// Board addresses and Ledung's header in a post (docs/steps/message-board.md, decision 3).
import { PROJECT_NAME } from '../config.ts';
import { MAX_ATTACHMENTS, validRef, type AttachmentRef } from './attachments.ts';

/** GitHub's login rules: letters, digits and single hyphens, at most 39. Other services fit inside them. */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const CHANNEL = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export type Address =
  /** "@login": the front desk of that person's Ledung. */
  | { kind: 'person'; login: string }
  /** "@login/Project": that project's manager in that person's Ledung. */
  | { kind: 'project'; login: string; project: string }
  /** "#name": read by managers that follow it; wakes none by itself. */
  | { kind: 'channel'; name: string };

/** An address from what a manager or a header wrote, or the reason it isn't one. */
export function parseAddress(raw: string): Address | string {
  const s = raw.trim();
  if (s.startsWith('#')) {
    const name = s.slice(1).toLowerCase();
    return CHANNEL.test(name) ? { kind: 'channel', name } : `"${s}" is not a channel name: # and up to 48 letters, digits, ".", "_" or "-".`;
  }
  if (!s.startsWith('@')) return `"${s}" is not an address: write @login, @login/Project or #channel.`;
  const slash = s.indexOf('/');
  const login = s.slice(1, slash < 0 ? undefined : slash);
  if (!LOGIN.test(login)) return `"${login}" is not a login.`;
  if (slash < 0) return { kind: 'person', login };
  const project = s.slice(slash + 1).trim();
  if (!PROJECT_NAME.test(project)) return `"${project}" is not a project name: letters, digits, spaces, ".", "_" or "-", at most 48.`;
  return { kind: 'project', login, project };
}

export function formatAddress(a: Address): string {
  return a.kind === 'channel' ? `#${a.name}` : a.kind === 'person' ? `@${a.login}` : `@${a.login}/${a.project}`;
}

export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Ledung's header: a hidden HTML comment at the start of the post (GitHub does not show it). It carries
 * only the addressing and the sending project; the sender always comes from the service (trust rule 1).
 */
const HEADER = /^<!-- ledung (\{.*?\}) -->[ \t]*\r?\n?/;

/** Where a Ledung post's text ends and the attachment list for people reading on the service begins. */
export const ATTACHMENTS_MARK = '<!-- ledung-attachments -->';

export function withHeader(to: string[], fromProject: string, text: string, attachments: AttachmentRef[] = []): string {
  // No "-->" inside the comment, whatever the names hold.
  const json = JSON.stringify({ v: 1, to, from: fromProject, ...(attachments.length ? { att: attachments } : {}) }).replace(/>/g, '\\u003e');
  return `<!-- ledung ${json} -->\n${text}`;
}

export function readHeader(body: string): { viaLedung: boolean; to: string[]; fromProject?: string; text: string; attachments: AttachmentRef[] } {
  const m = HEADER.exec(body);
  if (!m) return { viaLedung: false, to: [], text: body, attachments: [] };
  try {
    const h = JSON.parse(m[1]!) as { to?: unknown; from?: unknown; att?: unknown };
    const to = Array.isArray(h.to) ? h.to.filter((t): t is string => typeof t === 'string').slice(0, 20) : [];
    const fromProject = typeof h.from === 'string' && PROJECT_NAME.test(h.from) ? h.from : undefined;
    // Only attachments Ledung would have written (validRef); the rest are left out, never fetched.
    const attachments = Array.isArray(h.att) ? h.att.slice(0, MAX_ATTACHMENTS).map(validRef).filter((a): a is AttachmentRef => !!a) : [];
    let text = body.slice(m[0].length);
    // The list for people on the service repeats the header's attachments; the manager gets them from the header.
    const mark = text.lastIndexOf(`\n\n${ATTACHMENTS_MARK}`);
    if (mark >= 0 && attachments.length) text = text.slice(0, mark);
    return { viaLedung: true, to, fromProject, text, attachments };
  } catch {
    return { viaLedung: false, to: [], text: body, attachments: [] };
  }
}

/**
 * Text that looks like a secret: known token prefixes, private keys, JWTs, and long unbroken runs of
 * mixed letters and digits (decision 6). Returns what it found, in plain words, or null.
 */
export function tokenLike(text: string): string | null {
  const known: [RegExp, string][] = [
    [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
    [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'a GitHub token'],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic key'],
    [/\bsk-[A-Za-z0-9_-]{32,}/, 'an API key'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT'],
    [/\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i, 'a password or key assignment'],
  ];
  for (const [re, what] of known) if (re.test(text)) return what;
  // 32+ characters with many capitals, small letters and digits mixed: random, so a token. Commit hashes
  // (hex) are common in managers' posts and pass; so do CamelCase names, which have few digits.
  const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
  for (const run of text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    if (/^[0-9a-f]+$/i.test(run)) continue;
    if (count(run, /[A-Z]/g) >= 4 && count(run, /[a-z]/g) >= 4 && count(run, /[0-9]/g) >= 4) return 'a long token-like string';
  }
  return null;
}

/**
 * The project's sensitive patterns applied to a post (decision 6): path patterns against each word that
 * could be a path, command patterns against each line. The first match in plain words, or null.
 */
export function sensitiveInText(text: string, rules: { commandPatterns: string[]; pathPatterns: string[] }): string | null {
  const words = text.split(/[\s"'`()<>[\]{},;]+/).filter(Boolean);
  for (const p of rules.pathPatterns) {
    const re = new RegExp(p, 'i');
    const hit = words.find((w) => re.test(w.replace(/[.:!?]+$/, '')) || re.test(w));
    if (hit) return `"${hit}" matches the sensitive path pattern /${p}/`;
  }
  const lines = text.split(/\r?\n/);
  for (const p of rules.commandPatterns) {
    const re = new RegExp(p, 'i');
    if (lines.some((l) => re.test(l))) return `a line matches the sensitive command pattern /${p}/`;
  }
  return null;
}
