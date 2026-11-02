// Reading a project's flow (issue #310, part 1): flow.json, rules.md and the briefs and overlay texts it links, from
// .ledung/workflow in the project's folder, or from the shared workflow folder the project follows (decision 3;
// the "workflows" config, issues #21, #132). Read-only, with the file viewer's rules (src/sessions/files.ts): only
// inside the folder, links resolved first, so neither a path in flow.json nor a link in the folder leads out. A
// container project's files are read inside its container, with the same rules there.
//
// Writing them (issue #311, part 2, design decision 4): the builder saves straight into the project's own
// .ledung/workflow, never a shared workflow's folder; only the files the format knows, never through a link, each
// replacing exactly the version the page read.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, WorkflowConfig } from '../config.ts';
import { DEFAULT_FLOW, FLOW_FILE, FLOW_FOLDER, FLOW_IN_FOLDER, FLOW_TEXT_FOLDERS, FLOWS_FOLDER, linkedTexts, MANAGER_FILE, RULES_FILE, WRITABLE_FLOW_FILE, type Flow, type FlowEntry, type FlowFileWrite, type FlowProblem, type FlowView } from '../shared/flow.ts';
import { FileError, readProjectBytes } from './files.ts';
import { checkFlow, checkFlowCalls, machinePathIn, parseFlow, personGatedFlows } from '../shared/flow-check.ts';
import { projectWorkflow } from './workflow.ts';

/** flow.json, rules.md and every brief: big enough for long judgement, small enough for one answer to the page. */
export const FLOW_TEXT_MAX_BYTES = 256 * 1024;
/** All of a flow's texts together, so one answer to the page (and one container read) stays bounded (review of #310). */
export const FLOW_TEXTS_MAX_BYTES = 4 * 1024 * 1024;
/** The most files one save writes: a flow's briefs and overlays with room to spare (#311). */
export const FLOW_WRITE_MAX_FILES = 300;

/**
 * One file as read: its text, missing, or there but refused (outside the folder, too large, not text, the container
 * not reachable). Only a missing flow.json lets a later place count (review of #310, finding 2).
 */
export type FileRead = { text: string } | { missing: true } | { refused: string };

/** Reads files inside the flow folder by their path there, at most `budget` bytes in all. */
export type ReadFlowFiles = (files: string[], budget?: number) => Promise<Map<string, FileRead>>;

/**
 * Writes files by their path in the workflow folder: all checked first, then written in the order given; one with
 * `remove` is taken away instead (a flow in flows/ deleted or renamed, #447).
 */
export type WriteFlowFiles = (files: ({ path: string; text: string } | { path: string; remove: true })[]) => Promise<void>;

/** Where a flow may be: its folder as the project's sessions see it, and how Ledung reads it. */
export interface FlowPlace {
  kind: 'project' | 'workflow';
  /** The folder as the project's sessions see it (inside the container for a container project). */
  folder: string;
  /** The shared workflow's name, for a workflow's folder. */
  workflow?: string;
  read: ReadFlowFiles;
  /**
   * manager.md and the .md files in briefs/ and overlays/, by their path in the workflow folder, so the builder can pick
   * one (#311, #322); and the flows in flows/ (#447).
   */
  list: () => Promise<string[]>;
  /** Writes files into the folder (#311); only the project's own place has it. */
  write?: WriteFlowFiles;
}

/** The most .md files the builder lists of each folder it lists (FLOW_TEXT_FOLDERS). */
const LISTED_MAX = 200;
const LISTED_NAME = /^(?!\.)[A-Za-z0-9_. -]{1,80}\.md$/;
/** The most flows besides the default one a project's folder is read with (#447). */
export const FLOWS_MAX = 50;
/** The most of them the manager's instruction line names (#447, #32). */
const FLOWS_NAMED = 6;

/** A BOM is what PowerShell 5.1 writes by default; it is no part of the text (review of #310, finding 3). */
const withoutBom = (text: string) => text.replace(/^﻿/, '');

