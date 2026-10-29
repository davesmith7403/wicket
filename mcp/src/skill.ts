/**
 * The bundled Wicket skill, with progressive disclosure.
 *
 * A skill is a directory: SKILL.md (the entry point an agent loads first) plus references/*.md
 * (depth, loaded one file or one section at a time). This module reads that directory, splits
 * every file into its H2 sections, renders the table of contents wicket_skill answers by default,
 * finds one section or one whole file by name, concatenates everything into the single document
 * the endpoint's `skill` operation serves from a hosted URL, and lifts the essentials section the
 * server sends as its MCP `instructions` (the text every connected host injects into the system
 * prompt, so it is the one part an agent sees without asking).
 *
 * The directory is resolved relative to THIS module (mcp/skill), so `bun run src/index.ts` and a
 * packaged install read the same files with no build step. mcp/skill is a byte-for-byte mirror of
 * skills/wicket-usage, kept in sync by `bun run skill:sync` and asserted by the test suite.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * The bundled guide relative to this module: `skill/` beside `src/` in the package, or
 * `skills/wicket-usage/` beside `server/` in a bundled plugin.
 */
export const SKILL_DIR_DEFAULT = [join(import.meta.dir, '..', 'skill'), join(import.meta.dir, '..', 'skills', 'wicket-usage')].find(
    (dir) => existsSync(join(dir, 'SKILL.md')),
) ?? join(import.meta.dir, '..', 'skill');

/**
 * Where the guide is read from. The plugin's launcher sets WICKET_SKILL_DIR to the plugin's
 * `skills/wicket-usage/`: a compiled server has no files beside it, and one copy then serves both
 * this server and the host.
 */
export function resolveSkillDir(env: Record<string, string | undefined>): string {
    const given = env.WICKET_SKILL_DIR;
    return given && existsSync(join(given, 'SKILL.md')) ? given : SKILL_DIR_DEFAULT;
}

export const SKILL_DIR = resolveSkillDir(process.env);

/** Budget for the MCP `instructions` text: it rides along in every session's system prompt, and older Claude Code builds cut it at 2,048 characters. */
export const INSTRUCTIONS_MAX_CHARS = 2048;

export interface SkillSource {
    /** Path relative to the skill directory: "SKILL.md" or "references/<name>.md". */
    path: string;
    raw: string;
}

export interface SkillSection {
    file: string;
    title: string; // the `##` heading text
    body: string; // the heading line plus its content, up to the next `##`
}

export interface SkillFile extends SkillSource {
    title: string; // the first `# ` heading, else the path
    description: string | undefined; // frontmatter `description`, if present
    sections: SkillSection[];
}

export interface SkillDoc {
    description: string | undefined; // SKILL.md's frontmatter description
    files: SkillFile[];
    sections: SkillSection[]; // every file's sections, in file order
    raw: string; // the single-file bundle
}

/**
 * The files of a skill directory: SKILL.md first, then the reference files in the order SKILL.md
 * first links them (`](references/<name>.md)`), then any unlinked reference file alphabetically.
 */
export function skillFiles(dir: string): SkillSource[] {
    const entry = join(dir, 'SKILL.md');
    if (!existsSync(entry)) throw new Error(`no SKILL.md in ${dir}`);
    const skill = readFileSync(entry, 'utf8');
    const refDir = join(dir, 'references');
    const present = existsSync(refDir)
        ? readdirSync(refDir)
              .filter((f) => f.endsWith('.md'))
              .sort()
        : [];
    const linked: string[] = [];
    for (const m of skill.matchAll(/\]\(references\/([A-Za-z0-9._-]+\.md)\)/g)) {
        const name = m[1]!;
        if (present.includes(name) && !linked.includes(name)) linked.push(name);
    }
    const ordered = [...linked, ...present.filter((f) => !linked.includes(f))];
    return [
        { path: 'SKILL.md', raw: skill },
        ...ordered.map((f) => ({ path: `references/${f}`, raw: readFileSync(join(refDir, f), 'utf8') })),
    ];
}

/** Parse the files of one skill into a document. */
export function parseSkillDoc(sources: SkillSource[]): SkillDoc {
    const files = sources.map(parseSkillFile);
    return {
        description: files[0]?.description,
        files,
        sections: files.flatMap((f) => f.sections),
        raw: bundleOf(files),
    };
}

/**
 * Dependency-free markdown scan: the frontmatter is the block between the first pair of `---`
 * fence lines; the title is the first `# ` line; sections are delimited by lines starting with
 * `## ` (H2). Anything before the first H2 (title/preamble) is not a listed section.
 */
