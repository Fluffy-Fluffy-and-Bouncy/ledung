// Locked secrets (issue #468): the names and tokens, the encrypted vault and the lifetimes, blanking, the
// runtime files a running session's commands read, and how the runners pass values (never on a command line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  envName, expandSecrets, expandSecretsForShell, secretForClaude, secretNameProblem, SECRET_FILE_PATTERN, secretToken, suggestSecretName, tokenNames,
} from '../src/shared/secrets.ts';
import { Secrets } from '../src/secrets/secrets.ts';
import { dpapiGuard, fileGuard, Vault, type KeyGuard } from '../src/secrets/vault.ts';
import { cleanContainer, containerEnvFilePart, DockerSecretRuntime, exportLines, localRuntimeSessions, LocalSecretRuntime, localSecretsDir } from '../src/secrets/runtime.ts';
import { cleanStaleRuntime, metaPlaceBook, SessionSecrets } from '../src/secrets/live.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { DockerRunner } from '../src/runners/docker-runner.ts';
import { startShell } from '../src/runners/shell-run.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { matchSensitive } from '../src/sessions/sensitive.ts';
import { FileError, readProjectFile } from '../src/sessions/files.ts';
import { removeTemp } from './temp.ts';

const tmp = (name = 'ledung-secrets-test-') => fs.mkdtempSync(path.join(os.tmpdir(), name));
const S1 = { sessionId: 's1', project: 'p' };
const S2 = { sessionId: 's2', project: 'p' };
const OTHER = { sessionId: 's3', project: 'q' };
const VALUE = 'hunter2-correct-horse';

/** A key guard in memory, counting its calls. */
function memoryGuard(): KeyGuard & { key: Buffer | null; loads: number } {
  const g = {
    kind: 'memory', key: null as Buffer | null, loads: 0,
    load: async () => { g.loads++; return g.key; },
    save: async (k: Buffer) => { g.key = Buffer.from(k); },
  };
  return g;
}

test('names: small letters, digits and -_. ; the variable is its capitals; names the shell, Claude Code or Ledung use are refused', () => {
  assert.equal(envName('npm-token'), 'NPM_TOKEN');
  assert.equal(envName('db.pass'), 'DB_PASS');
  assert.equal(secretNameProblem('password'), null);
  assert.match(secretNameProblem('Password')!, /small letters/);
  assert.match(secretNameProblem('1st')!, /starting with a letter/);
  assert.match(secretNameProblem('a b')!, /small letters/);
  for (const reserved of ['path', 'home', 'ledung-config', 'claude-code-oauth-token', 'anthropic-api-key', 'ld-preload', 'node-options', 'bash-env']) {
    assert.ok(secretNameProblem(reserved), reserved);
  }
});

test('a default name from what the value looks like, else the words before it, else "secret"; never one taken', () => {
  assert.equal(suggestSecretName('here: ', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'github-token');
  assert.equal(suggestSecretName('', 'npm_abcdef'), 'npm-token');
  assert.equal(suggestSecretName('', 'sk-ant-api03-xyz'), 'api-key', "not anthropic-key: $ANTHROPIC_* is Claude Code's");
  assert.equal(suggestSecretName('my password is ', 'xyz'), 'password');
  assert.equal(suggestSecretName('the npm token: ', 'xyz'), 'npm-token');
  assert.equal(suggestSecretName('use the staging db passwd ', 'xyz'), 'db-password');
  assert.equal(suggestSecretName('the API key = ', 'xyz'), 'api-key');
  assert.equal(suggestSecretName('log in with ', 'xyz'), 'secret');
  assert.equal(suggestSecretName('my password is ', 'xyz', ['password', 'password-2']), 'password-3');
});

test('a token in a message becomes, for Claude, the name and its variable, never the value; unknown names stay as typed', () => {
  const text = `Deploy with ${secretToken('npm-token')} and ${secretToken('gone')}; again ${secretToken('npm-token')}.`;
  assert.deepEqual(tokenNames(text), ['npm-token', 'gone']);
  const out = expandSecrets(text, new Set(['npm-token']));
  assert.deepEqual(out.used, ['npm-token']);
  assert.equal(out.text, `Deploy with ${secretForClaude('npm-token')} and ${secretToken('gone')}; again ${secretForClaude('npm-token')}.`);
  assert.equal(secretForClaude('npm-token'), '🔑 secret "npm-token" (available as $NPM_TOKEN in your commands; never print it)');
  // In a "!" command the token is a reference to the variable in that shell.
  assert.equal(expandSecretsForShell(`curl -u ${secretToken('api')} x`, new Set(['api']), false), 'curl -u "$API" x');
  assert.equal(expandSecretsForShell(`echo ${secretToken('api')}`, new Set(['api']), true), 'echo $env:API');
});

test('the vault is encrypted: the file holds no value or name, opens again with the key, and one whose key is gone is never overwritten', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'secrets.enc');
    const guard = memoryGuard();
    const secrets = await Secrets.open(new Vault(file, guard));
    await secrets.add(S1, 'db-password', VALUE, 'kept');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(VALUE) && !raw.includes('db-password'), 'neither the value nor the name in the file');
    assert.ok(guard.key && guard.key.length === 32, 'a 256-bit key, kept by the guard');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'owner only');

    const again = await Secrets.open(new Vault(file, guard));
    assert.deepEqual(again.list(S1).map((s) => [s.name, s.lifetime]), [['db-password', 'kept']]);
    assert.deepEqual(again.values(S1), [{ env: 'DB_PASSWORD', value: VALUE }]);

    // A tampered file fails the GCM check rather than giving wrong values.
    const box = JSON.parse(raw);
    box.data = Buffer.from(Buffer.from(box.data, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64');
    fs.writeFileSync(file, JSON.stringify(box));
    assert.match((await Secrets.open(new Vault(file, guard))).problem!, /unavailable/);

    // The key is gone (another user, a wiped Keychain): unavailable, and the file stays as it was.
    fs.writeFileSync(file, raw);
    const lost = await Secrets.open(new Vault(file, memoryGuard()));
    assert.match(lost.problem!, /key .* is missing/);
    await assert.rejects(lost.add(S1, 'other', 'x'.repeat(8), 'session'), /unavailable/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);

    // The last one removed: the file goes.
    await again.remove(S1, again.list(S1)[0]!.id);
    assert.equal(fs.existsSync(file), false);
  } finally {
    removeTemp(dir);
  }
});

