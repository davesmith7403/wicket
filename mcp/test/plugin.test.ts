/**
 * The Claude Code plugin in plugin/ ships what the repository holds: the skill byte for byte, a
 * server bundle built from the current sources, the server's version, and a marketplace entry that
 * installs it. Each assertion names the command that repairs it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_DIR, pluginSourceFiles, pluginSourceHash } from '../src/plugin.ts';
import { skillFiles } from '../src/skill.ts';

const ROOT = join(PLUGIN_DIR, '..');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

describe('plugin', () => {
    test('the launchers were built from the current sources (bun run plugin:build)', () => {
        const server = join(PLUGIN_DIR, 'server');
        expect(readFileSync(join(server, 'SOURCE_HASH'), 'utf8').trim()).toBe(pluginSourceHash());
        // A Mach-O arm64 executable for macOS and a 32-bit x86 PE executable for Windows (it runs on x64
        // and, emulated, on Windows on ARM); no server and no runtime-dependent bundle in the plugin itself.
        const mac = readFileSync(join(server, 'wicket'));
        expect(mac.readUInt32LE(0)).toBe(0xfeedfacf);
        expect(mac.readUInt32LE(4)).toBe(0x0100000c);
        const win = readFileSync(join(server, 'wicket.exe'));
        expect(win.subarray(0, 2).toString()).toBe('MZ');
        expect(win.readUInt16LE(win.readUInt32LE(0x3c) + 4)).toBe(0x014c);
        expect(existsSync(join(server, 'index.js'))).toBe(false);
    });

    test('the source hash covers the launcher, so changing it asks for a rebuild', () => {
        const files = pluginSourceFiles().map((f) => f.replaceAll('\\', '/'));
        expect(files).toContainEqual(expect.stringMatching(/launcher\/launcher\.go$/));
        expect(files).toContainEqual(expect.stringMatching(/launcher\/go\.mod$/));
    });

    test('SHA256SUMS names the server zip of every supported platform for this version', () => {
        const version = json(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json')).version;
        const names = readFileSync(join(PLUGIN_DIR, 'server', 'SHA256SUMS'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
                const [sum, name] = line.split(/\s+/);
                expect(sum).toMatch(/^[0-9a-f]{64}$/);
                return name;
            });
        expect(names).toEqual(['darwin-arm64', 'windows-arm64', 'windows-x64'].map((p) => `wicket-server-${version}-${p}.zip`));
    });

    test('the launchers carry no path from the building machine', () => {
        for (const name of ['wicket', 'wicket.exe']) {
            expect(readFileSync(join(PLUGIN_DIR, 'server', name)).includes(Buffer.from(homedir()))).toBe(false);
        }
    });

    test('the skill is the repository skill, byte for byte (bun run plugin:build)', () => {
        const source = skillFiles(join(ROOT, 'skills', 'wicket-usage'));
        const shipped = skillFiles(join(PLUGIN_DIR, 'skills', 'wicket-usage'));
        expect(shipped.map((f) => f.path)).toEqual(source.map((f) => f.path));
        for (const [i, f] of source.entries()) expect(shipped[i]?.raw).toBe(f.raw);
    });

    test('the manifest carries the server version and the marketplace installs it', () => {
        const pkg = json(join(PLUGIN_DIR, '..', 'mcp', 'package.json'));
        const manifest = json(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'));
        const market = json(join(ROOT, '.claude-plugin', 'marketplace.json'));
        expect(manifest.name).toBe('wicket');
        expect(manifest.version).toBe(pkg.version);
        expect(market.plugins).toContainEqual(expect.objectContaining({ name: manifest.name, source: './plugin' }));
    });

    test('the MCP server entry runs the launcher from the plugin root', () => {
        const mcp = json(join(PLUGIN_DIR, '.mcp.json'));
        // Extensionless: macOS runs server/wicket, Windows finds server/wicket.exe.
        expect(mcp.mcpServers.wicket).toEqual({ command: '${CLAUDE_PLUGIN_ROOT}/server/wicket' });
    });

    test('/wicket:orient and /wicket:inventory are user-invoked skills that use the plugin tools', () => {
        for (const name of ['orient', 'inventory']) {
            const text = readFileSync(join(PLUGIN_DIR, 'skills', name, 'SKILL.md'), 'utf8');
            expect(text).toContain('disable-model-invocation: true');
            expect(text).toContain('mcp__plugin_wicket_wicket__wicket_whoami');
        }
    });

    test('/wicket:setup is a model-invocable skill whose allowed tools are AskUserQuestion and the setup tools', () => {
        const text = readFileSync(join(PLUGIN_DIR, 'skills', 'setup', 'SKILL.md'), 'utf8');
        const frontmatter = text.split('---')[1] ?? '';
        expect(frontmatter).not.toContain('disable-model-invocation');
        expect(frontmatter).toMatch(/^description: .+/m);
        expect(frontmatter).toContain('AskUserQuestion');
        expect(frontmatter).toContain('mcp__plugin_wicket_wicket__wicket_setup');
        expect(frontmatter).toContain('mcp__plugin_wicket_wicket__wicket_connections');
        expect(frontmatter).not.toMatch(/\bBash\b/);
    });
});
