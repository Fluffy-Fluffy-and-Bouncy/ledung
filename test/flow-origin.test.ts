// A workflow copy's origin and version (docs/steps/workflow-origin.md, approved by Simon 2026-11-09, question #1732):
// the hash, the origin block and its checks, the remote without secrets, what a split-off records (the credit chain
// included), "has changed since", "Record where this came from", and a proposal that can't change the origin.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../src/config.ts';
import { checkFlow, parseFlow } from '../src/shared/flow-check.ts';
import { chainAfter, cleanRemote, EARLIER_MAX, firstAuthor, ownCredit, repoKey } from '../src/shared/flow-origin.ts';
import type { FlowOrigin } from '../src/shared/flow.ts';
import { flowPlaces, readFlowView, workflowPlace } from '../src/sessions/flow-files.ts';
import { originalOf, originInfo, originOf, remoteOf, today, workflowHash } from '../src/sessions/flow-origin.ts';
import { buildProposal, keepOrigin } from '../src/sessions/flow-propose.ts';
import { withOrigin, workspaceFromView, workspaceWrites } from '../web/src/flowEdit.ts';
import { removeTemp } from './temp.ts';

const temps: string[] = [];
after(() => temps.forEach(removeTemp));

const BLOCKS = [{ id: 'a', kind: 'work', title: 'A', runs: 'new-session', brief: 'briefs/a.md' }];
const flowJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, title: 'Team process', ...extra, blocks: BLOCKS }, null, 2);

/** A folder with .ledung/workflow made of `files`, and optionally a git config with `remote`. */
function folderWith(files: Record<string, string>, remote?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-origin-'));
  temps.push(dir);
  for (const [f, t] of Object.entries(files)) {
    const at = path.join(dir, '.ledung', 'workflow', ...f.split('/'));
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, t);
  }
  if (remote !== undefined) {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://example.com/other.git\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  }
  return dir;
}

const workflowConfig = (name: string, folder: string) => ({ name, folder, managerFile: 'm.md', sessionFile: 's.md', projectConfig: 'p.json' });

test('the hash: the same for re-indented, reordered and CRLF files and with an origin added, another for a changed brief', async () => {
  const one = folderWith({ 'flow.json': flowJson({ author: 'Ana' }), 'briefs/a.md': '# A\nDo it.\n', 'rules.md': '# R' });
  const two = folderWith({
    'flow.json': JSON.stringify({ blocks: BLOCKS, author: 'Ana', title: 'Team process', version: 1, origin: { workflow: 'x', title: 'X', hash: 'sha256:000000000000', copiedAt: '2026-11-09' } }),
    'briefs/a.md': '\uFEFF# A\r\nDo it.\r\n', 'rules.md': '# R\n\n',
  });
  const view = (dir: string) => readFlowView('p', [workflowPlace(workflowConfig('team', dir))]);
  const h1 = workflowHash(await view(one));
  assert.match(h1!, /^sha256:[0-9a-f]{12}$/);
  assert.equal(workflowHash(await view(two)), h1);
  fs.writeFileSync(path.join(one, '.ledung', 'workflow', 'briefs', 'a.md'), '# A\nDo it twice.\n');
  assert.notEqual(workflowHash(await view(one)), h1);
  // An empty rules.md is none.
  const three = folderWith({ 'flow.json': flowJson({ author: 'Ana' }), 'briefs/a.md': '# A\nDo it.\n', 'rules.md': '# R' });
  const withEmpty = await view(three);
  assert.equal(workflowHash({ ...withEmpty, texts: { ...withEmpty.texts, 'briefs/empty.md': ' \n' } }), workflowHash(withEmpty));
});

