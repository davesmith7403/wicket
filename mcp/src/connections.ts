/**
 * Connection registry for the Wicket MCP server.
 *
 * A connection is a named, pinned {tenant, environment, company, credentials}
 * bundle. Sources, merged in this order (later wins on name collision):
 *   1. Env vars (BC_TENANT_ID etc.) -> implicit connection "default"  [back-compat]
 *   2. ~/.config/wicket/connections.json (or $WICKET_CONNECTIONS_FILE)
 *
 * Secrets resolve per connection, in priority order:
 *   - keychainService / keychainAccount  -> macOS `security find-generic-password`
 *   - secretEnv                          -> named environment variable
 *   - clientSecret                       -> inline (dev only; warns on stderr)
 *
 * Auth modes:
 *   - "client_credentials" (default) — service principal, app identity in BC.
 *   - "device_code" — delegated user auth via @azure/identity DeviceCodeCredential,
 *     scope .../.default (= the app's consented delegated permissions, i.e.
 *     user_impersonation). The consultant signs in AS THEMSELVES; BC user
 *     permissions apply per person and the Wicket Operation Log attributes each call to
 *     a human. No client secret (public-client flow); works with guest access in
 *     customer tenants. The @azure/identity package is imported dynamically, so a
 *     client_credentials-only deployment never loads it. The sign-in survives restarts:
 *     MSAL's token cache lives in the OS keychain (@azure/identity-cache-persistence) and the
 *     account record in ~/.config/wicket/auth/<name>.json (persistTokenCache: false opts out).
 *
 * companyId is REQUIRED on every connection. Wicket's endpoint is company-scoped
 * (companies({companyId})/wicketEndpoint(0)/…), so there is no companyless route to
 * "discover the company" — the caller must pin it. The optional `companies`
 * allowlist is client-side defense-in-depth: when present, companyId must be a
 * member (validated at load).
 */

import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config locations
// ---------------------------------------------------------------------------

/** Test seam: the directory that holds wicket/ (Bun caches homedir()). */
export const configHome = { dir: join(homedir(), '.config') };

/** WICKET_<suffix>, trimmed; undefined when unset or blank. */
export function envSetting(suffix: string): string | undefined {
    return process.env[`WICKET_${suffix}`]?.trim() || undefined;
}

/** ~/.config/wicket/<parts>. */
export function configPath(...parts: string[]): string {
    return join(configHome.dir, 'wicket', ...parts);
}

/** $WICKET_CONNECTIONS_FILE, else ~/.config/wicket/connections.json. */
export function connectionsFile(): string {
    return envSetting('CONNECTIONS_FILE') || configPath('connections.json');
}

/** Where a device_code connection's account record is saved: $WICKET_AUTH_DIR, else ~/.config/wicket/auth. */
export function authRecordPath(connectionName: string): string {
    const name = `${connectionName}.json`;
    const explicit = envSetting('AUTH_DIR');
    return explicit ? join(explicit, name) : configPath('auth', name);
}

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Schema for connections.json
// ---------------------------------------------------------------------------

/**
 * companyId is interpolated verbatim into the request URL (companies({companyId})),
 * so it must be a plain, brace-less GUID — anything else is rejected at load.
 */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * tenantId and environment are interpolated into the default SaaS URL
 * (/v2.0/{tenantId}/{environment}) and the token URL, so they are restricted to URL-safe
 * shapes at load: a tenant is a GUID or a domain-ish name (dot-separated DNS labels — a GUID
 * matches too), an environment is [A-Za-z0-9_-]. No '/', '?', '#' or '..' can get through.
 */
const TENANT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ENVIRONMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TENANT_MSG = 'must be a tenant GUID or domain (e.g. contoso.onmicrosoft.com)';
const ENVIRONMENT_MSG = 'must match [A-Za-z0-9_-] (it is interpolated into the request URL)';
const BASE_URL_MSG = 'must be an absolute https:// URL (http:// only for localhost; the bearer token rides on every request)';

/** An absolute https: URL, or http: to a loopback host (a local dev container never leaves the machine). The bearer token must never travel in cleartext over a network. */
function isHttpsUrl(v: string): boolean {
    try {
        const u = new URL(v);
        if (u.protocol === 'https:') return true;
        return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    } catch {
        return false;
    }
}

