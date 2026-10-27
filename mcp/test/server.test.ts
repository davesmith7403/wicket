/**
 * End-to-end through the MCP protocol: buildServer wired to an MCP Client over the SDK's
 * in-memory transport, with fetch stubbed. Covers the tool inventory + annotations, the
 * per-call connection override and idempotencyKey lifting, the readOnly guard as seen by an
 * agent, wicket_query_all pagination (full, capped, partial, first-page failure, pinned
 * client), the connection tools, and the bundled skill tool.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ConnectionRegistry } from '../src/connections.ts';
import { TOOL_NAMES } from '../src/index.ts';
import {
    COMPANY_A,
    COMPANY_B,
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
    toolJsonAs,
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
    stub.route(/login\.microsoftonline\.com\/tenant-prod\//, () =>
        jsonResponse({ access_token: 'tok-prod', expires_in: 3600 }),
    ).route(/login\.microsoftonline\.com\/tenant-sb\//, () =>
        jsonResponse({ access_token: 'tok-sb', expires_in: 3600 }),
    );
    registry = loadRegistry(tmp, {
        default: 'prod',
        connections: {
            prod: entry({ tenantId: 'tenant-prod', clientId: 'client-prod', description: 'Live' }),
            sandbox: entry({ tenantId: 'tenant-sb', clientId: 'client-sb', companyId: COMPANY_B }),
            ro: entry({ tenantId: 'tenant-prod', clientId: 'client-ro', readOnly: true }),
            masked: entry({ tenantId: 'tenant-prod', clientId: 'client-m', unmask: false }),
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

const call = (name: string, args: Record<string, unknown> = {}) =>
    harness.client.callTool({ name, arguments: args });

const envelopeOf = (req: RecordedRequest) => req.json as Record<string, unknown> & { data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

describe('server instructions', () => {
    test('the initialize handshake carries the skill essentials, so a host can inject them into the system prompt', () => {
        const instructions = harness.client.getInstructions();
        expect(typeof instructions).toBe('string');
        expect(instructions).toContain('wicket_skill');
        expect(instructions).toContain('wicket_describe');
    });
});

describe('tool inventory', () => {
    test('exposes every Wicket operation plus the server-side tools, with a connection override on each BC tool', async () => {
        const { tools } = await harness.client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
            [
                'wicket_action',
                'wicket_api_read',
                'wicket_apis',
                'wicket_cancel',
                'wicket_capabilities',
                'wicket_connections',
                'wicket_delete',
                'wicket_describe',
                'wicket_discover',
                'wicket_insert',
                'wicket_invoke',
                'wicket_map',
                'wicket_modify',
                'wicket_page_url',
                'wicket_query',
                'wicket_query_all',
                'wicket_query_deliver',
                'wicket_read_blob',
                'wicket_requests',
                'wicket_skill',
                'wicket_status',
                'wicket_use',
                'wicket_whoami',
            ].sort(),
        );
        expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
        const local = new Set(['wicket_connections', 'wicket_use', 'wicket_skill']);
        for (const t of tools) {
            const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
            if (local.has(t.name)) expect(props).not.toContain('connection');
            else expect(props).toContain('connection');
        }
    });

    test('annotations distinguish read, create, destructive and session tools', async () => {
        const { tools } = await harness.client.listTools();
        const ann = (name: string) => tools.find((t) => t.name === name)!.annotations!;
        expect(ann('wicket_query')).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect(ann('wicket_insert')).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
        expect(ann('wicket_modify')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(ann('wicket_delete')).toMatchObject({ destructiveHint: true, idempotentHint: true });
        expect(ann('wicket_action')).toMatchObject({ destructiveHint: true });
        expect(ann('wicket_invoke')).toMatchObject({ destructiveHint: true });
        expect(ann('wicket_cancel')).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
        expect(ann('wicket_use')).toMatchObject({ readOnlyHint: false, idempotentHint: true });
        for (const name of ['wicket_discover', 'wicket_describe', 'wicket_read_blob', 'wicket_capabilities', 'wicket_page_url', 'wicket_whoami', 'wicket_status', 'wicket_requests', 'wicket_skill', 'wicket_connections', 'wicket_query_all', 'wicket_apis', 'wicket_api_read']) {
            expect(ann(name).readOnlyHint).toBe(true);
        }
        // Async delivery writes a request row + a shareable blob package: never auto-approvable.
        expect(ann('wicket_query_deliver')).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        });
        for (const t of tools) {
            if (t.name !== 'wicket_query_deliver') expect(t.annotations?.openWorldHint).toBe(false);
        }
    });

    test('deliver lives only on wicket_query_deliver; wicket_query_all drops aggregate and adds maxPages/maxRows', async () => {
        const { tools } = await harness.client.listTools();
        const schemaOf = (name: string) =>
            tools.find((t) => t.name === name)!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        const props = (name: string) => Object.keys(schemaOf(name).properties ?? {});
        expect(props('wicket_query')).toEqual(expect.arrayContaining(['aggregate', 'cursor', 'connection']));
        expect(props('wicket_query')).not.toContain('deliver');
        expect(props('wicket_query_deliver')).toEqual(
            expect.arrayContaining(['deliver', 'idempotencyKey', 'connection', 'tableId', 'filter', 'select']),
        );
        expect(schemaOf('wicket_query_deliver').required).toEqual(expect.arrayContaining(['tableId', 'deliver']));
        const qa = props('wicket_query_all');
        expect(qa).not.toContain('aggregate');
        expect(qa).not.toContain('deliver');
        expect(qa).toEqual(expect.arrayContaining(['maxPages', 'maxRows', 'connection', 'cursor', 'tableId', 'filter', 'select']));
    });

    test('idempotencyKey is offered on every state-changing tool and no read tool', async () => {
        const { tools } = await harness.client.listTools();
        const has = (name: string) =>
            'idempotencyKey' in ((tools.find((t) => t.name === name)!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
        for (const n of ['wicket_insert', 'wicket_modify', 'wicket_delete', 'wicket_invoke', 'wicket_action', 'wicket_query_deliver']) {
            expect(has(n)).toBe(true);
        }
        for (const n of ['wicket_query', 'wicket_query_all', 'wicket_discover', 'wicket_cancel', 'wicket_apis', 'wicket_api_read']) expect(has(n)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// operation tools
// ---------------------------------------------------------------------------

describe('operation tools', () => {
    test('wicket_query round-trips through the default connection and renders the unwrapped result', async () => {
        const page = { value: [{ No: '10000', '@recordId': 'r1', '@etag': 'e1' }], '@pagingMode': 'offset' };
        stub.rpc(() => odata(page));

        const res = await call('wicket_query', { tableId: 18, select: ['No'], top: 1 });

        expect(toolIsError(res)).toBe(false);
        expect(toolJson(res)).toEqual(page);
        const req = stub.rpcRequests[0]!;
        expect(req.url).toContain(`/v2.0/tenant-prod/sandbox/`);
        expect(req.url).toMatch(/Microsoft\.NAV\.query$/);
        expect(req.headers.authorization).toBe('Bearer tok-prod');
        expect(envelopeOf(req).data).toEqual({ tableId: 18, select: ['No'], top: 1 });
    });

    test('a connection override routes one call to another tenant without touching the session', async () => {
        stub.rpc(() => odata({}));
        await call('wicket_whoami', { connection: 'sandbox' });
        await call('wicket_whoami');

        const [first, second] = stub.rpcRequests;
        expect(first!.url).toContain(`/tenant-sb/sandbox/api/wicket/rpc/v1.0/companies(${COMPANY_B})`);
        expect(first!.headers.authorization).toBe('Bearer tok-sb');
        expect(envelopeOf(first!).data).toEqual({});
        expect(second!.url).toContain(`/tenant-prod/sandbox/api/wicket/rpc/v1.0/companies(${COMPANY_A})`);
        expect(registry.current()).toEqual({ name: 'prod', isSessionSelection: false });
    });

    test('invoke/action without a key get a server-minted one, reported next to the result', async () => {
        stub.rpc(() => odata({ ok: true }));
        const res = await call('wicket_action', { action: 'post-sales', target: { systemId: 'abc' } });
        const env = envelopeOf(stub.rpcRequests[0]!);
        expect(typeof env.idempotencyKey).toBe('string');
        expect(env.idempotencyKey as string).toMatch(/^auto-[0-9a-f-]{36}$/);
        const body = toolJson(res) as Record<string, unknown>;
        expect(body['@idempotencyKey']).toBe(env.idempotencyKey);
        expect(body['@idempotencyKeyGenerated']).toBe(true);
        expect(body.ok).toBe(true);

        stub.rpc(() => odata({ ok: true }));
        await call('wicket_invoke', { codeunitId: 94190, procedure: 'Ping' });
        expect(envelopeOf(stub.rpcRequests[1]!).idempotencyKey as string).toMatch(/^auto-/);
    });

    test('a caller key is used verbatim and nothing is minted for insert/modify/delete', async () => {
        stub.rpc(() => odata({ ok: true }));
        const res = await call('wicket_action', { action: 'post-sales', idempotencyKey: 'post-42' });
        expect(envelopeOf(stub.rpcRequests[0]!).idempotencyKey).toBe('post-42');
        expect('@idempotencyKeyGenerated' in (toolJson(res) as Record<string, unknown>)).toBe(false);

        stub.rpc(() => odata({ recordId: 'r1' }));
        await call('wicket_insert', { tableId: 18, values: { Name: 'Contoso' } });
        expect('idempotencyKey' in envelopeOf(stub.rpcRequests[1]!)).toBe(false);
    });

    test('connection and idempotencyKey are lifted out of data; the key rides the envelope', async () => {
        stub.rpc(() => odata({ recordId: 'r1', '@etag': 'e1' }));
        await call('wicket_insert', {
            connection: 'sandbox',
            idempotencyKey: 'order-42',
            tableId: 18,
            values: { Name: 'Contoso' },
        });
        const env = envelopeOf(stub.rpcRequests[0]!);
        expect(env.idempotencyKey).toBe('order-42');
        expect(env.data).toEqual({ tableId: 18, values: { Name: 'Contoso' } });
        expect('connection' in env.data).toBe(false);
        expect('connection' in env).toBe(false);
    });

    test('wicket_query refuses a deliver block loudly and sends nothing', async () => {
        const res = await call('wicket_query', { tableId: 18, deliver: { mode: 'azureBlob' } });
        expect(toolIsError(res)).toBe(true);
        expect(toolJson(res)).toMatchObject({
            type: 'https://wicket.example/errors/use-deliver-tool',
            status: 400,
            suggest: { use: 'wicket_query_deliver' },
        });
        expect(stub.requests).toHaveLength(0);
    });

    test('wicket_query forwards only declared keys (an unknown key is not smuggled into data)', async () => {
        stub.rpc(() => odata({ value: [] }));
        await call('wicket_query', { tableId: 18, bogus: 1 });
        expect(envelopeOf(stub.rpcRequests[0]!).data).toEqual({ tableId: 18 });
    });

    test('wicket_query_deliver sends a query with deliver in data and the key on the envelope, even on a readOnly connection', async () => {
        const acceptance = { '@async': true, requestId: 'r-1', status: 'queued' };
        stub.rpc(() => odata(acceptance));
        const res = await call('wicket_query_deliver', {
            connection: 'ro',
            idempotencyKey: 'export-7',
            tableId: 21,
            select: ['*'],
            deliver: { mode: 'azureBlob', package: 'ndjson' },
        });
        expect(toolIsError(res)).toBe(false);
        expect(toolJson(res)).toEqual(acceptance);
        const req = stub.rpcRequests[0]!;
        expect(req.url).toMatch(/Microsoft\.NAV\.query$/);
        const env = envelopeOf(req);
        expect(env.idempotencyKey).toBe('export-7');
        expect(env.data).toEqual({ tableId: 21, select: ['*'], deliver: { mode: 'azureBlob', package: 'ndjson' } });
    });

    test('a connection with unmask:false sends "unmask": false from query, query_all, query_deliver, read_blob and describe; the default sends none', async () => {
        stub.rpc(() => odata({ value: [] }));
        await call('wicket_query', { connection: 'masked', tableId: 18 });
        await call('wicket_query_all', { connection: 'masked', tableId: 18 });
        await call('wicket_query_deliver', { connection: 'masked', tableId: 18, deliver: { mode: 'azureBlob' }, idempotencyKey: 'k1' });
        await call('wicket_read_blob', { connection: 'masked', tableId: 18, recordId: 'x', fieldNo: 5 });
        await call('wicket_describe', { connection: 'masked', kind: 'table', tableId: 18 });
        expect(stub.rpcRequests).toHaveLength(5);
        for (const req of stub.rpcRequests) expect(envelopeOf(req).data.unmask).toBe(false);
        await call('wicket_query', { tableId: 18 });
        expect(stub.rpcRequests).toHaveLength(6);
        expect('unmask' in envelopeOf(stub.rpcRequests[5]!).data).toBe(false);
    });

    test('wicket_query_deliver requires the deliver block', async () => {
        const res = await call('wicket_query_deliver', { tableId: 21 });
        expect(toolIsError(res)).toBe(true);
        expect(toolText(res)).toContain('deliver');
        expect(stub.requests).toHaveLength(0);
    });

    test('wicket_action carries an idempotencyKey on the envelope', async () => {
        stub.rpc(() => odata({ posted: true }));
        await call('wicket_action', { action: 'post-sales', target: { systemId: 's-1' }, idempotencyKey: 'post-SO1001' });
        const env = envelopeOf(stub.rpcRequests[0]!);
        expect(env.idempotencyKey).toBe('post-SO1001');
        expect(env.data).toEqual({ action: 'post-sales', target: { systemId: 's-1' } });
    });

    test('a gateway 5xx on a keyless write tells the agent the outcome is unknown', async () => {
        stub.rpc(() => jsonResponse({ message: 'bad gateway' }, 502));
        const res = await call('wicket_insert', { tableId: 18, values: { Name: 'X' } });
        expect(toolIsError(res)).toBe(true);
        expect(toolJsonAs<{ detail: string }>(res).detail).toMatch(/^bad gateway — The outcome is UNKNOWN/);
    });

    test('an RFC 7807 problem is an MCP tool error carrying the whole document', async () => {
        const problem = {
            type: 'https://wicket.example/errors/not-exposed',
            title: 'Table not exposed',
            status: 403,
            detail: 'Table 18 is not exposed',
            instance: 'urn:wicket:req:1',
            operation: 'query',
            suggest: { use: 'discover', data: { kind: 'tables' } },
        };
        stub.rpc(() => odata(problem));
        const res = await call('wicket_query', { tableId: 18 });
        expect(toolIsError(res)).toBe(true);
        expect(toolJson(res)).toEqual(problem);
    });

    test('a transport failure is an MCP tool error with a synthetic problem', async () => {
        stub.rpc(() => jsonResponse({ error: { message: 'Authentication failed' } }, 401));
        const res = await call('wicket_capabilities');
        expect(toolIsError(res)).toBe(true);
        expect(toolJson(res)).toMatchObject({ status: 401, detail: 'Authentication failed', operation: 'capabilities' });
    });

    test('an unknown connection override is a tool error, not a crash', async () => {
        const res = await call('wicket_whoami', { connection: 'ghost' });
        expect(toolIsError(res)).toBe(true);
        expect(toolText(res)).toMatch(/Unknown connection "ghost".*prod, sandbox, ro/);
        expect(stub.requests).toHaveLength(0);
    });

    test('schema validation rejects a malformed call as a tool error before anything is sent', async () => {
        const wrongType = await call('wicket_query', { tableId: 'eighteen' });
        expect(toolIsError(wrongType)).toBe(true);
        expect(toolText(wrongType)).toMatch(/Input validation error.*wicket_query/);
        expect(toolText(wrongType)).toContain('tableId');

        const badEnum = await call('wicket_discover', { kind: 'widgets' });
        expect(toolIsError(badEnum)).toBe(true);
        expect(toolText(badEnum)).toMatch(/'tables' \| 'codeunits' \| 'companies'/);

        expect(stub.requests).toHaveLength(0);
    });

    test('a readOnly connection refuses writes as a 403 problem without sending them, but reads work', async () => {
        // capabilities answers for the action lookup: post-sales is a mutating verb.
        stub.rpc((req) =>
            req.url.includes('capabilities')
                ? odata({ value: { actions: [{ action: 'post-sales', enabled: true, mutating: true }] }, '@requestId': 'r' })
                : odata({ userId: 'ro-bot' }),
        );
        for (const [tool, args] of [
            ['wicket_insert', { tableId: 18, values: {} }],
            ['wicket_modify', { tableId: 18, recordId: 'r', values: {} }],
            ['wicket_delete', { tableId: 18, recordId: 'r' }],
            ['wicket_invoke', { codeunitId: 94100, procedure: 'Run' }],
            ['wicket_action', { action: 'post-sales' }],
        ] as const) {
            const res = await call(tool, { ...args, connection: 'ro' });
            expect(toolIsError(res)).toBe(true);
            expect(toolJson(res)).toMatchObject({
                type: 'https://wicket.example/errors/connection-read-only',
                status: 403,
                suggest: { use: 'wicket_connections' },
            });
        }
        // Nothing mutating reached BC; the only call made was the capabilities read that told the
        // action guard post-sales mutates.
        expect(stub.rpcRequests.map((r) => r.url.split('Microsoft.NAV.')[1])).toEqual(['capabilities']);

        const read = await call('wicket_whoami', { connection: 'ro' });
        expect(toolIsError(read)).toBe(false);
        expect(toolJson(read)).toEqual({ userId: 'ro-bot' });
        expect(stub.rpcRequests).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// wicket_query_all
// ---------------------------------------------------------------------------

describe('wicket_query_all', () => {
    /** Three cursor pages: (none) -> c1 -> c2 -> end. */
    const pages: Record<string, unknown> = {
        first: { value: [{ n: 1 }, { n: 2 }], '@nextLink': 'c1', '@pagingMode': 'cursor', '@count': 5 },
        c1: { value: [{ n: 3 }, { n: 4 }], '@nextLink': 'c2', '@pagingMode': 'cursor' },
        c2: { value: [{ n: 5 }], '@pagingMode': 'cursor' },
    };
    const cursorOf = (req: RecordedRequest) => (envelopeOf(req).data.cursor as string | undefined) ?? 'first';

    test('follows @nextLink to the end and concatenates the rows', async () => {
        stub.rpc((req) => odata(pages[cursorOf(req)]));
        const res = await call('wicket_query_all', { tableId: 18, select: ['n'] });

        expect(toolIsError(res)).toBe(false);
        expect(toolJson(res)).toEqual({
            value: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }],
            '@pages': 3,
            '@pagingMode': 'cursor',
            '@count': 5,
        });
        expect(stub.rpcRequests.map(cursorOf)).toEqual(['first', 'c1', 'c2']);
        // Every page repeats the caller's query args alongside the moving cursor.
        for (const req of stub.rpcRequests) expect(envelopeOf(req).data).toMatchObject({ tableId: 18, select: ['n'] });
        expect('cursor' in envelopeOf(stub.rpcRequests[0]!).data).toBe(false);
    });

    test('maxPages caps the walk and hands back the resume cursor as @nextLink + @truncated', async () => {
        stub.rpc((req) => odata(pages[cursorOf(req)]));
        const res = await call('wicket_query_all', { tableId: 18, maxPages: 2 });
        expect(toolJson(res)).toEqual({
            value: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
            '@pages': 2,
            '@pagingMode': 'cursor',
            '@count': 5,
            '@nextLink': 'c2',
            '@truncated': true,
        });
        expect(stub.rpcRequests).toHaveLength(2);
    });

    test('resumes from a caller-supplied cursor', async () => {
        stub.rpc((req) => odata(pages[cursorOf(req)]));
        const res = await call('wicket_query_all', { tableId: 18, cursor: 'c1' });
        expect(toolJson(res)).toMatchObject({ value: [{ n: 3 }, { n: 4 }, { n: 5 }], '@pages': 2 });
        expect(stub.rpcRequests.map(cursorOf)).toEqual(['c1', 'c2']);
    });

    test('a mid-pagination problem returns the rows so far as a PARTIAL success with @error', async () => {
        const problem = { type: 'https://wicket.example/errors/scan-budget', title: 'Scan budget exceeded', status: 429, detail: 'budget' };
        stub.rpc((req) => odata(cursorOf(req) === 'c1' ? problem : pages[cursorOf(req)]));
        const res = await call('wicket_query_all', { tableId: 18 });

        expect(toolIsError(res)).toBe(false);
        expect(toolJson(res)).toEqual({
            value: [{ n: 1 }, { n: 2 }],
            '@pages': 1,
            '@pagingMode': 'cursor',
            '@count': 5,
            '@truncated': true,
            '@nextLink': 'c1',
            '@error': problem,
        });
    });

    test('a first-page problem is a normal tool error', async () => {
        const problem = { type: 'https://wicket.example/errors/not-exposed', title: 'Table not exposed', status: 403 };
        stub.rpc(() => odata(problem));
        const res = await call('wicket_query_all', { tableId: 18 });
        expect(toolIsError(res)).toBe(true);
        expect(toolJson(res)).toEqual(problem);
    });

    test('a mid-pagination transport failure (non-problem) is also partial, since it is synthesised into a problem', async () => {
        stub.rpc((req) => (cursorOf(req) === 'c1' ? jsonResponse({ message: 'gateway' }, 502) : odata(pages[cursorOf(req)])));
        const res = await call('wicket_query_all', { tableId: 18 });
        expect(toolIsError(res)).toBe(false);
        expect(toolJson(res)).toMatchObject({ '@truncated': true, '@nextLink': 'c1', '@error': { status: 502 } });
    });

    test('maxRows stops at the page that reaches the cap and hands back the resume cursor', async () => {
        stub.rpc((req) => odata(pages[cursorOf(req)]));
        const res = await call('wicket_query_all', { tableId: 18, maxRows: 3 });
        expect(toolJson(res)).toEqual({
            value: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
            '@pages': 2,
            '@pagingMode': 'cursor',
            '@count': 5,
            '@nextLink': 'c2',
            '@truncated': true,
        });
        expect(stub.rpcRequests).toHaveLength(2);
    });

    test('maxRows is bounded by the schema', async () => {
        const res = await call('wicket_query_all', { tableId: 18, maxRows: 50_001 });
        expect(toolIsError(res)).toBe(true);
        expect(stub.requests).toHaveLength(0);
    });

    test('the default row cap (5000) bounds an endless walk', async () => {
        const big = Array.from({ length: 1000 }, (_, i) => ({ n: i }));
        stub.rpc((_req, nth) => odata({ value: big, '@nextLink': `c${nth + 1}` }));
        const out = toolJsonAs<{ value: unknown[]; '@truncated': boolean; '@nextLink': string }>(
            await call('wicket_query_all', { tableId: 18 }),
        );
        expect(out.value).toHaveLength(5000);
        expect(out['@truncated']).toBe(true);
        expect(out['@nextLink']).toBe('c5');
    });

    test('a mid-pagination non-problem failure (network, non-JSON body) is also partial', async () => {
        stub.rpc((req) => {
            if (cursorOf(req) === 'c1') throw new TypeError('fetch failed: ECONNRESET');
            return odata(pages[cursorOf(req)]);
        });
        const res = await call('wicket_query_all', { tableId: 18 });
        expect(toolIsError(res)).toBe(false);
        expect(toolJson(res)).toMatchObject({
            value: [{ n: 1 }, { n: 2 }],
            '@truncated': true,
            '@nextLink': 'c1',
            '@error': { message: 'fetch failed: ECONNRESET' },
        });
    });

    test('a bare-array page ends the walk after one page', async () => {
        stub.rpc(() => odata([{ n: 1 }]));
        expect(toolJson(await call('wicket_query_all', { tableId: 18 }))).toEqual({ value: [{ n: 1 }], '@pages': 1 });
    });

    test('pins the client once: a session switch mid-walk cannot move later pages to another tenant', async () => {
        stub.rpc(async (req) => {
            // Simulate a concurrent wicket_use landing between page 1 and page 2.
            if (cursorOf(req) === 'first') registry.select('sandbox');
            return odata(pages[cursorOf(req)]);
        });
        const res = await call('wicket_query_all', { tableId: 18, connection: 'prod' });
        expect(toolJson(res)).toMatchObject({ '@pages': 3 });
        for (const req of stub.rpcRequests) {
            expect(req.url).toContain('/tenant-prod/');
            expect(req.headers.authorization).toBe('Bearer tok-prod');
        }
    });
});