test('the owner-only key file keeps a key that reads back', async () => {
  const dir = tmp();
  try {
    const g = fileGuard(path.join(dir, 'secrets.key'));
    assert.equal(await g.load(), null);
    const key = crypto.randomBytes(32);
    await g.save(key);
    assert.ok((await g.load())!.equals(key));
  } finally {
    removeTemp(dir);
  }
});

test('on Windows the key is kept with DPAPI for this user: the file holds no key, and reads back', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'secrets.key');
    const g = dpapiGuard(file);
    const key = crypto.randomBytes(32);
    await g.save(key);
    const kept = fs.readFileSync(file, 'utf8');
    assert.ok(!kept.includes(key.toString('hex')) && !kept.includes(key.toString('base64')));
    assert.ok((await g.load())!.equals(key));
  } finally {
    removeTemp(dir);
  }
});

test('lifetimes: once goes after its turn, this session when it is archived, kept and project stay until removed; a project secret reaches its other sessions only', async () => {
  const secrets = Secrets.memory();
  const changes: unknown[] = [];
  secrets.onChange = (c) => changes.push(c);
  const once = await secrets.add(S1, 'otp', '123456', 'once');
  await secrets.add(S1, 'session-pass', 'abcdefgh', 'session');
  await secrets.add(S1, 'kept-pass', 'ijklmnop', 'kept');
  await secrets.add(S1, 'deploy-key', 'qrstuvwx', 'project');
  assert.deepEqual(secrets.list(S1).map((s) => s.name), ['otp', 'session-pass', 'kept-pass', 'deploy-key']);
  assert.deepEqual(secrets.list(S2).map((s) => s.name), ['deploy-key'], 'another session of the project: only the project secret');
  assert.deepEqual(secrets.list(OTHER), [], 'another project: none');
  assert.deepEqual(changes.at(-1), { project: 'p' });
  assert.equal(once.reachesNow, false);
  await assert.rejects(secrets.add(S1, 'otp', 'x'.repeat(8), 'session'), /already has a secret/);
  await assert.rejects(secrets.add(S2, 'deploy_key', 'x'.repeat(8), 'session'), /\$DEPLOY_KEY/, 'one variable per name');
  await assert.rejects(secrets.add(S1, 'path', 'x', 'session'), /used by the shell/);
  await assert.rejects(secrets.add(S1, 'empty', '', 'session'), /no value/);

  await secrets.removeOnce('s1', new Set(['otp']));
  assert.ok(!secrets.names(S1).has('otp'));
  await secrets.endSession('s1');
  assert.deepEqual(secrets.list(S1).map((s) => s.name), ['kept-pass', 'deploy-key']);
  // Renamed and made the session's again: the project's other sessions lose it.
  const deploy = secrets.list(S1).find((s) => s.name === 'deploy-key')!;
  await secrets.edit(S2, deploy.id, { name: 'ship-key', lifetime: 'kept' });
  assert.deepEqual(secrets.list(S2).map((s) => s.name), ['ship-key']);
  assert.deepEqual(secrets.list(S1).map((s) => s.name), ['kept-pass']);
  await secrets.dropProject('p');
  assert.deepEqual(secrets.list(S2), []);
  // At Ledung's start, the "once" secrets of sessions that are not running had their turn.
  await secrets.add(S1, 'otp', '654321', 'once');
  await secrets.dropOnceExcept(new Set(['s9']));
  assert.deepEqual(secrets.list(S1), []);
});

