// A project's workflow as a flow (issue #310, part 1): the format, the design's checks, the reader and what a
// manager is told. Ledung's own process (test/fixtures/flow-ledung) is the example.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProject, type WorkflowConfig } from '../src/config.ts';
import { INSIDE_PROJECT_SCRIPT, splitMarked } from '../src/runners/docker-runner.ts';
import { checkFlow, machinePathIn, parseFlow } from '../src/shared/flow-check.ts';
import { flowInstructions, flowPlaces, localReader, readFlowView, type ContainerFiles, type ContainerRead } from '../src/sessions/flow-files.ts';
import { drawnArrows, type Flow } from '../src/shared/flow.ts';
import { removeTemp } from './temp.ts';

const EXAMPLE = path.resolve('test/fixtures/flow-ledung');
const exampleText = () => fs.readFileSync(path.join(EXAMPLE, '.ledung', 'workflow', 'flow.json'), 'utf8');
const temps: string[] = [];
after(() => temps.forEach(removeTemp));

/** A project folder with a .ledung/workflow made of `files` (path inside the workflow folder → text). */
function projectWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-flow-'));
  temps.push(dir);
  for (const [f, text] of Object.entries(files)) {
    const at = path.join(dir, '.ledung', 'workflow', ...f.split('/'));
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text);
  }
  return dir;
}

function flowOf(raw: unknown): Flow {
  const parsed = parseFlow(JSON.stringify(raw));
  assert.deepEqual(parsed.problems, []);
  return parsed.flow!;
}

const block = (id: string, more: Record<string, unknown> = {}) => ({ id, kind: 'work', title: id.toUpperCase(), ...more });
/** An outcome (#1184): its word, where it leads, and optionally on which time of the word. */
const out = (to: string, word = 'Next', times?: number) => ({ word, to, ...(times ? { times } : {}) });
/** Blocks with ways between them, each [from, to, word?, times?], as the blocks' outcomes. */
function ways(blocks: Record<string, unknown>[], list: [string, string, string?, number?][]): Record<string, unknown>[] {
  return blocks.map((b) => {
    const mine = list.filter(([from]) => from === b.id).map(([, to, word, times]) => out(to, word, times));
    return mine.length ? { ...b, outcomes: [...((b.outcomes as unknown[]) ?? []), ...mine] } : b;
  });
}

test("Ledung's own process reads as a flow with no problems, every brief and the rules found", async () => {
  const view = await readFlowView('Ledung', flowPlaces(parseProject({ name: 'Ledung', runner: 'local', path: EXAMPLE }), undefined), ['full']);
  assert.deepEqual(view.problems, []);
  assert.equal(view.source?.kind, 'project');
  assert.equal(view.flow?.blocks.length, 8);
  // Its second flow (#447): made, reviewed by a person, ended Ready or Rejected; "Make the asset" runs it.
  assert.deepEqual(view.flows.map((f) => [f.name, f.file, f.flow?.title, f.problems]), [['asset', 'flows/asset.json', 'Asset', []]]);
  assert.deepEqual(view.flow!.blocks.find((b) => b.id === 'asset'), { id: 'asset', kind: 'flow', title: 'Make the asset', flow: 'asset', outcomes: [{ word: 'Ready', to: 'build' }, { word: 'Rejected', end: true }] });
  assert.match(view.texts['briefs/asset-maker.md'] ?? '', /Asset maker/, "the other flow's briefs are read with the rest");
  assert.match(view.rules ?? '', /Standing rules/);
  assert.match(view.texts['briefs/reviewer.md'] ?? '', /never fix it yourself/);
  assert.ok(view.texts['overlays/check-before-push.md']);
  assert.match(view.texts['manager.md'] ?? '', /between steps/, "the manager's file is read with the briefs (#322)");
  // Build runs as a new session with a self-review sub-step; Fix continues its session (#322).
  const build = view.flow!.blocks.find((b) => b.id === 'build')!;
  assert.equal(build.runs, 'new-session');
  assert.deepEqual(build.substeps, [{
    id: 'self-review', kind: 'check', title: 'Self-review', brief: 'briefs/reviewer.md', model: 'sonnet', when: 'done',
    outcomes: [{ word: 'No findings', to: 'done' }, { word: 'Findings', to: 'owner' }, { word: 'Findings', times: 3, to: 'report' }],
  }]);
  assert.deepEqual(view.flow!.blocks.find((b) => b.id === 'fix'), { id: 'fix', kind: 'work', title: 'Fix', runs: 'continue', continues: 'build', brief: 'briefs/builder.md', outcomes: [{ word: 'Fixed', to: 'code-review' }] });
  const review = view.flow!.blocks.find((b) => b.id === 'functional-review')!;
  assert.equal(review.ask, 'review');
  // Code review's "Changes requested" goes to Fix, its 3rd time to the person (#1184).
  const arrows = drawnArrows(view.flow!);
  assert.deepEqual(arrows.filter((a) => a.from === 'code-review').map((a) => [a.to, a.word, a.times]), [
    ['functional-review', 'Approved', undefined],
    ['fix', 'Changes requested', undefined],
    ['decide', 'Changes requested', 3],
  ]);
});

