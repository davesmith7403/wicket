#!/usr/bin/env bun
/**
 * Build the Claude Code plugin in plugin/ and the server builds it downloads. Run after changing the
 * server, the launcher or the skill: `bun run plugin:build`. The suite fails while plugin/ is out of
 * date. Builds on an Apple-silicon Mac (codesign, zip, Go).
 *
 * - dist/server/: the server compiled into one self-contained executable per platform (no runtime
 *   to install), zipped as wicket-server-<version>-<platform>.zip. These are the release assets of
 *   v<version>; they are too large for the plugin's git repo.
 * - plugin/server/SHA256SUMS: the zips' checksums, committed with the plugin, so a launcher refuses
 *   any other download.
 * - plugin/server/wicket and wicket.exe: the launchers (mcp/launcher, Go) for macOS and Windows.
 * - plugin/server/bin/<version>/: this Mac's own build, so the plugin read straight from this
 *   repository never downloads (git-ignored).
 * - plugin/skills/wicket-usage/: the skill, one copy for Claude Code and the server.
 */
import { $ } from 'bun';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TARGETS, buildLauncher, compileServer } from './compile.ts';
import { skillFiles } from '../src/skill.ts';
import { PLUGIN_DIR, pluginSourceHash } from '../src/plugin.ts';

const MCP = join(import.meta.dir, '..');
const DIST = join(MCP, '..', 'dist', 'server');
const SOURCE_SKILL = join(MCP, '..', 'skills', 'wicket-usage');
const SERVER = join(PLUGIN_DIR, 'server');
const SKILL = join(PLUGIN_DIR, 'skills', 'wicket-usage');

const pkg = JSON.parse(readFileSync(join(MCP, 'package.json'), 'utf8')) as { version: string };
const version = pkg.version;

// The server builds and their checksums.
rmSync(DIST, { recursive: true, force: true });
const sums: string[] = [];
for (const target of TARGETS) {
    const dir = join(DIST, target.platform);
    const exe = join(dir, target.file);
    mkdirSync(dir, { recursive: true });
    await compileServer(target.platform, exe);
    const zip = join(DIST, `wicket-server-${version}-${target.platform}.zip`);
    await $`zip -X -j -q ${zip} ${exe}`;
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(readFileSync(zip));
    sums.push(`${hasher.digest('hex')}  wicket-server-${version}-${target.platform}.zip`);
}

// The plugin's server folder: launchers, checksums, and this Mac's own build. Wiped first.
rmSync(SERVER, { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });
writeFileSync(join(SERVER, 'SHA256SUMS'), `${sums.join('\n')}\n`);
await buildLauncher('darwin', 'arm64', join(SERVER, 'wicket'));
// 32-bit x86: runs on x64 Windows and under emulation on Windows on ARM (also Windows 10, which
// cannot run x64); it asks the OS for the native architecture to pick the server.
await buildLauncher('windows', '386', join(SERVER, 'wicket.exe'));
if (process.platform === 'darwin' && process.arch === 'arm64') {
    const local = join(SERVER, 'bin', version);
    mkdirSync(local, { recursive: true });
    copyFileSync(join(DIST, 'darwin-arm64', 'wicket-server'), join(local, 'wicket-server'));
}

// The MCP entry: extensionless, so macOS runs server/wicket and Windows finds server/wicket.exe.
writeFileSync(
    join(PLUGIN_DIR, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { wicket: { command: '${CLAUDE_PLUGIN_ROOT}/server/wicket' } } }, null, 2)}\n`,
);

// The skill, one copy: Claude Code loads it as a plugin skill and the server reads it for
// wicket_skill and its instructions (the launcher passes its folder as WICKET_SKILL_DIR).
rmSync(SKILL, { recursive: true, force: true });
mkdirSync(join(SKILL, 'references'), { recursive: true });
for (const f of skillFiles(SOURCE_SKILL)) writeFileSync(join(SKILL, f.path), f.raw);

// The version follows the server's, and the hash records which sources these builds came from.
const manifestPath = join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(SERVER, 'SOURCE_HASH'), `${pluginSourceHash()}\n`);

process.stdout.write(`built plugin ${version} in plugin/ and its server builds in dist/server/\n`);
