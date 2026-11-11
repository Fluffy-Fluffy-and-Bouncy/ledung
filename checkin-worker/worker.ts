// The endpoint of Ledung's anonymous daily check-in (#220): a Cloudflare Worker with a D1 database. It keeps one row
// per install ID: the day it was first and last seen, and the version, channel and operating system it last sent.
// Nothing else is stored, the IP address included (the README's promise). Deploying it is Martin's step (#220).
//
//   POST /v1/checkin   {id, version, channel, os}   → 204; anything else in the body is ignored, never stored
//   GET  /v1/counts    Authorization: Bearer <COUNTS_TOKEN>  → unique installs, active in 1/7/30 days, the splits
//
// Plain TypeScript with no Cloudflare packages: the few D1 calls it makes are typed below, so `npm run check` type
// checks it and test/checkin-worker.test.ts runs it under Node against node:sqlite with schema.sql.

/** The part of D1's API this Worker uses (https://developers.cloudflare.com/d1/worker-api/). */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
}

export interface Env {
  DB: D1Database;
  /** A secret (wrangler secret put COUNTS_TOKEN); without it the counts are not served at all. */
  COUNTS_TOKEN?: string;
}

export interface CheckIn {
  id: string;
  version: string;
  channel: 'public' | 'dev';
  os: string;
}

/** A body is four short fields; anything much longer is not a check-in. */
const MAX_BODY = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
// process.platform's values, all short lowercase words.
const OS = /^[a-z0-9]{1,16}$/;
/** The windows the counts are given for, in days. */
export const ACTIVE_DAYS = [1, 7, 30] as const;

/** The four fields from a check-in's body, or null when it isn't one. Other fields are dropped here. */
export function parseCheckIn(body: unknown): CheckIn | null {
  if (!body || typeof body !== 'object') return null;
  const { id, version, channel, os } = body as Record<string, unknown>;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (channel !== 'public' && channel !== 'dev') return null;
  if (typeof os !== 'string' || !OS.test(os)) return null;
  return { id, version, channel, os };
}

/** The UTC day of a time, as YYYY-MM-DD: the store keeps days, not times. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export async function record(db: D1Database, c: CheckIn, now: number): Promise<void> {
  const day = dayOf(now);
  await db.prepare(
    'INSERT INTO installs (id, first_day, last_day, version, channel, os) VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET last_day = excluded.last_day, version = excluded.version, channel = excluded.channel, os = excluded.os',
  ).bind(c.id, day, day, c.version, c.channel, c.os).run();
}

export interface Counts {
  day: string;
  unique: number;
  /** Installs last seen within the last N days, today included: "1" is today. */
  active: Record<string, number>;
  /** Among the installs active in the last 30 days. */
  byVersion: Record<string, number>;
  byChannel: Record<string, number>;
  byOs: Record<string, number>;
}

export async function counts(db: D1Database, now: number): Promise<Counts> {
  const day = dayOf(now);
  const since = (days: number) => dayOf(now - (days - 1) * 86_400_000);
  const unique = (await db.prepare('SELECT COUNT(*) AS n FROM installs').first<{ n: number }>())?.n ?? 0;
  const active: Record<string, number> = {};
  for (const d of ACTIVE_DAYS) {
    active[d] = (await db.prepare('SELECT COUNT(*) AS n FROM installs WHERE last_day >= ?').bind(since(d)).first<{ n: number }>())?.n ?? 0;
  }
  const split = async (column: 'version' | 'channel' | 'os') => {
    // The column is one of three fixed names, never from the request.
    const rows = (await db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM installs WHERE last_day >= ? GROUP BY ${column} ORDER BY n DESC`).bind(since(30)).all<{ k: string; n: number }>()).results;
    return Object.fromEntries(rows.map((r) => [r.k, r.n]));
  };
  return { day, unique, active, byVersion: await split('version'), byChannel: await split('channel'), byOs: await split('os') };
}

/**
 * Compares two strings in time that doesn't depend on where they differ, so the token can't be guessed byte by
 * byte from response times (privacy and security review of PR #223). Plain code: Node has no crypto.subtle one.
 */
export function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function handle(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/v1/checkin') {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    // A declared size is refused before the body is read; a body sent without one is measured after.
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) return new Response(null, { status: 413 });
    const text = await request.text();
    if (text.length > MAX_BODY) return new Response(null, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400 });
    }
    const c = parseCheckIn(body);
    if (!c) return new Response(null, { status: 400 });
    await record(env.DB, c, now);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/v1/counts') {
    if (!env.COUNTS_TOKEN || !sameText(request.headers.get('Authorization') ?? '', `Bearer ${env.COUNTS_TOKEN}`)) return new Response(null, { status: 404 });
    return Response.json(await counts(env.DB, now), { headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(null, { status: 404 });
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