test('the schema refuses what is not a flow, in words, with the block named', () => {
  const bad = (raw: unknown) => parseFlow(JSON.stringify(raw)).problems.map((p) => `${p.at}: ${p.message}`);
  assert.match(parseFlow('{ not json').problems[0]!.message, /not valid JSON/);
  assert.match(bad({ version: 2, blocks: [block('a')] })[0]!, /^version: must be 1/);
  assert.match(bad({ version: 1, blocks: [] })[0]!, /at least one block/);
  assert.match(bad({ version: 1, blocks: [block('build', { kind: 'meeting' })] })[0]!, /^blocks\.build\.kind: is one of work, check/);
  // A field this Ledung doesn't know is a problem, not quietly ignored, but the flow still draws: a typo shows, and a
  // flow from a newer Ledung (part 6) can still be read.
  const typo = parseFlow(JSON.stringify({ version: 1, blocks: [block('build', { brif: 'briefs/x.md', outcomes: [{ word: 'Again', to: 'build', times: 2, tries: 2 }] })], extra: 1 }));
  assert.ok(typo.flow);
  assert.deepEqual(typo.problems.map((p) => p.at), ['extra', 'blocks.build.brif', 'blocks.build.outcomes.1.tries']);
  assert.match(typo.problems[0]!.message, /not a field this Ledung knows .* left out/);
  assert.equal('brif' in typo.flow.blocks[0]!, false);
  // Outcomes count from 1 in every problem, the schema's and the checks' alike.
  assert.match(bad({ version: 1, blocks: [block('a', { outcomes: [out('a'), out('A')] })] })[0]!, /^blocks\.a\.outcomes\.2\.to: /);
  // A BOM before the JSON is not part of it; words keep their spaces (the builder writes back what it read).
  assert.equal(parseFlow('\uFEFF' + JSON.stringify({ version: 1, blocks: [block('a', { title: ' A ' })] })).flow?.blocks[0]!.title, ' A ');
  assert.match(bad({ version: 1, blocks: [block('a', { title: '   ' })] })[0]!, /^blocks\.a\.title: is empty/);
  assert.match(bad({ version: 1, blocks: [block('Build Step')] })[0]!, /lower case letters/);
  assert.match(bad({ version: 1, blocks: [block('a', { outcomes: [{ word: ' ', to: 'a' }] })] })[0]!, /^blocks\.a\.outcomes\.1\.word: is empty/);
  assert.match(bad({ version: 1, blocks: [block('a', { outcomes: [out('a', 'Again', 0)].map((o) => ({ ...o, times: 0 })) })] })[0]!, /^blocks\.a\.outcomes\.1\.times: /);
  assert.match(bad({ version: 1, blocks: [block('t', { kind: 'timer', timer: { every: 'often' } })] })[0]!, /"every": 30/);
  // A block's canvas position is a pair of numbers (part 2 stores the layout there).
  assert.equal(flowOf({ version: 1, blocks: [block('a', { at: { x: 10, y: -4.5 } })] }).blocks[0]!.at?.x, 10);
  // $comment is for people; it is allowed anywhere and not passed on.
  const flow = flowOf({ $comment: 'c', version: 1, blocks: [block('a', { $comment: 'c', outcomes: [{ $comment: 'c', word: 'Again', to: 'a' }] })] });
  assert.equal('$comment' in flow, false);
  assert.equal('$comment' in flow.blocks[0]!, false);
  assert.deepEqual(flow.blocks[0]!.outcomes, [{ word: 'Again', to: 'a' }]);
});

test('paths in the flow stay inside the workflow folder: no absolute path, "..", backslash, drive or encoding', () => {
  for (const brief of ['/etc/passwd.md', 'C:/x.md', 'C:\\x.md', '..\\x.md', '../x.md', 'briefs/../../x.md', './x.md', 'briefs/%2e%2e/x.md', '\\\\server\\x.md', 'briefs/x.txt']) {
    const parsed = parseFlow(JSON.stringify({ version: 1, blocks: [block('a', { brief })] }));
    assert.equal(parsed.flow, null, brief);
    assert.match(parsed.problems[0]!.at, /^blocks\.a\.brief$/, brief);
  }
  for (const brief of ['briefs/code-review.md', 'review.md', 'briefs/Code Review.md']) assert.ok(flowOf({ version: 1, blocks: [block('a', { brief })] }), brief);
});

test('every block reachable from the start or a timer', () => {
  const flow = flowOf({
    version: 1, start: 'a',
    blocks: ways([block('a'), block('b'), block('orphan'), block('nightly', { kind: 'timer', timer: { clock: 'daily' } }), block('c')], [['a', 'b'], ['nightly', 'c']]),
  });
  assert.deepEqual(checkFlow(flow, () => true).filter((p) => !p.hint).map((p) => p.at), ['blocks.orphan']);
  assert.match(checkFlow(flow, () => true).find((p) => !p.hint)!.message, /No outcome leads to "ORPHAN"/);
});

test('every loop is limited by an outcome with a count, or a person in it (#1184)', () => {
  const faults = (f: Flow) => checkFlow(f, () => true).filter((p) => !p.hint);
  const loop = (review: [string, string, string?, number?][]) => faults(flowOf({
    version: 1,
    blocks: ways([block('build'), block('review', { kind: 'check' }), block('fix'), block('ask', { kind: 'person', ask: 'question' })], [['build', 'review'], ['fix', 'review'], ['ask', 'fix'], ...review]),
  }));
  // Simon's: "Failed" back to Fix, the 3rd "Failed" to the person.
  assert.deepEqual(loop([['review', 'fix', 'Failed'], ['review', 'ask', 'Failed', 3]]), []);
  const open = loop([['review', 'fix', 'Failed']]);
  assert.equal(open.length, 2, 'the loop, and the person block nothing reaches now');
  assert.match(open.find((p) => /for ever/.test(p.message))!.message, /REVIEW → FIX can go round for ever: give an outcome in it a count/);
  // A count on another word limits nothing: "Failed" still goes round.
  assert.match(loop([['review', 'fix', 'Failed'], ['review', 'ask', 'Blocked', 3]]).map((p) => p.message).join('\n'), /can go round for ever/);
  // A person deciding each round limits it: the functional review's "Changes needed → Fix".
  assert.deepEqual(faults(flowOf({ version: 1, blocks: ways([block('fix'), block('fr', { kind: 'person', ask: 'review' })], [['fix', 'fr'], ['fr', 'fix', 'Changes needed']]) })), []);
  // A block with an outcome to itself is a loop too.
  assert.match(faults(flowOf({ version: 1, blocks: ways([block('a'), block('b')], [['a', 'b'], ['b', 'b', 'Again']]) }))[0]!.message, /^B can go round for ever/);
});

test('a counted outcome limits the loop through it too: 2 rounds, then the lead, then the reviewers again (#318, port finding 2)', () => {
  const faults = (f: Flow) => checkFlow(f, () => true).filter((p) => !p.hint);
  // Build → Review; "Failed" back to Build, the 3rd to the lead, who sends it back to Review. No person anywhere.
  const escalated = flowOf({ version: 1, blocks: ways([block('build'), block('review', { kind: 'check' }), block('lead', { runs: 'manager' }), block('merge')], [['build', 'review'], ['review', 'build', 'Failed'], ['review', 'lead', 'Failed', 3], ['lead', 'review'], ['review', 'merge', 'Approved']]) });
  assert.deepEqual(faults(escalated), []);
  // The lead back to Build, through Build's way to Review, is limited the same way.
  const viaBuild = flowOf({ version: 1, blocks: ways([block('build'), block('review', { kind: 'check' }), block('lead'), block('merge')], [['build', 'review'], ['review', 'build', 'Failed'], ['review', 'lead', 'Failed', 3], ['lead', 'build'], ['review', 'merge', 'Approved']]) });
  assert.deepEqual(faults(viaBuild), []);
  // A loop beside the counted one, with no count of its own, is still one.
  const beside = flowOf({ version: 1, blocks: ways([block('build'), block('review', { kind: 'check' }), block('lead'), block('fix')], [['build', 'review'], ['review', 'build', 'Failed'], ['review', 'lead', 'Failed', 3], ['lead', 'fix'], ['fix', 'lead']]) });
  assert.match(faults(beside).map((p) => p.message).join('\n'), /LEAD → FIX can go round for ever/);
});