test('the origin: checked apart, left out with its problems when wrong, only in flow.json, and never a path', () => {
  const good: FlowOrigin = { workflow: 'team', title: 'Team process', repo: 'https://github.com/example/team', release: 3, hash: 'sha256:1a2b3c4d5e6f', author: 'Ana (ana)', copiedAt: '2026-11-09', earlier: [{ title: 'Review loop', release: 7, author: 'Bo (bo)' }] };
  const read = parseFlow(flowJson({ release: 2, origin: good }));
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.flow!.origin, good);
  assert.equal(read.flow!.release, 2);
  // A wrong origin keeps the flow readable: it is left out, said where.
  for (const [origin, at] of [
    [{ ...good, hash: 'abc' }, 'origin.hash'],
    [{ ...good, copiedAt: undefined }, 'origin'],
    [{ ...good, adopted: '2026-11-09' }, 'origin'],
    [{ ...good, hash: undefined }, 'origin.hash'],
    [{ ...good, earlier: Array.from({ length: EARLIER_MAX + 1 }, () => ({ title: 'T' })) }, 'origin.earlier'],
  ] as const) {
    const p = parseFlow(flowJson({ origin }));
    assert.ok(p.flow, JSON.stringify(origin));
    assert.equal(p.flow!.origin, undefined);
    assert.ok(p.problems.some((x) => x.at === at && /the origin is left out/.test(x.message)), `${at}: ${JSON.stringify(p.problems)}`);
  }
  // Adopted without a version is fine.
  assert.deepEqual(parseFlow(flowJson({ origin: { workflow: 'team', title: 'T', adopted: '2026-11-09' } })).problems, []);
  // A field it doesn't know, in the origin and in a link.
  const typo = parseFlow(flowJson({ origin: { ...good, folder: 'x', earlier: [{ title: 'T', path: 'y' }] } }));
  assert.deepEqual(typo.problems.map((p) => p.at).sort(), ['origin.earlier.1.path', 'origin.folder']);
  // Only the default flow carries one, and a release.
  const other = parseFlow(flowJson({ origin: good, release: 3 }), 'flows/extra.json');
  assert.equal(other.flow!.origin, undefined);
  assert.equal(other.flow!.release, undefined);
  assert.deepEqual(other.problems.map((p) => p.at).sort(), ['origin', 'release']);
  // No path on one computer anywhere in it (section 6).
  const leaky = parseFlow(flowJson({ origin: { ...good, repo: 'C:\\repos\\team', earlier: [{ title: 'From /home/ana/flows' }] } })).flow!;
  const at = checkFlow(leaky, () => true).filter((p) => /path on one computer/.test(p.message)).map((p) => p.at).sort();
  assert.deepEqual(at, ['origin.earlier.1.title', 'origin.repo']);
  assert.equal(parseFlow(flowJson({ release: 0 })).flow, null);
});

test('the remote: no user, password, token, query or folder; https and ssh forms of one repository match', () => {
  assert.equal(cleanRemote('https://ana:ghp_secret@github.com/example/team.git?x=1#y'), 'https://github.com/example/team.git');
  assert.equal(cleanRemote('https://oauth2:tok@gitlab.example.com:8443/group/team/'), 'https://gitlab.example.com:8443/group/team');
  assert.equal(cleanRemote('git@github.com:example/team.git'), 'git@github.com:example/team.git');
  assert.equal(cleanRemote('deploy@host.example:example/team.git'), 'host.example:example/team.git');
  assert.equal(cleanRemote('ssh://git@host.example/srv/team.git'), 'ssh://host.example/srv/team.git');
  for (const local of ['C:/repos/team', 'C:\\repos\\team', '/home/ana/team', '../team', 'file:///srv/team', '\\\\server\\share\\team', 'host:/abs/path', '']) {
    assert.equal(cleanRemote(local), undefined, local);
  }
  assert.equal(repoKey('https://github.com/Example/Team.git'), repoKey('git@github.com:example/team'));
  assert.equal(repoKey('ssh://git@github.com:22/example/team.git/'), 'github.com/example/team');
  assert.notEqual(repoKey('https://github.com/example/team'), repoKey('https://github.com/example/other'));
});

