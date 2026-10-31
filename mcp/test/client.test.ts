/**
 * WicketClient transport contract: URL + envelope construction, OData unwrapping, RFC 7807
 * problem detection, synthetic transport/timeout problems, the readOnly guard, and the
 * per-connection ClientPool. Plus the small pure helpers (isProblem, readPage, compact…).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignInRequiredError } from '../src/connections.ts';
import {
    WicketClient,
    WicketProblemError,
    ClientPool,
    MUTATING_OPERATIONS,
    SERVER_VERSION,
    compact,
    fail,
    isProblem,
    isWriteCall,
    liftJsonObjectString,
    ok,
    readPage,
    truncate,
} from '../src/index.ts';
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
    spec,
    textResponse,
    timeoutRejection,
} from './helpers.ts';

let restoreEnv: () => void;
let stub: FetchStub;

beforeEach(() => {
    restoreEnv = sandboxEnv({ WICKET_TEST_SECRET: 's3cret' });
    stub = new FetchStub().install();
});

afterEach(() => {
    stub.uninstall();
    restoreEnv();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function problemOf(p: Promise<unknown>): Promise<WicketProblemError> {
    try {
        await p;
    } catch (err) {
        if (err instanceof WicketProblemError) return err;
        throw new Error(`expected WicketProblemError, got ${String(err)}`);
    }
    throw new Error('expected the call to reject');
}

// ---------------------------------------------------------------------------
// call(): request shape
// ---------------------------------------------------------------------------

describe('WicketClient.call request shape', () => {
    test('POSTs the envelope to the company-scoped bound-action URL with a bearer token', async () => {
        stub.token('tok-abc').rpc(() => odata({ rows: 1 }));
        const client = new WicketClient(
            spec({ name: 'prod', tenantId: 'tenant-p', environment: 'Production', companyId: COMPANY_B }),
        );

        const result = await client.call('query', { tableId: 18, top: 5 });

        expect(result).toEqual({ rows: 1 });
        expect(stub.rpcRequests).toHaveLength(1);
        const req = stub.rpcRequests[0]!;
        expect(req.url).toBe(
            'https://api.businesscentral.dynamics.com/v2.0/tenant-p/Production/api/wicket/rpc/v1.0/' +
                `companies(${COMPANY_B})/wicketEndpoint(0)/Microsoft.NAV.query`,
        );
        expect(req.method).toBe('POST');
        expect(req.headers.authorization).toBe('Bearer tok-abc');
        expect(req.headers['content-type']).toBe('application/json');
        expect(req.headers.accept).toBe('application/json');
        expect(req.signal).toBeInstanceOf(AbortSignal);

        const envelope = req.json as Record<string, unknown>;
        expect(Object.keys(envelope).sort()).toEqual(['data', 'id', 'issuedAt', 'origin']);
        expect(envelope.id).toMatch(UUID_RE);
        expect(new Date(envelope.issuedAt as string).toISOString()).toBe(envelope.issuedAt as string);
        expect(envelope.origin).toBe(`mcp.wicket/${SERVER_VERSION}+prod`);
        expect(envelope.data).toEqual({ tableId: 18, top: 5 });
    });

    test('the wire body is {"envelope": "<envelope JSON as a string>"} — the only shape BC publishes', async () => {
        // BC publishes a bound action only for simple parameter types; a JsonObject parameter is left
        // out of $metadata entirely (proven against a BC 28 sandbox, 2026-09-24). So the body carries
        // exactly one member, "envelope", whose value is the serialised envelope.
        stub.token().rpc(() => odata({ rows: 1 }));
        await new WicketClient(spec()).call('whoAmI', {});
        const wire = stub.rpcRequests[0]!.wireJson as Record<string, unknown>;
        expect(Object.keys(wire)).toEqual(['envelope']);
        expect(typeof wire.envelope).toBe('string');
        expect(JSON.parse(wire.envelope as string)).toMatchObject({ data: {} });
    });

    test('every call gets a fresh envelope id', async () => {
        stub.token().rpc(() => odata({}));
        const client = new WicketClient(spec());
        await client.call('capabilities', {});
        await client.call('capabilities', {});
        const ids = stub.rpcRequests.map((r) => (r.json as { id: string }).id);
        expect(new Set(ids).size).toBe(2);
    });

    test('every call carries User-Agent Wicket-MCP/<version> and client-request-id equal to the envelope id', async () => {
        stub.token().rpc(() => odata({}));
        const client = new WicketClient(spec());

        await client.call('query', { tableId: 18 });
        await client.call('changes', {});

        for (const req of stub.rpcRequests) {
            expect(req.headers['user-agent']).toBe(`Wicket-MCP/${SERVER_VERSION}`);
            expect(req.headers['client-request-id']).toBe((req.json as { id: string }).id);
        }
        expect(stub.rpcRequests[0]!.headers['client-request-id']).not.toBe(stub.rpcRequests[1]!.headers['client-request-id']);
    });

    test('honours a custom baseUrl and strips trailing slashes', async () => {
        stub.token().rpc(() => odata({}));
        const client = new WicketClient(spec({ baseUrl: 'https://bc.contoso.local:7048/BC260///' }));
        await client.call('whoAmI', {});
        expect(stub.rpcRequests[0]!.url).toBe(
            'https://bc.contoso.local:7048/BC260/api/wicket/rpc/v1.0/' +
                `companies(${COMPANY_A})/wicketEndpoint(0)/Microsoft.NAV.whoAmI`,
        );
    });

    test('an explicit origin (the env default with BC_ORIGIN) replaces the composed one', async () => {
        stub.token().rpc(() => odata({}));
        await new WicketClient(spec({ name: 'default', origin: 'ops.bot/2' })).call('whoAmI', {});
        expect((stub.rpcRequests[0]!.json as { origin: string }).origin).toBe('ops.bot/2');
    });

    test('stamps idempotencyKey on the envelope only when supplied', async () => {
        stub.token().rpc(() => odata({}));
        const client = new WicketClient(spec());
        await client.call('insert', { tableId: 18 });
        await client.call('insert', { tableId: 18 }, 'order-42');
        const [without, withKey] = stub.rpcRequests.map((r) => r.json as Record<string, unknown>);
        expect('idempotencyKey' in without!).toBe(false);
        expect(withKey!.idempotencyKey).toBe('order-42');
        expect(withKey!.data).toEqual({ tableId: 18 });
    });

    test('reuses the cached token across calls on the same connection', async () => {
        stub.token().rpc(() => odata({}));
        const client = new WicketClient(spec());
        await client.call('capabilities', {});
        await client.call('capabilities', {});
        expect(stub.tokenRequests).toHaveLength(1);
        expect(stub.rpcRequests).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// call(): response handling
// ---------------------------------------------------------------------------

describe('WicketClient.call response handling', () => {
    test('unwraps the OData "value" and returns the operation result with its @annotations', async () => {
        const page = { value: [{ No: '10000' }], '@nextLink': 'c1', '@count': 7, '@pagingMode': 'cursor' };
        stub.token().rpc(() => odata(page));
        expect(await new WicketClient(spec()).call('query', { tableId: 18 })).toEqual(page);
    });

    test('a body without a "value" wrapper is returned as-is; an empty body becomes {}', async () => {
        stub.token().rpc((_req, nth) => (nth === 0 ? jsonResponse({ bare: true }) : textResponse('', 200)));
        const client = new WicketClient(spec());
        expect(await client.call('capabilities', {})).toEqual({ bare: true });
        expect(await client.call('capabilities', {})).toEqual({});
    });

    test('an RFC 7807 problem inside value is thrown as WicketProblemError with the full document', async () => {
        const problem = {
            type: 'https://wicket.example/errors/not-exposed',
            title: 'Table not exposed',
            status: 403,
            detail: 'Table 18 is not exposed',
            operation: 'query',
            suggest: { use: 'discover' },
        };
        stub.token().rpc(() => odata(problem));
        const err = await problemOf(new WicketClient(spec()).call('query', { tableId: 18 }));
        expect(err.problem).toEqual(problem);
        expect(err.name).toBe('WicketProblemError');
        expect(err.message).toBe('Wicket query failed (403 Table not exposed): Table 18 is not exposed');
    });

    test('a business result carrying type+status but no title is NOT mistaken for a problem', async () => {
        const shipment = { type: 'shipment', status: 2, id: 'S-1' };
        stub.token().rpc(() => odata(shipment));
        expect(await new WicketClient(spec()).call('invoke', {})).toEqual(shipment);
    });

    test('a non-200 transport response becomes a synthetic problem lifting error.message', async () => {
        stub.token().rpc(() =>
            jsonResponse({ error: { code: 'Unauthorized', message: 'The credentials provided are incorrect' } }, 401),
        );
        const err = await problemOf(new WicketClient(spec()).call('query', {}));
        expect(err.problem).toEqual({
            type: 'https://wicket.example/errors/transport',
            title: 'Transport error (HTTP 401)',
            status: 401,
            detail: 'The credentials provided are incorrect',
            operation: 'query',
        });
    });

    test('a non-200 with a top-level message or a non-JSON body keeps what it can', async () => {
        stub.token().rpc((_req, nth) =>
            nth === 0 ? jsonResponse({ message: 'Route not found' }, 404) : textResponse('<html>502</html>', 502),
        );
        const client = new WicketClient(spec());
        expect((await problemOf(client.call('query', {}))).problem).toMatchObject({
            status: 404,
            detail: 'Route not found',
        });
        const bad = (await problemOf(client.call('query', {}))).problem;
        expect(bad).toMatchObject({ status: 502 });
        expect(bad.detail).toStartWith('<html>502</html> — ');
    });

    test('a long non-JSON error body is truncated', async () => {
        stub.token().rpc(() => textResponse('x'.repeat(2000), 503));
        const err = await problemOf(new WicketClient(spec()).call('query', {}));
        // 600 chars + ellipsis, then the retry guidance a 5xx carries.
        expect(err.problem.detail).toStartWith(`${'x'.repeat(600)}… — `);
        expect(err.problem.detail).not.toContain('x'.repeat(601));
    });

    test('a 200 with a non-JSON body is a plain Error (not a problem)', async () => {
        stub.token().rpc(() => textResponse('<html>login page</html>', 200));
        await expect(new WicketClient(spec()).call('query', {})).rejects.toThrow(
            /Wicket query returned non-JSON body \(HTTP 200\): <html>login page<\/html>/,
        );
    });

    test('a timed-out RPC becomes a synthetic 504 transport-timeout problem', async () => {
        stub.token().rpc(() => timeoutRejection());
        const err = await problemOf(new WicketClient(spec({ name: 'slow' })).call('query', {}));
        expect(err.problem).toMatchObject({
            type: 'https://wicket.example/errors/transport-timeout',
            status: 504,
            operation: 'query',
        });
        expect(err.problem.detail).toMatch(/within 120s on connection "slow"/);
    });

    test('other fetch failures propagate unchanged', async () => {
        stub.token().rpc(() => {
            throw new TypeError('fetch failed: ECONNREFUSED');
        });
        await expect(new WicketClient(spec()).call('query', {})).rejects.toThrow(/ECONNREFUSED/);
    });

    test('a token failure aborts before any RPC request', async () => {
        stub.route(/login\.microsoftonline\.com/, () => textResponse('nope', 400)).rpc(() => odata({}));
        await expect(new WicketClient(spec()).call('query', {})).rejects.toThrow(/token request failed/);
        expect(stub.rpcRequests).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// transport failures: outcome guidance, 401 retry, sign-in, string-wrapped values
// ---------------------------------------------------------------------------

describe('WicketClient transport failure guidance', () => {
    test('a 5xx on a read says it is safe to retry', async () => {
        stub.token().rpc(() => textResponse('bad gateway', 502));
        const err = await problemOf(new WicketClient(spec()).call('query', { tableId: 18 }));
        expect(err.problem.detail).toContain('safe to retry');
        expect(err.problem.detail).not.toContain('UNKNOWN');
    });

    test('a 5xx on a write without a key says the outcome is unknown: query before retrying', async () => {
        stub.token().rpc(() => textResponse('unavailable', 503));
        const err = await problemOf(new WicketClient(spec()).call('insert', { tableId: 18 }));
        expect(err.problem.detail).toContain('outcome is UNKNOWN');
        expect(err.problem.detail).toContain('query the affected records');
        expect(err.problem.detail).toContain('pass an idempotencyKey');
        expect(err.problem.detail).not.toContain('safe to retry');
    });

    test('a 5xx on a write WITH a key says resend with the same key', async () => {
        stub.token().rpc(() => textResponse('gateway timeout', 504));
        const err = await problemOf(new WicketClient(spec()).call('action', { action: 'post-sales' }, 'post-42'));
        expect(err.problem.detail).toContain('SAME idempotencyKey ("post-42")');
        expect(err.problem.detail).toContain('idempotency-in-progress');
    });

    test('a query with deliver counts as a write; a 4xx carries no guidance', async () => {
        expect(isWriteCall('query', { deliver: { mode: 'azureBlob' } })).toBe(true);
        expect(isWriteCall('query', { tableId: 18 })).toBe(false);
        expect(isWriteCall('invoke', {})).toBe(true);
        stub.token().rpc((_req, nth) => (nth === 0 ? textResponse('down', 503) : jsonResponse({ message: 'nope' }, 404)));
        const client = new WicketClient(spec());
        const deliver = await problemOf(client.call('query', { tableId: 18, deliver: { mode: 'azureBlob' } }));
        expect(deliver.problem.detail).toContain('outcome is UNKNOWN');
        expect((await problemOf(client.call('insert', {}))).problem.detail).toBe('nope');
    });

    test('a timeout on a write names the key to resend with; on a read it says safe to retry', async () => {
        stub.token().rpc(() => timeoutRejection());
        const client = new WicketClient(spec());
        const write = await problemOf(client.call('modify', { tableId: 18 }, 'k-1'));
        expect(write.problem).toMatchObject({ status: 504, type: 'https://wicket.example/errors/transport-timeout' });
        expect(write.problem.detail).toContain('SAME idempotencyKey ("k-1")');
        expect(write.problem.detail).not.toContain('safe to retry');
        const unkeyed = await problemOf(client.call('delete', { tableId: 18 }));
        expect(unkeyed.problem.detail).toContain('Do NOT blindly retry');
        const read = await problemOf(client.call('query', { tableId: 18 }));
        expect(read.problem.detail).toContain('safe to retry');
        expect(read.problem.detail).toContain('Narrow the query');
    });
});

describe('WicketClient 401 handling', () => {
    test('a 401 drops the cached token and resends once with a fresh one', async () => {
        stub.route(/login\.microsoftonline\.com/, (_req, nth) => jsonResponse({ access_token: `tok-${nth}`, expires_in: 3600 }))
            .rpc((_req, nth) => (nth === 0 ? jsonResponse({ error: { message: 'expired' } }, 401) : odata({ ok: 1 })));
        const client = new WicketClient(spec());
        expect(await client.call('insert', { tableId: 18 }, 'k')).toEqual({ ok: 1 });
        expect(stub.tokenRequests).toHaveLength(2);
        expect(stub.rpcRequests.map((r) => r.headers.authorization)).toEqual(['Bearer tok-0', 'Bearer tok-1']);
        // Same envelope both times — the resend is the identical request.
        expect(stub.rpcRequests[0]!.rawBody).toBe(stub.rpcRequests[1]!.rawBody);
    });

    test('a second 401 is surfaced; other statuses are never retried', async () => {
        stub.token().rpc((_req, nth) => (nth < 2 ? jsonResponse({ message: 'denied' }, 401) : jsonResponse({ message: 'no' }, 403)));
        const client = new WicketClient(spec());
        expect((await problemOf(client.call('query', {}))).problem).toMatchObject({ status: 401, detail: 'denied' });
        expect(stub.rpcRequests).toHaveLength(2);
        expect((await problemOf(client.call('query', {}))).problem).toMatchObject({ status: 403 });
        expect(stub.rpcRequests).toHaveLength(3);
    });

    test('a token source without invalidate is not retried', async () => {
        stub.rpc(() => jsonResponse({ message: 'denied' }, 401));
        const client = new WicketClient(spec(), { getToken: async () => 'fixed' });
        await problemOf(client.call('query', {}));
        expect(stub.rpcRequests).toHaveLength(1);
    });
});

describe('WicketClient device-code sign-in', () => {
    test('a pending sign-in becomes a 401 sign-in-required problem carrying the URL and code', async () => {
        stub.rpc(() => odata({}));
        const client = new WicketClient(spec({ name: 'me', authMode: 'device_code' }), {
            getToken: async () => {
                throw new SignInRequiredError('me', {
                    kind: 'device_code',
                    verificationUri: 'https://microsoft.com/devicelogin',
                    userCode: 'ABCD-EFGH',
                });
            },
        });
        const err = await problemOf(client.call('whoAmI', {}));
        expect(err.problem).toMatchObject({
            type: 'https://wicket.example/errors/sign-in-required',
            status: 401,
            operation: 'whoAmI',
            verificationUri: 'https://microsoft.com/devicelogin',
            userCode: 'ABCD-EFGH',
        });
        expect(err.problem.detail).toContain('https://microsoft.com/devicelogin');
        expect(err.problem.detail).toContain('ABCD-EFGH');
        expect(err.problem.detail).toContain('sign in, then retry the call');
        expect(stub.requests).toHaveLength(0);
    });

    test('the sign-in problem for a browser connection says a window opened and carries no userCode', async () => {
        const client = new WicketClient(spec({ name: 'web', authMode: 'browser' }), {
            getToken: async () => {
                throw new SignInRequiredError('web', { kind: 'browser' });
            },
        });
        const err = await problemOf(client.call('whoAmI', {}));
        expect(err.problem).toMatchObject({ type: 'https://wicket.example/errors/sign-in-required', status: 401 });
        expect(err.problem.detail).toContain('sign-in window opened in your browser');
        expect(err.problem.detail).toContain('retry');
        expect(err.problem).not.toHaveProperty('userCode');
        expect(err.problem).not.toHaveProperty('verificationUri');
        expect(stub.requests).toHaveLength(0);
    });
});

describe('string-wrapped OData value', () => {
    test('a value that is a JSON-object string is parsed, so a problem inside it is still detected', async () => {
        const problem = { type: 'https://wicket.example/errors/not-exposed', title: 'Table not exposed', status: 403 };
        stub.token().rpc((_req, nth) => (nth === 0 ? odata(JSON.stringify(problem)) : odata(JSON.stringify({ rows: 2 }))));
        const client = new WicketClient(spec());
        expect((await problemOf(client.call('query', {}))).problem).toEqual(problem);
        expect(await client.call('query', {})).toEqual({ rows: 2 });
    });

    test('JSON object/array strings are decoded; other strings are left alone', () => {
        expect(liftJsonObjectString('## Markdown')).toBe('## Markdown');
        expect(liftJsonObjectString('[1,2]')).toEqual([1, 2]);
        expect(liftJsonObjectString('{ not json')).toBe('{ not json');
        expect(liftJsonObjectString(' {"a":1}')).toEqual({ a: 1 });
        expect(liftJsonObjectString(7)).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// readOnly guard
// ---------------------------------------------------------------------------

describe('WicketClient readOnly guard', () => {
    test('refuses every mutating operation before minting a token', async () => {
        stub.token().rpc(() => odata({}));
        const client = new WicketClient(spec({ name: 'ro', readOnly: true }));
        for (const op of MUTATING_OPERATIONS) {
            const err = await problemOf(client.call(op, {}));
            expect(err.problem).toMatchObject({
                type: 'https://wicket.example/errors/connection-read-only',
                status: 403,
                operation: op,
                suggest: { use: 'wicket_connections' },
            });
            expect(err.problem.detail).toContain('connection "ro"');
        }
        expect(stub.requests).toHaveLength(0);
    });

    test('lets read operations through', async () => {
        stub.token().rpc(() => odata({ ok: 1 }));
        const client = new WicketClient(spec({ readOnly: true }));
        for (const op of ['discover', 'describe', 'query', 'readBlob', 'capabilities', 'status', 'requests', 'pageUrl', 'whoAmI', 'cancel']) {
            expect(await client.call(op, {})).toEqual({ ok: 1 });
        }
    });

    test('a query deliver submit is allowed (AL does not count delivery as mutating)', async () => {
        stub.token().rpc(() => odata({ '@async': true, requestId: 'r1' }));
        const client = new WicketClient(spec({ readOnly: true }));
        expect(await client.call('query', { tableId: 18, deliver: { mode: 'azureBlob' } }, 'k')).toEqual({
            '@async': true,
            requestId: 'r1',
        });
    });

    test('lets an action preview through (it runs inside the forced rollback)', async () => {
        stub.token().rpc(() => odata({ preview: true, wouldPost: true }));
        const client = new WicketClient(spec({ readOnly: true }));
        expect(await client.call('action', { action: 'post-sales', preview: true })).toEqual({ preview: true, wouldPost: true });
        expect(stub.rpcRequests).toHaveLength(1);
    });

    test('lets a verb through only when capabilities says mutating: false', async () => {
        const actions = [
            { action: 'item-availability', enabled: true, mutating: false },
            { action: 'post-sales', enabled: true, mutating: true },
        ];
        // The wire shape of an operation result: { value: {...}, '@requestId' }.
        stub.token().rpc((req) =>
            req.url.includes('capabilities') ? odata({ value: { actions }, '@requestId': 'r' }) : odata({ ok: 1 }),
        );
        const client = new WicketClient(spec({ name: 'ro', readOnly: true }));
        expect(await client.call('action', { action: 'Item-Availability' })).toEqual({ ok: 1 });
        const err = await problemOf(client.call('action', { action: 'post-sales' }));
        expect(err.problem).toMatchObject({ status: 403, operation: 'action' });
        // capabilities twice, the non-mutating verb once; the mutating verb never reached BC.
        expect(stub.rpcRequests.filter((r) => !r.url.includes('capabilities'))).toHaveLength(1);
    });

    test('the mutating set matches the AL dispatcher list', () => {
        expect([...MUTATING_OPERATIONS].sort()).toEqual(['action', 'batch', 'delete', 'insert', 'invoke', 'modify']);
    });
});

// ---------------------------------------------------------------------------
// ClientPool
// ---------------------------------------------------------------------------

describe('ClientPool', () => {
    let tmp: TempDir;
    beforeEach(() => {
        tmp = new TempDir();
    });
    afterEach(() => tmp.cleanup());

    test('caches one client per connection and follows the resolution ladder', async () => {
        const reg = loadRegistry(tmp, {
            default: 'prod',
            connections: {
                prod: entry({ tenantId: 'tenant-prod', clientId: 'client-prod' }),
                sandbox: entry({ tenantId: 'tenant-sb', clientId: 'client-sb', companyId: COMPANY_B }),
            },
        });
        const pool = new ClientPool(reg);
        expect(pool.get()).toBe(pool.get('prod'));
        expect(pool.get('sandbox')).not.toBe(pool.get('prod'));
        expect(pool.get('sandbox')).toBe(pool.get('sandbox'));
        reg.select('sandbox');
        expect(pool.get()).toBe(pool.get('sandbox'));
        expect(() => pool.get('ghost')).toThrow(/Unknown connection "ghost"/);
    });

    test('tokens never cross connections: each client mints with its own tenant and client id', async () => {
        stub.route(/login\.microsoftonline\.com\/tenant-prod\//, () =>
            jsonResponse({ access_token: 'tok-prod', expires_in: 3600 }),
        )
            .route(/login\.microsoftonline\.com\/tenant-sb\//, () =>
                jsonResponse({ access_token: 'tok-sb', expires_in: 3600 }),
            )
            .rpc(() => odata({}));
        const reg = loadRegistry(tmp, {
            connections: {
                prod: entry({ tenantId: 'tenant-prod', clientId: 'client-prod' }),
                sandbox: entry({ tenantId: 'tenant-sb', clientId: 'client-sb', companyId: COMPANY_B }),
            },
        });
        const pool = new ClientPool(reg);
        await pool.get('prod').call('whoAmI', {});
        await pool.get('sandbox').call('whoAmI', {});
        await pool.get('prod').call('whoAmI', {});

        expect(stub.tokenRequests.map((r) => r.form.get('client_id'))).toEqual(['client-prod', 'client-sb']);
        const rpc = stub.rpcRequests;
        expect(rpc.map((r) => r.headers.authorization)).toEqual(['Bearer tok-prod', 'Bearer tok-sb', 'Bearer tok-prod']);
        expect(rpc[0]!.url).toContain(`/v2.0/tenant-prod/sandbox/`);
        expect(rpc[0]!.url).toContain(`companies(${COMPANY_A})`);
        expect(rpc[1]!.url).toContain(`/v2.0/tenant-sb/sandbox/`);
        expect(rpc[1]!.url).toContain(`companies(${COMPANY_B})`);
        expect((rpc[1]!.json as { origin: string }).origin).toBe(`mcp.wicket/${SERVER_VERSION}+sandbox`);
    });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('server version', () => {
    const root = join(import.meta.dir, '..');
    test('SERVER_VERSION matches package.json', () => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
        expect(SERVER_VERSION).toBe(pkg.version);
    });
    test('the README origin example carries the current version', () => {
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(`"mcp.wicket/${SERVER_VERSION}+<connection>"`);
    });
});

describe('isProblem', () => {
    test('requires string type, string title and numeric status', () => {
        expect(isProblem({ type: 't', title: 'x', status: 400 })).toBe(true);
        expect(isProblem({ type: 't', title: 'x', status: 400, detail: 'd', extra: 1 })).toBe(true);
        expect(isProblem({ type: 'shipment', status: 2 })).toBe(false);
        expect(isProblem({ type: 't', title: 'x', status: '400' })).toBe(false);
        expect(isProblem({ type: 1, title: 'x', status: 400 })).toBe(false);
        expect(isProblem(null)).toBe(false);
        expect(isProblem(undefined)).toBe(false);
        expect(isProblem('type')).toBe(false);
        expect(isProblem([{ type: 't', title: 'x', status: 400 }])).toBe(false);
    });
});

describe('readPage', () => {
    test('accepts a bare array', () => {
        expect(readPage([1, 2])).toEqual({ value: [1, 2], nextLink: undefined, pagingMode: undefined, count: undefined });
    });
    test('reads the Wicket page object', () => {
        expect(readPage({ value: [1], '@nextLink': 'c1', '@pagingMode': 'cursor', '@count': 9 })).toEqual({
            value: [1],
            nextLink: 'c1',
            pagingMode: 'cursor',
            count: 9,
        });
    });
    test('boxes a scalar value, tolerates a missing value and a non-string @nextLink', () => {
        expect(readPage({ value: 'x' }).value).toEqual(['x']);
        expect(readPage({ '@count': 0 }).value).toEqual([]);
        expect(readPage({ value: [], '@nextLink': 42 }).nextLink).toBeUndefined();
    });
    test('anything else is an empty page', () => {
        expect(readPage(null).value).toEqual([]);
        expect(readPage('rows').value).toEqual([]);
        expect(readPage(7).value).toEqual([]);
    });
});

describe('compact / truncate / ok / fail', () => {
    test('compact drops undefined but keeps null, false, 0 and empty strings', () => {
        expect(compact({ a: undefined, b: null, c: false, d: 0, e: '', f: [] })).toEqual({
            b: null,
            c: false,
            d: 0,
            e: '',
            f: [],
        });
    });
    test('truncate appends an ellipsis only when cutting', () => {
        expect(truncate('abc', 3)).toBe('abc');
        expect(truncate('abcd', 3)).toBe('abc…');
    });
    test('ok renders strings verbatim and objects as pretty JSON', () => {
        expect(ok('plain')).toEqual({ content: [{ type: 'text', text: 'plain' }] });
        expect(ok({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
    });
    test('fail hands back the full problem document for WicketProblemError, else the message', () => {
        const problem = { type: 't', title: 'T', status: 409, detail: 'd' };
        const asProblem = fail(new WicketProblemError(problem));
        expect(asProblem.isError).toBe(true);
        expect(JSON.parse((asProblem.content[0] as { text: string }).text)).toEqual(problem);
        expect(fail(new Error('boom'))).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
        expect(fail('str')).toEqual({ content: [{ type: 'text', text: 'str' }], isError: true });
    });
});

// ---------------------------------------------------------------------------
// unmask opt-out (field masking)
// ---------------------------------------------------------------------------
describe('WicketClient unmask opt-out', () => {
    test('a connection with unmask:false stamps "unmask": false on query, readBlob and describe data', async () => {
        stub.token().rpc(() => odata({ ok: 1 }));
        const client = new WicketClient(spec({ unmask: false }));
        for (const op of ['query', 'readBlob', 'describe']) {
            await client.call(op, { tableId: 18 });
        }
        for (const req of stub.rpcRequests) {
            const data = (req.json as { data: Record<string, unknown> }).data;
            expect(data).toEqual({ tableId: 18, unmask: false });
        }
        expect(stub.rpcRequests).toHaveLength(3);
    });

    test('default (undefined) and unmask:true send no unmask member, and non-read operations never get one', async () => {
        stub.token().rpc(() => odata({ ok: 1 }));
        await new WicketClient(spec()).call('query', { tableId: 18 });
        await new WicketClient(spec({ unmask: true })).call('query', { tableId: 18 });
        await new WicketClient(spec({ unmask: false })).call('whoAmI', {});
        for (const req of stub.rpcRequests) {
            const data = (req.json as { data: Record<string, unknown> }).data;
            expect('unmask' in data).toBe(false);
        }
        expect(stub.rpcRequests).toHaveLength(3);
    });
});