/** The envelope `origin` charset/length the AL side validates; BC_ORIGIN must fit it. */
const ORIGIN_RE = /^[A-Za-z0-9._@/+:-]{1,256}$/;

// .strict(): an unknown key (e.g. a typo'd "keychainSevice") must FAIL the load,
// not silently strip and change which rung of the secret ladder applies.
const ConnectionEntry = z.object({
    tenantId: z.string().regex(TENANT_RE, TENANT_MSG),
    environment: z.string().regex(ENVIRONMENT_RE, ENVIRONMENT_MSG),
    /** Required: Wicket's endpoint is company-scoped, so every connection pins one. */
    companyId: z
        .string()
        .regex(GUID_RE, 'must be a brace-less GUID (it is interpolated into the request URL)'),
    /** Optional allowlist of company GUIDs this connection may target (defense in depth). */
    companies: z.array(z.string()).optional(),
    /**
     * "client_credentials" (default) uses a service-principal secret; "device_code"
     * signs the running user in interactively (public client, no secret) and calls BC
     * with their delegated identity.
     */
    authMode: z.enum(['client_credentials', 'device_code']).default('client_credentials'),
    clientId: z.string().min(1),
    /**
     * device_code only: keep the sign-in across MCP restarts — MSAL's token cache in the OS
     * keychain, the account record in ~/.config/wicket/auth/<name>.json. Default true; false
     * keeps the token in memory only (sign in again on every start).
     */
    persistTokenCache: z.boolean().default(true),
    /** Inline secret — dev only. Prefer keychain / secretEnv. */
    clientSecret: z.string().optional(),
    /** Name of an env var holding the secret. */
    secretEnv: z.string().optional(),
    /** macOS Keychain lookup: security find-generic-password -s <service> -a <account> -w */
    keychainService: z.string().optional(),
    keychainAccount: z.string().optional(),
    baseUrl: z.string().refine(isHttpsUrl, BASE_URL_MSG).optional(),
    /**
     * Client-side write guard. When true the MCP server refuses insert/modify/delete/invoke/
     * action for this connection BEFORE any token is fetched, answering a synthetic 403
     * connection-read-only problem that names the connection and points at wicket_connections.
     * Defense in depth over Wicket's server-side Read-Only Mode: one MCP process can front a
     * read-only production and a writable sandbox side by side, and the guard holds even if the
     * principal's rights in BC are later widened. Default false (back-compat).
     */
    readOnly: z.boolean().default(false),
    /**
     * Field-masking opt-out. When false the MCP server stamps `"unmask": false` on the data of
     * every read operation (query, readBlob, describe) so Wicket does NOT apply this principal's
     * unmask grants (Unmask permission-set tier, per-user exceptions): the connection then sees at
     * most what the baseline policy shows. Unset (default) leaves the server default, grants apply.
     * Only false is ever sent; there is no way to ask for MORE visibility from the client.
     */
    unmask: z.boolean().optional(),
    /** Free-text label shown by wicket_connections. */
    description: z.string().optional(),
}).strict();
/**
 * A resolved connection: the file/env entry plus its name and (for the implicit
 * env `default` only) an optional `origin` override honouring BC_ORIGIN.
 */
export type ConnectionSpec = z.infer<typeof ConnectionEntry> & {
    name: string;
    origin?: string;
};

const ConnectionsFile = z.object({
    default: z.string().optional(),
    connections: z.record(ConnectionEntry),
}).strict();