/** A text's version as the page sees it: short, and the same for the same text wherever it was read (#311). */
export const textVersion = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/** Reads files inside `root` with the file viewer's rules, each under `sub` ("" or a folder inside root). */
export function localReader(root: string, sub: string): ReadFlowFiles {
  return async (files, budget = FLOW_TEXTS_MAX_BYTES) => {
    let left = budget;
    return new Map(files.map((f): [string, FileRead] => {
      try {
        const { bytes } = readProjectBytes(root, sub ? `${sub}/${f}` : f, FLOW_TEXT_MAX_BYTES);
        if (bytes.subarray(0, 8192).includes(0)) return [f, { refused: `${f} is not a text file.` }];
        if (bytes.length > left) return [f, { refused: `${f} is past the ${FLOW_TEXTS_MAX_BYTES / 1048576} MB the workflow's texts may have together.` }];
        left -= bytes.length;
        return [f, { text: withoutBom(bytes.toString('utf8')) }];
      } catch (e) {
        if (!(e instanceof FileError)) throw e;
        return [f, /^There is no file /.test(e.message) ? { missing: true } : { refused: e.message }];
      }
    }));
  };
}

/**
 * manager.md, the .md files in briefs/ and overlays/ and the flows in flows/ (#447) under `root`/`sub` (#322), where
 * those folders are inside `root` (links resolved).
 */
export function localLister(root: string, sub: string): () => Promise<string[]> {
  return async () => {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      return [];
    }
    const own = (() => {
      try {
        const real = fs.realpathSync.native(path.join(realRoot, ...sub.split('/'), MANAGER_FILE));
        const inside = path.relative(realRoot, real);
        return inside && !inside.startsWith('..') && !path.isAbsolute(inside) && fs.statSync(real).isFile() ? [MANAGER_FILE] : [];
      } catch {
        return [];
      }
    })();
    const listed = (folder: string, name: (n: string) => boolean, max: number) => {
      try {
        const real = fs.realpathSync.native(path.join(realRoot, ...sub.split('/'), folder));
        const inside = path.relative(realRoot, real);
        if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return [];
        return fs.readdirSync(real, { withFileTypes: true }).filter((e) => name(e.name) && !e.isDirectory()).map((e) => `${folder}/${e.name}`).sort().slice(0, max);
      } catch {
        return [];
      }
    };
    return [
      ...own,
      ...FLOW_TEXT_FOLDERS.flatMap((folder) => listed(folder, (n) => LISTED_NAME.test(n), LISTED_MAX)),
      ...listed(FLOWS_FOLDER, (n) => FLOW_IN_FOLDER.test(`${FLOWS_FOLDER}/${n}`), FLOWS_MAX),
    ];
  };
}

/**
 * Writes files into `root`/.ledung/workflow (#311): no folder on the way and not the file itself may be a link, so
 * nothing written leaves the project's own workflow folder whatever the links say; each file is written beside itself
 * and renamed over the old one, so a reader never sees half a file. All are checked before any is written.
 */
