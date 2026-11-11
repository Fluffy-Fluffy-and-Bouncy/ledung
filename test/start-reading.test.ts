// The workflow's start-reading list (Project-Ledung#469): the list's shape (its $about in the workflow), which
// modules a process config switches on, the order things are named in, a broken list told at every start, and Ledung's own
// SessionStart hook that prints it after every startup, clear, compact and resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseConfig, parseProject } from '../src/config.ts';
import { configValues, moduleOn, parseStartReading, readInsideProject, readStartReadingFile, sessionStartText, startItems, type StartReading, type StartReadingList } from '../src/sessions/start-reading.ts';
import { projectWorkflow, type ProjectWorkflow } from '../src/sessions/workflow.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';

// A list in the workflow's shape, with made-up module names.
const LIST = {
  $about: 'A comment, ignored.',
  version: 1,
  manager: {
    read: ['process/lead.md'],
    modules: [
      { key: 'MODULE_ALPHA', is: 'on', read: 'modules/alpha/LEAD.md' },
      { key: 'MODULE_BETA', is: 'on', read: 'modules/beta/LEAD.md' },
      { key: 'HUMANS', is: 'team', read: 'modules/team/LEAD.md' },
    ],
    projectFiles: [{ path: 'docs/CONFIG.md' }, { path: 'notes/missing.md' }, { path: 'notes/GOAL.md', print: true }],
  },
  session: {
    read: ['process/worker.md'],
    modules: [{ key: 'HUMANS', is: 'team', read: 'modules/team/SESSIONS.md' }],
    byTitlePrefix: [
      { titlePrefix: 'test-review-', read: 'briefs/test-review.md' },
      { titlePrefix: 'review-', read: 'briefs/review.md' },
      { $why: 'a brief with its own module', titlePrefix: 'run-', read: 'briefs/run.md', when: [{ key: 'MODULE_ALPHA', is: 'on', read: 'modules/alpha/run.md' }] },
    ],
    projectFiles: [{ path: 'docs/CONFIG.md' }],
  },
};

// The workflow's own examples ($about): "**on** (agent-workflow v120; …)" is on, "`team` — …" is team, "online" is not on.
const CONFIG = [
  '| Key | Value |',
  '|---|---|',
  '| `MODULE_ALPHA` | **on** (agent-workflow v120; switched on 2026-10-01) |',
  '| `MODULE_BETA` | online |',
  '| `HUMANS` | `team` — two people |',
  '| `PATTERN` | `^(a|b)$` |',
  '| `MODULE_ALPHA` | off (a later row with the same key) |',
].join('\n');

const list = (): StartReadingList => {
  const r = parseStartReading('list.json', JSON.stringify(LIST));
  assert.equal(r.problem, null);
  return r.problem === null ? r.list : (null as never);
};

const W = path.resolve('/w');
const P = path.resolve('/p');
const where = { folder: W, projectFolder: P, projectConfig: path.join(P, 'docs/CONFIG.md'), local: true };

test("a module is on when the value cell's first word is the named value, ignoring case and what follows; a missing key is off", () => {
  const v = configValues(CONFIG);
  assert.equal(moduleOn(v, 'MODULE_ALPHA', 'on'), true, '**on** with a note after it');
  assert.equal(moduleOn(v, 'MODULE_ALPHA', 'ON'), true, 'case ignored');
  assert.equal(moduleOn(v, 'MODULE_BETA', 'on'), false, '"online" is not "on"');
  assert.equal(moduleOn(v, 'HUMANS', 'team'), true, 'backticks stripped');
  assert.equal(moduleOn(v, 'HUMANS', 'single'), false);
  assert.equal(moduleOn(v, 'MODULE_GAMMA', 'on'), false, 'a missing key is off');
  assert.equal(moduleOn(v, 'MODULE_GAMMA', 'off'), false, 'a missing key is not "off" either: it names nothing');
  assert.equal(v.get('MODULE_ALPHA'), 'on (agent-workflow v120; switched on 2026-10-01)', "the key's first row counts");
  assert.equal(v.has('Key'), true, 'the header row is a row like any other; no module is called "Key"');
  assert.equal(v.has('---'), false, 'the separator row is not a key');
  assert.equal(moduleOn(configValues(null), 'MODULE_ALPHA', 'on'), false, 'no config at all: every module off');
});

