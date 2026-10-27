#!/usr/bin/env bun
/**
 * Mirror skills/wicket-usage into mcp/skill (what the packaged server reads) and regenerate the
 * single-file bundle docs/wicket-usage-skill.md (what an admin hosts for the endpoint's `skill`
 * operation). Run after editing the skill: `bun run skill:sync`. The test suite asserts both are
 * in sync.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleSkill, parseSkillDoc, skillFiles } from '../src/skill.ts';

const ROOT = join(import.meta.dir, '..', '..');
const SOURCE = join(ROOT, 'skills', 'wicket-usage');
const MIRROR = join(import.meta.dir, '..', 'skill');
const BUNDLE = join(ROOT, 'docs', 'wicket-usage-skill.md');

const files = skillFiles(SOURCE);

// Replace the mirror wholesale so a renamed or removed reference file does not linger.
if (existsSync(MIRROR)) {
    for (const name of readdirSync(MIRROR)) rmSync(join(MIRROR, name), { recursive: true, force: true });
}
mkdirSync(join(MIRROR, 'references'), { recursive: true });
for (const f of files) writeFileSync(join(MIRROR, f.path), f.raw);

const bundle = bundleSkill(parseSkillDoc(files));
writeFileSync(BUNDLE, bundle);

process.stdout.write(
    `synced ${files.length} files to mcp/skill and wrote docs/wicket-usage-skill.md (${Buffer.byteLength(bundle, 'utf8')} bytes)\n`,
);