const CONNECTION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * When a connection carries a `companies` allowlist, its pinned companyId must be a
 * member — otherwise the connection is misconfigured (it can only ever target a
 * company it isn't allowed to). Enforced at load so it fails fast and loudly.
 */
function assertCompanyAllowed(spec: ConnectionSpec): void {
    if (!spec.companies?.length) return;
    const ok = spec.companies.some((c) => c.toLowerCase() === spec.companyId.toLowerCase());
    if (!ok) {
        throw new Error(
            `Connection "${spec.name}": companyId ${spec.companyId} is not in this connection's ` +
                `companies allowlist (${spec.companies.join(', ')}).`,
        );
    }
}

/**
 * Load-time secret-source check (existence of a SOURCE, not the secret value —
 * a keychain item or env var may legitimately appear only at token-fetch time):
 *
 * - client_credentials MUST configure one rung of the secret ladder
 *   (keychainService+keychainAccount, secretEnv, or clientSecret) — otherwise the
 *   connection would validate fine and fail only at the first token fetch.
 * - a half-configured keychain pair (service without account or vice versa) is an error.
 * - device_code carries no secret; a configured source is IGNORED (warned once on stderr).
 */
function assertSecretSource(spec: ConnectionSpec): void {
    const hasKeychainPair = Boolean(spec.keychainService && spec.keychainAccount);
    const hasAnySource =
        hasKeychainPair || Boolean(spec.secretEnv) || Boolean(spec.clientSecret);

    if (spec.authMode === 'device_code') {
        if (hasAnySource || spec.keychainService || spec.keychainAccount) {
            process.stderr.write(
                `wicket-mcp: connection "${spec.name}" uses device_code — its configured ` +
                    `secret source (keychain/secretEnv/clientSecret) is ignored.\n`,
            );
        }
        return;
    }

    if (Boolean(spec.keychainService) !== Boolean(spec.keychainAccount)) {
        throw new Error(
            `Connection "${spec.name}": keychain lookup needs BOTH keychainService and ` +
                `keychainAccount (only one is set).`,
        );
    }
    if (!hasAnySource) {
        throw new Error(
            `Connection "${spec.name}": authMode client_credentials but no secret source ` +
                'configured — set keychainService+keychainAccount, secretEnv, or clientSecret.',
        );
    }
}

/** Build + validate the implicit env `default` connection. Throws on a malformed variable. */
function envDefaultSpec(tenantId: string, environment: string, companyId: string, clientId: string): ConnectionSpec {
    const bad = (variable: string, value: string, why: string) =>
        new Error(`Connection "default" (from env): ${variable} "${value}" ${why}.`);
    if (!GUID_RE.test(companyId)) {
        throw bad('BC_COMPANY_ID', companyId, 'is not a brace-less GUID (it is interpolated into the request URL)');
    }
    if (!TENANT_RE.test(tenantId)) throw bad('BC_TENANT_ID', tenantId, TENANT_MSG);
    if (!ENVIRONMENT_RE.test(environment)) throw bad('BC_ENVIRONMENT', environment, ENVIRONMENT_MSG);
    const baseUrl = process.env.BC_BASE_URL?.trim() || undefined;
    if (baseUrl !== undefined && !isHttpsUrl(baseUrl)) throw bad('BC_BASE_URL', baseUrl, BASE_URL_MSG);
    // origin is stamped verbatim into every envelope; the AL side rejects anything outside
    // its charset, so a bad BC_ORIGIN would fail EVERY call — fail at load instead.
    const origin = process.env.BC_ORIGIN?.trim() || undefined;
    if (origin !== undefined && !ORIGIN_RE.test(origin)) {
        throw bad('BC_ORIGIN', origin, 'is invalid (use [A-Za-z0-9._@/+:-], <=256 chars)');
    }
    const spec: ConnectionSpec = {
        name: 'default',
        tenantId,
        environment,
        companyId,
        authMode: 'client_credentials',
        clientId,
        persistTokenCache: true,
        clientSecret: process.env.BC_CLIENT_SECRET?.trim() || undefined,
        baseUrl,
        // BC_READ_ONLY=1|true|yes makes the env-implicit connection refuse writes client-side.
        readOnly: /^(1|true|yes)$/i.test(process.env.BC_READ_ONLY?.trim() ?? ''),
        origin,
        description: 'Implicit connection from environment variables',
    };
    assertSecretSource(spec);
    return spec;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ConnectionRegistry {
    private readonly specs = new Map<string, ConnectionSpec>();
    private defaultName: string | undefined;
    /** Sticky session selection, set by the wicket_use tool. */
    private selected: string | undefined;

    static load(): ConnectionRegistry {
        const reg = new ConnectionRegistry();

        // 1. Implicit "default" from env vars (back-compat with single-connection setups).
        // A malformed env default is NOT fatal yet: connections.json may define its own
        // "default" that replaces it (below). The error is raised only if nothing does.
        let envError: Error | undefined;
        const t = process.env.BC_TENANT_ID?.trim();
        const e = process.env.BC_ENVIRONMENT?.trim();
        const co = process.env.BC_COMPANY_ID?.trim();
        const c = process.env.BC_CLIENT_ID?.trim();
        if (t && e && co && c) {
            try {
                reg.specs.set('default', envDefaultSpec(t, e, co, c));
            } catch (err) {
                envError = err instanceof Error ? err : new Error(String(err));
            }
            reg.defaultName = 'default';
        }

        // 2. connections.json (overrides env on name collision).
        const file = connectionsFile();
        if (existsSync(file)) {
            // Wrap parse failures so the error names the FILE — a bare zod/JSON error
            // gives the operator nothing to open. Zod issues keep their paths
            // (e.g. connections.contoso: Unrecognized key(s) in object: 'keychainSevice').
            let parsed: z.infer<typeof ConnectionsFile>;
            try {
                parsed = ConnectionsFile.parse(JSON.parse(readFileSync(file, 'utf8')));
            } catch (err) {
                const cause =
                    err instanceof z.ZodError
                        ? err.issues
                              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                              .join('; ')
                        : err instanceof Error
                          ? err.message
                          : String(err);
                throw new Error(`Failed to load ${file}: ${cause}`);
            }
            for (const [name, entry] of Object.entries(parsed.connections)) {
                if (!CONNECTION_NAME_RE.test(name)) {
                    throw new Error(
                        `Connection name "${name}" is invalid (use [A-Za-z0-9._-], <=64 chars).`,
                    );
                }
                const spec: ConnectionSpec = { ...entry, name };
                assertCompanyAllowed(spec);
                assertSecretSource(spec);
                reg.specs.set(name, spec);
            }
            // Best-effort hygiene: a connections.json that carries an INLINE secret
            // should not be readable by group/other. Warn once; never fail the load.
            if (Object.values(parsed.connections).some((c) => c.clientSecret)) {
                try {
                    if (statSync(file).mode & 0o077) {
                        process.stderr.write(
                            `wicket-mcp: ${file} contains an inline clientSecret and is ` +
                                `group/other-readable — consider: chmod 600 ${file}\n`,
                        );
                    }
                } catch {
                    /* best-effort only */
                }
            }
            // An explicitly declared default MUST name a loaded connection — otherwise
            // every non-overridden call (including writes) would silently target
            // whichever connection happens to be first. Fail fast, like the name check.
            if (parsed.default !== undefined) {
                if (!reg.specs.has(parsed.default)) {
                    throw new Error(
                        `connections.json declares default "${parsed.default}", which is not a ` +
                            `configured connection. Available: ${[...reg.specs.keys()].join(', ')}.`,
                    );
                }
                reg.defaultName = parsed.default;
            }
        }

        // The env default was malformed and no file entry named "default" replaced it.
        if (envError && !reg.specs.has('default')) throw envError;

        if (reg.specs.size === 0) {
            throw new Error(
                'No Wicket connections configured. Either set BC_TENANT_ID/BC_ENVIRONMENT/' +
                    'BC_COMPANY_ID/BC_CLIENT_ID/BC_CLIENT_SECRET, or create ' +
                    '~/.config/wicket/connections.json.',
            );
        }
        // Implicit fallback ONLY when no default was declared anywhere (no env-implicit
        // "default", no file `default`): fall back to the first connection loaded.
        if (!reg.defaultName) {
            reg.defaultName = reg.specs.keys().next().value;
        }
        return reg;
    }

    /** Resolution ladder: per-call override -> session selection -> default. */
    resolve(override?: string): ConnectionSpec {
        const name = override ?? this.selected ?? this.defaultName!;
        const spec = this.specs.get(name);
        if (!spec) {
            throw new Error(
                `Unknown connection "${name}". Available: ${[...this.specs.keys()].join(', ')}. ` +
                    'Use wicket_connections to list them.',
            );
        }
        return spec;
    }

    select(name: string): ConnectionSpec {
        const spec = this.specs.get(name);
        if (!spec) {
            throw new Error(
                `Unknown connection "${name}". Available: ${[...this.specs.keys()].join(', ')}.`,
            );
        }
        this.selected = name;
        return spec;
    }

    current(): { name: string; isSessionSelection: boolean } {
        return {
            name: this.selected ?? this.defaultName!,
            isSessionSelection: this.selected !== undefined,
        };
    }

    list(): Array<{
        name: string;
        tenantId: string;
        environment: string;
        companyId: string;
        authMode: string;
        readOnly: boolean;
        unmask?: boolean;
        description?: string;
        isDefault: boolean;
        isSelected: boolean;
    }> {
        const cur = this.current().name;
        return [...this.specs.values()].map((s) => ({
            name: s.name,
            tenantId: s.tenantId,
            environment: s.environment,
            companyId: s.companyId,
            authMode: s.authMode,
            readOnly: s.readOnly,
            ...(s.unmask !== undefined ? { unmask: s.unmask } : {}),
            description: s.description,
            isDefault: s.name === this.defaultName,
            isSelected: s.name === cur,
        }));
    }
}

// ---------------------------------------------------------------------------
// Secret resolution (never logged, resolved lazily per token fetch)
// ---------------------------------------------------------------------------

/**
 * Test seam: one macOS keychain read. Async execFile, NOT execFileSync: a locked-keychain modal on
 * one connection must not freeze the event loop (and every other connection).
 */
export const keychain = {
    async find(service: string, account: string): Promise<string> {
        const { stdout } = await execFileAsync(
            'security',
            ['find-generic-password', '-s', service, '-a', account, '-w'],
            { encoding: 'utf8' },
        );
        return stdout.trim();
    },
};

/** Specs already warned about an inline clientSecret — the warning is once per connection. */
const inlineSecretWarned = new WeakSet<ConnectionSpec>();

export async function resolveSecret(spec: ConnectionSpec): Promise<string> {
    if (spec.keychainService && spec.keychainAccount) {
        try {
            return await keychain.find(spec.keychainService, spec.keychainAccount);
        } catch {
            throw new Error(
                `Connection "${spec.name}": keychain lookup failed ` +
                    `(service=${spec.keychainService}, account=${spec.keychainAccount}). ` +
                    `Add it with: security add-generic-password -s ${spec.keychainService} ` +
                    `-a ${spec.keychainAccount} -w '<secret>'`,
            );
        }
    }
    if (spec.secretEnv) {
        const v = process.env[spec.secretEnv];
        if (!v) throw new Error(`Connection "${spec.name}": env var ${spec.secretEnv} is not set.`);
        return v;
    }
    if (spec.clientSecret) {
        if (!inlineSecretWarned.has(spec)) {
            inlineSecretWarned.add(spec);
            process.stderr.write(
                `wicket-mcp: connection "${spec.name}" uses an INLINE clientSecret — ` +
                    `prefer keychainService/keychainAccount or secretEnv.\n`,
            );
        }
        return spec.clientSecret;
    }
    throw new Error(
        `Connection "${spec.name}": no secret configured ` +
            '(set keychainService+keychainAccount, secretEnv, or clientSecret).',
    );
}

// ---------------------------------------------------------------------------
// Per-connection token providers
// ---------------------------------------------------------------------------

const APP_SCOPE = 'https://api.businesscentral.dynamics.com/.default';
// Delegated tokens ask for `.default`, i.e. every delegated permission the client app has been
// consented for BC — user_impersonation for a normal registration. Requesting user_impersonation by
// name is refused for Microsoft first-party public clients (AADSTS65002: preauthorization required),
// which `.default` also serves, so one scope works for both.
const DELEGATED_SCOPE = 'https://api.businesscentral.dynamics.com/.default';

/** Cap on the Entra ID token POST — a hung login endpoint must not block a tool call. */
const TOKEN_TIMEOUT_MS = 30_000;

/**
 * True when `err` is the DOMException a fetch rejects with once its
 * AbortSignal.timeout fires ("TimeoutError"; some runtimes report "AbortError").
 */
export function isTimeoutError(err: unknown): boolean {
    return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export interface TokenSource {
    getToken(): Promise<string>;
    /**
     * Drop any cached token so the next getToken mints a fresh one. Optional: a source that
     * cannot force a refresh omits it, and the client then does not retry a 401.
     */
    invalidate?(): void;
}

/** client_credentials — app identity (unchanged semantics from the single-connection server). */
export class AppTokenProvider implements TokenSource {
    private cached: { token: string; expiresAt: number } | null = null;
    private inflight: Promise<string> | null = null;

    constructor(private readonly spec: ConnectionSpec) {}

    invalidate(): void {
        this.cached = null;
    }

    async getToken(): Promise<string> {
        // Refresh 60s before the real expiry to avoid mid-flight 401s.
        if (this.cached && Date.now() < this.cached.expiresAt - 60_000) return this.cached.token;
        // Coalesce concurrent refreshes.
        if (this.inflight) return this.inflight;
        this.inflight = this.fetch().finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }

    private async fetch(): Promise<string> {
        const secret = await resolveSecret(this.spec);
        let res: Response;
        try {
            res = await fetch(
                `https://login.microsoftonline.com/${this.spec.tenantId}/oauth2/v2.0/token`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'client_credentials',
                        client_id: this.spec.clientId,
                        client_secret: secret,
                        scope: APP_SCOPE,
                    }).toString(),
                    // A hung token endpoint would otherwise block the tool call forever.
                    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
                },
            );
        } catch (err) {
            if (isTimeoutError(err)) {
                throw new Error(
                    `Connection "${this.spec.name}": token request timed out — Entra ID did ` +
                        `not respond within ${TOKEN_TIMEOUT_MS / 1000}s. Check network ` +
                        'reachability of login.microsoftonline.com and retry.',
                );
            }
            throw err;
        }
        const text = await res.text();
        if (!res.ok) {
            throw new Error(
                `Connection "${this.spec.name}": token request failed (HTTP ${res.status}): ` +
                    text.slice(0, 400),
            );
        }
        const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
        if (!parsed.access_token) {
            throw new Error(`Connection "${this.spec.name}": token response had no access_token.`);
        }
        this.cached = {
            token: parsed.access_token,
            expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
        };
        return parsed.access_token;
    }
}

