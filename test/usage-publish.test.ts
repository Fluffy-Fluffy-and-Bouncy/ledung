// Publishing usage to a shared repo (issue #363): what the file holds and never holds, the labels and the
// fingerprint, and publishing, reading and cleaning up against a fake GitHub that keeps refs, trees and commits.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { parseProject } from '../src/config.ts';
import type { Http } from '../src/board/github.ts';
import { accountFingerprint, normaliseRemote, otherLabel } from '../src/usage/publish-file.ts';
import { usageMark, usageSlices } from '../src/usage/publish-source.ts';
import { parseUsageBranch, usageBranch, UsageRepo } from '../src/usage/publish-github.ts';
import { publisherProjects, UsagePublisher, USAGE_KEY_FILE, type PublisherProject } from '../src/usage/publisher.ts';
import { PUBLISHED_USAGE_VERSION, readPublishedUsage, type PublishedUsage } from '../src/shared/published-usage.ts';
import type { UsageRecord } from '../src/usage/recorder.ts';

const REPO = 'acme/usage';
const DAY = 24 * 60 * 60 * 1000;

/** GitHub's Git data and refs calls as far as publishing and reading use them, in memory. */
function fakeGitHub(opts: { login?: string; empty?: boolean; canWrite?: boolean; repo?: string } = {}) {
  const name = opts.repo ?? REPO;
  const escaped = name.replace('/', '\\/');
  const refs = new Map<string, string>();
  const trees = new Map<string, string>();
  const commits = new Map<string, string>();
  const calls: string[] = [];
  const state = { empty: opts.empty ?? false, fail: 0, failFiles: 0, signedOut: false, refuseDelete: false, canWrite: opts.canWrite ?? true };
  const sha = () => crypto.randomBytes(20).toString('hex');
  const ok = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, body, headers });
  const listTag = () => `"${crypto.createHash('sha1').update(JSON.stringify([...refs].sort())).digest('hex')}"`;
  const http: Http = async (method, url, headers, body) => {
    const p = url.replace('https://api.github.com', '');
    calls.push(`${method} ${p}`);
    if (state.signedOut) return ok(401, { message: 'Bad credentials' });
    if (state.fail > 0) {
      state.fail--;
      return ok(502, { message: 'Bad gateway' });
    }
    const b = body as Record<string, any>;
    const base = `/repos/${name}`;
    if (method === 'GET' && p === '/user') return ok(200, { login: opts.login ?? 'alice' });
    if (method === 'GET' && p === base) return ok(200, { full_name: name, permissions: { push: state.canWrite } });
    if (method === 'POST' && p === `${base}/git/trees`) {
      if (state.empty) return ok(409, { message: 'Git Repository is empty.' });
      const s = sha();
      trees.set(s, b.tree[0].content);
      return ok(201, { sha: s });
    }
    if (method === 'PUT' && p === `${base}/contents/README.md`) {
      state.empty = false;
      return ok(201, {});
    }
    if (method === 'POST' && p === `${base}/git/commits`) {
      assert.deepEqual(b.parents, [], 'a usage commit has no parents');
      const s = sha();
      commits.set(s, b.tree);
      return ok(201, { sha: s });
    }
    const ref = new RegExp(`^/repos/${escaped}/git/refs/heads/(.+)$`).exec(p);
    if (ref && method === 'PATCH') {
      if (!refs.has(ref[1]!)) return ok(422, { message: 'Reference does not exist' });
      refs.set(ref[1]!, b.sha);
      return ok(200, {});
    }
    if (ref && method === 'DELETE' && state.refuseDelete) return ok(403, { message: 'Resource not accessible by integration' });
    if (ref && method === 'DELETE') return refs.delete(ref[1]!) ? ok(204, null) : ok(422, { message: 'Reference does not exist' });
    if (method === 'POST' && p === `${base}/git/refs`) {
      refs.set(String(b.ref).replace('refs/heads/', ''), b.sha);
      return ok(201, {});
    }
    if (method === 'GET' && p.startsWith(`${base}/git/matching-refs/heads/ledung-usage/`)) {
      const tag = listTag();
      if (headers['if-none-match'] === tag) return ok(304, '', { etag: tag });
      return ok(200, [...refs].map(([r, s]) => ({ ref: `refs/heads/${r}`, object: { sha: s } })), { etag: tag });
    }
    const file = new RegExp(`^/repos/${escaped}/contents/usage\\.json\\?ref=([0-9a-f]+)$`).exec(p);
    if (file && method === 'GET') {
      if (state.failFiles > 0) {
        state.failFiles--;
        return ok(502, { message: 'Bad gateway' });
      }
      const tree = commits.get(file[1]!);
      return tree ? ok(200, Buffer.from(trees.get(tree)!)) : ok(404, { message: 'Not Found' });
    }
    return ok(404, { message: `fake: no ${method} ${p}` });
  };
  const fileOn = (branch: string): PublishedUsage => JSON.parse(trees.get(commits.get(refs.get(branch)!)!)!);
  return { name, http, refs, calls, state, fileOn };
}