// ---------------------------------------------------------------------------
// connection tools
// ---------------------------------------------------------------------------

describe('wicket_connections / wicket_use', () => {
    test('lists connections without secrets and reflects default + selection', async () => {
        const before = toolJsonAs<{ connections: Array<Record<string, unknown>>; current: unknown }>(await call('wicket_connections'));
        expect(before.current).toEqual({ name: 'prod', isSessionSelection: false });
        expect(before.connections.map((c) => c.name)).toEqual(['prod', 'sandbox', 'ro', 'masked']);
        expect(before.connections[0]).toEqual({
            name: 'prod',
            tenantId: 'tenant-prod',
            environment: 'sandbox',
            companyId: COMPANY_A,
            authMode: 'client_credentials',
            readOnly: false,
            description: 'Live',
            isDefault: true,
            isSelected: true,
        });
        expect(before.connections[2]).toMatchObject({ name: 'ro', readOnly: true, isDefault: false });
        expect(toolText(await call('wicket_connections'))).not.toMatch(/secret|keychain|s3cret/i);

        const used = await call('wicket_use', { name: 'sandbox' });
        expect(toolIsError(used)).toBe(false);
        expect(toolJson(used)).toEqual({
            selected: 'sandbox',
            tenantId: 'tenant-sb',
            environment: 'sandbox',
            companyId: COMPANY_B,
            authMode: 'client_credentials',
            readOnly: false,
        });

        const after = toolJsonAs<{ connections: Array<Record<string, unknown>>; current: unknown }>(await call('wicket_connections'));
        expect(after.current).toEqual({ name: 'sandbox', isSessionSelection: true });
        expect(after.connections.map((c) => [c.name, c.isDefault, c.isSelected])).toEqual([
            ['prod', true, false],
            ['sandbox', false, true],
            ['ro', false, false],
            ['masked', false, false],
        ]);
    });

    test('wicket_use redirects subsequent calls; an unknown name is a tool error and leaves the selection alone', async () => {
        stub.rpc(() => odata({}));
        await call('wicket_use', { name: 'sandbox' });
        await call('wicket_whoami');
        expect(stub.rpcRequests[0]!.url).toContain('/tenant-sb/');

        const bad = await call('wicket_use', { name: 'ghost' });
        expect(toolIsError(bad)).toBe(true);
        expect(toolText(bad)).toMatch(/Unknown connection "ghost"/);
        expect(registry.current().name).toBe('sandbox');
    });
});