/**
 * Thrown by UserTokenProvider when the device-code sign-in is waiting on the human. Carries
 * the verification URL + user code so the MCP layer can hand them to the agent as a problem.
 */
export class DeviceCodeSignInRequiredError extends Error {
    constructor(
        readonly connection: string,
        readonly verificationUri: string,
        readonly userCode: string,
    ) {
        super(
            `Connection "${connection}": sign in at ${verificationUri} with code ${userCode}, ` +
                'then retry the call.',
        );
        this.name = 'DeviceCodeSignInRequiredError';
    }
}

/** The slice of DeviceCodeCredential the provider uses — a seam for tests. */
export interface DeviceCodeCredentialLike {
    getToken(scope: string): Promise<{ token: string } | null>;
}

export interface DeviceCodePrompt {
    verificationUri: string;
    userCode: string;
}

export interface UserTokenProviderOptions {
    /** Build the credential; the default lazily imports @azure/identity's DeviceCodeCredential. */
    createCredential?: (onPrompt: (info: DeviceCodePrompt) => void) => Promise<DeviceCodeCredentialLike>;
    /** How long one getToken waits for a token (or the sign-in prompt) before returning. */
    waitMs?: number;
}

/** Default wait: long enough for MSAL to deliver the prompt or a cached/refreshed token. */
const DEVICE_CODE_WAIT_MS = 10_000;