test('every person block says what it asks; only person and timer blocks have ask and timer', () => {
  const problems = checkFlow(flowOf({
    version: 1,
    blocks: ways([block('a'), block('p', { kind: 'person' }), block('w', { ask: 'review' }), block('t', { kind: 'timer' }), block('x', { timer: { every: 3, of: 'merges' } })], [['a', 'p'], ['a', 'w'], ['a', 'x']]),
  }), () => true);
  const messages = problems.map((p) => `${p.at}: ${p.message}`).join('\n');
  assert.match(messages, /blocks\.p: The person block "P" doesn't say what it asks/);
  assert.match(messages, /blocks\.w\.ask: Only a person block asks/);
  assert.match(messages, /blocks\.t: The timer block "T" doesn't say when it starts/);
  assert.match(messages, /blocks\.x\.timer: Only a timer block/);
});

test('a timer may carry a guard: at most every N hours, only when a condition holds; only a timer has one (#114)', () => {
  // The issue's examples: a metrics pass at most daily; a steward pass when Triage holds more than five.
  const timer = (more: Record<string, unknown>) => block('t', { kind: 'timer', timer: { every: 10, of: 'merges' }, outcomes: [out('a')], ...more });
  const guarded = flowOf({ version: 1, blocks: [block('a'), timer({ guard: { minHours: 24, when: 'Triage holds more than five' } })] });
  assert.deepEqual(guarded.blocks[1]!.guard, { minHours: 24, when: 'Triage holds more than five' });
  assert.deepEqual(checkFlow(guarded, () => true), []);
  assert.deepEqual(flowOf({ version: 1, blocks: [block('a'), timer({ guard: { when: 'Triage holds more than five' } })] }).blocks[1]!.guard, { when: 'Triage holds more than five' });
  // A guard on another kind of block is a problem, as "timer" is.
  const misplaced = checkFlow(flowOf({ version: 1, blocks: [block('a', { guard: { minHours: 24 } })] }), () => true);
  assert.deepEqual(misplaced.map((p) => [p.at, p.hint ?? false]), [['blocks.a.guard', false]]);
  assert.match(misplaced[0]!.message, /Only a timer block has "guard"/);
  // An empty guard, or hours that are not whole and between 1 and a year, are refused by the format.
  const refused = (guard: unknown) => parseFlow(JSON.stringify({ version: 1, blocks: [block('a'), timer({ guard })] }));
  for (const guard of [{}, { minHours: 0 }, { minHours: 1.5 }, { minHours: 8761 }, { when: ' ' }]) {
    const parsed = refused(guard);
    assert.equal(parsed.flow, null, JSON.stringify(guard));
    assert.match(parsed.problems[0]!.at, /^blocks\.t\.guard/, JSON.stringify(guard));
  }
  assert.match(refused({}).problems[0]!.message, /at least one/);
  assert.ok(refused({ minHours: 8760 }).flow, 'a year is the most');
  // A field the guard doesn't know is said and left out.
  const typo = parseFlow(JSON.stringify({ version: 1, blocks: [block('a'), timer({ guard: { minHours: 24, unless: 'x' } })] }));
  assert.deepEqual(typo.problems.map((p) => p.at), ['blocks.t.guard.unless']);
  // On a clock: no longer than the clock's own gap holds nothing back, a hint; a longer one is fine.
  const onClock = (clock: string, minHours: number) => checkFlow(flowOf({ version: 1, blocks: [block('a'), timer({ timer: { clock }, guard: { minHours } })] }), () => true);
  assert.deepEqual(onClock('daily', 24).map((p) => [p.at, p.hint]), [['blocks.t.guard.minHours', true]]);
  assert.match(onClock('daily', 24)[0]!.message, /starts daily, so "at most every 24 h" holds nothing back/);
  assert.deepEqual(onClock('hourly', 1).map((p) => p.at), ['blocks.t.guard.minHours']);
  assert.deepEqual(onClock('daily', 25), []);
  assert.deepEqual(onClock('weekly', 336), []);
});

test('every linked brief and overlay file exists; outcomes lead to blocks that are there; ids are unique', () => {
  const problems = checkFlow(flowOf({
    version: 1, start: 'nope',
    blocks: [block('a', { brief: 'briefs/a.md', outcomes: [out('ghost', 'Failed'), out('missing')] }), block('a')],
    overlays: [{ id: 'o', title: 'O', file: 'overlays/o.md', blocks: ['a', 'gone'] }],
  }), (f) => f === 'overlays/o.md');
  const messages = problems.map((p) => `${p.at}: ${p.message}`).join('\n');
  assert.match(messages, /blocks\.a: Two blocks have the id "a"/);
  assert.match(messages, /start: starts at "nope", which is not a block/);
  assert.match(messages, /blocks\.a\.outcomes\.1: "Failed" leads to "ghost", which is not a block/);
  assert.match(messages, /blocks\.a\.outcomes\.2: "Next" leads to "missing"/);
  assert.match(messages, /blocks\.a\.brief: The brief briefs\/a\.md is not in the workflow folder/);
  assert.match(messages, /overlays\.o\.blocks: amends "gone"/);
  assert.doesNotMatch(messages, /overlays\.o\.file/);
});

test("a block's profile is one the project's sessions can use (the config's and the workflow's profiles file, #298)", () => {
  const flow = flowOf({ version: 1, blocks: [block('a', { profile: 'review' })] });
  assert.deepEqual(checkFlow(flow, () => true, ['full', 'review']), []);
  assert.match(checkFlow(flow, () => true, ['full'])[0]!.message, /There is no session profile "review" for this project \(there are: full\)/);
  assert.match(checkFlow(flow, () => true, [])[0]!.message, /for this project \(it has none\)/);
});

test('nothing tied to one computer: paths in titles, models or words are problems (part 6, sharing)', () => {
  const flow = flowOf({
    version: 1, title: 'Runs from C:\\Users\\someone\\work',
    blocks: [block('a', { model: '/home/someone/bin/review', outcomes: [out('b', 'D:/share/x')] }), block('b', { title: 'Merge (see /Users/someone/notes)' })],
  });
  assert.deepEqual(checkFlow(flow, () => true).map((p) => p.at), ['blocks.a.model', 'blocks.a.outcomes.1.word', 'blocks.b.title', 'title']);
  // After any sign, not only a space (review of #310): a backtick, a colon.
  const marked = flowOf({ version: 1, blocks: [block('a', { outcomes: [out('b', 'run `C:\\tools\\x.exe`')] }), block('b', { outcomes: [out('a', 'path:/home/someone/x', 3)] })] });
  assert.deepEqual(checkFlow(marked, () => true).filter((p) => !p.hint).map((p) => p.at), ['blocks.a.outcomes.1.word', 'blocks.b.outcomes.1.word']);
  // Words with a slash are not paths, nor are folders every computer or container has.
  assert.deepEqual(checkFlow(flowOf({ version: 1, blocks: [block('a', { title: 'Merge / release', model: 'see /workspace/app and /tmp/x', outcomes: [out('b', 'and/or')] }), block('b')] }), () => true), []);
});

test('a path from the home folder is the same on every computer; a drive, a share or a root folder is not (#318, port finding 3)', () => {
  for (const home of ['~/.config/tool/settings.json', 'see ~\\notes', '$HOME/.config/x', '${HOME}/x', '%USERPROFILE%\\.config\\x', 'in `~/.ssh`']) {
    assert.equal(machinePathIn('rules.md', home), null, home);
    assert.deepEqual(checkFlow(flowOf({ version: 1, blocks: [block('a', { title: home })] }), () => true), [], home);
  }
  for (const tied of ['C:\\Users\\someone\\x', 'D:/work', '\\\\server\\share', '/home/someone/x', '/Users/someone/x', '/root/.config', '/mnt/c/x', '/Volumes/disk/x']) {
    assert.ok(machinePathIn('rules.md', tied), tied);
  }
});

test('the reader: no flow, a broken one, and problems for missing briefs, with the place it read', async () => {
  const empty = projectWith({});
  const none = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: empty }), undefined));
  assert.deepEqual(none, { project: 'p', source: null, expected: '.ledung/workflow/flow.json', flow: null, rules: null, texts: {}, problems: [], raw: null, versions: {}, saveTo: path.join(empty, '.ledung', 'workflow'), flows: [] });
  const broken = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: projectWith({ 'flow.json': '{"version":1}' }) }), undefined));
  assert.equal(broken.flow, null);
  assert.equal(broken.source?.kind, 'project');
  assert.match(broken.problems[0]!.at, /^blocks$/);
  const dir = projectWith({ 'flow.json': JSON.stringify({ version: 1, blocks: [block('a', { brief: 'briefs/a.md' })] }) });
  const missing = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  assert.equal(missing.source?.folder, path.join(dir, '.ledung', 'workflow'));
  assert.equal(missing.rules, null);
  assert.match(missing.problems[0]!.message, /The brief briefs\/a\.md is not in the workflow folder/);
});

