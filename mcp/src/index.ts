#!/usr/bin/env bun
/**
 * Wicket MCP server.
 *
 * Fronts the Wicket API page (a Business Central AL extension) so any
 * MCP-capable agent gets the Wicket operations as native tools:
 *
 *   discover, describe, query, readBlob, insert, modify, delete, invoke,
 *   action, capabilities, status, cancel, requests, pageUrl, whoAmI
 *
 * A query can also be delivered asynchronously to Azure Blob storage through the
 * separate wicket_query_deliver tool (see deliverSchema) — split from wicket_query so the
 * read tool's readOnly annotation stays true; status/cancel/requests track those requests.
 *
 * Transport contract (mirrors the AL side, see app/src/api/BcmagRpcEndpoint.Page.al):
 *   - Bound action over OData, ALWAYS HTTP 200.
 *   - POST {baseUrl}/api/wicket/rpc/v1.0/companies({companyId})/wicketEndpoint(0)/Microsoft.NAV.{operation}
 *   - Body is the envelope { id, issuedAt, origin, data }.
 *   - OData wraps the returned object under "value"; we read response.value.
 *   - If response.value has string "type", string "title" AND numeric "status"
 *     (the members the AL problem builder always emits), it's an RFC 7807 problem
 *     ({type,title,status,detail,instance,operation,suggest?}) — we surface it as
 *     an MCP tool error so the agent sees detail+suggest. Otherwise it's the result.
 *
 * Auth: OAuth2 client_credentials against Entra ID, scope
 *   https://api.businesscentral.dynamics.com/.default. Token cached until expiry.
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
    ConnectionRegistry,
    ConnectionUnavailableError,
    SignInRequiredError,
    authRecordPath,
    connectionsFile,
    createDelegatedCredential,
    validateConnectionEntry,
    writeAuthRecord,
    isTimeoutError,
    makeTokenSource,
    type ConnectionSpec,
    type TokenSource,
} from './connections.js';
import {
    ApiCatalogCache,
    asApiDescription,
    filterEntries,
    isRefusal,
    planApiRead,
    summarizeGroups,
} from './apiCatalog.js';
import {
    DescribeCache,
    MAP_MAX_BYTES,
    TenantMapError,
    currentStructureVersion,
    readMap,
    removeSection,
    summarizeDescribe,
    upsertSection,
} from './schemaKnowledge.js';
import { findSkillSection, instructionsFrom, loadSkillDoc, renderSkillToc } from './skill.js';
import { moveAsideBroken, removeConnection, setDefaultConnection, upsertConnection } from './connectionsFile.js';
import {
    SETUP_SESSION_NAME,
    SetupSession,
    checkHealth,
    explainAuthError,
    explainListError,
    listCompanies,
    listEnvironments,
    locate,
} from './setup.js';

export { bundleSkill, findSkillSection, instructionsFrom, loadSkillDoc, parseSkillDoc, renderSkillToc, skillFiles } from './skill.js';

// ---------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------

/** Bumped with the package version; stamped into the envelope origin. */
export const SERVER_VERSION = '2.4.0';

/** Cap on one RPC POST — a hung gateway must not block a tool call forever. */
export const RPC_TIMEOUT_MS = 120_000;

/**
 * Operations a `readOnly` connection refuses client-side. Mirrors the dispatcher's IsMutating
 * list on the AL side (invoke/action count as mutating because a wrapper can write). Like the
 * AL IsMutatingRequest, an `action` that runs inside Wicket's forced rollback — a preview, or a
 * verb whose capabilities entry says `mutating: false` — is let through: its writes are rolled back.
 */
export const MUTATING_OPERATIONS: ReadonlySet<string> = new Set(['insert', 'modify', 'delete', 'invoke', 'action']);

/**
 * Read operations that honour a per-request `"unmask": false` (field masking). The single
 * injection point is WicketClient.call, so every tool path (query, query_all, query_deliver,
 * read_blob, describe, wicket_api_read's describe pre-check) sees the same verdict. Writes need
 * no flag: the server recognises a mask echo whatever verdict the write runs under.
 */
export const UNMASK_AWARE_OPERATIONS: ReadonlySet<string> = new Set(['query', 'readBlob', 'describe']);

/**
 * MCP tool annotations. Hosts (Claude Code, Claude Desktop) use these to decide what to
 * auto-approve and what to confirm: a read-only tool can run unprompted, a destructive one
 * should not. They are hints, not enforcement — the enforcement is the readOnly connection
 * guard and Wicket's own deny-by-default gates.
 */
const READ_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const DELETE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const RUN_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const CANCEL_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SESSION_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Async delivery creates a request row, uploads a package to Azure Blob storage and hands back a
// shareable link — not read-only, and open-world (it reaches storage outside BC). idempotentHint
// stays false: only a caller-supplied idempotencyKey dedupes a resubmit.
/** Setup reaches Entra and Business Central's own APIs, edits connections.json, and can remove a connection. */
const SETUP_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const DELIVER_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

/** Synthetic (MCP-generated) problem types. BC's own problems use the same base URL. */
const PROBLEM_BASE = 'https://wicket.example/errors/';

// ---------------------------------------------------------------------------
// RFC 7807 problem + Wicket client
// ---------------------------------------------------------------------------

export interface Rfc7807Problem {
    type: string;
    title: string;
    status: number;
    detail?: string;
    instance?: string;
    operation?: string;
    suggest?: unknown;
    [k: string]: unknown;
}

/**
 * An RFC 7807 problem document per the Wicket transport contract. The AL side
 * (Bcmag Problem codeunit: Build / NewFailureSuggest) ALWAYS emits string `type`,
 * string `title` and integer `status` — so we require all three, not just
 * type+status: a business result that happens to carry {type:"shipment", status:2}
 * must NOT be misclassified as a problem.
 */
export function isProblem(value: unknown): value is Rfc7807Problem {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.type === 'string' &&
        typeof v.title === 'string' &&
        typeof v.status === 'number'
    );
}

/** Thrown when the Wicket endpoint returns an RFC 7807 problem document. */
export class WicketProblemError extends Error {
    constructor(public readonly problem: Rfc7807Problem) {
        super(
            `Wicket ${problem.operation ?? 'operation'} failed ` +
                `(${problem.status} ${problem.title ?? problem.type}): ` +
                `${problem.detail ?? ''}`.trim(),
        );
        this.name = 'WicketProblemError';
    }
}

export class WicketClient {
    private readonly tokens: TokenSource;
    private readonly baseUrl: string;
    private readonly origin: string;
    private readonly companyId: string;

    /** `tokens` is a test seam; production always derives the source from the spec. */
    constructor(
        private readonly spec: ConnectionSpec,
        tokens?: TokenSource,
    ) {
        this.tokens = tokens ?? makeTokenSource(spec);
        // Default to the SaaS Online host derived from tenant + environment.
        this.baseUrl = (
            spec.baseUrl ??
            `https://api.businesscentral.dynamics.com/v2.0/${spec.tenantId}/${spec.environment}`
        ).replace(/\/+$/, '');
        // Stamp the connection name into origin -> visible in the Wicket Operation Log.
        // The implicit env `default` may carry a BC_ORIGIN override (spec.origin); every
        // other connection composes mcp.wicket/<version>+<connection>. The version part
        // (dots) and the validated connection name ([A-Za-z0-9._-] <=64) both sit inside
        // the envelope origin charset [A-Za-z0-9._@/+:-], <=256 chars — so this is safe.
        this.origin = spec.origin ?? `mcp.wicket/${SERVER_VERSION}+${spec.name}`;
        this.companyId = spec.companyId;
    }

    private operationUrl(operation: string): string {
        return (
            `${this.baseUrl}/api/wicket/rpc/v1.0/` +
            `companies(${this.companyId})/wicketEndpoint(0)/Microsoft.NAV.${operation}`
        );
    }

    /**
     * POST the envelope for one operation and unwrap response.value.
     *
     * Wire shape (proven against a BC 28 SaaS sandbox): request body `{"envelope":"<envelope JSON as
     * a string>"}`, response `{"@odata.context":…,"value":"<result JSON as a string>"}`.
     * Throws WicketProblemError when value is an RFC 7807 problem.
     *
     * `idempotencyKey` is an optional caller-supplied token placed on the envelope. The AL
     * dispatcher honours it for EVERY operation (insert/modify/delete/invoke/action and a
     * query deliver submit are where it matters). We never auto-generate it: a retry with the
     * SAME key + same {operation,data} replays the stored result (the response carries
     * "@replayed": true); the same key with a different body yields a 409 idempotency-conflict
     * problem. The server reserves the key before executing, so a key runs at most once: a
     * resend while the first request is in flight is 409 idempotency-in-progress, and an
     * unknowable earlier outcome is 409 idempotency-indeterminate (never re-run).
     *
     * A 401 from BC is retried ONCE with a freshly minted token (when the token source can
     * invalidate its cache): the gateway rejected the request before the handler ran, so the
     * resend cannot double-execute anything.
     */
    async call(
        operation: string,
        data: Record<string, unknown>,
        idempotencyKey?: string,
    ): Promise<unknown> {
        // Client-side write guard: a readOnly connection never sends a mutating operation to BC at
        // all. Evaluated before any token is minted, except for a non-preview action, whose verb is
        // looked up in capabilities first.
        if (this.spec.readOnly && MUTATING_OPERATIONS.has(operation) && !(await this.runsInRollback(operation, data))) {
            throw new WicketProblemError(this.readOnlyProblem(operation));
        }
        // Opt-out only: a connection saying unmask:false drops this principal's unmask grants for
        // reads. Never sends true, never overrides an explicit value already in data.
        if (this.spec.unmask === false && UNMASK_AWARE_OPERATIONS.has(operation) && !('unmask' in data)) {
            data = { ...data, unmask: false };
        }
        const envelope: Record<string, unknown> = {
            id: randomUUID(),
            issuedAt: new Date().toISOString(),
            origin: this.origin,
            data,
        };
        // Only stamp the key when the caller actually supplied one.
        if (idempotencyKey !== undefined) envelope.idempotencyKey = idempotencyKey;
        const writes = isWriteCall(operation, data);

        const { res, text } = await this.authorizedFetch(
            this.operationUrl(operation),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // BC publishes a bound action only for simple parameter types, so the envelope
                // travels as ONE JSON string in the action's `envelope` parameter, and the result
                // comes back as one JSON string in `value` (parsed below).
                body: JSON.stringify({ envelope: JSON.stringify(envelope) }),
            },
            operation,
            () => this.syntheticTimeoutProblem(operation, writes, idempotencyKey),
        );

        // The bound action always returns 200 with a JSON body. A non-200 here
        // means we never reached the handler (gateway / auth / routing). Surface
        // it as a synthetic problem so the agent gets a structured, actionable error.
        if (!res.ok) {
            const synthetic = this.syntheticTransportProblem(operation, res.status, text, writes, idempotencyKey);
            throw new WicketProblemError(synthetic);
        }

        let body: unknown;
        try {
            body = text === '' ? {} : JSON.parse(text);
        } catch {
            throw new Error(
                `Wicket ${operation} returned non-JSON body (HTTP ${res.status}): ${truncate(text, 500)}`,
            );
        }

        // OData wraps the returned object under "value".
        let value =
            typeof body === 'object' && body !== null && 'value' in body
                ? (body as { value: unknown }).value
                : body;
        // Wicket's bound actions return Text, so "value" is the result serialised as a JSON string
        // (Edm.String). Decode it; a value that is already an object passes through unchanged.
        value = liftJsonObjectString(value);