test("a manager's list: read, then the modules that are on, then the project's files, in that order", () => {
  const items = startItems(list(), { role: 'manager', title: 'Manager: P' }, where, configValues(CONFIG));
  assert.deepEqual(items.map((i) => [i.kind, i.file]), [
    ['read', path.join(W, 'process/lead.md')],
    ['read', path.join(W, 'modules/alpha/LEAD.md')],
    ['read', path.join(W, 'modules/team/LEAD.md')],
    ['read', path.join(P, 'docs/CONFIG.md')],
    ['read', path.join(P, 'notes/missing.md')],
    ['print', path.join(P, 'notes/GOAL.md')],
  ]);
  // With the modules off, only what is always read.
  assert.deepEqual(startItems(list(), { role: 'manager', title: 'M' }, where, configValues('')).map((i) => i.file).slice(0, 2), [path.join(W, 'process/lead.md'), path.join(P, 'docs/CONFIG.md')]);
});

test("a session gets its own list and the first brief whose prefix starts its title, with that brief's own modules", () => {
  const v = configValues(CONFIG);
  const files = (title: string) => startItems(list(), { role: 'session', title }, where, v).map((i) => i.file);
  assert.deepEqual(files('fix-12'), [path.join(W, 'process/worker.md'), path.join(W, 'modules/team/SESSIONS.md'), path.join(P, 'docs/CONFIG.md')]);
  assert.deepEqual(files('test-review-7'), [path.join(W, 'process/worker.md'), path.join(W, 'modules/team/SESSIONS.md'), path.join(W, 'briefs/test-review.md'), path.join(P, 'docs/CONFIG.md')], 'the first match only');
  assert.deepEqual(files('review-7')[2], path.join(W, 'briefs/review.md'));
  assert.deepEqual(files('run-day').slice(2, 4), [path.join(W, 'briefs/run.md'), path.join(W, 'modules/alpha/run.md')], 'the brief, then its own module');
  assert.deepEqual(startItems(list(), { role: 'session', title: 'run-day' }, where, configValues('')).map((i) => i.file).slice(1, 3), [path.join(W, 'briefs/run.md'), path.join(P, 'docs/CONFIG.md')], 'its module off');
  assert.equal(files('my review-7').includes(path.join(W, 'briefs/review.md')), false, 'a prefix, not anywhere in the title');
});

test('the printed text names the files in order, prints a print file, and skips a missing project file without a word', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-start-reading-'));
  try {
    const project = path.join(dir, 'project');
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(project, 'notes'));
    fs.writeFileSync(path.join(project, 'docs/CONFIG.md'), CONFIG);
    fs.writeFileSync(path.join(project, 'notes/GOAL.md'), '# Goal\n\nShip it.\n');
    const listFile = path.join(dir, 'list.json');
    fs.writeFileSync(listFile, JSON.stringify(LIST));
    const sr: StartReading = { file: listFile, folder: W, projectFolder: project, projectConfig: path.join(project, 'docs/CONFIG.md'), local: true };
    const read = (f: string) => fs.promises.readFile(f, 'utf8').catch(() => null);
    const out = await sessionStartText(sr, { role: 'manager', title: 'Manager: P' }, read);
    assert.equal(out, [
      "The workflow's start-reading list: read these in full before anything else, in this order.",
      `1. ${path.join(W, 'process/lead.md')}`,
      `2. ${path.join(W, 'modules/alpha/LEAD.md')} (MODULE_ALPHA is on)`,
      `3. ${path.join(W, 'modules/team/LEAD.md')} (HUMANS is team)`,
      `4. ${path.join(project, 'docs/CONFIG.md')}`,
      `5. ${path.join(project, 'notes/GOAL.md')}, as it stands now:`,
      '# Goal\n\nShip it.',
      '(end of GOAL.md)',
    ].join('\n'));
    // Positive branch of "missing is skipped": once it exists, it is named.
    fs.writeFileSync(path.join(project, 'notes/missing.md'), 'here now');
    const later = await sessionStartText(sr, { role: 'manager', title: 'Manager: P' }, read);
    assert.match(later!, new RegExp(`5\\. ${path.join(project, 'notes/missing.md').replace(/[\\.]/g, '\\$&')}\\n`));
  } finally {
    removeTemp(dir);
  }
});