/** One device-code acquisition, shared by every getToken while it runs. */
interface DeviceCodeFlow {
    token: Promise<string>;
    /** Resolves when the prompt (URL + code) arrives; never rejects. */
    prompted: Promise<void>;
    prompt: DeviceCodePrompt | undefined;
}

/**
 * device_code — delegated user identity via @azure/identity's DeviceCodeCredential.
 * No client secret (public-client flow): tenantId + clientId only.
 *
 * The @azure/identity package is imported LAZILY (dynamic import on the first token
 * fetch) so a client_credentials-only deployment never loads it. A tool call NEVER blocks on
 * the human: getToken waits at most `waitMs` — if a token arrives (MSAL cache, or the user
 * already signed in) it is returned; if the flow is instead waiting on sign-in, getToken
 * throws DeviceCodeSignInRequiredError carrying the URL + code (also written to STDERR, since
 * stdout is the MCP protocol channel). The flow keeps polling in the background, so the next
 * call picks up the token once the user has signed in. MSAL keeps the token cached and
 * refreshes it silently; with persistTokenCache (the default) the cache and account record
 * outlive the process (see defaultDeviceCodeCredential), otherwise a restart means signing in
 * again.
 */
export class UserTokenProvider implements TokenSource {
    private credential: DeviceCodeCredentialLike | null = null;
    private flow: DeviceCodeFlow | null = null;
    /**
     * A flow that failed after its caller already got the sign-in problem (the human signed in,
     * then Entra refused the token). Reported once by the next call — otherwise that call would
     * silently start a new flow and the user would see only a fresh code, round after round.
     */
    private unreported: Error | null = null;
    /** Where the credential's prompt callback reports to — the flow currently running. */
    private onPrompt: (info: DeviceCodePrompt) => void = () => {};
    private readonly waitMs: number;