        if (isProblem(value)) {
            throw new WicketProblemError(value);
        }

        // Return the unwrapped op response. Wicket places its annotations (@nextLink, @count,
        // @pagingMode, @requestId) INSIDE this object, not at the OData wrapper level — a query
        // returns { value: [...rows], '@nextLink'?, '@count'?, '@pagingMode'? }. (A previous version
        // returned the raw OData wrapper whenever it carried any '@'-prefixed key, but '@odata.context'
        // is ALWAYS present on a BC action response, so every tool received the wrapper and
        // wicket_query_all never found a top-level @nextLink to follow — it never paginated.)
        return value;
    }

    /**
     * One authorized request: mint (or reuse) the token, send, and on a 401 drop the cached token and
     * resend ONCE — the gateway rejected the request before anything ran, so the resend is safe. A
     * device_code connection that still needs the human surfaces as a sign-in problem, a timeout as the
     * caller's synthetic timeout problem.
     */
    private async authorizedFetch(
        url: string,
        init: { method: string; headers?: Record<string, string>; body?: string },
        operation: string,
        timeoutProblem: () => Rfc7807Problem,
    ): Promise<{ res: Response; text: string }> {
        let res: Response | undefined;
        let text = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            let token: string;
            try {
                token = await this.tokens.getToken();
            } catch (err) {
                // device_code needs the human first: hand the agent the URL + code as a problem.
                if (err instanceof SignInRequiredError) {
                    throw new WicketProblemError(this.signInProblem(operation, err));
                }
                throw err;
            }
            try {
                res = await fetch(url, {
                    method: init.method,
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...init.headers },
                    ...(init.body !== undefined ? { body: init.body } : {}),
                    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
                });
            } catch (err) {
                // Surface a timed-out gateway as a synthetic problem (matching the non-200
                // transport path), not a raw DOMException.
                if (isTimeoutError(err)) throw new WicketProblemError(timeoutProblem());
                throw err;
            }
            text = await res.text();
            // 401 = the gateway refused the token before the handler ran. Drop the cached token
            // and resend once — a revoked/rotated token must not fail every call until expiry.
            if (res.status === 401 && attempt === 0 && this.tokens.invalidate) {
                this.tokens.invalidate();
                continue;
            }
            break;
        }
        // The loop always assigns res before breaking (or throws).
        return { res: res!, text };
    }

    /** The environment this connection reads; the API catalog is per environment, not per company. */
    get environmentKey(): string {
        return this.spec.baseUrl ? this.baseUrl : `${this.spec.tenantId}/${this.spec.environment}`;
    }

    get connectionName(): string {
        return this.spec.name;
    }

    /**
     * What a describe answer depends on: the environment, the company (field policy is per company) and
     * the connection (its principal, and its unmask:false stamp). Keys the per-connection describe cache.
     */
    get cacheKey(): string {
        return `${this.environmentKey}|${this.companyId}|${this.spec.name}`;
    }

    /**
     * GET one of the tenant's own API routes for this connection's company — the API-first read path.
     * `route` is a catalog route ("v2.0/customers", "<publisher>/<group>/<version>/<entitySet>"); each
     * segment must be a plain name, so nothing but a route from BC's own metadata can shape the URL.
     * Returns the OData body ({ value: [...], "@odata.count"? }). A non-200 is a problem carrying BC's
     * own error message.
     */
    async getApi(route: string, params: URLSearchParams): Promise<Record<string, unknown>> {
        const segments = route.split('/');
        if (segments.length < 2 || !segments.every((seg) => /^[A-Za-z0-9._-]+$/.test(seg))) {
            throw new WicketProblemError({
                type: `${PROBLEM_BASE}invalid-route`,
                title: 'Invalid API route',
                status: 400,
                detail: `"${route}" is not an API route from the catalog.`,
                operation: 'apiRead',
            });
        }
        const entitySet = segments.pop()!;
        const query = params.toString();
        const url =
            `${this.baseUrl}/api/${segments.join('/')}/companies(${this.companyId})/${entitySet}` +
            (query ? `?${query}` : '');
        const { res, text } = await this.authorizedFetch(url, { method: 'GET' }, 'apiRead', () => ({
            type: `${PROBLEM_BASE}transport-timeout`,
            title: 'Transport timeout',
            status: 504,
            detail: `BC did not answer the API read of ${route} within ${RPC_TIMEOUT_MS / 1000}s on connection "${this.spec.name}". Nothing was written (this is a read), so it is safe to retry; narrow the filter or top.`,
            operation: 'apiRead',
        }));
        let body: unknown;
        try {
            body = text === '' ? {} : JSON.parse(text);
        } catch {
            body = undefined;
        }
        if (!res.ok) {
            const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
            throw new WicketProblemError({
                type: `${PROBLEM_BASE}api-error`,
                title: `API read failed (HTTP ${res.status})`,
                status: res.status,
                detail: typeof message === 'string' && message !== '' ? message : truncate(text, 600),
                operation: 'apiRead',
                route,
            });
        }
        if (typeof body !== 'object' || body === null) {
            throw new Error(`The API read of ${route} returned a non-JSON body (HTTP ${res.status}): ${truncate(text, 500)}`);
        }
        return body as Record<string, unknown>;
    }

    private syntheticTransportProblem(
        operation: string,
        httpStatus: number,
        rawBody: string,
        writes: boolean,
        idempotencyKey: string | undefined,
    ): Rfc7807Problem {
        // Many BC transport errors (401/403/404 at the OData layer) come back as
        // their own JSON. Try to lift a useful message; otherwise pass the raw body.
        let detail = truncate(rawBody, 600);
        try {
            const parsed = JSON.parse(rawBody);
            const m = parsed?.error?.message ?? parsed?.message;
            if (typeof m === 'string' && m.length > 0) detail = m;
        } catch {
            /* not JSON — keep the raw body */
        }
        // A 5xx from the gateway (502/503/504…) may have been raised AFTER BC ran the handler,
        // so the agent needs to know whether a retry is safe. 4xx never reached execution.
        if (httpStatus >= 500) {
            detail = `${detail} — ${retryGuidance(writes, idempotencyKey)}`;
        }
        return {
            type: `${PROBLEM_BASE}transport`,
            title: `Transport error (HTTP ${httpStatus})`,
            status: httpStatus,
            detail,
            operation,
        };
    }

    /**
     * The AL rule (Bcmag Op Authorizer.RunsInRollback): a preview, or a verb enrolled non-mutating,
     * runs inside the forced rollback. The verb's flag comes from capabilities.actions, the same
     * catalog row the server consults.
     */
    private async runsInRollback(operation: string, data: Record<string, unknown>): Promise<boolean> {
        if (operation !== 'action') return false;
        if (data.preview === true) return true;
        const verb = typeof data.action === 'string' ? data.action.toLowerCase() : '';
        if (verb === '') return false;
        // The operation result is { value: { actions, … }, '@requestId' } on the wire; a bare object is
        // accepted too, as schemaKnowledge does for structureVersion.
        const answer = (await this.call('capabilities', {})) as
            | { value?: { actions?: unknown }; actions?: unknown }
            | undefined;
        const raw = answer?.value?.actions ?? answer?.actions;
        const actions = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
        return actions.some(
            (a) => typeof a.action === 'string' && a.action.toLowerCase() === verb && a.mutating === false,
        );
    }

    private readOnlyProblem(operation: string): Rfc7807Problem {
        return {
            type: `${PROBLEM_BASE}connection-read-only`,
            title: 'Connection is read-only',
            status: 403,
            detail:
                `connection "${this.spec.name}" is configured readOnly in the MCP server, so ` +
                `"${operation}" was refused before reaching Business Central. Target a writable ` +
                'connection for this call (pass connection: "<name>"; list them with wicket_connections), ' +
                'or ask the operator to clear readOnly on this connection.',
            operation,
            suggest: { use: 'wicket_connections' },
        };
    }

    private syntheticTimeoutProblem(
        operation: string,
        writes: boolean,
        idempotencyKey: string | undefined,
    ): Rfc7807Problem {
        const hint = writes
            ? retryGuidance(true, idempotencyKey)
            : `${retryGuidance(false, undefined)} Narrow the query (filter/top), or check the environment.`;
        return {
            type: `${PROBLEM_BASE}transport-timeout`,
            title: 'Transport timeout',
            status: 504,
            detail:
                `BC did not respond within ${RPC_TIMEOUT_MS / 1000}s on connection ` +
                `"${this.spec.name}". The gateway may be down or the operation too slow. ${hint}`,
            operation,
        };
    }

    private signInProblem(operation: string, err: SignInRequiredError): Rfc7807Problem {
        const base = { type: `${PROBLEM_BASE}sign-in-required`, title: 'Sign-in required', status: 401, operation };
        if (err.prompt.kind === 'browser') {
            return {
                ...base,
                detail:
                    `connection "${this.spec.name}" uses browser sign-in: a sign-in window opened in your browser. ` +
                    'Ask the user to finish signing in there, then retry the call. The sign-in keeps running in the ' +
                    'background, so the retry picks up the token.',
            };
        }
        const { verificationUri, userCode } = err.prompt;
        return {
            ...base,
            detail:
                `connection "${this.spec.name}" uses device_code sign-in. Ask the user to open ` +
                `${verificationUri} and enter the code ${userCode}, sign in, then retry the ` +
                'call. The sign-in keeps running in the background, so the retry picks up the token.',
            verificationUri,
            userCode,
        };
    }
}

/**
 * Whether a call can change state in BC: the mutating operations, plus a query carrying a
 * `deliver` block (it enqueues a request row and uploads a package). Drives the outcome
 * guidance on transport failures — not the readOnly guard, which mirrors AL IsMutating.
 */
export function isWriteCall(operation: string, data: Record<string, unknown>): boolean {
    return MUTATING_OPERATIONS.has(operation) || (operation === 'query' && data.deliver !== undefined);
}

/**
 * What an agent should do after a transport failure whose outcome it cannot see. A read is
 * always safe to repeat; a write may already have committed, so only an idempotency key makes
 * the resend safe.
 */
export function retryGuidance(writes: boolean, idempotencyKey: string | undefined): string {
    if (!writes) return 'Nothing was written (this is a read), so it is safe to retry.';
    if (idempotencyKey !== undefined) {
        return (
            'The outcome is UNKNOWN: the write may have committed before the failure. Resend the ' +
            `identical call with the SAME idempotencyKey ("${idempotencyKey}") — it replays the stored ` +
            'result, or answers 409 idempotency-in-progress (wait, resend) or idempotency-indeterminate ' +
            '(query the affected records, then use a NEW key).'
        );
    }
    return (
        'The outcome is UNKNOWN: the write may have committed before the failure. Do NOT blindly ' +
        'retry — query the affected records first to see whether it took effect, and pass an ' +
        'idempotencyKey on writes from now on so a retry is safe.'
    );
}

/** A string holding a JSON object or array becomes that value; anything else is unchanged. */
export function liftJsonObjectString(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const head = value.trimStart()[0];
    if (head !== '{' && head !== '[') return value;
    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null ? parsed : value;
    } catch {
        return value;
    }
}

/**
 * One WicketClient per connection, constructed lazily and cached. Each client owns its
 * own token source, so tokens never cross connections. `get` runs the registry's
 * resolution ladder (per-call override -> session selection -> default).
 */
