// The `!` prefix in the message box (issue #212, decided by Martin 2026-10-18 18:09, Ledung question #294):
// the person's command runs in the session's folder, ended with everything it started on its time limit, and
// its output reaches Claude as context in Claude Code's own bash-mode form, with no model turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashModeText, bangRefusal } from '../src/sessions/bang.ts';
import { bangAsk, bangCommand, shellFooter } from '../src/shared/bang.ts';
import { gitBashPath, localShell, startShell } from '../src/runners/shell-run.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { commandLines } from '../src/platform/process-tree.ts';
import { NO_LOCKDOWN } from '../src/projects/lockdown.ts';
import { Session } from '../src/sessions/session.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-bang-')));
/** Windows may hold a folder a moment after a process in it ended: retried, and never the test's failure. */
const clean = (dir: string) => {
  try {
    removeTemp(dir);
  } catch {
    // Left in the temp folder.
  }
};
const node = JSON.stringify(process.execPath).replace(/\\\\/g, '/');
/** A node one-liner as a shell command, quoted for bash (the default shell everywhere, decision 6). */
const nodeRun = (script: string) => `${node} -e '${script}'`;

test("Claude gets Claude Code's own bash-mode form: <bash-input>, then <bash-stdout> and <bash-stderr>", () => {
  // The strings in the bundled claude.exe: `<bash-input>${r}</bash-input>`, then
  // `<bash-stdout>${C}</bash-stdout><bash-stderr>${Ut(P)}</bash-stderr>` (issue #212, What Claude Code does).
  const ok = bashModeText('git status', { stdout: 'On branch main\n', stderr: '', exitCode: 0, cut: null, truncated: false });
  assert.equal(ok, '<bash-input>git status</bash-input>\n<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>');
  const failed = bashModeText('false', { stdout: '', stderr: 'boom\n', exitCode: 1, cut: null, truncated: false });
  assert.match(failed, /<bash-stderr>boom\nExit code 1<\/bash-stderr>$/);
  const cut = bashModeText('sleep 999', { stdout: '', stderr: '', exitCode: null, cut: 'timeout', truncated: true }, 120000);
  assert.match(cut, /timed out after 120 s; it and everything it started were ended/);
  assert.match(cut, /Output cut at/);
});

test('a line starting with "!" is a command; "!" alone and ordinary text are messages', () => {
  assert.equal(bangCommand('!git status'), 'git status');
  assert.equal(bangCommand('! ls -la '), 'ls -la');
  assert.equal(bangCommand('!'), null);
  assert.equal(bangCommand('hello !there'), null);
  assert.equal(bangCommand('Run !this'), null);
});

test('the ask before a sensitive command says "This matches <rule>; run it?" (decision 3)', () => {
  assert.equal(bangAsk('a git push'), 'This matches a git push; run it?');
  assert.equal(bangAsk('command matches /\\bdeploy\\b/'), 'This matches /\\bdeploy\\b/; run it?');
});

test('"!" is refused in a level B project, and in another project\'s session inside or above a locked project\'s folder (decision 5)', () => {
  const root = tmp();
  const locked = path.join(root, 'locked');
  const plain = path.join(root, 'plain');
  fs.mkdirSync(path.join(locked, 'sub'), { recursive: true });
  fs.mkdirSync(plain);
  const others = [{ name: 'secret', config: { runner: 'local', path: locked } }];
  const local = { name: 'mine', runner: 'local' as const, lockdown: NO_LOCKDOWN };
  assert.match(bangRefusal({ ...local, lockdown: { ...NO_LOCKDOWN, level: 'B' } }, plain, []) ?? '', /level B/);
  assert.match(bangRefusal(local, path.join(locked, 'sub'), others) ?? '', /while "secret" is locked: .* is inside its folder/);
  assert.match(bangRefusal(local, root, others) ?? '', /while "secret" is locked: .* holds its folder/);
  assert.equal(bangRefusal(local, plain, others), null, 'a folder beside it');
  assert.equal(bangRefusal({ ...local, runner: 'docker' }, '/work', others), null, "a container doesn't see this computer's folders");
  assert.equal(bangRefusal({ ...local, name: 'secret', lockdown: { ...NO_LOCKDOWN, level: 'A' } }, locked, others), null, 'the locked project itself, at level A');
  clean(root);
});