    constructor(
        private readonly spec: ConnectionSpec,
        private readonly options: UserTokenProviderOptions = {},
    ) {
        this.waitMs = options.waitMs ?? DEVICE_CODE_WAIT_MS;
    }

    async getToken(): Promise<string> {
        // Coalesce: every caller shares the one in-flight flow (two parallel FIRST calls would
        // otherwise each trigger a sign-in prompt). Once signed in, MSAL's in-memory cache
        // makes each new flow resolve at once.
        if (!this.flow && this.unreported) {
            const failure = this.unreported;
            this.unreported = null;
            throw new Error(`Connection "${this.spec.name}": device-code sign-in failed: ${failure.message}`, {
                cause: failure,
            });
        }
        const flow = this.flow ?? this.startFlow();
        // First caller: stop waiting as soon as the prompt shows (the human is needed). A later
        // caller, with the prompt already surfaced, waits the window for the token — the user
        // may just have signed in and the credential's next poll delivers it.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const window = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.waitMs);
        });
        try {
            const outcome = await Promise.race([
                flow.token.then((token) => ({ token })),
                (flow.prompt ? window : Promise.race([flow.prompted, window])).then(() => null),
            ]);
            if (outcome) return outcome.token;
        } catch (e) {
            // This caller receives the failure itself, so it is no longer unreported.
            if (this.unreported === e) this.unreported = null;
            throw e;
        } finally {
            clearTimeout(timer);
        }
        if (flow.prompt) {
            throw new DeviceCodeSignInRequiredError(this.spec.name, flow.prompt.verificationUri, flow.prompt.userCode);
        }
        throw new Error(
            `Connection "${this.spec.name}": device-code sign-in did not start within ` +
                `${this.waitMs / 1000}s (no token and no sign-in prompt yet). It keeps running in ` +
                'the background — retry the call shortly.',
        );
    }

    private startFlow(): DeviceCodeFlow {
        let signalPrompt: () => void = () => {};
        const flow: DeviceCodeFlow = {
            token: Promise.resolve(''),
            prompted: new Promise<void>((resolve) => {
                signalPrompt = resolve;
            }),
            prompt: undefined,
        };
        this.onPrompt = (info) => {
            flow.prompt = info;
            process.stderr.write(
                `\n[wicket:${this.spec.name}] Sign in: ${info.verificationUri} code: ${info.userCode}\n\n`,
            );
            signalPrompt();
        };
        flow.token = this.acquire().finally(() => {
            // Settled either way: the next call starts a fresh flow (a cached token resolves at
            // once; an expired/declined code prompts anew).
            if (this.flow === flow) this.flow = null;
        });
        // Nobody may be awaiting when the flow settles (the caller already got the sign-in
        // problem); a rejection must not surface as an unhandled one. Keep it for the next call,
        // which clears it if it is in fact awaiting (see getToken's catch).
        flow.token.catch((e: unknown) => {
            const failure = e instanceof Error ? e : new Error(String(e));
            this.unreported = failure;
            process.stderr.write(`\n[wicket:${this.spec.name}] Sign-in failed: ${failure.message}\n\n`);
        });
        this.flow = flow;
        return flow;
    }

    private async acquire(): Promise<string> {
        if (!this.credential) {
            const create = this.options.createCredential ?? defaultDeviceCodeCredential(this.spec);
            this.credential = await create((info) => this.onPrompt(info));
        }
        const token = await this.credential.getToken(DELEGATED_SCOPE);
        if (!token) {
            throw new Error(
                `Connection "${this.spec.name}": device-code auth returned no token.`,
            );
        }
        return token.token;
    }
}

