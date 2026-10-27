#!/usr/bin/env bun
/**
 * Build the Claude Code plugin in plugin/: the server bundled into one file (a plugin is copied
 * into Claude Code's cache on install, so it cannot reach this repository's node_modules), the
 * skill copied beside it, and the plugin version taken from package.json. Run after changing the
 * server or the skill: `bun run plugin:build`. The suite fails while plugin/ is out of date.
 */
import { $ } from 'bun';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillFiles } from '../src/skill.ts';
import { PLUGIN_DIR, pluginSourceHash } from '../src/plugin.ts';

const MCP = join(import.meta.dir, '..');
const SOURCE_SKILL = join(MCP, '..', 'skills', 'wicket-usage');
const SERVER = join(PLUGIN_DIR, 'server');
const SKILL = join(PLUGIN_DIR, 'skills', 'wicket-usage');

// The server, bundled. Wiped first so a renamed asset (the keychain addon) does not linger.
rmSync(SERVER, { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });
await $`bun build ${join(MCP, 'src', 'index.ts')} --target=bun --outdir=${SERVER}`.quiet();
// The bundler inlines a dependency's __dirname as an absolute path on the building machine: make it
// repository-relative so the bundle does not carry the builder's home folder.
const bundlePath = join(SERVER, 'index.js');
writeFileSync(bundlePath, readFileSync(bundlePath, 'utf8').replaceAll(`${join(MCP, '..')}/`, ''));

// The skill, one copy: Claude Code loads it as a plugin skill and the bundled server reads it for
// wicket_skill and its instructions (see SKILL_DIR).
rmSync(SKILL, { recursive: true, force: true });
mkdirSync(join(SKILL, 'references'), { recursive: true });
for (const f of skillFiles(SOURCE_SKILL)) writeFileSync(join(SKILL, f.path), f.raw);

// The version follows the server's, and the hash records which sources this bundle came from.
const pkg = JSON.parse(readFileSync(join(MCP, 'package.json'), 'utf8')) as { version: string };
const manifestPath = join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
manifest.version = pkg.version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(SERVER, 'SOURCE_HASH'), `${pluginSourceHash()}\n`);

process.stdout.write(`built plugin ${pkg.version} in plugin/\n`);
