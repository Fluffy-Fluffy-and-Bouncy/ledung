// Ledung's tray icon (issue #347): the server's side, with a fake helper in place of PowerShell or osascript. The
// helper scripts themselves need a screen; they are checked by hand (docs/steps/tray-icon.md, "Testing on the Mac").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { exitQuestion, helperSpawn, statusLine, tipLine, Tray, TraySwitch, trayKind, type TrayCounts, type TrayOptions } from '../src/platform/tray.ts';
import { MAC_TRAY_SCRIPT } from '../src/platform/tray-mac.ts';
import { WINDOWS_TRAY_SCRIPT } from '../src/platform/tray-windows.ts';

/** A helper that only records what it is told and says what the test makes it say. */
class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  lines: unknown[] = [];
  ended = false;
  killed = false;
  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        this.lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    this.stdin.on('finish', () => { this.ended = true; });
  }
  say(word: string): void { this.stdout.write(`${word}\n`); }
  die(code = 1): void { this.emit('exit', code); }
  kill(): boolean { this.killed = true; return true; }
  unref(): void {}
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function setup(over: Partial<TrayOptions> = {}) {
  const helpers: FakeHelper[] = [];
  const counts: TrayCounts = { working: 0, waiting: 0 };
  const calls: string[] = [];
  const logs: string[] = [];
  const tray = new Tray({
    kind: 'windows', address: '127.0.0.1:4396', iconFile: 'icon.png', canRestart: true,
    counts: () => ({ ...counts }),
    onOpen: () => calls.push('open'), onRestart: () => calls.push('restart'), onExit: () => calls.push('exit'),
    log: (l) => logs.push(l),
    spawn: () => {
      const h = new FakeHelper();
      helpers.push(h);
      return h as unknown as ChildProcess;
    },
    throttleMs: 30, retryMs: 40,
    ...over,
  });
  return { tray, helpers, counts, calls, logs };
}

test('the texts the icon shows', () => {
  assert.equal(statusLine({ working: 0, waiting: 0 }), 'Nothing working');
  assert.equal(statusLine({ working: 3, waiting: 2 }), '3 working · 2 waiting for you');
  assert.equal(statusLine({ working: 0, waiting: 1 }), '1 waiting for you');
  assert.equal(tipLine('127.0.0.1:41579', 0), 'Ledung · 127.0.0.1:41579');
  assert.equal(tipLine('127.0.0.1:41579', 2), 'Ledung · 127.0.0.1:41579 · 2 waiting for you');
  assert.equal(exitQuestion(3), '3 sessions are working. Exiting Ledung stops them; you can resume them after the next start.');
  assert.equal(exitQuestion(1), '1 session is working. Exiting Ledung stops it; you can resume it after the next start.');
  assert.equal(trayKind('win32'), 'windows');
  assert.equal(trayKind('darwin'), 'mac');
  assert.equal(trayKind('linux'), null);
});

test('the helper is told the state at start and again only when it changes, at most once per interval', async () => {
  const { tray, helpers, counts } = setup();
  tray.start();
  assert.equal(helpers.length, 1);
  await tick();
  const h = helpers[0]!;
  assert.deepEqual(h.lines, [{ tip: 'Ledung · 127.0.0.1:4396', status: 'Nothing working', address: '127.0.0.1:4396', waiting: 0, restart: true }]);
  // Unchanged: nothing sent.
  tray.changed();
  await tick(60);
  assert.equal(h.lines.length, 1);
  // Several changes in a burst: one line, with the latest counts.
  counts.working = 2;
  tray.changed();
  counts.waiting = 1;
  tray.changed();
  await tick(60);
  assert.equal(h.lines.length, 2);
  assert.deepEqual(h.lines[1], { tip: 'Ledung · 127.0.0.1:4396 · 1 waiting for you', status: '2 working · 1 waiting for you', address: '127.0.0.1:4396', waiting: 1, restart: true });
  tray.stop();
});

