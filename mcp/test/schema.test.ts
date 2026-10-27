/**
 * Schema knowledge: the describe cache (revalidated with ifNoneMatch), the describe summary, the
 * discover publisher filter, and the per-connection tenant map. Cache and config dirs are per-test
 * temp directories (sandboxEnv), never the operator's home.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, type ConnectionRegistry } from '../src/connections.ts';
import { MAP_MAX_BYTES, parseSections } from '../src/schemaKnowledge.ts';
import {
    COMPANY_B,
    FetchStub,
    TempDir,
    entry,
    jsonResponse,
    loadRegistry,
    odata,
    sandboxEnv,
    startServer,
    toolIsError,
    toolJsonAs,
    type RecordedRequest,
    type ServerHarness,
} from './helpers.ts';

const CUSTOMER = {
    tableId: 18,
    name: 'Customer',
    captionML: { ENU: 'Customer' },
    app: { id: '437dbf0e-84ff-417a-965d-ed2bb9650972', name: 'Base Application', publisher: 'Microsoft', version: '26.0.0.0' },
    schemaVersion: '1.0',
    primaryKey: ['No.'],
    fields: [
        { no: 1, name: 'No.', type: 'Code', length: 20, class: 'Normal', readable: true, writable: true, access: 'clear', isPrimary: true, captionML: { ENU: 'No.' } },
        { no: 2, name: 'Name', type: 'Text', length: 100, class: 'Normal', readable: true, writable: true, access: 'clear', captionML: { ENU: 'Name' } },
        { no: 102, name: 'E-Mail', type: 'Text', length: 80, class: 'Normal', readable: true, writable: false, access: 'masked', mask: { profile: 'EMAIL', kind: 'email' }, filterable: false, sortable: false },
        { no: 22, name: 'Customer Posting Group', type: 'Code', length: 20, class: 'Normal', readable: true, writable: true, access: 'clear', tableRelation: [{ tableId: 92, fieldNo: 1 }] },
        { no: 39, name: 'Blocked', type: 'Option', class: 'Normal', readable: true, writable: true, access: 'clear', optionMembers: [{ ord: 0, name: ' ' }, { ord: 1, name: 'Ship' }] },
        { no: 59, name: 'Balance (LCY)', type: 'Decimal', class: 'FlowField', readable: true, writable: false, access: 'clear' },
    ],
    keys: [{ fields: ['No.'], clustered: true, isPrimary: true }, { fields: ['Name'], clustered: false }],
    hasSystemFields: true,
    apiRoutes: [],
    permissions: { read: true, insert: false, modify: false, delete: false },
};

let restoreEnv: () => void;
let tmp: TempDir;
let stub: FetchStub;
let registry: ConnectionRegistry;
let harness: ServerHarness;
/** What the scripted Wicket answers; tests adjust these. */
let describeVersion: string;
let structureVersion: string | undefined;
let capabilitiesFails: boolean;

const opOf = (req: RecordedRequest) => req.url.slice(req.url.lastIndexOf('.') + 1);
const dataOf = (req: RecordedRequest) => (req.json as { data: Record<string, unknown> }).data;
const describeCalls = () => stub.rpcRequests.filter((r) => opOf(r) === 'describe');

beforeEach(async () => {
    restoreEnv = sandboxEnv({ WICKET_TEST_SECRET: 's3cret' });
    tmp = new TempDir();
    describeVersion = 'dv1';
    structureVersion = 'sv1';
    capabilitiesFails = false;
    stub = new FetchStub().install();
    stub.route(/login\.microsoftonline\.com\//, () => jsonResponse({ access_token: 'tok', expires_in: 3600 })).rpc((req) => {
        const data = dataOf(req);
        switch (opOf(req)) {
            case 'describe': {
                if (data.kind !== 'table') return odata({ value: { kind: data.kind, passthrough: true } });
                if (data.ifNoneMatch === describeVersion) {
                    return odata({ value: { tableId: data.tableId, describeVersion, notModified: true } });
                }
                const include = data.include as { referencedBy?: boolean } | undefined;
                const referencedBy = include?.referencedBy
                    ? { referencedBy: [{ tableId: 21, tableName: 'Cust. Ledger Entry', fieldNo: 3, fieldName: 'Customer No.' }] }
                    : {};
                return odata({ value: { ...CUSTOMER, ...referencedBy, describeVersion } });
            }
            case 'discover':
                return odata({ value: [{ id: 50110, name: 'Contoso Contract', scope: 'table', app: { id: 'a', name: 'Contoso Contracts', publisher: 'Contoso', version: '1.0.0.0' } }] });
            case 'capabilities':
                if (capabilitiesFails) return odata({ type: 'https://wicket.example/errors/internal', title: 'Internal', status: 500, detail: 'boom' });
                return odata({ value: { product: 'Wicket', ...(structureVersion ? { structureVersion } : {}) } });
        }
        throw new Error(`unscripted RPC ${opOf(req)}`);
    });
    registry = loadRegistry(tmp, {
        default: 'prod',
        connections: {
            prod: entry({ tenantId: 'tenant-prod' }),
            sandbox: entry({ tenantId: 'tenant-prod', companyId: COMPANY_B }),
        },
    });
    harness = await startServer(registry);
});

