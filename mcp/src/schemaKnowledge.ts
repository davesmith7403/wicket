/**
 * Schema knowledge: the describe cache, the compact describe summary, and the tenant map.
 *
 *   DESCRIBE CACHE  describe kind "table" answers, persisted per connection (a describe depends on the
 *                   caller's field policy and BC permissions, so the key is the connection, not the
 *                   environment). Every call still asks Wicket, with ifNoneMatch=<cached describeVersion>;
 *                   Wicket hashes its own answer, so an unchanged answer costs one fingerprint and a
 *                   changed policy is never served stale. The win is bandwidth and a stable copy for the
 *                   summary view, never a skipped check.
 *
 *   SUMMARY         a compact rendering of one describe answer: what an agent needs to query and join
 *                   (keys, field names and types, relations), without captionML or option captions.
 *
 *   TENANT MAP      what an agent has learned about a tenant that describe cannot say: what a solution
 *                   table is for, its business key, how it joins, gotchas. One Markdown file per
 *                   connection, sections = "## " headings. It holds STRUCTURE ONLY — never record values:
 *                   the map is a local file, and a value written there would escape the field masking
 *                   the endpoint applies.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cacheDir } from './apiCatalog.js';
import { configPath } from './connections.js';

/** The slice of WicketClient the cache and map need. */
export interface KnowledgeClient {
    readonly connectionName: string;
    readonly cacheKey: string;
    call(operation: string, data: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// describe cache
// ---------------------------------------------------------------------------

interface CachedDescribe {
    describeVersion: string;
    value: Record<string, unknown>;
    fetchedAt: string;
}

interface DescribeCacheFile {
    cacheKey: string;
    entries: Record<string, CachedDescribe>;
}

/** Tables kept per connection; the oldest fetch is dropped beyond it. */
export const DESCRIBE_CACHE_MAX_ENTRIES = 500;

export interface DescribeRequest {
    tableId: number;
    languages?: string[];
    referencedBy?: boolean;
}

export interface DescribeResult {
    /** The full answer as Wicket returns it ({ value, @requestId, … }), value always the full table. */
    answer: Record<string, unknown>;
    fromCache: boolean;
}

export class DescribeCache {
    private readonly memory = new Map<string, DescribeCacheFile>();

    async get(client: KnowledgeClient, request: DescribeRequest, extra: Record<string, unknown> = {}): Promise<DescribeResult> {
        const file = this.load(client.cacheKey);
        const entryKey = describeEntryKey(request);
        const cached = file.entries[entryKey];
        const data: Record<string, unknown> = {
            ...extra,
            kind: 'table',
            tableId: request.tableId,
            ...(request.languages !== undefined ? { languages: request.languages } : {}),
            ...(request.referencedBy ? { include: { referencedBy: true } } : {}),
        };

        const answer = asRecord(await client.call('describe', cached ? { ...data, ifNoneMatch: cached.describeVersion } : data));
        const value = asRecord(answer.value);
        if (value.notModified === true) {
            if (cached) return { answer: { ...answer, value: cached.value }, fromCache: true };
            // Wicket says unchanged for a version we no longer hold (a concurrent eviction): ask again.
            return this.store(client.cacheKey, file, entryKey, asRecord(await client.call('describe', data)));
        }
        return this.store(client.cacheKey, file, entryKey, answer);
    }

    private store(cacheKey: string, file: DescribeCacheFile, entryKey: string, answer: Record<string, unknown>): DescribeResult {
        const value = asRecord(answer.value);
        const version = value.describeVersion;
        // An endpoint without describeVersion (older build) is passed through and never cached.
        if (typeof version === 'string' && version !== '') {
            file.entries[entryKey] = { describeVersion: version, value, fetchedAt: new Date().toISOString() };
            evictOldest(file.entries);
            this.memory.set(cacheKey, file);
            writeJson(describePath(cacheKey), file, 'describe cache');
        }
        return { answer, fromCache: false };
    }

    private load(cacheKey: string): DescribeCacheFile {
        const inMemory = this.memory.get(cacheKey);
        if (inMemory) return inMemory;
        let file: DescribeCacheFile = { cacheKey, entries: {} };
        try {
            const parsed = JSON.parse(readFileSync(describePath(cacheKey), 'utf8')) as DescribeCacheFile;
            if (parsed.cacheKey === cacheKey && typeof parsed.entries === 'object' && parsed.entries !== null) file = parsed;
        } catch {
            /* no file, unreadable or not JSON: start empty */
        }
        this.memory.set(cacheKey, file);
        return file;
    }
}

export function describeEntryKey(request: DescribeRequest): string {
    const langs = request.languages && request.languages.length > 0 ? request.languages.join(',') : '-';
    return `${request.tableId}|${langs}|${request.referencedBy ? 'ref' : '-'}`;
}

function evictOldest(entries: Record<string, CachedDescribe>): void {
    const keys = Object.keys(entries);
    if (keys.length <= DESCRIBE_CACHE_MAX_ENTRIES) return;
    keys.sort((a, b) => entries[a]!.fetchedAt.localeCompare(entries[b]!.fetchedAt));
    for (const key of keys.slice(0, keys.length - DESCRIBE_CACHE_MAX_ENTRIES)) delete entries[key];
}

function describePath(cacheKey: string): string {
    // The key spells out tenant, environment, company and connection: hash it into the file name.
    const digest = createHash('sha256').update(cacheKey).digest('hex').slice(0, 32);
    return join(cacheDir(), `describe-${digest}.json`);
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

/** The compact view of one describe kind "table" answer. */
export function summarizeDescribe(value: Record<string, unknown>): Record<string, unknown> {
    const fields = Array.isArray(value.fields) ? value.fields.map(asRecord) : [];
    const out: Record<string, unknown> = {
        tableId: value.tableId,
        name: value.name,
        caption: firstCaption(value.captionML),
        app: value.app ?? null,
        primaryKey: value.primaryKey,
        keys: Array.isArray(value.keys)
            ? value.keys.map(asRecord).map((k) => compactObject({ fields: k.fields, clustered: k.clustered === true ? true : undefined }))
            : undefined,
        fields: fields.map((f) =>
            compactObject({
                no: f.no ?? f.fieldNo,
                name: f.name,
                type: f.type,
                length: typeof f.length === 'number' && f.length > 0 ? f.length : undefined,
                class: f.class !== undefined && f.class !== 'Normal' ? f.class : undefined,
                access: f.access === 'masked' ? 'masked' : f.readable === false ? 'hidden' : undefined,
                writable: f.writable === false ? false : undefined,
                relation: relationOf(f.tableRelation),
                // Keyed by ordinal: enum extensions use ordinals such as 50000, so a positional list
                // would mislead the filter an agent writes ("Document Type" eq <ordinal>).
                options: Array.isArray(f.optionMembers)
                    ? Object.fromEntries(
                          f.optionMembers
                              .map(asRecord)
                              .filter((o) => typeof o.ord === 'number' && typeof o.name === 'string')
                              .map((o) => [String(o.ord), o.name as string]),
                      )
                    : undefined,
            }),
        ),
        referencedBy: value.referencedBy,
        referencedByTruncated: value.referencedByTruncated === true ? true : undefined,
        describeVersion: value.describeVersion,
    };
    return compactObject(out);
}

function firstCaption(captionML: unknown): string | undefined {
    const r = asRecord(captionML);
    for (const v of Object.values(r)) if (typeof v === 'string' && v !== '') return v;
    return undefined;
}

/** tableRelation is an array of { tableId, fieldNo? }; render "18" or "18.1", joined by "|". */
function relationOf(rel: unknown): string | undefined {
    if (!Array.isArray(rel) || rel.length === 0) return undefined;
    return rel
        .map(asRecord)
        .map((r) => (typeof r.fieldNo === 'number' ? `${r.tableId}.${r.fieldNo}` : `${r.tableId}`))
        .join('|');
}

function compactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
}

// ---------------------------------------------------------------------------
// tenant map
// ---------------------------------------------------------------------------

export const MAP_MAX_BYTES = 128 * 1024;
export const MAP_SECTION_MAX_LENGTH = 200;

interface MapMeta {
    structureVersionAtWrite?: string;
    updatedAt?: string;
}

export class TenantMapError extends Error {}

export interface MapReadResult {
    connection: string;
    content: string;
    sections: string[];
    updatedAt: string | null;
    structureVersionAtWrite: string | null;
    currentStructureVersion: string | null;
    /** true when the apps changed since the map was last written; null when either version is unknown. */
    stale: boolean | null;
}

/** maps/<connection>.md under the wicket config dir; connection names are [A-Za-z0-9._-]. */
export function mapPaths(connection: string): { md: string; meta: string } {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(connection)) throw new TenantMapError(`invalid connection name "${connection}"`);
    const dir = configPath('maps');
    return { md: join(dir, `${connection}.md`), meta: join(dir, `${connection}.meta.json`) };
}

/** The live structureVersion from capabilities, or null when the endpoint does not report one. */
export async function currentStructureVersion(client: KnowledgeClient): Promise<string | null> {
    const answer = asRecord(await client.call('capabilities', {}));
    const v = asRecord(answer.value).structureVersion ?? answer.structureVersion;
    return typeof v === 'string' && v !== '' ? v : null;
}

export function readMap(connection: string, current: string | null): MapReadResult {
    const { md, meta } = mapPaths(connection);
    const content = existsSync(md) ? readFileSync(md, 'utf8') : '';
    const m = readMeta(meta);
    const atWrite = m.structureVersionAtWrite ?? null;
    return {
        connection,
        content,
        sections: parseSections(content).map((s) => s.name),
        updatedAt: m.updatedAt ?? null,
        structureVersionAtWrite: atWrite,
        currentStructureVersion: current,
        stale: atWrite !== null && current !== null ? atWrite !== current : null,
    };
}

/** Replace the named section's body, or append it; returns whether it existed. */
export function upsertSection(connection: string, section: string, body: string, current: string | null): { created: boolean; bytes: number } {
    const name = validateSection(section);
    const { md, meta } = mapPaths(connection);
    const content = existsSync(md) ? readFileSync(md, 'utf8') : '';
    const { preamble, sections } = splitSections(content);
    const cleanBody = stripOwnHeading(body, name).replace(/\s+$/, '');
    if (/^## /m.test(cleanBody)) {
        throw new TenantMapError('section content must not contain "## " headings (one call per section; use ### inside a section)');
    }
    const existing = sections.find((s) => s.name === name);
    if (existing) existing.body = cleanBody;
    else sections.push({ name, body: cleanBody });
    const next = joinSections(preamble, sections);
    const bytes = Buffer.byteLength(next, 'utf8');
    if (bytes > MAP_MAX_BYTES) {
        throw new TenantMapError(
            `the map would be ${bytes} bytes, over the ${MAP_MAX_BYTES}-byte cap: tighten existing sections or remove stale ones first`,
        );
    }
    writeText(md, next);
    writeJson(meta, { structureVersionAtWrite: current ?? undefined, updatedAt: new Date().toISOString() } satisfies MapMeta, 'tenant map metadata', true);
    return { created: !existing, bytes };
}

export function removeSection(connection: string, section: string): { bytes: number } {
    const name = validateSection(section);
    const { md, meta } = mapPaths(connection);
    const content = existsSync(md) ? readFileSync(md, 'utf8') : '';
    const { preamble, sections } = splitSections(content);
    const index = sections.findIndex((s) => s.name === name);
    if (index < 0) throw new TenantMapError(`no section "${name}" in the map (sections: ${sections.map((s) => s.name).join(', ') || 'none'})`);
    sections.splice(index, 1);
    const next = joinSections(preamble, sections);
    writeText(md, next);
    // Removing does not re-verify anything, so the stamp from the last write stands.
    const m = readMeta(meta);
    writeJson(meta, { ...m, updatedAt: new Date().toISOString() }, 'tenant map metadata', true);
    return { bytes: Buffer.byteLength(next, 'utf8') };
}

function validateSection(section: string): string {
    const name = section.trim();
    if (name === '') throw new TenantMapError('section must not be empty');
    if (/[\r\n]/.test(name)) throw new TenantMapError('section must be a single line');
    if (name.length > MAP_SECTION_MAX_LENGTH) throw new TenantMapError(`section must be at most ${MAP_SECTION_MAX_LENGTH} characters`);
    if (name.startsWith('#')) throw new TenantMapError('section is the heading text without the leading "## "');
    return name;
}

function stripOwnHeading(body: string, name: string): string {
    const lines = body.replace(/^\s*\n/, '').split('\n');
    if (lines[0] !== undefined && lines[0].trim() === `## ${name}`) lines.shift();
    return lines.join('\n').replace(/^\n+/, '');
}

interface Section {
    name: string;
    body: string;
}

export function parseSections(content: string): Section[] {
    return splitSections(content).sections;
}

function splitSections(content: string): { preamble: string; sections: Section[] } {
    const lines = content.split('\n');
    const pre: string[] = [];
    const sections: Section[] = [];
    let current: { name: string; lines: string[] } | undefined;
    for (const line of lines) {
        const m = /^## (.+?)\s*$/.exec(line);
        if (m) {
            if (current) sections.push({ name: current.name, body: current.lines.join('\n').replace(/^\n+|\s+$/g, '') });
            current = { name: m[1]!.trim(), lines: [] };
        } else if (current) current.lines.push(line);
        else pre.push(line);
    }
    if (current) sections.push({ name: current.name, body: current.lines.join('\n').replace(/^\n+|\s+$/g, '') });
    return { preamble: pre.join('\n').replace(/\s+$/, ''), sections };
}

function joinSections(preamble: string, sections: Section[]): string {
    const parts: string[] = [];
    if (preamble !== '') parts.push(preamble);
    for (const s of sections) parts.push(s.body === '' ? `## ${s.name}` : `## ${s.name}\n\n${s.body}`);
    return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
}

function readMeta(path: string): MapMeta {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as MapMeta;
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// io
// ---------------------------------------------------------------------------

function writeText(path: string, text: string): void {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
}

/** Write-then-rename. A cache write is best effort; a map write (`strict`) must fail loudly. */
function writeJson(path: string, value: unknown, what: string, strict = false): void {
    try {
        writeText(path, JSON.stringify(value));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (strict) throw new TenantMapError(`could not write the ${what}: ${message}`);
        process.stderr.write(`[wicket-mcp] could not write the ${what}: ${message}\n`);
    }
}

function asRecord(v: unknown): Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
