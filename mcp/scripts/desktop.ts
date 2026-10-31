/**
 * The Claude desktop app extension (MCP Bundle, .mcpb): a zip with manifest.json at its root that
 * the app installs from one double-click. It carries the plugin's own launcher, plugin.json,
 * checksums, usage skill and icon in the plugin's layout, because the launcher finds them two folders
 * above itself; on its first start the launcher downloads and verifies the server from the
 * v<version> release, exactly as the Claude Code plugin does. Connections come from wicket_setup in
 * a chat, so the bundle asks the user for nothing at install time.
 *
 * Built by `bun run plugin:build` into dist/: wicket-<version>.mcpb is the release asset;
 * wicket-<version>-local.mcpb also carries this Mac's server build, for installing before the
 * release exists.
 */
import { $ } from 'bun';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DESKTOP_EXTENSION_NAME = 'wicket';

/** The bundle manifest (MCPB manifest_version 0.3). */
export function desktopManifest(version: string): Record<string, unknown> {
    return {
        manifest_version: '0.3',
        name: DESKTOP_EXTENSION_NAME,
        display_name: 'Wicket',
        version,
        description: 'Read, write and run business actions in Microsoft Dynamics 365 Business Central through Wicket.',
        long_description:
            'Wicket gives Claude governed access to Business Central: query any table the administrator exposes, ' +
            'write records in one transaction, run enrolled business actions with a preview first, and see what ' +
            'the agent changed. After installing, say "set up Wicket" in a chat to connect to an environment.',
        author: { name: 'Dave The Wicketkeeper' },
        keywords: ['business-central', 'dynamics-365', 'erp'],
        icon: 'icon.png',
        server: {
            type: 'binary',
            entry_point: 'server/wicket',
            mcp_config: {
                // The app appends .exe on Windows, where the launcher is server/wicket.exe.
                command: '${__dirname}/server/wicket',
                args: [],
                env: {},
            },
        },
        tools_generated: true,
        compatibility: { platforms: ['darwin', 'win32'] },
    };
}

export interface DesktopBuild {
    pluginDir: string;
    version: string;
    outFile: string;
    /** Carry this Mac's server build in server/bin/<version>/, so nothing is downloaded. */
    withLocalServer: boolean;
}

/** The bundle's files, as paths relative to the plugin folder. */
export function desktopFiles(build: Pick<DesktopBuild, 'version' | 'withLocalServer'>): string[] {
    const files = [
        '.claude-plugin/plugin.json',
        'server/wicket',
        'server/wicket.exe',
        'server/SHA256SUMS',
        'skills/wicket-usage',
        'icon.png',
    ];
    if (build.withLocalServer) files.push(`server/bin/${build.version}/wicket-server`);
    return files;
}

export async function buildDesktopExtension(build: DesktopBuild): Promise<void> {
    const stage = mkdtempSync(join(tmpdir(), 'wicket-mcpb-'));
    try {
        for (const rel of desktopFiles(build)) {
            const from = join(build.pluginDir, rel);
            if (!existsSync(from)) throw new Error(`desktop extension: ${rel} is missing from ${build.pluginDir}`);
            const to = join(stage, rel);
            mkdirSync(join(to, '..'), { recursive: true });
            cpSync(from, to, { recursive: true });
        }
        writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(desktopManifest(build.version), null, 2)}\n`);
        rmSync(build.outFile, { force: true });
        // zip keeps the Unix mode bits, so the launcher stays executable on macOS; -X drops extra
        // attributes (owner, times) that would make the bundle differ between builds of the same files.
        await $`zip -X -r -q ${build.outFile} .`.cwd(stage);
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