afterEach(async () => {
    await harness.close();
    stub.uninstall();
    tmp.cleanup();
    restoreEnv();
});

const call = (name: string, args: Record<string, unknown> = {}) => harness.client.callTool({ name, arguments: args });

// ---------------------------------------------------------------------------
// wicket_describe cache
// ---------------------------------------------------------------------------

describe('wicket_describe cache', () => {
    test('first call fetches and persists; second call revalidates with ifNoneMatch and serves the cached answer', async () => {
        const first = toolJsonAs<{ fromCache: boolean; value: { name: string; describeVersion: string } }>(
            await call('wicket_describe', { kind: 'table', tableId: 18 }),
        );
        expect(first.fromCache).toBe(false);
        expect(first.value.name).toBe('Customer');
        expect(dataOf(describeCalls()[0]!).ifNoneMatch).toBeUndefined();
        expect(readdirSync(process.env.WICKET_CACHE_DIR!).some((f) => f.startsWith('describe-'))).toBe(true);

        const second = toolJsonAs<{ fromCache: boolean; value: { name: string; fields: unknown[] } }>(
            await call('wicket_describe', { kind: 'table', tableId: 18 }),
        );
        expect(dataOf(describeCalls()[1]!)).toMatchObject({ kind: 'table', tableId: 18, ifNoneMatch: 'dv1' });
        expect(second.fromCache).toBe(true);
        expect(second.value.name).toBe('Customer');
        expect(second.value.fields).toHaveLength(CUSTOMER.fields.length);
    });

    test('a changed answer (new describeVersion) replaces the cache', async () => {
        await call('wicket_describe', { kind: 'table', tableId: 18 });
        describeVersion = 'dv2';
        const changed = toolJsonAs<{ fromCache: boolean; value: { describeVersion: string } }>(
            await call('wicket_describe', { kind: 'table', tableId: 18 }),
        );
        expect(changed.fromCache).toBe(false);
        expect(changed.value.describeVersion).toBe('dv2');
        await call('wicket_describe', { kind: 'table', tableId: 18 });
        expect(dataOf(describeCalls()[2]!).ifNoneMatch).toBe('dv2');
    });

    test('the cache survives a server restart (disk) and is keyed per connection', async () => {
        await call('wicket_describe', { kind: 'table', tableId: 18 });
        await harness.close();
        harness = await startServer(registry);
        const again = toolJsonAs<{ fromCache: boolean }>(await call('wicket_describe', { kind: 'table', tableId: 18 }));
        expect(again.fromCache).toBe(true);
        // Another connection (other company) holds no copy yet: it fetches without ifNoneMatch.
        await call('wicket_describe', { kind: 'table', tableId: 18, connection: 'sandbox' });
        expect(dataOf(describeCalls().at(-1)!).ifNoneMatch).toBeUndefined();
    });

    test('languages and referencedBy are part of the key; referencedBy maps to include.referencedBy', async () => {
        await call('wicket_describe', { kind: 'table', tableId: 18 });
        const withRefs = toolJsonAs<{ fromCache: boolean; value: { referencedBy: unknown[] } }>(
            await call('wicket_describe', { kind: 'table', tableId: 18, referencedBy: true }),
        );
        const sent = dataOf(describeCalls()[1]!);
        expect(sent.include).toEqual({ referencedBy: true });
        expect(sent.ifNoneMatch).toBeUndefined();
        expect(sent.referencedBy).toBeUndefined();
        expect(withRefs.fromCache).toBe(false);
        expect(withRefs.value.referencedBy).toHaveLength(1);
        await call('wicket_describe', { kind: 'table', tableId: 18, languages: ['DEU'] });
        expect(dataOf(describeCalls()[2]!).ifNoneMatch).toBeUndefined();
    });

    test('summary returns the compact view', async () => {
        const out = toolJsonAs<{ summary: boolean; fromCache: boolean; value: Record<string, unknown> }>(
            await call('wicket_describe', { kind: 'table', tableId: 18, summary: true, referencedBy: true }),
        );
        expect(out.summary).toBe(true);
        expect(dataOf(describeCalls()[0]!).summary).toBeUndefined();
        expect(out.value).toEqual({
            tableId: 18,
            name: 'Customer',
            caption: 'Customer',
            app: CUSTOMER.app,
            primaryKey: ['No.'],
            keys: [{ fields: ['No.'], clustered: true }, { fields: ['Name'] }],
            fields: [
                { no: 1, name: 'No.', type: 'Code', length: 20 },
                { no: 2, name: 'Name', type: 'Text', length: 100 },
                { no: 102, name: 'E-Mail', type: 'Text', length: 80, access: 'masked', writable: false },
                { no: 22, name: 'Customer Posting Group', type: 'Code', length: 20, relation: '92.1' },
                { no: 39, name: 'Blocked', type: 'Option', options: { '0': ' ', '1': 'Ship' } },
                { no: 59, name: 'Balance (LCY)', type: 'Decimal', class: 'FlowField', writable: false },
            ],
            referencedBy: [{ tableId: 21, tableName: 'Cust. Ledger Entry', fieldNo: 3, fieldName: 'Customer No.' }],
            describeVersion: 'dv1',
        });
    });

    test('an endpoint without describeVersion is passed through and never cached', async () => {
        describeVersion = '';
        await call('wicket_describe', { kind: 'table', tableId: 18 });
        await call('wicket_describe', { kind: 'table', tableId: 18 });
        expect(dataOf(describeCalls()[1]!).ifNoneMatch).toBeUndefined();
    });

    test('codeunit and api kinds pass straight through without table-only members', async () => {
        const out = toolJsonAs<{ value: { passthrough: boolean } }>(
            await call('wicket_describe', { kind: 'codeunit', codeunitId: 94190, summary: true, referencedBy: true }),
        );
        expect(out.value.passthrough).toBe(true);
        const sent = dataOf(describeCalls()[0]!);
        expect(sent).toEqual({ kind: 'codeunit', codeunitId: 94190 });
    });
});

