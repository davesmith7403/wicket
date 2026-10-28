/**
 * The setup service: finding the tenant from what a person has at hand, the one setup sign-in
 * session, listing environments and companies, silent health checks, and plain-language errors.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DelegatedCredential, DelegatedTarget, SignInPrompt } from '../src/connections.ts';
import { SignInNeededError, keychain } from '../src/connections.ts';
import {
    SetupSession,
    checkHealth,
    explainAuthError,
    explainListError,
    listCompanies,
    listEnvironments,
    locate,
    matchCompany,
    parseBcAddress,
} from '../src/setup.ts';
import { COMPANY_A, FetchStub, TempDir, jsonResponse, sandboxEnv, spec } from './helpers.ts';

const TID = '9b1c3d2e-0000-4000-8000-123456789abc';

/** An unsigned JWT carrying `claims` — setup only reads the payload. */
function jwt(claims: Record<string, unknown>): string {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

let restoreEnv: () => void;
let tmp: TempDir;
let stub: FetchStub;

beforeEach(() => {
    restoreEnv = sandboxEnv();
    tmp = new TempDir();
    stub = new FetchStub().install();
});

afterEach(() => {
    stub.uninstall();
    tmp.cleanup();
    restoreEnv();
});

describe('parseBcAddress / locate', () => {
    test('reads tenant GUID, domain tenant, missing tenant, environment, and a percent-encoded non-ASCII company', () => {
        expect(parseBcAddress(`https://businesscentral.dynamics.com/${TID}/Production?company=CRONUS%20%C3%96sterreich&page=22`)).toEqual({
            tenant: TID,
            environment: 'Production',
            companyName: 'CRONUS Österreich',
        });
        expect(parseBcAddress('https://businesscentral.dynamics.com/contoso.onmicrosoft.com/Sandbox/')).toEqual({
            tenant: 'contoso.onmicrosoft.com',
            environment: 'Sandbox',
        });
        expect(parseBcAddress('https://businesscentral.dynamics.com/Sandbox?company=CRONUS')).toEqual({
            environment: 'Sandbox',
            companyName: 'CRONUS',
        });
        expect(parseBcAddress('https://businesscentral.dynamics.com/')).toEqual({});
        expect(parseBcAddress('https://example.com/x/y')).toBeUndefined();
        expect(parseBcAddress('not a url')).toBeUndefined();
    });

    test('locate resolves an email domain to the issuer GUID and reports what it could not tell', async () => {
        stub.route(/login\.microsoftonline\.com\/contoso\.com\/v2\.0\/\.well-known\/openid-configuration/, () =>
            jsonResponse({ issuer: `https://login.microsoftonline.com/${TID}/v2.0` }),
        );
        expect(await locate('  someone@contoso.com ')).toEqual({ tenantId: TID, unresolved: ['environment', 'company'] });
        expect(await locate(`https://businesscentral.dynamics.com/${TID}/Production?company=CRONUS`)).toEqual({
            tenantId: TID,
            environment: 'Production',
            companyName: 'CRONUS',
            unresolved: [],
        });
    });

    test('locate of an unknown domain says so instead of throwing', async () => {
        stub.route(/openid-configuration/, () => jsonResponse({ error: 'invalid_tenant' }, 400));
        const found = await locate('nobody.example');
        expect(found.tenantId).toBeUndefined();
        expect(found.unresolved).toContain('tenant');
    });
});

describe('SetupSession', () => {
    /** A scripted delegated credential: prompts, then waits for `signIn` (the human). */
    function scripted() {
        let complete: ((token: string) => void) | undefined;
        let fail: ((e: Error) => void) | undefined;
        const created: DelegatedTarget[] = [];
        const createCredential = async (target: DelegatedTarget, onPrompt: (p: SignInPrompt) => void): Promise<DelegatedCredential> => {
            created.push(target);
            return {
                getToken: () =>
                    new Promise((resolve, reject) => {
                        complete = (token) => resolve({ token });
                        fail = reject;
                        queueMicrotask(() =>
                            onPrompt(
                                target.authMode === 'browser'
                                    ? { kind: 'browser' }
                                    : { kind: 'device_code', verificationUri: 'https://microsoft.com/devicelogin', userCode: 'CODE-1' },
                            ),
                        );
                    }),
                authenticationRecord: () => '{"username":"me@contoso.com"}',
            };
        };
        return { createCredential, created, signIn: (t: string) => complete!(t), fail: (e: Error) => fail!(e) };
    }

    test('signin returns pending with the device code, then signedIn with upn and tid', async () => {
        const cred = scripted();
        const session = new SetupSession({ createCredential: cred.createCredential, waitMs: 20 });
        const first = await session.signin({ method: 'device_code' });
        expect(first).toEqual({
            state: 'pending',
            prompt: { kind: 'device_code', verificationUri: 'https://microsoft.com/devicelogin', userCode: 'CODE-1' },
        });
        expect(cred.created[0]).toMatchObject({ tenantId: 'organizations', clientId: '1950a258-227b-4e31-a9cf-717495945fc2' });
        cred.signIn(jwt({ upn: 'me@contoso.com', tid: TID }));
        expect(await session.signin({ method: 'device_code' })).toEqual({ state: 'signedIn', upn: 'me@contoso.com', tenantId: TID });
        expect(session.token()).toContain('.');
        expect(session.target).toMatchObject({ method: 'device_code', tenantId: TID });
        expect(session.authenticationRecord()).toContain('me@contoso.com');
        expect(cred.created).toHaveLength(1);
    });

    test('a second signin with other args replaces the pending one', async () => {
        const cred = scripted();
        const session = new SetupSession({ createCredential: cred.createCredential, waitMs: 20 });
        await session.signin({ method: 'device_code' });
        const browser = await session.signin({ method: 'browser', tenantId: TID });
        expect(browser).toEqual({ state: 'pending', prompt: { kind: 'browser' } });
        expect(cred.created.map((t) => t.authMode)).toEqual(['device_code', 'browser']);
        expect(() => session.token()).toThrow(/not signed in/);
    });

    test('signin with restart drops a finished session and signs in afresh (the wrong account)', async () => {
        const cred = scripted();
        const session = new SetupSession({ createCredential: cred.createCredential, waitMs: 20 });
        await session.signin({ method: 'browser' });
        cred.signIn(jwt({ upn: 'other@contoso.com', tid: TID }));
        expect(await session.signin({ method: 'browser' })).toMatchObject({ state: 'signedIn', upn: 'other@contoso.com' });
        expect(await session.signin({ method: 'browser', restart: true })).toEqual({ state: 'pending', prompt: { kind: 'browser' } });
        expect(cred.created).toHaveLength(2);
        cred.signIn(jwt({ upn: 'me@contoso.com', tid: TID }));
        expect(await session.signin({ method: 'browser' })).toMatchObject({ state: 'signedIn', upn: 'me@contoso.com' });
    });

    test('signin with restart replaces a pending one (the closed tab)', async () => {
        const cred = scripted();
        const session = new SetupSession({ createCredential: cred.createCredential, waitMs: 20 });
        await session.signin({ method: 'browser' });
        expect((await session.signin({ method: 'browser', restart: true })).state).toBe('pending');
        expect(cred.created).toHaveLength(2);
    });

    test('a pending session older than 10 minutes fails with "start again"', async () => {
        const cred = scripted();
        let now = 1_000_000;
        const session = new SetupSession({ createCredential: cred.createCredential, waitMs: 20, now: () => now });
        await session.signin({ method: 'browser' });
        now += 10 * 60_000 + 1;
        expect(await session.signin({ method: 'browser' })).toEqual({ state: 'failed', message: expect.stringMatching(/sign-in timed out, start again/) });
        // The next call starts afresh.
        expect((await session.signin({ method: 'browser' })).state).toBe('pending');
        expect(cred.created).toHaveLength(2);
    });

    test('a sign-in refused by Entra is a failed state in plain words', async () => {
        const cred = scripted();
        const session = new SetupSession({ createCredential: cred.createCredential, waitMs: 20 });
        await session.signin({ method: 'browser', tenantId: TID });
        cred.fail(new Error('AADSTS50020: User account from identity provider does not exist in tenant'));
        const state = await session.signin({ method: 'browser', tenantId: TID });
        expect(state).toEqual({ state: 'failed', message: expect.stringMatching(/isn't a member or guest of that tenant/) });
    });

    test('client_credentials signin reads the keychain item and returns appId and tid; the secret appears in no result', async () => {
        const original = keychain.find;
        keychain.find = async (service, account) => {
            expect([service, account]).toEqual(['wicket', 'contoso']);
            return 'SENTINEL-SECRET';
        };
        stub.route(new RegExp(`login\\.microsoftonline\\.com/${TID}/oauth2/v2\\.0/token`), () =>
            jsonResponse({ access_token: jwt({ appid: 'app-1', tid: TID }), expires_in: 3600 }),
        );
        try {
            const session = new SetupSession();
            const state = await session.signin({
                method: 'client_credentials',
                tenantId: TID,
                clientId: 'app-1',
                keychainService: 'wicket',
                keychainAccount: 'contoso',
            });
            expect(state).toEqual({ state: 'signedIn', appId: 'app-1', tenantId: TID });
            expect(JSON.stringify(state)).not.toContain('SENTINEL');
            expect(JSON.stringify(session.target)).not.toContain('SENTINEL');
        } finally {
            keychain.find = original;
        }
    });

    test('client_credentials without a tenant or client is refused before any request', async () => {
        const state = await new SetupSession().signin({ method: 'client_credentials', keychainService: 'wicket', keychainAccount: 'x' });
        expect(state).toEqual({ state: 'failed', message: expect.stringMatching(/tenantId and clientId/) });
        expect(stub.requests).toHaveLength(0);
    });
});

describe('listing', () => {
    test('listEnvironments uses v1.1 and maps name/type/countryCode', async () => {
        stub.route(/api\.businesscentral\.dynamics\.com\/environments\/v1\.1$/, () =>
            jsonResponse({ value: [{ name: 'Production', type: 'production', countryCode: 'US', aadTenantId: TID }] }),
        );
        expect(await listEnvironments('tok')).toEqual([{ name: 'Production', type: 'production', countryCode: 'US' }]);
        expect(stub.requests[0]!.headers.authorization).toBe('Bearer tok');
    });

    test('listCompanies calls the per-environment companies URL', async () => {
        stub.route(new RegExp(`/v2\\.0/${TID}/Sandbox/api/v2\\.0/companies$`), () =>
            jsonResponse({ value: [{ id: COMPANY_A, name: 'CRONUS', displayName: 'Cronus Ltd.', systemVersion: '28' }] }),
        );
        expect(await listCompanies('tok', TID, 'Sandbox')).toEqual([{ id: COMPANY_A, name: 'CRONUS', displayName: 'Cronus Ltd.' }]);
    });

    test('a refused list carries its HTTP status for explainAuthError', async () => {
        stub.route(/environments\/v1\.1/, () => jsonResponse({ error: { code: 'Unauthorized' } }, 401));
        await expect(listEnvironments('tok')).rejects.toMatchObject({ status: 401 });
    });

    test('matchCompany is case-insensitive and falls back to displayName', () => {
        const companies = [
            { id: '1', name: 'CRONUS Österreich', displayName: '' },
            { id: '2', name: 'MY COMPANY', displayName: 'My Company Ltd.' },
        ];
        expect(matchCompany(companies, 'cronus österreich')?.id).toBe('1');
        expect(matchCompany(companies, 'my company ltd.')?.id).toBe('2');
        expect(matchCompany(companies, 'other')).toBeUndefined();
    });
});

describe('checkHealth', () => {
    const silentNeeded = async (): Promise<DelegatedCredential> => ({
        getToken: async () => {
            throw new SignInNeededError('me');
        },
        authenticationRecord: () => undefined,
    });

    test('reports signInNeeded without prompting', async () => {
        const seen: Array<{ silentOnly?: boolean }> = [];
        let whoamiCalls = 0;
        const health = await checkHealth(
            spec({ name: 'me', authMode: 'browser' }),
            async () => {
                whoamiCalls++;
                return {};
            },
            {
                createCredential: async (_target, _onPrompt, opts) => {
                    seen.push(opts ?? {});
                    return silentNeeded();
                },
            },
        );
        expect(health.state).toBe('signInNeeded');
        expect(seen).toEqual([{ silentOnly: true }]);
        expect(whoamiCalls).toBe(0);
    });

    test('reports ok with the identity whoami returns', async () => {
        const health = await checkHealth(spec({ name: 'me', authMode: 'browser' }), async () => ({ userName: 'ME' }), {
            createCredential: async () => ({ getToken: async () => ({ token: 't' }), authenticationRecord: () => undefined }),
        });
        expect(health).toMatchObject({ state: 'ok', identity: { userName: 'ME' } });
    });

    test('reports secretMissing, wicketNotFound (404), bcRefused (403)', async () => {
        const original = keychain.find;
        keychain.find = async () => {
            throw new Error('not found');
        };
        try {
            const missing = await checkHealth(spec({ keychainService: 'wicket', keychainAccount: 'x', secretEnv: undefined }), async () => ({}));
            expect(missing.state).toBe('secretMissing');
        } finally {
            keychain.find = original;
        }
        const problem = (status: number) => async () => {
            throw Object.assign(new Error('problem'), { problem: { type: 'x', title: 't', status } });
        };
        process.env.WICKET_TEST_SECRET = 's';
        expect((await checkHealth(spec(), problem(404))).state).toBe('wicketNotFound');
        expect((await checkHealth(spec(), problem(403))).state).toBe('bcRefused');
        expect((await checkHealth(spec(), problem(401))).state).toBe('bcRefused');
        expect((await checkHealth(spec(), async () => {
            throw new TypeError('fetch failed');
        })).state).toBe('unreachable');
        expect((await checkHealth(spec(), async () => {
            throw new Error('Connection "unit": token request failed (HTTP 401): AADSTS7000215: Invalid client secret');
        })).state).toBe('tokenRefused');
    });
});

describe('explainListError', () => {
    test('a refused environment list asks for the BC address instead of blaming Wicket permissions', () => {
        for (const status of [401, 403, 404]) {
            const text = explainListError(Object.assign(new Error('x'), { status }), 'environments');
            expect(text).toMatch(/couldn't list the environments/);
            expect(text).toMatch(/paste the Business Central address/);
            expect(text).not.toMatch(/Wicket/);
        }
    });

    test('a refused company list names the environment and does not claim Wicket is missing', () => {
        const text = explainListError(Object.assign(new Error('x'), { status: 404 }), 'companies', 'Sandbox');
        expect(text).toMatch(/company list for Sandbox/);
        expect(text).not.toMatch(/isn't installed/);
        expect(explainListError(new Error('AADSTS50020: nope'), 'companies', 'Sandbox')).toMatch(/isn't a member or guest/);
    });
});

describe('explainAuthError', () => {
    test('maps each listed code to one sentence and a next step', () => {
        const cases: Array<[unknown, RegExp]> = [
            [new Error('AADSTS50020: User account does not exist in tenant'), /isn't a member or guest of that tenant/],
            [new Error('AADSTS65001: The user or administrator has not consented'), /admin consent/],
            [new Error('consent_required'), /admin consent/],
            [new Error('AADSTS700016: Application not found in the directory'), /client ID isn't known in this tenant/],
            [new Error('token request failed (HTTP 401): AADSTS7000215: Invalid client secret'), /client secret is wrong or expired/],
            [{ problem: { status: 401 } }, /doesn't know this user/],
            [Object.assign(new Error('x'), { status: 403 }), /Wicket - Read/],
            [{ problem: { status: 404 } }, /isn't installed in that environment/],
        ];
        for (const [err, pattern] of cases) expect(explainAuthError(err)).toMatch(pattern);
    });

    test('anything else keeps its own message, cut to 300 characters', () => {
        expect(explainAuthError(new Error('boom'))).toBe('boom');
        expect(explainAuthError(new Error('x'.repeat(400)))).toHaveLength(300);
    });
});