test("the remote is read from the folder's git config, a worktree's too, and is cleaned", () => {
  const dir = folderWith({ 'flow.json': flowJson() }, 'https://ana:secret@github.com/example/team.git');
  assert.equal(remoteOf(dir), 'https://github.com/example/team.git');
  // A folder inside the repository.
  fs.mkdirSync(path.join(dir, 'process'));
  assert.equal(remoteOf(path.join(dir, 'process')), 'https://github.com/example/team.git');
  // A worktree: .git is a file, and commondir leads to the shared config.
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-origin-wt-'));
  temps.push(wt);
  const gitdir = path.join(dir, '.git', 'worktrees', 'w');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  assert.equal(remoteOf(wt), 'https://github.com/example/team.git');
  // "origin" a folder: the next remote fit to write (the fixture's "upstream"), never the folder.
  const local = folderWith({ 'flow.json': flowJson() }, 'C:/repos/team');
  assert.equal(remoteOf(local), 'https://example.com/other.git');
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-origin-none-'));
  temps.push(none);
  fs.mkdirSync(path.join(none, '.git'));
  fs.writeFileSync(path.join(none, '.git', 'config'), '[remote "origin"]\n\turl = C:/repos/team\n');
  assert.equal(remoteOf(none), undefined);
});

test('the chain: a copy of a copy names the first author, and keeps the first and the latest links', () => {
  const origin: FlowOrigin = { workflow: 'mid', title: 'Mid', author: 'Cy', hash: 'sha256:111111111111', copiedAt: '2026-11-01', earlier: [{ title: 'First', author: 'Ana' }] };
  assert.deepEqual(chainAfter(origin), [{ title: 'First', author: 'Ana' }, { title: 'Mid', author: 'Cy', hash: 'sha256:111111111111' }]);
  assert.equal(firstAuthor(origin), 'Ana');
  assert.equal(firstAuthor({ ...origin, earlier: undefined }), 'Cy');
  assert.equal(chainAfter(undefined), undefined);
  const long = { ...origin, earlier: Array.from({ length: EARLIER_MAX }, (_, i) => ({ title: `T${i}` })) };
  const chain = chainAfter(long)!;
  assert.equal(chain.length, EARLIER_MAX);
  assert.equal(chain[0]!.title, 'T0');
  assert.equal(chain.at(-1)!.title, 'Mid');
  assert.deepEqual(ownCredit({ author: 'Ana', release: 3 }, { title: 'T', author: 'Ana', release: 3 }), {});
  assert.deepEqual(ownCredit({ author: 'Me', release: 1 }, { title: 'T', author: 'Ana', release: 3 }), { author: 'Me', release: 1 });
});

/** A shared workflow (a git repository with a remote) and a project following it, as the manager reads them. */
function sharedSetup(shared: Record<string, string>, own: Record<string, string>, remote = 'https://token@github.com/example/team.git') {
  const folder = folderWith(shared, remote);
  const dir = folderWith(own);
  const workflow = workflowConfig('team', folder);
  const project = parseProject({ name: 'shop', runner: 'local', path: dir, workflow: { name: 'team' } });
  const places = () => flowPlaces(project, workflow);
  const known = [{ name: 'team', folder, place: workflowPlace(workflow) }];
  const info = async (dismissed = false) => {
    const view = await readFlowView('shop', places());
    return { view, ...(await originInfo(view, places(), known, { dismissed, now: new Date(2026, 10, 9) })) };
  };
  return { folder, dir, places, info };
}

