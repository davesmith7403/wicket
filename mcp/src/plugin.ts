/**
 * Where the Claude Code plugin lives and how to tell whether its launchers and server builds are
 * current. The binaries differ by platform and from build to build, so freshness is judged by a hash
 * of the inputs they were built from, which is the same on every machine.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MCP_DIR = join(import.meta.dir, '..');
export const PLUGIN_DIR = join(MCP_DIR, '..', 'plugin');

/** The files the plugin is built from: the server sources, package.json, bun.lock and the launcher with its dependencies. */
export function pluginSourceFiles(): string[] {
    const listed = (dir: string, ext: string) =>
        readdirSync(dir)
            .filter((f) => f.endsWith(ext) && !f.endsWith(`_test${ext}`))
            .sort()
            .map((f) => join(dir, f));
    const launcher = join(MCP_DIR, 'launcher');
    return [
        ...listed(join(MCP_DIR, 'src'), '.ts'),
        join(MCP_DIR, 'package.json'),
        join(MCP_DIR, 'bun.lock'),
        ...listed(launcher, '.go'),
        join(launcher, 'go.mod'),
        join(launcher, 'go.sum'),
    ];
}

/**
 * sha256 over pluginSourceFiles in a fixed order. Paths use / and text uses LF, so a Windows
 * checkout (backslashes, CRLF line endings) hashes the same as a Mac one.
 */
export function pluginSourceHash(): string {
    const hash = createHash('sha256');
    for (const file of pluginSourceFiles()) {
        hash.update(file.slice(MCP_DIR.length).replaceAll('\\', '/'));
        hash.update('\0');
        hash.update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
        hash.update('\0');
    }
    return hash.digest('hex');
}