export function parseSkillFile(source: SkillSource): SkillFile {
    const lines = source.raw.split('\n');

    let description: string | undefined;
    let bodyStart = 0;
    if (lines[0]?.trim() === '---') {
        let end = -1;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i]?.trim() === '---') {
                end = i;
                break;
            }
        }
        if (end !== -1) {
            description = parseFrontmatterDescription(lines.slice(1, end));
            bodyStart = end + 1;
        }
    }

    let title: string | undefined;
    const sections: SkillSection[] = [];
    let current: { title: string; body: string[] } | null = null;
    const flush = () => {
        if (current) sections.push({ file: source.path, title: current.title, body: current.body.join('\n').trim() });
    };
    for (let i = bodyStart; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // `## ` is exactly H2 — `### ` fails startsWith('## ') (third char is '#', not ' ').
        if (line.startsWith('## ')) {
            flush();
            current = { title: line.slice(3).trim(), body: [line] };
        } else if (current) {
            current.body.push(line);
        } else if (title === undefined && line.startsWith('# ')) {
            title = line.slice(2).trim();
        }
    }
    flush();

    return { ...source, title: title ?? source.path, description, sections };
}

/**
 * Lift the YAML `description:` value out of the frontmatter. It is a folded scalar that
 * continues across indented lines until the next top-level `key:`; folded newlines collapse to
 * single spaces.
 */
function parseFrontmatterDescription(fmLines: string[]): string | undefined {
    const start = fmLines.findIndex((l) => /^description:/.test(l));
    if (start === -1) return undefined;
    const parts = [(fmLines[start] ?? '').replace(/^description:\s*/, '')];
    for (let j = start + 1; j < fmLines.length; j++) {
        const l = fmLines[j] ?? '';
        // A new non-indented `key:` ends the value.
        if (/^\S/.test(l) && /^[A-Za-z0-9_-]+:/.test(l)) break;
        parts.push(l.trim());
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return text === '' ? undefined : text;
}

/** The cheap table of contents: the description, then every file with its H2 titles. */
export function renderSkillToc(doc: SkillDoc): string {
    const out: string[] = [];
    if (doc.description) out.push(doc.description, '');
    out.push(
        'Sections (fetch one with mode:"section", section:"<title>"; a file name such as "filters" fetches that whole file):',
    );
    for (const f of doc.files) {
        out.push(`${f.path} — ${f.title}`);
        for (const s of f.sections) out.push(`- ${s.title}`);
    }
    return out.join('\n');
}

/**
 * One section by name: an exact (case-insensitive) title first; then a whole file by its stem
 * ("filters"), path or title; then a title that starts with the query, a substring match in either
 * direction, and finally token overlap.
 */
export function findSkillSection(doc: SkillDoc, name: string): SkillSection | undefined {
    const q = name.trim().toLowerCase();
    if (q === '') return undefined;
    const exact = doc.sections.find((s) => s.title.toLowerCase() === q);
    if (exact) return exact;
    const file = doc.files.find(
        (f) => stem(f.path) === q || f.path.toLowerCase() === q || f.title.toLowerCase() === q,
    );
    if (file) return { file: file.path, title: file.title, body: file.raw.trimEnd() };
    const prefix = doc.sections.find((s) => s.title.toLowerCase().startsWith(q));
    if (prefix) return prefix;
    const substring = doc.sections.find((s) => {
        const t = s.title.toLowerCase();
        return t.includes(q) || q.includes(t);
    });
    if (substring) return substring;
    const tokens = q.split(/\s+/).filter((t) => t.length > 2);
    return doc.sections.find((s) => {
        const t = s.title.toLowerCase();
        return tokens.some((tok) => t.includes(tok));
    });
}

function stem(path: string): string {
    return basename(path).replace(/\.md$/i, '').toLowerCase();
}

/** The single-file bundle: every file trimmed, joined by one blank line, ending in a newline. */
export function bundleSkill(doc: SkillDoc): string {
    return doc.raw;
}

function bundleOf(files: SkillSource[]): string {
    return `${files.map((f) => f.raw.trimEnd()).join('\n\n')}\n`;
}

/** The MCP `instructions`: SKILL.md's first H2 section without its heading line. */
export function instructionsFrom(doc: SkillDoc): string {
    const first = doc.files[0]?.sections[0];
    if (!first) return '';
    return first.body.split('\n').slice(1).join('\n').trim();
}

const cache = new Map<string, SkillDoc>();

/** Read + parse a skill directory once, then memoize. */
export function loadSkillDoc(dir: string = SKILL_DIR): SkillDoc {
    let doc = cache.get(dir);
    if (!doc) {
        doc = parseSkillDoc(skillFiles(dir));
        cache.set(dir, doc);
    }
    return doc;
}