test('the reader never leaves the folder: a link in the workflow folder to a file outside it is not read', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-flow-out-'));
  temps.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET');
  const dir = projectWith({ 'flow.json': JSON.stringify({ version: 1, blocks: [block('a', { brief: 'briefs/a.md' })] }) });
  fs.mkdirSync(path.join(dir, '.ledung', 'workflow', 'briefs'));
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, '.ledung', 'workflow', 'briefs', 'a.md'));
    fs.symlinkSync(outside, path.join(dir, '.ledung', 'workflow', 'rules.md'), 'junction');
  } catch {
    t.skip('this machine does not allow links');
    return;
  }
  const view = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  assert.equal(JSON.stringify(view).includes('SECRET'), false);
  assert.equal(view.rules, null);
  // Said once, as refused, with the reason.
  assert.deepEqual(view.problems.map((p) => p.at), ['briefs/a.md', 'rules.md']);
  assert.match(view.problems[0]!.message, /^can't be read: Only files inside the project folder/);
  // The whole workflow folder as a link to outside the project: nothing in it is read.
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-flow-linked-'));
  temps.push(linked);
  fs.mkdirSync(path.join(linked, '.ledung'));
  fs.writeFileSync(path.join(outside, 'flow.json'), JSON.stringify({ version: 1, title: 'SECRET', blocks: [block('a')] }));
  fs.symlinkSync(outside, path.join(linked, '.ledung', 'workflow'), 'junction');
  const out = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: linked }), undefined));
  assert.equal(out.flow, null);
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
  assert.equal(out.source?.kind, 'project');
  assert.match(out.problems[0]!.message, /^can't be read: Only files inside the project folder/);
  // And a link that stays inside is followed, as the file viewer does.
  const rules = (await localReader(EXAMPLE, '.ledung/workflow')(['rules.md'])).get('rules.md');
  assert.ok(rules && 'text' in rules && rules.text.startsWith('# Standing rules'));
});

/** A container that reads with `read`, lists nothing and writes nothing. */
const inBox = (read: ContainerRead): ContainerFiles => ({ read, list: async () => [], write: async () => {} });

