/**
 * wicket_changes: the change history through the MCP protocol — filters forwarded as the op's data,
 * the wire shape returned as is, and the two refusals (changes-off, changes-forbidden) surfaced as
 * problems the agent can read.
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
    registry = loadRegistry(tmp, { default: 'prod', connections: { prod: entry({ tenantId: 'tenant-prod' }) } });
    harness = await startServer(registry);
});

afterEach(async () => {
    await harness.close();
    stub.uninstall();
    tmp.cleanup();
    restoreEnv();
});

const call = (args: Record<string, unknown> = {}) => harness.client.callTool({ name: 'wicket_changes', arguments: args });
const envelopeOf = (req: RecordedRequest) => req.json as { data: Record<string, unknown> };

const PAGE = {
    value: [
        {
            entryNo: 7,
            createdAt: '2026-10-29T14:02:00Z',
            kind: 'changed',
            tableId: 18,
            tableName: 'Customer',
            recordKey: '20000',
            user: 'ANNA',
            connection: 'contoso-sandbox',
            requestId: 'r-1',
            fieldCount: 2,
            fields: [
                { fieldNo: 20, fieldName: 'Credit Limit (LCY)', shownAs: 'clear', old: '50000', new: '75000' },
                { fieldNo: 9, fieldName: 'Phone No.', shownAs: 'hidden' },
            ],
        },
    ],
    '@nextLink': 'Y2hhbmdlczo3',
};

describe('wicket_changes', () => {
    test('changes tool forwards filters and returns the value array', async () => {
        stub.rpc(() => odata(PAGE));
        const filters = {
            from: '2026-10-01T00:00:00Z',
            to: '2026-10-30T00:00:00Z',
            tableId: 18,
            viaConnection: 'contoso-sandbox',
            kind: 'changed',
            user: 'ANNA',
            top: 50,
            cursor: 'Y2hhbmdlczo5',
        };
        const result = await call(filters);

        expect(toolIsError(result)).toBe(false);
        expect(stub.rpcRequests).toHaveLength(1);
        expect(stub.rpcRequests[0]!.url).toEndWith('/Microsoft.NAV.changes');
        expect(envelopeOf(stub.rpcRequests[0]!).data).toEqual(filters);
        expect(toolJson(result)).toEqual(PAGE);
    });

    test('changes-off and changes-forbidden come back as problems', async () => {
        stub.rpc((_req, nth) =>
            odata({
                type: `https://wicket.example/errors/${nth === 0 ? 'changes-off' : 'changes-forbidden'}`,
                title: 'Refused',
                status: 403,
                detail: nth === 0 ? 'the change history is off' : 'data.user needs the Wicket - Audit Changes permission set',
            }),
        );
        const off = await call();
        expect(toolIsError(off)).toBe(true);
        expect(toolText(off)).toContain('changes-off');

        const forbidden = await call({ user: 'SOMEONE' });
        expect(toolIsError(forbidden)).toBe(true);
        expect(toolText(forbidden)).toContain('changes-forbidden');
        expect(toolText(forbidden)).toContain('Wicket - Audit Changes');
    });

    test('is a read-only tool', async () => {
        const { tools } = await harness.client.listTools();
        expect(tools.find((t) => t.name === 'wicket_changes')!.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
        });
    });
});
