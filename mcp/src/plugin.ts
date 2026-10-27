/**
 * Where the Claude Code plugin lives and how to tell whether its bundled server is current. The
 * bundle itself differs by platform (it carries the native keychain addon), so freshness is judged
 * by a hash of the inputs it was built from, which is the same on every machine.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MCP_DIR = join(import.meta.dir, '..');
export const PLUGIN_DIR = join(MCP_DIR, '..', 'plugin');

/** sha256 over the server sources, package.json and bun.lock, in a fixed order. */
export function pluginSourceHash(): string {
    const hash = createHash('sha256');
    const src = join(MCP_DIR, 'src');
    const files = [
        ...readdirSync(src)
            .filter((f) => f.endsWith('.ts'))
            .sort()
            .map((f) => join(src, f)),
        join(MCP_DIR, 'package.json'),
        join(MCP_DIR, 'bun.lock'),
    ];
    for (const file of files) {
        hash.update(file.slice(MCP_DIR.length));
        hash.update('\0');
        hash.update(readFileSync(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}
