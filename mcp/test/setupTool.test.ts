/**
 * wicket_setup end to end through MCP: a server that starts with nothing configured, the add path
 * from a pasted address to a working connection in the same server, and the guards on save/remove.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ConnectionRegistry,
    SignInNeededError,
    authRecordPath,
    keychain,
    type DelegatedCredential,
    type DelegatedTarget,
} from '../src/connections.ts';
import { SetupSession } from '../src/setup.ts';
import {
    COMPANY_A,
    COMPANY_B,
    FetchStub,
    TempDir,
    entry,
    jsonResponse,
    odata,
    sandboxEnv,
    startServer,
    toolIsError,
    toolJsonAs,
    toolText,
    type ServerHarness,
} from './helpers.ts';

const TID = '9b1c3d2e-0000-4000-8000-123456789abc';

function jwt(claims: Record<string, unknown>): string {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

let restoreEnv: () => void;
let tmp: TempDir;
let stub: FetchStub;
let harness: ServerHarness | undefined;
let file: string;
const realKeychainFind = keychain.find;

beforeEach(() => {
    restoreEnv = sandboxEnv();
    tmp = new TempDir();
    stub = new FetchStub().install();
    file = join(tmp.path, 'wicket', 'connections.json');
    process.env.WICKET_CONNECTIONS_FILE = file;
    keychain.find = async () => 'SENTINEL-SECRET';
});

afterEach(async () => {
    await harness?.close();
    harness = undefined;
    keychain.find = realKeychainFind;
    stub.uninstall();
    tmp.cleanup();
    restoreEnv();
});

/** A delegated credential that signs in at once as me@contoso.com, or (silent) reports a sign-in is needed. */
function instantCredential(log: Array<{ target: DelegatedTarget; silentOnly?: boolean }>) {
    return async (target: DelegatedTarget, _onPrompt: unknown, opts: { silentOnly?: boolean } = {}): Promise<DelegatedCredential> => {
        log.push({ target, ...(opts.silentOnly ? { silentOnly: true } : {}) });
        return {
            getToken: async () => {
                if (opts.silentOnly) throw new SignInNeededError(target.name);
                return { token: jwt({ upn: 'me@contoso.com', tid: TID }) };
            },
            authenticationRecord: () => JSON.stringify({ tenantId: TID, clientId: target.clientId, username: 'me@contoso.com' }),
        };
    };
}

async function start(options: Parameters<typeof startServer>[1] = {}) {
    const registry = ConnectionRegistry.load();
    harness = await startServer(registry, options);
    return registry;
}

const setup = (args: Record<string, unknown>) => harness!.client.callTool({ name: 'wicket_setup', arguments: args });

function routeAppToken() {
    stub.route(new RegExp(`login\\.microsoftonline\\.com/${TID}/oauth2/v2\\.0/token`), () =>
        jsonResponse({ access_token: jwt({ appid: 'app-1', tid: TID }), expires_in: 3600 }),
    );
}

