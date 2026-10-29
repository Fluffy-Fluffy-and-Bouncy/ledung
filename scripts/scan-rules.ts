// The rules of the public scan (#340), shared by the export dry run (scripts/export-public.ts) and the
// issue scan (scripts/scan-issues.ts), so what counts as a hit, and what explains one, cannot drift
// apart between the code and the issues that are copied to the public repository.
//
// Words that must not appear (people, other projects) are not written here, since this file is
// exported too: they come from a local JSON file
// { "terms": ["regex", ...], "allow": [{ "file": "path or prefix/", "match": "regex", "why": "...", "kind": "optional" }] }.
import fs from 'node:fs';

/** A binary file, which no scan can read (#411). */
export const BINARY = 'unscanned binary';

export interface Allow { file: string; match: string; why: string; kind?: string }
export interface Terms { terms: string[]; allow: Allow[] }
/** `column` is where the match starts in its line, from 0; a hit on a whole file (`line` 0) has none. */
export interface Hit { file: string; line: number; kind: string; text: string; allowed?: string; column?: number }

const SECRETS: [string, RegExp][] = [
  ['github token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['api key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['e-mail', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['home folder', /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>|*?]+/gi],
  // Not after a host name: github.com/users/<login> is a web address.
  ['home folder', /(?<![\w.%-])\/(Users|home)\/[^/\s"'`]+/g],
  ['ip address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
];

/** Addresses and names that are placeholders by definition, whoever's repository it is. */
const ALWAYS_FINE: [string, RegExp][] = [
  ['e-mail', /@(example\.(com|org|net)|[a-z0-9.-]+\.(test|invalid|example|localhost))$|^(noreply|no-reply)@|@users\.noreply\.github\.com$/i],
  ['home folder', /[\\/](Users|home)[\\/]+(\$\{|%|<|\{|(you|user|username|me|name|runner)\b)|[\\/]Users[\\/]+(Shared|Public|Default)$/i],
];

function privateOrReserved(ip: string): boolean {
  const n = ip.split('.').map(Number);
  if (n.some((x) => x > 255)) return true; // not an address: a version or a number
  const [a, b] = n as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    // documentation ranges (RFC 5737)
    || ip.startsWith('192.0.2.') || ip.startsWith('198.51.100.') || ip.startsWith('203.0.113.');
}

/** The `why` of the placeholder rule or allow entry that explains a hit, if any. */
export function allowedBy(hit: Hit, allow: Allow[]): string | undefined {
  for (const [kind, re] of ALWAYS_FINE) if (hit.kind === kind && re.test(hit.text)) return 'placeholder';
  for (const a of allow) {
    const fileOk = a.file.endsWith('/') ? hit.file.startsWith(a.file) : hit.file === a.file;
    const kindOk = hit.kind === BINARY ? a.kind === 'binary' : a.kind === undefined || a.kind === hit.kind;
    if (fileOk && kindOk && new RegExp(a.match, 'i').test(hit.text)) return a.why;
  }
  return undefined;
}

/** Every hit in one text; `file` says where it is, and is what the allow entries' `file` is matched against. */
export function scanText(file: string, text: string, terms: Terms): Hit[] {
  const patterns: [string, RegExp][] = [...SECRETS, ...terms.terms.map((t): [string, RegExp] => ['term', new RegExp(t, 'gi')])];
  const hits: Hit[] = [];
  text.split('\n').forEach((line, i) => {
    for (const [kind, re] of patterns) {
      for (const m of line.matchAll(re)) {
        if (kind === 'ip address' && privateOrReserved(m[0])) continue;
        const hit: Hit = { file, line: i + 1, kind, text: m[0], column: m.index };
        const why = allowedBy(hit, terms.allow);
        if (why) hit.allowed = why;
        hits.push(hit);
      }
    }
  });
  return hits;
}

/** The terms file; with none, only the built-in patterns are scanned. */
export function loadTerms(file: string | undefined): Terms {
  return file ? { terms: [], allow: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) } : { terms: [], allow: [] };
}