function record(n: number, at: number, extra: Partial<UsageRecord>): UsageRecord {
  return {
    sessionId: 's1', messageId: `m${n}`, at, model: 'claude-opus-5-5', input: 100, cacheWrite: 10, cacheRead: 1000, output: 50, thinking: null, cost: 0.01,
    project: 'Open Project', role: 'session', team: null, subagent: null, branch: 'main', trigger: 'user', machine: 'pc', account: 'default', ...extra,
  };
}

function setup(o: { now?: number; github?: ReturnType<typeof fakeGitHub>; linkedKey?: string | null; meta?: Map<string, string>; keyDir?: string; projects?: () => PublisherProject[] } = {}) {
  const now = o.now ?? Date.UTC(2026, 9, 28, 10, 0);
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.createSession({ id: 's1', project: 'Open Project', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'auto' });
  const github = o.github ?? fakeGitHub();
  const meta = o.meta ?? new Map<string, string>();
  const keyDir = o.keyDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-usage-key-'));
  const logs: string[] = [];
  const clock = { now, computer: 'Studio' };
  const counts = { builds: 0 };
  const publisher = new UsagePublisher({
    meta: { get: (k) => meta.get(k) ?? null, set: (k, v) => void meta.set(k, v) },
    keyDir,
    slices: (range) => {
      counts.builds++;
      return usageSlices(db, range);
    },
    mark: () => usageMark(db),
    limits: () => store.latestLimits(),
    computer: () => clock.computer,
    // As the project settings come: "Hidden Project" never had the setting, which is the default (test review, finding 1).
    projects: o.projects ?? (() => publisherProjects([{ config: { name: 'Open Project', publishUsageName: true } }, { config: { name: 'Hidden Project' } }])),
    remotes: async (names) => new Map(names.map((n) => [n, n === 'Hidden Project' ? 'https://bob:ghp_TOKENSECRET@github.com/Secret-Org/Secret-Repo.git' : null])),
    emailOf: (account) => (account === 'default' ? 'Person.Secret@Example.com' : null),
    linkedKey: async () => o.linkedKey ?? null,
    repoFor: (repo) => new UsageRepo({ repo, http: github.http, token: async () => 'token' }),
    now: () => clock.now,
    log: (line) => logs.push(line),
  });
  return { db, store, github, meta, keyDir, logs, clock, publisher, now, counts };
}

