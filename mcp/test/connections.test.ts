/**
 * ConnectionRegistry loading + resolution, secret-source validation, secret resolution,
 * and the client_credentials token provider (caching, coalescing, error mapping).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir } from '../src/apiCatalog.ts';
import {
    AppTokenProvider,
    ConnectionRegistry,
    DeviceCodeSignInRequiredError,
    authRecordPath,
    configHome,
    envSetting,
    keychain,
    UserTokenProvider,
    type DeviceCodePrompt,
    isTimeoutError,
    makeTokenSource,
    resolveSecret,
} from '../src/connections.ts';
import {
    COMPANY_A,
    COMPANY_B,
    FetchStub,
    TempDir,
    captureStderr,
    entry,
    loadRegistry,
    sandboxEnv,
    spec,
    timeoutRejection,
} from './helpers.ts';

const TOKEN_URL_LOOSE = /login\.microsoftonline\.com/;

let restoreEnv: () => void;
let tmp: TempDir;

beforeEach(() => {
    restoreEnv = sandboxEnv({ WICKET_TEST_SECRET: 's3cret' });
    tmp = new TempDir();
});

afterEach(() => {
    tmp.cleanup();
    restoreEnv();
});

// ---------------------------------------------------------------------------
// load(): env-implicit "default"
// ---------------------------------------------------------------------------

describe('ConnectionRegistry.load from environment', () => {
    const envDefault = {
        BC_TENANT_ID: 'env-tenant',
        BC_ENVIRONMENT: 'production',
        BC_COMPANY_ID: COMPANY_A,
        BC_CLIENT_ID: 'env-client',
        BC_CLIENT_SECRET: 'env-secret',
    };

    test('builds the implicit "default" connection and makes it the default', () => {
        Object.assign(process.env, envDefault);
        const reg = ConnectionRegistry.load();
        const list = reg.list();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            name: 'default',
            tenantId: 'env-tenant',
            environment: 'production',
            companyId: COMPANY_A,
            authMode: 'client_credentials',
            readOnly: false,
            isDefault: true,
            isSelected: true,
        });
        expect(reg.current()).toEqual({ name: 'default', isSessionSelection: false });
    });

    test('BC_READ_ONLY accepts 1 / true / yes (case-insensitive) and nothing else', () => {
        for (const [raw, expected] of [
            ['1', true],
            ['true', true],
            ['YES', true],
            ['0', false],
            ['no', false],
            ['', false],
        ] as const) {
            Object.assign(process.env, envDefault, { BC_READ_ONLY: raw });
            expect(ConnectionRegistry.load().resolve().readOnly).toBe(expected);
        }
    });

    test('BC_ORIGIN and BC_BASE_URL ride on the env default', () => {
        Object.assign(process.env, envDefault, {
            BC_ORIGIN: 'ops.bot/1',
            BC_BASE_URL: 'https://bc.contoso.local/BC260/',
        });
        const s = ConnectionRegistry.load().resolve();
        expect(s.origin).toBe('ops.bot/1');
        expect(s.baseUrl).toBe('https://bc.contoso.local/BC260/');
    });

    test('an env default without any secret fails at load, not at the first token fetch', () => {
        Object.assign(process.env, envDefault, { BC_CLIENT_SECRET: undefined });
        delete process.env.BC_CLIENT_SECRET;
        expect(() => ConnectionRegistry.load()).toThrow(/no secret source configured/);
    });

    test('a braced or malformed BC_COMPANY_ID is rejected (it is interpolated into the URL)', () => {
        Object.assign(process.env, envDefault, { BC_COMPANY_ID: `{${COMPANY_A}}` });
        expect(() => ConnectionRegistry.load()).toThrow(/brace-less GUID/);
        Object.assign(process.env, envDefault, { BC_COMPANY_ID: 'CRONUS' });
        expect(() => ConnectionRegistry.load()).toThrow(/brace-less GUID/);
    });

    test('BC_TENANT_ID / BC_ENVIRONMENT / BC_BASE_URL / BC_ORIGIN are validated at load', () => {
        for (const [key, value, pattern] of [
            ['BC_TENANT_ID', 'evil/../x', /BC_TENANT_ID "evil\/\.\.\/x" must be a tenant GUID or domain/],
            ['BC_ENVIRONMENT', 'prod?x=1', /BC_ENVIRONMENT "prod\?x=1" must match/],
            ['BC_BASE_URL', 'http://bc.contoso.local/BC260', /BC_BASE_URL .* must be an absolute https:\/\/ URL/],
            ['BC_ORIGIN', 'ops bot', /BC_ORIGIN "ops bot" is invalid/],
            ['BC_ORIGIN', 'x'.repeat(257), /BC_ORIGIN .* is invalid/],
        ] as const) {
            Object.assign(process.env, envDefault);
            delete process.env.BC_BASE_URL;
            delete process.env.BC_ORIGIN;
            process.env[key] = value;
            expect(() => ConnectionRegistry.load()).toThrow(pattern);
        }
        Object.assign(process.env, envDefault, {
            BC_TENANT_ID: 'contoso.onmicrosoft.com',
            BC_ORIGIN: 'ops.bot@x/1+a:b',
            BC_BASE_URL: 'https://bc.contoso.local/BC260',
        });
        expect(ConnectionRegistry.load().resolve().tenantId).toBe('contoso.onmicrosoft.com');
    });

    test('a malformed env default does not block startup when connections.json replaces "default"', () => {
        Object.assign(process.env, envDefault, { BC_COMPANY_ID: 'CRONUS' });
        const reg = loadRegistry(tmp, { connections: { default: entry({ tenantId: 'file-tenant' }), other: entry() } });
        expect(reg.resolve().tenantId).toBe('file-tenant');
        // ...but it still fails fast when nothing replaces it.
        expect(() => loadRegistry(tmp, { connections: { other: entry() } })).toThrow(/BC_COMPANY_ID "CRONUS"/);
    });

    test('an incomplete env quartet is ignored rather than half-loaded', () => {
        Object.assign(process.env, envDefault);
        delete process.env.BC_ENVIRONMENT;
        expect(() => ConnectionRegistry.load()).toThrow(/No Wicket connections configured/);
    });

    test('no env and no file is a clear startup error', () => {
        expect(() => ConnectionRegistry.load()).toThrow(/No Wicket connections configured/);
    });
});

// ---------------------------------------------------------------------------
// load(): connections.json
// ---------------------------------------------------------------------------

describe('ConnectionRegistry.load from connections.json', () => {
    test('loads several connections and honours the declared default', () => {
        const reg = loadRegistry(tmp, {
            default: 'sandbox',
            connections: {
                prod: entry({ tenantId: 'tenant-prod', readOnly: true, description: 'Live' }),
                sandbox: entry({ tenantId: 'tenant-sb', companyId: COMPANY_B }),
            },
        });
        expect(reg.resolve().name).toBe('sandbox');
        expect(reg.resolve('prod')).toMatchObject({ tenantId: 'tenant-prod', readOnly: true });
        expect(reg.list().map((c) => [c.name, c.isDefault, c.isSelected])).toEqual([
            ['prod', false, false],
            ['sandbox', true, true],
        ]);
    });

    test('persistTokenCache defaults to true and can be turned off', () => {
        const reg = loadRegistry(tmp, {
            connections: {
                keep: entry({ authMode: 'device_code' }),
                forget: entry({ authMode: 'device_code', persistTokenCache: false }),
            },
            default: 'keep',
        });
        expect(reg.resolve('keep').persistTokenCache).toBe(true);
        expect(reg.resolve('forget').persistTokenCache).toBe(false);
    });

    test('list() never exposes secret material', () => {
        const err = captureStderr(); // silences the chmod hint for the inline secret
        let reg: ConnectionRegistry;
        try {
            reg = loadRegistry(tmp, {
                connections: {
                    a: entry({ clientSecret: 'inline-secret', secretEnv: undefined }),
                    b: entry({ keychainService: 'svc', keychainAccount: 'acct', secretEnv: undefined }),
                },
            });
        } finally {
            err.restore();
        }
        const json = JSON.stringify(reg.list());
        expect(json).not.toContain('inline-secret');
        expect(json).not.toContain('clientSecret');
        expect(json).not.toContain('keychain');
        expect(json).not.toContain('secretEnv');
    });

    test('falls back to the first loaded connection when no default is declared anywhere', () => {
        const reg = loadRegistry(tmp, {
            connections: { zeta: entry(), alpha: entry({ companyId: COMPANY_B }) },
        });
        expect(reg.current().name).toBe('zeta');
    });

    test('a declared default that names no connection fails fast', () => {
        expect(() =>
            loadRegistry(tmp, { default: 'ghost', connections: { real: entry() } }),
        ).toThrow(/declares default "ghost".*Available: real/);
    });

    test('an unknown key (typo) fails the load and names the file and the path', () => {
        expect(() =>
            loadRegistry(tmp, {
                connections: { contoso: entry({ keychainSevice: 'oops' }) },
            }),
        ).toThrow(/Failed to load .*connections\.json: connections\.contoso: Unrecognized key/);
    });

    test('malformed JSON is wrapped with the file name', () => {
        process.env.WICKET_CONNECTIONS_FILE = tmp.write('connections.json', '{ not json');
        expect(() => ConnectionRegistry.load()).toThrow(/Failed to load .*connections\.json/);
    });

    test('connection names are restricted to the envelope-safe charset', () => {
        expect(() =>
            loadRegistry(tmp, { connections: { 'bad name!': entry() } }),
        ).toThrow(/Connection name "bad name!" is invalid/);
        expect(() =>
            loadRegistry(tmp, { connections: { ['x'.repeat(65)]: entry() } }),
        ).toThrow(/is invalid/);
        expect(loadRegistry(tmp, { connections: { 'ok.Name_1-2': entry() } }).resolve().name).toBe(
            'ok.Name_1-2',
        );
    });

    test('tenantId, environment and baseUrl must be URL-safe (https only)', () => {
        expect(() => loadRegistry(tmp, { connections: { a: entry({ tenantId: 'x/y' }) } })).toThrow(
            /connections\.a\.tenantId: must be a tenant GUID or domain/,
        );
        expect(() => loadRegistry(tmp, { connections: { a: entry({ environment: 'Prod/../x' }) } })).toThrow(
            /connections\.a\.environment: must match/,
        );
        expect(() => loadRegistry(tmp, { connections: { a: entry({ baseUrl: 'http://bc.local/BC' }) } })).toThrow(
            /connections\.a\.baseUrl: must be an absolute https:\/\/ URL/,
        );
        expect(() => loadRegistry(tmp, { connections: { a: entry({ baseUrl: 'bc.local' }) } })).toThrow(/https/);
        // A local dev container over plain http is fine: the token never leaves the machine.
        expect(() => loadRegistry(tmp, { connections: { a: entry({ baseUrl: 'http://localhost:7048/BC' }) } })).not.toThrow();
        const reg = loadRegistry(tmp, {
            connections: {
                a: entry({
                    tenantId: '9b1c3d2e-0000-4000-8000-123456789abc',
                    environment: 'My_Sandbox-2',
                    baseUrl: 'https://bc.contoso.com:7048/BC260',
                }),
            },
        });
        expect(reg.resolve().environment).toBe('My_Sandbox-2');
    });

    test('companyId must be a brace-less GUID', () => {
        expect(() =>
            loadRegistry(tmp, { connections: { a: entry({ companyId: `{${COMPANY_A}}` }) } }),
        ).toThrow(/brace-less GUID/);
    });

    test('a companies allowlist must contain the pinned companyId (case-insensitive)', () => {
        expect(() =>
            loadRegistry(tmp, {
                connections: { a: entry({ companies: [COMPANY_B] }) },
            }),
        ).toThrow(/not in this connection's companies allowlist/);
        const reg = loadRegistry(tmp, {
            connections: { a: entry({ companies: [COMPANY_B, COMPANY_A.toUpperCase()] }) },
        });
        expect(reg.resolve().companyId).toBe(COMPANY_A);
    });

    test('a half-configured keychain pair is an error', () => {
        expect(() =>
            loadRegistry(tmp, {
                connections: { a: entry({ keychainService: 'svc', secretEnv: undefined }) },
            }),
        ).toThrow(/needs BOTH keychainService and keychainAccount/);
        expect(() =>
            loadRegistry(tmp, {
                connections: { a: entry({ keychainAccount: 'acct', secretEnv: undefined }) },
            }),
        ).toThrow(/needs BOTH/);
    });

    test('client_credentials without any secret source is an error', () => {
        expect(() =>
            loadRegistry(tmp, { connections: { a: entry({ secretEnv: undefined }) } }),
        ).toThrow(/no secret source configured/);
    });

    test('device_code needs no secret; a configured one is ignored with a warning', () => {
        const err = captureStderr();
        try {
            const reg = loadRegistry(tmp, {
                connections: {
                    me: entry({ authMode: 'device_code', secretEnv: undefined }),
                    noisy: entry({ authMode: 'device_code', clientSecret: 'unused' }),
                },
            });
            expect(reg.resolve('me').authMode).toBe('device_code');
            expect(makeTokenSource(reg.resolve('me'))).toBeInstanceOf(UserTokenProvider);
            expect(makeTokenSource(reg.resolve('noisy'))).toBeInstanceOf(UserTokenProvider);
        } finally {
            err.restore();
        }
        expect(err.lines.filter((l) => l.includes('is ignored'))).toHaveLength(1);
        expect(err.lines.join('')).toContain('"noisy"');
    });

    test('the file wins over the env-implicit "default" on a name collision', () => {
        Object.assign(process.env, {
            BC_TENANT_ID: 'env-tenant',
            BC_ENVIRONMENT: 'production',
            BC_COMPANY_ID: COMPANY_A,
            BC_CLIENT_ID: 'env-client',
            BC_CLIENT_SECRET: 'env-secret',
        });
        const reg = loadRegistry(tmp, {
            connections: { default: entry({ tenantId: 'file-tenant' }), other: entry() },
        });
        expect(reg.resolve('default').tenantId).toBe('file-tenant');
        // The env default stays the default when the file declares none.
        expect(reg.current().name).toBe('default');
        expect(reg.list()).toHaveLength(2);
    });

    test('a file `default` overrides the env-implicit default', () => {
        Object.assign(process.env, {
            BC_TENANT_ID: 'env-tenant',
            BC_ENVIRONMENT: 'production',
            BC_COMPANY_ID: COMPANY_A,
            BC_CLIENT_ID: 'env-client',
            BC_CLIENT_SECRET: 'env-secret',
        });
        const reg = loadRegistry(tmp, {
            default: 'other',
            connections: { other: entry({ tenantId: 'tenant-other' }) },
        });
        expect(reg.current().name).toBe('other');
        expect(reg.resolve('default').tenantId).toBe('env-tenant');
    });

    test.skipIf(process.platform === 'win32')(
        'a world-readable file holding an inline clientSecret gets a chmod hint, never a failure',
        () => {
            const err = captureStderr();
            try {
                const file = tmp.write(
                    'connections.json',
                    JSON.stringify({
                        connections: { a: entry({ clientSecret: 'inline', secretEnv: undefined }) },
                    }),
                );
                chmodSync(file, 0o644);
                process.env.WICKET_CONNECTIONS_FILE = file;
                expect(ConnectionRegistry.load().resolve().name).toBe('a');
            } finally {
                err.restore();
            }
            expect(err.lines.join('')).toMatch(/chmod 600/);
        },
    );
});

// ---------------------------------------------------------------------------
// resolve / select / current
// ---------------------------------------------------------------------------

describe('ConnectionRegistry resolution ladder', () => {
    let reg: ConnectionRegistry;
    beforeEach(() => {
        reg = loadRegistry(tmp, {
            default: 'prod',
            connections: {
                prod: entry({ tenantId: 'tenant-prod' }),
                sandbox: entry({ tenantId: 'tenant-sb' }),
            },
        });
    });

    test('per-call override beats the session selection, which beats the default', () => {
        expect(reg.resolve().tenantId).toBe('tenant-prod');
        reg.select('sandbox');
        expect(reg.resolve().tenantId).toBe('tenant-sb');
        expect(reg.resolve('prod').tenantId).toBe('tenant-prod');
        expect(reg.current()).toEqual({ name: 'sandbox', isSessionSelection: true });
        expect(reg.list().find((c) => c.name === 'sandbox')).toMatchObject({
            isDefault: false,
            isSelected: true,
        });
    });

    test('unknown names are rejected with the available list', () => {
        expect(() => reg.resolve('nope')).toThrow(/Unknown connection "nope".*prod, sandbox/);
        expect(() => reg.select('nope')).toThrow(/Unknown connection "nope"/);
        // A failed select must not disturb the current selection.
        expect(reg.current().name).toBe('prod');
    });
});

// ---------------------------------------------------------------------------
// resolveSecret
// ---------------------------------------------------------------------------

describe('resolveSecret', () => {
    test('reads the named env var', async () => {
        expect(await resolveSecret(spec({ secretEnv: 'WICKET_TEST_SECRET' }))).toBe('s3cret');
    });

    test('an unset env var is an error naming the variable', async () => {
        await expect(resolveSecret(spec({ secretEnv: 'WICKET_TEST_MISSING' }))).rejects.toThrow(
            /env var WICKET_TEST_MISSING is not set/,
        );
    });

    test('an inline clientSecret is returned with a stderr warning, once per connection', async () => {
        const err = captureStderr();
        const inline = spec({ secretEnv: undefined, clientSecret: 'inline' });
        try {
            expect(await resolveSecret(inline)).toBe('inline');
            expect(await resolveSecret(inline)).toBe('inline');
            await resolveSecret(spec({ name: 'other', secretEnv: undefined, clientSecret: 'inline' }));
        } finally {
            err.restore();
        }
        const warnings = err.lines.filter((l) => /INLINE clientSecret/.test(l));
        expect(warnings).toHaveLength(2);
        expect(warnings[1]).toContain('"other"');
    });

    test('no source at all is an error', async () => {
        await expect(resolveSecret(spec({ secretEnv: undefined }))).rejects.toThrow(
            /no secret configured/,
        );
    });
});

// ---------------------------------------------------------------------------
// AppTokenProvider
// ---------------------------------------------------------------------------

describe('AppTokenProvider', () => {
    let stub: FetchStub;
    beforeEach(() => {
        stub = new FetchStub().install();
    });
    afterEach(() => stub.uninstall());

    test('posts a client_credentials grant for the connection tenant and caches the token', async () => {
        stub.token('tok-1');
        const provider = new AppTokenProvider(spec({ tenantId: 'tenant-x', clientId: 'client-x' }));

        expect(await provider.getToken()).toBe('tok-1');
        expect(await provider.getToken()).toBe('tok-1');

        expect(stub.tokenRequests).toHaveLength(1);
        const req = stub.tokenRequests[0]!;
        expect(req.url).toBe('https://login.microsoftonline.com/tenant-x/oauth2/v2.0/token');
        expect(req.method).toBe('POST');
        expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(req.form.get('grant_type')).toBe('client_credentials');
        expect(req.form.get('client_id')).toBe('client-x');
        expect(req.form.get('client_secret')).toBe('s3cret');
        expect(req.form.get('scope')).toBe('https://api.businesscentral.dynamics.com/.default');
        expect(req.signal).toBeInstanceOf(AbortSignal);
    });

    test('coalesces concurrent first fetches into one request', async () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((r) => (release = r));
        stub.route(/login\.microsoftonline\.com/, async () => {
            await gate;
            return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
                status: 200,
            });
        });
        const provider = new AppTokenProvider(spec());
        const a = provider.getToken();
        const b = provider.getToken();
        release!();
        expect(await Promise.all([a, b])).toEqual(['tok', 'tok']);
        expect(stub.tokenRequests).toHaveLength(1);
    });

    test('refetches when the cached token is inside the 60s refresh margin', async () => {
        stub.route(TOKEN_URL_LOOSE, (_req, nth) =>
            new Response(JSON.stringify({ access_token: `tok-${nth}`, expires_in: 30 }), {
                status: 200,
            }),
        );
        const provider = new AppTokenProvider(spec());
        expect(await provider.getToken()).toBe('tok-0');
        expect(await provider.getToken()).toBe('tok-1');
        expect(stub.tokenRequests).toHaveLength(2);
    });

    test('a missing expires_in defaults to an hour (so the token IS cached)', async () => {
        stub.token('tok', undefined);
        const provider = new AppTokenProvider(spec());
        await provider.getToken();
        await provider.getToken();
        expect(stub.tokenRequests).toHaveLength(1);
    });

    test('a non-2xx token response surfaces the status and body head', async () => {
        stub.route(TOKEN_URL_LOOSE, () =>
            new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215' }), {
                status: 401,
            }),
        );
        await expect(new AppTokenProvider(spec({ name: 'prod' })).getToken()).rejects.toThrow(
            /Connection "prod": token request failed \(HTTP 401\): .*AADSTS7000215/,
        );
    });

    test('a 200 without access_token is an error', async () => {
        stub.route(TOKEN_URL_LOOSE, () => new Response('{}', { status: 200 }));
        await expect(new AppTokenProvider(spec()).getToken()).rejects.toThrow(/no access_token/);
    });

    test('a timed-out token POST is reported as a timeout, not a raw DOMException', async () => {
        stub.route(TOKEN_URL_LOOSE, () => timeoutRejection());
        await expect(new AppTokenProvider(spec({ name: 'slow' })).getToken()).rejects.toThrow(
            /Connection "slow": token request timed out.*30s/,
        );
    });

    test('a failed fetch is not cached: the next call retries', async () => {
        stub.route(TOKEN_URL_LOOSE, (_req, nth) =>
            nth === 0
                ? new Response('boom', { status: 500 })
                : new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }),
        );
        const provider = new AppTokenProvider(spec());
        await expect(provider.getToken()).rejects.toThrow(/HTTP 500/);
        expect(await provider.getToken()).toBe('tok');
    });

    test('invalidate drops the cached token so the next call mints a fresh one', async () => {
        stub.route(TOKEN_URL_LOOSE, (_req, nth) =>
            new Response(JSON.stringify({ access_token: `tok-${nth}`, expires_in: 3600 }), { status: 200 }),
        );
        const provider = new AppTokenProvider(spec());
        expect(await provider.getToken()).toBe('tok-0');
        expect(await provider.getToken()).toBe('tok-0');
        provider.invalidate();
        expect(await provider.getToken()).toBe('tok-1');
    });

    test('the secret is resolved lazily, at fetch time', async () => {
        stub.token('tok');
        const provider = new AppTokenProvider(spec({ secretEnv: 'WICKET_LATE_SECRET' }));
        await expect(provider.getToken()).rejects.toThrow(/WICKET_LATE_SECRET is not set/);
        process.env.WICKET_LATE_SECRET = 'late';
        expect(await provider.getToken()).toBe('tok');
        expect(stub.tokenRequests[0]!.form.get('client_secret')).toBe('late');
    });
});


// ---------------------------------------------------------------------------
// UserTokenProvider (device_code) — with a stubbed credential
// ---------------------------------------------------------------------------

describe('UserTokenProvider', () => {
    const PROMPT: DeviceCodePrompt = { verificationUri: 'https://microsoft.com/devicelogin', userCode: 'ABCD-EFGH' };

    /**
     * A scripted DeviceCodeCredential: each getToken either resolves at once (a cached token),
     * or prompts and then waits until `signIn()` (the human) completes it.
     */
    function fakeCredential(mode: 'cached' | 'prompt' | 'silent') {
        let complete: ((t: string) => void) | undefined;
        let fail: ((e: Error) => void) | undefined;
        const state = { created: 0, calls: 0 };
        const createCredential = async (onPrompt: (info: DeviceCodePrompt) => void) => {
            state.created++;
            return {
                getToken: (_scope: string) => {
                    state.calls++;
                    if (mode === 'cached') return Promise.resolve({ token: `user-tok-${state.calls}` });
                    return new Promise<{ token: string } | null>((resolve, reject) => {
                        complete = (t) => resolve({ token: t });
                        fail = reject;
                        if (mode === 'prompt') queueMicrotask(() => onPrompt(PROMPT));
                    });
                },
            };
        };
        return {
            createCredential,
            state,
            signIn: (t: string) => complete!(t),
            /** Wait until the credential's getToken has been entered `n` times. */
            reached: async (n: number) => {
                while (state.calls < n) await Bun.sleep(1);
            },
            expire: () => fail!(new Error('device code expired')),
        };
    }

    test('returns a cached token without prompting', async () => {
        const cred = fakeCredential('cached');
        const provider = new UserTokenProvider(spec({ authMode: 'device_code' }), cred);
        expect(await provider.getToken()).toBe('user-tok-1');
        expect(await provider.getToken()).toBe('user-tok-2');
        expect(cred.state.created).toBe(1);
    });

    test('a pending sign-in fails fast with the URL + code, keeps running, and the retry gets the token', async () => {
        const cred = fakeCredential('prompt');
        const provider = new UserTokenProvider(spec({ name: 'me', authMode: 'device_code' }), {
            createCredential: cred.createCredential,
            waitMs: 5_000,
        });
        const err = captureStderr();
        let first: unknown;
        const started = Date.now();
        try {
            await provider.getToken();
        } catch (e) {
            first = e;
        } finally {
            err.restore();
        }
        // It returned on the prompt, not after the wait window.
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(first).toBeInstanceOf(DeviceCodeSignInRequiredError);
        expect(first).toMatchObject({ connection: 'me', verificationUri: PROMPT.verificationUri, userCode: 'ABCD-EFGH' });
        expect(err.lines.join('')).toContain('[wicket:me] Sign in: https://microsoft.com/devicelogin code: ABCD-EFGH');

        // The human signs in while the next call is waiting: it receives the in-flight token.
        const second = provider.getToken();
        cred.signIn('user-tok');
        expect(await second).toBe('user-tok');
        expect(cred.state.calls).toBe(1);
    });

    test('a retry before sign-in completes repeats the same code after the wait window', async () => {
        const cred = fakeCredential('prompt');
        const provider = new UserTokenProvider(spec({ authMode: 'device_code' }), {
            createCredential: cred.createCredential,
            waitMs: 30,
        });
        const err = captureStderr();
        try {
            await expect(provider.getToken()).rejects.toBeInstanceOf(DeviceCodeSignInRequiredError);
            await expect(provider.getToken()).rejects.toMatchObject({ userCode: 'ABCD-EFGH' });
        } finally {
            err.restore();
        }
        // Still one flow: the sign-in was not restarted.
        expect(cred.state.calls).toBe(1);
        expect(err.lines.filter((l) => l.includes('Sign in:'))).toHaveLength(1);
    });

    test('no token and no prompt within the window is a timeout error, not a hang', async () => {
        const cred = fakeCredential('silent');
        const provider = new UserTokenProvider(spec({ name: 'quiet', authMode: 'device_code' }), {
            createCredential: cred.createCredential,
            waitMs: 20,
        });
        await expect(provider.getToken()).rejects.toThrow(/Connection "quiet": device-code sign-in did not start within/);
        // The flow kept running; when it resolves the next call gets the token.
        cred.signIn('late-tok');
        expect(await provider.getToken()).toBe('late-tok');
    });

    test('an expired code surfaces its error and the next call starts a fresh flow', async () => {
        const cred = fakeCredential('silent');
        const provider = new UserTokenProvider(spec({ authMode: 'device_code' }), {
            createCredential: cred.createCredential,
            waitMs: 5_000,
        });
        const pending = provider.getToken();
        await cred.reached(1);
        cred.expire();
        await expect(pending).rejects.toThrow(/device code expired/);
        const again = provider.getToken();
        await cred.reached(2);
        cred.signIn('fresh');
        expect(await again).toBe('fresh');
        expect(cred.state.calls).toBe(2);
        expect(cred.state.created).toBe(1);
    });

    test('a sign-in that fails while nobody waits is reported by the next call, not replaced by a new code', async () => {
        const cred = fakeCredential('prompt');
        const provider = new UserTokenProvider(spec({ name: 'me', authMode: 'device_code' }), {
            createCredential: cred.createCredential,
            waitMs: 5_000,
        });
        const err = captureStderr();
        try {
            await expect(provider.getToken()).rejects.toBeInstanceOf(DeviceCodeSignInRequiredError);
            // The human signs in, but the token request is refused (e.g. AADSTS consent).
            cred.expire();
            await Bun.sleep(1);
            await expect(provider.getToken()).rejects.toThrow(
                /Connection "me": device-code sign-in failed: device code expired/,
            );
            expect(cred.state.calls).toBe(1);
            // Reported once: the call after that starts a fresh flow.
            await expect(provider.getToken()).rejects.toBeInstanceOf(DeviceCodeSignInRequiredError);
            expect(cred.state.calls).toBe(2);
        } finally {
            err.restore();
        }
        expect(err.lines.join('')).toContain('[wicket:me] Sign-in failed: device code expired');
    });
});

