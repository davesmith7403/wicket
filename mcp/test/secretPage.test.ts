/**
 * The one-time page that takes a client secret in the browser and puts it in the system's secret
 * store, so the secret never passes through the chat or a shell, on macOS and Windows alike.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { openInBrowser, startSecretPage, type SecretPage } from '../src/secretPage.ts';

let page: SecretPage | undefined;
afterEach(() => page?.close());

function recorder() {
    const stored: Array<[string, string, string]> = [];
    return {
        stored,
        store: async (service: string, account: string, secret: string) => {
            if (secret.includes('\n')) throw new Error('A client secret cannot contain a line break.');
            stored.push([service, account, secret]);
        },
    };
}

const origin = (url: string) => new URL(url).origin;
const post = (url: string, body: string, headers: Record<string, string> = { Origin: origin(url) }) =>
    fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });

describe('secret page', () => {
    test('serves a form on 127.0.0.1 that is never cached and names the connection', async () => {
        page = await startSecretPage({ service: 'wicket', account: 'contoso', store: recorder().store });
        expect(new URL(page.url).hostname).toBe('127.0.0.1');
        const res = await fetch(page.url);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
        const html = await res.text();
        expect(html).toContain('contoso');
        expect(html).toContain('type="password"');
    });

    test('a POST from the page stores the secret once, then the page is gone', async () => {
        const rec = recorder();
        page = await startSecretPage({ service: 'wicket', account: 'contoso', store: rec.store });
        const res = await post(page.url, 'secret=s3cret%7E%22x');
        expect(res.status).toBe(200);
        expect(await res.text()).not.toContain('s3cret');
        expect(rec.stored).toEqual([['wicket', 'contoso', 's3cret~"x']]);
        expect(await page.done).toBe('stored');
        // Gone: the listener stops; a connection the browser kept open gets a 404.
        const after = await fetch(page.url).catch(() => undefined);
        expect(after?.status ?? 404).toBe(404);
    });

    test('another path, another origin or no origin is refused and stores nothing', async () => {
        const rec = recorder();
        page = await startSecretPage({ service: 'wicket', account: 'contoso', store: rec.store });
        const base = origin(page.url);
        expect((await post(`${base}/not-the-token`, 'secret=x', { Origin: base })).status).toBe(404);
        expect((await post(page.url, 'secret=x', { Origin: 'http://evil.example' })).status).toBe(403);
        expect((await post(page.url, 'secret=x', {})).status).toBe(403);
        expect(rec.stored).toEqual([]);
    });

    test('an empty secret or one the store refuses is answered on the page, and the page stays open', async () => {
        const rec = recorder();
        page = await startSecretPage({ service: 'wicket', account: 'contoso', store: rec.store });
        const empty = await post(page.url, 'secret=');
        expect(empty.status).toBe(400);
        const refused = await post(page.url, 'secret=a%0Ab');
        expect(refused.status).toBe(400);
        expect(await refused.text()).toContain('line break');
        expect((await post(page.url, 'secret=ok')).status).toBe(200);
        expect(rec.stored).toEqual([['wicket', 'contoso', 'ok']]);
    });

    test('the page lets the browser send its real Origin (a no-referrer policy makes it send null)', async () => {
        page = await startSecretPage({ service: 'wicket', account: 'contoso', store: recorder().store });
        const policy = (await fetch(page.url)).headers.get('referrer-policy');
        expect(policy).toBe('same-origin');
    });

    test('a request naming another host is refused even with a matching Origin (DNS rebinding)', async () => {
        const rec = recorder();
        page = await startSecretPage({ service: 'wicket', account: 'contoso', store: rec.store });
        const res = await post(page.url, 'secret=x', { Origin: 'http://evil.example:8080', Host: 'evil.example:8080' });
        expect(res.status).toBe(403);
        expect(rec.stored).toEqual([]);
    });

    test('two submissions at once store one secret', async () => {
        const stored: string[] = [];
        page = await startSecretPage({
            service: 'wicket',
            account: 'contoso',
            store: async (_s, _a, secret) => {
                await Bun.sleep(20);
                stored.push(secret);
            },
        });
        const results = await Promise.all([post(page.url, 'secret=one'), post(page.url, 'secret=two')]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(stored).toHaveLength(1);
    });

    test('a secret with a control character is refused on the page before the store sees it', async () => {
        const rec = recorder();
        page = await startSecretPage({ service: 'wicket', account: 'contoso', store: rec.store });
        expect((await post(page.url, 'secret=a%00b')).status).toBe(400);
        expect(rec.stored).toEqual([]);
    });

    test('a page nobody uses closes itself after its time', async () => {
        page = await startSecretPage({ service: 'wicket', account: 'contoso', store: recorder().store, ttlMs: 30 });
        expect(await page.done).toBe('expired');
        await expect(fetch(page.url)).rejects.toThrow();
    });
});

describe('openInBrowser', () => {
    const url = 'http://127.0.0.1:5555/' + 'ab'.repeat(32);

    test('opens the address with the platform URL opener', async () => {
        const runs: Array<[string, string[]]> = [];
        await openInBrowser(url, { env: {}, platform: 'darwin', run: async (command, args) => void runs.push([command, args]) });
        expect(runs).toEqual([['open', [url]]]);
    });

    test('on Windows it hands the address to the URL protocol handler', async () => {
        const runs: Array<[string, string[]]> = [];
        await openInBrowser(url, { env: {}, platform: 'win32', run: async (command, args) => void runs.push([command, args]) });
        expect(runs).toEqual([['rundll32', ['url.dll,FileProtocolHandler', url]]]);
    });

    test('WICKET_OPEN_BROWSER=0 opens nothing, so the caller shows the address instead', async () => {
        let ran = false;
        await expect(
            openInBrowser(url, { env: { WICKET_OPEN_BROWSER: '0' }, platform: 'darwin', run: async () => void (ran = true) }),
        ).rejects.toThrow(/WICKET_OPEN_BROWSER/);
        expect(ran).toBe(false);
    });
});