describe('wicket_setup', () => {
    test('status with no file reports missing and no connections', async () => {
        await start();
        const status = toolJsonAs<Record<string, unknown>>(await setup({ action: 'status' }));
        expect(status).toMatchObject({ file, problem: { kind: 'missing' }, connections: [], rejected: [] });
    });

    test('the full add path ends in a working connection in the same server, without restart', async () => {
        routeAppToken();
        stub.route(/environments\/v1\.1$/, () => jsonResponse({ value: [{ name: 'Production', type: 'production', countryCode: 'US' }] }));
        stub.route(new RegExp(`/v2\\.0/${TID}/Production/api/v2\\.0/companies$`), () =>
            jsonResponse({ value: [{ id: COMPANY_A, name: 'CRONUS', displayName: '' }] }),
        );
        stub.rpc(() => odata({ userId: 'APP' }));
        const registry = await start();

        const located = toolJsonAs<Record<string, unknown>>(
            await setup({ action: 'locate', hint: `https://businesscentral.dynamics.com/${TID}/Production?company=CRONUS` }),
        );
        expect(located).toMatchObject({ tenantId: TID, environment: 'Production', companyName: 'CRONUS' });
        const signedIn = toolJsonAs<Record<string, unknown>>(
            await setup({ action: 'signin', method: 'client_credentials', tenantId: TID, clientId: 'app-1', keychainService: 'wicket', keychainAccount: 'contoso' }),
        );
        expect(signedIn).toMatchObject({ state: 'signedIn', appId: 'app-1', tenantId: TID });
        expect(toolJsonAs<{ value: unknown[] }>(await setup({ action: 'environments' })).value).toHaveLength(1);
        const companies = toolJsonAs<{ value: Array<{ id: string }> }>(await setup({ action: 'companies', environment: 'Production' }));
        expect(companies.value[0]!.id).toBe(COMPANY_A);

        const saved = toolJsonAs<Record<string, unknown>>(
            await setup({ action: 'save', name: 'contoso', environment: 'Production', companyId: COMPANY_A, makeDefault: true }),
        );
        expect(saved).toMatchObject({ saved: 'contoso', health: { state: 'ok', identity: { userId: 'APP' } } });
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
            default: 'contoso',
            connections: {
                contoso: {
                    tenantId: TID,
                    environment: 'Production',
                    companyId: COMPANY_A,
                    authMode: 'client_credentials',
                    clientId: 'app-1',
                    keychainService: 'wicket',
                    keychainAccount: 'contoso',
                },
            },
        });
        expect(registry.current().name).toBe('contoso');
        const who = await harness!.client.callTool({ name: 'wicket_whoami', arguments: {} });
        expect(toolIsError(who)).toBe(false);
    });

    test('a delegated save writes the sign-in record under the new name and always writes clientId', async () => {
        const log: Array<{ target: DelegatedTarget; silentOnly?: boolean }> = [];
        stub.rpc(() => odata({ userId: 'ME' }));
        await start({
            setupSession: new SetupSession({ createCredential: instantCredential(log), waitMs: 20 }),
            createCredential: async () => ({ getToken: async () => ({ token: 'tok' }), authenticationRecord: () => undefined }),
            tokens: () => ({ getToken: async () => 'tok' }),
        });
        expect(toolJsonAs<Record<string, unknown>>(await setup({ action: 'signin', method: 'browser' }))).toMatchObject({
            state: 'signedIn',
            upn: 'me@contoso.com',
            tenantId: TID,
        });
        const saved = toolJsonAs<Record<string, unknown>>(
            await setup({ action: 'save', name: 'me-prod', environment: 'Production', companyId: COMPANY_A }),
        );
        expect(saved).toMatchObject({ saved: 'me-prod', health: { state: 'ok' } });
        expect(JSON.parse(readFileSync(file, 'utf8')).connections['me-prod']).toEqual({
            tenantId: TID,
            environment: 'Production',
            companyId: COMPANY_A,
            authMode: 'browser',
            clientId: '1950a258-227b-4e31-a9cf-717495945fc2',
        });
        expect(JSON.parse(readFileSync(authRecordPath('me-prod'), 'utf8'))).toMatchObject({ username: 'me@contoso.com' });
        expect(existsSync(authRecordPath('.setup-session'))).toBe(false);
    });

    test('save before signing in is refused', async () => {
        await start();
        const res = await setup({ action: 'save', name: 'x', environment: 'Production', companyId: COMPANY_A });
        expect(toolIsError(res)).toBe(true);
        expect(toolText(res)).toMatch(/sign in first/i);
    });

    test('save refuses an existing name without replace', async () => {
        routeAppToken();
        stub.rpc(() => odata({}));
        await start();
        await setup({ action: 'signin', method: 'client_credentials', tenantId: TID, clientId: 'app-1', keychainService: 'wicket', keychainAccount: 'a' });
        await setup({ action: 'save', name: 'a', environment: 'Production', companyId: COMPANY_A });
        const again = await setup({ action: 'save', name: 'a', environment: 'Sandbox', companyId: COMPANY_B });
        expect(toolIsError(again)).toBe(true);
        expect(toolText(again)).toMatch(/connection "a" exists/);
        const replaced = await setup({ action: 'save', name: 'a', environment: 'Sandbox', companyId: COMPANY_B, replace: true });
        expect(toolIsError(replaced)).toBe(false);
        expect(JSON.parse(readFileSync(file, 'utf8')).connections.a).toMatchObject({ environment: 'Sandbox', companyId: COMPANY_B });
    });

    test('an invalid entry is refused before anything is written', async () => {
        routeAppToken();
        await start();
        await setup({ action: 'signin', method: 'client_credentials', tenantId: TID, clientId: 'app-1', keychainService: 'wicket', keychainAccount: 'a' });
        const res = await setup({ action: 'save', name: 'bad name!', environment: 'Production', companyId: COMPANY_A });
        expect(toolIsError(res)).toBe(true);
        expect(toolText(res)).toMatch(/is invalid/);
        expect(existsSync(file)).toBe(false);
    });

    test('removing the selected connection falls back to the default', async () => {
        process.env.WICKET_TEST_SECRET = 's';
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify({ default: 'prod', connections: { prod: entry(), sandbox: entry() } }));
        const registry = await start();
        registry.select('sandbox');
        const res = await setup({ action: 'remove', name: 'sandbox' });
        expect(toolIsError(res)).toBe(false);
        expect(registry.current()).toEqual({ name: 'prod', isSessionSelection: false });
        expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).connections)).toEqual(['prod']);
    });

    test('status rows carry tenantId, clientId and the keychain reference, never the secret', async () => {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(
            file,
            JSON.stringify({ connections: { app: entry({ clientId: 'my-app', keychainService: 'wicket', keychainAccount: 'app', secretEnv: undefined }) } }),
        );
        stub.route(/login\.microsoftonline\.com\/tenant-a\//, () => jsonResponse({ access_token: 'tok', expires_in: 3600 }));
        stub.rpc(() => odata({}));
        await start();
        const status = toolJsonAs<{ connections: Array<Record<string, unknown>> }>(await setup({ action: 'status' }));
        expect(status.connections[0]).toMatchObject({ tenantId: 'tenant-a', clientId: 'my-app', keychainService: 'wicket', keychainAccount: 'app' });
        expect(JSON.stringify(status)).not.toContain('SENTINEL');
    });

    test('view: status rows name the company, the description, read-only and whether the default client is used', async () => {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(
            file,
            JSON.stringify({
                default: 'up',
                connections: {
                    up: entry({ authMode: 'browser', clientId: undefined, secretEnv: undefined, readOnly: true, description: 'CRONUS · Production' }),
                    down: entry({ authMode: 'browser', clientId: 'my-app', secretEnv: undefined, description: 'Fabrikam · Sandbox' }),
                },
            }),
        );
        stub.rpc(() => odata({ userId: 'ME', company: 'CRONUS' }));
        await start({
            createCredential: async (target) => ({
                getToken: async () => {
                    if (target.name === 'down') throw new SignInNeededError('down');
                    return { token: 't' };
                },
                authenticationRecord: () => undefined,
            }),
            tokens: () => ({ getToken: async () => 't' }),
        });
        const status = toolJsonAs<{ connections: Array<Record<string, unknown>> }>(await setup({ action: 'status' }));
        expect(status.connections[0]).toMatchObject({
            name: 'up',
            isDefault: true,
            company: 'CRONUS',
            description: 'CRONUS · Production',
            readOnly: true,
            usesDefaultClient: true,
        });
        expect(status.connections[1]).toMatchObject({ name: 'down', description: 'Fabrikam · Sandbox', readOnly: false, usesDefaultClient: false });
        expect(status.connections[1]).not.toHaveProperty('company');
    });

    test('save records the company name as the description, and keeps a description already there', async () => {
        routeAppToken();
        stub.rpc(() => odata({}));
        await start();
        await setup({ action: 'signin', method: 'client_credentials', tenantId: TID, clientId: 'app-1', keychainService: 'wicket', keychainAccount: 'a' });
        await setup({ action: 'save', name: 'a', environment: 'Production', companyId: COMPANY_A, companyName: 'CRONUS' });
        expect(JSON.parse(readFileSync(file, 'utf8')).connections.a.description).toBe('CRONUS · Production');

        const doc = JSON.parse(readFileSync(file, 'utf8'));
        doc.connections.a.description = 'My own label';
        writeFileSync(file, JSON.stringify(doc));
        await setup({ action: 'save', name: 'a', environment: 'Sandbox', companyId: COMPANY_B, companyName: 'Fabrikam', replace: true });
        expect(JSON.parse(readFileSync(file, 'utf8')).connections.a.description).toBe('My own label');
    });

    test('status runs no interactive sign-in', async () => {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(
            file,
            JSON.stringify({ connections: { me: entry({ authMode: 'browser', clientId: undefined, secretEnv: undefined }) } }),
        );
        const log: Array<{ target: DelegatedTarget; silentOnly?: boolean }> = [];
        await start({ createCredential: instantCredential(log) });
        const status = toolJsonAs<{ connections: Array<{ name: string; source: string; health: { state: string } }> }>(
            await setup({ action: 'status' }),
        );
        expect(status.connections).toEqual([
            expect.objectContaining({ name: 'me', source: 'file', isDefault: true, health: expect.objectContaining({ state: 'signInNeeded' }) }),
        ]);
        expect(log.map((l) => l.silentOnly)).toEqual([true]);
        expect(stub.requests).toHaveLength(0);
    });

    test('the env-var connection is listed with source env and remove/save on it are refused', async () => {
        Object.assign(process.env, {
            BC_TENANT_ID: 'env-tenant',
            BC_ENVIRONMENT: 'production',
            BC_COMPANY_ID: COMPANY_A,
            BC_CLIENT_ID: 'env-client',
            BC_CLIENT_SECRET: 'env-secret',
        });
        stub.route(/login\.microsoftonline\.com\/env-tenant\//, () => jsonResponse({ access_token: 'tok', expires_in: 3600 }));
        stub.rpc(() => odata({}));
        routeAppToken();
        await start();
        const status = toolJsonAs<{ connections: Array<{ name: string; source: string }> }>(await setup({ action: 'status' }));
        expect(status.connections).toEqual([expect.objectContaining({ name: 'default', source: 'env' })]);
        const removed = await setup({ action: 'remove', name: 'default' });
        expect(toolIsError(removed)).toBe(true);
        expect(toolText(removed)).toMatch(/environment variables/);
        await setup({ action: 'signin', method: 'client_credentials', tenantId: TID, clientId: 'app-1', keychainService: 'wicket', keychainAccount: 'default' });
        const saved = await setup({ action: 'save', name: 'default', environment: 'Production', companyId: COMPANY_A, replace: true });
        expect(toolIsError(saved)).toBe(true);
        expect(toolText(saved)).toMatch(/environment variables/);
    });

    test('no tool result contains the keychain secret', async () => {
        routeAppToken();
        stub.route(/environments\/v1\.1$/, () => jsonResponse({ value: [] }));
        stub.rpc(() => odata({}));
        await start();
        const results = [
            await setup({ action: 'signin', method: 'client_credentials', tenantId: TID, clientId: 'app-1', keychainService: 'wicket', keychainAccount: 'k' }),
            await setup({ action: 'environments' }),
            await setup({ action: 'save', name: 'k', environment: 'Production', companyId: COMPANY_A }),
            await setup({ action: 'status' }),
        ];
        for (const r of results) expect(toolText(r)).not.toContain('SENTINEL');
        expect(readFileSync(file, 'utf8')).not.toContain('SENTINEL');
    });
});