test('only the fixed words are acted on; Restart only where a launcher starts Ledung again', async () => {
  const { tray, helpers, calls } = setup();
  tray.start();
  const h = helpers[0]!;
  for (const w of ['open', 'OPEN', 'open now', 'stop', '{"exit":true}', '']) h.say(w);
  h.say('restart');
  await tick();
  assert.deepEqual(calls, ['open', 'restart']);
  tray.stop();

  const noLauncher = setup({ canRestart: false });
  noLauncher.tray.start();
  noLauncher.helpers[0]!.say('restart');
  await tick();
  assert.deepEqual(noLauncher.calls, []);
  assert.equal((noLauncher.helpers[0]!.lines[0] as { restart: boolean }).restart, false);
  noLauncher.tray.stop();
});

test('Exit stops at once with nothing working, and asks first, counted now, when sessions are working', async () => {
  const { tray, helpers, counts, calls } = setup();
  tray.start();
  const h = helpers[0]!;
  h.say('exit');
  await tick();
  assert.deepEqual(calls, ['exit']);
  calls.length = 0;
  // Working since the last state line: still asked, as the count is taken when Exit is chosen.
  counts.working = 3;
  h.say('exit');
  await tick();
  assert.deepEqual(calls, []);
  assert.deepEqual(h.lines.at(-1), { ask: exitQuestion(3) });
  // Cancel sends nothing; Exit Ledung in the dialog sends exit-confirmed.
  h.say('exit-confirmed');
  await tick();
  assert.deepEqual(calls, ['exit']);
  tray.stop();
});

test('stopping tells the helper to stop and closes its input, so it removes the icon; words after that are ignored', async () => {
  const { tray, helpers, calls } = setup();
  tray.start();
  const h = helpers[0]!;
  tray.stop();
  await tick();
  assert.deepEqual(h.lines.at(-1), { stop: true });
  assert.equal(h.ended, true);
  h.say('open');
  await tick();
  assert.deepEqual(calls, []);
  // Its exit after the stop is expected: not logged, not started again.
  h.die(0);
  await tick(80);
  assert.equal(helpers.length, 1);
});

test('a helper that dies on its own is started again once, then left off until the next start', async () => {
  const { tray, helpers, logs } = setup();
  tray.start();
  helpers[0]!.die(1);
  await tick(10);
  assert.equal(helpers.length, 1, 'not at once');
  await tick(80);
  assert.equal(helpers.length, 2, 'once, after the wait');
  assert.equal((helpers[1]!.lines[0] as { status: string }).status, 'Nothing working', 'the new one is told the state');
  helpers[1]!.die(1);
  await tick(100);
  assert.equal(helpers.length, 2);
  assert.match(logs.join('\n'), /helper ended \(code 1\)/);
  assert.match(logs.at(-1)!, /left off until Ledung starts again/);
  // Switched off and on (Settings) is a new start: one more try.
  tray.stop();
  tray.start();
  assert.equal(helpers.length, 3);
  tray.stop();
});

test('a helper that cannot start is logged and does not stop Ledung', async () => {
  const { tray, logs } = setup({ spawn: () => { throw new Error('no desktop'); } });
  tray.start();
  assert.match(logs[0]!, /could not start: no desktop/);
  tray.stop();
});

