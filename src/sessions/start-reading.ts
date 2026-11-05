// The workflow's start-reading list (Project-Ledung#469; Martin, 2026-11-05 22:06: "That hook should be in the
// toolbox that ledung provides but the information to use it should be from the workflow"). Ledung's own
// SessionStart hook prints, after every startup, clear, compact and resume, what the session reads first; the
// workflow's startReadingFile says what that is, so the code knows the format and no process (repository stays
// generic). A cleared manager had read only its lead file, not the module file its config switched on.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SessionRole } from '../shared/protocol.ts';
import { withoutComments } from './profiles.ts';

const WorkflowPath = z.string().trim().min(1);
// A project file the list may print stays inside the project folder: nothing absolute, nothing climbing out.
const ProjectPath = z.string().trim().min(1).refine(
  (p) => !path.isAbsolute(p) && !path.posix.isAbsolute(p) && !p.split(/[\\/]+/).includes('..') && !/^[A-Za-z]:/.test(p),
  'path must stay inside the project folder (relative, no "..")',
);

// Entries are strict, as the nudges file's are: a misspelt key would otherwise be a file that is silently never named.
const Condition = z.preprocess(withoutComments, z.object({ key: z.string().trim().min(1), is: z.string().trim().min(1), read: WorkflowPath }).strict());
const ByTitle = z.preprocess(withoutComments, z.object({
  titlePrefix: z.string().min(1),
  read: WorkflowPath,
  when: z.array(Condition).default([]),
}).strict());
const ProjectFile = z.preprocess(withoutComments, z.object({ path: ProjectPath, print: z.boolean().default(false) }).strict());

const RoleFields = {
  read: z.array(WorkflowPath).default([]),
  modules: z.array(Condition).default([]),
  projectFiles: z.array(ProjectFile).default([]),
};
// byTitlePrefix is for sessions only: a manager's title is not a role.
const ManagerList = z.preprocess(withoutComments, z.object(RoleFields).strict());
const SessionList = z.preprocess(withoutComments, z.object({ ...RoleFields, byTitlePrefix: z.array(ByTitle).default([]) }).strict());

const StartReadingFile = z.preprocess(withoutComments, z.object({
  version: z.literal(1, { message: 'version must be 1' }),
  manager: ManagerList.optional(),
  session: SessionList.optional(),
}));

export type StartReadingList = z.infer<typeof StartReadingFile>;

/** Where a session's start-reading list comes from and where its files are, as the project's workflow gives them. */
export interface StartReading {
  /** The workflow's list, a full path on this computer. */
  file: string;
  /** The process folder on this computer: the list's "read" paths are inside it. */
  folder: string;
  /** The project folder as the session sees it: "projectFiles" are inside it. */
  projectFolder: string;
  /** The project's process config as the session sees it, whose Key | Value rows switch modules on. */
  projectConfig: string;
  /** Whether the session runs on this computer, so the project's files are joined with this computer's paths. */
  local: boolean;
}

/** A list file as read: the list, or what is wrong with it. */
export type StartReadingRead = { list: StartReadingList; problem: null } | { problem: string };

/** Checks a list's text; `file` is only for the messages. */
export function parseStartReading(file: string, text: string | null): StartReadingRead {
  if (text === null) return { problem: `The workflow's start-reading list ${file} was not found.` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { problem: `The workflow's start-reading list ${file} is not valid JSON: ${(e as Error).message}` };
  }
  const result = StartReadingFile.safeParse(raw);
  if (!result.success) {
    return { problem: `The workflow's start-reading list ${file} has problems: ${result.error.issues.map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`).join('; ')}` };
  }
  return { list: result.data, problem: null };
}

const cell = (c: string) => c.replace(/\*\*/g, '').replace(/`/g, '').trim();

/**
 * The Key | Value rows of a process config's tables, the key and the value cell each with ** and backticks
 * stripped. A key's first row counts; an escaped \| stays inside its cell.
 */
export function configValues(text: string | null): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.trim().split(/(?<!\\)\|/).slice(1);
    if (cells.length < 2) continue;
    const key = cell(cells[0]!);
    if (!key || /^:?-+:?$/.test(key) || values.has(key)) continue;
    values.set(key, cell(cells[1]!));
  }
  return values;
}

/** Whether a module applies: the value cell's first word (letters, digits, _ and -) is `is`, ignoring case; a missing key is off. */
export function moduleOn(values: ReadonlyMap<string, string>, key: string, is: string): boolean {
  const word = /^[A-Za-z0-9_-]+/.exec(values.get(key) ?? '')?.[0];
  return word !== undefined && word.toLowerCase() === is.toLowerCase();
}

/** One thing to read: a file to name, or (print) a project file whose text goes in as it is. `project`: in the project folder. */
export interface StartItem { kind: 'read' | 'print'; file: string; project: boolean; why?: string }

