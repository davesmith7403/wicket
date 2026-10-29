/**
 * Where a connection's client secret lives on each platform: the macOS Keychain, or a DPAPI-protected
 * file on Windows. The Windows half is exercised here with a stand-in for DPAPI; the real thing runs
 * on the Windows CI job.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileStore, keychainCommand, secretPath, storeFor } from '../src/secretStore.ts';
import { TempDir } from './helpers.ts';

let tmp: TempDir;
beforeEach(() => {
    tmp = new TempDir();
});
afterEach(() => tmp.cleanup());

describe('secretPath', () => {
    test('lives under LOCALAPPDATA\\wicket\\secrets\\<service>\\<account>.bin', () => {
        expect(secretPath('wicket', 'contoso-prod', { LOCALAPPDATA: tmp.path })).toBe(
            join(tmp.path, 'wicket', 'secrets', 'wicket', 'contoso-prod.bin'),
        );
    });

    test('Windows names are case-blind: Prod and prod get different files, and device names are refused', () => {
        const prod = secretPath('wicket', 'Prod', { LOCALAPPDATA: tmp.path });
        const lower = secretPath('wicket', 'prod', { LOCALAPPDATA: tmp.path });
        expect(prod.toLowerCase()).not.toBe(lower.toLowerCase());
        for (const device of ['con', 'NUL', 'aux', 'com1', 'LPT9', 'prn']) {
            expect(() => secretPath('wicket', device, { LOCALAPPDATA: tmp.path })).toThrow(/invalid/);
        }
    });

    test('refuses names that could leave the secrets folder', () => {
        for (const [service, account] of [['..', 'x'], ['wicket', '../x'], ['wicket', 'a/b'], ['wicket', 'a\\b'], ['', 'x']]) {
            expect(() => secretPath(service!, account!, { LOCALAPPDATA: tmp.path })).toThrow(/invalid/);
        }
    });
});

describe('keychainCommand', () => {
    test('quotes the secret for `security -i`, so it never appears in a process list', () => {
        expect(keychainCommand('wicket', 'contoso', 'a~b "q" x\\y')).toBe(
            'add-generic-password -U -s "wicket" -a "contoso" -w "a~b \\"q\\" x\\\\y"\n',
        );
    });

    test('refuses a secret with a line break or any other control character, which would end the command early', () => {
        expect(() => keychainCommand('wicket', 'contoso', 'a\nb')).toThrow(/control character/);
        expect(() => keychainCommand('wicket', 'contoso', 'a\u0000b')).toThrow(/control character/);
    });
});

describe('fileStore (Windows)', () => {
    /** A stand-in for the DPAPI file persistence that marks what it protected, so the test sees the file is not plain text. */
    const fakePersistence = async (path: string) => ({
        async save(text: string) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, `P:${text}`);
        },
        async load() {
            const data = readFileSync(path, 'utf8');
            if (!data.startsWith('P:')) throw new Error('not protected');
            return data.slice(2);
        },
    });

    test('stores, finds and removes a secret, and the file holds only the protected form', async () => {
        const store = fileStore(fakePersistence, { LOCALAPPDATA: tmp.path });
        await store.store('wicket', 'contoso', 's3cret');
        const file = join(tmp.path, 'wicket', 'secrets', 'wicket', 'contoso.bin');
        expect(readFileSync(file).toString()).toBe('P:s3cret');
        expect(await store.find('wicket', 'contoso')).toBe('s3cret');
        await store.remove('wicket', 'contoso');
        expect(existsSync(file)).toBe(false);
        await expect(store.find('wicket', 'contoso')).rejects.toThrow();
    });

    test('a lookup of a secret that is not there creates nothing', async () => {
        const store = fileStore(fakePersistence, { LOCALAPPDATA: tmp.path });
        await expect(store.find('wicket', 'missing')).rejects.toThrow(/No secret is stored/);
        expect(existsSync(join(tmp.path, 'wicket'))).toBe(false);
    });
});

describe('storeFor', () => {
    test('picks the Keychain on macOS and the protected file on Windows, and says what to use elsewhere', () => {
        expect(storeFor('darwin').kind).toBe('keychain');
        expect(storeFor('win32').kind).toBe('dpapi');
        expect(() => storeFor('linux').find('wicket', 'x')).toThrow(/secretEnv/);
    });
});
