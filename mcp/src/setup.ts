/**
 * Guided setup: everything /wicket:setup needs that is not a Wicket call. It finds the tenant from
 * what a person has at hand (a BC address, an email, a domain), holds the one sign-in session setup
 * runs before a connection exists, lists environments and companies with that session's token, checks
 * a saved connection's health without ever prompting, and turns Entra and BC refusals into one
 * sentence with the next step.
 */

import {
    AppTokenProvider,
    DEFAULT_PUBLIC_CLIENT_ID,
    SignInNeededError,
    authRecordPath,
    createDelegatedCredential,
    isDelegated,
    resolveSecret,
    type ConnectionSpec,
    type DelegatedCredential,
    type DelegatedTarget,
    type SignInPrompt,
} from './connections.js';
import { rmSync } from 'node:fs';

const BC_API = 'https://api.businesscentral.dynamics.com';
const SCOPE = `${BC_API}/.default`;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVIRONMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_TIMEOUT_MS = 30_000;

/** The name the setup session's sign-in runs under before the connection has one. */
export const SETUP_SESSION_NAME = '.setup-session';

// ---------------------------------------------------------------------------
// Locating the tenant
// ---------------------------------------------------------------------------

/**
 * Read a Business Central web address: businesscentral.dynamics.com/<tenant>/<environment>/?company=<name>,
 * any part missing. The first segment is the tenant when it is a GUID or a domain, else the environment.
 * Undefined when the text is not a BC address.
 */
export function parseBcAddress(text: string): { tenant?: string; environment?: string; companyName?: string } | undefined {
    let url: URL;
    try {
        url = new URL(text.trim());
    } catch {
        return undefined;
    }
    if (url.hostname !== 'businesscentral.dynamics.com' && !url.hostname.endsWith('.businesscentral.dynamics.com')) return undefined;
    const segments = url.pathname.split('/').filter(Boolean);
    const found: { tenant?: string; environment?: string; companyName?: string } = {};
    if (segments[0] && (GUID_RE.test(segments[0]) || segments[0].includes('.'))) found.tenant = segments.shift();
    if (segments[0] && ENVIRONMENT_RE.test(segments[0])) found.environment = segments[0];
    const company = url.searchParams.get('company');
    if (company) found.companyName = company;
    return found;
}