// ---------------------------------------------------------------------------
// wicket_skill (against the real bundled guide)
// ---------------------------------------------------------------------------

describe('wicket_skill', () => {
    test('toc by default: description, then every file with its H2 titles', async () => {
        const text = toolText(await call('wicket_skill'));
        expect(text).toMatch(/^Use when a task touches Microsoft Dynamics 365 Business Central/);
        expect(text).toContain('Sections (fetch one with mode:"section", section:"<title>"; a file name such as "filters" fetches that whole file):');
        expect(text).toContain('SKILL.md — Wicket usage');
        expect(text).toContain('- Essentials');
        expect(text).toContain('references/filters.md — Filter cookbook');
        expect(text).toContain('- wicket_query');
        expect(text).not.toContain('### ');
    });

    test('section: exact title, prefix, a whole file by name, then a note + toc when nothing matches', async () => {
        const exact = toolText(await call('wicket_skill', { mode: 'section', section: 'essentials' }));
        expect(exact.startsWith('## Essentials')).toBe(true);
        expect(exact).not.toContain('\n## Workflow');

        const prefix = toolText(await call('wicket_skill', { mode: 'section', section: 'wicket_action' }));
        expect(prefix.startsWith('## wicket_action')).toBe(true);
        expect(prefix).not.toContain('\n## wicket_query_deliver');

        const file = toolText(await call('wicket_skill', { mode: 'section', section: 'filters' }));
        expect(file.startsWith('# Filter cookbook')).toBe(true);
        expect(file).toContain('## Filter syntax');

        const miss = toolText(await call('wicket_skill', { mode: 'section', section: 'zzz-nothing-here' }));
        expect(miss).toMatch(/^No section matched "zzz-nothing-here"\./);
        expect(miss).toContain('- Essentials');

        const noName = toolText(await call('wicket_skill', { mode: 'section' }));
        expect(noName).toMatch(/^mode:"section" needs a `section` title or a reference file name\./);
    });

    test('full returns the single-file bundle: SKILL.md first, then every reference file', async () => {
        const full = toolText(await call('wicket_skill', { mode: 'full' }));
        expect(full.startsWith('---\nname: wicket-usage')).toBe(true);
        expect(full).toContain('## Essentials');
        expect(full).toContain('# Filter cookbook');
        expect(full).toContain('# Wire protocol for HTTP clients');
    });

    test('never touches the network', async () => {
        await call('wicket_skill', { mode: 'full' });
        expect(stub.requests).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// result rendering: a page of rows is one row per line, still valid JSON
// ---------------------------------------------------------------------------

describe('row rendering', () => {
    test('a value array of two or more objects renders one row per line and round-trips', async () => {
        stub.rpc(() =>
            odata({
                value: [
                    { 'No.': '10000', Name: 'Adatum', '@recordId': 'r1', '@etag': 'e1' },
                    { 'No.': '20000', Name: 'Trey', '@recordId': 'r2', '@etag': 'e2' },
                ],
                '@nextLink': 'cursor-1',
                '@pagingMode': 'keyset',
            }),
        );
        const text = toolText(await call('wicket_query', { tableId: 18, select: ['No.', 'Name'] }));
        const lines = text.split('\n');
        expect(lines[0]).toBe('{');
        expect(lines[1]).toBe('  "value": [');
        expect(lines[2]).toBe('    {"No.":"10000","Name":"Adatum","@recordId":"r1","@etag":"e1"},');
        expect(lines[3]).toBe('    {"No.":"20000","Name":"Trey","@recordId":"r2","@etag":"e2"}');
        expect(lines[4]).toBe('  ],');
        expect(text).toContain('  "@nextLink": "cursor-1"');
        expect(JSON.parse(text)).toEqual({
            value: [
                { 'No.': '10000', Name: 'Adatum', '@recordId': 'r1', '@etag': 'e1' },
                { 'No.': '20000', Name: 'Trey', '@recordId': 'r2', '@etag': 'e2' },
            ],
            '@nextLink': 'cursor-1',
            '@pagingMode': 'keyset',
        });
    });

    test('a single row, an aggregate object and a non-row value keep the pretty layout', async () => {
        // One route, scripted by call order (the stub answers with the FIRST matching route).
        stub.rpc((_req, nth) =>
            nth === 0
                ? odata({ value: [{ 'No.': '10000' }], '@pagingMode': 'keyset' })
                : odata({ value: { count: 42, sum: { Amount: 10 } } }),
        );
        const one = toolText(await call('wicket_query', { tableId: 18 }));
        expect(one).toContain('    {\n      "No.": "10000"\n    }');

        const agg = toolText(await call('wicket_query', { tableId: 21, aggregate: { count: true, sum: ['Amount'] } }));
        expect(agg).toContain('"count": 42');
        expect(JSON.parse(agg)).toEqual({ value: { count: 42, sum: { Amount: 10 } } });
    });

    test('every tool carries a title and the write tools stay marked destructive', async () => {
        const { tools } = await harness.client.listTools();
        for (const t of tools) expect(typeof t.title).toBe('string');
        const byName = new Map(tools.map((t) => [t.name, t]));
        expect(byName.get('wicket_query')!.title).toBe('Query rows or aggregate');
        expect(byName.get('wicket_modify')!.annotations?.destructiveHint).toBe(true);
    });
});