test("a shared workflow's folder: its .ledung/workflow is used when the project has none of its own, and the project's own wins (#1073)", async () => {
  const shared = projectWith({ 'flow.json': JSON.stringify({ version: 1, title: 'Shared', blocks: [block('a')] }), 'rules.md': 'shared rules' });
  const workflow: WorkflowConfig = { name: 'team', folder: shared, managerFile: 'LEAD.md', sessionFile: 'WORKER.md', projectConfig: 'P.md' };
  const plain = parseProject({ name: 'p', runner: 'local', path: projectWith({}) });
  const fromShared = await readFlowView('p', flowPlaces(plain, workflow));
  assert.equal(fromShared.flow?.title, 'Shared');
  assert.deepEqual(fromShared.source, { kind: 'workflow', folder: path.join(shared, '.ledung', 'workflow'), workflow: 'team' });
  assert.equal(fromShared.rules, 'shared rules');
  const own = parseProject({ name: 'p', runner: 'local', path: projectWith({ 'flow.json': JSON.stringify({ version: 1, title: 'Own', blocks: [block('a')] }) }) });
  assert.equal((await readFlowView('p', flowPlaces(own, workflow))).flow?.title, 'Own');
  // A project out of the workflow (use: false) never reads its folder.
  const out = parseProject({ name: 'p', runner: 'local', path: projectWith({}), workflow: { use: false } });
  assert.equal((await readFlowView('p', flowPlaces(out, workflow))).source, null);
  // A project's own flow.json that is there but refused (too large, not text, a link out) doesn't give way to the
  // shared one: the page says why (review of #310, finding 2).
  const big = parseProject({ name: 'p', runner: 'local', path: projectWith({ 'flow.json': ' '.repeat(256 * 1024 + 1) }) });
  const refused = await readFlowView('p', flowPlaces(big, workflow));
  assert.equal(refused.source?.kind, 'project');
  assert.equal(refused.flow, null);
  assert.match(refused.problems[0]!.message, /^can't be read: .*too large/);
  // A container project follows a shared workflow only when it says so (#21), and reads its own through the container.
  const container = parseProject({ name: 'c', runner: 'docker', container: 'box', pathInContainer: '/work' });
  const asked: string[][] = [];
  const places = flowPlaces(container, workflow, inBox(async (files) => {
    asked.push(files);
    return new Map(files.map((f) => [f, { missing: true as const }]));
  }));
  assert.deepEqual(places.map((p) => [p.kind, p.folder]), [['project', '/work/.ledung/workflow']]);
  assert.equal((await readFlowView('c', places)).source, null);
  assert.deepEqual(asked, [['.ledung/workflow/flow.json']]);
  // A container that can't be read is said, not taken for "no flow".
  const down = flowPlaces(container, undefined, inBox(async (files) => new Map(files.map((f) => [f, { refused: 'the container "box" could not be read' }]))));
  assert.match((await readFlowView('c', down)).problems[0]!.message, /container "box" could not be read/);
  assert.equal(await flowInstructions(down), null);
});

test('a manager is told where the flow is, short, only when there is one', async () => {
  const project = parseProject({ name: 'Ledung', runner: 'local', path: EXAMPLE });
  const line = await flowInstructions(flowPlaces(project, undefined));
  assert.equal(line, `The process is drawn in ${path.join(EXAMPLE, '.ledung', 'workflow', 'flow.json')} (blocks, who acts, where a person decides; Ledung's workflow page shows it), with the briefs it links and any standing rules (rules.md) beside it: read them and follow the flow: judge each result against its block's outcomes, which say where the work goes next. Your standing procedures between steps: manager.md there. Other flows, in ${path.join('flows', '<name>.json')}: asset. Each piece of work runs in one flow, flow.json's unless you or the person pick another; a "Run flow" block starts its flow as a piece of work of its own, and the word that flow ends with is the block's outcome.`);
  assert.ok(line!.length < 700 + EXAMPLE.length);
  // No manager's file (#322): nothing more.
  const plain = projectWith({ 'flow.json': JSON.stringify({ version: 1, blocks: [block('a', { runs: 'manager' })] }) });
  assert.match((await flowInstructions(flowPlaces(parseProject({ name: 'p', runner: 'local', path: plain }), undefined)))!, /where the work goes next\.$/);
  assert.equal(await flowInstructions(flowPlaces(parseProject({ name: 'p', runner: 'local', path: projectWith({}) }), undefined)), null);
  const container = flowPlaces(parseProject({ name: 'c', runner: 'docker', container: 'box', pathInContainer: '/work' }), undefined, inBox(async (files) => new Map(files.map((f) => [f, { text: '{}' }]))));
  assert.match((await flowInstructions(container))!, /^The process is drawn in \/work\/\.ledung\/workflow\/flow\.json /);
});

test("a container project's files: one fixed script with the names as arguments; its answer splits by file", () => {
  // The names are never part of the script, so no name can change it, and the command line grows only by the names.
  assert.match(INSIDE_PROJECT_SCRIPT, /^mark=\$1; root=\$\(readlink -f -- "\$2"\)/);
  assert.match(INSIDE_PROJECT_SCRIPT, /for f in "\$@"; do/);
  assert.match(INSIDE_PROJECT_SCRIPT, /"\$root"\/\*\)/);
  const out = splitMarked('M 0 ok\n\uFEFF{"version":1}\nM 1 refused leads outside the project folder\nM 2 ok\n# a\n\nlast line', ['x', 'y', 'z', 'w'], 'M');
  assert.deepEqual([...out], [
    ['x', { text: '{"version":1}\n' }], ['y', { refused: 'y leads outside the project folder.' }], ['z', { text: '# a\n\nlast line' }], ['w', { missing: true }],
  ]);
  assert.deepEqual([...splitMarked('M - unreachable\n', ['x'], 'M')], [['x', { refused: "the project folder isn't in the container" }]]);
});

test('a BOM (PowerShell 5.1 writes one) is no part of the files', async () => {
  const dir = projectWith({ 'flow.json': '\uFEFF' + JSON.stringify({ version: 1, blocks: [block('a', { brief: 'b.md' })] }), 'b.md': '\uFEFF# B' });
  const view = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  assert.deepEqual(view.problems, []);
  assert.equal(view.texts['b.md'], '# B');
});

test('all texts together stay within 4 MB: past it a brief is refused, with the reason', async () => {
  const files: Record<string, string> = {};
  const blocks: ReturnType<typeof block>[] = [];
  for (let i = 0; i < 17; i++) {
    files[`b${i}.md`] = 'x'.repeat(250 * 1024);
    blocks.push(block(`b${i}`, { brief: `b${i}.md` }));
  }
  const chain = blocks.map((b, i) => (i + 1 < blocks.length ? { ...b, outcomes: [out(`b${i + 1}`)] } : b));
  const dir = projectWith({ ...files, 'flow.json': JSON.stringify({ version: 1, blocks: chain }) });
  const view = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  assert.equal(Object.keys(view.texts).length, 16);
  assert.deepEqual(view.problems.map((p) => p.at), ['b16.md']);
  assert.match(view.problems[0]!.message, /past the 4 MB/);
});

