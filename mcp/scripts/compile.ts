/**
 * Compiling the server into one self-contained executable per platform, shared by the plugin build
 * and the smoke test.
 */
import { $, type BunPlugin } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MCP = join(import.meta.dir, '..');

export const TARGETS = [
    { platform: 'darwin-arm64', bun: 'bun-darwin-arm64', file: 'wicket-server' },
    { platform: 'windows-arm64', bun: 'bun-windows-arm64', file: 'wicket-server.exe' },
    { platform: 'windows-x64', bun: 'bun-windows-x64', file: 'wicket-server.exe' },
] as const;

export type Platform = (typeof TARGETS)[number]['platform'];

/** The platform this machine runs, as the release names it. */
export function hostPlatform(): Platform {
    if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
    if (process.platform === 'win32') return process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
    throw new Error(`no server build for ${process.platform}/${process.arch}`);
}

/**
 * Native modules per platform. The WAM broker runtime is never used (Wicket has no broker plugin),
 * and it would inline this machine's path. On Windows the token cache uses DPAPI, which
 * msal-node-extensions loads by a computed path the compiler cannot follow: import it statically so
 * that arch's dpapi.node is embedded, and stub keytar, which is only for macOS and Linux.
 */
function nativeModules(platform: Platform): BunPlugin {
    const windows = platform.startsWith('windows');
    const arch = platform.endsWith('arm64') ? 'arm64' : 'x64';
    return {
        name: 'wicket-native-modules',
        setup(build) {
            const stub = (name: string, contents: string) => {
                const filter = new RegExp(`^${name.replace(/[/@]/g, '\\$&')}$`);
                build.onResolve({ filter }, () => ({ path: name, namespace: 'stub' }));
                build.onLoad({ filter, namespace: 'stub' }, () => ({ contents, loader: 'js' }));
            };
            stub('@azure/msal-node-runtime', 'export const msalNodeRuntime = undefined; export const ErrorStatus = {}; export const LogLevel = {}; export default undefined;');
            if (!windows) return;
            stub('keytar', 'const no = async () => { throw new Error("keytar is not used on Windows"); }; export default { getPassword: no, setPassword: no, deletePassword: no };');
            build.onLoad({ filter: /msal-node-extensions[\\/]dist[\\/]Dpapi\.mjs$/ }, () => ({
                contents: `import Dpapi from "../bin/${arch}/dpapi.node"; export { Dpapi };`,
                loader: 'js',
            }));
        },
    };
}

/**
 * Refuse a binary that carries this checkout's path (a bundler inlining a dependency's __dirname
 * would ship the builder's user name). Not the home folder itself: on a CI runner that is
 * /Users/runner, which the Bun runtime carries from its own build.
 */
export function assertNoBuildPath(path: string): void {
    const root = join(MCP, '..');
    if (readFileSync(path).includes(Buffer.from(root))) throw new Error(`${path} contains ${root}`);
}

/** Compile the server for `platform` into `outfile`, signed where macOS requires it. */
export async function compileServer(platform: Platform, outfile: string): Promise<void> {
    const target = TARGETS.find((t) => t.platform === platform)!;
    const result = await Bun.build({
        entrypoints: [join(MCP, 'src', 'main.ts')],
        minify: true,
        compile: { target: target.bun, outfile },
        plugins: [nativeModules(platform)],
    });
    if (!result.success) throw new AggregateError(result.logs, `server build for ${platform} failed`);
    // The compiler's ad-hoc signature does not cover the payload it appends; macOS kills such a binary.
    if (platform.startsWith('darwin') && process.platform === 'darwin') await $`codesign --force --sign - ${outfile}`.quiet();
    assertNoBuildPath(outfile);
}

/** Build the launcher (mcp/launcher, Go) for an OS and architecture. */
export async function buildLauncher(goos: 'darwin' | 'windows', goarch: 'arm64' | 'amd64' | '386', outfile: string): Promise<void> {
    await $`go build -trimpath -ldflags=${'-s -w'} -o ${outfile} .`
        .cwd(join(MCP, 'launcher'))
        .env({ ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' })
        .quiet();
    assertNoBuildPath(outfile);
}
