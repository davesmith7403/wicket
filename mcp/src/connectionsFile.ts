/**
 * Safe edits of connections.json, for setup. Every edit re-reads the file right before writing, so
 * a hand edit or another session's save made since this server loaded it is kept; only the fields
 * an edit names change, and every other entry (a rejected one included) is written back as it was.
 * A file that is not valid JSON is never written: it is reported, and moved aside only on request.
 * Writes are atomic (temp file + rename), mode 600 in a 700 directory, with the previous file kept
 * as connections.json.bak.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { authRecordPath, connectionsFile } from './connections.js';

/** connections.json exists but is not a JSON object with a `connections` object: setup will not rewrite it. */
export class ConnectionsFileUnreadableError extends Error {
    constructor(
        readonly file: string,
        reason: string,
    ) {
        super(`${file} cannot be read (${reason}); it was left as it is.`);
        this.name = 'ConnectionsFileUnreadableError';
    }
}

interface FileDoc {
    default?: string;
    connections: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
}

function readDoc(file: string): FileDoc {
    if (!existsSync(file)) return { connections: {} };
    let doc: unknown;
    try {
        doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        throw new ConnectionsFileUnreadableError(file, err instanceof Error ? err.message : String(err));
    }
    const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObject(doc) || !isObject(doc.connections)) {
        throw new ConnectionsFileUnreadableError(file, 'expected an object with a "connections" object');
    }
    return doc as FileDoc;
}

function writeDoc(file: string, doc: FileDoc): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file)) {
        // The backup may hold an inline secret: keep it as private as the file itself.
        copyFileSync(file, `${file}.bak`);
        chmodSync(`${file}.bak`, 0o600);
    }
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
}

function edit(change: (doc: FileDoc) => void): void {
    const file = connectionsFile();
    const doc = readDoc(file);
    change(doc);
    writeDoc(file, doc);
}

/** Add `name`, or merge `fields` over it when `replace` is set; other keys of the entry are kept. */
export function upsertConnection(
    name: string,
    fields: Record<string, unknown>,
    opts: { replace: boolean; makeDefault?: boolean; validate?: (name: string, merged: Record<string, unknown>) => void },
): void {
    edit((doc) => {
        const existing = doc.connections[name];
        if (existing && !opts.replace) throw new Error(`connection "${name}" exists`);
        const merged = { ...(existing ?? {}), ...fields };
        // Check the entry as it will be written, kept fields included (a companies allowlist, say).
        opts.validate?.(name, merged);
        doc.connections[name] = merged;
        if (opts.makeDefault) doc.default = name;
    });
}

/**
 * Remove `name` and its saved sign-in record. When it was the default and one connection is left,
 * that one becomes the default; with several left the default keeps naming the removed one, so calls
 * without an explicit connection fail until someone picks (`defaultCleared: true`) rather than
 * landing on whichever connection happens to be first.
 */
export function removeConnection(name: string): { defaultCleared: boolean } {
    let defaultCleared = false;
    edit((doc) => {
        if (!(name in doc.connections)) throw new Error(`connection "${name}" is not in ${connectionsFile()}`);
        delete doc.connections[name];
        if (doc.default === name) {
            const left = Object.keys(doc.connections);
            if (left.length === 1) doc.default = left[0];
            else if (left.length === 0) delete doc.default;
            else defaultCleared = true;
        }
    });
    rmSync(authRecordPath(name), { force: true });
    return { defaultCleared };
}

export function setDefaultConnection(name: string): void {
    edit((doc) => {
        if (!(name in doc.connections)) throw new Error(`connection "${name}" is not in ${connectionsFile()}`);
        doc.default = name;
    });
}

/** Rename an unreadable connections.json to connections.json.broken-<YYYYMMDD-HHMMSS>; returns the new path. */
export function moveAsideBroken(): string {
    const file = connectionsFile();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const target = `${file}.broken-${stamp}`;
    renameSync(file, target);
    return target;
}