test('a split-off records the origin, moves the author and release into it, writes no path, and is not "different"', async () => {
  const s = sharedSetup({ 'flow.json': flowJson({ author: 'Ana (ana)', release: 3 }), 'briefs/a.md': '# A' }, {});
  const { view, splitOff } = await s.info();
  assert.equal(view.source?.kind, 'workflow');
  assert.deepEqual(splitOff, { workflow: 'team', title: 'Team process', repo: 'https://github.com/example/team.git', release: 3, hash: workflowHash(view)!, author: 'Ana (ana)', copiedAt: '2026-11-09' });
  // The builder's save of the copy, as the page makes it.
  const ws = workspaceFromView(view)!;
  const writes = workspaceWrites(withOrigin(ws, splitOff!));
  const flow = writes.find((w) => w.path === 'flow.json')!;
  const written = JSON.parse(flow.text!);
  assert.deepEqual(written.origin, splitOff);
  assert.equal('author' in written, false);
  assert.equal('release' in written, false);
  // With the credit at the top, not after the blocks.
  assert.deepEqual(Object.keys(written), ['version', 'title', 'origin', 'blocks']);
  for (const form of [s.folder, JSON.stringify(s.folder).slice(1, -1), s.folder.split(path.sep).join('/')]) assert.equal(flow.text!.includes(form), false, form);
  assert.doesNotMatch(flow.text!, /token/);
  for (const w of writes) fs.mkdirSync(path.dirname(path.join(s.dir, '.ledung', 'workflow', w.path)), { recursive: true });
  for (const w of writes) fs.writeFileSync(path.join(s.dir, '.ledung', 'workflow', w.path), w.text!);
  const after = await s.info();
  assert.equal(after.view.source?.kind, 'project');
  assert.deepEqual(after.view.flow?.origin, splitOff);
  assert.deepEqual(after.view.shared, { workflow: 'team', differs: false });
  assert.deepEqual(after.original, { workflow: 'team', title: 'Team process', release: 3, changed: false });
  assert.equal(after.adopt, undefined, 'a copy with an origin is offered nothing');
  assert.equal(after.splitOff, undefined);
  // The original changes a brief and raises its release: the copy is told, and stays as it is.
  fs.writeFileSync(path.join(s.folder, '.ledung', 'workflow', 'briefs', 'a.md'), '# A, better');
  fs.writeFileSync(path.join(s.folder, '.ledung', 'workflow', 'flow.json'), flowJson({ author: 'Ana (ana)', release: 4 }));
  assert.deepEqual((await s.info()).original, { workflow: 'team', title: 'Team process', release: 4, changed: true });
});

test('the original is found by its remote when it goes by another name here, and a copy of a copy names the first author', async () => {
  const first: FlowOrigin = { workflow: 'base', title: 'Base process', author: 'Ana (ana)', release: 1, hash: 'sha256:aaaaaaaaaaaa', copiedAt: '2026-11-01' };
  const s = sharedSetup({ 'flow.json': flowJson({ author: 'Cy (cy)', origin: first }), 'briefs/a.md': '# A' }, {});
  const { splitOff } = await s.info();
  assert.deepEqual(splitOff!.earlier, [{ title: 'Base process', release: 1, hash: 'sha256:aaaaaaaaaaaa', author: 'Ana (ana)' }]);
  assert.equal(firstAuthor(splitOff!), 'Ana (ana)');
  assert.equal(splitOff!.author, 'Cy (cy)');
  // Recorded under another name on another computer: found by the remote.
  const view = await readFlowView('shop', s.places());
  const copy = { ...view, source: { kind: 'project' as const, folder: '/elsewhere' }, flow: { ...view.flow!, origin: { ...splitOff!, workflow: 'renamed' } } };
  const known = [{ name: 'team', folder: s.folder, place: workflowPlace(workflowConfig('team', s.folder)) }];
  assert.deepEqual((await originInfo(copy, [], known, { dismissed: false })).original, { workflow: 'team', title: 'Team process', changed: false });
  // Neither the remote nor the name here: nothing said.
  const lost = { ...copy, flow: { ...copy.flow, origin: { ...splitOff!, workflow: 'gone', repo: 'https://github.com/example/gone' } } };
  assert.equal((await originInfo(lost, [], known, { dismissed: false })).original, undefined);
});

test('"Record where this came from": the full origin when the copy is the same, no version when it differs, nothing once dismissed', async () => {
  const shared = { 'flow.json': flowJson({ author: 'Ana (ana)', release: 2 }), 'briefs/a.md': '# A' };
  const same = sharedSetup(shared, { ...shared });
  const one = await same.info();
  assert.deepEqual(one.adopt, { workflow: 'team', title: 'Team process', repo: 'https://github.com/example/team.git', release: 2, hash: workflowHash((await readFlowView('p', [workflowPlace(workflowConfig('team', same.folder))])))!, author: 'Ana (ana)', adopted: '2026-11-09' });
  assert.equal((await same.info(true)).adopt, undefined);
  // Recording it: only flow.json is written, the author moves into the origin.
  const writes = workspaceWrites(withOrigin(workspaceFromView(one.view)!, one.adopt!));
  assert.deepEqual(writes.map((w) => w.path), ['flow.json']);
  assert.equal(writes[0]!.base, one.view.versions['flow.json']);
  assert.equal('author' in JSON.parse(writes[0]!.text!), false);
  const differs = sharedSetup(shared, { ...shared, 'briefs/a.md': '# A, mine' });
  const two = await differs.info();
  assert.equal(two.view.shared?.differs, true);
  assert.deepEqual(two.adopt, { workflow: 'team', title: 'Team process', repo: 'https://github.com/example/team.git', author: 'Ana (ana)', adopted: '2026-11-09' });
  assert.equal(two.original, undefined);
});