// ---------------------------------------------------------------------------
// makeTokenSource / isTimeoutError
// ---------------------------------------------------------------------------

describe('makeTokenSource', () => {
    test('picks the provider by authMode', () => {
        expect(makeTokenSource(spec())).toBeInstanceOf(AppTokenProvider);
        expect(makeTokenSource(spec({ authMode: 'device_code' }))).toBeInstanceOf(UserTokenProvider);
    });
});

describe('isTimeoutError', () => {
    test('recognises TimeoutError and AbortError DOMExceptions only', () => {
        expect(isTimeoutError(new DOMException('x', 'TimeoutError'))).toBe(true);
        expect(isTimeoutError(new DOMException('x', 'AbortError'))).toBe(true);
        expect(isTimeoutError(new Error('TimeoutError'))).toBe(false);
        expect(isTimeoutError('TimeoutError')).toBe(false);
        expect(isTimeoutError(undefined)).toBe(false);
    });
});

describe('connection unmask option', () => {
    test('unmask is persisted from connections.json, defaults to undefined, and is listed only when set', () => {
        const reg = loadRegistry(tmp, {
            default: 'a',
            connections: {
                a: entry({ tenantId: 't', clientId: 'c' }),
                b: entry({ tenantId: 't', clientId: 'c', unmask: false }),
            },
        });
        expect(reg.resolve('a').unmask).toBeUndefined();
        expect(reg.resolve('b').unmask).toBe(false);
        const [a, b] = reg.list();
        expect('unmask' in a!).toBe(false);
        expect(b).toMatchObject({ name: 'b', unmask: false });
    });
});