test('on Windows the shell is Git Bash, found next to git as Claude Code finds it, or PowerShell when the config says so (decision 6)', () => {
  const files = new Set(['C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\bash.exe']);
  const exists = (f: string) => files.has(path.win32.normalize(f));
  if (process.platform === 'win32') assert.equal(gitBashPath({ PATH: 'C:\\Windows;C:\\Git\\cmd' }, exists), path.resolve('C:\\Git\\bin\\bash.exe'));
  assert.equal(gitBashPath({ PATH: '', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' }, exists), 'C:\\Git\\bin\\bash.exe');
  assert.equal(localShell('ls', 'powershell', 'win32').name, 'PowerShell');
  assert.equal(localShell('ls', 'powershell', 'linux').name, 'bash', 'the setting is for Windows only');
  if (process.platform === 'win32') assert.equal(localShell('ls', 'bash', 'win32').name, 'Git Bash');
});

test("it runs in the session's folder, with the session's environment and no LEDUNG_* settings", async () => {
  const dir = tmp();
  const runner = new LocalRunner({ name: 'p', runner: 'local', path: dir } as never);
  const env = { ...process.env, LEDUNG_CONFIG: 'real.json', ACCOUNT_TOKEN: 'mine' } as Record<string, string>;
  const script = 'process.stdout.write([process.cwd(), process.env.LEDUNG_CONFIG, process.env.ACCOUNT_TOKEN].join("|"))';
  const r = await startShell(runner.shell(nodeRun(script), 'bash', env)).done;
  assert.equal(r.exitCode, 0, r.stderr);
  const [cwd, ledung, account] = r.stdout.split('|');
  assert.equal(path.resolve(cwd!), dir);
  assert.equal(ledung, '', 'no LEDUNG_*');
  assert.equal(account, 'mine', 'the rest of the session environment, its login included');
  clean(dir);
});

test("in a container project it runs through docker exec, as the project's user, in its folder, with a tag of its own", async () => {
  const { DockerRunner } = await import('../src/runners/docker-runner.ts');
  const runner = new DockerRunner({ name: 'c', runner: 'docker', container: 'box', pathInContainer: '/work', user: 'dev' } as never, 'sid');
  const spec = runner.shell('git status; echo "$HOME"', 'powershell', { PATH: '/x', LEDUNG_CONFIG: 'real.json', CLAUDE_CODE_OAUTH_TOKEN: 'secret-token' });
  assert.equal(spec.command, 'docker');
  const a = spec.args;
  assert.deepEqual(a.slice(0, 5), ['exec', '-u', 'dev', '-w', '/work']);
  // The login goes by name only: docker reads its value from its own environment, never from the command line.
  assert.ok(a.includes('CLAUDE_CODE_OAUTH_TOKEN') && !a.join(' ').includes('secret-token'));
  assert.equal(spec.env.CLAUDE_CODE_OAUTH_TOKEN, 'secret-token');
  assert.equal(spec.env.LEDUNG_CONFIG, undefined, 'no LEDUNG_* for docker either');
  assert.ok(a.includes('LEDUNG_TAG=ledung-sid-sh1-'), a.join(' '));
  assert.equal(a.at(-1), 'git status; echo "$HOME"', 'the command whole, as an argument: no quoting to get wrong');
  assert.ok(a.includes('box'));
  // Each command has its own tag, so ending one never ends the session's Claude Code (tag ledung-sid).
  assert.ok(runner.shell('ls', 'bash', {}).args.includes('LEDUNG_TAG=ledung-sid-sh2-'));
  assert.ok(spec.endInside, 'what it started in the container is ended there');
});

test('the exit code and stderr come back; output above the cap is cut, with a note', async () => {
  const dir = tmp();
  const runner = new LocalRunner({ name: 'p', runner: 'local', path: dir } as never);
  const failed = await startShell(runner.shell(`${nodeRun('process.stderr.write("bad"); process.exit(3)')}`, 'bash', process.env as never)).done;
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.stderr, 'bad');
  const big = await startShell(runner.shell(nodeRun('process.stdout.write("x".repeat(5000))'), 'bash', process.env as never), { maxChars: 1000 }).done;
  assert.equal(big.stdout.length, 1000);
  assert.equal(big.truncated, true);
  clean(dir);
});

/** Whether a process with this marker on its command line is still running. */
const stillThere = async (marker: string) => (await commandLines()).some((l) => l.includes(marker) && !l.includes('commandLines'));

test('past its time limit it is ended with everything it started, and the result says it was cut off', async () => {
  const dir = tmp();
  const runner = new LocalRunner({ name: 'p', runner: 'local', path: dir } as never);
  const marker = `ledung-bang-timeout-${process.pid}-${Date.now()}`;
  // A command that starts a child of its own and then waits: both must go.
  const script = `require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)", "${marker}"], { stdio: "ignore" }); setTimeout(()=>{}, 60000)`;
  const run = startShell(runner.shell(nodeRun(script), 'bash', process.env as never), { timeoutMs: 6000 });
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(await stillThere(marker), true, 'the probe sees the child while it runs');
  const r = await run.done;
  assert.equal(r.cut, 'timeout');
  assert.equal(r.exitCode, null);
  assert.ok(r.durationMs >= 6000 && r.durationMs < 30000, `${r.durationMs} ms`);
  assert.equal(await stillThere(marker), false, 'the child it started was ended too');
  clean(dir);
});

test('what a command leaves behind when it exits is ended too: nothing could stop it later', async () => {
  const dir = tmp();
  const runner = new LocalRunner({ name: 'p', runner: 'local', path: dir } as never);
  const marker = `ledung-bang-left-${process.pid}-${Date.now()}`;
  const script = `require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)", "${marker}"], { stdio: "ignore", detached: true }).unref(); setTimeout(()=>{}, 5000)`;
  const run = startShell(runner.shell(nodeRun(script), 'bash', process.env as never));
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(await stillThere(marker), true, 'the probe sees it while the command runs');
  const r = await run.done;
  assert.equal(r.cut, null);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(await stillThere(marker), false, 'the process it left behind was ended');
  clean(dir);
});

test('Stop ends a running command with everything it started', async () => {
  const dir = tmp();
  const runner = new LocalRunner({ name: 'p', runner: 'local', path: dir } as never);
  const marker = `ledung-bang-stop-${process.pid}-${Date.now()}`;
  const script = `require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)", "${marker}"], { stdio: "ignore" }); setTimeout(()=>{}, 60000)`;
  const run = startShell(runner.shell(nodeRun(script), 'bash', process.env as never));
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await stillThere(marker), true, 'the probe sees the child while it runs');
  await run.stop('stopped');
  const r = await run.done;
  assert.equal(r.cut, 'stopped');
  assert.equal(await stillThere(marker), false, 'the child it started was ended too');
  assert.match(shellFooter({ ...r, command: 'x', shell: 'Git Bash', cwd: dir, toClaude: true }).text, /^Stopped/);
  clean(dir);
});

/** A Session through start() with a stand-in for the SDK's query that hands over what Ledung sends Claude. */
async function session(dir: string) {
  const store = new Store(openDatabase(':memory:'));
  const info = store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session' });
  let prompt: AsyncIterable<SDKUserMessage> | null = null;
  let deliver: ((m: unknown) => void) | null = null;
  const stream = {
    accountInfo: async () => ({}),
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((resolve) => { deliver = (m) => resolve({ value: m, done: false }); }) }),
  };
  const turns: string[] = [];
  const s = new Session({
    info, store, publish: () => {}, userName: 'Simon',
    management: new Proxy({}, { get: (_, k) => (k === 'questionTiers' ? () => [] : () => undefined) }) as never,
    runner: new LocalRunner({ name: 'p', runner: 'local', path: dir } as never),
    gate: { mayStart: () => true, started: (_id, trigger) => turns.push(trigger), ended: () => {} },
    query: ((args: { prompt: AsyncIterable<SDKUserMessage> }) => { prompt = args.prompt; return stream; }) as never,
  });
  await s.start();
  const sent = prompt![Symbol.asyncIterator]();
  /** A line from Claude Code, through the host's path and then the SDK's. */
  const fromClaude = async (m: Record<string, unknown>) => {
    (s as unknown as { onHostLine(seq: number, at: number, json: string): void }).onHostLine(Date.now(), Date.now(), JSON.stringify(m));
    deliver!(m);
    await new Promise((r) => setTimeout(r, 20));
  };
  return { s, store, sent, turns, fromClaude };
}