/** The tenant GUID behind a domain, from its OpenID configuration; undefined when Entra knows no such tenant. */
async function tenantOfDomain(domain: string): Promise<string | undefined> {
    try {
        const res = await fetch(
            `https://login.microsoftonline.com/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`,
            { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
        if (!res.ok) return undefined;
        const issuer = ((await res.json()) as { issuer?: string }).issuer ?? '';
        return issuer.split('/').find((part) => GUID_RE.test(part));
    } catch {
        return undefined;
    }
}

export interface Located {
    tenantId?: string;
    environment?: string;
    companyName?: string;
    /** What the hint could not tell: 'tenant', 'environment', 'company'. */
    unresolved: string[];
}

/** Turn a BC address, an email or a domain into as much of a connection as it can tell. */
export async function locate(hint: string): Promise<Located> {
    const text = hint.trim();
    const address = parseBcAddress(text);
    let tenant: string | undefined;
    const found: Located = { unresolved: [] };
    if (address) {
        tenant = address.tenant;
        if (address.environment) found.environment = address.environment;
        if (address.companyName) found.companyName = address.companyName;
    } else {
        tenant = text.includes('@') ? text.slice(text.lastIndexOf('@') + 1) : text;
    }
    if (tenant) {
        const id = GUID_RE.test(tenant) ? tenant : await tenantOfDomain(tenant);
        if (id) found.tenantId = id.toLowerCase();
    }
    const result: Located = {
        ...(found.tenantId ? { tenantId: found.tenantId } : {}),
        ...(found.environment ? { environment: found.environment } : {}),
        ...(found.companyName ? { companyName: found.companyName } : {}),
        unresolved: [],
    };
    if (!result.tenantId) result.unresolved.push('tenant');
    if (!result.environment) result.unresolved.push('environment');
    if (!result.companyName) result.unresolved.push('company');
    return result;
}

// ---------------------------------------------------------------------------
// The setup sign-in session
// ---------------------------------------------------------------------------

export type SigninMethod = 'browser' | 'device_code' | 'client_credentials';

export interface SigninArgs {
    method: SigninMethod;
    /** Drop the current sign-in, whatever its state, and start afresh (another account, a closed window). */
    restart?: boolean;
    tenantId?: string;
    clientId?: string;
    keychainService?: string;
    keychainAccount?: string;
}

export type SigninState =
    | { state: 'pending'; prompt: SignInPrompt }
    | { state: 'signedIn'; upn?: string; appId?: string; tenantId: string }
    | { state: 'failed'; message: string };

export interface SetupTarget {
    method: SigninMethod;
    tenantId: string;
    clientId: string;
    keychainService?: string;
    keychainAccount?: string;
}

type CreateCredential = typeof createDelegatedCredential;

export interface SetupSessionOptions {
    createCredential?: CreateCredential;
    /** How long one signin call waits for the token, or the prompt, before answering pending. */
    waitMs?: number;
    now?: () => number;
}

/** A sign-in nobody finishes (closed tab, unused code) is abandoned after this long. */
const PENDING_LIMIT_MS = 10 * 60_000;

interface Flow {
    key: string;
    startedAt: number;
    target: SetupTarget;
    prompt?: SignInPrompt;
    prompted: Promise<void>;
    result: Promise<{ token: string } | { error: unknown }>;
    settled?: { token: string } | { error: unknown };
    credential?: DelegatedCredential;
}

function claimsOf(token: string): Record<string, unknown> {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/**
 * The one sign-in setup holds, before any connection exists. A call with the same arguments continues
 * it; different arguments replace it. A call never waits on the person for longer than `waitMs`: it
 * answers pending with the prompt, and the next call picks the token up.
 */
export class SetupSession {
    private flow: Flow | undefined;
    private readonly createCredential: CreateCredential;
    private readonly waitMs: number;
    private readonly now: () => number;

    constructor(options: SetupSessionOptions = {}) {
        this.createCredential = options.createCredential ?? createDelegatedCredential;
        this.waitMs = options.waitMs ?? 10_000;
        this.now = options.now ?? Date.now;
    }

    async signin(args: SigninArgs): Promise<SigninState> {
        const key = JSON.stringify([args.method, args.tenantId, args.clientId, args.keychainService, args.keychainAccount]);
        if (this.flow && (this.flow.key !== key || args.restart)) this.flow = undefined;
        if (this.flow && !this.flow.settled && this.now() - this.flow.startedAt > PENDING_LIMIT_MS) {
            this.flow = undefined;
            return { state: 'failed', message: 'The sign-in was not finished within 10 minutes: sign-in timed out, start again.' };
        }
        if (this.flow && this.flow.settled && 'error' in this.flow.settled) this.flow = undefined;
        if (!this.flow) {
            if (args.method === 'client_credentials' && (!args.tenantId || !args.clientId)) {
                return { state: 'failed', message: 'An app sign-in needs the tenantId and clientId of the app registration.' };
            }
            this.flow = this.start(key, args);
        }
        const flow = this.flow;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const window = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.waitMs);
        });
        try {
            await Promise.race([flow.result, flow.prompt ? window : Promise.race([flow.prompted, window])]);
        } finally {
            clearTimeout(timer);
        }
        if (flow.settled && 'error' in flow.settled) {
            this.flow = undefined;
            return { state: 'failed', message: explainAuthError(flow.settled.error) };
        }
        if (flow.settled) {
            const claims = claimsOf(flow.settled.token);
            const tenantId = String(claims.tid ?? flow.target.tenantId);
            flow.target = { ...flow.target, tenantId };
            const who = claims.upn ?? claims.preferred_username ?? claims.unique_name;
            return {
                state: 'signedIn',
                ...(typeof who === 'string' ? { upn: who } : {}),
                ...(flow.target.method === 'client_credentials' ? { appId: String(claims.appid ?? claims.azp ?? flow.target.clientId) } : {}),
                tenantId,
            };
        }
        if (flow.prompt) return { state: 'pending', prompt: flow.prompt };
        return { state: 'failed', message: 'The sign-in did not start; try again.' };
    }

    private start(key: string, args: SigninArgs): Flow {
        const target: SetupTarget = {
            method: args.method,
            tenantId: args.tenantId ?? 'organizations',
            clientId: args.clientId ?? DEFAULT_PUBLIC_CLIENT_ID,
            ...(args.keychainService ? { keychainService: args.keychainService } : {}),
            ...(args.keychainAccount ? { keychainAccount: args.keychainAccount } : {}),
        };
        let signalPrompt: () => void = () => {};
        const flow: Flow = {
            key,
            startedAt: this.now(),
            target,
            prompted: new Promise<void>((resolve) => {
                signalPrompt = resolve;
            }),
            result: Promise.resolve({ error: undefined }),
        };
        const acquire = async (): Promise<string> => {
            if (target.method === 'client_credentials') {
                return new AppTokenProvider(this.appSpec(target)).getToken();
            }
            // Always a fresh sign-in: a record left by an earlier setup would sign the old account in silently.
            rmSync(authRecordPath(SETUP_SESSION_NAME), { force: true });
            const delegated: DelegatedTarget = {
                name: SETUP_SESSION_NAME,
                tenantId: target.tenantId,
                clientId: target.clientId,
                authMode: target.method,
                persistTokenCache: true,
            };
            flow.credential = await this.createCredential(delegated, (prompt) => {
                flow.prompt = prompt;
                signalPrompt();
            });
            const token = await flow.credential.getToken(SCOPE);
            if (!token) throw new Error('The sign-in returned no token.');
            return token.token;
        };
        flow.result = acquire().then(
            (token) => (flow.settled = { token }),
            (error: unknown) => (flow.settled = { error }),
        );
        return flow;
    }

    private appSpec(target: SetupTarget): ConnectionSpec {
        return {
            name: SETUP_SESSION_NAME,
            tenantId: target.tenantId,
            environment: 'setup',
            companyId: '00000000-0000-0000-0000-000000000000',
            authMode: 'client_credentials',
            clientId: target.clientId,
            persistTokenCache: false,
            readOnly: true,
            ...(target.keychainService ? { keychainService: target.keychainService } : {}),
            ...(target.keychainAccount ? { keychainAccount: target.keychainAccount } : {}),
        };
    }

    /** The signed-in token; throws when the session has not signed in. */
    token(): string {
        const settled = this.flow?.settled;
        if (!settled || !('token' in settled)) throw new Error('Setup is not signed in: call signin first.');
        return settled.token;
    }

    get target(): SetupTarget | undefined {
        return this.flow?.target;
    }

    /** The delegated sign-in's account record (serialized), to save under the new connection's name. */
    authenticationRecord(): string | undefined {
        return this.flow?.credential?.authenticationRecord();
    }
}

