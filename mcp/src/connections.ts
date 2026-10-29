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

import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { storeFor, type SecretStore } from './secretStore.js';

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
    /** Optional list of the company GUIDs this connection may target, its permitted companies (defense in depth). */
    companies: z.array(z.string()).optional(),
    /**
     * "client_credentials" (default) uses a service-principal secret; "device_code" and
     * "browser" sign the running user in (public client, no secret) and call BC with their
     * delegated identity — by a code typed at microsoft.com/devicelogin, or in a browser window.
     */
    authMode: z.enum(['client_credentials', 'device_code', 'browser']).default('client_credentials'),
    /** Required for client_credentials; the delegated modes default to DEFAULT_PUBLIC_CLIENT_ID. */
    clientId: z.string().min(1).optional(),
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
export type ConnectionSpec = Omit<z.infer<typeof ConnectionEntry>, 'clientId'> & {
    clientId: string;
    name: string;
    origin?: string;
};

/**
 * The client a delegated connection signs in through when it names none: a Microsoft first-party
 * public client that Business Central already trusts in every tenant, so no app registration is needed.
 */
export const DEFAULT_PUBLIC_CLIENT_ID = '1950a258-227b-4e31-a9cf-717495945fc2';

/** True for the modes that sign a person in (no secret). */
export function isDelegated(authMode: ConnectionSpec['authMode']): authMode is 'device_code' | 'browser' {
    return authMode === 'device_code' || authMode === 'browser';
}

// Entries are validated one by one (ConnectionEntry), so one bad entry is set aside rather than
// taking every connection down with it.
const ConnectionsFile = z.object({
    default: z.string().optional(),
    connections: z.record(z.unknown()),
}).strict();

