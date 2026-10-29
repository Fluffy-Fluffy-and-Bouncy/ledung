// Keeping ledung.db small (issue #349). Claude Code keeps every session's full transcript itself, so Ledung's copy of
// tool results is only for the page: an image's data is never stored, a result's text is stored up to RESULT_LIMIT,
// and once a session has been ended for `days` its results are cut to OLD_RESULT_LIMIT. Assistant messages (text,
// tool names and inputs, usage), questions, permissions, decisions and usage records are never touched.
//
// A cut result block carries `ledung_cut: { chars }`, which the page shows as a note; an image keeps its type and
// loses its data (the page shows "[image]" for it, as it always did).
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** A tool result's text is stored up to this many characters (the issue's 64 KB). */
export const RESULT_LIMIT = 64 * 1024;
/** What a session ended `days` ago keeps of each tool result: enough for the page's preview and an error's first lines. */
export const OLD_RESULT_LIMIT = 2000;

const DAY = 24 * 60 * 60 * 1000;

function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** An image block without its data. */
function imagePlaceholder(b: any): any {
  if (b.ledung_omitted !== undefined) return b;
  return { type: 'image', ledung_omitted: jsonLength(b.source) };
}

/** A tool result block cut to `limit` characters of text; the same block if nothing needs cutting. */
function trimResult(b: any, limit: number): any {
  const already = Number(b.ledung_cut?.chars ?? 0);
  let cut = 0;
  let content = b.content;
  if (typeof content === 'string') {
    if (content.length > limit) {
      cut = content.length - limit;
      content = content.slice(0, limit);
    }
  } else if (Array.isArray(content)) {
    let left = limit;
    let changed = false;
    const blocks: any[] = [];
    for (const c of content) {
      if (c?.type === 'image') {
        const p = imagePlaceholder(c);
        if (p !== c) changed = true;
        blocks.push(p);
      } else if (c?.type === 'text' && typeof c.text === 'string') {
        if (c.text.length > left) {
          cut += c.text.length - left;
          changed = true;
          if (left > 0) blocks.push({ ...c, text: c.text.slice(0, left) });
          left = 0;
        } else {
          left -= c.text.length;
          blocks.push(c);
        }
      } else {
        // Any other block (a document, a search result): kept while it fits, else only its type.
        const n = jsonLength(c);
        if (n > left) {
          cut += n;
          changed = true;
          blocks.push({ type: c?.type, ledung_omitted: n });
        } else {
          left -= n;
          blocks.push(c);
        }
      }
    }
    if (!changed) return b;
    content = blocks;
  }
  if (cut === 0 && content === b.content) return b;
  return { ...b, content, ...(cut > 0 ? { ledung_cut: { chars: already + cut } } : {}) };
}

/**
 * What Ledung stores of a line from Claude Code: in a user message (the one carrying tool results), every image
 * without its data and every tool result cut to `limit` characters, and the structured copy of the result
 * (`tool_use_result`, which nothing in Ledung reads) left out when it is bigger than that or holds an image.
 * Any other line, and a user message with nothing to cut, comes back as the same object.
 */
export function trimForStorage(m: any, limit = RESULT_LIMIT): any {
  if (m?.type !== 'user' || typeof m.message !== 'object' || m.message === null) return m;
  let out = m;
  const content = m.message.content;
  if (Array.isArray(content)) {
    let changed = false;
    const blocks = content.map((b: any) => {
      const t = b?.type === 'tool_result' ? trimResult(b, limit) : b?.type === 'image' ? imagePlaceholder(b) : b;
      if (t !== b) changed = true;
      return t;
    });
    if (changed) out = { ...m, message: { ...m.message, content: blocks } };
  }
  const structured = m.tool_use_result;
  if (structured !== undefined && (typeof structured !== 'object' || structured === null || !structured.ledung_omitted)) {
    const json = JSON.stringify(structured) ?? '';
    if (json.length > limit || /"type":"image"|"base64"/.test(json)) out = { ...out, tool_use_result: { ledung_omitted: json.length } };
  }
  return out;
}

const yieldToOthers = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface TrimResult {
  sessions: number;
  rows: number;
  /** Characters of stored JSON removed. */
  chars: number;
  /** Bytes the file gave back through incremental vacuum (0 until the one-off VACUUM at a start has switched it on). */
  reclaimed: number;
}

export interface TrimmerOptions {
  /** The config's keepToolResultsDays, read at each pass. */
  days: () => number;
  now?: () => number;
  /** Characters of stored JSON read per write before a pause. */
  batchChars?: number;
  pauseMs?: number;
  everyMs?: number;
  firstAfterMs?: number;
  log?: (line: string) => void;
}