export class ClientPool {
    private readonly clients = new Map<string, { spec: ConnectionSpec; client: WicketClient }>();
    /** `tokensFor` is a test seam: a token source for a spec, instead of the one its authMode picks. */
    constructor(
        private readonly registry: ConnectionRegistry,
        private readonly tokensFor?: (spec: ConnectionSpec) => TokenSource | undefined,
    ) {}

    get(connectionOverride?: string): WicketClient {
        let spec: ConnectionSpec;
        try {
            spec = this.registry.resolve(connectionOverride);
        } catch (err) {
            if (err instanceof ConnectionUnavailableError) {
                throw new WicketProblemError({
                    type: `${PROBLEM_BASE}connection-unavailable`,
                    title: 'No usable connection',
                    status: 503,
                    detail: err.message,
                });
            }
            throw err;
        }
        // A registry reload replaces the spec object of a changed entry: build a fresh client
        // (and token source) for it rather than keep calling the old tenant with the old token.
        const cached = this.clients.get(spec.name);
        if (cached && cached.spec === spec) return cached.client;
        const client = new WicketClient(spec, this.tokensFor?.(spec));
        this.clients.set(spec.name, { spec, client });
        return client;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function truncate(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Render a successful result as an MCP text content block. */
/** Operations whose calls get a server-minted idempotency key when the agent sends none. */
export const AUTO_KEY_OPERATIONS: ReadonlySet<string> = new Set(['invoke', 'action']);

/** Report a server-minted key next to the result, so a retry of the same call can reuse it. */
export function withGeneratedKey(result: unknown, key: string): unknown {
    const note = { '@idempotencyKey': key, '@idempotencyKeyGenerated': true };
    return result !== null && typeof result === 'object' && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), ...note }
        : { value: result, ...note };
}

export function ok(result: unknown): CallToolResult {
    const text = typeof result === 'string' ? result : renderJson(result);
    return { content: [{ type: 'text', text }] };
}

/**
 * Pretty JSON, except that a `value` array of two or more objects (a page of rows, a discover
 * list, async requests) is rendered one row per line. A page of rows is skimmed or handed to a
 * script, never studied field by field, and the indentation of a thousand rows costs more
 * tokens than the rows themselves. The output stays valid JSON.
 */
export function renderJson(result: unknown): string {
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
        const { value, ...rest } = result as Record<string, unknown>;
        if (Array.isArray(value) && value.length > 1 && value.every((v) => typeof v === 'object' && v !== null)) {
            const rows = value.map((v) => `    ${JSON.stringify(v)}`).join(',\n');
            const restText = JSON.stringify(rest, null, 2);
            const restInner = restText === '{}' ? '' : `,\n${restText.slice(2, -2)}`;
            return `{\n  "value": [\n${rows}\n  ]${restInner}\n}`;
        }
    }
    return JSON.stringify(result, null, 2);
}

/** Render an error (RFC 7807 problem or thrown error) as an MCP tool error. */
export function fail(err: unknown): CallToolResult {
    if (err instanceof WicketProblemError) {
        // Hand the agent the full problem document so it can read detail + suggest.
        return {
            content: [{ type: 'text', text: JSON.stringify(err.problem, null, 2) }],
            isError: true,
        };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Strip undefined keys so we never send `"top": undefined` etc. into the
 * envelope's data object. zod-validated args may contain optional undefineds.
 */
function asObject(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) out[k] = v;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Bundled skill (progressive disclosure) — see ./skill.ts. mcp/skill mirrors skills/wicket-usage
// (`bun run skill:sync`), so an agent learns Wicket from the tool surface alone, one section at a
// time; the skill's essentials section doubles as the server's MCP `instructions`.
// ---------------------------------------------------------------------------

/** Every tool the server registers, in registration order. Asserted by the suite and the skill. */
export const TOOL_NAMES = [
    'wicket_discover',
    'wicket_describe',
    'wicket_query',
    'wicket_query_deliver',
    'wicket_read_blob',
    'wicket_insert',
    'wicket_modify',
    'wicket_delete',
    'wicket_invoke',
    'wicket_action',
    'wicket_capabilities',
    'wicket_page_url',
    'wicket_whoami',
    'wicket_status',
    'wicket_cancel',
    'wicket_requests',
    'wicket_apis',
    'wicket_api_read',
    'wicket_map',
    'wicket_skill',
    'wicket_connections',
    'wicket_use',
    'wicket_query_all',
    'wicket_setup',
] as const;

const skillSchema = {
    mode: z
        .enum(['toc', 'section', 'full'])
        .optional()
        .describe(
            'What to return: "toc" (default) — the guide description plus every file and its section titles ' +
                '(cheapest); "section" — one section or one whole reference file (pass `section`); "full" — the ' +
                'entire guide (large; prefer sections).',
        ),
    section: z
        .string()
        .optional()
        .describe(
            'The section title, or a reference file name such as "filters", "errors", "writes", "presenting", ' +
                '"automation", "tools", "tables", "solutions" or "protocol" for that whole file. Matched case-insensitively ' +
                '(exact, then prefix, then fuzzy). No match → the toc plus a note.',
        ),
};

// ---------------------------------------------------------------------------
// zod schemas — one per operation's `data` payload.
// Shapes mirror the AL operation handlers and the capabilities op.
// ---------------------------------------------------------------------------

const Languages = z
    .array(z.string())
    .optional()
    .describe('Caption language codes, e.g. ["ENU","DEU"]. Defaults to the Wicket setup default.');

// JSON-able values for write/invoke payloads.
const JsonValue: z.ZodType<unknown> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(JsonValue)]),
);
const ValuesObject = z.record(JsonValue);

// Optional caller-supplied idempotency token for write-ish tools (insert/modify/delete/invoke/
// action and wicket_query_deliver — the AL dispatcher honours it on every operation, but only a
// state-changing call needs it). Placed on the envelope, NOT in data. Never auto-generated. A retry with the same key + same
// {operation,data} replays the stored result ("@replayed": true); same key + different body → 409
// idempotency-conflict; same key while the first request is still running → 409
// idempotency-in-progress; earlier outcome unknowable → 409 idempotency-indeterminate (the server
// never re-executes a settled key). Max 128 printable characters (mirrors the AL envelope validation).
const IdempotencyKey = z
    .string()
    .max(128)
    .optional()
    .describe(
        'Optional idempotency token (<=128 printable chars). Provide the SAME key when retrying to ' +
            'safely replay the stored result (response carries "@replayed": true); the same key with a ' +
            'different body returns a 409 idempotency-conflict; while the first request is still running, ' +
            'a 409 idempotency-in-progress (wait and resend); if the earlier outcome is unknowable, a 409 ' +
            'idempotency-indeterminate (query the records, then retry with a NEW key). Omit to skip ' +
            'idempotency semantics.',
    );

// Per-call connection override — the PREFERRED, race-free way to target a specific
// Wicket connection: it names the connection for THIS call only and never mutates
// shared session state (unlike wicket_use). Spread into every BC-touching tool schema
// (via the tool() helper for the operation tools, and explicitly on wicket_query_all).
const ConnectionOverride = {
    connection: z
        .string()
        .optional()
        .describe(
            'Named Wicket connection to use for THIS call only (the preferred, race-free ' +
                'override). Omit to use the connection selected via wicket_use, or the default. ' +
                'List available connections with wicket_connections.',
        ),
};

const discoverSchema = {
    kind: z
        .enum(['tables', 'codeunits', 'companies', 'apis'])
        .describe(
            'What to list: reachable tables, enrolled codeunits, companies, or the tenant\'s API pages and ' +
                'API queries ("apis" — prefer wicket_apis, which caches the catalog).',
        ),
    filter: z
        .string()
        .optional()
        .describe(
            'Plain AL filter (NOT the $filter subset) on Object Caption / company Name, e.g. "*Sales*"; ' +
                'for kind="apis" it filters the entity set name.',
        ),
    publisher: z
        .string()
        .optional()
        .describe(
            'kind="tables"/"codeunits" only: AL filter on the owning app\'s Publisher, e.g. "<>Microsoft" for ' +
                'solution/custom objects or "Contoso*". Objects that belong to no app (platform tables) never match.',
        ),
    top: z.number().int().positive().optional().describe('Max rows (capped at the server Max Top).'),
    tableId: z.number().int().optional().describe('kind="apis" only: just the API pages over this table.'),
    skip: z.number().int().nonnegative().optional().describe('kind="apis" only: rows to skip (follow @nextSkip).'),
    ifNoneMatch: z
        .string()
        .optional()
        .describe('kind="apis" only: a cached catalogVersion; when still current the rows are omitted and notModified is true.'),
    languages: Languages,
};

const describeSchema = {
    kind: z
        .enum(['table', 'codeunit', 'api'])
        .describe('Describe a table, an enrolled codeunit, or one API page/query (its fields and whether Wicket lets you read through it).'),
    tableId: z.number().int().optional().describe('Required when kind="table".'),
    codeunitId: z.number().int().optional().describe('Required when kind="codeunit".'),
    pageId: z.number().int().optional().describe('kind="api": the API page id (from wicket_apis or a table\'s apiRoutes).'),
    queryId: z.number().int().optional().describe('kind="api": an API query id instead of a page.'),
    languages: Languages,
    summary: z
        .boolean()
        .optional()
        .describe(
            'kind="table" only: return a compact view (app, primaryKey, keys, fields as {no, name, type, length, ' +
                'access, relation, options (ordinal → member name)}, referencedBy) instead of the full answer — use it to orient; ' +
                'ask for the full answer when you need captions or classifications.',
        ),
    referencedBy: z
        .boolean()
        .optional()
        .describe(
            'kind="table" only: also list the fields of OTHER tables whose relation targets this table ' +
                '(referencedBy) — how solution tables hanging off a core table are found. Scans all field ' +
                'metadata, so ask only when you need it.',
        ),
};

const apisSchema = {
    tableId: z.number().int().optional().describe('Only the API pages over this BC table (e.g. 18 = Customer).'),
    search: z
        .string()
        .optional()
        .describe('Case-insensitive substring of the entity set, entity or page name, e.g. "salesOrder".'),
    group: z
        .string()
        .optional()
        .describe('Only one route prefix, e.g. "v2.0" (Microsoft standard) or "microsoft/automation/v2.0".'),
    refresh: z
        .boolean()
        .optional()
        .describe('Ignore the cache and fetch the whole catalog again (rarely needed: the cache revalidates itself).'),
};

export const API_READ_DEFAULT_TOP = 100;
export const API_READ_MAX_TOP = 1000;

const apiReadSchema = {
    pageId: z.number().int().describe('The API page to read through (from wicket_apis, or apiRoutes in wicket_describe kind="table").'),
    select: z
        .array(z.string())
        .optional()
        .describe(
            'API field names (camelCase, as wicket_describe kind="api" lists them). Omit to get every field ' +
                'Wicket marks readable. A restricted or computed field is refused, never silently dropped.',
        ),
    filter: z
        .string()
        .optional()
        .describe(
            'OData $filter over this API\'s own fields, e.g. "balance gt 1000 and city eq \'Seattle\'". ' +
                'Every field it names must be readable; navigation and lambdas ("/") are refused.',
        ),
    orderBy: z.array(z.string()).optional().describe('e.g. ["displayName asc"]; readable fields only.'),
    top: z
        .number()
        .int()
        .positive()
        .max(API_READ_MAX_TOP)
        .optional()
        .describe(`Page size (default ${API_READ_DEFAULT_TOP}, max ${API_READ_MAX_TOP}).`),
    skip: z.number().int().nonnegative().optional().describe('Rows to skip — pass the previous page\'s @nextSkip.'),
    count: z.boolean().optional().describe('Add @count, the total for the filter.'),
};

