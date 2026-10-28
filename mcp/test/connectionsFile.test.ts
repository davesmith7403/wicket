/**
 * Safe edits of connections.json: setup writes through these, so they must never lose a field,
 * an entry or an outside edit, and never touch a file they cannot read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionRegistry, authRecordPath, validateConnectionEntry } from '../src/connections.ts';
import {
    ConnectionsFileUnreadableError,
    moveAsideBroken,
    removeConnection,
    setDefaultConnection,
    upsertConnection,
} from '../src/connectionsFile.ts';
import { COMPANY_B, TempDir, entry, sandboxEnv } from './helpers.ts';

let restoreEnv: () => void;
let tmp: TempDir;
let file: string;

beforeEach(() => {
    restoreEnv = sandboxEnv();
    tmp = new TempDir();
    file = join(tmp.path, 'conf', 'wicket', 'connections.json');
    process.env.WICKET_CONNECTIONS_FILE = file;
});

afterEach(() => {
    tmp.cleanup();
    restoreEnv();
});

const read = () => JSON.parse(readFileSync(file, 'utf8')) as { default?: string; connections: Record<string, Record<string, unknown>> };

function seed(doc: unknown): void {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
}

describe('upsertConnection', () => {
    test('creates the file and directory with 600/700 when none exists', () => {
        upsertConnection('fresh', entry(), { replace: false });
        expect(read().connections.fresh).toMatchObject({ tenantId: 'tenant-a' });
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    });

    test('update keeps fields setup did not pass', () => {
        seed({
            connections: {
                prod: entry({ readOnly: true, unmask: false, companies: [COMPANY_B], description: 'Live', persistTokenCache: false }),
            },
        });
        upsertConnection('prod', { companyId: COMPANY_B }, { replace: true });
        expect(read().connections.prod).toMatchObject({
            companyId: COMPANY_B,
            readOnly: true,
            unmask: false,
            companies: [COMPANY_B],
            description: 'Live',
            persistTokenCache: false,
            tenantId: 'tenant-a',
        });
    });

    test('an outside edit made after load survives a save', () => {
        seed({ connections: { a: entry() } });
        // Another session (or a hand edit) adds "b" after this server read the file.
        seed({ connections: { a: entry(), b: entry({ tenantId: 'tenant-b' }) } });
        upsertConnection('c', entry(), { replace: false });
        expect(Object.keys(read().connections)).toEqual(['a', 'b', 'c']);
    });

    test('a rejected sibling entry is written back unchanged', () => {
        const broken = entry({ keychainSevice: 'typo' });
        seed({ connections: { broken } });
        upsertConnection('good', entry(), { replace: false });
        expect(read().connections.broken).toEqual(broken);
    });

    test('validates the merged entry before writing, so a replace cannot break a working connection', () => {
        seed({ connections: { a: entry({ companies: [entry().companyId] }) } });
        const before = readFileSync(file, 'utf8');
        expect(() =>
            upsertConnection('a', { companyId: COMPANY_B }, { replace: true, validate: (name, merged) => validateConnectionEntry(name, merged) }),
        ).toThrow(/not among this connection's permitted companies/);
        expect(readFileSync(file, 'utf8')).toBe(before);
    });

    test('refuses an existing name without replace', () => {
        seed({ connections: { prod: entry() } });
        expect(() => upsertConnection('prod', entry({ tenantId: 'other' }), { replace: false })).toThrow(
            /connection "prod" exists/,
        );
        expect(read().connections.prod).toMatchObject({ tenantId: 'tenant-a' });
    });

    test('writes connections.json.bak with the previous content', () => {
        seed({ connections: { a: entry() } });
        const before = readFileSync(file, 'utf8');
        upsertConnection('b', entry(), { replace: false, makeDefault: true });
        expect(readFileSync(`${file}.bak`, 'utf8')).toBe(before);
        expect(read().default).toBe('b');
    });

    test('never writes a file that is not valid JSON', () => {
        seed('{ not json');
        expect(() => upsertConnection('a', entry(), { replace: false })).toThrow(ConnectionsFileUnreadableError);
        expect(readFileSync(file, 'utf8')).toBe('{ not json');
        expect(existsSync(`${file}.bak`)).toBe(false);
    });
});

describe('moveAsideBroken / removeConnection / setDefaultConnection', () => {
    test('moveAsideBroken renames the file and returns the new path', () => {
        seed('{ not json');
        const moved = moveAsideBroken();
        expect(moved).toMatch(/connections\.json\.broken-\d{8}-\d{6}$/);
        expect(readFileSync(moved, 'utf8')).toBe('{ not json');
        expect(existsSync(file)).toBe(false);
    });

    test('remove deletes the entry and its auth record', () => {
        seed({ default: 'b', connections: { a: entry(), b: entry() } });
        const record = authRecordPath('a');
        mkdirSync(join(record, '..'), { recursive: true });
        writeFileSync(record, '{}');
        removeConnection('a');
        expect(Object.keys(read().connections)).toEqual(['b']);
        expect(existsSync(record)).toBe(false);
    });

    test('removing the default with two left keeps no default chosen, so nothing falls back silently', () => {
        seed({ default: 'a', connections: { a: entry(), b: entry(), c: entry() } });
        expect(removeConnection('a')).toEqual({ defaultCleared: true });
        const reg = ConnectionRegistry.load();
        expect(reg.problem?.kind).toBe('dangling-default');
        expect(reg.current().name).toBeUndefined();
    });

    test('removing the default with one left makes that one the default', () => {
        seed({ default: 'a', connections: { a: entry(), b: entry() } });
        expect(removeConnection('a')).toEqual({ defaultCleared: false });
        expect(read().default).toBe('b');
    });

    test('setDefault sets a known name and throws on an unknown one', () => {
        seed({ connections: { a: entry(), b: entry() } });
        setDefaultConnection('b');
        expect(read().default).toBe('b');
        expect(() => setDefaultConnection('ghost')).toThrow(/connection "ghost" is not in/);
    });
});