export function localWriter(root: string): WriteFlowFiles {
  const walk = (realRoot: string, file: string, create: boolean): string => {
    const parts = [...FLOW_FOLDER.split('/'), ...file.split('/')];
    let at = realRoot;
    for (const [i, part] of parts.entries()) {
      at = path.join(at, part);
      const shown = parts.slice(0, i + 1).join('/');
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(at);
      } catch {
        // Not there yet: made when writing.
      }
      const last = i === parts.length - 1;
      // A junction counts as a link here too (Node reports it as one).
      if (stat?.isSymbolicLink()) throw new FileError(`${shown} is a link; the builder writes only into the project's own ${FLOW_FOLDER} folder.`);
      if (stat && (last ? !stat.isFile() : !stat.isDirectory())) throw new FileError(`${shown} is not a ${last ? 'file' : 'folder'}.`);
      if (!stat && !last && create) {
        try {
          fs.mkdirSync(at);
        } catch (e) {
          throw new FileError(`${shown} could not be made: ${(e as Error).message}`);
        }
      }
    }
    return at;
  };
  return async (files) => {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      throw new FileError("The project's folder is not there.");
    }
    for (const f of files) walk(realRoot, f.path, false);
    for (const f of files) {
      // A flow deleted or renamed (#447): the file only, never through a link (walk refused one above).
      if ('remove' in f) {
        try {
          fs.rmSync(walk(realRoot, f.path, false), { force: true });
        } catch (e) {
          throw new FileError(`${f.path} could not be removed: ${(e as Error).message}`);
        }
        continue;
      }
      const target = walk(realRoot, f.path, true);
      const temp = `${target}.ledung-${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(temp, f.text, { flag: 'wx' });
        fs.renameSync(temp, target);
      } catch (e) {
        fs.rmSync(temp, { force: true });
        throw new FileError(`${f.path} could not be written: ${(e as Error).message}`);
      }
    }
  };
}

/** How a container project's files are read: DockerRunner.readInsideProject. */
export type ContainerRead = (files: string[], maxBytes: number, budget: number) => Promise<Map<string, FileRead>>;

/** How a container project's flow folder is read, listed and written: through its runner (DockerRunner, #311). */
export interface ContainerFiles {
  read: ContainerRead;
  list: () => Promise<string[]>;
  write: WriteFlowFiles;
}

/**
 * The places a project's flow may be, in the order they count: its own .ledung/workflow first, then the shared
 * workflow's folder it follows (question #1073).
 */
export function flowPlaces(project: ProjectConfig, workflow: WorkflowConfig | undefined, container?: ContainerFiles): FlowPlace[] {
  const places: FlowPlace[] = [];
  if (project.runner === 'local') {
    places.push({
      kind: 'project', folder: path.join(project.path, ...FLOW_FOLDER.split('/')),
      read: localReader(project.path, FLOW_FOLDER), list: localLister(project.path, FLOW_FOLDER), write: localWriter(project.path),
    });
  } else if (container) {
    places.push({
      kind: 'project',
      folder: path.posix.join(project.pathInContainer, FLOW_FOLDER),
      read: async (files, budget = FLOW_TEXTS_MAX_BYTES) => {
        const m = await container.read(files.map((f) => `${FLOW_FOLDER}/${f}`), FLOW_TEXT_MAX_BYTES, budget);
        return new Map(files.map((f) => [f, m.get(`${FLOW_FOLDER}/${f}`) ?? { missing: true }]));
      },
      list: container.list,
      write: container.write,
    });
  }
  // A shared workflow's folder is on this computer; a container project follows one only when it says so (#21).
  // The builder never writes there (#311): one project's change would change every project that follows it.
  if (workflow && projectWorkflow(workflow, project)) {
    places.push({
      kind: 'workflow', folder: path.join(workflow.folder, ...FLOW_FOLDER.split('/')), workflow: workflow.name,
      read: localReader(workflow.folder, FLOW_FOLDER), list: localLister(workflow.folder, FLOW_FOLDER),
    });
  }
  return places;
}

/**
 * The place whose flow counts: the first with a flow.json, or the first whose flow.json is there but refused (then
 * `refused` says why), so a project's own flow that can't be read never quietly gives way to a shared one.
 */
export async function findFlow(places: FlowPlace[]): Promise<{ place: FlowPlace; text: string } | { place: FlowPlace; refused: string } | null> {
  for (const place of places) {
    const read = (await place.read([FLOW_FILE])).get(FLOW_FILE) ?? { missing: true };
    if ('text' in read) return { place, text: read.text };
    if ('refused' in read) return { place, refused: read.refused };
  }
  return null;
}

/** The workflow page's view of a project's flow: the flow, its texts and every problem the checks find. */
export async function readFlowView(project: string, places: FlowPlace[], profiles?: readonly string[]): Promise<FlowView> {
  const expected = `${FLOW_FOLDER}/${FLOW_FILE}`;
  const saveTo = places.find((p) => p.kind === 'project' && p.write)?.folder ?? null;
  const found = await findFlow(places);
  if (!found) return { project, source: null, expected, flow: null, rules: null, texts: {}, problems: [], raw: null, versions: {}, saveTo, flows: [] };
  const { place } = found;
  const source = { kind: place.kind, folder: place.folder, ...(place.workflow ? { workflow: place.workflow } : {}) };
  if ('refused' in found) return { project, source, expected, flow: null, rules: null, texts: {}, problems: [{ at: FLOW_FILE, message: `can't be read: ${found.refused}` }], raw: null, versions: {}, saveTo, flows: [] };
  const parsed = parseFlow(found.text);
  const versions: Record<string, string> = { [FLOW_FILE]: textVersion(found.text) };
  const all: string[] = await place.list().catch(() => []);
  // The other flows (#447), each in flows/<name>.json: read before the texts, as flow.json is, so their briefs are known.
  let budget = FLOW_TEXTS_MAX_BYTES - Buffer.byteLength(found.text);
  // "main" is the default flow's name, flow.json's (#447): flows/main.json would be a second flow of that name.
  const reserved = `${FLOWS_FOLDER}/${DEFAULT_FLOW}.json`;
  const flowFiles = all.filter((f) => FLOW_IN_FOLDER.test(f) && f !== reserved).slice(0, FLOWS_MAX);
  const flowReads = flowFiles.length ? await place.read(flowFiles, budget) : new Map<string, FileRead>();
  const flows: FlowEntry[] = flowFiles.map((file) => {
    const name = FLOW_IN_FOLDER.exec(file)![1]!;
    const r = flowReads.get(file) ?? { missing: true };
    if (!('text' in r)) return { name, file, flow: null, raw: null, problems: [{ at: file, message: `can't be read: ${'refused' in r ? r.refused : 'it is gone'}` }] };
    budget -= Buffer.byteLength(r.text);
    versions[file] = textVersion(r.text);
    const p = parseFlow(r.text, file);
    // One manager, one file: the default flow names it (#447).
    const own: FlowProblem[] = p.flow?.manager === undefined ? [] : [{ at: 'manager', message: `The manager's file is named by the default flow (${FLOW_FILE}) for all flows: take "manager" out of ${file}.` }];
    return { name, file, flow: p.flow, raw: r.text, problems: [...own, ...p.problems] };
  });
  // The texts every flow links: they share the folder's briefs and overlay texts (#447).
  const linked = [...new Set([parsed.flow, ...flows.map((f) => f.flow)].flatMap((f) => (f ? linkedTexts(f) : [])))];
  // manager.md and the other .md files in briefs/ and overlays/ too, so the builder can pick one (#311); after the linked ones, so
  // those come first within the budget, and refusing one of the others is no problem of the flow's.
  const listed = all.filter((f) => !FLOW_IN_FOLDER.test(f) && !linked.includes(f));
  const read = await place.read([RULES_FILE, ...linked, ...listed], budget);
  const texts: Record<string, string> = {};
  const refused: FlowProblem[] = [];
  for (const f of [...linked, ...listed]) {
    const r = read.get(f);
    if (r && 'text' in r) texts[f] = r.text;
    else if (r && 'refused' in r && linked.includes(f)) refused.push({ at: f, message: `can't be read: ${r.refused}` });
  }
  const rules = read.get(RULES_FILE);
  if (rules && 'refused' in rules) refused.push({ at: RULES_FILE, message: `can't be read: ${rules.refused}` });
  // A refused brief is said once, as refused, not again as missing.
  const exists = (f: string) => texts[f] !== undefined || refused.some((p) => p.at === f);
  // Between the flows (#447): what a Run flow block runs, how it can end, and whether a person decides in it.
  const byName = new Map<string, Flow | null>([[DEFAULT_FLOW, parsed.flow], ...flows.map((f): [string, Flow | null] => [f.name, f.flow])]);
  const gated = personGatedFlows(byName);
  const checked = parsed.flow ? checkFlow(parsed.flow, exists, profiles, gated) : [];
  const calls = checkFlowCalls(byName);
  for (const f of flows) if (f.flow) f.problems.push(...checkFlow(f.flow, exists, profiles, gated), ...calls.get(f.name)!);
  if (all.includes(reserved)) refused.push({ at: reserved, message: `"${DEFAULT_FLOW}" is the default flow's name, which is ${FLOW_FILE}'s: give this flow another name; it is left out.` });
  const ruleText = rules && 'text' in rules ? rules.text : null;
  if (ruleText !== null) versions[RULES_FILE] = textVersion(ruleText);
  for (const [f, text] of Object.entries(texts)) versions[f] = textVersion(text);
  // The texts too: nothing in the folder may be tied to one computer (part 6).
  const paths = [...(ruleText === null ? [] : [machinePathIn(RULES_FILE, ruleText)]), ...linked.map((f) => (texts[f] === undefined ? null : machinePathIn(f, texts[f])))];
  return {
    project, source, expected, flow: parsed.flow, rules: ruleText, texts,
    problems: [...parsed.problems, ...refused, ...checked, ...(calls.get(DEFAULT_FLOW) ?? []), ...paths.filter((p): p is FlowProblem => p !== null)],
    raw: found.text, versions, saveTo, flows,
  };
}