const querySchema = {
    tableId: z.number().int().describe('BC table number to read, e.g. 18 = Customer.'),
    select: z
        .array(z.string())
        .optional()
        .describe(
            'Field names to return. Omit to get only the primary key. Cannot combine with selectFieldNo. ' +
                'Pass ["*"] (the sole entry) for every readable scalar field; note "*" is narrowed by the ' +
                'field policy, so it may return FEWER fields than describe lists (restricted fields are silently omitted).',
        ),
    selectFieldNo: z
        .array(z.number().int())
        .optional()
        .describe('Field numbers to return (localization-stable). Cannot combine with select.'),
    filter: z
        .string()
        .optional()
        .describe(
            'OData $filter subset. Double-quote field names that are not plain [A-Za-z0-9_]; options by ' +
                'ordinal; dates bare; strings in single quotes: "\\"Balance (LCY)\\" gt 1000 and Blocked eq 0", ' +
                '"\\"No.\\" in (\'10000\',\'20000\')", "startswith(Name,\'Acme\')". No cross-field or.',
        ),
    modifiedAfter: z
        .string()
        .datetime({ offset: true, local: true })
        .optional()
        .describe(
            'ISO 8601 datetime — only rows with SystemModifiedAt at or after this instant (inclusive). ' +
                'ANDed with `filter`. This (with modifiedBefore) is the incremental-sync pattern: keep the ' +
                'serverTime of your last pull and pass it here on the next one (upsert on the key, since a ' +
                'boundary row repeats). A caller `filter` that also targets SystemModifiedAt conflicts → ' +
                '400 invalid-field.',
        ),
    modifiedBefore: z
        .string()
        .datetime({ offset: true, local: true })
        .optional()
        .describe(
            'ISO 8601 datetime — only rows with SystemModifiedAt at or before this instant (inclusive). ' +
                'ANDed with `filter` (and modifiedAfter) to bound an incremental-sync window. A caller `filter` ' +
                'that also targets SystemModifiedAt conflicts → 400 invalid-field.',
        ),
    orderBy: z
        .array(z.string())
        .optional()
        .describe('Sort terms, e.g. ["Name asc"] or ["Balance (LCY) desc"]. All terms must share one direction.'),
    top: z.number().int().positive().optional().describe('Max rows (default 100, capped at Max Top).'),
    skip: z.number().int().nonnegative().optional().describe('Offset skip (offset paging).'),
    cursor: z.string().optional().describe('Opaque continuation cursor — pass back the prior @nextLink.'),
    count: z.boolean().optional().describe('Include @count (total matching rows) in the response.'),
    include: z
        .object({ flowFields: z.boolean().optional() })
        .optional()
        .describe('Set { flowFields: true } to calculate FlowFields that are in select.'),
    aggregate: z
        .object({
            count: z.boolean().optional().describe('Include the count of matching rows.'),
            sum: z.array(z.string()).optional().describe('Field names to sum (numeric fields only).'),
            avg: z.array(z.string()).optional().describe('Field names to average (numeric fields only).'),
            min: z.array(z.string()).optional().describe('Field names to take the minimum of.'),
            max: z.array(z.string()).optional().describe('Field names to take the maximum of.'),
        })
        .optional()
        .describe(
            'Server-side aggregation. Composes ONLY with filter and returns a SINGLE summary object ' +
                '({ count?, sum?, avg?, min?, max? }) instead of a row array. Cannot combine with select/' +
                'selectFieldNo/orderBy/top/skip/cursor/count/include (→ 400 invalid-aggregate). sum/avg accept ' +
                'stored numeric fields only: a FlowField (class "FlowField" in describe, e.g. Customer ' +
                '"Balance (LCY)", Sales Invoice Header "Amount") is refused — aggregate the ledger or line ' +
                'table it is computed from. Every named field must be readable under the field policy or you ' +
                'get 403 field-restricted.',
        ),
};

// wicket_query_deliver = the query inputs plus a REQUIRED deliver block and an optional
// idempotencyKey (the enqueue is a write: the same key replays to the same requestId instead of
// spawning a duplicate export). Its own tool so wicket_query can keep its readOnly annotation.
const deliverSchema = {
    ...querySchema,
    deliver: z
        .object({
            mode: z.literal('azureBlob').describe('Delivery target. Only "azureBlob" is supported.'),
            package: z
                .enum(['ndjson', 'json', 'zip'])
                .optional()
                .describe('Package format for the delivered rows. Defaults to the Wicket setup default.'),
            scheduleAt: z
                .string()
                .optional()
                .describe(
                    'RFC 3339 date-time to run the query later (must be in the future, within the ' +
                        'server Max Schedule Ahead window). Omit to run immediately in the background.',
                ),
        })
        .describe(
            'REQUIRED. Deliver the result ASYNCHRONOUSLY to Azure Blob storage instead of returning rows. The ' +
                'call returns immediately with an @async ACCEPTANCE — { @async:true, requestId, status, ' +
                'packageUrl?, scheduledFor, expiresAt, statusVia } — NOT rows. Poll wicket_status with the ' +
                'requestId (or list via wicket_requests) to track it, and download from packageUrl once ' +
                'status is "succeeded"; packageUrl 404s until the package is written. A scheduled request ' +
                'withholds packageUrl until it completes (read it from wicket_status). Async must be configured server-' +
                'side (→ 403 async-not-configured); a malformed block → 400 invalid-deliver; exceeding your ' +
                'in-flight cap → 429 too-many-requests.',
        ),
    idempotencyKey: IdempotencyKey,
};

const readBlobSchema = {
    tableId: z.number().int().describe('Table the record belongs to.'),
    recordId: z.string().describe('Opaque @recordId token from a prior query row.'),
    fieldNo: z.number().int().describe('Field number of the BLOB/Media field to read.'),
};

const insertSchema = {
    tableId: z.number().int().describe('Table to insert into.'),
    values: ValuesObject.optional().describe('Field values keyed by field name. Use this OR valuesByFieldNo.'),
    valuesByFieldNo: ValuesObject.optional().describe('Field values keyed by field number (stringified).'),
    init: z.boolean().optional().describe('Run the insert trigger (OnInsert). Defaults to true.'),
    idempotencyKey: IdempotencyKey,
};

const modifySchema = {
    tableId: z.number().int().describe('Table to modify.'),
    recordId: z.string().describe('Opaque @recordId token from a prior query/insert.'),
    values: ValuesObject.optional().describe('Field values keyed by field name. Use this OR valuesByFieldNo.'),
    valuesByFieldNo: ValuesObject.optional().describe('Field values keyed by field number (stringified).'),
    etag: z.string().optional().describe('Optimistic-concurrency @etag from a prior read. Mismatch → 412.'),
    validate: z.boolean().optional().describe('Run field validation (OnValidate). Defaults to true.'),
    idempotencyKey: IdempotencyKey,
};

const deleteSchema = {
    tableId: z.number().int().describe('Table to delete from.'),
    recordId: z.string().describe('Opaque @recordId token from a prior query/insert.'),
    etag: z.string().optional().describe('Optimistic-concurrency @etag from a prior read. Mismatch → 412.'),
    idempotencyKey: IdempotencyKey,
};

const invokeSchema = {
    codeunitId: z.number().int().describe('Codeunit hosting the enrolled procedure.'),
    procedure: z.string().describe('Enrolled procedure name (see describe kind=codeunit).'),
    args: ValuesObject.optional().describe('Argument object matching the procedure argsSchema.'),
    returnShape: z.enum(['json', 'void']).optional().describe('Expected return shape; usually inferred from enrollment.'),
    idempotencyKey: IdempotencyKey,
};

// action runs a NAMED business action from the deny-by-default Action Catalog (e.g. "post-sales").
// The verbs are provided by an installed action-provider companion; discover them (plus whether each
// mutates / supports preview) via wicket_capabilities → actions. target.systemId (a query row's
// @systemId) is merged into the wrapper args. preview only works when the action's previewSupported
// is true; a preview and a non-mutating verb run inside the server's forced rollback, so they pass
// read-only mode (server and readOnly connection alike); a mutating action is refused there.
const actionSchema = {
    action: z
        .string()
        .describe(
            'Named action to run, e.g. "post-sales". Deny-by-default: only actions enrolled and ' +
                'allowed in the Action Catalog run. Discover the verbs via wicket_capabilities → actions: every ' +
                'enrolled verb with enabled, mutating, previewSupported and argsSchema (empty until an ' +
                'action-provider companion is installed). Unknown → 404 unknown-action; enabled: false → 403 action-disabled.',
        ),
    target: z
        .object({
            systemId: z
                .string()
                .optional()
                .describe('A record\'s @systemId (from a wicket_query row) — merged into the action args as systemId.'),
        })
        .optional()
        .describe('The record the action operates on. Pass { systemId } from a prior query row\'s @systemId.'),
    args: ValuesObject.optional().describe('Action-specific argument object (see the verb\'s argsSchema), merged with target.systemId.'),
    preview: z
        .boolean()
        .optional()
        .describe(
            'Preview instead of running (only if the action\'s previewSupported is true, else 400 ' +
                'preview-unsupported). Runs inside a forced rollback, so it never changes data, needs no ' +
                'idempotency key and works on a read-only endpoint. The posting verbs return ' +
                '{ preview, wouldPost, errors, entries, glAccounts }: what the post would create, or why it would fail.',
        ),
    idempotencyKey: IdempotencyKey,
};

// capabilities takes an empty data object.
const capabilitiesSchema = {} satisfies Record<string, never>;

// pageUrl builds a BC web-client deep link for one record. Identify the record by
// systemId (preferred) or recordId; when both are passed, systemId wins. The table's
// exposure must Allow Read (same gate as query → 403 not-exposed otherwise).
const pageUrlSchema = {
    table: z
        .string()
        .describe('Table to link into — a table name (e.g. "Customer") or "#<number>" (e.g. "#18").'),
    systemId: z
        .string()
        .optional()
        .describe(
            'The record\'s SystemId GUID (a query row\'s @systemId). One of systemId/recordId is ' +
                'required; if both are passed, systemId wins.',
        ),
    recordId: z
        .string()
        .optional()
        .describe('Opaque @recordId token from a prior query row. Ignored when systemId is also passed.'),
    pageId: z
        .number()
        .int()
        .optional()
        .describe(
            'Page to open. Omit to let the server pick the table\'s default card/list page; if it ' +
                'cannot determine one you get 404 no-page — pass pageId explicitly then.',
        ),
};

// whoAmI takes an empty data object.
const whoAmISchema = {} satisfies Record<string, never>;

// --- Async delivery ops (status / cancel / requests). All are STRICTLY caller-scoped:
// a request owned by a different principal is indistinguishable from a nonexistent one
// (404 unknown-request), so you only ever see or act on your own async requests. ---

const statusSchema = {
    requestId: z
        .string()
        .describe('The requestId from a query async acceptance (deliver) — the request to report on.'),
};

const cancelSchema = {
    requestId: z.string().describe('The requestId of the async request to cancel.'),
};

const requestsSchema = {
    status: z
        .enum(['queued', 'scheduled', 'running', 'succeeded', 'failed', 'cancelled', 'expired'])
        .optional()
        .describe('Filter to one lifecycle status. An unknown value yields an empty list (never an error).'),
    top: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max requests to return, newest first (default 20, capped at 100).'),
};