test('the file never holds prompts, replies, tool output, paths, folder or branch names, titles, emails or tokens', async () => {
  const { store, github, publisher, now } = setup();
  const secrets = ['PROMPT-SECRET', 'REPLY-SECRET', 'TOOL-OUTPUT-SECRET', '/Users/bob/secret-folder', 'secret-folder', 'feature/BRANCH-SECRET', 'BRANCH-SECRET',
    'TITLE-SECRET', 'Person.Secret@Example.com', 'person.secret', 'ghp_TOKENSECRET', 'sk-ant-TOKEN-SECRET', 'Hidden Project', 'Secret-Repo', 'Secret-Org', 'MACHINE-SECRET', 'TEAM-SECRET'];
  store.createSession({ id: 'sess-SECRET', project: 'Hidden Project', runner: 'local', title: 'TITLE-SECRET', parentId: null, permissionMode: 'auto' });
  store.addMessage('sess-SECRET', 'user', { text: 'PROMPT-SECRET in /Users/bob/secret-folder with sk-ant-TOKEN-SECRET' }, now - 1000);
  store.addMessage('sess-SECRET', 'sdk', { type: 'assistant', message: { content: [{ type: 'text', text: 'REPLY-SECRET' }, { type: 'tool_result', content: 'TOOL-OUTPUT-SECRET' }] } }, now - 900);
  store.addUsage(record(1, now - 2000, { sessionId: 'sess-SECRET', messageId: 'msg-PROMPT-SECRET', project: 'Hidden Project', branch: 'feature/BRANCH-SECRET', machine: 'MACHINE-SECRET', team: 'TEAM-SECRET', subagent: 'TOOL-OUTPUT-SECRET' }));
  store.addUsage(record(2, now - 3 * DAY, { project: 'Open Project' }));
  store.addLimit({ account: 'default', at: now - 500, kind: 'five_hour', status: 'allowed', utilization: 0.4, resetsAt: now + 3600_000, data: { note: 'sk-ant-TOKEN-SECRET' } });
  await publisher.configure({ enabled: true, repo: REPO });
  assert.equal(publisher.view().error, null);
  const branch = [...github.refs.keys()][0]!;
  const text = JSON.stringify(github.fileOn(branch));
  for (const s of secrets) assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `"${s}" is in the published file`);
  // What is meant to be there is.
  const file = github.fileOn(branch);
  assert.equal(file.version, PUBLISHED_USAGE_VERSION);
  assert.equal(file.login, 'alice');
  assert.equal(file.computer, 'Studio');
  assert.equal(file.asOf, now);
  // The account is its name and the fingerprint of its email for this repo (test review, finding 2).
  assert.equal(file.accounts[0]!.label, 'default');
  assert.equal(file.accounts[0]!.fingerprint, accountFingerprint('Person.Secret@Example.com', REPO));
  const projects = new Set(file.accounts[0]!.daily.map((d) => d.project));
  assert.ok(projects.has('Open Project'), 'a switched-on project is published by name');
  assert.equal([...projects].filter((p) => /^other#[0-9a-z]{4}$/.test(p)).length, 1, 'the other project is other# and 4 characters');
  assert.equal(file.accounts[0]!.limits[0]!.utilization, 0.4);
  assert.equal(file.accounts[0]!.limits[0]!.seenAt, now - 500);
});

test('daily totals for 400 days and hourly ones for 8 days, with every figure', async () => {
  const { store, github, publisher, now } = setup();
  store.addUsage(record(1, now - 10 * 60_000, {}));
  store.addUsage(record(2, now - 9 * 60_000, { model: 'claude-sonnet-5-5', cost: 0.02 }));
  store.addUsage(record(3, now - 9 * DAY, {}));
  store.addUsage(record(4, now - 399 * DAY, {}));
  store.addUsage(record(5, now - 401 * DAY, {}));
  await publisher.configure({ enabled: true, repo: REPO });
  const a = github.fileOn([...github.refs.keys()][0]!).accounts[0]!;
  assert.equal(a.label, 'default');
  // Days 0, 9 and 399 back are in it; 401 is not.
  assert.equal(new Set(a.daily.map((d) => d.t)).size, 3);
  // Only the last 8 days are hourly: the two calls of now, on two models.
  assert.equal(a.hourly.length, 2);
  const opus = a.hourly.find((h) => h.model === 'opus-5-5')!;
  assert.deepEqual({ ...opus, t: 0 }, { t: 0, model: 'opus-5-5', project: 'Open Project', input: 100, cacheWrite: 10, cacheRead: 1000, output: 50, cost: 0.01, calls: 1 });
  assert.equal(opus.t % 3600_000, 0, 'an hour starts on the hour');
});

test('a project label is stable, the same for one remote written differently, and holds nothing of the name', () => {
  const key = crypto.randomBytes(32);
  const forms = [
    'https://github.com/Secret-Org/Secret-Repo.git',
    'https://bob:ghp_x@github.com/secret-org/secret-repo',
    'git@github.com:Secret-Org/Secret-Repo.git',
    'ssh://git@github.com/Secret-Org/Secret-Repo.git/',
    'HTTPS://GitHub.com/Secret-Org/Secret-Repo/',
  ];
  assert.deepEqual(new Set(forms.map(normaliseRemote)), new Set(['github.com/secret-org/secret-repo']));
  const labels = forms.map((remote) => otherLabel({ remote, name: 'whatever' }, key));
  assert.equal(new Set(labels).size, 1, 'every form of the remote has one label');
  assert.match(labels[0]!, /^other#[0-9a-z]{4}$/);
  assert.equal(otherLabel({ remote: forms[0], name: 'x' }, key), labels[0], 'stable');
  // Without a remote, from the name; with another key, another label.
  const byName = otherLabel({ name: 'Secret Repo' }, key);
  assert.match(byName, /^other#[0-9a-z]{4}$/);
  assert.equal(otherLabel({ name: 'Secret Repo' }, key), byName);
  assert.notEqual(otherLabel({ remote: forms[0], name: 'x' }, crypto.randomBytes(32)), labels[0]);
  for (const part of ['secret', 'repo', 'org', 'sec', 'rep']) assert.ok(!labels[0]!.slice(6).includes(part) && !byName.slice(6).includes(part));
});

test('the account fingerprint is one per account and repo, without the email', () => {
  const a = accountFingerprint('Person@Example.com', 'Acme/Usage');
  assert.equal(a, accountFingerprint(' person@example.com ', 'acme/usage'));
  assert.notEqual(a, accountFingerprint('person@example.com', 'acme/other'), 'salted with the repo');
  assert.notEqual(a, accountFingerprint('other@example.com', 'acme/usage'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, crypto.createHash('sha256').update('person@example.com').digest('hex'), 'not a bare hash of the email');
});

test('the branch is ledung-usage/<login>/<computer id>, kept across a rename, and replaced on every publish', async () => {
  const { store, github, publisher, meta, clock } = setup();
  store.addUsage(record(1, clock.now - 60_000, {}));
  await publisher.configure({ enabled: true, repo: REPO });
  const id = meta.get('usage-computer-id')!;
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.deepEqual([...github.refs.keys()], [`ledung-usage/alice/${id}`]);
  assert.deepEqual(parseUsageBranch(`refs/heads/ledung-usage/alice/${id}`), { login: 'alice', computerId: id });
  assert.throws(() => usageBranch('alice/../x', id));
  // Nothing changed: no publish.
  const before = github.calls.length;
  await publisher.publishNow();
  assert.equal(github.calls.length, before);
  // A new call: one tree, one commit, one ref update.
  store.addUsage(record(2, clock.now - 30_000, {}));
  clock.now += 5 * 60_000;
  const first = github.refs.get(`ledung-usage/alice/${id}`);
  await publisher.publishNow();
  assert.deepEqual(github.calls.slice(before).map((c) => c.split(' ')[0]), ['POST', 'POST', 'PATCH']);
  assert.notEqual(github.refs.get(`ledung-usage/alice/${id}`), first);
  assert.equal(github.fileOn(`ledung-usage/alice/${id}`).accounts[0]!.daily[0]!.calls, 2);
  // A renamed computer keeps its branch; the file carries the new name.
  clock.computer = 'Studio 2';
  await publisher.publishNow();
  assert.deepEqual([...github.refs.keys()], [`ledung-usage/alice/${id}`]);
  assert.equal(github.fileOn(`ledung-usage/alice/${id}`).computer, 'Studio 2');
});

test('an empty repo gets a README first; a failed publish is kept for Settings and never throws', async () => {
  const github = fakeGitHub({ empty: true });
  const { store, publisher, clock, logs } = setup({ github });
  store.addUsage(record(1, clock.now - 60_000, {}));
  github.state.fail = 1;
  await publisher.configure({ enabled: true, repo: REPO });
  assert.match(publisher.view().error ?? '', /502/);
  assert.equal(github.refs.size, 0);
  assert.ok(logs.some((l) => /Trying again in 1 min/.test(l)));
  await publisher.publishNow();
  assert.equal(publisher.view().error, null);
  assert.equal(publisher.view().lastPublishedAt, clock.now);
  assert.equal(github.refs.size, 1);
  assert.ok(github.calls.some((c) => c.startsWith('PUT /repos/acme/usage/contents/README.md')));
});

test('switching off deletes this computer\'s branch', async () => {
  const { store, github, publisher, clock } = setup();
  store.addUsage(record(1, clock.now - 60_000, {}));
  await publisher.configure({ enabled: true, repo: REPO });
  assert.equal(github.refs.size, 1);
  await publisher.configure({ enabled: false, repo: REPO });
  assert.equal(github.refs.size, 0);
  assert.equal(publisher.view().enabled, false);
  // Off: the timer publishes nothing.
  const before = github.calls.length;
  await publisher.publishNow();
  assert.equal(github.calls.length, before);
});

test('the usage key: taken from a linked computer, else made; kept next to the link keys; a pasted one replaces it', async () => {
  const linked = crypto.randomBytes(32).toString('base64url');
  const a = setup({ linkedKey: linked });
  a.store.addUsage(record(1, a.clock.now - 60_000, { project: 'Hidden Project' }));
  await a.publisher.configure({ enabled: true, repo: REPO });
  assert.equal(fs.readFileSync(path.join(a.keyDir, USAGE_KEY_FILE), 'utf8'), linked);
  // A second computer with the same key labels the project alike.
  const github = fakeGitHub({ login: 'bob' });
  const b = setup({ linkedKey: linked, github });
  b.store.addUsage(record(1, b.clock.now - 60_000, { project: 'Hidden Project' }));
  await b.publisher.configure({ enabled: true, repo: REPO });
  const label = (g: ReturnType<typeof fakeGitHub>) => g.fileOn([...g.refs.keys()][0]!).accounts[0]!.daily[0]!.project;
  assert.equal(label(a.github), label(github));
  // Without a linked key: one is made.
  const c = setup();
  c.store.addUsage(record(1, c.clock.now - 60_000, {}));
  await c.publisher.configure({ enabled: true, repo: REPO });
  assert.match(c.publisher.key() ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(c.publisher.key(), linked);
  assert.throws(() => c.publisher.setKey('not a key'));
  c.publisher.setKey(linked);
  assert.equal(c.publisher.key(), linked);
});

test('reading: the branch list is conditional, only changed files are fetched, a newer format says update Ledung', async () => {
  const github = fakeGitHub();
  const { store, publisher, clock, meta } = setup({ github });
  store.addUsage(record(1, clock.now - 60_000, {}));
  await publisher.configure({ enabled: true, repo: REPO });
  // Another computer's file, from a newer Ledung.
  const otherRepo = new UsageRepo({ repo: REPO, http: github.http, token: async () => 't' });
  await otherRepo.publish('ledung-usage/carol/00112233445566778899aabb', Buffer.from(JSON.stringify({ version: PUBLISHED_USAGE_VERSION + 1, login: 'carol', computer: 'Laptop', asOf: clock.now })), 'x');
  let view = await publisher.shared(true);
  assert.equal(view.entries.length, 2);
  const own = view.entries.find((e) => e.own)!;
  assert.equal(own.state, 'ok');
  assert.equal(own.computer, 'Studio');
  assert.ok(!JSON.stringify(view.entries.map(({ file: _f, ...e }) => e)).includes('ledung-usage/'), 'the page gets names, never the branch');
  const newer = view.entries.find((e) => !e.own)!;
  assert.deepEqual([newer.state, newer.login, newer.computer], ['newer', 'carol', 'Laptop']);
  // Nothing changed: one list call answered 304, no file read.
  const before = github.calls.length;
  view = await publisher.shared(true);
  assert.deepEqual(github.calls.slice(before), [`GET /repos/${REPO}/git/matching-refs/heads/ledung-usage/?per_page=100`]);
  // This computer publishes again: only its file is read.
  store.addUsage(record(2, clock.now - 30_000, {}));
  clock.now += 5 * 60_000;
  await publisher.publishNow();
  const mark = github.calls.length;
  await publisher.shared(true);
  const reads = github.calls.slice(mark).filter((c) => c.includes('/contents/usage.json'));
  assert.equal(reads.length, 1);
  assert.ok(reads[0]!.endsWith(github.refs.get(`ledung-usage/alice/${meta.get('usage-computer-id')}`)!));
  assert.equal(readPublishedUsage({ version: PUBLISHED_USAGE_VERSION, login: 'x' }).kind, 'invalid');
});

test('a computer silent for 30 days is stale, and only a login that can write may remove it', async () => {
  const github = fakeGitHub({ canWrite: false });
  const { publisher, clock } = setup({ github });
  const old = { version: PUBLISHED_USAGE_VERSION, login: 'dave', computer: 'Old PC', computerId: 'ffeeddccbbaa998877665544', asOf: clock.now - 31 * DAY, timeZone: 'UTC', accounts: [] };
  const fresh = { ...old, login: 'erin', computer: 'New PC', computerId: '0011223344556677889900aa', asOf: clock.now - DAY };
  const repo = new UsageRepo({ repo: REPO, http: github.http, token: async () => 't' });
  await repo.publish('ledung-usage/dave/ffeeddccbbaa998877665544', Buffer.from(JSON.stringify(old)), 'x');
  await repo.publish('ledung-usage/erin/0011223344556677889900aa', Buffer.from(JSON.stringify(fresh)), 'x');
  await publisher.configure({ enabled: false, repo: REPO });
  let view = await publisher.shared(true);
  const stale = view.entries.find((e) => e.login === 'dave')!;
  const live = view.entries.find((e) => e.login === 'erin')!;
  assert.equal(stale.stale, true);
  assert.equal(live.stale, false);
  assert.equal(view.canRemove, false);
  await assert.rejects(publisher.removeStale(stale.id), /write access/);
  // With write access: the stale one goes, a live one may not.
  github.state.canWrite = true;
  const writer = setup({ github });
  await writer.publisher.configure({ enabled: false, repo: REPO });
  await writer.publisher.shared(true);
  await assert.rejects(writer.publisher.removeStale(live.id), /silent for 30 days/);
  view = await writer.publisher.removeStale(stale.id);
  assert.deepEqual(view.entries.map((e) => e.login), ['erin']);
  assert.ok(!github.refs.has('ledung-usage/dave/ffeeddccbbaa998877665544'));
});

test('a failing GitHub gets one retry at a time, 1, 2 then 5 minutes apart: the calls do not grow hour by hour', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const github = fakeGitHub();
    const { store, publisher, clock, meta } = setup({ github });
    store.addUsage(record(1, clock.now - 60_000, {}));
    meta.set('usage-publish', JSON.stringify({ repo: REPO, allAccounts: true, accounts: [] }));
    github.state.fail = 1_000_000;
    publisher.start();
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    const perHour: number[] = [];
    for (let hour = 0; hour < 3; hour++) {
      const before = github.calls.length;
      for (let m = 0; m < 60; m++) {
        mock.timers.tick(60_000);
        await flush();
      }
      // Publishing calls only: the 5-minute read of the branch list is its own, 12 an hour.
      perHour.push(github.calls.slice(before).filter((c) => !c.includes('/matching-refs/')).length);
    }
    publisher.stop();
    // 1 + 2 + 5·n minutes: about 12 tries an hour, one call each (the sign-in check fails first).
    assert.ok(perHour.every((n) => n <= 14), `calls per hour: ${perHour.join(', ')}`);
    assert.ok(perHour[2]! <= perHour[1]!, `calls per hour grew: ${perHour.join(', ')}`);
    assert.match(publisher.view().error ?? '', /502/);
  } finally {
    mock.timers.reset();
  }
});

test('switching off works while GitHub refuses; the branch is removed once it answers again', async () => {
  const { store, github, publisher, clock } = setup();
  store.addUsage(record(1, clock.now - 60_000, {}));
  await publisher.configure({ enabled: true, repo: REPO });
  assert.equal(github.refs.size, 1);
  github.state.signedOut = true;
  const view = await publisher.configure({ enabled: false, repo: REPO });
  assert.equal(view.enabled, false, 'off is saved even though the delete failed');
  assert.deepEqual(view.pendingRemovals, [REPO]);
  assert.match(view.error ?? '', /Removing this computer's usage from acme\/usage failed: Sign in/);
  assert.equal(github.refs.size, 1);
  github.state.signedOut = false;
  await publisher.publishNow();
  assert.equal(github.refs.size, 0);
  assert.deepEqual(publisher.view().pendingRemovals, []);
  assert.equal(publisher.view().error, null);
});

test('nothing recorded and the same hour: the file is not even built', async () => {
  const { store, github, publisher, clock, counts } = setup();
  store.addUsage(record(1, clock.now - 60_000, {}));
  await publisher.configure({ enabled: true, repo: REPO });
  const builds = counts.builds;
  const calls = github.calls.length;
  clock.now += 5 * 60_000;
  await publisher.publishNow();
  assert.equal(counts.builds, builds, 'no new call: no build');
  assert.equal(github.calls.length, calls);
  store.addUsage(record(2, clock.now - 1000, {}));
  await publisher.publishNow();
  assert.equal(counts.builds, builds + 1, 'a new call builds it');
  // The next hour builds it again, whatever the calls say.
  clock.now += 60 * 60_000;
  await publisher.publishNow();
  assert.equal(counts.builds, builds + 2);
});

test('a file that failed to download is read again next time, and is never offered for removal as stale', async () => {
  const github = fakeGitHub();
  const { publisher, clock } = setup({ github });
  const repo = new UsageRepo({ repo: REPO, http: github.http, token: async () => 't' });
  const file = { version: PUBLISHED_USAGE_VERSION, login: 'erin', computer: 'New PC', computerId: '0011223344556677889900aa', asOf: clock.now - DAY, timeZone: 'UTC', accounts: [] };
  await repo.publish('ledung-usage/erin/0011223344556677889900aa', Buffer.from(JSON.stringify(file)), 'x');
  await publisher.configure({ enabled: false, repo: REPO });
  github.state.failFiles = 1;
  let view = await publisher.shared(true);
  assert.deepEqual([view.entries[0]!.state, view.entries[0]!.stale], ['invalid', false]);
  // The branch has not moved, but the file is fetched again.
  view = await publisher.shared(true);
  assert.deepEqual([view.entries[0]!.state, view.entries[0]!.computer], ['ok', 'New PC']);
});

test('daily figures come from the daily totals table when the database has it', () => {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'auto' });
  const now = Date.now();
  store.addUsage(record(1, now - 1000, { project: 'p' }));
  const range = { since: now - 10 * DAY, sinceDay: '2000-01-01', hourSince: now - 8 * DAY };
  const fromCalls = usageSlices(db, range);
  assert.equal(fromCalls.daily.length, 1);
  assert.equal(fromCalls.hourly.length, 1);
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'usage_daily'`).get()) {
    db.exec(`CREATE TABLE usage_daily (day TEXT, account TEXT, machine TEXT, model TEXT, project TEXT, role TEXT, trigger TEXT, input INTEGER,
      cache_write INTEGER, cache_read INTEGER, output INTEGER, thinking INTEGER, cost REAL, calls INTEGER, subagent_tokens INTEGER)`);
  }
  db.exec(`DELETE FROM usage_daily`);
  // Two rows of one day that differ only in what the file does not carry (computer, role) are summed.
  db.exec(`INSERT INTO usage_daily VALUES ('2026-01-02', 'default', 'pc', 'claude-opus-5-5', 'p', 'session', 'user', 7, 1, 2, 3, 0, 0.5, 2, 0),
    ('2026-01-02', 'default', 'pc2', 'claude-opus-5-5', 'p', 'manager', 'user', 3, 0, 0, 1, 0, 0.25, 1, 0)`);
  const fromTable = usageSlices(db, range);
  assert.deepEqual(fromTable.daily, [{ day: '2026-01-02', account: 'default', model: 'claude-opus-5-5', project: 'p', input: 10, cacheWrite: 1, cacheRead: 2, output: 4, cost: 0.75, calls: 3 }]);
  assert.deepEqual(fromTable.hourly, fromCalls.hourly, 'hours still come from the calls');
});

/** Several fake repos behind one login: each call goes to the repo its path names. */
function fakeRepos(...repos: ReturnType<typeof fakeGitHub>[]): Http {
  return (method, url, headers, body) => {
    const hit = repos.find((r) => url.includes(`/repos/${r.name}/`) || url.endsWith(`/repos/${r.name}`)) ?? repos[0]!;
    return hit.http(method, url, headers, body);
  };
}

test('moving to another repo publishes there even while the old repo refuses the delete; two moves remember both', async () => {
  const a = fakeGitHub({ repo: 'acme/a' });
  const b = fakeGitHub({ repo: 'acme/b' });
  const c = fakeGitHub({ repo: 'acme/c' });
  const http = fakeRepos(a, b, c);
  const { store, publisher, clock } = setup({ github: { ...a, http } });
  store.addUsage(record(1, clock.now - 60_000, {}));
  await publisher.configure({ enabled: true, repo: 'acme/a' });
  assert.equal(a.refs.size, 1);
  // Access to A is gone: its delete is refused for good.
  a.state.refuseDelete = true;
  let view = await publisher.configure({ enabled: true, repo: 'acme/b' });
  assert.equal(b.refs.size, 1, 'B is published although A refused');
  assert.deepEqual(view.pendingRemovals, ['acme/a']);
  assert.match(view.error ?? '', /Removing this computer's usage from acme\/a failed/);
  // A second move: B's file goes, A's is still remembered.
  view = await publisher.configure({ enabled: true, repo: 'acme/c' });
  assert.equal(b.refs.size, 0);
  assert.equal(c.refs.size, 1);
  assert.deepEqual(view.pendingRemovals, ['acme/a']);
  // A accepts again: nothing is left behind.
  a.state.refuseDelete = false;
  await publisher.publishNow();
  assert.equal(a.refs.size, 0);
  assert.deepEqual(publisher.view().pendingRemovals, []);
  assert.equal(publisher.view().error, null);
});

// Per account and per project (issue #380; Martin, 2026-10-28: "Different project should be able to publish to
// different boards. AND the publish usage should be per account.").

/** Two repos behind one login, and a computer with two accounts and two projects. */
function split(o: { meta?: Map<string, string> } = {}) {
  const home = fakeGitHub({ repo: 'friends/usage' });
  const work = fakeGitHub({ repo: 'team/usage' });
  const projects = { list: [{ config: { name: 'Hobby', publishUsageName: true } }, { config: { name: 'Job', publishUsageName: true, usageRepo: 'team/usage' } }] as { config: { name: string; publishUsageName?: boolean; usageRepo?: string } }[] };
  const t = setup({ github: { ...home, http: fakeRepos(home, work) }, meta: o.meta, projects: () => publisherProjects(projects.list) });
  const at = t.clock.now - 60_000;
  let n = 0;
  // Each account in each project, and a chat, which no project claims; "contractor" only ever worked on Job.
  for (const account of ['default', 'work']) {
    for (const project of ['Hobby', 'Job', 'chats']) t.store.addUsage(record(++n, at, { account, project, messageId: `${account}-${project}` }));
  }
  t.store.addUsage(record(++n, at, { account: 'contractor', project: 'Job', messageId: 'contractor-Job' }));
  const utilization: Record<string, number> = { default: 0.2, work: 0.7, contractor: 0.9 };
  for (const [account, u] of Object.entries(utilization)) t.store.addLimit({ account, at, kind: 'five_hour', status: 'allowed', utilization: u, resetsAt: at + 3600_000, data: {} });
  const file = (g: ReturnType<typeof fakeGitHub>) => (g.refs.size ? g.fileOn([...g.refs.keys()][0]!) : null);
  /** account → its projects, and which accounts carry limits, as a repo's file has them. */
  const seen = (g: ReturnType<typeof fakeGitHub>) => {
    const f = file(g);
    if (!f) return null;
    return Object.fromEntries(f.accounts.map((a) => [a.label, { projects: [...new Set(a.daily.map((d) => d.project))].sort(), limits: a.limits.map((l) => l.utilization) }]));
  };
  return { ...t, home, work, projects, seen };
}

test('#380: each repo gets only the accounts that are on, for its own projects', async () => {
  const { publisher, home, work, seen } = split();
  // "work" off, "default" and "contractor" on; Job goes to the team's repo, everything else to the default (friends') one.
  const view = await publisher.configure({ enabled: true, repo: 'friends/usage', allAccounts: false, accounts: ['contractor', 'default'] });
  assert.equal(view.error, null);
  assert.deepEqual(view.projectRepos, [{ repo: 'team/usage', projects: ['Job'] }]);
  // From the setup: default used Hobby, Job and chats; chats is no project's, so it is the default repo's (other#).
  const homeSeen = seen(home)!;
  assert.deepEqual(Object.keys(homeSeen), ['default'], 'friends\' repo: no "work" (off), no "contractor" (only Job)');
  assert.equal(homeSeen.default!.projects.length, 2);
  assert.equal(homeSeen.default!.projects[0], 'Hobby');
  assert.match(homeSeen.default!.projects[1]!, /^other#[0-9a-z]{4}$/, 'the chats');
  assert.deepEqual(homeSeen.default!.limits, [0.2]);
  // The team's repo: Job only. An account's limits go where its usage goes, so default's are in both, contractor's only here.
  assert.deepEqual(seen(work), { contractor: { projects: ['Job'], limits: [0.9] }, default: { projects: ['Job'], limits: [0.2] } });
  const text = JSON.stringify([home.fileOn([...home.refs.keys()][0]!), work.fileOn([...work.refs.keys()][0]!)]);
  assert.ok(!text.includes('"work"') && !text.includes('0.7'), 'the account that is off is in neither file, nor its limits');
});

test('#380: all accounts publishes an account added later; switching one off or moving a project removes it on the next publish', async () => {
  const { publisher, store, clock, home, work, projects, seen } = split();
  await publisher.configure({ enabled: true, repo: 'friends/usage', allAccounts: true });
  assert.deepEqual(Object.keys(seen(home)!).sort(), ['default', 'work']);
  assert.deepEqual(Object.keys(seen(work)!).sort(), ['contractor', 'default', 'work']);
  // An account added later: with all accounts on, published without touching the setting.
  store.addUsage(record(99, clock.now - 1000, { account: 'later', project: 'Hobby', messageId: 'later' }));
  clock.now += 5 * 60_000;
  await publisher.publishNow();
  assert.deepEqual(Object.keys(seen(home)!).sort(), ['default', 'later', 'work']);
  // One account off: gone from both repos on the next publish.
  await publisher.configure({ enabled: true, repo: 'friends/usage', allAccounts: false, accounts: ['contractor', 'default', 'later'] });
  assert.deepEqual(Object.keys(seen(home)!).sort(), ['default', 'later']);
  assert.deepEqual(Object.keys(seen(work)!).sort(), ['contractor', 'default']);
  // Job moves to the default repo: the team's repo has this computer's file removed, and Job is in the friends' one.
  projects.list = [{ config: { name: 'Hobby', publishUsageName: true } }, { config: { name: 'Job', publishUsageName: true } }];
  clock.now += 5 * 60_000;
  await publisher.publishNow();
  assert.equal(work.refs.size, 0, 'no repo points at team/usage any more');
  assert.ok(seen(home)!.default!.projects.includes('Job'));
  assert.deepEqual(seen(home)!.contractor, { projects: ['Job'], limits: [0.9] }, 'its limits follow its usage');
  assert.deepEqual(publisher.view().pendingRemovals, []);
  assert.deepEqual(publisher.view().projectRepos, []);
});

test('#380: a removed project keeps the repo it last had: its usage stays there and never moves into the default (Martin, Ledung question #366)', async () => {
  const { publisher, clock, home, work, projects, seen } = split();
  await publisher.configure({ enabled: true, repo: 'friends/usage', allAccounts: true });
  assert.ok(seen(work)!.default!.projects.includes('Job'));
  const homeBefore = seen(home);
  // Job is removed in Ledung: the live list no longer has it, its kept settings still name team/usage.
  const job = projects.list.find((p) => p.config.name === 'Job')!;
  const live = projects.list.filter((p) => p !== job);
  const removed = [job];
  (publisher as unknown as { opts: { projects: () => PublisherProject[] } }).opts.projects = () => publisherProjects(live, removed);
  clock.now += 5 * 60_000;
  await publisher.publishNow();
  assert.equal(work.refs.size, 1, 'the team repo keeps this computer\'s file');
  assert.deepEqual(Object.values(seen(work)!).map((a) => a.projects.length), [1, 1, 1], 'Job only, for each account');
  assert.ok(Object.values(seen(work)!).every((a) => a.projects[0]!.startsWith('other#')), 'a removed project is not published by name');
  // The default repo's file is as it was: no other# label for Job, no contractor, who only worked on Job.
  assert.deepEqual(seen(home), homeBefore, 'nothing of Job moved into the default repo');
  assert.deepEqual(Object.keys(seen(home)!).sort(), ['default', 'work']);
  assert.deepEqual(publisher.view().projectRepos, [{ repo: 'team/usage', projects: ['Job (removed)'] }]);
  // A live project of the same name wins over the removed one's settings.
  assert.deepEqual(publisherProjects([{ config: { name: 'Job' } }], removed).map((p) => [p.name, p.repo]), [['Job', null]]);
});

test('#380: the project store keeps a removed project\'s settings for the publisher, not once a live one has its name', () => {
  const projects = new ProjectStore(openDatabase(':memory:'));
  projects.add(parseProject({ name: 'Job', runner: 'local', path: '/p/job', usageRepo: 'team/usage' }));
  projects.add(parseProject({ name: 'Hobby', runner: 'local', path: '/p/hobby' }));
  projects.remove('Job');
  assert.deepEqual(projects.removed().map((p) => [p.config.name, p.config.usageRepo]), [['Job', 'team/usage']]);
  assert.deepEqual(publisherProjects(projects.list(), projects.removed()).map((p) => [p.name, p.repo, p.removed === true]), [['Hobby', null, false], ['Job', 'team/usage', true]]);
  // Added again: the live project's settings count, and the removed row is gone.
  projects.add(parseProject({ name: 'Job', runner: 'local', path: '/p/job' }));
  assert.deepEqual(projects.removed(), []);
});
