/**
 * API-first reads: the tenant's own API catalog, cached, and the governance pre-check that decides
 * whether one read may go through an API page instead of Wicket's dynamic plane.
 *
 * Two kinds of knowledge, kept apart on purpose:
 *
 *   STRUCTURE  which API pages/queries exist, their routes, source tables, operations. It changes only
 *              when apps are installed, upgraded or removed, so it is cached in memory and on disk
 *              (one file per environment — the catalog is per environment, not per company) and
 *              revalidated with ONE call: discover kind "apis" + ifNoneMatch=<cached catalogVersion>.
 *
 *   GOVERNANCE whether Wicket lets THIS caller read through an API right now (routable) and which of its
 *              fields (readable). It follows the exposure allowlist, the field policy and the API
 *              Routing switch, so it is NEVER cached: wicket_api_read asks describe kind "api" fresh on
 *              every call, and refuses when Wicket would.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { configPath, envSetting } from './connections.js';

// ---------------------------------------------------------------------------
// catalog structure + cache
// ---------------------------------------------------------------------------

export interface ApiEntry {
    id: number;
    apiKind: 'page' | 'query';
    name?: string;
    entitySetName: string;
    entityName?: string;
    /** Preferred route, e.g. "v2.0/customers" or "microsoft/automation/v2.0/companies". */
    route: string;
    routes?: string[];
    sourceTableId?: number;
    operations?: Record<string, boolean>;
}

export interface CatalogSnapshot {
    environmentKey: string;
    catalogVersion: string;
    fetchedAt: string;
    entries: ApiEntry[];
}

export type CatalogSource = 'memory' | 'revalidated' | 'server';

export interface CatalogResult {
    snapshot: CatalogSnapshot;
    source: CatalogSource;
    /** The routing mode Wicket reported on the call that loaded or revalidated the catalog. */
    apiRouting?: string;
}

/** The slice of WicketClient the cache needs (a test seam, and keeps this module transport-free). */
export interface CatalogClient {
    readonly environmentKey: string;
    call(operation: string, data: Record<string, unknown>): Promise<unknown>;
}

/** Page size for a full catalog fetch; Wicket caps top at its Max Top (1000 by default). */
const FETCH_PAGE = 1000;
/** A runaway guard: the standard catalog is a few hundred rows. */
const MAX_FETCH_PAGES = 50;

/** $WICKET_CACHE_DIR, else ~/.config/wicket/cache. */
export function cacheDir(): string {
    return envSetting('CACHE_DIR') || configPath('cache');
}

export class ApiCatalogCache {
    private readonly memory = new Map<string, { snapshot: CatalogSnapshot; apiRouting?: string }>();

    /**
     * The catalog for the client's environment. First use in this process revalidates (the disk copy
     * if there is one, with one cheap call) or fetches; later uses are served from memory until
     * `refresh` is passed or `invalidate` is called (wicket_api_read calls it when a describe reports a
     * different catalogVersion than the cached one).
     */
    async get(client: CatalogClient, refresh = false): Promise<CatalogResult> {
        const key = client.environmentKey;
        const inMemory = this.memory.get(key);
        if (inMemory && !refresh) return { ...inMemory, source: 'memory' };

        const onDisk = refresh ? undefined : readSnapshot(key);
        if (onDisk) {
            const answer = asRecord(await client.call('discover', { kind: 'apis', ifNoneMatch: onDisk.catalogVersion }));
            const apiRouting = asString(answer.apiRouting);
            if (answer.notModified === true) {
                this.memory.set(key, { snapshot: onDisk, apiRouting });
                return { snapshot: onDisk, source: 'revalidated', apiRouting };
            }
        }

        const { snapshot, apiRouting } = await fetchCatalog(client);
        writeSnapshot(snapshot);
        this.memory.set(key, { snapshot, apiRouting });
        return { snapshot, source: 'server', apiRouting };
    }

    /** The cached version for an environment, if any (memory only). */
    versionOf(environmentKey: string): string | undefined {
        return this.memory.get(environmentKey)?.snapshot.catalogVersion;
    }

    invalidate(environmentKey: string): void {
        this.memory.delete(environmentKey);
    }
}