/**
 * What a save may write, from the page's request (#311): only files the format knows (flow.json, rules.md,
 * manager.md, briefs/*.md, overlays/*.md), each once, text within the limits, and a flow.json that is a flow (its checks' problems
 * may stand: a draft may be saved). Throws FileError with the reason.
 */
export function flowWrites(given: unknown): FlowFileWrite[] {
  if (!Array.isArray(given) || given.length === 0) throw new FileError('There is nothing to save.');
  if (given.length > FLOW_WRITE_MAX_FILES) throw new FileError(`One save writes at most ${FLOW_WRITE_MAX_FILES} files.`);
  const seen = new Set<string>();
  let total = 0;
  const files = given.map((f): FlowFileWrite => {
    const { path: p, text, base, remove } = (f ?? {}) as Record<string, unknown>;
    if (typeof p !== 'string' || !WRITABLE_FLOW_FILE.test(p) || p === `${FLOWS_FOLDER}/${DEFAULT_FLOW}.json`) {
      throw new FileError(`${typeof p === 'string' ? p.slice(0, 100) : 'A file'} is not a file the workflow's format has: only ${FLOW_FILE}, ${RULES_FILE}, ${MANAGER_FILE}, <name>.md in ${FLOW_TEXT_FOLDERS.join('/, ')}/ and <name>.json in ${FLOWS_FOLDER}/ (not "${DEFAULT_FLOW}", the default flow's name) are written.`);
    }
    if (seen.has(p.toLowerCase())) throw new FileError(`${p} is given twice.`);
    seen.add(p.toLowerCase());
    // A flow deleted or renamed (#447): the only file a save takes away, and only the version the page read.
    if (remove !== undefined) {
      if (remove !== true || !FLOW_IN_FOLDER.test(p)) throw new FileError(`${p} can't be removed: a save removes only a flow in ${FLOWS_FOLDER}/.`);
      if (typeof base !== 'string' || !/^[0-9a-f]{16}$/.test(base)) throw new FileError(`${p} doesn't say which version it removes.`);
      return { path: p, remove: true, base };
    }
    if (typeof text !== 'string' || text.includes('\0')) throw new FileError(`${p} has no text, or not plain text.`);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > FLOW_TEXT_MAX_BYTES) throw new FileError(`${p} is larger than the ${FLOW_TEXT_MAX_BYTES / 1024} KB a workflow's text may have.`);
    total += bytes;
    if (base !== null && (typeof base !== 'string' || !/^[0-9a-f]{16}$/.test(base))) throw new FileError(`${p} doesn't say which version it replaces.`);
    return { path: p, text, base };
  });
  if (total > FLOW_TEXTS_MAX_BYTES) throw new FileError(`Together the files are larger than the ${FLOW_TEXTS_MAX_BYTES / 1048576} MB a workflow's texts may have.`);
  for (const f of files) {
    if (f.remove || (f.path !== FLOW_FILE && !FLOW_IN_FOLDER.test(f.path))) continue;
    const parsed = parseFlow(f.text, f.path);
    if (!parsed.flow) throw new FileError(`${f.path} would not be a flow: ${parsed.problems.slice(0, 3).map((p) => `${p.at} ${p.message}`).join('; ')}`);
  }
  return files;
}

