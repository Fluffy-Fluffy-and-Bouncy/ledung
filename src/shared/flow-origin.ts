// A workflow copy's origin and version (docs/steps/workflow-origin.md, approved by Simon 2026-11-09, question #1732):
// what a project's own copy of a shared workflow records about where it came from, and how the page says it ("based on
// Team process v3 by Ana"). Credit only, nothing enforced (Simon, 2026-11-06, question #1680), and it carries through
// further copies, so a copy of a copy still names the first author. Pure, shared by the server and the page.
import type { FlowOrigin, FlowOriginLink } from './flow.ts';

/** The most copies further back an origin keeps: the first one and the latest nine (workflow-origin.md, section 2). */
export const EARLIER_MAX = 10;
/** A workflow's hash as Ledung writes it: "sha256:" and the first 12 hex digits. */
export const ORIGIN_HASH = /^sha256:[0-9a-f]{12}$/;

/** One origin as a link of the next copy's chain: what it credits, without where it was found. */
export function linkOf(o: FlowOriginLink): FlowOriginLink {
  return {
    title: o.title,
    ...(o.release !== undefined ? { release: o.release } : {}),
    ...(o.hash !== undefined ? { hash: o.hash } : {}),
    ...(o.author !== undefined ? { author: o.author } : {}),
  };
}

/**
 * The chain a copy of a workflow carries when that workflow has an origin of its own: its earlier ones, then its own
 * origin. Past EARLIER_MAX, the first (the first author) and the latest ones are kept. None: the workflow is no copy.
 */
export function chainAfter(origin: FlowOrigin | undefined): FlowOriginLink[] | undefined {
  if (!origin) return undefined;
  const all = [...(origin.earlier ?? []), linkOf(origin)];
  return all.length <= EARLIER_MAX ? all : [all[0]!, ...all.slice(-(EARLIER_MAX - 1))];
}

/** Who the first workflow in the chain was by: the oldest link's author, else the origin's own. */
export function firstAuthor(o: FlowOrigin): string | undefined {
  return o.earlier?.length ? o.earlier[0]!.author : o.author;
}

/** An origin without its remote: "Leave the repository out" (section 6). */
export function withoutRepo(o: FlowOrigin): FlowOrigin {
  const { repo: _, ...rest } = o;
  return rest;
}

/** "Team process v3" or "Team process", as the page says it. */
export const originName = (o: FlowOriginLink): string => (o.release !== undefined ? `${o.title} v${o.release}` : o.title);

/**
 * A copy's own author and release, from what it was copied with: the original's move into the origin, so the copy
 * claims neither (section 2); one the copy set itself (it differs from the original's) stays.
 */
export function ownCredit(flow: { author?: string; release?: number }, origin: FlowOriginLink): { author?: string; release?: number } {
  return {
    ...(flow.author !== undefined && flow.author !== origin.author ? { author: flow.author } : {}),
    ...(flow.release !== undefined && flow.release !== origin.release ? { release: flow.release } : {}),
  };
}

/**
 * A git remote fit to write into a copy that may be committed to a public repository (section 6): an https, http, ssh
 * or git URL, or the "git@host:path" form, with any user, password, token, query or fragment taken out (the "git"
 * user of the short form is no secret, and kept). Anything else, a folder on a computer above all, gives none.
 */
export function cleanRemote(url: string): string | undefined {
  const u = url.trim();
  if (!u || /\s/.test(u)) return undefined;
  // git@host:org/repo.git; a one-letter "host" is a drive (C:/repos/x), and "host://" is a URL.
  const short = /^(?:([^@/:]+)@)?([A-Za-z0-9][A-Za-z0-9.-]+):(?!\/\/)([A-Za-z0-9._~/-]+)$/.exec(u);
  if (short) {
    const [, user, host, rest] = short;
    if (rest!.startsWith('/') || rest!.includes('..')) return undefined;
    const out = `${user === 'git' ? 'git@' : ''}${host}:${rest}`;
    return out.length <= 300 ? out : undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return undefined;
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) return undefined;
  const path = parsed.pathname.replace(/\/+$/, '');
  const out = `${parsed.protocol}//${parsed.host}${path}`;
  // Within what the origin's check takes (review of part a).
  return out.length <= 300 ? out : undefined;
}

/**
 * A remote as two are compared, so the https and ssh forms of one repository match: host and path, lower case, with
 * no protocol, user, port, ".git" or slash at the end.
 */
export function repoKey(url: string): string {
  const lower = url.trim().toLowerCase();
  const scheme = /^[a-z+]+:\/\//.test(lower);
  let u = lower.replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]*@/, '');
  // A URL's "host:port/path" (only a URL has a port: the short form's "host:2024/x" is a path), and the short form's "host:path".
  if (scheme) u = u.replace(/^([^/]+):\d+\//, '$1/');
  else u = u.replace(/^([^/:]+):/, '$1/');
  return u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
}
