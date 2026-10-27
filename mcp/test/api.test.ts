/**
 * API-first reads: wicket_apis (the cached API catalog) and wicket_api_read (a read through one API page,
 * gated by a fresh describe kind="api"). The catalog cache lives in WICKET_CACHE_DIR, which sandboxEnv
 * points at a per-test temp directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { planApiRead, scanFilter, type ApiDescription } from '../src/apiCatalog.ts';
import type { ConnectionRegistry } from '../src/connections.ts';
import {
    COMPANY_A,
    FetchStub,
    TempDir,
    captureStderr,
    entry,
    jsonResponse,
    loadRegistry,
    odata,
    sandboxEnv,
    startServer,
    toolIsError,
    toolJsonAs,
    type RecordedRequest,
    type ServerHarness,
} from './helpers.ts';

const API_URL = /\/api\/(?!wicket\/rpc\/).+\/companies\(/;

const CUSTOMERS = {
    id: 30009,
    scope: 'api',
    apiKind: 'page',
    name: 'APIV2 - Customers',
    entitySetName: 'customers',
    entityName: 'customer',
    route: 'v2.0/customers',
    routes: ['v2.0/customers'],
    sourceTableId: 18,
    operations: { read: true, insert: true, modify: true, delete: true },
};
const VENDORS = { ...CUSTOMERS, id: 30010, name: 'APIV2 - Vendors', entitySetName: 'vendors', entityName: 'vendor', route: 'v2.0/vendors', routes: ['v2.0/vendors'], sourceTableId: 23 };
const CUSTOM = { ...CUSTOMERS, id: 50500, name: 'Contoso Orders', entitySetName: 'orders', entityName: 'order', route: 'contoso/sales/v1.0/orders', routes: ['contoso/sales/v1.0/orders'], sourceTableId: 50500 };
const SALES_QUERY = { id: 30050, scope: 'api', apiKind: 'query', name: 'Sales Totals', entitySetName: 'salesTotals', entityName: 'salesTotal', route: 'v2.0/salesTotals', routes: ['v2.0/salesTotals'], operations: { read: true, insert: false, modify: false, delete: false } };
const CATALOG = [CUSTOMERS, VENDORS, CUSTOM, SALES_QUERY];

function customersApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ...CUSTOMERS,
        sourceTableView: '',
        routable: true,
        catalogVersion: 'v1',
        fields: [
            { name: 'id', mapped: true, fieldNo: 2000000000, readable: true },
            { name: 'number', mapped: true, fieldNo: 1, readable: true },
            { name: 'displayName', mapped: true, fieldNo: 2, readable: true },
            { name: 'email', mapped: true, fieldNo: 102, readable: false },
            { name: 'balance', mapped: true, fieldNo: 59, readable: true },
            { name: 'lastModifiedDateTime', mapped: false, readable: false },
        ],
        ...overrides,
    };
}

let restoreEnv: () => void;
let tmp: TempDir;
let stub: FetchStub;
let registry: ConnectionRegistry;
let harness: ServerHarness;
/** What the scripted Wicket answers; tests adjust these before calling. */
let catalogVersion: string;
let describeAnswer: Record<string, unknown>;
let apiAnswer: (req: RecordedRequest) => Response;

const opOf = (req: RecordedRequest) => req.url.slice(req.url.lastIndexOf('.') + 1);
const dataOf = (req: RecordedRequest) => (req.json as { data: Record<string, unknown> }).data;