/** Meta key: the one-off cut of rows stored before #349 is done. */
const STORAGE_CUT_DONE = 'tool-results-cut';

/**
 * Shrinks the stored tool results of sessions ended more than `days()` ago (and, once, every row stored before #349
 * to what storage keeps now), in small batches with pauses between them so the page and sessions go on meanwhile,
 * then gives the freed pages back to the file system when the database has incremental vacuum (see compactAtStart).
 * A session is done once until it ends again.
 */
export class HistoryTrimmer {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TrimResult> | null = null;
  private readonly db: DatabaseSync;
  private readonly opts: TrimmerOptions;

  constructor(db: DatabaseSync, opts: TrimmerOptions) {
    this.db = db;
    this.opts = opts;
  }

  /** A pass shortly after the start, then every few hours. */
  start(): void {
    const every = this.opts.everyMs ?? 6 * 60 * 60 * 1000;
    const tick = () => {
      void this.run().catch((e) => this.opts.log?.(`Shrinking old tool results failed: ${(e as Error).message}`));
      this.timer = setTimeout(tick, every);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, this.opts.firstAfterMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One pass; a second call while one runs gets the same pass. */
  run(): Promise<TrimResult> {
    this.running ??= this.pass().finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(): Promise<TrimResult> {
    const now = (this.opts.now ?? Date.now)();
    const result: TrimResult = { sessions: 0, rows: 0, chars: 0, reclaimed: 0 };
    // Once: rows stored before #349 get what every row gets at storage now (screenshots out, results cut at 64 KB),
    // in every session, so a database full of recent sessions shrinks too.
    if (!this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(STORAGE_CUT_DONE)) {
      const all = this.db.prepare('SELECT id FROM sessions ORDER BY created_at').all() as { id: string }[];
      for (const s of all) await this.trimSession(s.id, RESULT_LIMIT, result);
      this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(STORAGE_CUT_DONE, new Date(now).toISOString());
    }
    const old = this.db
      .prepare(`SELECT id FROM sessions WHERE status = 'ended' AND ended_at IS NOT NULL AND ended_at < ? AND (trimmed_at IS NULL OR trimmed_at < ended_at) ORDER BY ended_at, id`)
      .all(now - this.opts.days() * DAY) as { id: string }[];
    const done = this.db.prepare('UPDATE sessions SET trimmed_at = ? WHERE id = ?');
    const stillEnded = this.db.prepare(`SELECT 1 FROM sessions WHERE id = ? AND status = 'ended'`);
    const newest = this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE session_id = ?');
    for (const s of old) {
      // Resumed since the list was read: skipped, and done when it ends again. Resumed during its own walk: what it
      // says from then on is past the walk's end, so it is stored as any running session's (review of PR #352, M4).
      if (!stillEnded.get(s.id)) continue;
      const upTo = Number((newest.get(s.id) as { id: number | null }).id ?? 0);
      await this.trimSession(s.id, OLD_RESULT_LIMIT, result, upTo);
      done.run(now, s.id);
      result.sessions++;
    }
    result.reclaimed = await this.reclaim();
    if (result.rows) {
      this.opts.log?.(`Shrank ${result.rows} stored tool result(s), ${mb(result.chars)} MB` +
        (result.reclaimed ? `; the database gave back ${mb(result.reclaimed)} MB.` : '; the space is given back at a later start.'));
    }
    return result;
  }

  /**
   * Cuts one session's stored tool results to `limit`, up to message `upTo`: its rows a few at a time, one short write
   * per batch of about batchChars read, then a pause. The type and size are checked here, not in SQL: SQLite reads a
   * row's whole text for LIKE, length and octet_length alike, and a query over 500 big rows held the event loop for 1 s
   * (#349).
   */
  private async trimSession(sessionId: string, limit: number, result: TrimResult, upTo = Number.MAX_SAFE_INTEGER): Promise<void> {
    const batchChars = this.opts.batchChars ?? 2 * 1024 * 1024;
    const next = this.db.prepare(`SELECT id, data FROM messages WHERE session_id = ? AND id > ? AND id <= ? AND kind = 'sdk' ORDER BY id LIMIT 10`);
    const write = this.db.prepare('UPDATE messages SET data = ? WHERE id = ?');
    let after = 0;
    for (let finished = false; !finished;) {
      let chars = 0;
      this.db.exec('BEGIN');
      try {
        while (chars < batchChars) {
          const rows = next.all(sessionId, after, upTo) as { id: number; data: string }[];
          if (!rows.length) {
            finished = true;
            break;
          }
          for (const row of rows) {
            after = Number(row.id);
            chars += row.data.length;
            if (row.data.length <= limit || !row.data.startsWith('{"type":"user"')) continue;
            let m: unknown;
            try {
              m = JSON.parse(row.data);
            } catch {
              continue;
            }
            const t = trimForStorage(m, limit);
            if (t === m) continue;
            const json = JSON.stringify(t);
            write.run(json, row.id);
            result.rows++;
            result.chars += row.data.length - json.length;
          }
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
      await yieldToOthers(this.opts.pauseMs ?? 20);
    }
  }

  /**
   * Gives free pages back 2 MB at a time, when the database has incremental vacuum. Returns the bytes. Each step is
   * checkpointed at once: one checkpoint of everything moved held the event loop for 3 s on a 3 GB database.
   */
  private async reclaim(): Promise<number> {
    if (pragma(this.db, 'auto_vacuum') !== 2) return 0;
    const page = pragma(this.db, 'page_size');
    let freed = 0;
    for (let free = pragma(this.db, 'freelist_count'); free > 0; free = pragma(this.db, 'freelist_count')) {
      const step = Math.min(free, Math.max(1, Math.floor((2 * 1024 * 1024) / page)));
      this.db.exec(`PRAGMA incremental_vacuum(${step})`);
      // In WAL mode the file only shrinks at a checkpoint; PASSIVE never waits on a reader.
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      freed += step * page;
      await yieldToOthers(this.opts.pauseMs ?? 20);
    }
    return freed;
  }
}

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1);
}

function pragma(db: DatabaseSync, name: string): number {
  const r = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Number(Object.values(r)[0]);
}

/** A database smaller than this is switched at once: its VACUUM is quick. */
export const VACUUM_AT_START_BYTES = 64 * 1024 * 1024;

export interface CompactOptions {
  log?: (line: string) => void;
  /** Below this size a database is switched whatever its free space; default VACUUM_AT_START_BYTES. */
  threshold?: number;
  /** Free bytes on the database's disk; default from the file system. Null: unknown. */
  diskFree?: () => number | null;
}

/** Free bytes on the disk holding the database's file, or null (in memory, or the file system won't say). */
function diskFreeFor(db: DatabaseSync): number | null {
  const main = (db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find((d) => d.name === 'main');
  if (!main?.file) return null;
  try {
    const s = fs.statfsSync(path.dirname(main.file));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * At a start, before anything else uses the database: a database without incremental vacuum (any made before #349)
 * gets it, with the one VACUUM that switching needs, once at least half the file is free space (the trim passes made
 * it) or the file is under `threshold` and so quick. VACUUM rewrites the live data only, so it takes as long as what is
 * left after the trim, not the file's old size; it runs here because it holds the database that long. It never stops
 * a start: too little disk for the copy it writes, or a database another program holds, is logged and tried again at
 * the next start (review of PR #352, finding I1). Returns what it did, or null.
 */
export function compactAtStart(db: DatabaseSync, opts: CompactOptions = {}): { ms: number; before: number; after: number } | null {
  const log = opts.log ?? (() => {});
  const threshold = opts.threshold ?? VACUUM_AT_START_BYTES;
  if (pragma(db, 'auto_vacuum') === 2) return null;
  const page = pragma(db, 'page_size');
  const size = pragma(db, 'page_count') * page;
  const free = pragma(db, 'freelist_count') * page;
  // A VACUUM takes as long as the data left (6-43 s for 0.5-1.3 GB on a Mac, #349), so a big one waits until at least
  // half the file is free: then it runs once, on the least data. Until then new rows reuse the free pages.
  if (size >= threshold && free < size / 2) return null;
  // The copy VACUUM writes needs about the live data's size on the same disk.
  const disk = (opts.diskFree ?? (() => diskFreeFor(db)))();
  if (disk !== null && disk < size - free) {
    log(`Could not give the freed space back: the disk has ${mb(disk)} MB free and the database needs ${mb(size - free)} MB for it; Ledung tries again at the next start.`);
    return null;
  }
  const big = size >= threshold;
  if (big) log(`Giving ${mb(free)} MB of freed space in the database back; this takes a moment, once...`);
  const t = Date.now();
  try {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    log(`Could not give the freed space back: ${(e as Error).message}; Ledung tries again at the next start.`);
    return null;
  }
  const after = pragma(db, 'page_count') * page;
  const ms = Date.now() - t;
  if (big) log(`The database went from ${mb(size)} MB to ${mb(after)} MB in ${(ms / 1000).toFixed(1)} s.`);
  return { ms, before: size, after };
}
