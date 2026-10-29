#!/usr/bin/env bun
/**
 * End-to-end smoke test of the plugin on the machine it runs on (CI runs it on Windows and macOS):
 * a plugin folder with only the launcher, a release served locally, and an MCP client that starts
 * the server the way Claude Code does, by the extensionless `server/wicket`. It proves:
 *
 * - the launcher downloads, checks and starts this platform's compiled server;
 * - the server answers with its tools and reads the skill;
 * - the persistent token cache loads (DPAPI on Windows, the Keychain on macOS);
 * - a secret given through the secret page lands in the system store and is read back by a health check;
 * - removing the connection removes that secret.
 *
 * `bun run scripts/smoke.ts`. Needs Go and network access to login.microsoftonline.com.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { $ } from 'bun';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLauncher, compileServer, hostPlatform } from './compile.ts';
import { TOOL_NAMES } from '../src/index.ts';

const MCP = join(import.meta.dir, '..');
const windows = process.platform === 'win32';
const platform = hostPlatform();
const version = (JSON.parse(readFileSync(join(MCP, 'package.json'), 'utf8')) as { version: string }).version;
const account = `smoke-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), 'wicket-smoke-'));

function check(ok: unknown, what: string): void {
    if (!ok) throw new Error(`smoke: ${what}`);
    process.stdout.write(`ok  ${what}\n`);
}

let exitCode = 0;
let client: Client | undefined;
/** What the launcher and server wrote to stderr: printed when the smoke test fails. */
let stderr = '';
let release: ReturnType<typeof Bun.serve> | undefined;
try {
    // A plugin folder as Claude Code installs it, without any server.
    const plugin = join(work, 'plugin');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicket', version }));
    cpSync(join(MCP, '..', 'skills', 'wicket-usage'), join(plugin, 'skills', 'wicket-usage'), { recursive: true });
    mkdirSync(join(plugin, 'server'), { recursive: true });
    // The launcher as shipped: 32-bit x86 on Windows, arm64 on macOS.
    await buildLauncher(windows ? 'windows' : 'darwin', windows ? '386' : 'arm64', join(plugin, 'server', windows ? 'wicket.exe' : 'wicket'));

    // This platform's release zip, its checksum, and a local "GitHub" serving it.
    const stage = join(work, 'stage');
    mkdirSync(stage);
    const serverFile = windows ? 'wicket-server.exe' : 'wicket-server';
    await compileServer(platform, join(stage, serverFile));
    const zipName = `wicket-server-${version}-${platform}.zip`;
    const zip = join(work, zipName);
    // Windows' own bsdtar writes a zip with -a; Git's GNU tar, also on the runner's PATH, would not.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (windows) await $`${tar} -a -c -f ${zip} -C ${stage} ${serverFile}`.quiet();
    else await $`zip -X -j -q ${zip} ${join(stage, serverFile)}`.quiet();
    // The compiled server on its own first: it must start and say so, before the launcher is involved.
    const alone = Bun.spawn([join(stage, serverFile)], {
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
            ...process.env,
            WICKET_CONNECTIONS_FILE: join(work, 'none.json'),
            WICKET_OPEN_BROWSER: '0',
            WICKET_SKILL_DIR: join(plugin, 'skills', 'wicket-usage'),
        },
    });
    const aloneText = await Promise.race([
        (async () => {
            let text = '';
            for await (const chunk of alone.stderr) {
                text += new TextDecoder().decode(chunk);
                if (text.includes('wicket-mcp ready')) break;
            }
            return text;
        })(),
        Bun.sleep(30_000).then(() => 'timed out'),
    ]);
    alone.stdin.end();
    const aloneExit = await Promise.race([alone.exited, Bun.sleep(5_000).then(() => 'still running')]);
    if (aloneExit === 'still running') alone.kill();
    check(aloneText.includes('wicket-mcp ready'), `the compiled server starts on its own (stderr: ${aloneText.trim().slice(0, 300) || '(none)'})`);
    check(aloneExit === 0, `the compiled server ends when its stdin closes (exit: ${aloneExit})`);

    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(readFileSync(zip));
    writeFileSync(join(plugin, 'server', 'SHA256SUMS'), `${hasher.digest('hex')}  ${zipName}\n`);
    let downloads = 0;
    release = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
            if (new URL(req.url).pathname !== `/v${version}/${zipName}`) return new Response('not found', { status: 404 });
            downloads++;
            return new Response(Bun.file(zip));
        },
    });

    // Connections: a person's browser sign-in (never signed in here) and an app whose secret comes from the page.
    const config = join(work, 'config');
    mkdirSync(config);
    const tenant = '00000000-0000-4000-8000-0000000000aa';
    writeFileSync(
        join(config, 'connections.json'),
        JSON.stringify({
            default: 'me',
            connections: {
                me: { tenantId: tenant, environment: 'Production', companyId: '00000000-0000-4000-8000-0000000000bb', authMode: 'browser' },
                [account]: {
                    tenantId: tenant,
                    environment: 'Production',
                    companyId: '00000000-0000-4000-8000-0000000000bb',
                    authMode: 'client_credentials',
                    clientId: '00000000-0000-4000-8000-0000000000cc',
                    keychainService: 'wicket',
                    keychainAccount: account,
                },
            },
        }),
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BC_'))) as Record<string, string>;
    Object.assign(env, {
        WICKET_RELEASES: `http://127.0.0.1:${release.port}/`,
        WICKET_CONNECTIONS_FILE: join(config, 'connections.json'),
        WICKET_AUTH_DIR: join(config, 'auth'),
        WICKET_CACHE_DIR: join(config, 'cache'),
        WICKET_OPEN_BROWSER: '0',
        ...(windows ? { LOCALAPPDATA: join(work, 'localappdata') } : {}),
    });

    // Started as Claude Code starts it: the extensionless command.
    const transport = new StdioClientTransport({ command: join(plugin, 'server', 'wicket'), env, stderr: 'pipe' });
    transport.stderr?.on('data', (d) => (stderr += String(d)));
    client = new Client({ name: 'smoke', version: '0' });
    await client.connect(transport);
    const call = async (args: Record<string, unknown>) => {
        const res = (await client!.callTool({ name: 'wicket_setup', arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
        if (res.isError) throw new Error(`wicket_setup ${String(args.action)}: ${res.content[0]?.text}`);
        return JSON.parse(res.content[0]!.text) as Record<string, any>;
    };

    check(downloads === 1, `the launcher downloaded the ${platform} server once and started it`);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check(TOOL_NAMES.every((n) => tools.includes(n)), `the server lists all ${TOOL_NAMES.length} tools`);
    const skill = (await client.callTool({ name: 'wicket_skill', arguments: { mode: 'toc' } })) as { content: Array<{ text: string }> };
    check(skill.content[0]?.text.includes('Wicket'), 'the server reads the skill the launcher points it at');

    const before = await call({ action: 'status' });
    const me = before.connections.find((c: any) => c.name === 'me');
    check(me?.health.state === 'signInNeeded', 'a person never signed in here is reported as needing a sign-in, without a prompt');
    check(!stderr.includes('persistent token cache unavailable'), `the persistent token cache loaded (${windows ? 'DPAPI' : 'encrypted file, key in the Keychain'})`);

    const page = await call({ action: 'secretPage', name: account });
    check(page.opened === false, 'no browser was opened (WICKET_OPEN_BROWSER=0); the address came back instead');
    const posted = await fetch(page.url, {
        method: 'POST',
        body: 'secret=smoke-secret-value',
        headers: { Origin: new URL(page.url).origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    check(posted.status === 200, `the secret page stored a secret (${page.store})`);
    if (windows) {
        const file = join(work, 'localappdata', 'wicket', 'secrets', 'wicket', `${account}.bin`);
        check(existsSync(file) && !readFileSync(file).includes(Buffer.from('smoke-secret-value')), 'the secret file exists and is not plain text');
    }
    const after = await call({ action: 'status' });
    const app = after.connections.find((c: any) => c.name === account);
    check(app && app.health.state !== 'secretMissing', `the health check read the stored secret back (then: ${app?.health.state})`);

    await call({ action: 'remove', name: account });
    const gone = await call({ action: 'status' });
    check(!gone.connections.some((c: any) => c.name === account), 'the connection was removed');
    if (windows) check(!existsSync(join(work, 'localappdata', 'wicket', 'secrets', 'wicket', `${account}.bin`)), 'its secret file was removed');
    else check((await $`security find-generic-password -s wicket -a ${account}`.nothrow().quiet()).exitCode !== 0, 'its Keychain item was removed');
} catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.stderr.write(`--- launcher and server stderr ---\n${stderr}\n`);
    exitCode = 1;
} finally {
    await client?.close().catch(() => undefined);
    release?.stop(true);
    if (!windows) await $`security delete-generic-password -s wicket -a ${account}`.nothrow().quiet();
    rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