// ---------------------------------------------------------------------------
// Listing environments and companies
// ---------------------------------------------------------------------------

/** A refused listing call, carrying the HTTP status for explainAuthError. */
export class HttpStatusError extends Error {
    constructor(
        readonly status: number,
        body: string,
    ) {
        super(`HTTP ${status}: ${body.slice(0, 300)}`);
        this.name = 'HttpStatusError';
    }
}

async function getJson(url: string, token: string): Promise<{ value?: Array<Record<string, unknown>> }> {
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpStatusError(res.status, text);
    return JSON.parse(text) as { value?: Array<Record<string, unknown>> };
}

export async function listEnvironments(token: string): Promise<Array<{ name: string; type: string; countryCode: string }>> {
    const body = await getJson(`${BC_API}/environments/v1.1`, token);
    return (body.value ?? []).map((e) => ({ name: String(e.name), type: String(e.type), countryCode: String(e.countryCode) }));
}

export async function listCompanies(
    token: string,
    tenantId: string,
    environment: string,
): Promise<Array<{ id: string; name: string; displayName: string }>> {
    const body = await getJson(
        `${BC_API}/v2.0/${encodeURIComponent(tenantId)}/${encodeURIComponent(environment)}/api/v2.0/companies`,
        token,
    );
    return (body.value ?? []).map((c) => ({ id: String(c.id), name: String(c.name), displayName: String(c.displayName ?? '') }));
}

/** The company called `name`, by name then display name, ignoring case. */
export function matchCompany<C extends { name: string; displayName: string }>(companies: C[], name: string): C | undefined {
    const wanted = name.trim().toLocaleLowerCase();
    return (
        companies.find((c) => c.name.toLocaleLowerCase() === wanted) ??
        companies.find((c) => c.displayName && c.displayName.toLocaleLowerCase() === wanted)
    );
}

// ---------------------------------------------------------------------------
// Health and plain-language errors
// ---------------------------------------------------------------------------

export type HealthState = 'ok' | 'signInNeeded' | 'secretMissing' | 'tokenRefused' | 'bcRefused' | 'wicketNotFound' | 'unreachable';

export interface Health {
    state: HealthState;
    message: string;
    identity?: unknown;
}

function statusOf(err: unknown): number | undefined {
    const e = err as { status?: unknown; problem?: { status?: unknown } } | null;
    const status = e?.problem?.status ?? e?.status;
    return typeof status === 'number' ? status : undefined;
}