test('blanking: the exact value becomes 🔑name in text and in JSON, a longer value first; values too short are left alone', async () => {
  const secrets = Secrets.memory();
  await secrets.add(S1, 'short', 'abc', 'session');
  await secrets.add(S1, 'pass', 'p"a\\ss', 'session');
  await secrets.add(S1, 'long', 'p"a\\ss-and-more', 'session');
  assert.equal(secrets.blank('x p"a\\ss-and-more y p"a\\ss abc'), 'x 🔑long y 🔑pass abc');
  const json = JSON.stringify({ out: 'got p"a\\ss here' });
  assert.equal(JSON.parse(secrets.blankJson(json)).out, 'got 🔑pass here');
  assert.ok(secrets.holdsValue('…p"a\\ss…'));
  assert.ok(!secrets.holdsValue('nothing'));
});

test('everything Ledung stores is blanked: tool output, messages, questions, answers, permissions, the inbox and held messages', async () => {
  const secrets = Secrets.memory();
  const store = new Store(openDatabase(':memory:'));
  store.setBlanker({ text: (s) => secrets.blank(s), json: (s) => secrets.blankJson(s) });
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
  await secrets.add(S1, 'token', VALUE, 'session');
  const tool = store.addHostLine('s1', 1, Date.now(), { type: 'user', message: { content: [{ type: 'tool_result', content: `echo ${VALUE}` }] } });
  const said = store.addMessage('s1', 'sdk', { type: 'assistant', message: { content: [{ type: 'text', text: `It is ${VALUE}.` }] } });
  const q = store.createQuestion({ sessionId: 's1', question: `Use ${VALUE}?`, options: [VALUE, 'no'], addressedTo: 'user' });
  store.answerQuestion(q.id, `yes, ${VALUE}`, 'user');
  const p = store.createPermission({ id: 'p1', sessionId: 's1', toolName: 'Bash', input: { command: `login ${VALUE}` }, title: VALUE, reason: null });
  store.addInbox('s1', 'manager:m', `the key is ${VALUE}`);
  store.setHeldMessages('s1', [`held ${VALUE}`]);
  const all = JSON.stringify([tool, said, store.getQuestion(q.id), p, store.undeliveredInbox('s1'), store.heldMessages('s1'), store.listMessages('s1')]);
  assert.ok(!all.includes(VALUE), all);
  assert.ok(all.includes('🔑token'));
});

test('a session reading a runtime file of secrets asks the person, whatever the lists say; the file viewer never shows one', () => {
  const id = crypto.randomUUID();
  const local = path.join(localSecretsDir('/data'), `ledung-${id}.secrets`);
  assert.ok(SECRET_FILE_PATTERN.test(local));
  for (const [tool, input] of [['Bash', { command: `cat /tmp/ledung-${id}.secrets` }], ['Read', { file_path: local }], ['PowerShell', { command: `Get-Content ${local}` }], ['Grep', { pattern: 'x', path: path.dirname(local) }]] as const) {
    assert.match(matchSensitive(tool, input as Record<string, unknown>)?.rule ?? '', /locked secrets/, tool);
  }
  assert.equal(matchSensitive('Bash', { command: 'echo "$NPM_TOKEN" | wc -c' }), null, 'using the variable is not reading the file');
  // Even inside a project folder (a project under the temp folder), the viewer refuses it.
  const dir = tmp('ledung-secrets-0a1b2c3d-');
  try {
    fs.writeFileSync(path.join(dir, `ledung-${id}.secrets`), "export A='x'\n");
    assert.throws(() => readProjectFile(dir, `ledung-${id}.secrets`), FileError);
  } finally {
    removeTemp(dir);
  }
});