test("the rules and briefs are scanned for paths on one computer too, each file's first such line", async () => {
  const dir = projectWith({ 'flow.json': JSON.stringify({ version: 1, blocks: [block('a', { brief: 'b.md' })] }), 'b.md': '# B\nok\nOpen C:\\Users\\someone\\notes.txt\nand ~/x', 'rules.md': '- fine /workspace/app' });
  const view = await readFlowView('p', flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined));
  assert.deepEqual(view.problems.map((p) => p.at), ['b.md:3']);
  assert.match(view.problems[0]!.message, /"Open C:\\Users\\someone\\notes\.txt" looks like a path on one computer/);
});

test('review of #318: a long manager file path is not repeated in the instruction line (#322)', async () => {
  const long = `briefs/${'m'.repeat(70)}.md`;
  const dir = projectWith({ 'flow.json': JSON.stringify({ version: 1, manager: long, blocks: [block('a')] }), [long]: '# Manager' });
  const line = (await flowInstructions(flowPlaces(parseProject({ name: 'p', runner: 'local', path: dir }), undefined)))!;
  assert.match(line, /Your standing procedures between steps: the file its "manager" names there\.$/);
  assert.doesNotMatch(line, /mmmm/);
  // A manager's file that isn't there is not named (review of #322); the page says it is missing.
  const missing = projectWith({ 'flow.json': JSON.stringify({ version: 1, manager: 'manager.md', blocks: [block('a')] }) });
  assert.match((await flowInstructions(flowPlaces(parseProject({ name: 'p', runner: 'local', path: missing }), undefined)))!, /where the work goes next\.$/);
});