const CONNECTION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Object-prototype keys: as a key of the connections object they would read or set the prototype. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

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
            `Connection "${spec.name}": companyId ${spec.companyId} is not among this connection's ` +
                `permitted companies (${spec.companies.join(', ')}).`,
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

    if (isDelegated(spec.authMode)) {
        if (hasAnySource || spec.keychainService || spec.keychainAccount) {
            process.stderr.write(
                `wicket-mcp: connection "${spec.name}" uses ${spec.authMode} — its configured ` +
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

function errorText(err: unknown): string {
    if (err instanceof z.ZodError) {
        return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    }
    return err instanceof Error ? err.message : String(err);
}

/** Validate one connections.json entry. Throws with a message naming the entry's path. */
/** Throw when `name` cannot name a connection. */
export function assertConnectionName(name: string): void {
    if (!CONNECTION_NAME_RE.test(name)) {
        throw new Error(`Connection name "${name}" is invalid (use [A-Za-z0-9._-], <=64 chars).`);
    }
    if (RESERVED_NAMES.has(name)) {
        throw new Error(`Connection name "${name}" is invalid (a reserved word; choose another name).`);
    }
}

export function validateConnectionEntry(name: string, raw: unknown): ConnectionSpec {
    assertConnectionName(name);
    const result = ConnectionEntry.safeParse(raw);
    if (!result.success) {
        throw new Error(
            result.error.issues.map((i) => `${['connections', name, ...i.path].join('.')}: ${i.message}`).join('; '),
        );
    }
    const entry = result.data;
    if (!entry.clientId && !isDelegated(entry.authMode)) {
        throw new Error(`connections.${name}.clientId: required for client_credentials`);
    }
    const spec: ConnectionSpec = { ...entry, clientId: entry.clientId ?? DEFAULT_PUBLIC_CLIENT_ID, name };
    assertCompanyAllowed(spec);
    assertSecretSource(spec);
    return spec;
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

/** Why the registry has no usable default: nothing configured, an unreadable file, or a default naming nothing. */
export interface RegistryProblem {
    kind: 'missing' | 'invalid' | 'dangling-default';
    file: string;
    message: string;
}

/** A configured connection that failed validation: set aside, never reachable. */
export interface RejectedConnection {
    name: string;
    source: 'file' | 'env';
    message: string;
}

const SETUP_HINT = 'Run /wicket:setup (or call the wicket_setup tool).';

/** No connection to route a call to: nothing configured, a rejected entry, or no default. */
export class ConnectionUnavailableError extends Error {
    constructor(reason: string) {
        super(`${reason} ${SETUP_HINT}`);
        this.name = 'ConnectionUnavailableError';
    }
}

export class ConnectionRegistry {
    private specs = new Map<string, ConnectionSpec>();
    private defaultName: string | undefined;
    /** Sticky session selection, set by the wicket_use tool. */
    private selected: string | undefined;
    /** Set when there is nothing to fall back on; reported by wicket_connections and setup. */
    problem: RegistryProblem | undefined;
    rejected: RejectedConnection[] = [];
    /** Names whose loaded spec came from the BC_* variables, which setup cannot edit. */
    private fromEnv = new Set<string>();

    /**
     * Never throws: a missing or unreadable file, or a bad entry, is recorded (problem / rejected)
     * and the server starts with what did load, so setup can repair it from the chat.
     */
    static load(): ConnectionRegistry {
        const reg = new ConnectionRegistry();
        reg.reload();
        return reg;
    }

    /** Re-read the env vars and the file in place. The session selection survives if it still loads. */
    reload(): void {
        const specs = new Map<string, ConnectionSpec>();
        const rejected: RejectedConnection[] = [];
        let defaultName: string | undefined;
        let problem: RegistryProblem | undefined;
        const file = connectionsFile();

        // 1. Implicit "default" from env vars (back-compat with single-connection setups).
        // A malformed env default is set aside only if connections.json does not define its
        // own "default" (below).
        let envRejection: RejectedConnection | undefined;
        let envLoaded = false;
        const t = process.env.BC_TENANT_ID?.trim();
        const e = process.env.BC_ENVIRONMENT?.trim();
        const co = process.env.BC_COMPANY_ID?.trim();
        const c = process.env.BC_CLIENT_ID?.trim();
        if (t && e && co && c) {
            try {
                specs.set('default', envDefaultSpec(t, e, co, c));
                defaultName = 'default';
                envLoaded = true;
            } catch (err) {
                envRejection = { name: 'default', source: 'env', message: errorText(err) };
            }
        }

        // 2. connections.json (overrides env on name collision).
        let declaredDefault: string | undefined;
        if (existsSync(file)) {
            let parsed: z.infer<typeof ConnectionsFile> | undefined;
            try {
                parsed = ConnectionsFile.parse(JSON.parse(readFileSync(file, 'utf8')));
            } catch (err) {
                // A JSON syntax error quotes the text around it, which could be an inline secret.
                const reason = err instanceof SyntaxError ? 'it is not valid JSON' : errorText(err);
                problem = { kind: 'invalid', file, message: `Failed to load ${file}: ${reason}` };
            }
            let inlineSecret = false;
            for (const [name, raw] of Object.entries(parsed?.connections ?? {})) {
                try {
                    const spec = validateConnectionEntry(name, raw);
                    specs.set(name, spec);
                    inlineSecret ||= Boolean(spec.clientSecret);
                    if (name === 'default') {
                        envRejection = undefined;
                        envLoaded = false;
                    }
                } catch (err) {
                    specs.delete(name);
                    rejected.push({ name, source: 'file', message: errorText(err) });
                }
            }
            // Best-effort hygiene: a connections.json that carries an INLINE secret
            // should not be readable by group/other. Warn once; never fail the load.
            if (inlineSecret) {
                try {
                    // Windows has no POSIX modes (every file reads as 0o666): nothing to hint there.
                    if (process.platform !== 'win32' && statSync(file).mode & 0o077) {
                        process.stderr.write(
                            `wicket-mcp: ${file} contains an inline clientSecret and is ` +
                                `group/other-readable — consider: chmod 600 ${file}\n`,
                        );
                    }
                } catch {
                    /* best-effort only */
                }
            }
            declaredDefault = parsed?.default;
        }
        if (envRejection) rejected.unshift(envRejection);

        // An explicitly declared default MUST name a loaded connection. It never falls back to
        // another one: every call without an override (writes included) would land on a
        // connection nobody chose.
        if (declaredDefault !== undefined) {
            defaultName = specs.has(declaredDefault) ? declaredDefault : undefined;
            if (!defaultName && !problem) {
                problem = {
                    kind: 'dangling-default',
                    file,
                    message:
                        `connections.json declares default "${declaredDefault}", which is not a ` +
                        `usable connection. Available: ${[...specs.keys()].join(', ') || '(none)'}.`,
                };
            }
        } else if (!defaultName) {
            // Implicit fallback ONLY when no default was declared anywhere.
            defaultName = specs.keys().next().value;
        }
        if (specs.size === 0 && rejected.length === 0 && !problem) {
            problem = { kind: 'missing', file, message: `No Business Central connection is configured (${file}).` };
        }

        // Keep the previous object for an entry that did not change: the client pool keys on it, so
        // its client, cached token and any sign-in in progress survive an unrelated save.
        for (const [name, spec] of specs) {
            const previous = this.specs.get(name);
            if (previous && JSON.stringify(previous) === JSON.stringify(spec)) specs.set(name, previous);
        }
        this.specs = specs;
        this.fromEnv = new Set(envLoaded ? ['default'] : []);
        this.rejected = rejected;
        this.problem = problem;
        this.defaultName = defaultName;
        if (this.selected !== undefined && !specs.has(this.selected)) this.selected = undefined;
    }

    /** Resolution ladder: per-call override -> session selection -> default. */
    resolve(override?: string): ConnectionSpec {
        const name = override ?? this.selected ?? this.defaultName;
        if (name === undefined) throw new ConnectionUnavailableError(this.unavailableReason());
        const spec = this.specs.get(name);
        if (!spec) {
            const rejection = this.rejected.find((r) => r.name === name);
            if (rejection) {
                throw new ConnectionUnavailableError(`Connection "${name}" is set aside: ${rejection.message}.`);
            }
            throw new Error(
                `Unknown connection "${name}". Available: ${[...this.specs.keys()].join(', ')}. ` +
                    'Use wicket_connections to list them.',
            );
        }
        return spec;
    }

    /** Where a loaded connection came from; undefined when no connection has that name. */
    sourceOf(name: string): 'file' | 'env' | undefined {
        if (!this.specs.has(name)) return undefined;
        return this.fromEnv.has(name) ? 'env' : 'file';
    }

    private unavailableReason(): string {
        if (this.problem?.kind === 'missing') return 'No Business Central connection is configured.';
        if (this.problem) return `${this.problem.message}`;
        if (this.specs.size === 0) {
            return `No usable connection: ${this.rejected.map((r) => `"${r.name}" (${r.message})`).join('; ')}.`;
        }
        return 'No default connection: pass `connection` on the call.';
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

    current(): { name: string | undefined; isSessionSelection: boolean } {
        return {
            name: this.selected ?? this.defaultName,
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
 * Test seam: the system's secret store (see secretStore.ts): the Keychain on macOS, a DPAPI-protected
 * file on Windows. Each call picks the platform's store, so a test can replace one method.
 */
export const keychain = {
    kind: (): SecretStore['kind'] => storeFor(process.platform).kind,
    find: (service: string, account: string): Promise<string> => storeFor(process.platform).find(service, account),
    store: (service: string, account: string, secret: string): Promise<void> =>
        storeFor(process.platform).store(service, account, secret),
    remove: (service: string, account: string): Promise<void> => storeFor(process.platform).remove(service, account),
};

/** Specs already warned about an inline clientSecret — the warning is once per connection. */
const inlineSecretWarned = new WeakSet<ConnectionSpec>();

export async function resolveSecret(spec: ConnectionSpec): Promise<string> {
    if (spec.keychainService && spec.keychainAccount) {
        try {
            return await keychain.find(spec.keychainService, spec.keychainAccount);
        } catch (err) {
            // The store's own reason (an invalid name, a refused Keychain) beats a guess; never the secret.
            const reason = err instanceof Error && /invalid|refused|denied/i.test(err.message) ? ` ${err.message}` : '';
            throw new Error(
                `Connection "${spec.name}": no client secret found in the system's secret store ` +
                    `(service=${spec.keychainService}, account=${spec.keychainAccount}).${reason} ` +
                    'Store it again with /wicket:setup (Fix), or the wicket_setup action secretPage.',
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
    /** True once this source holds a delegated sign-in; lets a health check skip the saved-record probe. */
    signedIn?(): boolean;
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

/** What the person must do to sign in: enter a code at a URL, or finish in the browser window that opened. */
export type SignInPrompt =
    | { kind: 'device_code'; verificationUri: string; userCode: string }
    | { kind: 'browser' };

/**
 * Thrown by UserTokenProvider when a delegated sign-in is waiting on the human. Carries the prompt
 * so the MCP layer can hand it to the agent as a problem.
 */
export class SignInRequiredError extends Error {
    constructor(
        readonly connection: string,
        readonly prompt: SignInPrompt,
    ) {
        super(
            prompt.kind === 'device_code'
                ? `Connection "${connection}": sign in at ${prompt.verificationUri} with code ${prompt.userCode}, ` +
                      'then retry the call.'
                : `Connection "${connection}": finish signing in in the browser window that opened, then retry the call.`,
        );
        this.name = 'SignInRequiredError';
    }
}

/** A silent-only credential found that the person must sign in again (no prompt was started). */
export class SignInNeededError extends Error {
    constructor(connection: string) {
        super(`Connection "${connection}": the saved sign-in is missing or expired; sign in again.`);
        this.name = 'SignInNeededError';
    }
}

/** The slice of a delegated credential the provider uses — a seam for tests. */
export interface DeviceCodeCredentialLike {
    getToken(scope: string, options?: { abortSignal?: AbortSignal }): Promise<{ token: string } | null>;
}

export interface UserTokenProviderOptions {
    /** Build the credential; the default lazily imports @azure/identity (see createDelegatedCredential). */
    createCredential?: (onPrompt: (info: SignInPrompt) => void) => Promise<DeviceCodeCredentialLike>;
    /** How long one getToken waits for a token (or the sign-in prompt) before returning. */
    waitMs?: number;
}

/** Default wait: long enough for MSAL to deliver the prompt or a cached/refreshed token. */
const DEVICE_CODE_WAIT_MS = 10_000;

/** One sign-in acquisition, shared by every getToken while it runs. */
interface DeviceCodeFlow {
    token: Promise<string>;
    /** Resolves when the prompt (URL + code, or the browser opening) arrives; never rejects. */
    prompted: Promise<void>;
    prompt: SignInPrompt | undefined;
}

/**
 * device_code and browser — delegated user identity via @azure/identity's DeviceCodeCredential or
 * InteractiveBrowserCredential. No client secret (public-client flow): tenantId + clientId only.
 *
 * The @azure/identity package is imported LAZILY (dynamic import on the first token
 * fetch) so a client_credentials-only deployment never loads it. A tool call NEVER blocks on
 * the human: getToken waits at most `waitMs` — if a token arrives (MSAL cache, or the user
 * already signed in) it is returned; if the flow is instead waiting on sign-in, getToken
 * throws SignInRequiredError carrying the prompt (also written to STDERR, since
 * stdout is the MCP protocol channel). The flow keeps polling in the background, so the next
 * call picks up the token once the user has signed in. MSAL keeps the token cached and
 * refreshes it silently; with persistTokenCache (the default) the cache and account record
 * outlive the process (see createDelegatedCredential), otherwise a restart means signing in
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
    private onPrompt: (info: SignInPrompt) => void = () => {};
    private readonly waitMs: number;
    private hasToken = false;

    constructor(
        private readonly spec: ConnectionSpec,
        private readonly options: UserTokenProviderOptions = {},
    ) {
        this.waitMs = options.waitMs ?? DEVICE_CODE_WAIT_MS;
    }

    private get label(): string {
        return this.spec.authMode === 'browser' ? 'browser' : 'device-code';
    }

    signedIn(): boolean {
        return this.hasToken;
    }

    async getToken(): Promise<string> {
        // Coalesce: every caller shares the one in-flight flow (two parallel FIRST calls would
        // otherwise each trigger a sign-in prompt). Once signed in, MSAL's in-memory cache
        // makes each new flow resolve at once.
        if (!this.flow && this.unreported) {
            const failure = this.unreported;
            this.unreported = null;
            throw new Error(`Connection "${this.spec.name}": ${this.label} sign-in failed: ${failure.message}`, {
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
        if (flow.prompt) throw new SignInRequiredError(this.spec.name, flow.prompt);
        throw new Error(
            `Connection "${this.spec.name}": ${this.label} sign-in did not start within ` +
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
                info.kind === 'device_code'
                    ? `\n[wicket:${this.spec.name}] Sign in: ${info.verificationUri} code: ${info.userCode}\n\n`
                    : `\n[wicket:${this.spec.name}] Sign in: a browser window opened — finish signing in there.\n\n`,
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
            const create =
                this.options.createCredential ??
                ((onPrompt) => createDelegatedCredential(this.spec as DelegatedTarget, onPrompt));
            this.credential = await create((info) => this.onPrompt(info));
        }
        const token = await this.credential.getToken(DELEGATED_SCOPE);
        if (!token) {
            throw new Error(
                `Connection "${this.spec.name}": ${this.label} auth returned no token.`,
            );
        }
        this.hasToken = true;
        return token.token;
    }
}

/** What a delegated credential needs: a connection, or the setup session before it has a name. */
export interface DelegatedTarget {
    name: string;
    tenantId: string;
    clientId: string;
    authMode: 'browser' | 'device_code';
    persistTokenCache: boolean;
}

export interface DelegatedCredential extends DeviceCodeCredentialLike {
    /** The signed-in account, serialized for authRecordPath — undefined until someone signed in. */
    authenticationRecord(): string | undefined;
}

type IdentityModule = typeof import('@azure/identity');

/**
 * A delegated credential that never signs in behind the caller's back: getToken first tries the
 * cache silently (the saved account record + MSAL's cache); only when that needs a person does it
 * report the prompt and sign in — device code (URL + code through onPrompt) or a browser window.
 * `silentOnly` stops there with SignInNeededError instead, for health checks. With persistence
 * the account record is saved to authRecordPath(target.name), so the next start is silent.
 */
export async function createDelegatedCredential(
    target: DelegatedTarget,
    onPrompt: (info: SignInPrompt) => void,
    opts: { silentOnly?: boolean; identity?: IdentityModule } = {},
): Promise<DelegatedCredential> {
    const identity = opts.identity ?? (await import('@azure/identity'));
    const persist = target.persistTokenCache && (await enableTokenCachePersistence(identity.useIdentityPlugin));
    const recordFile = authRecordPath(target.name);
    let record = persist ? readAuthRecord(recordFile, target, identity.deserializeAuthenticationRecord) : undefined;
    const common = {
        tenantId: target.tenantId,
        clientId: target.clientId,
        disableAutomaticAuthentication: true,
        ...(persist ? { tokenCachePersistenceOptions: { enabled: true, name: TOKEN_CACHE_NAME } } : {}),
        ...(record ? { authenticationRecord: record } : {}),
    };
    const credential =
        target.authMode === 'browser'
            ? new identity.InteractiveBrowserCredential({ ...common, redirectUri: 'http://localhost' })
            : new identity.DeviceCodeCredential({
                  ...common,
                  userPromptCallback: (info) =>
                      onPrompt({ kind: 'device_code', verificationUri: info.verificationUri, userCode: info.userCode }),
              });
    const needsPerson = (e: unknown) => e instanceof Error && e.name === 'AuthenticationRequiredError';
    return {
        async getToken(scope: string, options: { abortSignal?: AbortSignal } = {}) {
            if (record) {
                try {
                    return await credential.getToken(scope, options);
                } catch (e) {
                    if (!needsPerson(e)) throw e;
                }
            }
            if (opts.silentOnly) throw new SignInNeededError(target.name);
            if (target.authMode === 'browser') onPrompt({ kind: 'browser' });
            const fresh = await credential.authenticate(scope, options);
            if (fresh) {
                record = fresh;
                if (persist) writeAuthRecord(recordFile, identity.serializeAuthenticationRecord(fresh));
            }
            return credential.getToken(scope, options);
        },
        authenticationRecord: () => (record ? identity.serializeAuthenticationRecord(record) : undefined),
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
    spec: { tenantId: string; clientId: string },
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

export function writeAuthRecord(file: string, text: string): void {
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
    return isDelegated(spec.authMode)
        ? new UserTokenProvider(spec)
        : new AppTokenProvider(spec);
}
