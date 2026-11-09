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
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return path.join(dotGit, 'config');
      // A worktree or submodule: "gitdir: <path>", and a worktree's "commondir" leads to the shared config.
      const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      if (!gitdir) return null;
      const real = path.resolve(dir, gitdir);
      try {
        const common = fs.readFileSync(path.join(real, 'commondir'), 'utf8').trim();
        return path.join(path.resolve(real, common), 'config');
      } catch {
        return path.join(real, 'config');
      }
    } catch {
      // No .git here: one folder up.
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The remote of the git repository a shared workflow's folder is in, fit to write into a copy (section 6): "origin"'s,
 * else the first remote's, cleaned by cleanRemote. None: no repository, no remote, or one that is a folder.
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
    const head = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (head) { section = head[1]!; continue; }
    if (/^\s*\[/.test(line)) { section = null; continue; }
    const url = section !== null ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
    if (url && !remotes.has(section!)) remotes.set(section!, url[1]!.replace(/^"(.*)"$/, '$1'));
  }
  const url = remotes.get('origin') ?? remotes.values().next().value;
  return url === undefined ? undefined : cleanRemote(url);
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
 */
export function originOf(original: FlowView, workflow: string, repo: string | undefined, day: string, how: { adopted?: boolean; version?: boolean } = {}): FlowOrigin | undefined {
  const flow = original.flow;
  if (!flow) return undefined;
  const hash = workflowHash(original);
  const version = how.version !== false;
  const earlier = chainAfter(flow.origin);
  return {
    workflow,
    title: flow.title?.trim() || workflow,
    ...(repo ? { repo } : {}),
    ...(version && flow.release !== undefined ? { release: flow.release } : {}),
    ...(version && hash ? { hash } : {}),
    ...(flow.author !== undefined ? { author: flow.author } : {}),
    ...(how.adopted ? { adopted: day } : { copiedAt: day }),
    ...(earlier ? { earlier } : {}),
  };
}

/**
 * What the workflow page shows and offers about a flow's origin (sections 3 and 4): the origin a split-off now would
 * record, whether the original of a copy has changed since (found by remote, else by name, among this computer's
 * workflows), and the origin "Record where this came from" would write for an older copy, unless it was dismissed.
 * Reading another workflow that fails just leaves its part out.
 */
export async function originInfo(view: FlowView, places: FlowPlace[], workflows: KnownWorkflow[], how: { dismissed: boolean; now?: Date }): Promise<Pick<FlowView, 'splitOff' | 'original' | 'adopt'>> {
  const day = today(how.now);
  const known = (name: string | undefined) => workflows.find((w) => w.name === name);
  const out: Pick<FlowView, 'splitOff' | 'original' | 'adopt'> = {};
  if (view.source?.kind === 'workflow' && view.saveTo && view.flow && view.source.workflow) {
    const w = known(view.source.workflow);
    const origin = originOf(view, view.source.workflow, w ? remoteOf(w.folder) : undefined, day);
    if (origin) out.splitOff = origin;
  }
  const origin = view.flow?.origin;
  if (origin?.hash) {
    const key = origin.repo ? repoKey(origin.repo) : null;
    const remote = (w: KnownWorkflow) => remoteOf(w.folder);
    const w = (key ? workflows.find((x) => { const r = remote(x); return r !== undefined && repoKey(r) === key; }) : undefined) ?? known(origin.workflow);
    // Not the very folder shown: a shared workflow that is itself a copy names another one.
    if (w && w.place.folder !== view.source?.folder) {
      const theirs = await readFlowView(view.project, [w.place]).catch(() => null);
      const hash = theirs ? workflowHash(theirs) : null;
      if (theirs?.flow && hash) out.original = { workflow: w.name, ...(theirs.flow.release !== undefined ? { release: theirs.flow.release } : {}), changed: hash !== origin.hash };
    }
  }
  if (!how.dismissed && view.source?.kind === 'project' && view.saveTo && view.flow && !view.flow.origin && view.shared) {
    const place = places.find((p) => p.kind === 'workflow' && p.workflow === view.shared!.workflow);
    const theirs = place ? await readFlowView(view.project, [place]).catch(() => null) : null;
    const w = known(view.shared.workflow);
    const adopt = theirs ? originOf(theirs, view.shared.workflow, w ? remoteOf(w.folder) : undefined, day, { adopted: true, version: !view.shared.differs }) : undefined;
    if (adopt) out.adopt = adopt;
  }
  return out;
}