beforeEach(async () => {
    restoreEnv = sandboxEnv({ WICKET_TEST_SECRET: 's3cret' });
    tmp = new TempDir();
    catalogVersion = 'v1';
    describeAnswer = customersApi();
    apiAnswer = () => jsonResponse({ value: [] });
    stub = new FetchStub().install();
    stub.route(/login\.microsoftonline\.com\//, () => jsonResponse({ access_token: 'tok', expires_in: 3600 }))
        .rpc((req) => {
            const data = dataOf(req);
            // The real describe answer wraps the description in `value` (as every Wicket op does).
            if (opOf(req) === 'describe') return odata({ value: describeAnswer });
            if (opOf(req) === 'discover' && data.kind === 'apis') {
                if (data.ifNoneMatch === catalogVersion) {
                    return odata({ value: [], notModified: true, catalogVersion, apiRouting: 'Prefer' });
                }
                const top = typeof data.top === 'number' ? data.top : 100;
                const skip = typeof data.skip === 'number' ? data.skip : 0;
                const page = CATALOG.slice(skip, skip + top);
                return odata({
                    value: page,
                    catalogVersion,
                    apiRouting: 'Prefer',
                    '@count': CATALOG.length,
                    ...(skip + page.length < CATALOG.length ? { '@nextSkip': skip + page.length } : {}),
                });
            }
            throw new Error(`unscripted RPC ${opOf(req)}`);
        })
        .route(API_URL, (req) => apiAnswer(req));
    registry = loadRegistry(tmp, { connections: { prod: entry({ tenantId: 'tenant-prod' }) } });
    harness = await startServer(registry);
});

afterEach(async () => {
    await harness.close();
    stub.uninstall();
    tmp.cleanup();
    restoreEnv();
});

const call = (name: string, args: Record<string, unknown> = {}) => harness.client.callTool({ name, arguments: args });
const discoverCalls = () => stub.rpcRequests.filter((r) => opOf(r) === 'discover');

// ---------------------------------------------------------------------------
// wicket_apis
// ---------------------------------------------------------------------------

describe('wicket_apis', () => {
    test('first use fetches the catalog, summarises it by route prefix, and writes the disk cache', async () => {
        const out = toolJsonAs<{ source: string; total: number; catalogVersion: string; apiRouting: string; groups: Array<{ prefix: string; count: number }> }>(
            await call('wicket_apis'),
        );
        expect(out.source).toBe('server');
        expect(out.total).toBe(4);
        expect(out.catalogVersion).toBe('v1');
        expect(out.apiRouting).toBe('Prefer');
        expect(out.groups).toEqual([
            { prefix: 'contoso/sales/v1.0', count: 1 },
            { prefix: 'v2.0', count: 3 },
        ]);
        expect(dataOf(discoverCalls()[0]!)).toMatchObject({ kind: 'apis', top: 1000 });
        expect(readdirSync(process.env.WICKET_CACHE_DIR!).some((f) => f.startsWith('apis-') && f.endsWith('.json'))).toBe(true);
    });

    test('later calls in the same process are served from memory without touching BC', async () => {
        await call('wicket_apis');
        const before = discoverCalls().length;
        const out = toolJsonAs<{ source: string; count: number; value: Array<{ route: string }> }>(await call('wicket_apis', { tableId: 18 }));
        expect(out.source).toBe('memory');
        expect(out.value.map((e) => e.route)).toEqual(['v2.0/customers']);
        expect(discoverCalls().length).toBe(before);
    });

    test('a new process revalidates the disk copy with ifNoneMatch and one call', async () => {
        await call('wicket_apis');
        await harness.close();
        harness = await startServer(registry); // fresh ApiCatalogCache, same disk
        const before = discoverCalls().length;
        const out = toolJsonAs<{ source: string; total: number }>(await call('wicket_apis'));
        expect(out.source).toBe('revalidated');
        expect(out.total).toBe(4);
        const sent = discoverCalls().slice(before);
        expect(sent.length).toBe(1);
        expect(dataOf(sent[0]!)).toEqual({ kind: 'apis', ifNoneMatch: 'v1' });
    });

    test('a moved catalogVersion makes the revalidation refetch everything', async () => {
        await call('wicket_apis');
        await harness.close();
        harness = await startServer(registry);
        catalogVersion = 'v2';
        const out = toolJsonAs<{ source: string; catalogVersion: string }>(await call('wicket_apis'));
        expect(out.source).toBe('server');
        expect(out.catalogVersion).toBe('v2');
    });

    test('refresh ignores both caches', async () => {
        await call('wicket_apis');
        const out = toolJsonAs<{ source: string }>(await call('wicket_apis', { refresh: true }));
        expect(out.source).toBe('server');
    });

    test('search and group narrow the listing', async () => {
        const bySearch = toolJsonAs<{ value: Array<{ id: number }> }>(await call('wicket_apis', { search: 'VEND' }));
        expect(bySearch.value.map((e) => e.id)).toEqual([30010]);
        const byGroup = toolJsonAs<{ value: Array<{ id: number }> }>(await call('wicket_apis', { group: 'contoso/sales/v1.0' }));
        expect(byGroup.value.map((e) => e.id)).toEqual([50500]);
    });

    test('a catalog larger than one page is fetched across @nextSkip', async () => {
        // Force two pages by shrinking what the stub returns per call.
        const original = CATALOG.slice();
        CATALOG.push(...Array.from({ length: 1200 }, (_, i) => ({ ...VENDORS, id: 60000 + i, entitySetName: `extra${i}`, route: `v2.0/extra${i}` })));
        try {
            const out = toolJsonAs<{ total: number }>(await call('wicket_apis'));
            expect(out.total).toBe(1204);
            expect(discoverCalls().map((r) => dataOf(r).skip)).toEqual([undefined, 1000]);
        } finally {
            CATALOG.length = 0;
            CATALOG.push(...original);
        }
    });
});

// ---------------------------------------------------------------------------
// wicket_api_read
// ---------------------------------------------------------------------------

describe('wicket_api_read', () => {
    test('the describe pre-check carries the connection\'s unmask:false, and a masked field is refused', async () => {
        registry = loadRegistry(tmp, { connections: { prod: entry({ tenantId: 'tenant-prod', unmask: false }) } });
        await harness.close();
        harness = await startServer(registry);
        describeAnswer = customersApi({
            fields: [
                { name: 'number', mapped: true, fieldNo: 1, readable: true, access: 'clear' },
                { name: 'email', mapped: true, fieldNo: 102, readable: false, access: 'masked' },
            ],
        });
        const res = await call('wicket_api_read', { pageId: 30009, select: ['number', 'email'] });
        expect(toolIsError(res)).toBe(true);
        const describeReq = stub.rpcRequests.find((r) => opOf(r) === 'describe')!;
        expect(dataOf(describeReq)).toEqual({ kind: 'api', pageId: 30009, unmask: false });
        expect(stub.matching(API_URL)).toHaveLength(0);
    });

    test('reads through the API with exactly the readable fields when no select is given', async () => {
        apiAnswer = () => jsonResponse({ value: [{ '@odata.etag': 'W/1', id: 'g1', number: 'C1', displayName: 'Acme', balance: 5, email: 'leak@x' }] });
        const stderr = captureStderr();
        let out: { '@via': string; route: string; value: Array<Record<string, unknown>> };
        try {
            out = toolJsonAs(await call('wicket_api_read', { pageId: 30009 }));
        } finally {
            stderr.restore();
        }
        const get = stub.matching(API_URL)[0]!;
        const url = new URL(get.url);
        expect(url.pathname).toBe(`/v2.0/tenant-prod/sandbox/api/v2.0/companies(${COMPANY_A})/customers`);
        expect(url.searchParams.get('$select')).toBe('id,number,displayName,balance');
        expect(url.searchParams.get('$top')).toBe('100');
        expect(get.method).toBe('GET');
        expect(out['@via']).toBe('api');
        expect(out.route).toBe('v2.0/customers');
        // A field the plan did not select never reaches the agent, even if BC sends it.
        expect(out.value).toEqual([{ '@odata.etag': 'W/1', id: 'g1', number: 'C1', displayName: 'Acme', balance: 5 }]);
        expect(stderr.lines.join('')).toContain('api read connection=prod route=v2.0/customers');
        // Governance was asked fresh, for this page.
        const describeCall = stub.rpcRequests.find((r) => opOf(r) === 'describe')!;
        expect(dataOf(describeCall)).toEqual({ kind: 'api', pageId: 30009 });
    });

    test('passes select, filter, orderBy, top, skip and count through, and reports @nextSkip on a full page', async () => {
        apiAnswer = () => jsonResponse({ '@odata.count': 7, value: [{ number: 'C1' }, { number: 'C2' }] });
        const out = toolJsonAs<{ '@count': number; '@nextSkip': number }>(
            await call('wicket_api_read', {
                pageId: 30009,
                select: ['number', 'displayName'],
                filter: "balance gt 1000 and displayName eq 'O''Brien email'",
                orderBy: ['displayName DESC'],
                top: 2,
                skip: 4,
                count: true,
            }),
        );
        const params = new URL(stub.matching(API_URL)[0]!.url).searchParams;
        expect(params.get('$select')).toBe('number,displayName');
        expect(params.get('$filter')).toBe("balance gt 1000 and displayName eq 'O''Brien email'");
        expect(params.get('$orderby')).toBe('displayName desc');
        expect(params.get('$top')).toBe('2');
        expect(params.get('$skip')).toBe('4');
        expect(params.get('$count')).toBe('true');
        expect(out['@count']).toBe(7);
        expect(out['@nextSkip']).toBe(6);
    });

    test('a non-routable API is refused before any API call, pointing at wicket_query', async () => {
        describeAnswer = customersApi({ routable: false, notRoutableReason: 'routing-off' });
        const res = await call('wicket_api_read', { pageId: 30009 });
        expect(toolIsError(res)).toBe(true);
        const problem = toolJsonAs<{ type: string; status: number; suggest: { use: string; tableId: number; reason: string } }>(res);
        expect(problem.type).toEndWith('/api-not-routable');
        expect(problem.status).toBe(403);
        expect(problem.suggest).toEqual({ use: 'wicket_query', tableId: 18, reason: 'routing-off' });
        expect(stub.matching(API_URL)).toHaveLength(0);
    });

    test.each([
        [{ select: ['email'] }, 403, 'field-restricted'],
        [{ select: ['lastModifiedDateTime'] }, 403, 'field-restricted'],
        [{ select: ['nope'] }, 400, 'unknown-api-field'],
        [{ filter: "email eq 'a@b'" }, 403, 'field-restricted'],
        [{ filter: 'secretThing eq 1' }, 400, 'unknown-api-field'],
        [{ filter: "address/city eq 'X'" }, 400, 'invalid-filter'],
        [{ filter: "displayName eq 'open" }, 400, 'invalid-filter'],
        [{ orderBy: ['email asc'] }, 403, 'field-restricted'],
        [{ orderBy: ['displayName sideways'] }, 400, 'invalid-orderby'],
    ])('refuses %j with %i %s and sends nothing to the API', async (args, status, slug) => {
        const res = await call('wicket_api_read', { pageId: 30009, ...args });
        expect(toolIsError(res)).toBe(true);
        const problem = toolJsonAs<{ type: string; status: number }>(res);
        expect(problem.status).toBe(status);
        expect(problem.type).toEndWith(`/${slug}`);
        expect(stub.matching(API_URL)).toHaveLength(0);
    });

    test('a custom publisher route builds /api/<publisher>/<group>/<version>/companies(...)/<entitySet>', async () => {
        describeAnswer = customersApi({ id: 50500, route: 'contoso/sales/v1.0/orders', sourceTableId: 50500 });
        await call('wicket_api_read', { pageId: 50500, select: ['number'] });
        expect(new URL(stub.matching(API_URL)[0]!.url).pathname).toBe(
            `/v2.0/tenant-prod/sandbox/api/contoso/sales/v1.0/companies(${COMPANY_A})/orders`,
        );
    });

    test('a route that did not come from BC metadata is refused', async () => {
        describeAnswer = customersApi({ route: 'v2.0/customers?$expand=x' });
        const res = await call('wicket_api_read', { pageId: 30009, select: ['number'] });
        expect(toolJsonAs<{ type: string }>(res).type).toEndWith('/invalid-route');
        expect(stub.matching(API_URL)).toHaveLength(0);
    });

    test("BC's own OData error surfaces as an api-error problem", async () => {
        apiAnswer = () => jsonResponse({ error: { code: 'BadRequest', message: 'Could not find a property named foo.' } }, 400);
        const res = await call('wicket_api_read', { pageId: 30009, select: ['number'] });
        const problem = toolJsonAs<{ type: string; status: number; detail: string }>(res);
        expect(problem.type).toEndWith('/api-error');
        expect(problem.status).toBe(400);
        expect(problem.detail).toBe('Could not find a property named foo.');
    });

    test('a describe with a new catalogVersion drops the in-memory catalog', async () => {
        await call('wicket_apis');
        describeAnswer = customersApi({ catalogVersion: 'v2' });
        catalogVersion = 'v2';
        await call('wicket_api_read', { pageId: 30009, select: ['number'] });
        const out = toolJsonAs<{ source: string; catalogVersion: string }>(await call('wicket_apis'));
        expect(out.source).not.toBe('memory');
        expect(out.catalogVersion).toBe('v2');
    });
});

// ---------------------------------------------------------------------------
// pre-check units
// ---------------------------------------------------------------------------

describe('scanFilter and planApiRead', () => {
    test('literals are skipped: strings (with doubled apostrophes), GUIDs, numbers and dates', () => {
        expect(
            scanFilter("id eq 3f2a8c1e-7b4d-4e9a-a1c2-6d5e4f3b2a10 and name eq 'it''s balance' and d ge 2026-01-01T00:00:00Z and n gt 1.5"),
        ).toEqual({ identifiers: ['id', 'eq', 'and', 'name', 'eq', 'and', 'd', 'ge', 'and', 'n', 'gt'] });
        expect(scanFilter("startswith(displayName,'A')")).toEqual({ identifiers: ['startswith', 'displayName'] });
    });

    test('a field that shares a function name is still checked against the policy', () => {
        const api: ApiDescription = {
            id: 1,
            route: 'v2.0/x',
            entitySetName: 'x',
            routable: true,
            fields: [
                { name: 'number', readable: true },
                { name: 'date', readable: false },
            ],
        };
        const plan = planApiRead(api, { filter: 'date gt 2026-01-01' });
        expect('slug' in plan && plan.slug).toBe('field-restricted');
    });
});

describe('planApiRead and masked fields', () => {
    test('a field the server describes as masked (readable:false, access:"masked") is refused for select and filter', () => {
        const api = {
            id: 1,
            route: 'v2.0/x',
            entitySetName: 'x',
            routable: true,
            fields: [
                { name: 'number', readable: true, access: 'clear' },
                { name: 'email', readable: false, access: 'masked' },
            ],
        } as unknown as ApiDescription;
        const sel = planApiRead(api, { select: ['number', 'email'] });
        expect('slug' in sel && sel.slug).toBe('field-restricted');
        const flt = planApiRead(api, { filter: "email eq 'a@b.c'" });
        expect('slug' in flt && flt.slug).toBe('field-restricted');
        expect('slug' in planApiRead(api, { select: ['number'] })).toBe(false);
    });
});
