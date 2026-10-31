/**
 * The desktop app extension (.mcpb): its manifest and what the bundle holds. The bundle mirrors the
 * plugin's layout because the launcher finds plugin.json, the checksums and the skill two folders
 * above itself.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { buildDesktopExtension, desktopFiles, desktopManifest } from '../scripts/desktop.ts';
import { PLUGIN_DIR } from '../src/plugin.ts';

const version = (JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version: string })
    .version;

describe('desktop extension manifest', () => {
    test('runs the launcher from the bundle as a binary server, on macOS and Windows', () => {
        const m = desktopManifest(version) as Record<string, any>;
        expect(m.manifest_version).toBe('0.3');
        expect(m.name).toBe('wicket');
        expect(m.version).toBe(version);
        expect(m.server).toEqual({
            type: 'binary',
            entry_point: 'server/wicket',
            mcp_config: { command: '${__dirname}/server/wicket', args: [], env: {} },
        });
        expect(m.compatibility.platforms).toEqual(['darwin', 'win32']);
    });

    test('shows the Wicket avatar as its icon', () => {
        expect((desktopManifest(version) as Record<string, any>).icon).toBe('icon.png');
        expect(desktopFiles({ version, withLocalServer: false })).toContain('icon.png');
    });

    test('asks the user for nothing at install time: connections and secrets go through wicket_setup', () => {
        const m = desktopManifest(version);
        expect('user_config' in m).toBe(false);
        expect(JSON.stringify(m)).not.toMatch(/secret|password|token/i);
    });
});

describe('desktop extension bundle', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'wicket-mcpb-test-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test('the release bundle leaves the server to the download; the local one carries this Mac\'s build', () => {
        expect(desktopFiles({ version, withLocalServer: false })).not.toContain(`server/bin/${version}/wicket-server`);
        expect(desktopFiles({ version, withLocalServer: true })).toContain(`server/bin/${version}/wicket-server`);
    });

    // zip/unzip are not on the Windows runners; the bundle is built on a Mac. Shelling out to zip
    // can outlast the 5 s default when the disk is busy (right after a plugin build), so it gets 30 s.
    test.skipIf(process.platform === 'win32')(
        'holds the manifest at its root and the plugin layout the launcher expects, launcher executable',
        async () => {
            const out = join(dir, 'wicket.mcpb');
            await buildDesktopExtension({ pluginDir: PLUGIN_DIR, version, outFile: out, withLocalServer: false });
            const listing = (await $`zipinfo ${out}`.text()).split('\n');
            const names = listing.map((l) => l.trim().split(/\s+/).slice(8).join(' ')).filter(Boolean);
            for (const f of [
                'manifest.json',
                '.claude-plugin/plugin.json',
                'server/wicket',
                'server/wicket.exe',
                'server/SHA256SUMS',
                'skills/wicket-usage/SKILL.md',
                'icon.png',
            ]) {
                expect(names).toContain(f);
            }
            expect(names.some((n) => n.startsWith('server/bin/'))).toBe(false);
            expect(names.some((n) => n.startsWith('skills/setup'))).toBe(false);
            const launcher = listing.find((l) => l.trim().endsWith(' server/wicket'))!;
            expect(launcher.startsWith('-rwx')).toBe(true);
            const manifest = JSON.parse(await $`unzip -p ${out} manifest.json`.text());
            expect(manifest.version).toBe(version);
        },
        30_000,
    );
});