test('the output goes to Claude as one shouldQuery: false message, with no turn, and the chat keeps its block', async () => {
  const dir = tmp();
  const { s, store, sent, turns, fromClaude } = await session(dir);
  await s.runShell(nodeRun('process.stdout.write("hello from bang")'), 'bash');
  const m = (await sent.next()).value as SDKUserMessage;
  assert.equal(m.shouldQuery, false, 'context only: no assistant turn');
  assert.equal(m.message.content, `<bash-input>${nodeRun('process.stdout.write("hello from bang")')}</bash-input>\n<bash-stdout>hello from bang</bash-stdout><bash-stderr></bash-stderr>`);
  assert.deepEqual(turns, [], 'no turn started, so no place under the working limit');
  const block = store.listMessages('s1', { limit: 50 }).find((x) => x.kind === 'shell')!;
  assert.equal(block.data.stdout, 'hello from bang');
  assert.equal(block.data.exitCode, 0);
  assert.equal(block.data.cwd, dir);
  assert.equal(block.data.toClaude, true);
  // Claude Code answers such a message with an empty result and no turn (#212 build step 1): not stored, not a turn's end.
  await fromClaude({ type: 'result', subtype: 'success', num_turns: 0, result: '', session_id: 'c', total_cost_usd: 0, usage: {}, modelUsage: {} });
  assert.equal(store.listMessages('s1', { limit: 50 }).filter((x) => x.kind === 'sdk' && x.data.type === 'result').length, 0, 'the empty result is not stored');
  assert.equal(store.listMessages('s1', { limit: 50 }).filter((x) => x.kind === 'event' && /compact/i.test(x.data.text)).length, 0, 'nor taken for a compact');
  clean(dir);
});