// ---------------------------------------------------------------------------
// wicket_discover publisher
// ---------------------------------------------------------------------------

describe('wicket_discover publisher', () => {
    test('passes publisher through to discover', async () => {
        const out = toolJsonAs<{ value: Array<{ app: { publisher: string } }> }>(
            await call('wicket_discover', { kind: 'tables', publisher: '<>Microsoft' }),
        );
        const sent = dataOf(stub.rpcRequests.find((r) => opOf(r) === 'discover')!);
        expect(sent).toEqual({ kind: 'tables', publisher: '<>Microsoft' });
        expect(out.value[0]!.app.publisher).toBe('Contoso');
    });
});

// ---------------------------------------------------------------------------
// wicket_map
// ---------------------------------------------------------------------------

type MapRead = {
    connection: string;
    content: string;
    sections: string[];
    stale: boolean | null;
    structureVersionAtWrite: string | null;
    currentStructureVersion: string | null;
    hint?: string;
    warning?: string;
};

describe('wicket_map', () => {
    test('an empty map reads as empty with a hint', async () => {
        const out = toolJsonAs<MapRead>(await call('wicket_map', { action: 'read' }));
        expect(out.content).toBe('');
        expect(out.sections).toEqual([]);
        expect(out.stale).toBeNull();
        expect(out.currentStructureVersion).toBe('sv1');
        expect(out.hint).toContain('<>Microsoft');
    });

    test('upsert creates, replaces and appends sections, stamping the structureVersion', async () => {
        const created = toolJsonAs<{ created: boolean; structureVersionAtWrite: string }>(
            await call('wicket_map', { action: 'upsert', section: '50110 Contoso Contract', content: 'Business key: Contract No.\nJoins Customer via Customer No.' }),
        );
        expect(created).toMatchObject({ created: true, structureVersionAtWrite: 'sv1' });
        await call('wicket_map', { action: 'upsert', section: '18 Customer', content: 'Blocked " " = not blocked.' });
        const replaced = toolJsonAs<{ created: boolean }>(
            await call('wicket_map', { action: 'upsert', section: '50110 Contoso Contract', content: '## 50110 Contoso Contract\nBusiness key: Contract No. (PK is Entry No.)' }),
        );
        expect(replaced.created).toBe(false);

        const out = toolJsonAs<MapRead>(await call('wicket_map', { action: 'read' }));
        expect(out.sections).toEqual(['50110 Contoso Contract', '18 Customer']);
        expect(out.content).toContain('PK is Entry No.');
        expect(out.content).not.toContain('Joins Customer');
        expect(out.stale).toBe(false);
        expect(parseSections(out.content).find((s) => s.name === '50110 Contoso Contract')!.body).toBe('Business key: Contract No. (PK is Entry No.)');
        expect(existsSync(join(configPath('maps'), 'prod.md'))).toBe(true);
    });

    test('read reports stale when the apps changed since the last write', async () => {
        await call('wicket_map', { action: 'upsert', section: 'Notes', content: 'x' });
        structureVersion = 'sv2';
        const out = toolJsonAs<MapRead>(await call('wicket_map', { action: 'read' }));
        expect(out).toMatchObject({ stale: true, structureVersionAtWrite: 'sv1', currentStructureVersion: 'sv2' });
    });

    test('read still returns the map when capabilities fails, with staleness unknown', async () => {
        await call('wicket_map', { action: 'upsert', section: 'Notes', content: 'x' });
        capabilitiesFails = true;
        const out = toolJsonAs<MapRead>(await call('wicket_map', { action: 'read' }));
        expect(out.sections).toEqual(['Notes']);
        expect(out.stale).toBeNull();
        expect(out.warning).toContain('structureVersion unavailable');
    });

    test('remove deletes a section and refuses an unknown one', async () => {
        await call('wicket_map', { action: 'upsert', section: 'A', content: 'a' });
        await call('wicket_map', { action: 'upsert', section: 'B', content: 'b' });
        await call('wicket_map', { action: 'remove', section: 'A' });
        const out = toolJsonAs<MapRead>(await call('wicket_map', { action: 'read' }));
        expect(out.sections).toEqual(['B']);
        const missing = await call('wicket_map', { action: 'remove', section: 'A' });
        expect(toolIsError(missing)).toBe(true);
        expect(toolJsonAs<{ type: string; detail: string }>(missing)).toMatchObject({ type: 'https://wicket.example/errors/map-invalid' });
    });

    test('validates section names and content', async () => {
        for (const section of ['', 'two\nlines', '## Heading', 'x'.repeat(201)]) {
            expect(toolIsError(await call('wicket_map', { action: 'upsert', section, content: 'c' }))).toBe(true);
        }
        expect(toolIsError(await call('wicket_map', { action: 'upsert', section: 'A', content: 'one\n## sneaky second section' }))).toBe(true);
        expect(toolIsError(await call('wicket_map', { action: 'upsert', section: 'A' }))).toBe(true);
        expect(toolIsError(await call('wicket_map', { action: 'remove' }))).toBe(true);
    });

    test('refuses a write that would exceed the size cap and leaves the map unchanged', async () => {
        await call('wicket_map', { action: 'upsert', section: 'Small', content: 'keep me' });
        const big = await call('wicket_map', { action: 'upsert', section: 'Big', content: 'x'.repeat(MAP_MAX_BYTES) });
        expect(toolIsError(big)).toBe(true);
        expect(toolJsonAs<{ detail: string }>(big).detail).toContain('cap');
        const out = toolJsonAs<MapRead>(await call('wicket_map', { action: 'read' }));
        expect(out.sections).toEqual(['Small']);
    });

    test('maps are per connection', async () => {
        await call('wicket_map', { action: 'upsert', section: 'Prod only', content: 'p' });
        const other = toolJsonAs<MapRead>(await call('wicket_map', { action: 'read', connection: 'sandbox' }));
        expect(other.connection).toBe('sandbox');
        expect(other.sections).toEqual([]);
        expect(readFileSync(join(configPath('maps'), 'prod.md'), 'utf8')).toContain('## Prod only');
    });
});