test("a local session's runtime files: the env file sources the values file, which the shell reads anew before each command; quoting survives any value", async () => {
  const dir = tmp();
  try {
    const rt = new LocalSecretRuntime(path.join(dir, 'rt'), 'f0e1d2c3-0000-4000-8000-000000000001', null);
    const tricky = `it's "quoted" $HOME \`x\` \\ and\nnewline`;
    rt.prepare(rt.envScript(['OLD']));
    await rt.write([{ env: 'TRICKY', value: tricky }]);
    assert.ok(!fs.readFileSync(rt.envFile, 'utf8').includes(tricky), 'the env file holds no value');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'rt')).mode & 0o077, 0, 'a private folder');
    const envFile = rt.envFile.replace(/\\/g, '/');
    const runner = new LocalRunner({ name: 'p', runner: 'local', path: dir } as never);
    const read = async () => (await startShell(runner.shell(`. '${envFile}'; printf '%s|%s' "$TRICKY" "\${OLD-unset}"`, 'bash', { ...process.env, OLD: 'from-launch' } as Record<string, string>)).done);
    const r = await read();
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, `${tricky}|unset`, 'the value exactly; a launch value since removed is unset');
    // A secret added mid-session: the same env file gives it to the next command.
    await rt.write([{ env: 'TRICKY', value: 'changed' }]);
    assert.equal((await read()).stdout, 'changed|unset');
    await rt.clear();
    assert.equal(fs.existsSync(rt.envFile), false);
  } finally {
    removeTemp(dir);
  }
});

test('a session: its launch writes the files and gives Claude Code the env file; changes follow; its end removes them and its "once" secrets', async () => {
  const dir = tmp();
  try {
    const secrets = Secrets.memory();
    const meta = new Map<string, string>();
    const book = metaPlaceBook({ get: (k) => meta.get(k) ?? null, set: (k, v) => void meta.set(k, v) });
    const id = 'a0b1c2d3-0000-4000-8000-000000000002';
    const rt = new LocalSecretRuntime(dir, id, null);
    const live = new SessionSecrets({ secrets, scope: { sessionId: id, project: 'p' }, runtime: rt, book });
    await secrets.add({ sessionId: id, project: 'p' }, 'npm-token', VALUE, 'session');
    const launch = (await live.launch(null))!;
    assert.equal(launch.env.CLAUDE_ENV_FILE, rt.envFile);
    assert.equal(launch.env.NPM_TOKEN, VALUE, 'in the launch environment too (PowerShell, MCP servers)');
    assert.deepEqual(launch.secrets.names, ['NPM_TOKEN']);
    assert.ok(!launch.secrets.script.includes(VALUE));
    assert.deepEqual(book.get(id), { kind: 'local', dir });
    assert.equal(live.list(true)[0]!.reachesNow, true);
    const valuesFile = path.join(dir, `ledung-${id}.secrets`);
    assert.ok(fs.readFileSync(valuesFile, 'utf8').includes('NPM_TOKEN'));

    await secrets.add({ sessionId: id, project: 'p' }, 'otp', '987654', 'once');
    await live.refresh();
    assert.ok(fs.readFileSync(valuesFile, 'utf8').includes('export OTP='));
    const sent = live.forClaude(`use ${secretToken('otp')} and ${secretToken('npm-token')}, not ${VALUE}`);
    assert.equal(sent.text, `use ${secretForClaude('otp')} and ${secretForClaude('npm-token')}, not 🔑npm-token`);
    assert.deepEqual(sent.once, ['otp']);

    // Reattached by a later Ledung: it still reaches the session, from the book.
    const again = new SessionSecrets({ secrets, scope: { sessionId: id, project: 'p' }, runtime: new LocalSecretRuntime(dir, id, null), book });
    again.attached();
    assert.equal(again.list(true)[0]!.reachesNow, true);

    await live.ended();
    assert.equal(fs.existsSync(valuesFile), false);
    assert.equal(fs.existsSync(rt.envFile), false);
    assert.equal(book.get(id), null);
    assert.deepEqual(secrets.list({ sessionId: id, project: 'p' }).map((s) => s.name), ['npm-token'], 'the "once" one went with the end');
    // A session started before #468: no env file, so it gets them from its next start.
    const before = new SessionSecrets({ secrets, scope: { sessionId: id, project: 'p' }, runtime: rt, book });
    before.attached();
    assert.equal(before.list(true)[0]!.reachesNow, false);
  } finally {
    removeTemp(dir);
  }
});