// query_all (convenience) extends query but follows @nextLink to completion.
// aggregate is deliberately excluded: it returns ONE summary object, not pageable
// rows, so paging it is meaningless (use wicket_query). querySchema carries no deliver:
// async delivery returns a SINGLE @async acceptance object (use wicket_query_deliver).
const { aggregate: _queryAllNoAggregate, ...queryPageableSchema } = querySchema;

/** Default / hard ceiling for wicket_query_all's row cap — one tool result must stay bounded. */
export const QUERY_ALL_DEFAULT_MAX_ROWS = 5_000;
export const QUERY_ALL_MAX_ROWS = 50_000;

const queryAllSchema = {
    ...ConnectionOverride,
    ...queryPageableSchema,
    maxPages: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Safety cap on the number of pages to follow (default 100).'),
    maxRows: z
        .number()
        .int()
        .positive()
        .max(QUERY_ALL_MAX_ROWS)
        .optional()
        .describe(
            `Cap on accumulated rows (default ${QUERY_ALL_DEFAULT_MAX_ROWS}, max ${QUERY_ALL_MAX_ROWS}). The walk ` +
                'stops after the page that reaches it (so the result can exceed it by up to one page) and ' +
                'returns "@truncated": true with the "@nextLink" cursor to resume from.',
        ),
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface BuildServerOptions {
    /** The setup sign-in session (a seam for tests); one per server otherwise. */
    setupSession?: SetupSession;
    /** How setup's health checks build a delegated credential (a seam for tests). */
    createCredential?: typeof createDelegatedCredential;
}

export function buildServer(pool: ClientPool, registry: ConnectionRegistry, options: BuildServerOptions = {}): McpServer {
    // The skill's essentials ride along as MCP `instructions`: hosts inject them into the system
    // prompt, so they are the one piece of guidance an agent sees before its first call.
    const server = new McpServer(
        { name: 'wicket-mcp', version: SERVER_VERSION },
        { instructions: instructionsFrom(loadSkillDoc()) },
    );

    const tool = (
        name: string,
        title: string,
        description: string,
        operation: string,
        inputSchema: Record<string, z.ZodTypeAny>,
        annotations: ToolAnnotations,
        refuse?: (args: Record<string, unknown>) => Rfc7807Problem | undefined,
    ) => {
        // Every BC-touching tool accepts a per-call `connection` override.
        const shape: Record<string, z.ZodTypeAny> = { ...ConnectionOverride, ...inputSchema };
        // zod strips undeclared keys silently. A tool with a `refuse` hook must SEE a key it wants
        // to reject loudly (wicket_query + deliver), so it validates with passthrough and then keeps
        // only the declared keys for the payload.
        const schema = refuse ? z.object(shape).passthrough() : shape;
        server.registerTool(
            name,
            { title, description, inputSchema: schema, annotations },
            async (raw: Record<string, unknown>): Promise<CallToolResult> => {
                try {
                    const refused = refuse?.(raw ?? {});
                    if (refused) return fail(new WicketProblemError(refused));
                    const args = refuse
                        ? Object.fromEntries(Object.entries(raw ?? {}).filter(([k]) => k in shape))
                        : raw;
                    // `connection` routes the call to a client; `idempotencyKey` (present only on
                    // the write-ish schemas) rides the envelope. Both are lifted out of the args
                    // before building the operation `data` payload.
                    const { idempotencyKey, connection, ...rest } = args ?? {};
                    const client = pool.get(connection as string | undefined);
                    // invoke/action reach wrappers that post and commit: without a key, a lost
                    // response cannot be retried without risking a second posting. When the agent
                    // sent none, mint one and say so — in the result, and (through the client's retry
                    // guidance) in any timeout/transport problem — so the retry can reuse it.
                    const generated = idempotencyKey === undefined && AUTO_KEY_OPERATIONS.has(operation);
                    const key = generated ? `auto-${randomUUID()}` : (idempotencyKey as string | undefined);
                    const result = await client.call(operation, compact(rest), key);
                    return ok(generated ? withGeneratedKey(result, key as string) : result);
                } catch (err) {
                    return fail(err);
                }
            },
        );
    };

    tool(
        'wicket_discover',
        'Discover tables, codeunits or companies',
        'List what is reachable: tables, codeunits, companies, or the tenant\'s API catalog (kind "apis" — ' +
            'prefer wicket_apis, which caches it). `filter` is a plain AL filter on the object caption, e.g. ' +
            '"*Sales*" (not the $filter grammar); publisher "<>Microsoft" lists only solution/custom tables, ' +
            'each with its owning app {id, name, publisher, version}. Returns at most `top` rows (default 100, ' +
            'max 1000) with NO continuation marker, so a result of exactly `top` rows is truncated: narrow by ' +
            'publisher or by caption range ("..I", "I..P", "P..S", "S.."). For codeunits the list follows the ' +
            'exposure mode (every reachable codeunit in Open mode) and permissions.invoke does NOT mean a ' +
            'procedure is callable — only wicket_describe kind:"codeunit" lists the enrolled procedures.',
        'discover',
        discoverSchema,
        READ_ANNOTATIONS,
    );

    const describeCache = new DescribeCache();

    server.registerTool(
        'wicket_describe',
        {
            title: 'Describe a table, codeunit or API page',
            description:
                'The schema of one BC table (fields, types, keys, primary key, relations, permissions, owning ' +
                'app, apiRoutes), the enrolled procedures of one codeunit, or one API page (its fields and whether ' +
                'Wicket lets you read through it). Call it before reading or writing an unfamiliar table: field ' +
                'names, option ordinals and what you may read are not guessable, and the field policy may hide ' +
                'restricted fields entirely. Use summary:true for the compact view that answers most questions — ' +
                'fields as {no, name, type, length, class?, access?, writable?, relation?, options?}, where an ' +
                'absent class means a stored field (class "FlowField" cannot be aggregated, sorted or filtered ' +
                'on), an absent access means clear (access "masked" means a masked rendering), an absent writable ' +
                'means writable, and options maps an Option field\'s member ordinals to their names (the ' +
                'ordinal is what you filter with — extended enums use ordinals such as 50000). Table answers are cached per connection and revalidated with Wicket on ' +
                'every call (fromCache:true = unchanged), so repeating a describe is cheap. referencedBy:true adds ' +
                'the fields of other tables that point at this one (scans all metadata; ask when mapping ' +
                'relations). Ask for the full answer only when you need captions or classifications.',
            inputSchema: { ...ConnectionOverride, ...describeSchema },
            annotations: READ_ANNOTATIONS,
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
            try {
                const { connection, summary, referencedBy, ...rest } = args as {
                    connection?: string;
                    summary?: boolean;
                    referencedBy?: boolean;
                } & Record<string, unknown>;
                const client = pool.get(connection);
                if (rest.kind !== 'table' || typeof rest.tableId !== 'number') {
                    // codeunit / api (and a table call missing its id, which Wicket refuses with a
                    // typed problem) pass straight through; summary/referencedBy are table-only.
                    return ok(await client.call('describe', compact(rest)));
                }
                const { kind: _kind, tableId, languages, ...extra } = rest as {
                    kind: string;
                    tableId: number;
                    languages?: string[];
                } & Record<string, unknown>;
                const { answer, fromCache } = await describeCache.get(
                    client,
                    { tableId, languages, referencedBy: referencedBy === true },
                    compact(extra),
                );
                if (summary === true) {
                    const { value, ...meta } = answer;
                    return ok({ ...meta, summary: true, fromCache, value: summarizeDescribe(asObject(value)) });
                }
                return ok({ ...answer, fromCache });
            } catch (err) {
                return fail(err);
            }
        },
    );

    tool(
        'wicket_query',
        'Query rows or aggregate',
        'Read rows from one BC table. Without select you get only the primary key, so select the fields ' +
            'you need (select ["*"] alone = every readable field, narrowed by the field policy). filter is an ' +
            'OData subset: double-quote any field name that is not plain [A-Za-z0-9_] and filter options by ' +
            'ordinal — e.g. "\\"Balance (LCY)\\" gt 1000 and Blocked eq 0", "\\"Posting Date\\" ge 2025-01-01", ' +
            '"\\"No.\\" eq \'10000\'"; same-field OR via in (...), no cross-field or (split the query), ' +
            'contains() is case-sensitive. Rows carry @recordId, @systemId, @etag and, when present, @masked ' +
            '(fields whose values are display renderings, never data; they cannot be filtered, sorted or ' +
            'aggregated). aggregate {count, sum, avg, min, max} composes only with filter and returns ONE ' +
            'summary object instead of rows; sum/avg work on stored numeric fields only — a FlowField such as ' +
            'Balance (LCY) is refused, so aggregate the ledger or line table it is computed from. count:true ' +
            'adds @count (the total for the filter) to a page. A FlowField in select needs ' +
            'include:{flowFields:true}. orderBy must match a key and switches paging to offset; omit it for ' +
            'keyset paging (follow @nextLink as cursor). modifiedAfter/modifiedBefore (inclusive) bound ' +
            'SystemModifiedAt for incremental sync. Async delivery is wicket_query_deliver; all rows in one ' +
            'call is wicket_query_all. Grammar and recipes: wicket_skill section "filters".',
        'query',
        querySchema,
        READ_ANNOTATIONS,
        (args) =>
            args.deliver === undefined
                ? undefined
                : {
                      type: `${PROBLEM_BASE}use-deliver-tool`,
                      title: 'Async delivery needs wicket_query_deliver',
                      status: 400,
                      detail:
                          'wicket_query is read-only and does not accept `deliver`. Call wicket_query_deliver ' +
                          'with the same query inputs plus the deliver block (and an optional idempotencyKey).',
                      operation: 'query',
                      suggest: { use: 'wicket_query_deliver' },
                  },
    );

    tool(
        'wicket_query_deliver',
        'Deliver a query to Azure Blob Storage',
        'Run a query ASYNCHRONOUSLY and deliver the result as a package to Azure Blob Storage instead of ' +
            'returning rows — the way to export a large result when wicket_capabilities reports async.enabled ' +
            '(otherwise 403 async-not-configured: page or use wicket_query_all instead). Takes the wicket_query ' +
            'inputs plus a required `deliver` block ({ mode:"azureBlob", package?, scheduleAt? }). Returns an ' +
            '@async acceptance { requestId, status, packageUrl?, scheduledFor, expiresAt, statusVia } at once; ' +
            'poll wicket_status and download the signed packageUrl it reports once "succeeded". NOT read-only: ' +
            'it creates a request row and a shareable package link. Pass an idempotencyKey so a resubmit ' +
            'replays to the same requestId instead of spawning a duplicate export. Allowed on readOnly ' +
            'connections (Wicket does not count delivery as a mutating operation).',
        'query',
        deliverSchema,
        DELIVER_ANNOTATIONS,
    );

    tool(
        'wicket_read_blob',
        'Read a binary field',
        'Fetch one binary field (BLOB/Media) of one record as { contentType, bytesBase64 }; decode the base64 ' +
            'yourself. Pass the row\'s @recordId from a prior wicket_query and the field number from ' +
            'wicket_describe (a field of type Blob or Media). Up to 10 MB; a MediaSet field is refused ' +
            '(422 mediaset-unsupported) and an empty field is 404 empty-blob.',
        'readBlob',
        readBlobSchema,
        READ_ANNOTATIONS,
    );

    tool(
        'wicket_insert',
        'Insert one record',
        'Create one record in a BC table from values (by field name) or valuesByFieldNo; every value is ' +
            'validated by the table\'s own field logic. Option values as the member name, the ordinal or ' +
            '{ ord }; null clears a field. Pass an idempotencyKey so a retry after a lost response replays ' +
            'instead of inserting twice. Returns the new record\'s recordId and @etag; read the row back to ' +
            'verify. Rules and batches: wicket_skill section "writes".',
        'insert',
        insertSchema,
        CREATE_ANNOTATIONS,
    );

    tool(
        'wicket_modify',
        'Modify one record',
        'Update one record by its @recordId: send etag from your most recent read of the row (a mismatch is ' +
            '412 precondition-failed — re-read, re-apply, retry with the new @etag), only the fields that ' +
            'change (by name or field number), and an idempotencyKey. Primary-key fields are immutable ' +
            '(400 pk-immutable). Never send back a masked rendering (a value listed in the row\'s @masked): ' +
            '400 masked-value. Returns the new @etag; read the row back to verify.',
        'modify',
        modifySchema,
        UPDATE_ANNOTATIONS,
    );

    tool(
        'wicket_delete',
        'Delete one record',
        'Delete one record by its @recordId, with etag from your most recent read (mismatch → 412) and an ' +
            'idempotencyKey so a retry after a lost response is safe. Returns { deleted: true, recordId }.',
        'delete',
        deleteSchema,
        DELETE_ANNOTATIONS,
    );

    tool(
        'wicket_invoke',
        'Invoke an enrolled procedure',
        'Run one AL procedure enrolled in the Wicket Procedure Catalog (deny-by-default): only the procedures ' +
            'wicket_describe kind:"codeunit" lists are callable, whatever wicket_discover shows. Synchronous. ' +
            'Pass an idempotencyKey so a retry after a lost response is safe; when you send none, the server ' +
            'mints one and returns it as @idempotencyKey — reuse it verbatim to retry this same call. Prefer ' +
            'wicket_action for business operations such as posting.',
        'invoke',
        invokeSchema,
        RUN_ANNOTATIONS,
    );

    tool(
        'wicket_action',
        'Run a named business action',
        'Run a named business action (posting etc.) from the deny-by-default Action Catalog — e.g. ' +
            '"post-sales", "release-sales", "make-order-from-quote", "document-pdf", "item-availability". The verbs ' +
            'come from an installed action-provider companion; wicket_capabilities → actions lists every ' +
            'enrolled verb with enabled, mutating, previewSupported and argsSchema (empty: no companion; ' +
            'enabled:false: an administrator must allow it). Pass a record\'s @systemId (from a wicket_query ' +
            'row) as target.systemId; it is merged into the action args. preview:true (when previewSupported) ' +
            'runs inside a forced rollback and returns what a post would create, or why it would fail; it ' +
            'works on a read-only endpoint, as does a mutating:false verb. A real posting commits immediately ' +
            'and Wicket never rolls it back: preview first and never post twice. Pass an ' +
            'idempotencyKey so a retry after a lost response cannot post twice; when you send none, the server ' +
            'mints one and returns it as @idempotencyKey — reuse it verbatim to retry this same call. ' +
            'Checklist: wicket_skill section "writes".',
        'action',
        actionSchema,
        RUN_ANNOTATIONS,
    );

    tool(
        'wicket_capabilities',
        'Endpoint capabilities',
        'The endpoint\'s self-description (about 5 KB): limits (defaultTop, maxTop, scanBudget, maxInMembers), ' +
            'readOnly, exposureMode, fieldPolicy (classification verdicts, mask profiles, this principal\'s ' +
            'unmask grants), apiRouting.mode ("Prefer" allows wicket_api_read), async.enabled (whether ' +
            'wicket_query_deliver can work), actions (every enrolled business verb with enabled and argsSchema), structureVersion, and the ' +
            'filter grammar. Call it once per connection per session (again after wicket_use) and plan from ' +
            'it instead of guessing. Takes no input.',
        'capabilities',
        capabilitiesSchema,
        READ_ANNOTATIONS,
    );

    tool(
        'wicket_page_url',
        'Deep link to a record',
        'A BC web-client link for one record, for handing it to a person: table (a name such as "Customer" or ' +
            '"#36") plus systemId (preferred, from a wicket_query row\'s @systemId) or recordId. Without pageId ' +
            'the server picks the table\'s default lookup page, which is often a LIST (Customer → 33 Customer ' +
            'Lookup, Sales Header → 45 Sales List): pass the card page when the person should act on the record ' +
            '(Customer Card 21, Vendor Card 26, Item Card 30, Sales Order 42, Posted Sales Invoice 132). One ' +
            'link per call; for a long list give one list link rather than a call per row. Returns ' +
            '{ pageUrl, pageId }; the link opens under the viewer\'s own BC login. Requires read exposure on the ' +
            'table (403 not-exposed); 404 unknown-record for a stale handle, 404 no-page when no default page ' +
            'exists (pass pageId).',
        'pageUrl',
        pageUrlSchema,
        READ_ANNOTATIONS,
    );

    tool(
        'wicket_whoami',
        'Who am I',
        'Identify the calling principal, company and endpoint posture: { userSecurityId, userId, company, ' +
            'readOnly, fieldPolicy, strongEtag, serverTime, unmaskGranted, activeExceptions }. One small call: ' +
            'use it at the start of a session and after wicket_use to confirm which tenant and company you are ' +
            'on and whether writes are possible; serverTime is the watermark to keep for an incremental sync. ' +
            'unmaskGranted says whether the Unmask tier is in effect for this principal; activeExceptions is ' +
            'the count of per-user exception rows active now. Takes no input.',
        'whoAmI',
        whoAmISchema,
        READ_ANNOTATIONS,
    );

    // --- Async delivery: track / cancel / list the caller's own requests. ---

    tool(
        'wicket_status',
        'Async request status',
        'Report one async delivery request by its requestId (from a wicket_query_deliver acceptance). ' +
            'Returns the projection { requestId, status, operation, packageFormat, createdAt, scheduledFor, ' +
            'startedAt, completedAt, expiresAt, progressRows, resultRowCount, resultBytes, packageUrl? (only ' +
            'once "succeeded", freshly signed), problem? (on failure) }. Poll this to know when to download ' +
            'packageUrl; the server never polls for you. Caller-scoped: a foreign or unknown requestId ' +
            'returns 404 unknown-request.',
        'status',
        statusSchema,
        READ_ANNOTATIONS,
    );

    tool(
        'wicket_cancel',
        'Cancel an async request',
        'Cancel one async delivery request by its requestId. A scheduled request is cancelled outright; ' +
            'a queued or running one is asked to stop cooperatively at its next page checkpoint; a request ' +
            'that already finished is a no-op. Returns { requestId, status }. Caller-scoped: a foreign or ' +
            'unknown requestId returns 404 unknown-request.',
        'cancel',
        cancelSchema,
        CANCEL_ANNOTATIONS,
    );

    tool(
        'wicket_requests',
        'List async requests',
        'List YOUR OWN async delivery requests, newest first, each as the same projection wicket_status ' +
            'returns. Optionally filter by status and cap with top (default 20, max 100). Strictly ' +
            'caller-scoped: only requests you submitted are ever returned.',
        'requests',
        requestsSchema,
        READ_ANNOTATIONS,
    );

    // --- API-first reads: the tenant's API catalog (cached) and reads through an API page. ---

    const apiCache = new ApiCatalogCache();

    server.registerTool(
        'wicket_apis',
        {
            title: 'API catalog',
            description:
                'The tenant\'s own API catalog: every API page and API query, with its route (e.g. ' +
                '"v2.0/customers"), source table and allowed operations. Cached per environment, in memory ' +
                'and on disk, and revalidated with one cheap call against Wicket\'s catalogVersion, so ' +
                'calling it often is fine. Without tableId/search/group it returns a summary by route ' +
                'prefix; narrow it to list entries. Use it to find whether an API covers the data you need ' +
                'before choosing between wicket_api_read and wicket_query. The answer also carries apiRouting ' +
                '(Wicket\'s current mode: "Prefer" allows API reads, "Off" means use wicket_query — check it ' +
                'before planning an API read).',
            inputSchema: { ...ConnectionOverride, ...apisSchema },
            annotations: READ_ANNOTATIONS,
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
            try {
                const { connection, tableId, search, group, refresh } = args as {
                    connection?: string;
                    tableId?: number;
                    search?: string;
                    group?: string;
                } & { refresh?: boolean };
                const client = pool.get(connection);
                const { snapshot, source, apiRouting } = await apiCache.get(client, refresh === true);
                const header = {
                    catalogVersion: snapshot.catalogVersion,
                    fetchedAt: snapshot.fetchedAt,
                    source,
                    ...(apiRouting !== undefined ? { apiRouting } : {}),
                };
                if (tableId === undefined && search === undefined && group === undefined) {
                    return ok({
                        ...header,
                        total: snapshot.entries.length,
                        groups: summarizeGroups(snapshot.entries),
                        hint: 'Pass tableId, search or group to list entries; then wicket_describe kind="api" with a pageId for its fields.',
                    });
                }
                const value = filterEntries(snapshot.entries, { tableId, search, group });
                return ok({ ...header, count: value.length, value });
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        'wicket_api_read',
        {
            title: 'Read through an API page',
            description:
                'Read rows through one of the tenant\'s own API pages instead of Wicket\'s dynamic plane — the ' +
                'better route when an API covers the data (stable contract, the API\'s own shaping and ' +
                'field names). Allowed only when Wicket says so: each call first asks wicket_describe ' +
                'kind="api" (fresh, never cached), refuses unless routable is true, and lets you select, ' +
                'filter and order by only fields Wicket marks readable. With no select you get every ' +
                'readable field. Refusals say why and point at wicket_query with the source tableId. Use ' +
                'wicket_query instead when routing is Off, no API covers the fields you need, or the user ' +
                'asks for dynamic access. Note: an API read is not recorded in the Wicket Operation Log. ' +
                'Returns { @via:"api", route, value:[rows], @nextSkip?, @count? }.',
            inputSchema: { ...ConnectionOverride, ...apiReadSchema },
            annotations: READ_ANNOTATIONS,
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
            try {
                const { connection, pageId, select, filter, orderBy, top, skip, count } = args as {
                    connection?: string;
                    pageId: number;
                    select?: string[];
                    filter?: string;
                    orderBy?: string[];
                    top?: number;
                    skip?: number;
                    count?: boolean;
                };
                const client = pool.get(connection);
                // Governance first, fresh: routable and readable follow Wicket's policy as it is NOW.
                const api = asApiDescription(await client.call('describe', { kind: 'api', pageId }));
                // A catalogVersion that moved means apps changed: let wicket_apis refetch next time.
                const cachedVersion = apiCache.versionOf(client.environmentKey);
                if (cachedVersion !== undefined && api.catalogVersion !== undefined && cachedVersion !== api.catalogVersion) {
                    apiCache.invalidate(client.environmentKey);
                }
                const plan = planApiRead(api, { select, filter, orderBy });
                if (isRefusal(plan)) {
                    return fail(
                        new WicketProblemError({
                            type: `${PROBLEM_BASE}${plan.slug}`,
                            title: plan.title,
                            status: plan.status,
                            detail: plan.detail,
                            operation: 'apiRead',
                            ...(plan.suggest ? { suggest: plan.suggest } : {}),
                        }),
                    );
                }
                const pageSize = Math.min(top ?? API_READ_DEFAULT_TOP, API_READ_MAX_TOP);
                const params = new URLSearchParams();
                params.set('$select', plan.select.join(','));
                if (plan.filter) params.set('$filter', plan.filter);
                if (plan.orderBy) params.set('$orderby', plan.orderBy.join(','));
                params.set('$top', String(pageSize));
                if (skip) params.set('$skip', String(skip));
                if (count) params.set('$count', 'true');
                const body = await client.getApi(api.route, params);
                // Defense in depth: keep only the planned fields (and the row etag), whatever came back.
                const allowed = new Set(plan.select);
                const rows = (Array.isArray(body.value) ? body.value : []).map((row) =>
                    Object.fromEntries(
                        Object.entries(row as Record<string, unknown>).filter(([k]) => allowed.has(k) || k === '@odata.etag'),
                    ),
                );
                process.stderr.write(
                    `[wicket-mcp] api read connection=${client.connectionName} route=${api.route} ` +
                        `select=${plan.select.length} fields filter=${plan.filter ?? ''} rows=${rows.length}\n`,
                );
                return ok({
                    '@via': 'api',
                    pageId: api.id,
                    route: api.route,
                    ...(api.sourceTableId !== undefined ? { sourceTableId: api.sourceTableId } : {}),
                    value: rows,
                    ...(typeof body['@odata.count'] === 'number' ? { '@count': body['@odata.count'] } : {}),
                    ...(rows.length === pageSize ? { '@nextSkip': (skip ?? 0) + pageSize } : {}),
                });
            } catch (err) {
                return fail(err);
            }
        },
    );

    // --- Tenant map: what an agent learned about this connection's tenant, kept across sessions. ---
    server.registerTool(
        'wicket_map',
        {
            title: 'Tenant map',
            description:
                'The tenant map: notes about THIS connection\'s tenant that describe cannot give — what a ' +
                'solution/custom table is for, its business key versus its primary key, how it joins to core ' +
                'tables, what its option values mean in practice, which API page covers it, gotchas. One ' +
                'Markdown document per connection, kept on this machine across sessions at ' +
                '~/.config/wicket/maps/<connection>.md (outside any repository or project); sections are "## " ' +
                'headings (one per table or topic, e.g. "50110 Contoso Contract"). read it before exploring a ' +
                'tenant; upsert a section when you learn something (at the end of an exploration, replacing the ' +
                'section); remove a section that is wrong. read reports stale:true when apps were installed or ' +
                'upgraded since the map was written — then re-verify a section with wicket_describe before ' +
                'trusting it. STRUCTURE ONLY: never write record values, customer/vendor/employee names, amounts, ' +
                `e-mails, IDs of real records or anything that came back masked — the map is a local file outside ` +
                `Wicket's field policy. Capped at ${MAP_MAX_BYTES / 1024} KB per connection.`,
            inputSchema: {
                ...ConnectionOverride,
                action: z.enum(['read', 'upsert', 'remove']).describe('read the map, upsert one section, or remove one section.'),
                section: z
                    .string()
                    .optional()
                    .describe('upsert/remove: the section heading text, without "## " (single line, at most 200 characters).'),
                content: z
                    .string()
                    .optional()
                    .describe('upsert: the section body in Markdown (no "## " headings inside; use "###" for sub-points). Replaces the section.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
            try {
                const { connection, action, section, content } = args as {
                    connection?: string;
                    action: 'read' | 'upsert' | 'remove';
                    section?: string;
                    content?: string;
                };
                const client = pool.get(connection);
                const name = client.connectionName;
                if (action === 'read') {
                    let current: string | null = null;
                    let warning: string | undefined;
                    try {
                        current = await currentStructureVersion(client);
                    } catch (err) {
                        // The map is local: an unreachable endpoint must not hide it. Staleness is then unknown.
                        warning = `structureVersion unavailable: ${err instanceof Error ? err.message : String(err)}`;
                    }
                    const result = readMap(name, current);
                    return ok({
                        ...result,
                        ...(warning ? { warning } : {}),
                        ...(result.content === ''
                            ? { hint: 'The map is empty. Orient first: wicket_discover publisher "<>Microsoft", wicket_describe summary:true, then upsert what you learn.' }
                            : {}),
                    });
                }
                if (section === undefined) throw new TenantMapError(`action "${action}" needs a section`);
                if (action === 'remove') return ok({ connection: name, removed: section.trim(), ...removeSection(name, section) });
                if (content === undefined) throw new TenantMapError('upsert needs content');
                const current = await currentStructureVersion(client);
                const { created, bytes } = upsertSection(name, section, content, current);
                return ok({ connection: name, section: section.trim(), created, bytes, structureVersionAtWrite: current });
            } catch (err) {
                if (err instanceof TenantMapError) {
                    return fail(
                        new WicketProblemError({
                            type: `${PROBLEM_BASE}map-invalid`,
                            title: 'Tenant map request refused',
                            status: 400,
                            detail: err.message,
                        }),
                    );
                }
                return fail(err);
            }
        },
    );

    // --- Protocol education: the bundled usage guide, with progressive disclosure. ---
    server.registerTool(
        'wicket_skill',
        {
            title: 'Wicket usage guide',
            description:
                'The Wicket usage guide for agents, bundled with this server (no repository access needed). ' +
                'Read it before the first write of a session, before building an export, dashboard or sync from ' +
                'BC data, and when an error slug, a limit or a tenant behaviour is unfamiliar. Progressive ' +
                'disclosure: mode:"toc" (default) lists every file and section cheaply; mode:"section" fetches ' +
                'one section by title, or one whole reference file by name — tools, filters, errors, writes, ' +
                'presenting, automation, tables, solutions, protocol; mode:"full" returns everything (large). Local and free.',
            inputSchema: skillSchema,
            annotations: READ_ANNOTATIONS,
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
            try {
                const doc = loadSkillDoc();
                const mode = (args.mode as 'toc' | 'section' | 'full' | undefined) ?? 'toc';
                if (mode === 'full') return ok(doc.raw);
                if (mode === 'section') {
                    const name = args.section as string | undefined;
                    const hit = name ? findSkillSection(doc, name) : undefined;
                    if (!hit) {
                        const note = name
                            ? `No section matched "${name}".`
                            : 'mode:"section" needs a `section` title or a reference file name.';
                        return ok(`${note}\n\n${renderSkillToc(doc)}`);
                    }
                    return ok(hit.body);
                }
                return ok(renderSkillToc(doc));
            } catch (err) {
                return fail(err);
            }
        },
    );

    // --- Multi-connection: list the configured connections and switch the session. ---
    server.registerTool(
        'wicket_connections',
        {
            title: 'List connections',
            description:
                'List the configured Wicket connections (name, tenant, environment, company, ' +
                'authMode, readOnly, unmask (only when set; false = this connection ignores its unmask grants), which is default, which is currently selected). Secrets are never ' +
                'shown. A readOnly connection refuses insert/modify/delete/invoke/action client-side. ' +
                'To target a connection, PREFER passing `connection` on any tool for that one call ' +
                '(race-free); wicket_use switches the whole session but is a caveated convenience.',
            inputSchema: {},
            annotations: READ_ANNOTATIONS,
        },
        async (): Promise<CallToolResult> => {
            try {
                return ok({
                    connections: registry.list(),
                    current: registry.current(),
                    ...(registry.problem ? { problem: registry.problem } : {}),
                    ...(registry.rejected.length ? { rejected: registry.rejected } : {}),
                });
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        'wicket_use',
        {
            title: 'Switch the session connection',
            description:
                'Select the Wicket connection for the rest of this session. All subsequent tool ' +
                'calls use it unless they pass an explicit `connection` override. CAVEAT: this ' +
                'mutates shared session state, so the per-call `connection` override is the ' +
                'PREFERRED, race-free mechanism — pass `connection` on a tool instead of switching ' +
                'when you can. IMPORTANT: after switching, previously fetched @recordId/@etag/' +
                '@systemId tokens, async requestIds, and cursors belong to the OLD connection — ' +
                're-run discover/query rather than reusing them, and re-fetch wicket_capabilities.',
            inputSchema: {
                name: z.string().describe('Connection name, from wicket_connections.'),
            },
            annotations: SESSION_ANNOTATIONS,
        },
        async ({ name }): Promise<CallToolResult> => {
            try {
                const spec = registry.select(name as string);
                return ok({
                    selected: spec.name,
                    tenantId: spec.tenantId,
                    environment: spec.environment,
                    companyId: spec.companyId,
                    authMode: spec.authMode,
                    readOnly: spec.readOnly,
                    ...(spec.unmask !== undefined ? { unmask: spec.unmask } : {}),
                });
            } catch (err) {
                return fail(err);
            }
        },
    );

    // --- Convenience: page a query to completion by following @nextLink. ---
    server.registerTool(
        'wicket_query_all',
        {
            title: 'Query all rows',
            description:
                'Like wicket_query, but transparently follows @nextLink and concatenates every page into a ' +
                'single rows array — the tool for an export or a script. Size it: get the count first ' +
                '(wicket_query with count:true or aggregate:{count:true}), set maxRows just above it, select ' +
                'only the fields you need, and omit orderBy (keyset paging). Stops at maxPages (default 100) or ' +
                'maxRows (default 5000, max 50000), returning "@truncated": true and the "@nextLink" cursor to ' +
                'resume from. A result this large belongs in a file, not in the conversation: a host that saves ' +
                'an oversized result to a file (Claude Code does) lets a script process it. Does NOT support ' +
                'aggregate (use wicket_query) or deliver (use wicket_query_deliver). If a page fetch fails ' +
                'MID-pagination, the rows already fetched are returned as a PARTIAL result with ' +
                '"@truncated": true, an "@nextLink" resume cursor, and the error under "@error" (a failure on ' +
                'the first page errors normally).',
            inputSchema: queryAllSchema,
            annotations: READ_ANNOTATIONS,
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
            try {
                const { maxPages, maxRows, connection, ...queryArgs } = args as {
                    maxPages?: number;
                    maxRows?: number;
                    connection?: string;
                } & Record<string, unknown>;
                // Pin the client ONCE before the loop so a concurrent wicket_use from a
                // parallel turn cannot switch tenants between pages.
                const client = pool.get(connection);
                // Belt-and-braces: aggregate is excluded from queryAllSchema, but reject it
                // explicitly if it ever arrives — an aggregate returns one object, not pages.
                if (queryArgs.aggregate !== undefined) {
                    return fail(
                        new Error(
                            'wicket_query_all cannot page an aggregate (it returns a single summary ' +
                                'object, not rows). Call wicket_query with aggregate instead.',
                        ),
                    );
                }
                // deliver is not in queryAllSchema, but reject it explicitly if it ever arrives —
                // async delivery returns one @async acceptance object, not pageable rows.
                if (queryArgs.deliver !== undefined) {
                    return fail(
                        new Error(
                            'wicket_query_all cannot deliver asynchronously (async returns a single ' +
                                '@async acceptance, not rows). Call wicket_query_deliver instead, ' +
                                'then poll wicket_status.',
                        ),
                    );
                }
                const limit = maxPages ?? 100;
                const rowCap = maxRows ?? QUERY_ALL_DEFAULT_MAX_ROWS;
                const rows: unknown[] = [];
                let cursor: string | undefined = queryArgs.cursor as string | undefined;
                let pages = 0;
                let lastPagingMode: unknown;
                let totalCount: unknown;

                do {
                    const data = compact({ ...queryArgs, cursor });
                    let page: unknown;
                    try {
                        page = await client.call('query', data);
                    } catch (err) {
                        // Mid-pagination failure with pages already fetched: don't throw
                        // the rows away — whatever the error (a problem document, a network
                        // failure, a non-JSON body). Return the accumulated rows as a PARTIAL
                        // result with @truncated, the resume cursor (@nextLink — the last
                        // successful page's cursor, i.e. the one whose fetch failed) and the
                        // error under @error. Zero pages fetched → the normal error path.
                        if (pages > 0) {
                            return ok({
                                value: rows,
                                '@pages': pages,
                                '@pagingMode': lastPagingMode,
                                ...(totalCount !== undefined ? { '@count': totalCount } : {}),
                                '@truncated': true,
                                ...(cursor ? { '@nextLink': cursor } : {}),
                                '@error':
                                    err instanceof WicketProblemError
                                        ? err.problem
                                        : { message: err instanceof Error ? err.message : String(err) },
                            });
                        }
                        throw err;
                    }
                    const { value, nextLink, pagingMode, count } = readPage(page);
                    rows.push(...value);
                    lastPagingMode = pagingMode ?? lastPagingMode;
                    if (count !== undefined) totalCount = count;
                    cursor = nextLink;
                    pages += 1;
                } while (cursor && pages < limit && rows.length < rowCap);

                return ok({
                    value: rows,
                    '@pages': pages,
                    '@pagingMode': lastPagingMode,
                    ...(totalCount !== undefined ? { '@count': totalCount } : {}),
                    ...(cursor ? { '@nextLink': cursor, '@truncated': true } : {}),
                });
            } catch (err) {
                return fail(err);
            }
        },
    );

    // --- Guided setup: works with no connection at all, so it is not a BC-endpoint tool. ---
    const setupSession = options.setupSession ?? new SetupSession();
    const healthOf = (spec: ConnectionSpec) =>
        checkHealth(spec, () => pool.get(spec.name).call('whoAmI', {}), {
            ...(options.createCredential ? { createCredential: options.createCredential } : {}),
        });
    // What Fix needs to sign a connection in again as it was: never a secret, only where it lives.
    const identityOf = (spec: ConnectionSpec) => ({
        name: spec.name,
        authMode: spec.authMode,
        tenantId: spec.tenantId,
        clientId: spec.clientId,
        environment: spec.environment,
        companyId: spec.companyId,
        ...(spec.keychainService ? { keychainService: spec.keychainService, keychainAccount: spec.keychainAccount } : {}),
        ...(spec.secretEnv ? { secretEnv: spec.secretEnv } : {}),
    });
    const refuseEnv = (name: string) => {
        if (registry.sourceOf(name) === 'env') {
            throw new Error(
                `Connection "${name}" comes from environment variables (BC_TENANT_ID etc.): change those, ` +
                    'or save a connection under another name.',
            );
        }
    };
    const need = (value: unknown, what: string): string => {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is required for this action.`);
        return value.trim();
    };

    server.registerTool(
        'wicket_setup',
        {
            title: 'Set up Business Central connections',
            description:
                'Add, fix, re-default or remove Wicket connections; use it when no connection is configured, ' +
                'when a call fails with connection-unavailable or sign-in trouble, or when the user wants another ' +
                'tenant or company. In Claude Code the /wicket:setup command drives it with questions. Actions: ' +
                '`status` (the file, any problem, each connection with a silent health check — never prompts); ' +
                '`locate` {hint: a BC web address, an email or a domain} → tenantId and, from an address, ' +
                'environment and companyName; `signin` {method: browser | device_code | client_credentials, ' +
                'tenantId? (default organizations), clientId? (default: the Wicket default client), restart? ' +
                '(start afresh: wrong account, closed window, expired code), ' +
                'keychainService/keychainAccount for client_credentials} → pending with the prompt (call again ' +
                'once the user has signed in), signedIn {upn or appId, tenantId}, or failed; `environments`; ' +
                '`companies` {environment}; `save` {name, environment, companyId, makeDefault?, replace?} writes ' +
                'the connection from the signed-in session and tests it with whoami; `remove` {name} (destructive: ' +
                'confirm with the user first; `defaultCleared` means ask which connection becomes the default); `setDefault` {name}; `moveAsideBroken` renames an unreadable ' +
                'connections.json (only on the user\'s yes). Add = locate → signin → environments → companies → ' +
                'save. Secrets never pass through this tool: a client secret is read from the Keychain item.',
            inputSchema: {
                action: z.enum(['status', 'locate', 'signin', 'environments', 'companies', 'save', 'remove', 'setDefault', 'moveAsideBroken']),
                hint: z.string().optional().describe('locate: a BC web address, an email or a domain.'),
                method: z.enum(['browser', 'device_code', 'client_credentials']).optional().describe('signin: how to sign in.'),
                restart: z
                    .boolean()
                    .optional()
                    .describe('signin: drop the current sign-in and start afresh (wrong account, closed window, expired code).'),
                tenantId: z.string().optional().describe('signin: the tenant (GUID or domain); required for client_credentials.'),
                clientId: z.string().optional().describe('signin: the app registration; required for client_credentials.'),
                keychainService: z.string().optional().describe('signin (client_credentials): Keychain service of the secret, usually "wicket".'),
                keychainAccount: z.string().optional().describe('signin (client_credentials): Keychain account of the secret, usually the connection name.'),
                environment: z.string().optional().describe('companies / save: the environment name.'),
                companyId: z.string().optional().describe('save: the company id from `companies`.'),
                name: z.string().optional().describe('save / remove / setDefault: the connection name.'),
                makeDefault: z.boolean().optional().describe('save: make it the default connection.'),
                replace: z.boolean().optional().describe('save: overwrite an existing connection of that name (fields not given are kept).'),
            },
            annotations: SETUP_ANNOTATIONS,
        },
        async (args): Promise<CallToolResult> => {
            try {
                switch (args.action) {
                    case 'status': {
                        const connections = await Promise.all(
                            registry.list().map(async (c) => ({
                                ...identityOf(registry.resolve(c.name)),
                                source: registry.sourceOf(c.name),
                                isDefault: c.isDefault,
                                health: await healthOf(registry.resolve(c.name)),
                            })),
                        );
                        return ok({
                            file: connectionsFile(),
                            ...(registry.problem ? { problem: registry.problem } : {}),
                            rejected: registry.rejected,
                            connections,
                        });
                    }
                    case 'locate':
                        return ok(await locate(need(args.hint, 'hint')));
                    case 'signin':
                        return ok(
                            await setupSession.signin({
                                method: args.method ?? 'browser',
                                ...(args.restart ? { restart: true } : {}),
                                ...(args.tenantId ? { tenantId: args.tenantId } : {}),
                                ...(args.clientId ? { clientId: args.clientId } : {}),
                                ...(args.keychainService ? { keychainService: args.keychainService } : {}),
                                ...(args.keychainAccount ? { keychainAccount: args.keychainAccount } : {}),
                            }),
                        );
                    case 'environments': {
                        const token = setupSession.token();
                        try {
                            return ok({ value: await listEnvironments(token) });
                        } catch (err) {
                            return fail(new Error(explainListError(err, 'environments')));
                        }
                    }
                    case 'companies': {
                        const target = setupSession.target;
                        const token = setupSession.token();
                        const environment = need(args.environment, 'environment');
                        try {
                            return ok({ value: await listCompanies(token, target!.tenantId, environment) });
                        } catch (err) {
                            return fail(new Error(explainListError(err, 'companies', environment)));
                        }
                    }
                    case 'save': {
                        const name = need(args.name, 'name');
                        refuseEnv(name);
                        const target = setupSession.target;
                        try {
                            setupSession.token();
                        } catch {
                            throw new Error('Not signed in: sign in first (action signin), then save.');
                        }
                        const fields: Record<string, unknown> = {
                            tenantId: target!.tenantId,
                            environment: need(args.environment, 'environment'),
                            companyId: need(args.companyId, 'companyId'),
                            authMode: target!.method,
                            // Always written, even when it is the default client: a pre-2.4 server
                            // requires the field.
                            clientId: target!.clientId,
                            ...(target!.method === 'client_credentials'
                                ? { keychainService: target!.keychainService, keychainAccount: target!.keychainAccount }
                                : {}),
                        };
                        upsertConnection(name, fields, {
                            replace: args.replace ?? false,
                            makeDefault: args.makeDefault ?? false,
                            validate: (n, merged) => void validateConnectionEntry(n, merged),
                        });
                        const record = setupSession.authenticationRecord();
                        if (target!.method !== 'client_credentials' && record) {
                            writeAuthRecord(authRecordPath(name), record);
                            rmSync(authRecordPath(SETUP_SESSION_NAME), { force: true });
                        }
                        registry.reload();
                        const rejected = registry.rejected.find((r) => r.name === name);
                        if (rejected) throw new Error(`Saved, but the connection does not load: ${rejected.message}`);
                        return ok({ saved: name, health: await healthOf(registry.resolve(name)) });
                    }
                    case 'remove': {
                        const name = need(args.name, 'name');
                        refuseEnv(name);
                        const { defaultCleared } = removeConnection(name);
                        registry.reload();
                        return ok({
                            removed: name,
                            ...(defaultCleared ? { defaultCleared: true, next: 'Ask which connection becomes the default (setDefault).' } : {}),
                            connections: registry.list(),
                            current: registry.current(),
                        });
                    }
                    case 'setDefault': {
                        const name = need(args.name, 'name');
                        refuseEnv(name);
                        setDefaultConnection(name);
                        registry.reload();
                        return ok({ default: name, current: registry.current() });
                    }
                    case 'moveAsideBroken': {
                        const movedTo = moveAsideBroken();
                        registry.reload();
                        return ok({ movedTo });
                    }
                }
            } catch (err) {
                return fail(new Error(explainAuthError(err)));
            }
        },
    );

    return server;
}

export interface PageView {
    value: unknown[];
    nextLink: string | undefined;
    pagingMode: unknown;
    count: unknown;
}

/** A query response is either the bare value array or the OData wrapper with @nextLink. */
export function readPage(page: unknown): PageView {
    if (Array.isArray(page)) {
        return { value: page, nextLink: undefined, pagingMode: undefined, count: undefined };
    }
    if (typeof page === 'object' && page !== null) {
        const w = page as Record<string, unknown>;
        const value = Array.isArray(w.value) ? w.value : w.value === undefined ? [] : [w.value];
        const nextLink = typeof w['@nextLink'] === 'string' ? (w['@nextLink'] as string) : undefined;
        return { value, nextLink, pagingMode: w['@pagingMode'], count: w['@count'] };
    }
    return { value: [], nextLink: undefined, pagingMode: undefined, count: undefined };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const registry = ConnectionRegistry.load();
    const pool = new ClientPool(registry);
    const server = buildServer(pool, registry);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stdio servers communicate over stdout/stdin only; log to stderr.
    const cur = registry.current();
    process.stderr.write(
        `wicket-mcp ready — connections=${registry.list().map((c) => c.name).join(',') || '(none)'} ` +
            `current=${cur.name ?? '(none)'}` +
            (registry.problem ? ` problem=${registry.problem.kind}` : '') +
            (registry.rejected.length ? ` rejected=${registry.rejected.map((r) => r.name).join(',')}` : '') +
            '\n',
    );
}

// Start only when executed as the entrypoint (`bun run src/index.ts`, the `wicket-mcp` bin).
// Importing this module — as the test suite does to reach the exported client, pool, and
// buildServer — must not open a stdio transport or read the operator's connections.
if (import.meta.main) {
    main().catch((err) => {
        process.stderr.write(`wicket-mcp failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    });
}
