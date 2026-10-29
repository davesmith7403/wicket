/**
 * The macOS token cache: MSAL's cache kept in a file encrypted with AES-256-GCM, its key in the
 * Keychain, written and read through Apple's `security` tool (see secretStore.ts).
 *
 * Why not the Keychain directly (what @azure/identity-cache-persistence does with keytar): macOS
 * ties a Keychain item to the program that created it, and without an Apple-issued certificate a
 * program's identity is its build. Every Wicket update would then meet a Keychain prompt, and a
 * call fails until someone answers it. `security` is Apple's own and keeps its identity, so no
 * update ever prompts. Trade-off: any program running as the same user can read the key with the
 * same tool (other tools keep this cache as a plain file).
 *
 * Windows keeps @azure/identity-cache-persistence, which protects the file with DPAPI.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT = 1;
const KEY_SERVICE = 'wicket';
const KEY_ACCOUNT = 'token-cache-key';

/** Where the cache key comes from. */
export interface KeySource {
    get(): Promise<Buffer>;
}

/** [format 1][iv 12][tag 16][ciphertext] */
export function encrypt(key: Buffer, text: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT]), iv, cipher.getAuthTag(), body]);
}

/** The text, or null when the data is empty, damaged or sealed with another key. */
export function decrypt(key: Buffer, data: Buffer): string | null {
    if (data.length < 29 || data[0] !== FORMAT) return null;
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(1, 13));
        decipher.setAuthTag(data.subarray(13, 29));
        return Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

/** What MSAL hands a cache plugin on each access (the slice of TokenCacheContext used here). */
export interface CacheAccess {
    cacheHasChanged: boolean;
    tokenCache: { serialize(): string; deserialize(text: string): void };
}

/**
 * MSAL's cache plugin over one encrypted file: read before each access, written after one that
 * changed the cache. Written whole to a temporary file and renamed into place, mode 600, so a
 * reader never sees half a file; two servers writing at once leave the later one's cache (a
 * refresh token one of them held is then fetched again, never lost for good).
 */
export class EncryptedFileCache {
    constructor(
        readonly path: string,
        private readonly keys: KeySource,
    ) {}

    async beforeCacheAccess(access: CacheAccess): Promise<void> {
        if (!existsSync(this.path)) return;
        // Another key, or a damaged file, reads as no cache: the person signs in again.
        const text = decrypt(await this.keys.get(), readFileSync(this.path));
        if (text !== null) access.tokenCache.deserialize(text);
    }

    async afterCacheAccess(access: CacheAccess): Promise<void> {
        if (!access.cacheHasChanged) return;
        const sealed = encrypt(await this.keys.get(), access.tokenCache.serialize());
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.tmp-${process.pid}`;
        writeFileSync(temp, sealed, { mode: 0o600 });
        renameSync(temp, this.path);
    }
}

interface KeyStore {
    find(service: string, account: string): Promise<string>;
    store(service: string, account: string, secret: string): Promise<void>;
}

/**
 * The cache key from the store, created on first use. Read back after storing, so two servers
 * starting at once settle on the key that was written last.
 */
export function cacheKeySource(store: KeyStore): KeySource {
    let key: Promise<Buffer> | undefined;
    const fetch = async (): Promise<Buffer> => {
        try {
            const hex = await store.find(KEY_SERVICE, KEY_ACCOUNT);
            if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
        } catch {
            /* not created yet */
        }
        await store.store(KEY_SERVICE, KEY_ACCOUNT, randomBytes(32).toString('hex'));
        return Buffer.from(await store.find(KEY_SERVICE, KEY_ACCOUNT), 'hex');
    };
    return {
        get() {
            key ??= fetch().catch((err: unknown) => {
                key = undefined;
                throw err;
            });
            return key;
        },
    };
}

/** An @azure/identity plugin that gives MSAL the encrypted file cache at `path`. */
export function wicketCachePlugin(path: string, keys: KeySource) {
    return (context: unknown): void => {
        const control = (context as { cachePluginControl: { setPersistence(factory: () => Promise<EncryptedFileCache>): void } })
            .cachePluginControl;
        control.setPersistence(async () => new EncryptedFileCache(path, keys));
    };
}
