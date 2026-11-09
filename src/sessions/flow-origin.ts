// A workflow's version and where a copy came from (docs/steps/workflow-origin.md, approved by Simon 2026-11-09,
// question #1732): the hash Ledung computes over a workflow's files, so it can tell any change, and the shared
// folder's git remote, read from its git config (no network, no git process), so a copy can name its original
// without a path on one computer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FLOW_FILE, FLOW_IN_FOLDER, type FlowOrigin, type FlowView } from '../shared/flow.ts';
import { chainAfter, cleanRemote, repoKey } from '../shared/flow-origin.ts';
import { readFlowView, type FlowPlace } from './flow-files.ts';

/** JSON with its keys sorted at every level, as the "differs" check (ledung#110) reads a flow: order means nothing. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

/** A text as hashed and compared: no BOM, LF line ends, no space at the ends. */
const plainText = (t: string) => t.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();

/**
 * A flow file as hashed: its JSON with sorted keys, the default flow without its `origin` (recording an origin doesn't
 * change what a workflow is), or its text as written when it isn't JSON.
 */
function flowContent(file: string, text: string): string {
  try {
    const raw = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    if (file === FLOW_FILE && raw && typeof raw === 'object' && !Array.isArray(raw)) delete (raw as Record<string, unknown>).origin;
    return sortedJson(raw);
  } catch {
    return plainText(text);
  }
}

/**
 * A workflow's hash (section 1): every file it is made of as a view reads them (every flow, the rules, the manager's
 * file, the briefs and overlays, "folder:" briefs), normalised as the "differs" check reads them, by path. An empty
 * text counts as none. "sha256:" and 12 hex digits.
 */