test("at Ledung's start the runtime files of sessions no longer running go, the ones still running stay", async () => {
  const dir = tmp();
  try {
    const meta = new Map<string, string>();
    const book = metaPlaceBook({ get: (k) => meta.get(k) ?? null, set: (k, v) => void meta.set(k, v) });
    const dead = 'deadbeef-0000-4000-8000-000000000003';
    const alive = 'a11ce000-0000-4000-8000-000000000004';
    for (const id of [dead, alive]) {
      const rt = new LocalSecretRuntime(dir, id, null);
      rt.prepare(rt.envScript([]));
      await rt.write([{ env: 'A', value: 'x' }]);
      book.set(id, { kind: 'local', dir });
    }
    // One the book lost track of (a crash before it was recorded) goes too.
    fs.writeFileSync(path.join(dir, 'ledung-0dd00000-0000-4000-8000-000000000005.secrets'), "export A='x'\n");
    await cleanStaleRuntime({ book, live: new Set([alive]), localDir: dir, containers: [], log: () => {} });
    assert.deepEqual([...localRuntimeSessions(dir).keys()], [alive]);
    assert.ok(book.get(alive) && !book.get(dead));
  } finally {
    removeTemp(dir);
  }
});

test('a container session: values reach the container on stdin, never in docker\'s arguments; the launch passes them by name and writes the env file inside', async () => {
  const calls: { args: string[]; input: string | null }[] = [];
  const rt = new DockerSecretRuntime({ container: 'box', user: 'dev' }, 'c0ffee00-0000-4000-8000-000000000006', async (args, input) => void calls.push({ args, input }));
  await rt.write([{ env: 'NPM_TOKEN', value: VALUE }]);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.args.join(' ').includes(VALUE), 'not on the command line');
  assert.equal(calls[0]!.input, exportLines([{ env: 'NPM_TOKEN', value: VALUE }]));
  assert.deepEqual(calls[0]!.args.slice(0, 5), ['exec', '-i', '-u', 'dev', 'box']);
  assert.match(calls[0]!.args.at(-1)!, /umask 077; t=\$\(mktemp \/tmp\/ledung-XXXXXX\) && cat > "\$t" && mv -f "\$t" '\/tmp\/ledung-c0ffee00-[^']+\.secrets'/);

  const runner = new DockerRunner({ name: 'c', runner: 'docker', container: 'box', pathInContainer: '/work', user: 'dev' } as never, 'c0ffee00-0000-4000-8000-000000000006');
  const script = rt.envScript(['NPM_TOKEN']);
  const spec = runner.launchSpec({ command: 'claude', args: ['--x'], cwd: '/work', env: { ...process.env, NPM_TOKEN: VALUE, CLAUDE_ENV_FILE: rt.envFile } as Record<string, string>, signal: new AbortController().signal } as never,
    { names: ['NPM_TOKEN'], envFile: rt.envFile, script });
  const all = spec.args.join(' ');
  assert.ok(!all.includes(VALUE), 'the value is not in docker\'s arguments');
  assert.ok(spec.args.includes('NPM_TOKEN'), 'passed by name');
  assert.equal(spec.env.NPM_TOKEN, VALUE, 'docker reads it from its own environment');
  assert.ok(all.includes(containerEnvFilePart(rt.envFile, script)), 'the env file is written inside the container');
  // A "!" command in the container: the same.
  const bang = runner.shell('echo "$NPM_TOKEN"', 'bash', { NPM_TOKEN: VALUE }, ['NPM_TOKEN']);
  assert.ok(!bang.args.join(' ').includes(VALUE) && bang.args.includes('NPM_TOKEN'));

  // The clean-up lists and removes only other sessions' files, in one call each.
  const seen: string[][] = [];
  const removed = await cleanContainer({ container: 'box' }, new Set(['c0ffee00-0000-4000-8000-000000000006']), async (args) => {
    seen.push(args);
    return { stdout: '/tmp/ledung-c0ffee00-0000-4000-8000-000000000006.secrets\n/tmp/ledung-deadbeef-0000-4000-8000-000000000007.env\n' };
  });
  assert.equal(removed, 1);
  assert.match(seen[1]!.at(-1)!, /^rm -f '\/tmp\/ledung-deadbeef-[^']+\.env'$/);
});

test('a local session gets the env file and the values only through its environment, never its arguments', () => {
  const runner = new LocalRunner({ name: 'p', runner: 'local', path: os.tmpdir() } as never);
  const spec = runner.launchSpec({ command: 'claude', args: ['--x'], cwd: os.tmpdir(), env: { PATH: '/x', NPM_TOKEN: VALUE, CLAUDE_ENV_FILE: '/f.env', LEDUNG_CONFIG: 'real' } as Record<string, string>, signal: new AbortController().signal } as never);
  assert.ok(!spec.args.join(' ').includes(VALUE));
  assert.equal(spec.env.NPM_TOKEN, VALUE);
  assert.equal(spec.env.CLAUDE_ENV_FILE, '/f.env');
  assert.equal(spec.env.LEDUNG_CONFIG, undefined);
});