/**
 * What a session reads first, in the list's order: read, the modules that are on, the title's brief with its own
 * "when", then the project's files. Paths are full; project files are joined as the session sees its folder.
 */
export function startItems(list: StartReadingList, s: { role: SessionRole; title: string }, sr: Omit<StartReading, 'file'>, values: ReadonlyMap<string, string>): StartItem[] {
  const own = s.role === 'manager' ? list.manager : list.session;
  if (!own) return [];
  const inFolder = (p: string) => path.join(sr.folder, p);
  const inProject = (p: string) => sr.local ? path.join(sr.projectFolder, p) : path.posix.join(sr.projectFolder, p.replace(/\\/g, '/'));
  const on = (c: { key: string; is: string; read: string }): StartItem[] =>
    moduleOn(values, c.key, c.is) ? [{ kind: 'read', file: inFolder(c.read), project: false, why: `${c.key} is ${c.is}` }] : [];
  const items: StartItem[] = own.read.map((p) => ({ kind: 'read', file: inFolder(p), project: false }));
  items.push(...own.modules.flatMap(on));
  if (s.role === 'session' && list.session) {
    const brief = list.session.byTitlePrefix.find((b) => s.title.startsWith(b.titlePrefix));
    if (brief) items.push({ kind: 'read', file: inFolder(brief.read), project: false, why: `your title starts with "${brief.titlePrefix}"` }, ...brief.when.flatMap(on));
  }
  items.push(...own.projectFiles.map((f): StartItem => ({ kind: f.print ? 'print' : 'read', file: inProject(f.path), project: true })));
  return items;
}

/** A printed project file is cut past this many characters: the list is for the start of a context, not a dump. */
export const PRINT_MAX_CHARS = 20_000;

/**
 * The text the SessionStart hook adds, from the items and the project files' texts (null: missing, skipped without
 * a word). Null when there is nothing to say.
 */
export function startReadingText(items: readonly StartItem[], texts: ReadonlyMap<string, string | null>): string | null {
  const lines: string[] = [];
  let n = 0;
  for (const item of items) {
    const text = item.project ? texts.get(item.file) ?? null : null;
    if (item.project && text === null) continue;
    if (item.kind === 'read') {
      lines.push(`${++n}. ${item.file}${item.why ? ` (${item.why})` : ''}`);
    } else {
      const body = (text ?? '').trimEnd();
      const cut = body.length > PRINT_MAX_CHARS ? `${body.slice(0, PRINT_MAX_CHARS)}\n[… cut at ${PRINT_MAX_CHARS} characters: read the rest of ${item.file}]` : body;
      lines.push(`${++n}. ${item.file}, as it stands now:`, cut, `(end of ${path.basename(item.file)})`);
    }
  }
  if (!lines.length) return null;
  return [`The workflow's start-reading list: read these in full before anything else, in this order.`, ...lines].join('\n');
}

/** What a session is told when its workflow's list can't be used: never a silent nothing (#298 decision 6, as for nudges). */
export function startReadingProblemLine(problem: string, role: SessionRole): string {
  // Only a manager reports it: every worker opening a question about it would be noise (as for the nudges file).
  return `${problem.replace(/\.?$/, '.')} No start-reading list is shown until it is fixed.${role === 'manager' ? ' Tell whoever you ask (ask_user) once.' : ''}`;
}

/** Reads a list file on this computer. */
export function readStartReadingFile(file: string): StartReadingRead {
  let text: string | null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  return parseStartReading(file, text);
}

/**
 * The SessionStart hook's text for a session, and the problem it has now been told of. A broken list is told the
 * first time it is seen and again when it changes, as workflow-nudges does; once the list is fine, a later problem
 * is told afresh. `readProject` reads a file as the session sees it (null when missing); it never throws here.
 */
export async function sessionStartText(
  sr: StartReading | undefined,
  s: { role: SessionRole; title: string } | undefined,
  told: string | null,
  readProject: (file: string) => Promise<string | null>,
  read: (file: string) => StartReadingRead = readStartReadingFile,
): Promise<{ text: string | null; told: string | null }> {
  if (!sr || !s) return { text: null, told };
  const r = read(sr.file);
  if (r.problem !== null) return { text: r.problem === told ? null : startReadingProblemLine(r.problem, s.role), told: r.problem };
  const safeRead = (f: string) => readProject(f).catch(() => null);
  const own = s.role === 'manager' ? r.list.manager : r.list.session;
  const needsConfig = !!own && (own.modules.length > 0 || (s.role === 'session' && !!r.list.session?.byTitlePrefix.some((b) => b.when.length > 0)));
  const values = configValues(needsConfig ? await safeRead(sr.projectConfig) : null);
  const items = startItems(r.list, s, sr, values);
  // Project files are looked at: a missing one is skipped without a word, a printed one goes in as it is.
  const texts = new Map<string, string | null>();
  for (const i of items) if (i.project) texts.set(i.file, await safeRead(i.file));
  return { text: startReadingText(items, texts), told: null };
}