test('during a turn the output waits for the turn to end, then goes to Claude before anything else', async () => {
  const dir = tmp();
  const { s, store, sent, turns, fromClaude } = await session(dir);
  s.send('work on it');
  assert.equal(turns.length, 1, 'a real turn started: the "!" output has a turn to wait for');
  assert.equal(((await sent.next()).value as SDKUserMessage).message.content, 'work on it');
  await fromClaude({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'working' }] } });
  assert.equal(store.getSession('s1')!.status, 'running');
  await s.runShell(nodeRun('process.stdout.write("later")'), 'bash');
  let next: SDKUserMessage | null = null;
  void sent.next().then((r) => (next = r.value as SDKUserMessage));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(next, null, 'not while the turn runs');
  await fromClaude({ type: 'result', subtype: 'success', num_turns: 1, result: 'done', session_id: 'c', total_cost_usd: 0, usage: {}, modelUsage: {} });
  assert.equal(next!.shouldQuery, false);
  assert.match(String(next!.message.content), /<bash-stdout>later<\/bash-stdout>/);
  clean(dir);
});

test("a \"!\" message Claude Code merged into the next turn leaves no empty result due: a later one isn't swallowed (review-212 minor 1)", async () => {
  const dir = tmp();
  const { s, store, sent, fromClaude } = await session(dir);
  await s.runShell(nodeRun('process.stdout.write("merged")'), 'bash');
  assert.equal(((await sent.next()).value as SDKUserMessage).shouldQuery, false);
  // No empty result for it: Claude Code merged it into the next message's turn, which ends with its own result.
  await fromClaude({ type: 'result', subtype: 'success', num_turns: 1, result: 'ok', session_id: 'c', total_cost_usd: 0, usage: {}, modelUsage: {} });
  // A later zero-turn result (here an error) is Claude Code's own: stored, not taken for the "!" message's.
  await fromClaude({ type: 'result', subtype: 'error_during_execution', num_turns: 0, session_id: 'c', total_cost_usd: 0, usage: {}, modelUsage: {} });
  const results = store.listMessages('s1', { limit: 50 }).filter((x) => x.kind === 'sdk' && x.data.type === 'result').map((x) => x.data.subtype);
  assert.deepEqual(results, ['success', 'error_during_execution']);
  clean(dir);
});