async function fetchCatalog(client: CatalogClient): Promise<{ snapshot: CatalogSnapshot; apiRouting?: string }> {
    const entries: ApiEntry[] = [];
    let version = '';
    let apiRouting: string | undefined;
    let skip = 0;
    for (let page = 0; page < MAX_FETCH_PAGES; page++) {
        const answer = asRecord(await client.call('discover', { kind: 'apis', top: FETCH_PAGE, ...(skip > 0 ? { skip } : {}) }));
        const rows = Array.isArray(answer.value) ? answer.value : [];
        for (const row of rows) {
            const entry = toEntry(row);
            if (entry) entries.push(entry);
        }
        // A version that moves mid-fetch means apps changed under us: start over once from scratch.
        const pageVersion = asString(answer.catalogVersion) ?? '';
        if (page > 0 && pageVersion !== version) {
            return fetchCatalog(client);
        }
        version = pageVersion;
        apiRouting = asString(answer.apiRouting) ?? apiRouting;
        const next = answer['@nextSkip'];
        if (typeof next !== 'number' || rows.length === 0) break;
        skip = next;
    }
    return {
        snapshot: {
            environmentKey: client.environmentKey,
            catalogVersion: version,
            fetchedAt: new Date().toISOString(),
            entries,
        },
        apiRouting,
    };
}

function toEntry(row: unknown): ApiEntry | undefined {
    const r = asRecord(row);
    if (typeof r.id !== 'number' || typeof r.route !== 'string' || typeof r.entitySetName !== 'string') return undefined;
    return {
        id: r.id,
        apiKind: r.apiKind === 'query' ? 'query' : 'page',
        name: asString(r.name),
        entitySetName: r.entitySetName,
        entityName: asString(r.entityName),
        route: r.route,
        routes: Array.isArray(r.routes) ? r.routes.filter((x): x is string => typeof x === 'string') : undefined,
        sourceTableId: typeof r.sourceTableId === 'number' ? r.sourceTableId : undefined,
        operations: typeof r.operations === 'object' && r.operations !== null ? (r.operations as Record<string, boolean>) : undefined,
    };
}

function snapshotPath(environmentKey: string): string {
    // The key holds a tenant and environment (and a custom base URL when one is set); hash it so the
    // file name is always safe and does not spell out the tenant.
    const digest = createHash('sha256').update(environmentKey).digest('hex').slice(0, 32);
    return join(cacheDir(), `apis-${digest}.json`);
}