test('a proposal gets the recorded origin back when it leaves it out or changes it, and never adds one', () => {
  const origin = { workflow: 'team', title: 'Team process', hash: 'sha256:1a2b3c4d5e6f', copiedAt: '2026-11-09' };
  const current = flowJson({ origin });
  const dropped = JSON.stringify({ version: 1, title: 'Team process', blocks: BLOCKS });
  const back = keepOrigin(current, dropped);
  assert.equal(back.kept, true);
  assert.deepEqual(JSON.parse(back.text).origin, origin);
  assert.deepEqual(Object.keys(JSON.parse(back.text)), ['version', 'title', 'origin', 'blocks']);
  const changed = keepOrigin(current, flowJson({ origin: { ...origin, title: 'Mine now' } }));
  assert.equal(changed.kept, true);
  assert.deepEqual(JSON.parse(changed.text).origin, origin);
  // Unchanged (key order aside): the text as given.
  const same = JSON.stringify({ origin: { copiedAt: '2026-11-09', hash: 'sha256:1a2b3c4d5e6f', title: 'Team process', workflow: 'team' }, version: 1, blocks: BLOCKS });
  assert.deepEqual(keepOrigin(current, same), { text: same, kept: false });
  // A copy without one gets none from a proposal.
  const added = keepOrigin(flowJson(), flowJson({ origin }));
  assert.equal(added.kept, true);
  assert.equal('origin' in JSON.parse(added.text), false);
  // Not JSON: as given, for the checks to say.
  assert.deepEqual(keepOrigin(current, '{ nope'), { text: '{ nope', kept: false });
});

test('today is the local day, and originOf gives nothing for a view without a flow', async () => {
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  const dir = folderWith({ 'flow.json': '{ nope' });
  const view = await readFlowView('p', [workflowPlace(workflowConfig('team', dir))]);
  assert.equal(originOf(view, 'team', undefined, '2026-11-09'), undefined);
});

test('the original: by remote and name among workflows in one repository, never one of the same name from another, never itself', () => {
  const w = (name: string, folder = `/w/${name}`) => ({ name, folder, place: { kind: 'workflow' as const, folder: `${folder}/.ledung/workflow`, workflow: name, read: async () => new Map(), list: async () => [] } });
  const remotes: Record<string, string | undefined> = { '/w/team': 'https://github.com/acme/flows.git', '/w/review': 'git@github.com:acme/flows', '/w/solo': 'https://github.com/acme/solo', '/w/local': undefined };
  const remote = (x: { folder: string }) => remotes[x.folder];
  const all = [w('team'), w('review'), w('solo'), w('local')];
  const project = { source: { kind: 'project' as const, folder: '/p/.ledung/workflow' } };
  const o = (workflow: string, repo?: string): FlowOrigin => ({ workflow, title: 'T', hash: 'sha256:000000000000', copiedAt: '2026-11-09', ...(repo ? { repo } : {}) });
  // Two workflows in one repository: the one of the origin's name.
  assert.equal(originalOf(o('review', 'https://github.com/acme/flows'), project, all, remote)?.name, 'review');
  assert.equal(originalOf(o('team', 'https://github.com/acme/flows'), project, all, remote)?.name, 'team');
  // Renamed here, and its repository holds two: which one can't be told, so none.
  assert.equal(originalOf(o('renamed', 'https://github.com/acme/flows'), project, all, remote), undefined);
  // Renamed here, alone in its repository: that one.
  assert.equal(originalOf(o('renamed', 'https://github.com/acme/solo.git'), project, all, remote)?.name, 'solo');
  // The same name from another repository is not it; a workflow of that name with no remote may be.
  assert.equal(originalOf(o('solo', 'https://github.com/someone/else'), project, all, remote), undefined);
  assert.equal(originalOf(o('local', 'https://github.com/someone/else'), project, all, remote)?.name, 'local');
  assert.equal(originalOf(o('solo'), project, all, remote)?.name, 'solo');
  // A shared workflow that is a copy and kept its name is never compared with itself.
  const itself = { source: { kind: 'workflow' as const, folder: 'C:/elsewhere', workflow: 'solo' } };
  assert.equal(originalOf(o('solo', 'https://github.com/acme/solo'), itself, all, remote), undefined);
});

