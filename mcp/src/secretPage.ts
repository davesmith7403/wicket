/**
 * A one-time page, served on 127.0.0.1, where the person pastes a client secret; the server puts it
 * straight into the system's secret store. The secret never passes through the chat, a shell or a
 * process list, and the same step works on macOS and Windows.
 *
 * Guards: a random port and a 256-bit token in the path; a POST must come from the page itself
 * (Origin), is accepted once, and the page closes after that or after its time (10 minutes). The
 * secret is never logged or echoed back.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60_000;
const MAX_SECRET = 1024;

export interface SecretPage {
    url: string;
    /** 'stored' once the secret is in the store, 'expired' when nobody used the page in time. */
    done: Promise<'stored' | 'expired'>;
    close(): void;
}

export interface SecretPageOptions {
    service: string;
    account: string;
    store: (service: string, account: string, secret: string) => Promise<void>;
    ttlMs?: number;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(account: string, body: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wicket: client secret</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1f2328;background:#fff}
input{width:100%;font:inherit;padding:.5rem;margin:.5rem 0 1rem;box-sizing:border-box}
button{font:inherit;padding:.5rem 1rem}
.note{color:#59636e;font-size:.9rem}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}.note{color:#9198a1}}
</style></head><body>
<h1>Client secret for “${escape(account)}”</h1>
${body}
</body></html>`;
}

const FORM = `<form method="post">
<label for="secret">Paste the app registration's client secret</label>
<input id="secret" name="secret" type="password" autocomplete="off" autofocus required>
<button type="submit">Store it</button>
</form>
<p class="note">It goes into this computer's own secret store (the Keychain on a Mac, protected for your Windows account on Windows). It does not pass through the chat.</p>`;

export async function startSecretPage(options: SecretPageOptions): Promise<SecretPage> {
    const token = randomBytes(32).toString('hex');
    let finish: (outcome: 'stored' | 'expired') => void = () => {};
    const done = new Promise<'stored' | 'expired'>((resolve) => {
        finish = resolve;
    });
    const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // Not no-referrer: under it a browser sends `Origin: null` on the form's own POST.
        'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    };
    const reply = (status: number, body: string) => new Response(page(options.account, body), { status, headers });
    let used = false;
    let storing = false;

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname !== `/${token}` || used) return new Response('Not found', { status: 404 });
            if (req.method === 'GET') return reply(200, FORM);
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
            // Compared with this listener's own address, never with what the request claims: a
            // DNS-rebinding page would name its own host in both Host and Origin.
            const self = `127.0.0.1:${server.port}`;
            if (req.headers.get('host') !== self || req.headers.get('origin') !== `http://${self}`) {
                return new Response('Forbidden', { status: 403 });
            }
            if (storing) return new Response('Already storing a secret', { status: 409 });
            const form = new URLSearchParams((await req.text()).slice(0, MAX_SECRET * 4));
            const secret = (form.get('secret') ?? '').trim();
            if (!secret || secret.length > MAX_SECRET) {
                return reply(400, `<p>That was empty or too long. Try again.</p>${FORM}`);
            }
            if (/[\x00-\x1f\x7f]/.test(secret)) {
                return reply(400, `<p>A client secret has no control characters or line breaks. Try again.</p>${FORM}`);
            }
            storing = true;
            try {
                await options.store(options.service, options.account, secret);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return reply(400, `<p>It was not stored: ${escape(message)}</p>${FORM}`);
            } finally {
                storing = false;
            }
            used = true;
            queueMicrotask(() => close('stored'));
            return reply(200, '<p>Stored. You can close this tab and go back to Claude.</p>');
        },
    });

    const timer = setTimeout(() => close('expired'), options.ttlMs ?? TTL_MS);
    function close(outcome: 'stored' | 'expired'): void {
        clearTimeout(timer);
        // Graceful after a store, so the "Stored" reply still reaches the browser.
        void server.stop(outcome === 'expired');
        finish(outcome);
    }

    return { url: `http://127.0.0.1:${server.port}/${token}`, done, close: () => close('expired') };
}

export interface OpenOptions {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    run?: (command: string, args: string[]) => Promise<void>;
}

const execFileP = (command: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
        execFile(command, args, (err) => (err ? reject(err) : resolve()));
    });

/**
 * Open `url` in the default browser with the platform's URL opener. The URL is passed as it is: a
 * redirect file would hide the token from the process list, but `.html` often opens in an editor on
 * a developer's machine. WICKET_OPEN_BROWSER=0 opens nothing (a headless machine, CI); the caller
 * then shows the address.
 */
export async function openInBrowser(url: string, options: OpenOptions = {}): Promise<void> {
    const env = options.env ?? process.env;
    if (env.WICKET_OPEN_BROWSER === '0') throw new Error('WICKET_OPEN_BROWSER=0: no browser is opened.');
    const platform = options.platform ?? process.platform;
    const [command, args]: [string, string[]] =
        platform === 'win32'
            ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
            : platform === 'darwin'
              ? ['open', [url]]
              : ['xdg-open', [url]];
    await (options.run ?? execFileP)(command, args);
}