test('a bad list says what is wrong with it', () => {
  const problem = (v: unknown) => parseStartReading('l.json', typeof v === 'string' || v === null ? v : JSON.stringify(v)).problem ?? '';
  assert.equal(problem(null), "The workflow's start-reading list l.json was not found.");
  assert.match(problem('{ nope'), /^The workflow's start-reading list l\.json is not valid JSON: /);
  assert.match(problem({ version: 2 }), /version: version must be 1/);
  assert.match(problem({ version: 1, manager: { read: 'process/lead.md' } }), /manager\.read/);
  assert.match(problem({ version: 1, manager: { modules: [{ key: 'X', value: 'on', read: 'x.md' }] } }), /manager\.modules\.0/, 'a misspelt key');
  assert.match(problem({ version: 1, manager: { byTitlePrefix: [] } }), /manager/, 'briefs by title are for sessions only');
  assert.match(problem({ version: 1, session: { projectFiles: [{ path: '../elsewhere/secret.md', print: true }] } }), /session\.projectFiles\.0\.path: path must stay inside the project folder/);
  assert.match(problem({ version: 1, session: { projectFiles: [{ path: path.resolve('/etc/passwd') }] } }), /must stay inside the project folder/);
  // Positive branch: the workflow's own shape parses.
  assert.equal(problem(LIST), '');
});

test('a broken list is told at every start until it is fixed; only a manager is asked to report it', async () => {
  // Martin, 2026-11-06 00:11, Ledung question #1498: "a — At every start". A start is a fresh context.
  let text: string | null = null;
  const read = (f: string) => parseStartReading(f, text);
  const sr: StartReading = { file: '/w/list.json', ...where };
  const none = async () => null;
  const manager = { role: 'manager' as const, title: 'Manager' };
  const notice = "The workflow's start-reading list /w/list.json was not found. No start-reading list is shown until it is fixed. Tell whoever you ask (ask_user) once.";
  assert.equal(await sessionStartText(sr, manager, none, read), notice);
  assert.equal(await sessionStartText(sr, manager, none, read), notice, 'again at the next start');
  text = '{ nope';
  assert.match((await sessionStartText(sr, manager, none, read))!, /is not valid JSON/);
  text = JSON.stringify(LIST);
  assert.match((await sessionStartText(sr, manager, none, read))!, /^The workflow's start-reading list: read these/, 'fixed: the list');
  const worker = await sessionStartText(sr, { role: 'session', title: 'fix-1' }, none, (f) => parseStartReading(f, null));
  assert.ok(worker!.endsWith('No start-reading list is shown until it is fixed.'), 'a worker is told, but not asked to report it');
});

test('with no list, or none for this role, nothing is added; a project file that fails to read is skipped, never thrown', async () => {
  const boom = () => { throw new Error('nothing should be read'); };
  assert.equal(await sessionStartText(undefined, { role: 'manager', title: 'M' }, boom, boom), null);
  const onlyManager = (f: string) => parseStartReading(f, JSON.stringify({ version: 1, manager: { read: ['lead.md'] } }));
  const sr: StartReading = { file: '/w/l.json', ...where };
  assert.equal(await sessionStartText(sr, { role: 'session', title: 'fix-1' }, boom, onlyManager), null, 'no session list');
  assert.match((await sessionStartText(sr, { role: 'manager', title: 'M' }, boom, onlyManager))!, /1\. .*lead\.md$/, 'the manager gets its own');
  const failing = async () => { throw new Error('container gone'); };
  const withFiles = (f: string) => parseStartReading(f, JSON.stringify({ version: 1, manager: { read: ['lead.md'], modules: [{ key: 'MODULE_ALPHA', is: 'on', read: 'a.md' }], projectFiles: [{ path: 'GOAL.md', print: true }] } }));
  const out = await sessionStartText(sr, { role: 'manager', title: 'M' }, failing, withFiles);
  assert.equal(out, `The workflow's start-reading list: read these in full before anything else, in this order.\n1. ${path.join(W, 'lead.md')}`);
});

test('audit L17: a list file or a printed project file whose real path leads outside its folder is refused with the problem line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-start-reading-'));
  try {
    const [workflow, project, outside] = ['workflow', 'project', 'outside'].map((d) => path.join(dir, d)) as [string, string, string];
    for (const d of [workflow, project, outside]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET');
    fs.writeFileSync(path.join(project, 'GOAL.md'), 'The goal.');
    // Junctions: links to a folder that Windows makes without an administrator, as the chats test does.
    fs.symlinkSync(outside, path.join(project, 'linked'), 'junction');
    fs.symlinkSync(outside, path.join(workflow, 'linked'), 'junction');
    const list = (files: string[]) => JSON.stringify({ version: 1, session: { read: ['worker.md'], projectFiles: files.map((p) => ({ path: p, print: true })) } });
    const sr = (file: string): StartReading => ({ file, folder: workflow, projectFolder: project, projectConfig: path.join(project, 'CFG.md'), local: true });
    const s = { role: 'session' as const, title: 'fix-1' };
    // The readers the session passes (Session.startReadingContext): both check the real path.
    const readProject = (f: string) => readInsideProject(project, f);
    const listFile = path.join(workflow, 'list.json');
    // The positive branch: a list inside the workflow's folder, and a project file inside the project, are read.
    fs.writeFileSync(listFile, list(['GOAL.md']));
    assert.match((await sessionStartText(sr(listFile), s, readProject, readStartReadingFile))!, /GOAL\.md, as it stands now:\nThe goal\.\n/);
    // A printed project file through a link out of the project: the whole list is refused, nothing of it pasted.
    fs.writeFileSync(listFile, list(['GOAL.md', 'linked/secret.md']));
    const out = await sessionStartText(sr(listFile), s, readProject, readStartReadingFile);
    assert.equal(out, `The workflow's start-reading list ${listFile} names ${path.join(project, 'linked', 'secret.md')}, which leads outside the project folder. No start-reading list is shown until it is fixed.`);
    // The list file itself, through a link or "..": not read.
    fs.writeFileSync(path.join(outside, 'list.json'), list(['GOAL.md']));
    for (const file of [path.join(workflow, 'linked', 'list.json'), path.resolve(workflow, '../outside/list.json')]) {
      assert.equal(await sessionStartText(sr(file), s, readProject, readStartReadingFile), `The workflow's start-reading list ${file} leads outside the workflow's folder ${workflow}, so it is not read. No start-reading list is shown until it is fixed.`, file);
    }
  } finally {
    removeTemp(dir);
  }
});

