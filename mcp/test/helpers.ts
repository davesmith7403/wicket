/**
 * Shared test scaffolding for the Wicket MCP server suite.
 *
 * - FetchStub: replaces globalThis.fetch with a route-based recorder so the token POST
 *   and the Wicket POST can be scripted per test and inspected afterwards.
 * - sandboxEnv: isolates every BC_* / WICKET_* variable, points
 *   WICKET_CONNECTIONS_FILE at a nonexistent path and the config home at a fresh temp dir, so
 *   the operator's real ~/.config/wicket is never read by a test.
 * - TempDir + loadRegistry: write a connections.json fixture and load it for real through
 *   ConnectionRegistry.load().
 * - startServer: wire buildServer to an MCP Client over the SDK's in-memory transport so
 *   tools are exercised end to end (zod validation, handler, result rendering).
 */

import { spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ConnectionRegistry, configHome, type ConnectionSpec } from '../src/connections.ts';
import { ClientPool, buildServer } from '../src/index.ts';

export const COMPANY_A = '11111111-1111-1111-1111-111111111111';
export const COMPANY_B = '22222222-2222-2222-2222-222222222222';

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

export interface RecordedRequest {
    url: string;
    method: string;
    /** Header names lower-cased. */
    headers: Record<string, string>;
    rawBody: string;
    /**
     * JSON.parse(rawBody) when it parses, else undefined. For a Wicket POST this is the DECODED
     * envelope (the wire carries it as a string in `{"envelope": "<json>"}`); `wireJson` keeps the
     * body exactly as sent.
     */
    json: unknown;
    /** JSON.parse(rawBody) as sent, before the RPC envelope string is decoded. */
    wireJson: unknown;
    /** Form view of the body (the Entra token POST is x-www-form-urlencoded). */
    form: URLSearchParams;
    signal: AbortSignal | null | undefined;
}

/** `nth` counts prior matches of the same route, so a handler can script page 1, 2, 3… */
export type RouteHandler = (req: RecordedRequest, nth: number) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function textResponse(text: string, status = 200): Response {
    return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * Wrap an operation result the way BC does for Wicket's Text-returning bound actions:
 * `{ "@odata.context": …#Edm.String, "value": "<result JSON as a string>" }`.
 */
export function odata(value: unknown): Response {
    return jsonResponse({
        '@odata.context': 'https://bc.example/$metadata#Edm.String',
        value: typeof value === 'string' ? value : JSON.stringify(value),
    });
}

/** A fetch rejection shaped like the one AbortSignal.timeout() produces. */
export function timeoutRejection(): never {
    throw new DOMException('The operation timed out.', 'TimeoutError');
}

export const TOKEN_URL = /login\.microsoftonline\.com\/.+\/oauth2\/v2\.0\/token$/;
export const RPC_URL = /\/api\/wicket\/rpc\/v1\.0\/companies\([^)]+\)\/wicketEndpoint\(0\)\/Microsoft\.NAV\./;

export class FetchStub {
    readonly requests: RecordedRequest[] = [];
    private readonly routes: Array<{ match: RegExp; handler: RouteHandler; hits: number }> = [];
    private original: typeof fetch | null = null;

    route(match: RegExp, handler: RouteHandler): this {
        this.routes.push({ match, handler, hits: 0 });
        return this;
    }

    /** Script the Entra ID token endpoint. */
    token(accessToken = 'test-token', expiresIn: number | undefined = 3600): this {
        return this.route(TOKEN_URL, () =>
            jsonResponse(
                expiresIn === undefined
                    ? { access_token: accessToken, token_type: 'Bearer' }
                    : { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn },
            ),
        );
    }

    /** Script every Wicket POST with one handler. */
    rpc(handler: RouteHandler): this {
        return this.route(RPC_URL, handler);
    }

    matching(re: RegExp): RecordedRequest[] {
        return this.requests.filter((r) => re.test(r.url));
    }

    get tokenRequests(): RecordedRequest[] {
        return this.matching(TOKEN_URL);
    }

    get rpcRequests(): RecordedRequest[] {
        return this.matching(RPC_URL);
    }

    install(): this {
        if (this.original) return this;
        this.original = globalThis.fetch;
        const stubbed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url =
                typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            const method = init?.method ?? 'GET';
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((v, k) => {
                headers[k.toLowerCase()] = v;
            });
            const rawBody =
                typeof init?.body === 'string' ? init.body : init?.body == null ? '' : String(init.body);
            let json: unknown;
            try {
                json = rawBody === '' ? undefined : JSON.parse(rawBody);
            } catch {
                json = undefined;
            }
            const wireJson = json;
            // Decode the Wicket wire envelope so tests assert on the envelope itself.
            if (
                RPC_URL.test(url) &&
                typeof json === 'object' &&
                json !== null &&
                typeof (json as { envelope?: unknown }).envelope === 'string'
            ) {
                try {
                    json = JSON.parse((json as { envelope: string }).envelope);
                } catch {
                    /* leave the wire body as-is */
                }
            }
            const req: RecordedRequest = {
                url,
                method,
                headers,
                rawBody,
                json,
                wireJson,
                form: new URLSearchParams(rawBody),
                signal: init?.signal,
            };
            this.requests.push(req);
            const route = this.routes.find((r) => r.match.test(url));
            if (!route) throw new Error(`FetchStub: unexpected request ${method} ${url}`);
            const nth = route.hits++;
            return await route.handler(req, nth);
        };
        globalThis.fetch = stubbed as typeof fetch;
        return this;
    }

    uninstall(): void {
        if (this.original) {
            globalThis.fetch = this.original;
            this.original = null;
        }
    }
}

