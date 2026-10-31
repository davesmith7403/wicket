/**
 * wicket_batch: many writes in one call through the MCP protocol — items and preview forwarded as the
 * op's data, a server-minted idempotency key when the agent sends none, the read-only connection guard
 * (a preview passes, a real batch never reaches BC), and a failing item's problem surfaced to the agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ConnectionRegistry } from '../src/connections.ts';
import {
    FetchStub,
    TempDir,
    entry,
    jsonResponse,
    loadRegistry,
    odata,
    sandboxEnv,
    startServer,
    toolIsError,
    toolJson,
    toolText,
    type RecordedRequest,
    type ServerHarness,
} from './helpers.ts';

let restoreEnv: () => void;
let tmp: TempDir;
let stub: FetchStub;
let registry: ConnectionRegistry;
let harness: ServerHarness;

beforeEach(async () => {
    restoreEnv = sandboxEnv({ WICKET_TEST_SECRET: 's3cret' });
    tmp = new TempDir();
    stub = new FetchStub().install();
    stub.route(/login\.microsoftonline\.com\//, () => jsonResponse({ access_token: 'tok', expires_in: 3600 }));
    registry = loadRegistry(tmp, {
        default: 'prod',
        connections: {
            prod: entry({ tenantId: 'tenant-prod' }),
            ro: entry({ tenantId: 'tenant-prod', clientId: 'client-ro', readOnly: true }),
        },
    });
    harness = await startServer(registry);
});

afterEach(async () => {
    await harness.close();
    stub.uninstall();
    tmp.cleanup();
    restoreEnv();
});

const call = (args: Record<string, unknown>) => harness.client.callTool({ name: 'wicket_batch', arguments: args });
const envelopeOf = (req: RecordedRequest) => req.json as { data: Record<string, unknown>; idempotencyKey?: string };

const ITEMS = [
    { op: 'insert', tableId: 36, values: { 'Document Type': 'Order', 'Sell-to Customer No.': '10000' } },
    {
        op: 'insert',
        tableId: 37,
        values: { 'Document Type': 'Order', 'Document No.': { fromItem: 0, field: 'No.' }, 'Line No.': 10000 },
    },
    { op: 'modify', tableId: 18, recordId: 'cmVj', etag: 'W/"1"', values: { Name: 'Renamed' } },
    { op: 'delete', tableId: 18, recordId: 'cmVk' },
];

describe('wicket_batch', () => {
    test('forwards the items and preview, and returns the per-item results', async () => {
        const answer = { value: { items: [{ index: 0, op: 'insert', recordId: 'a' }], count: 1, preview: true } };
        stub.rpc(() => odata(answer));
        const res = await call({ items: ITEMS, preview: true });

        expect(toolIsError(res)).toBe(false);
        expect(stub.rpcRequests[0]!.url).toEndWith('/Microsoft.NAV.batch');
        expect(envelopeOf(stub.rpcRequests[0]!).data).toEqual({ items: ITEMS, preview: true });
        expect(toolJson(res)).toMatchObject(answer);
    });

    test('a batch without a key gets a server-minted one, reported next to the result', async () => {
        stub.rpc(() => odata({ value: { items: [], count: 0 } }));
        const res = await call({ items: ITEMS });
        const key = envelopeOf(stub.rpcRequests[0]!).idempotencyKey;
        expect(key).toMatch(/^auto-[0-9a-f-]{36}$/);
        expect((toolJson(res) as Record<string, unknown>)['@idempotencyKey']).toBe(key);
    });

    test('a read-only connection lets a preview through and never sends a real batch', async () => {
        stub.rpc(() => odata({ value: { items: [], count: 0, preview: true } }));
        const preview = await call({ items: ITEMS, preview: true, connection: 'ro' });
        expect(toolIsError(preview)).toBe(false);

        const real = await call({ items: ITEMS, connection: 'ro' });
        expect(toolIsError(real)).toBe(true);
        expect(toolJson(real)).toMatchObject({ type: 'https://wicket.example/errors/connection-read-only', status: 403 });
        expect(stub.rpcRequests).toHaveLength(1);
    });

    test('a failing item comes back as a problem that names the item', async () => {
        stub.rpc(() =>
            odata({
                type: 'https://wicket.example/errors/unknown-field',
                title: 'Unknown field',
                status: 400,
                detail: 'items[1] (insert, table 37): field "Line Nr." does not exist',
                item: 1,
                itemOp: 'insert',
            }),
        );
        const res = await call({ items: ITEMS });
        expect(toolIsError(res)).toBe(true);
        expect(toolJson(res)).toMatchObject({ status: 400, item: 1, itemOp: 'insert' });
        expect(toolText(res)).toContain('items[1]');
    });

    test('is a destructive write tool', async () => {
        const { tools } = await harness.client.listTools();
        expect(tools.find((t) => t.name === 'wicket_batch')!.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
        });
    });
});