test("the config takes a workflow's startReadingFile, and the project's workflow carries it with its folders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-start-reading-'));
  try {
    const workflow = { folder: dir, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'CFG.md' };
    const config = parseConfig({ workflow: { ...workflow, startReadingFile: 'process/start-reading.json' } });
    assert.equal(config.workflow!.startReadingFile, 'process/start-reading.json');
    const project = parseProject({ name: 'p', runner: 'local', path: dir });
    assert.deepEqual(projectWorkflow(config.workflow, project)!.startReading, {
      file: path.resolve(dir, 'process/start-reading.json'), folder: dir, projectFolder: dir, projectConfig: path.resolve(dir, 'CFG.md'), local: true,
    });
    assert.equal(projectWorkflow(parseConfig({ workflow }).workflow, project)!.startReading, undefined, 'no key: no list');
  } finally {
    removeTemp(dir);
  }
});

test("every session gets Ledung's SessionStart hook; it adds the list when the workflow has one, nothing otherwise", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-start-reading-'));
  try {
    fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify({ version: 1, session: { read: ['process/worker.md'], projectFiles: [{ path: 'GOAL.md', print: true }] } }));
    fs.writeFileSync(path.join(dir, 'GOAL.md'), 'The goal.');
    const store = new Store(openDatabase(':memory:'));
    const management = new Management({
      store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
      startSession: async () => { throw new Error('not used'); },
      stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
      machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
      setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
      projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
      ensureManager: async () => { throw new Error('not used'); },
    });
    const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'fix-1', parentId: null, permissionMode: 'default' });
    const base: ProjectWorkflow = { rulesFile: () => path.join(dir, 'process/worker.md'), projectConfig: path.join(dir, 'CFG.md'), configExists: false };
    const startText = async (workflow: ProjectWorkflow | null, source: string) => {
      const session = new Session({
        info, store, publish: () => {}, userName: 'Simon', management, workflow,
        runner: { cwd: dir, currentBranch: async () => null } as never,
        gate: { mayStart: () => true, started: () => {}, ended: () => {} },
      });
      const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
      const hooks = options.hooks!.SessionStart!;
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0]!.matcher, undefined, 'every source: startup, clear, compact and resume');
      const out = await hooks[0]!.hooks[0]!({ hook_event_name: 'SessionStart', source } as never, undefined, { signal: new AbortController().signal });
      return (out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? null;
    };
    const sr: StartReading = { file: path.join(dir, 'list.json'), folder: dir, projectFolder: dir, projectConfig: path.join(dir, 'CFG.md'), local: true };
    for (const source of ['startup', 'clear', 'compact', 'resume']) {
      assert.equal(await startText({ ...base, startReading: sr }, source), [
        "The workflow's start-reading list: read these in full before anything else, in this order.",
        `1. ${path.join(dir, 'process/worker.md')}`,
        `2. ${path.join(dir, 'GOAL.md')}, as it stands now:`,
        'The goal.',
        '(end of GOAL.md)',
      ].join('\n'), source);
    }
    // A launch's own startup SessionStart never reaches the SDK's hook (loopback), so its first prompt carries the
    // list, and only the first; once a SessionStart did reach the hook, no prompt carries it.
    const prompts = async (workflow: ProjectWorkflow | null, startFirst: boolean, attachTo?: string) => {
      const session = new Session({
        info, store, publish: () => {}, userName: 'Simon', management, workflow,
        runner: { cwd: dir, currentBranch: async () => null } as never,
        gate: { mayStart: () => true, started: () => {}, ended: () => {} },
        ...(attachTo ? { attachTo } : {}),
      });
      const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
      const signal = { signal: new AbortController().signal };
      if (startFirst) await options.hooks!.SessionStart![0]!.hooks[0]!({ hook_event_name: 'SessionStart', source: 'clear' } as never, undefined, signal);
      const prompt = options.hooks!.UserPromptSubmit![0]!.hooks[0]!;
      const say = async () => ((await prompt({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' } as never, undefined, signal)) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      return [await say(), await say()];
    };
    const [first, second] = await prompts({ ...base, startReading: sr }, false);
    assert.match(first!, /\n\nThe workflow's start-reading list: read these in full before anything else, in this order\.\n1\. .*worker\.md\n2\. .*GOAL\.md, as it stands now:\nThe goal\./);
    assert.doesNotMatch(second!, /start-reading list/, 'the second prompt does not');
    assert.match(second!, /^Current local time: /, 'the second prompt has its usual lines (the probe reads real output)');
    const [afterHook] = await prompts({ ...base, startReading: sr }, true);
    assert.doesNotMatch(afterHook!, /start-reading list/, 'a SessionStart that reached the hook already said it');
    assert.doesNotMatch((await prompts(null, false))[0]!, /start-reading list/, 'no workflow: the first prompt as before');
    // A session that kept running in its host while Ledung restarted (Restart Ledung after a release) already has the
    // list: reattached, its next prompt does not get it again. The first-prompt assert above is the positive branch.
    const [reattached] = await prompts({ ...base, startReading: sr }, false, 'pipe-of-a-running-host');
    assert.doesNotMatch(reattached!, /start-reading list/, 'a reattached session is not given the list again');
    assert.match(reattached!, /^Current local time: /);

    assert.equal(await startText(base, 'clear'), null, 'a workflow without a list: nothing extra');
    assert.equal(await startText(null, 'clear'), null, 'no workflow: nothing extra');
    // A list that can't be read never fails the start: it is told, as text, and at every start of the same session
    // (Martin, 2026-11-06 00:11, Ledung question #1498), since each start is a fresh context.
    const broken = new Session({
      info, store, publish: () => {}, userName: 'Simon', management, workflow: { ...base, startReading: { ...sr, file: path.join(dir, 'gone.json') } },
      runner: { cwd: dir, currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
    const brokenHook = (await broken.claudeOptions({ onLine: () => {}, onStderr: () => {} })).hooks!.SessionStart![0]!.hooks[0]!;
    for (const source of ['clear', 'compact', 'clear']) {
      const out = await brokenHook({ hook_event_name: 'SessionStart', source } as never, undefined, { signal: new AbortController().signal });
      assert.match((out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '', /gone\.json was not found\. No start-reading list is shown until it is fixed\./, `told again at ${source}`);
    }
  } finally {
    removeTemp(dir);
  }
});

test("a container project's list: its folder in the container, project files joined with / and read through the container", () => {
  // The workflow's folder is on this computer, so its files keep this computer's paths; the project's are the container's.
  const docker = parseProject({ name: 'c', runner: 'docker', container: 'box', pathInContainer: '/work', workflow: { use: true } });
  const config = parseConfig({ workflow: { folder: W, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'docs/CONFIG.md', startReadingFile: 'list.json' } });
  const sr = projectWorkflow(config.workflow, docker)!.startReading!;
  assert.deepEqual(sr, { file: path.resolve(W, 'list.json'), folder: W, projectFolder: '/work', projectConfig: '/work/docs/CONFIG.md', local: false });
  const items = startItems(list(), { role: 'manager', title: 'M' }, sr, configValues(CONFIG));
  assert.deepEqual(items.map((i) => i.file), [
    path.join(W, 'process/lead.md'), path.join(W, 'modules/alpha/LEAD.md'), path.join(W, 'modules/team/LEAD.md'),
    '/work/docs/CONFIG.md', '/work/notes/missing.md', '/work/notes/GOAL.md',
  ]);
});

test("a container session reads the project's files through its runner, by the path from where the runner stands", async () => {
  const store = new Store(openDatabase(':memory:'));
  const info = store.createSession({ id: 'c1', project: 'c', runner: 'docker', title: 'fix-2', parentId: null, permissionMode: 'default' });
  const asked: string[] = [];
  // The session runs in a worktree below the project folder, so the goal file is three folders up from where it stands.
  const runner = {
    cwd: '/work/.claude/worktrees/fix-2', currentBranch: async () => null,
    readProjectFile: async (rel: string) => { asked.push(rel); return rel === '../../../GOAL.md' ? 'The container goal.' : null; },
  };
  const listDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-start-reading-'));
  try {
    fs.writeFileSync(path.join(listDir, 'list.json'), JSON.stringify({ version: 1, session: { read: ['worker.md'], projectFiles: [{ path: 'GOAL.md', print: true }] } }));
    const sr: StartReading = { file: path.join(listDir, 'list.json'), folder: listDir, projectFolder: '/work', projectConfig: '/work/CFG.md', local: false };
    const session = new Session({
      info, store, publish: () => {}, userName: 'Simon',
      management: { managerOf: () => null, questionTiers: () => [] } as never,
      workflow: { rulesFile: () => path.join(listDir, 'worker.md'), projectConfig: '/work/CFG.md', configExists: null, startReading: sr },
      runner: runner as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
    const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
    const out = await options.hooks!.SessionStart![0]!.hooks[0]!({ hook_event_name: 'SessionStart', source: 'clear' } as never, undefined, { signal: new AbortController().signal });
    assert.deepEqual(asked, ['../../../GOAL.md']);
    assert.equal((out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext, [
      "The workflow's start-reading list: read these in full before anything else, in this order.",
      `1. ${path.join(listDir, 'worker.md')}`,
      '2. /work/GOAL.md, as it stands now:',
      'The container goal.',
      '(end of GOAL.md)',
    ].join('\n'));
  } finally {
    removeTemp(listDir);
  }
});