test("the remote: a comment after it, names in any case, another remote when origin's is a folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-origin-git-'));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, '.git'));
  const config = (text: string) => fs.writeFileSync(path.join(dir, '.git', 'config'), text);
  config('[Remote "origin"]\n\tURL = https://github.com/o/r.git # the old one\n');
  assert.equal(remoteOf(dir), 'https://github.com/o/r.git');
  config('[remote "origin"]\n\turl = "https://github.com/o/r.git" ; quoted\n');
  assert.equal(remoteOf(dir), 'https://github.com/o/r.git');
  config('[remote "origin"]\n\turl = C:/repos/r\n[remote "github"]\n\turl = git@github.com:o/r.git\n');
  assert.equal(remoteOf(dir), 'git@github.com:o/r.git');
  // Remotes and keys within what the checks take.
  assert.equal(cleanRemote(`https://github.com/${'a'.repeat(300)}`), undefined);
  assert.notEqual(repoKey('git@host.example:2024/repo'), repoKey('https://host.example/repo'));
  assert.equal(repoKey('ssh://git@host.example:2222/o/r.git'), 'host.example/o/r');
});

test("an older copy whose version is not known still moves the original's release out when it is recorded", async () => {
  const shared = { 'flow.json': flowJson({ author: 'Ana (ana)', release: 2 }), 'briefs/a.md': '# A' };
  const s = sharedSetup(shared, { ...shared, 'briefs/a.md': '# A, mine' });
  const { view, adopt, adoptFrom } = await s.info();
  assert.equal(adopt?.release, undefined);
  assert.deepEqual(adoptFrom, { author: 'Ana (ana)', release: 2 });
  const written = JSON.parse(workspaceWrites(withOrigin(workspaceFromView(view)!, adopt!, adoptFrom))[0]!.text!);
  assert.equal('release' in written, false);
  assert.equal('author' in written, false);
});

test('flow_propose: a proposal that drops the origin gets it back and says so; one that only drops it proposes nothing', async () => {
  const origin = { workflow: 'team', title: 'Team process', hash: 'sha256:1a2b3c4d5e6f', copiedAt: '2026-11-09' };
  const dir = folderWith({ 'flow.json': flowJson({ origin }), 'briefs/a.md': '# A' });
  const project = parseProject({ name: 'shop', runner: 'local', path: dir });
  const view = await readFlowView('shop', flowPlaces(project, undefined));
  const changed = JSON.stringify({ version: 1, title: 'Team process', blocks: [{ ...BLOCKS[0], title: 'Build it' }] }, null, 2);
  const p = await buildProposal(view, [{ file: 'flow.json', text: changed }], 'Rename the block');
  assert.equal(p.originKept, true);
  const written = JSON.parse(p.writes[0]!.text!);
  assert.deepEqual(written.origin, origin);
  assert.equal(written.blocks[0].title, 'Build it');
  const dropped = JSON.stringify({ version: 1, title: 'Team process', blocks: BLOCKS });
  await assert.rejects(buildProposal(view, [{ file: 'flow.json', text: dropped }], 'Drop the origin'), /a proposal can't change it/);
  const untouched = await buildProposal(view, [{ file: 'briefs/a.md', text: '# A, better' }], 'Better brief');
  assert.equal(untouched.originKept, undefined);
});