function readSnapshot(environmentKey: string): CatalogSnapshot | undefined {
    try {
        const parsed = JSON.parse(readFileSync(snapshotPath(environmentKey), 'utf8')) as CatalogSnapshot;
        if (parsed.environmentKey !== environmentKey || typeof parsed.catalogVersion !== 'string' || !Array.isArray(parsed.entries)) {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined; // no file, unreadable, or not JSON: fetch afresh
    }
}

function writeSnapshot(snapshot: CatalogSnapshot): void {
    try {
        const path = snapshotPath(snapshot.environmentKey);
        mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
        // Write-then-rename, so a concurrent reader never sees a half-written file.
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
        renameSync(temp, path);
    } catch (err) {
        // The disk copy is an optimisation: a read-only home directory must not fail the tool.
        process.stderr.write(`[wicket-mcp] could not write the API catalog cache: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}

// ---------------------------------------------------------------------------
// catalog views for wicket_apis
// ---------------------------------------------------------------------------

/** Route prefix = everything before the entity set: "v2.0", "microsoft/automation/v2.0". */
export function routePrefix(route: string): string {
    const cut = route.lastIndexOf('/');
    return cut < 0 ? '' : route.slice(0, cut);
}

export function summarizeGroups(entries: ApiEntry[]): Array<{ prefix: string; count: number }> {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(routePrefix(e.route), (counts.get(routePrefix(e.route)) ?? 0) + 1);
    return [...counts.entries()].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => a.prefix.localeCompare(b.prefix));
}

export function filterEntries(
    entries: ApiEntry[],
    opts: { tableId?: number; search?: string; group?: string },
): ApiEntry[] {
    const needle = opts.search?.toLowerCase();
    return entries.filter(
        (e) =>
            (opts.tableId === undefined || e.sourceTableId === opts.tableId) &&
            (opts.group === undefined || routePrefix(e.route) === opts.group) &&
            (needle === undefined ||
                e.entitySetName.toLowerCase().includes(needle) ||
                (e.name ?? '').toLowerCase().includes(needle) ||
                (e.entityName ?? '').toLowerCase().includes(needle)),
    );
}

// ---------------------------------------------------------------------------
// governance pre-check for wicket_api_read
// ---------------------------------------------------------------------------

/** The describe kind "api" answer, as far as the pre-check reads it. */
export interface ApiDescription {
    id: number;
    route: string;
    entitySetName: string;
    sourceTableId?: number;
    routable: boolean;
    notRoutableReason?: string;
    catalogVersion?: string;
    fields: Array<{ name: string; mapped?: boolean; readable?: boolean }>;
}

/** Accepts the describe answer as it arrives on the wire, `{ value: { ... } }`, or the bare object. */
export function asApiDescription(answer: unknown): ApiDescription {
    const outer = asRecord(answer);
    const v = typeof outer.value === 'object' && outer.value !== null && !Array.isArray(outer.value) ? asRecord(outer.value) : outer;
    const fields = Array.isArray(v.fields)
        ? v.fields.map((f) => asRecord(f)).filter((f) => typeof f.name === 'string').map((f) => ({
              name: f.name as string,
              mapped: f.mapped === true,
              readable: f.readable === true,
          }))
        : [];
    return {
        id: typeof v.id === 'number' ? v.id : 0,
        route: asString(v.route) ?? '',
        entitySetName: asString(v.entitySetName) ?? '',
        sourceTableId: typeof v.sourceTableId === 'number' ? v.sourceTableId : undefined,
        routable: v.routable === true,
        notRoutableReason: asString(v.notRoutableReason),
        catalogVersion: asString(v.catalogVersion),
        fields,
    };
}

export interface ApiReadRequest {
    select?: string[];
    filter?: string;
    orderBy?: string[];
}

export interface ApiReadPlan {
    select: string[];
    filter?: string;
    orderBy?: string[];
}

/** A refusal in problem terms; the caller wraps it into an RFC 7807 document. */
export interface PlanRefusal {
    slug: string;
    status: number;
    title: string;
    detail: string;
    suggest?: Record<string, unknown>;
}

/**
 * Decide what one API read may ask for, under the governance describe just reported. Every field the
 * read touches — selected, filtered on or ordered by — must be an API field Wicket marks readable. With
 * no select, the read selects exactly the readable fields, so a restricted field is never fetched.
 */
export function planApiRead(api: ApiDescription, req: ApiReadRequest): ApiReadPlan | PlanRefusal {
    if (!api.routable) {
        const reason = api.notRoutableReason ?? 'not-routable';
        return {
            slug: 'api-not-routable',
            status: 403,
            title: 'API read not allowed',
            detail:
                reason === 'routing-off'
                    ? 'API routing is Off in Wicket Setup, so reads go through the dynamic plane. Use wicket_query on the source table.'
                    : reason === 'not-exposed'
                      ? `Wicket does not let this caller read table ${api.sourceTableId ?? '?'} (exposure allowlist or BC permissions), so its API cannot be used either.`
                      : `This API cannot be pre-checked against Wicket's field policy (${reason}). Use wicket_query on the source table.`,
            suggest: { use: 'wicket_query', ...(api.sourceTableId !== undefined ? { tableId: api.sourceTableId } : {}), reason },
        };
    }
    const all = new Set(api.fields.map((f) => f.name));
    const readable = new Set(api.fields.filter((f) => f.readable).map((f) => f.name));

    const check = (name: string, where: string): PlanRefusal | undefined => {
        if (!all.has(name)) {
            return {
                slug: 'unknown-api-field',
                status: 400,
                title: 'Unknown API field',
                detail: `"${name}" (in ${where}) is not a field of ${api.route}.`,
                suggest: { fields: [...readable].sort() },
            };
        }
        if (!readable.has(name)) {
            return {
                slug: 'field-restricted',
                status: 403,
                title: 'Field access restricted',
                detail: `"${name}" (in ${where}) is not readable under Wicket's field policy, or is computed by the API and cannot be checked against it.`,
                suggest: { fields: [...readable].sort() },
            };
        }
        return undefined;
    };

    let select: string[];
    if (req.select && req.select.length > 0) {
        for (const name of req.select) {
            const refusal = check(name, 'select');
            if (refusal) return refusal;
        }
        select = [...new Set(req.select)];
    } else {
        select = api.fields.filter((f) => f.readable).map((f) => f.name);
        if (select.length === 0) {
            return {
                slug: 'field-restricted',
                status: 403,
                title: 'No readable fields',
                detail: `None of ${api.route}'s fields is readable under Wicket's field policy.`,
                suggest: { use: 'wicket_query', ...(api.sourceTableId !== undefined ? { tableId: api.sourceTableId } : {}) },
            };
        }
    }

    let filter: string | undefined;
    if (req.filter !== undefined && req.filter.trim() !== '') {
        const scan = scanFilter(req.filter);
        if ('error' in scan) {
            return { slug: 'invalid-filter', status: 400, title: 'Filter not allowed', detail: scan.error };
        }
        for (const name of scan.identifiers) {
            // A name that IS a field is always checked, even when it doubles as a function or operator
            // name ("date", "length"): skipping it would let a filter probe a restricted field.
            if (!all.has(name) && FILTER_KEYWORDS.has(name.toLowerCase())) continue;
            const refusal = check(name, 'filter');
            if (refusal) return refusal;
        }
        filter = req.filter;
    }

    let orderBy: string[] | undefined;
    if (req.orderBy && req.orderBy.length > 0) {
        orderBy = [];
        for (const term of req.orderBy) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+(asc|desc))?\s*$/i.exec(term);
            if (!m) {
                return { slug: 'invalid-orderby', status: 400, title: 'Invalid orderBy', detail: `"${term}" is not "<field> [asc|desc]".` };
            }
            const refusal = check(m[1]!, 'orderBy');
            if (refusal) return refusal;
            orderBy.push(m[2] ? `${m[1]} ${m[2].toLowerCase()}` : m[1]!);
        }
    }

    return { select, filter, orderBy };
}