function messageOf(err: unknown): string {
    if (err instanceof Error) return err.message;
    const problem = (err as { problem?: { detail?: unknown } } | null)?.problem;
    return typeof problem?.detail === 'string' ? problem.detail : String(err);
}

/**
 * Check a saved connection without ever prompting: a delegated sign-in is tried silently (cache and
 * account record only), a secret is resolved but never shown, then `whoami` runs through Wicket.
 */
export async function checkHealth(
    spec: ConnectionSpec,
    whoami: () => Promise<unknown>,
    opts: { createCredential?: CreateCredential } = {},
): Promise<Health> {
    try {
        if (isDelegated(spec.authMode)) {
            const create = opts.createCredential ?? createDelegatedCredential;
            const credential = await create(spec as DelegatedTarget, () => {}, { silentOnly: true });
            await credential.getToken(SCOPE);
        } else {
            await resolveSecret(spec);
        }
    } catch (err) {
        if (err instanceof SignInNeededError) return { state: 'signInNeeded', message: 'The saved sign-in is missing or expired: sign in again.' };
        if (!isDelegated(spec.authMode)) {
            return { state: 'secretMissing', message: 'The client secret is not where the connection says (Keychain item or variable): store it again.' };
        }
        return { state: 'tokenRefused', message: explainAuthError(err) };
    }
    try {
        return { state: 'ok', message: 'Connected.', identity: await whoami() };
    } catch (err) {
        const status = statusOf(err);
        const type = (err as { problem?: { type?: unknown } } | null)?.problem?.type;
        if (typeof type === 'string' && type.endsWith('sign-in-required')) {
            return { state: 'signInNeeded', message: 'The saved sign-in is missing or expired: sign in again.' };
        }
        if (status === 404) return { state: 'wicketNotFound', message: explainAuthError(err) };
        if (status === 401 || status === 403) return { state: 'bcRefused', message: explainAuthError(err) };
        if (/token request|AADSTS/.test(messageOf(err))) return { state: 'tokenRefused', message: explainAuthError(err) };
        if (err instanceof TypeError || /timed out|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(messageOf(err))) {
            return { state: 'unreachable', message: `Business Central could not be reached: ${messageOf(err).slice(0, 200)}` };
        }
        return { state: status ? 'bcRefused' : 'unreachable', message: explainAuthError(err) };
    }
}

/**
 * A refused environments or companies list, in words that fit that step: these are Business
 * Central's own APIs, so a 403 or 404 says nothing about Wicket's permission sets or installation.
 */
export function explainListError(err: unknown, list: 'environments' | 'companies', environment?: string): string {
    if (/AADSTS/.test(messageOf(err))) return explainAuthError(err);
    const status = statusOf(err);
    if (status === undefined) return explainAuthError(err);
    if (list === 'environments') {
        return (
            `This account couldn't list the environments (HTTP ${status}): paste the Business Central address ` +
            'from your browser instead, or type the environment name.'
        );
    }
    return (
        `Business Central refused the company list for ${environment ?? 'that environment'} (HTTP ${status}): check ` +
        "the environment name, and that this account can sign in to it in the browser."
    );
}

/** One sentence and the next step for the Entra and BC refusals setup meets; anything else as it came, cut to 300 characters. */
export function explainAuthError(err: unknown): string {
    const text = messageOf(err);
    if (/AADSTS50020/.test(text)) {
        return "This account isn't a member or guest of that tenant: sign in with another account, or ask the tenant's admin for guest access.";
    }
    if (/AADSTS65001|consent_required/.test(text)) {
        return 'The app needs admin consent in that tenant: use the Wicket default client, or ask an admin to consent.';
    }
    if (/AADSTS700016/.test(text)) {
        return "That client ID isn't known in this tenant: check the ID, or use the Wicket default client.";
    }
    if (/AADSTS7000215|AADSTS7000222/.test(text)) {
        return 'The client secret is wrong or expired: store the current secret in the Keychain again.';
    }
    const status = statusOf(err);
    if (status === 401) {
        return "Business Central doesn't know this user (or app) in that environment: the BC admin must add it.";
    }
    if (status === 403) {
        return 'Signed in, but there is no Wicket permission set: the BC admin assigns Wicket - Read (or Execute/Edit).';
    }
    if (status === 404) {
        return "Wicket isn't installed in that environment, or the environment or company name is wrong.";
    }
    return text.slice(0, 300);
}