test('Restart Ledung ends a running command; the chat says so, and Claude gets nothing', async () => {
  const dir = tmp();
  const { s, store, sent } = await session(dir);
  const running = s.runShell(nodeRun('setTimeout(()=>{}, 60000)'), 'bash');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await s.stopShell('restart'), true);
  await running;
  const block = store.listMessages('s1', { limit: 50 }).find((x) => x.kind === 'shell')!;
  assert.equal(block.data.cut, 'restart');
  assert.equal(block.data.toClaude, false);
  assert.match(shellFooter(block.data).text, /^Ended by Restart Ledung\. .*Claude did not get it\.$/);
  let next: unknown = null;
  void sent.next().then((r) => (next = r.value));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(next, null, 'nothing was sent to Claude');
  clean(dir);
});

test('one "!" command at a time in a session', async () => {
  const dir = tmp();
  const { s } = await session(dir);
  const first = s.runShell(nodeRun('setTimeout(()=>{}, 1500)'), 'bash');
  assert.throws(() => s.runShell('echo again', 'bash'), /still running/);
  assert.equal(s.info.shell?.command, nodeRun('setTimeout(()=>{}, 1500)'), 'the box can show it running');
  await first;
  assert.equal(s.info.shell, null);
  clean(dir);
});

test('through Ledung: a session above a locked project refuses "!" with a plain message, and a sensitive match runs only once confirmed', async () => {
  const { SessionManager } = await import('../src/sessions/manager.ts');
  const { parseConfig } = await import('../src/config.ts');
  const root = tmp();
  fs.mkdirSync(path.join(root, 'locked'));
  fs.mkdirSync(path.join(root, 'plain'));
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    projects: [
      { name: 'workspace', runner: 'local', path: root },
      { name: 'secret', runner: 'local', path: path.join(root, 'locked'), lockdown: { level: 'A' } },
      { name: 'plain', runner: 'local', path: path.join(root, 'plain'), sensitive: { commandPatterns: ['\\bdeploy\\b'] } },
    ],
  }), store, () => {}));
  store.createSession({ id: 'w', project: 'workspace', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
  store.createSession({ id: 'p', project: 'plain', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
  await assert.rejects(manager.runShell('w', 'cat locked/notes.txt', true), /"!" commands are off in this session while "secret" is locked/);
  assert.match(manager.shellCheck('w', 'ls').refused ?? '', /secret/);
  // The page asks first: the check names the rule, and an unconfirmed run is refused before anything starts.
  assert.equal(manager.shellCheck('p', 'deploy now').refused, null);
  assert.match(manager.shellCheck('p', 'deploy now').rule ?? '', /deploy/);
  assert.equal(manager.shellCheck('p', 'git status').rule, null);
  await assert.rejects(manager.runShell('p', 'deploy now', false), /This matches .*deploy.*; confirm it/);
  assert.equal(store.getSession('p')!.status, 'starting', 'nothing was started or resumed');
  clean(root);
});

test('people only: no Ledung tool runs a "!" command', () => {
  // The tools a manager or session has are in tools.ts and what they call in management.ts; neither reaches the shell.
  for (const file of ['src/sessions/tools.ts', 'src/sessions/management.ts']) {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
    assert.equal(/runShell|stopShell|startShell/.test(source), false, file);
  }
});