// ---------------------------------------------------------------------------
// environment + files
// ---------------------------------------------------------------------------

const ENV_PREFIXES = ['BC_', 'WICKET_'];

/**
 * Remove every BC_* / WICKET_* variable, apply `overrides`, and return a restore function. Unless
 * overridden, WICKET_CONNECTIONS_FILE points at a path that does not exist, and the config home
 * (~/.config) is an empty temp dir, so nothing falls back to the operator's home-directory files.
 */
export function sandboxEnv(overrides: Record<string, string | undefined> = {}): () => void {
    const snapshot = new Map<string, string | undefined>();
    for (const key of Object.keys(process.env)) {
        if (ENV_PREFIXES.some((p) => key.startsWith(p))) {
            snapshot.set(key, process.env[key]);
            delete process.env[key];
        }
    }
    process.env.WICKET_CONNECTIONS_FILE = join(tmpdir(), 'wicket-mcp-test-does-not-exist', 'none.json');
    // Never let a test write the API catalog cache into the operator's real home directory.
    const cacheDir = mkdtempSync(join(tmpdir(), 'wicket-mcp-cache-'));
    process.env.WICKET_CACHE_DIR = cacheDir;
    const realConfigHome = configHome.dir;
    const fakeConfigHome = mkdtempSync(join(tmpdir(), 'wicket-mcp-home-'));
    configHome.dir = fakeConfigHome;
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return () => {
        rmSync(cacheDir, { recursive: true, force: true });
        configHome.dir = realConfigHome;
        rmSync(fakeConfigHome, { recursive: true, force: true });
        for (const key of Object.keys(process.env)) {
            if (ENV_PREFIXES.some((p) => key.startsWith(p))) delete process.env[key];
        }
        for (const [k, v] of snapshot) {
            if (v !== undefined) process.env[k] = v;
        }
    };
}

export class TempDir {
    readonly path = mkdtempSync(join(tmpdir(), 'wicket-mcp-test-'));

    write(name: string, content: string): string {
        const full = join(this.path, name);
        writeFileSync(full, content, 'utf8');
        return full;
    }

    cleanup(): void {
        rmSync(this.path, { recursive: true, force: true });
    }
}

/** A valid connections.json entry with a secretEnv source; override any field. */
export function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        tenantId: 'tenant-a',
        environment: 'sandbox',
        companyId: COMPANY_A,
        clientId: 'client-a',
        secretEnv: 'WICKET_TEST_SECRET',
        ...overrides,
    };
}

/** Write `doc` as connections.json, point the registry at it, and load for real. */
export function loadRegistry(tmp: TempDir, doc: unknown): ConnectionRegistry {
    process.env.WICKET_CONNECTIONS_FILE = tmp.write('connections.json', JSON.stringify(doc));
    return ConnectionRegistry.load();
}

/** A fully resolved spec for unit tests that bypass the registry. */
export function spec(overrides: Partial<ConnectionSpec> = {}): ConnectionSpec {
    return {
        name: 'unit',
        tenantId: 'tenant-a',
        environment: 'sandbox',
        companyId: COMPANY_A,
        authMode: 'client_credentials',
        clientId: 'client-a',
        persistTokenCache: false,
        secretEnv: 'WICKET_TEST_SECRET',
        readOnly: false,
        ...overrides,
    };
}

/** Capture process.stderr.write (the server's only log channel) without printing. */
export function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
    }) as typeof process.stderr.write);
    return { lines, restore: () => spy.mockRestore() };
}

// ---------------------------------------------------------------------------
// in-memory MCP harness
// ---------------------------------------------------------------------------

export interface ServerHarness {
    client: Client;
    pool: ClientPool;
    close(): Promise<void>;
}

export async function startServer(registry: ConnectionRegistry): Promise<ServerHarness> {
    const pool = new ClientPool(registry);
    const server = buildServer(pool, registry);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'wicket-mcp-test', version: '0.0.0' });
    await client.connect(clientTransport);
    return {
        client,
        pool,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

interface ToolResultLike {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
}

export function toolText(result: unknown): string {
    return (result as ToolResultLike).content?.[0]?.text ?? '';
}

/** Parsed JSON of the first text block. Non-generic on purpose: tsc cannot infer a generic in
 *  expect()'s argument position and collapses the matcher to Matchers<undefined>. */
export function toolJson(result: unknown): unknown {
    return JSON.parse(toolText(result));
}

/** Typed view of toolJson for tests that read fields off the result. */
export function toolJsonAs<T>(result: unknown): T {
    return toolJson(result) as T;
}

export function toolIsError(result: unknown): boolean {
    return Boolean((result as ToolResultLike).isError);
}