test('review of #322: "earlier" means every way from the start passes it; a check checks the work behind people and other checks', () => {
  const problems = (raw: Record<string, unknown>) => checkFlow(flowOf({ version: 1, ...raw }), () => true).filter((p) => !p.hint).map((p) => `${p.at}: ${p.message}`).join('\n');
  // Plan comes first and continues Build, reached only through Review's "Failed": on the first pass there is no Build session.
  assert.match(problems({
    start: 'plan',
    blocks: ways([block('plan', { runs: 'continue', continues: 'build' }), block('build', { runs: 'new-session' }), block('review', { kind: 'check', runs: 'new-session' }), block('p', { kind: 'person', ask: 'question' })],
      [['plan', 'build'], ['build', 'review'], ['review', 'plan', 'Failed'], ['review', 'p', 'Failed', 3]]),
  }), /blocks\.plan\.continues: "BUILD" doesn't come before "PLAN"/);
  // Build → a person → Review continuing Build: still the author reviewing their own work.
  assert.match(problems({
    blocks: ways([block('build', { runs: 'new-session' }), block('p', { kind: 'person', ask: 'question' }), block('review', { kind: 'check', runs: 'continue', continues: 'build' })], [['build', 'p'], ['p', 'review']]),
  }), /The check "REVIEW" would run in the session that did "BUILD"/);
  // A second check by the reviewer of the first is no review of its own work.
  assert.equal(problems({
    blocks: ways([block('build', { runs: 'new-session' }), block('cr', { kind: 'check', runs: 'new-session' }), block('sec', { kind: 'check', runs: 'continue', continues: 'cr' })], [['build', 'cr'], ['cr', 'sec']]),
  }), '');
});

test('#322 the schema: runs, continues, sub-steps and the manager file; roles are gone', () => {
  const flow = flowOf({
    version: 1, manager: 'manager.md',
    blocks: [
      block('build', { runs: 'new-session', substeps: [{ id: 'self-review', kind: 'check', title: 'Self-review', brief: 'briefs/reviewer.md', model: 'sonnet', when: 'done', outcomes: [{ word: 'Clean', to: 'done' }, { word: 'Findings', to: 'owner' }, { word: 'Findings', times: 3, to: 'ask-manager' }] }], outcomes: [out('fix')] }),
      block('fix', { runs: 'continue', continues: 'build' }),
    ],
  });
  assert.equal(flow.manager, 'manager.md');
  assert.equal(flow.blocks[0]!.substeps![0]!.outcomes![2]!.to, 'ask-manager');
  const bad = (raw: unknown) => parseFlow(JSON.stringify(raw)).problems.map((p) => `${p.at}: ${p.message}`);
  assert.match(bad({ version: 1, blocks: [block('a', { runs: 'worker' })] })[0]!, /^blocks\.a\.runs: is "manager", "person", "new-session" or "continue"/);
  assert.match(bad({ version: 1, blocks: [block('a', { substeps: [{ id: 's', kind: 'person', title: 'S' }] })] })[0]!, /^blocks\.a\.substeps\.s\.kind: is "work" or "check"/);
  assert.match(bad({ version: 1, blocks: [block('a', { substeps: [{ id: 's', kind: 'check', title: 'S', when: 'later' }] })] })[0]!, /^blocks\.a\.substeps\.s\.when: is "start", "done"/);
  assert.match(bad({ version: 1, blocks: [block('a', { substeps: [{ id: 's', kind: 'check', title: 'S', outcomes: [{ word: 'No', to: 'person' }] }] })] })[0]!, /^blocks\.a\.substeps\.s\.outcomes\.1\.to: is "done" \(the block goes on\), "owner"/);
  assert.match(bad({ version: 1, manager: '../manager.md', blocks: [block('a')] })[0]!, /^manager: is a path inside the workflow folder/);
  // 2b's role and roles are no fields any more: said, and left out.
  const old = parseFlow(JSON.stringify({ version: 1, roles: { manager: 'roles/manager.md' }, blocks: [block('a', { role: 'worker' })] }));
  assert.ok(old.flow);
  assert.deepEqual(old.problems.map((p) => p.at), ['roles', 'blocks.a.role']);
});

test("#322 sub-steps don't nest and own no session: said in words, and left out", () => {
  const parsed = parseFlow(JSON.stringify({
    version: 1,
    blocks: [block('a', { runs: 'new-session', substeps: [{ id: 's', kind: 'work', title: 'S', substeps: [{ id: 't', kind: 'check', title: 'T' }], runs: 'new-session', continues: 'a', profile: 'full' }] })],
  }));
  assert.ok(parsed.flow, 'the flow still reads');
  assert.deepEqual(parsed.problems.map((p) => p.at), ['blocks.a.substeps.s.substeps', 'blocks.a.substeps.s.runs', 'blocks.a.substeps.s.continues', 'blocks.a.substeps.s.profile']);
  assert.match(parsed.problems[0]!.message, /a subagent starts no subagents of its own, so sub-steps don't nest/);
  assert.match(parsed.problems[1]!.message, /owns no session/);
  assert.deepEqual(parsed.flow.blocks[0]!.substeps, [{ id: 's', kind: 'work', title: 'S' }]);
  // Unique within their block; their briefs exist; the same outcome twice is one too many.
  const flow = flowOf({ version: 1, blocks: [block('a', { runs: 'manager', substeps: [{ id: 's', kind: 'check', title: 'S', brief: 'briefs/x.md' }, { id: 's', kind: 'check', title: 'T', outcomes: [{ word: 'Done', to: 'done' }, { word: 'Done', to: 'report' }] }] })] });
  assert.deepEqual(checkFlow(flow, () => false).filter((p) => !p.hint).map((p) => p.at), ['blocks.a.substeps.s.brief', 'blocks.a.substeps.s', 'blocks.a.substeps.s.outcomes']);
  // Back to the block's one for ever, unless a count of the same word ends it (#1185).
  const round = (outcomes: unknown[]) => checkFlow(flowOf({ version: 1, blocks: [block('a', { runs: 'manager', substeps: [{ id: 's', kind: 'check', title: 'S', outcomes }] })] }), () => true).filter((p) => !p.hint).map((p) => p.message);
  assert.match(round([{ word: 'Findings', to: 'owner' }]).join('\n'), /"S" can go round for ever on "Findings"/);
  assert.deepEqual(round([{ word: 'Findings', to: 'owner' }, { word: 'Findings', times: 3, to: 'report' }]), []);
  // A manager block may have sub-steps; a person's or one nobody runs may not.
  const owners = (more: Record<string, unknown>) => checkFlow(flowOf({ version: 1, blocks: [block('a', { ...more, substeps: [{ id: 's', kind: 'check', title: 'S' }] })] }), () => true).filter((p) => !p.hint).map((p) => p.message);
  assert.deepEqual(owners({ runs: 'manager' }), []);
  assert.deepEqual(owners({ runs: 'new-session' }), []);
  assert.match(owners({ kind: 'person', ask: 'question' }).join('\n'), /A person starts no subagents/);
  assert.match(owners({}).join('\n'), /Sub-steps are subagents of the one who runs "A": say who/);
});

test('#322 continue points at an earlier block on the way here that runs as a session', () => {
  const problems = (blocks: Record<string, unknown>[], list: [string, string, string?, number?][]) => checkFlow(flowOf({ version: 1, blocks: ways(blocks, list) }), () => true).filter((p) => !p.hint).map((p) => `${p.at}: ${p.message}`);
  const way: [string, string, string?, number?][] = [['build', 'review'], ['fix', 'review'], ['review', 'fix', 'Failed'], ['review', 'ask', 'Failed', 3]];
  const review = block('review', { kind: 'check', runs: 'new-session' });
  const ask = block('ask', { kind: 'person', ask: 'question' });
  // Fix continues Build: Build comes first (Build → Review → "Failed" → Fix) and runs as a session.
  assert.deepEqual(problems([block('build', { runs: 'new-session' }), review, block('fix', { runs: 'continue', continues: 'build' }), ask], way), []);
  // A session three deep still is one: Fix-again continues Fix, which continues Build.
  assert.deepEqual(problems([block('build', { runs: 'new-session' }), review, block('fix', { runs: 'continue', continues: 'build' }), block('again', { runs: 'continue', continues: 'fix' }), ask], [...way, ['fix', 'again', 'Stuck']]), []);
  // Not a session: the manager's or a person's block.
  assert.match(problems([block('build', { runs: 'manager' }), review, block('fix', { runs: 'continue', continues: 'build' }), ask], way).join('\n'), /fix\.continues: "BUILD" runs as the manager, not as a session/);
  // Not earlier: work gets here without passing it.
  const later = problems([block('build', { runs: 'new-session' }), review, block('fix', { runs: 'continue', continues: 'merge' }), ask, block('merge', { runs: 'new-session' })], [...way, ['review', 'merge', 'Approved']]);
  assert.match(later.join('\n'), /blocks\.fix\.continues: "MERGE" doesn't come before "FIX"/);
  // Its own, nobody's, one that isn't there; and "continues" without "runs": "continue", or the other way round.
  assert.match(problems([block('a', { runs: 'continue', continues: 'a' })], []).join('\n'), /can't continue its own session/);
  assert.match(problems([block('a', { runs: 'continue', continues: 'ghost' })], []).join('\n'), /continues "ghost", which is not a block/);
  assert.match(problems([block('a', { runs: 'continue' })], []).join('\n'), /blocks\.a\.continues: "A" continues a session: say whose/);
  assert.match(problems([block('a', { runs: 'new-session' }), block('b', { runs: 'manager', continues: 'a' })], [['a', 'b']]).join('\n'), /blocks\.b\.continues: "continues" is for a block that runs as "continue"/);
  // Sessions that only continue each other start nowhere.
  assert.match(problems([block('a', { runs: 'continue', continues: 'b' }), block('b', { runs: 'continue', continues: 'a' }), ask], [['a', 'b'], ['b', 'ask'], ['ask', 'a']]).join('\n'), /continues sessions that only continue each other/);
  // Who runs what kind: a person block is a person's, a fork nobody's.
  assert.match(problems([block('p', { kind: 'person', ask: 'review', runs: 'new-session' })], []).join('\n'), /blocks\.p\.runs: A person block is a person's/);
  assert.match(problems([block('f', { kind: 'fork', runs: 'manager' })], []).join('\n'), /blocks\.f\.runs: A fork only splits or joins the work/);
});

test("#322 a check can't continue the session of work it checks; a check sub-step inside that work is fine", () => {
  const flow = (reviewRuns: Record<string, unknown>, buildMore: Record<string, unknown> = {}) => flowOf({
    version: 1,
    blocks: ways([
      block('build', { runs: 'new-session', ...buildMore }),
      block('review', { kind: 'check', ...reviewRuns }),
      block('fix', { runs: 'continue', continues: 'build' }),
      block('ask', { kind: 'person', ask: 'question' }),
    ], [['build', 'review'], ['fix', 'review'], ['review', 'fix', 'Failed'], ['review', 'ask', 'Failed', 3]]),
  });
  const of = (f: Flow) => checkFlow(f, () => true).filter((p) => !p.hint).map((p) => `${p.at}: ${p.message}`);
  // Review continuing Build's session would review its own work (Build's, and Fix's, the same session): an error.
  const own = of(flow({ runs: 'continue', continues: 'build' }));
  assert.equal(own.length, 1);
  assert.match(own[0]!, /^blocks\.review\.continues: The check "REVIEW" would run in the session that did "BUILD" and "FIX", the work it checks/);
  assert.match(own[0]!, /make it a check sub-step of that block/);
  // A new session of its own is the way.
  assert.deepEqual(of(flow({ runs: 'new-session' })), []);
  // The author looking over their own work as a check sub-step is allowed: no problem.
  assert.deepEqual(of(flow({ runs: 'new-session' }, { substeps: [{ id: 'self-review', kind: 'check', title: 'Self-review', when: 'done' }] })), []);
});

test('#1184 outcomes: the same word and count twice is a problem; a block leading nowhere, a lone count and a session with no brief are hints', () => {
  const all = (raw: Record<string, unknown>) => checkFlow(flowOf({ version: 1, ...raw }), () => true);
  const twice = all({ blocks: [block('a', { outcomes: [out('b', 'Failed', 3), out('b', 'Failed', 3), out('b', 'Failed')] }), block('b')] });
  assert.deepEqual(twice.map((p) => [p.at, !!p.hint]), [['blocks.a.outcomes', false]]);
  assert.match(twice[0]!.message, /Two outcomes of "A" are "Failed \(3rd time\)"/);
  // The same word with another count, or a plain one beside a counted one, is fine.
  assert.deepEqual(all({ blocks: [block('a', { outcomes: [out('b', 'Failed'), out('b', 'Failed', 2), out('b', 'Failed', 3)] }), block('b')] }), []);
  // Only a count: where do the other times go?
  const lone = all({ blocks: [block('a', { outcomes: [out('b', 'Failed', 3)] }), block('b')] });
  assert.deepEqual(lone.map((p) => [p.at, !!p.hint]), [['blocks.a.outcomes', true]]);
  assert.match(lone[0]!.message, /says only where "Failed \(3rd time\)" goes: say with a plain "Failed" where the other times go/);
  // One block with no outcomes is the end; two, and each gets a hint.
  assert.deepEqual(all({ blocks: [block('a', { outcomes: [out('b')] }), block('b')] }), []);
  const ends = all({ blocks: [block('a', { outcomes: [out('b'), out('c', 'Other')] }), block('b'), block('c')] });
  assert.deepEqual(ends.map((p) => [p.at, !!p.hint]), [['blocks.b.outcomes', true], ['blocks.c.outcomes', true]]);
  assert.match(ends[0]!.message, /^Where does "B" go next\?/);
  // A session with no brief: a hint.
  const briefless = all({ blocks: [block('a', { runs: 'new-session' })] });
  assert.deepEqual(briefless.map((p) => [p.at, !!p.hint]), [['blocks.a.brief', true]]);
  assert.match(briefless[0]!.message, /runs as a session but has no brief/);
});

test('#1184 the old arrows, pass and fail are said and left out: the flow still draws', () => {
  const parsed = parseFlow(JSON.stringify({
    version: 1,
    blocks: [block('a', { pass: 'Approved', fail: { to: 'a', rounds: 2 }, substeps: [{ id: 's', kind: 'check', title: 'S', pass: 'Ok', fail: { rounds: 1 } }] })],
    arrows: [{ from: 'a', to: 'a' }],
  }));
  assert.ok(parsed.flow);
  assert.deepEqual(parsed.problems.map((p) => p.at), ['arrows', 'blocks.a.pass', 'blocks.a.fail', 'blocks.a.substeps.s.pass', 'blocks.a.substeps.s.fail']);
  assert.match(parsed.problems[0]!.message, /^was the list of arrows, and arrows are now each block's outcomes \(question #1184\)/);
  assert.match(parsed.problems[2]!.message, /"times": 3/);
  assert.equal('pass' in parsed.flow.blocks[0]!, false);
});

test('locks are gone (Simon, 2026-10-26, question #1183): an old "lock" reads as a field this Ledung doesn\'t know, and the flow still draws', () => {
  const parsed = parseFlow(JSON.stringify({ version: 1, blocks: [block('a', { kind: 'person', ask: 'review', lock: true })] }));
  assert.ok(parsed.flow);
  assert.deepEqual(parsed.problems.map((p) => p.at), ['blocks.a.lock']);
  assert.match(parsed.problems[0]!.message, /^was a lock, and locks are gone \(question #1183\).*Take it out of flow\.json/);
  assert.equal('lock' in parsed.flow.blocks[0]!, false);
});

test('review of #1184: a count back to the same block ends nothing; a sub-step count back to its owner neither; a "no" through other work is still checked work', () => {
  const faults = (raw: Record<string, unknown>) => checkFlow(flowOf({ version: 1, ...raw }), () => true).filter((p) => !p.hint).map((p) => `${p.at}: ${p.message}`).join('\n');
  // "Failed → Build" and "Failed, the 3rd time → Build": round for ever.
  assert.match(faults({ blocks: ways([block('build'), block('rev', { kind: 'check' })], [['build', 'rev', 'Done'], ['rev', 'build', 'Failed'], ['rev', 'build', 'Failed', 3]]) }), /BUILD → REV can go round for ever|REV → BUILD can go round for ever/);
  // A sub-step whose count also sends it back to the owner.
  const sub = (outcomes: unknown[]) => faults({ blocks: [block('a', { runs: 'manager', substeps: [{ id: 's', kind: 'check', title: 'S', outcomes }] })] });
  assert.match(sub([{ word: 'F', to: 'owner' }, { word: 'F', times: 2, to: 'owner' }]), /"S" can go round for ever on "F"/);
  assert.equal(sub([{ word: 'F', to: 'owner' }, { word: 'F', times: 2, to: 'report' }]), '');
  // Write → Lint → Review, Review continuing Write's session and sending "Changes" back to Write: its own work.
  assert.match(faults({
    blocks: ways([block('w', { runs: 'new-session' }), block('lint', { runs: 'manager' }), block('rev', { kind: 'check', runs: 'continue', continues: 'w' }), block('p', { kind: 'person', ask: 'question' })],
      [['w', 'lint'], ['lint', 'rev'], ['rev', 'w', 'Changes'], ['rev', 'p', 'Changes', 3]]),
  }), /The check "REV" would run in the session that did "W"/);
});