export function isRefusal(x: ApiReadPlan | PlanRefusal): x is PlanRefusal {
    return 'slug' in x;
}

/**
 * OData operators, literals and the string/date functions a flat $filter may use. Anything else that
 * looks like a name must be a field of the API (and is then checked against the field policy).
 */
const FILTER_KEYWORDS = new Set([
    'and', 'or', 'not', 'in', 'eq', 'ne', 'gt', 'ge', 'lt', 'le', 'true', 'false', 'null',
    'contains', 'startswith', 'endswith', 'tolower', 'toupper', 'length', 'indexof', 'substring', 'trim',
    'concat', 'year', 'month', 'day', 'hour', 'minute', 'second', 'date', 'time',
]);

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const NUMBER_OR_DATE = /^[0-9][0-9A-Za-z.:+-]*/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Tokenise a $filter just far enough to find every name it references. String literals are skipped
 * (with OData's doubled-apostrophe escape), GUID and number/date literals are consumed whole. Refused
 * outright: navigation and lambdas ("/", which is how a filter would reach a related entity the
 * pre-check has not seen) and an unterminated string.
 */
export function scanFilter(filter: string): { identifiers: string[] } | { error: string } {
    const identifiers: string[] = [];
    let i = 0;
    while (i < filter.length) {
        const ch = filter[i]!;
        if (ch === "'") {
            i++;
            for (;;) {
                if (i >= filter.length) return { error: 'the filter has an unterminated string literal' };
                if (filter[i] === "'") {
                    if (filter[i + 1] === "'") {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === '/') {
            return { error: 'navigation and lambda expressions ("/") are not allowed in an API read filter; filter on this API\'s own fields' };
        }
        const rest = filter.slice(i);
        const guid = GUID.exec(rest);
        if (guid) {
            i += guid[0].length;
            continue;
        }
        const num = NUMBER_OR_DATE.exec(rest);
        if (num) {
            i += num[0].length;
            continue;
        }
        const ident = IDENTIFIER.exec(rest);
        if (ident) {
            identifiers.push(ident[0]);
            i += ident[0].length;
            continue;
        }
        i++; // whitespace, parentheses, commas, signs
    }
    return { identifiers };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
