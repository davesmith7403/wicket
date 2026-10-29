/**
 * Where a connection's client secret lives: the system's own store for the user's secrets, named by
 * the connection's keychainService and keychainAccount.
 *
 * - macOS: a generic password in the login Keychain, through `security`. Writing feeds the command to
 *   `security -i` on stdin, so the secret never appears in a process list.
 * - Windows: a file protected with DPAPI for the current user, at
 *   %LOCALAPPDATA%\wicket\secrets\<service>\<account>.bin (through msal-node-extensions, the same
 *   protection the Windows token cache uses). Only this Windows account can read it.
 *
 * Anywhere else there is no store: a connection names its secret with secretEnv instead.
 */

import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SecretStore {
    readonly kind: 'keychain' | 'dpapi' | 'none';
    find(service: string, account: string): Promise<string>;
    store(service: string, account: string, secret: string): Promise<void>;
    remove(service: string, account: string): Promise<void>;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Names Windows reserves for devices, with or without an extension. */
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * A name as a Windows file name: checked, and case kept apart on a case-blind file system by
 * marking each capital with ^ ("Prod" is ^prod, "prod" is prod).
 */
function fileName(what: string, value: string): string {
    if (!NAME_RE.test(value) || value === '.' || value === '..' || DEVICE_RE.test(value)) {
        throw new Error(`The secret's ${what} "${value}" is invalid (use [A-Za-z0-9._-], <=64 chars, not a Windows device name).`);
    }
    return value.replace(/[A-Z]/g, (c) => `^${c.toLowerCase()}`);
}

/** The protected file for a secret on Windows. */
export function secretPath(service: string, account: string, env: Record<string, string | undefined> = process.env): string {
    const folder = fileName('service', service);
    const file = fileName('account', account);
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'wicket', 'secrets', folder, `${file}.bin`);
}

/** The `security -i` line that stores a secret, quoted for its parser (backslash and double quote escaped). */
export function keychainCommand(service: string, account: string, secret: string): string {
    if (/[\x00-\x1f\x7f]/.test(secret)) throw new Error('A client secret cannot contain a line break or another control character.');
    const quote = (text: string) => `"${text.replace(/[\\"]/g, '\\$&')}"`;
    return `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${quote(secret)}\n`;
}

const macKeychain: SecretStore = {
    kind: 'keychain',
    async find(service, account) {
        // Async: a locked-keychain modal on one connection must not freeze every other one.
        const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
            encoding: 'utf8',
        });
        return stdout.trim();
    },
    async store(service, account, secret) {
        const line = keychainCommand(service, account, secret);
        await new Promise<void>((resolve, reject) => {
            // A timeout: an existing item whose access list asks for confirmation would otherwise hang.
            const child = execFile('security', ['-i'], { timeout: 30_000 }, (err, _stdout, stderr) =>
                err || stderr.trim() ? reject(new Error(`The Keychain refused the secret: ${stderr.trim() || err?.message}`)) : resolve(),
            );
            child.stdin?.end(line);
        });
    },
    async remove(service, account) {
        await execFileAsync('security', ['delete-generic-password', '-s', service, '-a', account]).catch(() => undefined);
    },
};

/** What a protected file needs: write the text, or read it back. */
export interface ProtectedFile {
    save(text: string): Promise<void>;
    load(): Promise<string | null>;
}

/** A store of one protected file per secret. */
export function fileStore(open: (path: string) => Promise<ProtectedFile>, env: Record<string, string | undefined> = process.env): SecretStore {
    return {
        kind: 'dpapi',
        async find(service, account) {
            const path = secretPath(service, account, env);
            // Checked first: opening the persistence creates the folder and an empty file.
            if (!existsSync(path)) throw new Error(`No secret is stored for ${service}/${account}.`);
            const text = await (await open(path)).load();
            if (!text) throw new Error(`No secret is stored for ${service}/${account}.`);
            return text;
        },
        async store(service, account, secret) {
            await (await open(secretPath(service, account, env))).save(secret);
        },
        async remove(service, account) {
            rmSync(secretPath(service, account, env), { force: true });
        },
    };
}

/** DPAPI through msal-node-extensions, loaded only on Windows. */
async function dpapiFile(path: string): Promise<ProtectedFile> {
    const { FilePersistenceWithDataProtection, DataProtectionScope } = await import('@azure/msal-node-extensions');
    return FilePersistenceWithDataProtection.create(path, DataProtectionScope.CurrentUser);
}

const noStore: SecretStore = {
    kind: 'none',
    find: () => {
        throw new Error('This platform has no secret store for Wicket: name the secret with secretEnv instead.');
    },
    store: () => {
        throw new Error('This platform has no secret store for Wicket: name the secret with secretEnv instead.');
    },
    remove: async () => undefined,
};

export function storeFor(platform: NodeJS.Platform): SecretStore {
    if (platform === 'darwin') return macKeychain;
    if (platform === 'win32') return fileStore(dpapiFile);
    return noStore;
}