export function workflowHash(view: Pick<FlowView, 'raw' | 'flows' | 'rules' | 'texts'>): string | null {
  if (view.raw === null) return null;
  const files: [string, string][] = [[FLOW_FILE, flowContent(FLOW_FILE, view.raw)]];
  for (const f of view.flows) if (f.raw !== null && FLOW_IN_FOLDER.test(f.file)) files.push([f.file, flowContent(f.file, f.raw)]);
  const texts = { ...view.texts, ...(view.rules !== null ? { 'rules.md': view.rules } : {}) };
  for (const [f, t] of Object.entries(texts)) {
    const plain = plainText(t);
    if (plain) files.push([f, plain]);
  }
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(files), 'utf8').digest('hex').slice(0, 12)}`;
}

/** The git config of the repository a folder is in, by walking up to its .git (a folder, or a worktree's file). */
function gitConfigOf(folder: string): string | null {
  let dir = path.resolve(folder);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      // No .git here: one folder up.
    }
    if (st?.isDirectory()) return path.join(dotGit, 'config');
    if (st) {
      // A worktree or submodule: "gitdir: <path>", and a worktree's "commondir" leads to the shared config. One that
      // can't be read is this repository's all the same: never a parent's (review of part a).
      let gitdir: string | undefined;
      try {
        gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      } catch {
        return null;
      }
      if (!gitdir) return null;
      const real = path.resolve(dir, gitdir);
      try {
        const common = fs.readFileSync(path.join(real, 'commondir'), 'utf8').trim();
        return path.join(path.resolve(real, common), 'config');
      } catch {
        return path.join(real, 'config');
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** A git config value: quotes taken off, and a comment after it ("#" or ";" outside quotes) left out, as git reads it. */
function configValue(raw: string): string {
  let out = '';
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && (ch === '#' || ch === ';')) break;
    out += ch;
  }
  return out.trim();
}

/**
 * The remote of the git repository a shared workflow's folder is in, fit to write into a copy (section 6): "origin"'s
 * if it is fit, else the first other remote that is, cleaned by cleanRemote. None: no repository, or no remote fit to
 * write (a folder, say). Section and key names are read regardless of case, as git does.
 */
export function remoteOf(folder: string): string | undefined {
  const file = gitConfigOf(folder);
  if (!file) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const remotes = new Map<string, string>();
  let section: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/i.exec(line);
    if (head) { section = head[1]!; continue; }
    if (/^\s*\[/.test(line)) { section = null; continue; }
    const url = section !== null ? /^\s*url\s*=(.*)$/i.exec(line) : null;
    if (url && !remotes.has(section!)) remotes.set(section!, configValue(url[1]!));
  }
  const order = [...(remotes.has('origin') ? ['origin'] : []), ...[...remotes.keys()].filter((k) => k !== 'origin')];
  for (const name of order) {
    const clean = cleanRemote(remotes.get(name)!);
    if (clean) return clean;
  }
  return undefined;
}

/** Today on this computer, YYYY-MM-DD: the day a copy is made or its origin recorded. */
export function today(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** A shared workflow configured on this computer, with its folder and how to read its flow. */
export interface KnownWorkflow {
  name: string;
  folder: string;
  place: FlowPlace;
}

/**
 * The origin a copy of `original` (a shared workflow's view) records (section 2): its name, title, remote, release,
 * hash and author, and the chain its own origin carries; `copiedAt` today. With `adopted`, recorded later for an older
 * copy instead (section 4), and without release and hash when `version` is false: the version copied isn't known.
 * Kept within what the checks take, so Ledung never writes an origin it would refuse to read (review of part a).
 */
export function originOf(original: FlowView, workflow: string, repo: string | undefined, day: string, how: { adopted?: boolean; version?: boolean } = {}): FlowOrigin | undefined {
  const flow = original.flow;
  const name = workflow.trim().slice(0, 48);
  if (!flow || !name) return undefined;
  const hash = workflowHash(original);
  const version = how.version !== false;
  const earlier = chainAfter(flow.origin);
  return {
    workflow: name,
    title: (flow.title?.trim() || name).slice(0, 120),
    ...(repo ? { repo } : {}),
    ...(version && flow.release !== undefined ? { release: flow.release } : {}),
    ...(version && hash ? { hash } : {}),
    ...(flow.author !== undefined ? { author: flow.author } : {}),
    ...(how.adopted ? { adopted: day } : { copiedAt: day }),
    ...(earlier ? { earlier } : {}),
  };
}

/**
 * The workflow on this computer an origin names (section 3), never the one shown itself (a shared workflow that is a
 * copy and kept its name). By its remote, and among several with that remote (workflows in one repository) the one of
 * its name; with no remote match, by its name only when the origin has no remote or that workflow has none, so a
 * workflow of the same name from another repository is never taken for it (review of parts a, b and c).
 */
export function originalOf(origin: FlowOrigin, view: Pick<FlowView, 'source'>, workflows: KnownWorkflow[], remote: (w: KnownWorkflow) => string | undefined): KnownWorkflow | undefined {
  const others = workflows.filter((w) => !(view.source?.kind === 'workflow' && view.source.workflow === w.name) && w.place.folder !== view.source?.folder);
  const byName = others.find((w) => w.name === origin.workflow);
  if (!origin.repo) return byName;
  const key = repoKey(origin.repo);
  const same = others.filter((w) => { const r = remote(w); return r !== undefined && repoKey(r) === key; });
  if (same.length) return same.find((w) => w.name === origin.workflow) ?? (same.length === 1 ? same[0] : undefined);
  return byName && remote(byName) === undefined ? byName : undefined;
}

/**
 * What the workflow page shows and offers about a flow's origin (sections 3 and 4): the origin a split-off now would
 * record, whether the original of a copy has changed since, and the origin "Record where this came from" would write
 * for an older copy (with the original's own author and release, which it moves out of the copy), unless dismissed.
 * Each part is worked out apart: one that fails is left out and said in the log, and never takes the others with it.
 */
export async function originInfo(view: FlowView, places: FlowPlace[], workflows: KnownWorkflow[], how: { dismissed: boolean; now?: Date }): Promise<Pick<FlowView, 'splitOff' | 'original' | 'adopt' | 'adoptFrom'>> {
  const day = today(how.now);
  // Each folder's remote read once per view.
  const remotes = new Map<string, string | undefined>();
  const remote = (w: KnownWorkflow) => {
    if (!remotes.has(w.folder)) remotes.set(w.folder, remoteOf(w.folder));
    return remotes.get(w.folder);
  };
  const known = (name: string | undefined) => workflows.find((w) => w.name === name);
  const part = async (what: string, work: () => Promise<void> | void) => {
    try {
      await work();
    } catch (e) {
      console.warn(`Workflow: ${what} of ${view.project}'s flow could not be worked out: ${(e as Error).message}`);
    }
  };
  const out: Pick<FlowView, 'splitOff' | 'original' | 'adopt' | 'adoptFrom'> = {};
  await part('the origin a copy would record', () => {
    if (view.source?.kind !== 'workflow' || !view.saveTo || !view.flow || !view.source.workflow) return;
    const w = known(view.source.workflow);
    const origin = originOf(view, view.source.workflow, w ? remote(w) : undefined, day);
    if (origin) out.splitOff = origin;
  });
  await part('whether the original changed', async () => {
    const origin = view.flow?.origin;
    if (!origin?.hash) return;
    const w = originalOf(origin, view, workflows, remote);
    if (!w) return;
    const theirs = await readFlowView(view.project, [w.place]);
    const hash = workflowHash(theirs);
    if (!theirs.flow || !hash) return;
    out.original = {
      workflow: w.name, title: theirs.flow.title?.trim() || w.name,
      ...(theirs.flow.release !== undefined ? { release: theirs.flow.release } : {}),
      changed: hash !== origin.hash,
    };
  });
  await part('"Record where this came from"', async () => {
    if (how.dismissed || view.source?.kind !== 'project' || !view.saveTo || !view.flow || view.flow.origin || !view.shared) return;
    const shared = view.shared;
    const place = places.find((p) => p.kind === 'workflow' && p.workflow === shared.workflow);
    if (!place) return;
    const theirs = await readFlowView(view.project, [place]);
    const w = known(shared.workflow);
    const adopt = originOf(theirs, shared.workflow, w ? remote(w) : undefined, day, { adopted: true, version: !shared.differs });
    if (!adopt || !theirs.flow) return;
    out.adopt = adopt;
    // The original's own credit, which the copy may still carry even when the version copied isn't known (review of part d).
    out.adoptFrom = { ...(theirs.flow.author !== undefined ? { author: theirs.flow.author } : {}), ...(theirs.flow.release !== undefined ? { release: theirs.flow.release } : {}) };
  });
  return out;
}
