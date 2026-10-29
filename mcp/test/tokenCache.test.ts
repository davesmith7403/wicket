/**
 * The macOS token cache: MSAL's cache in a file encrypted with a key kept in the Keychain through
 * Apple's `security` tool, so a Wicket update (a new build, a new code identity) never meets a
 * Keychain prompt.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EncryptedFileCache, cacheKeySource, decrypt, encrypt, wicketCachePlugin } from '../src/tokenCache.ts';
import { TempDir } from './helpers.ts';

let tmp: TempDir;
beforeEach(() => {
    tmp = new TempDir();
});
afterEach(() => tmp.cleanup());

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);

describe('encrypt / decrypt', () => {
    test('round-trips, and the stored form is not the text', () => {
        const sealed = encrypt(KEY, '{"AccessToken":{"x":"secret-token"}}');
        expect(sealed.includes(Buffer.from('secret-token'))).toBe(false);
        expect(decrypt(KEY, sealed)).toBe('{"AccessToken":{"x":"secret-token"}}');
    });

    test('another key, a damaged file or an empty one reads as no cache, never as an error', () => {
        const sealed = encrypt(KEY, 'cache');
        expect(decrypt(OTHER, sealed)).toBeNull();
        const damaged = Buffer.from(sealed);
        damaged[damaged.length - 1]! ^= 1;
        expect(decrypt(KEY, damaged)).toBeNull();
        expect(decrypt(KEY, Buffer.alloc(0))).toBeNull();
    });
});

/** What MSAL hands a cache plugin: its in-memory cache and whether this access changed it. */
function context(changed: boolean, cache: { text: string }) {
    return {
        cacheHasChanged: changed,
        tokenCache: {
            serialize: () => cache.text,
            deserialize: (text: string) => void (cache.text = text),
        },
    };
}

describe('EncryptedFileCache', () => {
    test('writes a changed cache encrypted, and the next process reads it back', async () => {
        const path = join(tmp.path, 'auth', 'token-cache.bin');
        const keys = { get: async () => KEY };
        await new EncryptedFileCache(path, keys).afterCacheAccess(context(true, { text: '{"Account":{"me":"secret-token"}}' }));
        expect(readFileSync(path).includes(Buffer.from('secret-token'))).toBe(false);
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
        const fresh = { text: '' };
        await new EncryptedFileCache(path, keys).beforeCacheAccess(context(false, fresh));
        expect(fresh.text).toBe('{"Account":{"me":"secret-token"}}');
    });

    test('an unchanged cache is not written', async () => {
        const path = join(tmp.path, 'token-cache.bin');
        await new EncryptedFileCache(path, { get: async () => KEY }).afterCacheAccess(context(false, { text: 'x' }));
        expect(existsSync(path)).toBe(false);
    });

    test('a cache written under another key, or none at all, leaves MSAL empty: the person signs in again', async () => {
        const path = join(tmp.path, 'token-cache.bin');
        const fresh = { text: '' };
        await new EncryptedFileCache(path, { get: async () => KEY }).beforeCacheAccess(context(false, fresh));
        await new EncryptedFileCache(path, { get: async () => OTHER }).afterCacheAccess(context(true, { text: 'old' }));
        await new EncryptedFileCache(path, { get: async () => KEY }).beforeCacheAccess(context(false, fresh));
        expect(fresh.text).toBe('');
    });
});

describe('cacheKeySource', () => {
    test('creates the key once in the store, then reuses it', async () => {
        const store = new Map<string, string>();
        const keychain = {
            find: async (s: string, a: string) => {
                const v = store.get(`${s}/${a}`);
                if (v === undefined) throw new Error('not found');
                return v;
            },
            store: async (s: string, a: string, secret: string) => void store.set(`${s}/${a}`, secret),
        };
        const first = await cacheKeySource(keychain).get();
        expect(first).toHaveLength(32);
        expect(store.get('wicket/token-cache-key')).toBe(first.toString('hex'));
        expect((await cacheKeySource(keychain).get()).equals(first)).toBe(true);
    });
});

describe('wicketCachePlugin', () => {
    test('registers a factory that gives MSAL the encrypted file cache', async () => {
        let factory: (() => Promise<unknown>) | undefined;
        const context = { cachePluginControl: { setPersistence: (f: typeof factory) => void (factory = f) } };
        const path = join(tmp.path, 'token-cache.bin');
        wicketCachePlugin(path, { get: async () => KEY })(context);
        const plugin = (await factory!()) as EncryptedFileCache;
        expect(plugin).toBeInstanceOf(EncryptedFileCache);
        expect(plugin.path).toBe(path);
    });
});