// ---------------------------------------------------------------------------
// config locations
// ---------------------------------------------------------------------------

describe('config locations', () => {
    /** Write a connections.json under <config home>/wicket/ and return its path. */
    function writeConfig(name: string): string {
        const folder = join(configHome.dir, 'wicket');
        mkdirSync(folder, { recursive: true });
        const file = join(folder, 'connections.json');
        writeFileSync(file, JSON.stringify({ connections: { [name]: entry() } }), 'utf8');
        return file;
    }

    test('envSetting reads WICKET_* trimmed and is undefined when unset or blank', () => {
        expect(envSetting('PROBE')).toBeUndefined();
        process.env.WICKET_PROBE = '  ';
        expect(envSetting('PROBE')).toBeUndefined();
        process.env.WICKET_PROBE = ' new ';
        expect(envSetting('PROBE')).toBe('new');
    });

    test('WICKET_CONNECTIONS_FILE wins over ~/.config/wicket/connections.json', () => {
        writeConfig('home');
        process.env.WICKET_CONNECTIONS_FILE = tmp.write('connections.json', JSON.stringify({ connections: { explicit: entry() } }));
        expect(ConnectionRegistry.load().list().map((c) => c.name)).toEqual(['explicit']);
    });

    test('~/.config/wicket/connections.json loads when no variable is set', () => {
        delete process.env.WICKET_CONNECTIONS_FILE;
        writeConfig('home');
        expect(ConnectionRegistry.load().list().map((c) => c.name)).toEqual(['home']);
    });

    test('with no file anywhere the error points at ~/.config/wicket', () => {
        delete process.env.WICKET_CONNECTIONS_FILE;
        expect(() => ConnectionRegistry.load()).toThrow(/~\/\.config\/wicket\/connections\.json/);
    });

    test('device-code records are saved under wicket/auth, or under WICKET_AUTH_DIR when set', () => {
        expect(authRecordPath('contoso')).toBe(join(configHome.dir, 'wicket', 'auth', 'contoso.json'));
        process.env.WICKET_AUTH_DIR = '/tmp/new-auth';
        expect(authRecordPath('contoso')).toBe(join('/tmp/new-auth', 'contoso.json'));
    });

    test('the API catalog cache honours WICKET_CACHE_DIR, else ~/.config/wicket/cache', () => {
        const sandboxCache = process.env.WICKET_CACHE_DIR!;
        expect(cacheDir()).toBe(sandboxCache);
        delete process.env.WICKET_CACHE_DIR;
        expect(cacheDir()).toBe(join(configHome.dir, 'wicket', 'cache'));
        process.env.WICKET_CACHE_DIR = sandboxCache;
    });

    test('a keychain miss is reported for the configured service after exactly one lookup', async () => {
        const find = spyOn(keychain, 'find').mockImplementation(async () => {
            throw new Error('not found');
        });
        try {
            await expect(
                resolveSecret(spec({ secretEnv: undefined, keychainService: 'wicket', keychainAccount: 'contoso' })),
            ).rejects.toThrow(/service=wicket, account=contoso.*security add-generic-password -s wicket -a contoso/);
            expect(find.mock.calls).toEqual([['wicket', 'contoso']]);
        } finally {
            find.mockRestore();
        }
    });
});
