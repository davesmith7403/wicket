/**
 * The server process ends when its host closes stdin, even while something keeps its event loop
 * busy (an open secret page). On Windows the launcher cannot exec, so a server that lingered would
 * outlive the session and lock the plugin's folder.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { TempDir } from './helpers.ts';

let tmp: TempDir;
beforeEach(() => {
    tmp = new TempDir();
});
afterEach(() => tmp.cleanup());

test('closing stdin ends the server although a secret page is open', async () => {
    const child = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'src', 'index.ts')], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
        env: {
            ...process.env,
            WICKET_CONNECTIONS_FILE: join(tmp.path, 'none.json'),
            WICKET_OPEN_BROWSER: '0',
            BC_TENANT_ID: '',
        },
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const reader = child.stdout.getReader();
    let buffered = '';
    const nextReply = async (id: number) => {
        for (;;) {
            const line = buffered.split('\n').find((l) => l.includes(`"id":${id}`));
            if (line) return JSON.parse(line) as { result?: { content?: Array<{ text: string }> } };
            const { value, done } = await reader.read();
            if (done) throw new Error('server ended early');
            buffered += new TextDecoder().decode(value);
        }
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await nextReply(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wicket_setup', arguments: { action: 'secretPage', name: 'contoso' } } });
    const page = JSON.parse((await nextReply(2)).result!.content![0]!.text) as { url: string; opened: boolean };
    expect(page.opened).toBe(false);
    expect((await fetch(page.url)).status).toBe(200);

    child.stdin.end();
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) child.kill();
    expect(exited).toBe(true);
}, 20_000);