function defaultDeviceCodeCredential(
    spec: ConnectionSpec,
): (onPrompt: (info: DeviceCodePrompt) => void) => Promise<DeviceCodeCredentialLike> {
    return async (onPrompt) => {
        const identity = await import('@azure/identity');
        const persist = spec.persistTokenCache && (await enableTokenCachePersistence(identity.useIdentityPlugin));
        const recordFile = authRecordPath(spec.name);
        let record = persist ? readAuthRecord(recordFile, spec, identity.deserializeAuthenticationRecord) : undefined;
        const credential = new identity.DeviceCodeCredential({
            tenantId: spec.tenantId,
            clientId: spec.clientId,
            userPromptCallback: (info) => onPrompt({ verificationUri: info.verificationUri, userCode: info.userCode }),
            ...(persist ? { tokenCachePersistenceOptions: { enabled: true, name: TOKEN_CACHE_NAME } } : {}),
            ...(record ? { authenticationRecord: record } : {}),
        });
        if (!persist) return credential;
        return {
            async getToken(scope: string) {
                // Without a record the persisted cache cannot be matched to an account, so the
                // first sign-in goes through authenticate(), whose record is saved for later starts.
                if (!record) {
                    const fresh = await credential.authenticate(scope);
                    if (fresh) {
                        record = fresh;
                        writeAuthRecord(recordFile, identity.serializeAuthenticationRecord(fresh));
                    }
                }
                return credential.getToken(scope);
            },
        };
    };
}

