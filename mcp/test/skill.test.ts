/**
 * The modular skill loader behind wicket_skill and the server instructions: a skill directory
 * (SKILL.md + references/*.md) parsed into files and H2 sections, the table of contents, section
 * and file lookup, the single-file bundle, and the essentials section the server injects as its
 * MCP `instructions`. Plus the real bundled skill: in sync with the repo source, every tool
 * documented, section titles unique, instructions within budget.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    SKILL_DIR_DEFAULT,
    resolveSkillDir,
    INSTRUCTIONS_MAX_CHARS,
    bundleSkill,
    findSkillSection,
    instructionsFrom,
    loadSkillDoc,
    parseSkillDoc,
    renderSkillToc,
    skillFiles,
} from '../src/skill.ts';
import { TOOL_NAMES } from '../src/index.ts';

const SKILL = [
    '---',
    'name: demo',
    'description: Use when the folded',
    '  description continues here',
    '   and here.',
    'other: value',
    '---',
    '# Demo skill',
    'preamble that is not a section',
    '## Essentials',
    'rule one',
    'rule two',
    '## Alpha',
    'alpha body, see [filters](references/filters.md) and [tools](references/tools.md)',
    '### Alpha sub',
    'sub body',
    '',
    '## Beta — with dash',
    'beta body',
    '##Not a heading (no space)',
    '',
].join('\n');

const TOOLS = ['# Tool reference', '', '## wicket_query — read rows', 'query body', '', '## wicket_insert — create', 'insert body', ''].join('\n');
const FILTERS = ['# Filter cookbook', '', 'intro line', '', '## Comparisons', 'eq ne', '', '## Wildcards', 'star', ''].join('\n');
const ZETA = ['# Unlinked file', '', '## Gamma', 'gamma body', ''].join('\n');

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wicket-skill-'));
    mkdirSync(join(dir, 'references'));
    writeFileSync(join(dir, 'SKILL.md'), SKILL);
    writeFileSync(join(dir, 'references', 'tools.md'), TOOLS);
    writeFileSync(join(dir, 'references', 'filters.md'), FILTERS);
    writeFileSync(join(dir, 'references', 'zeta.md'), ZETA);
    writeFileSync(join(dir, 'references', 'notes.txt'), 'not markdown, ignored');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('resolveSkillDir', () => {
    test('the launcher-given WICKET_SKILL_DIR wins: a compiled server has no files of its own', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wicket-skill-'));
        try {
            writeFileSync(join(dir, 'SKILL.md'), '# x');
            expect(resolveSkillDir({ WICKET_SKILL_DIR: dir })).toBe(dir);
            // Without it, the module-relative copies are used as before.
            expect(resolveSkillDir({})).toBe(SKILL_DIR_DEFAULT);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('skillFiles', () => {
    test('SKILL.md first, then reference files in the order SKILL.md links them, then the rest alphabetically', () => {
        expect(skillFiles(dir).map((f) => f.path)).toEqual(['SKILL.md', 'references/filters.md', 'references/tools.md', 'references/zeta.md']);
    });

    test('a directory without SKILL.md is an error', () => {
        rmSync(join(dir, 'SKILL.md'));
        expect(() => skillFiles(dir)).toThrow(/SKILL\.md/);
    });
});

describe('parseSkillDoc', () => {
    const doc = () => parseSkillDoc(skillFiles(dir));

    test('folds the frontmatter description into one line and takes the title from the H1', () => {
        const d = doc();
        expect(d.description).toBe('Use when the folded description continues here and here.');
        expect(d.files[0]!.title).toBe('Demo skill');
        expect(d.files[1]!.title).toBe('Filter cookbook');
    });

    test('splits on H2 only; H3 stays inside its parent; preamble is not a section; sections know their file', () => {
        const d = doc();
        expect(d.files[0]!.sections.map((s) => s.title)).toEqual(['Essentials', 'Alpha', 'Beta — with dash']);
        expect(d.files[0]!.sections[1]!.body).toBe(
            '## Alpha\nalpha body, see [filters](references/filters.md) and [tools](references/tools.md)\n### Alpha sub\nsub body',
        );
        expect(d.files[0]!.sections[2]!.body).toBe('## Beta — with dash\nbeta body\n##Not a heading (no space)');
        expect(d.sections.map((s) => `${s.file}:${s.title}`)).toEqual([
            'SKILL.md:Essentials',
            'SKILL.md:Alpha',
            'SKILL.md:Beta — with dash',
            'references/filters.md:Comparisons',
            'references/filters.md:Wildcards',
            'references/tools.md:wicket_query — read rows',
            'references/tools.md:wicket_insert — create',
            'references/zeta.md:Gamma',
        ]);
    });

    test('a file without frontmatter or H1 still parses', () => {
        const d = parseSkillDoc([{ path: 'SKILL.md', raw: '## Only\nbody' }]);
        expect(d.description).toBeUndefined();
        expect(d.files[0]!.title).toBe('SKILL.md');
        expect(d.sections).toEqual([{ file: 'SKILL.md', title: 'Only', body: '## Only\nbody' }]);
    });

    test('an unterminated frontmatter fence is treated as body', () => {
        const d = parseSkillDoc([{ path: 'SKILL.md', raw: '---\nname: x\n## Real\nbody' }]);
        expect(d.description).toBeUndefined();
        expect(d.sections.map((s) => s.title)).toEqual(['Real']);
    });
});

describe('findSkillSection', () => {
    const doc = () => parseSkillDoc(skillFiles(dir));

    test('exact (case-insensitive) match wins, across files', () => {
        expect(findSkillSection(doc(), 'ALPHA')?.title).toBe('Alpha');
        expect(findSkillSection(doc(), ' wildcards ')?.file).toBe('references/filters.md');
    });

    test('falls back to substring in either direction, then to token overlap', () => {
        expect(findSkillSection(doc(), 'beta')?.title).toBe('Beta — with dash');
        expect(findSkillSection(doc(), 'the alpha section please')?.title).toBe('Alpha');
        expect(findSkillSection(doc(), 'wicket_insert')?.title).toBe('wicket_insert — create');
        expect(findSkillSection(doc(), 'something dash')?.title).toBe('Beta — with dash');
    });

    test('a file name or title fetches the whole file as one section', () => {
        const byStem = findSkillSection(doc(), 'filters');
        expect(byStem?.file).toBe('references/filters.md');
        expect(byStem?.title).toBe('Filter cookbook');
        expect(byStem?.body).toBe(FILTERS.trimEnd());
        expect(findSkillSection(doc(), 'references/tools.md')?.title).toBe('Tool reference');
        expect(findSkillSection(doc(), 'tool reference')?.body).toBe(TOOLS.trimEnd());
    });

    test('an exact section title beats a file whose stem happens to match', () => {
        writeFileSync(join(dir, 'references', 'alpha.md'), '# Alpha file\n\n## Something\nx\n');
        expect(findSkillSection(doc(), 'alpha')?.body.startsWith('## Alpha')).toBe(true);
    });

    test('an empty or unmatched query yields undefined', () => {
        expect(findSkillSection(doc(), '')).toBeUndefined();
        expect(findSkillSection(doc(), '   ')).toBeUndefined();
        expect(findSkillSection(doc(), 'omega')).toBeUndefined();
    });
});

describe('renderSkillToc', () => {
    test('description, then each file with its sections, with the fetch hint', () => {
        expect(renderSkillToc(parseSkillDoc(skillFiles(dir)))).toBe(
            [
                'Use when the folded description continues here and here.',
                '',
                'Sections (fetch one with mode:"section", section:"<title>"; a file name such as "filters" fetches that whole file):',
                'SKILL.md — Demo skill',
                '- Essentials',
                '- Alpha',
                '- Beta — with dash',
                'references/filters.md — Filter cookbook',
                '- Comparisons',
                '- Wildcards',
                'references/tools.md — Tool reference',
                '- wicket_query — read rows',
                '- wicket_insert — create',
                'references/zeta.md — Unlinked file',
                '- Gamma',
            ].join('\n'),
        );
    });
});

describe('bundleSkill and instructionsFrom', () => {
    test('the bundle is SKILL.md followed by every reference file in order, each separated by a blank line', () => {
        const bundle = bundleSkill(parseSkillDoc(skillFiles(dir)));
        expect(bundle.startsWith('---\nname: demo')).toBe(true);
        expect(bundle).toBe([SKILL.trimEnd(), FILTERS.trimEnd(), TOOLS.trimEnd(), ZETA.trimEnd()].join('\n\n') + '\n');
    });

    test('the instructions are the first H2 section of SKILL.md without its heading line', () => {
        expect(instructionsFrom(parseSkillDoc(skillFiles(dir)))).toBe('rule one\nrule two');
    });

    test('a SKILL.md without an H2 yields empty instructions', () => {
        expect(instructionsFrom(parseSkillDoc([{ path: 'SKILL.md', raw: '# T\nno sections' }]))).toBe('');
    });
});

describe('loadSkillDoc', () => {
    test('is memoised per directory', () => {
        const a = loadSkillDoc(dir);
        expect(loadSkillDoc(dir)).toBe(a);
    });
});

// ---------------------------------------------------------------------------
// the real skill
// ---------------------------------------------------------------------------

describe('bundled skill', () => {
    const bundledDir = join(import.meta.dir, '..', 'skill');
    const sourceDir = join(import.meta.dir, '..', '..', 'skills', 'wicket-usage');

    test('mcp/skill mirrors skills/wicket-usage byte for byte (run `bun run skill:sync` after editing the skill)', () => {
        const bundled = skillFiles(bundledDir);
        const source = skillFiles(sourceDir);
        expect(bundled.map((f) => f.path)).toEqual(source.map((f) => f.path));
        for (const [i, f] of bundled.entries()) {
            // Buffer.equals: a byte compare, so a whitespace/line-ending drift fails too.
            expect(Buffer.from(f.raw).equals(Buffer.from(source[i]!.raw))).toBe(true);
        }
    });

    test('the hosted single-file bundle (docs/wicket-usage-skill.md) is up to date', () => {
        const hosted = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'wicket-usage-skill.md'), 'utf8');
        expect(hosted).toBe(bundleSkill(loadSkillDoc(bundledDir)));
    });

    test('loads, is memoised, and documents every tool the server registers', () => {
        const doc = loadSkillDoc(bundledDir);
        expect(loadSkillDoc(bundledDir)).toBe(doc);
        expect(doc.description).toMatch(/Business Central/);
        const titles = doc.sections.map((s) => s.title.toLowerCase());
        for (const name of TOOL_NAMES) {
            expect(titles.some((t) => t.startsWith(name) || t.startsWith(`\`${name}\``))).toBe(true);
        }
    });

    test('section titles are unique across files, so a section fetch is unambiguous', () => {
        const titles = loadSkillDoc(bundledDir).sections.map((s) => s.title.toLowerCase());
        expect(new Set(titles).size).toBe(titles.length);
    });

    test('the frontmatter fits the Agent Skills limits and the description states when to use the skill', () => {
        const raw = loadSkillDoc(bundledDir).files[0]!.raw;
        const frontmatter = raw.split('\n---')[0]!;
        expect(frontmatter.length).toBeLessThanOrEqual(1024);
        expect(loadSkillDoc(bundledDir).description).toMatch(/^Use when/);
    });

    test('the server instructions stay within budget and point at the guide', () => {
        const instructions = instructionsFrom(loadSkillDoc(bundledDir));
        expect(instructions.length).toBeGreaterThan(200);
        expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
        expect(instructions).toContain('wicket_skill');
    });
});
