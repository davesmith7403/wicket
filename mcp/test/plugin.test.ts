/**
 * The Claude Code plugin in plugin/ ships what the repository holds: the skill byte for byte, a
 * server bundle built from the current sources, the server's version, and a marketplace entry that
 * installs it. Each assertion names the command that repairs it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_DIR, pluginSourceHash } from '../src/plugin.ts';
import { skillFiles } from '../src/skill.ts';

const ROOT = join(PLUGIN_DIR, '..');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

describe('plugin', () => {
    test('the server bundle was built from the current sources (bun run plugin:build)', () => {
        const stamp = join(PLUGIN_DIR, 'server', 'SOURCE_HASH');
        expect(existsSync(join(PLUGIN_DIR, 'server', 'index.js'))).toBe(true);
        expect(readFileSync(stamp, 'utf8').trim()).toBe(pluginSourceHash());
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

    test('the MCP server entry runs the bundled server from the plugin root', () => {
        const mcp = json(join(PLUGIN_DIR, '.mcp.json'));
        expect(mcp.mcpServers.wicket).toEqual({ command: 'bun', args: ['run', '${CLAUDE_PLUGIN_ROOT}/server/index.js'] });
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