test('the switch: on by default, off for a Ledung with its own data folder unless the config says so; Settings wins', async () => {
  const meta = new Map<string, string>();
  const store = { get: (k: string) => meta.get(k) ?? null, set: (k: string, v: string) => { meta.set(k, v); } };
  const make = (ownDataDir: boolean, configured?: boolean) => {
    const s = setup();
    return { ...s, sw: new TraySwitch({ tray: s.tray, meta: store, configured: () => configured, ownDataDir }) };
  };
  assert.equal(make(false).sw.wanted(), true);
  assert.equal(make(true).sw.wanted(), false);
  assert.equal(make(true, true).sw.wanted(), true);
  assert.equal(make(false, false).sw.wanted(), false);

  const { sw, helpers } = make(true, true);
  sw.apply();
  assert.equal(helpers.length, 1);
  assert.deepEqual(sw.set(false), { kind: 'windows', on: false });
  assert.equal(helpers[0]!.ended || (await tick(), helpers[0]!.ended), true, 'off removes the icon at once');
  assert.equal(meta.get('tray-icon'), 'off');
  // Kept: the config's true no longer turns it on, and a restart (a new switch on the same data) keeps it off.
  assert.equal(make(true, true).sw.wanted(), false);
  assert.deepEqual(sw.set(true), { kind: 'windows', on: true });
  assert.equal(helpers.length, 2);
  sw.set(false);

  const none = new TraySwitch({ tray: null, meta: store, configured: () => undefined, ownDataDir: false });
  assert.deepEqual(none.view(), { kind: null, on: false });
  assert.throws(() => none.set(true), /no tray icon/);
});

test('the helper outlives Ledung long enough to remove its own icon (acceptance round 1, point 5)', () => {
  // Windows: PowerShell is started by cmd.exe, so it isn't in the job Node kills its own children with on exit (a
  // killed helper's icon stays drawn). The script goes in the environment, cmd.exe's command line being too short.
  const [cmd, args, options] = helperSpawn('windows', 'icon.png');
  assert.match(cmd, /System32[\\/]cmd\.exe$/i);
  assert.equal(options.detached, undefined, 'detached, Windows PowerShell has no console and exits at once');
  assert.equal(options.windowsHide, true);
  assert.equal(options.windowsVerbatimArguments, true);
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(args[3]!, /^""[^"]+System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe" -NoProfile -NonInteractive -WindowStyle Hidden -Command iex \$env:LEDUNG_TRAY_SCRIPT"$/);
  assert.ok(args[3]!.length < 8000, 'within cmd.exe\'s command line');
  assert.equal(options.env?.LEDUNG_TRAY_SCRIPT, WINDOWS_TRAY_SCRIPT);
  assert.equal(options.env?.LEDUNG_TRAY_PARENT, String(process.pid));
  assert.equal(options.env?.LEDUNG_TRAY_ICON, 'icon.png');
  // Mac: osascript directly; macOS doesn't end children with their parent, and it checks the parent itself.
  const [osa, , macOptions] = helperSpawn('mac', 'tray-mac.png');
  assert.equal(osa, '/usr/bin/osascript');
  assert.equal(macOptions.env?.LEDUNG_TRAY_PARENT, String(process.pid));
});

test('every way out of the helper scripts removes the icon: {stop}, end of input, parent gone', () => {
  // Windows: Quit hides and disposes the icon, reached from {stop}, the end of input and the parent check; a finally
  // around the message loop covers anything else.
  const win = WINDOWS_TRAY_SCRIPT.replace(/\s+/g, ' ');
  for (const part of [
    'function Remove-Icon { try { $icon.Visible = $false } catch { } try { $icon.Dispose() } catch { } }',
    'if ($null -ne $script:dialog) { $script:dialog.Close() } Remove-Icon [System.Windows.Forms.Application]::Exit()',
    'if ($m.stop) { Quit; return }',
    'if ($null -eq $line) { Quit; return }',
    'if ($parent.HasExited) { Quit; return }',
    'try { [System.Windows.Forms.Application]::Run() } finally { Remove-Icon }',
  ]) assert.ok(win.includes(part), part);
  // Mac: quit() removes the status item, from {stop}, the end of input and the parent check.
  const mac = MAC_TRAY_SCRIPT.replace(/\s+/g, ' ');
  for (const part of [
    'function quit() { if (item) $.NSStatusBar.systemStatusBar.removeStatusItem(item); $.exit(0); }',
    'if (m.stop) { quit(); return; }',
    'data.length === 0) { quit(); return; }',
    'if (!parentAlive()) quit();',
  ]) assert.ok(mac.includes(part), part);
});