/**
 * Saves the builder's files into the project's own place (#311): each must still be the version the page read (none,
 * for a new file), so a change made meanwhile, by hand or in another window, is never written over. The texts go
 * first, then the other flows, then flow.json, so a flow on disk never links a brief or runs a flow that isn't written
 * yet; a flow deleted or renamed is removed last (#447), once nothing written still runs it under its old name.
 */
export async function saveFlowFiles(place: FlowPlace, given: unknown): Promise<void> {
  if (place.kind !== 'project' || !place.write) throw new FileError("The builder writes only into the project's own workflow folder.");
  const files = flowWrites(given);
  const now = await place.read(files.map((f) => f.path));
  for (const f of files) {
    const r = now.get(f.path) ?? { missing: true };
    if ('refused' in r) throw new FileError(`${f.path} can't be saved: ${r.refused}`);
    const version = 'text' in r ? textVersion(r.text) : null;
    if (version !== f.base) {
      throw new FileError(f.base === null
        ? `${f.path} is already in the workflow folder: it was made since the page read the workflow. Reload the workflow and pick it instead.`
        : `${f.path} has changed since the page read the workflow${version === null ? ' (it was removed)' : ''}. Reload the workflow to see the change; your edits here are not saved.`);
    }
  }
  const order = (f: FlowFileWrite) => (f.remove ? 4 : f.path === FLOW_FILE ? 3 : FLOW_IN_FOLDER.test(f.path) ? 2 : f.path === RULES_FILE ? 1 : 0);
  await place.write([...files].sort((a, b) => order(a) - order(b)).map((f) => (f.remove ? { path: f.path, remove: true as const } : { path: f.path, text: f.text })));
}