/**
 * Names the cache's change-tracking file (~/.IdentityService/<name>). On macOS the tokens themselves
 * sit in ONE keychain entry (Microsoft.Developer.IdentityService / MSALCache) whatever the name;
 * MSAL keys entries per tenant/client/account.
 */
const TOKEN_CACHE_NAME = 'wicket-mcp';

let persistencePlugin: Promise<boolean> | undefined;

/**
 * Register @azure/identity-cache-persistence once per process. On failure (package missing, no
 * keychain) warn and fall back to the in-memory cache — sign-in still works, it just does not
 * survive a restart.
 */
function enableTokenCachePersistence(useIdentityPlugin: (plugin: never) => void): Promise<boolean> {
    persistencePlugin ??= import('@azure/identity-cache-persistence')
        .then(({ cachePersistencePlugin }) => {
            useIdentityPlugin(cachePersistencePlugin as never);
            return true;
        })
        .catch((e: unknown) => {
            process.stderr.write(
                `wicket-mcp: persistent token cache unavailable (${e instanceof Error ? e.message : String(e)}); ` +
                    'device-code sign-in will not survive a restart.\n',
            );
            return false;
        });
    return persistencePlugin;
}

/**
 * The saved account record for a connection, or undefined when absent, unreadable, or for a
 * different tenant/client (the connection was re-pointed — sign in afresh).
 */
function readAuthRecord<R extends { tenantId: string; clientId: string }>(
    file: string,
    spec: ConnectionSpec,
    deserialize: (text: string) => R,
): R | undefined {
    if (!existsSync(file)) return undefined;
    try {
        const record = deserialize(readFileSync(file, 'utf8'));
        return record.tenantId === spec.tenantId && record.clientId === spec.clientId ? record : undefined;
    } catch {
        return undefined;
    }
}

function writeAuthRecord(file: string, text: string): void {
    try {
        mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
        writeFileSync(file, text, { mode: 0o600 });
    } catch (e) {
        // Non-fatal: this session is signed in; the next start just prompts again.
        process.stderr.write(
            `wicket-mcp: could not save the sign-in record to ${file} (${e instanceof Error ? e.message : String(e)}).\n`,
        );
    }
}

/**
 * Pick the token source for a connection: delegated-user (device_code) or app identity
 * (client_credentials). device_code carries no secret, so it never calls resolveSecret.
 */
export function makeTokenSource(spec: ConnectionSpec): TokenSource {
    return spec.authMode === 'device_code'
        ? new UserTokenProvider(spec)
        : new AppTokenProvider(spec);
}