/**
 * What a manager is told about its project's flow (issue #310, part 1), after the workflow's own lines; short, since
 * the instructions are near Claude Code's limit (#32). The manager routes the work by reading results against the
 * outcomes; Ledung counts them (part 3, #1184). The manager's file, its standing procedures between steps, when
 * the flow has one, in a few words more (#322); the project's other flows by name, when it has some (#447). Null: the
 * project has no flow Ledung can read.
 */
export async function flowInstructions(places: FlowPlace[]): Promise<string | null> {
  const found = await findFlow(places).catch(() => null);
  if (!found || !('text' in found)) return null;
  const sep = found.place.folder.includes('\\') ? '\\' : '/';
  const flow = parseFlow(found.text).flow;
  // Named only when it is there to read: the page says when it is missing (review of #322).
  const own = flow?.manager && 'text' in ((await found.place.read([flow.manager]).catch(() => null))?.get(flow.manager) ?? { missing: true }) ? flow.manager : undefined;
  // A long path is not repeated: the line stays short (#32, review of #318).
  const named = own && (own.length <= 60 ? own : 'the file its "manager" names');
  // By name only, at most six (#32): the manager reads each file for the rest.
  const others = (await found.place.list().catch(() => [])).flatMap((f) => {
    const name = FLOW_IN_FOLDER.exec(f)?.[1];
    return name && name !== DEFAULT_FLOW ? [name] : [];
  });
  const more = others.length > FLOWS_NAMED ? `, and ${others.length - FLOWS_NAMED} more` : '';
  const flows = others.length
    ? ` Other flows, in ${FLOWS_FOLDER}${sep}<name>.json: ${others.slice(0, FLOWS_NAMED).join(', ')}${more}. Each piece of work runs in one flow, ${FLOW_FILE}'s unless you or the person pick another; a "Run flow" block starts its flow as a piece of work of its own, and the word that flow ends with is the block's outcome.`
    : '';
  return `The process is drawn in ${found.place.folder}${sep}${FLOW_FILE} (blocks, who acts, where a person decides; Ledung's workflow page shows it), with the briefs it links and any standing rules (${RULES_FILE}) beside it: read them and follow the flow: judge each result against its block's outcomes, which say where the work goes next.${named ? ` Your standing procedures between steps: ${named} there.` : ''}${flows}`;
}
