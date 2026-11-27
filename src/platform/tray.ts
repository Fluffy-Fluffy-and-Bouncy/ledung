// Ledung's tray icon (issue #347, docs/steps/tray-icon.md): an icon in Windows' notification area or the Mac's menu
// bar that says Ledung runs, opens its page, and restarts or exits it.
//
// The Ledung server starts the helper and is its only owner (choice B): when the server ends, however it ends, the
// helper's input closes and it removes the icon. The helper is a script run by the system's own signed program,
// Windows PowerShell or osascript (choice A), and talks to Ledung only over its stdin and stdout:
// - Ledung → helper, a JSON line: the state ({tip, status, address, waiting, restart}) when it changes, at most once
//   a second, {ask} with the Exit question's text, or {stop}: remove the icon and exit.
// - Helper → Ledung: one of the fixed words in WORDS; anything else is dropped.
// It never gets the sign-in token: Open Ledung sends "open", and the server opens the sign-in link (choice D).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { TrayView } from '../shared/protocol.ts';
import { MAC_TRAY_SCRIPT } from './tray-mac.ts';
import { WINDOWS_TRAY_SCRIPT } from './tray-windows.ts';

export type TrayKind = 'windows' | 'mac';

/** Where Ledung has a tray icon: Windows and macOS; Linux later, as its own issue (choice E). */
export function trayKind(platform: NodeJS.Platform = process.platform): TrayKind | null {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : null;
}

export interface TrayCounts {
  /** Sessions in a turn (the session manager's working count). */
  working: number;
  /** What waits for the person: the page's and phone push's rule (src/shared/waiting.ts). */
  waiting: number;
}

/** The menu's first line: "3 working · 2 waiting for you", or "Nothing working". */
export function statusLine({ working, waiting }: TrayCounts): string {
  const parts = [];
  if (working) parts.push(`${working} working`);
  if (waiting) parts.push(`${waiting} waiting for you`);
  return parts.length ? parts.join(' · ') : 'Nothing working';
}

/** The Windows tooltip: "Ledung · 127.0.0.1:41579", and "· 2 waiting for you" when something waits. */
export function tipLine(address: string, waiting: number): string {
  return `Ledung · ${address}${waiting ? ` · ${waiting} waiting for you` : ''}`;
}

/** The Exit question, asked only when sessions are working (choice C). */
export function exitQuestion(working: number): string {
  const they = working === 1 ? '1 session is working' : `${working} sessions are working`;
  return `${they}. Exiting Ledung stops ${working === 1 ? 'it' : 'them'}; you can resume ${working === 1 ? 'it' : 'them'} after the next start.`;
}

/** The only words the helper may send; anything else is dropped (the design's Security section). */
const WORDS = new Set(['open', 'restart', 'exit', 'exit-confirmed']);

export interface TrayOptions {
  kind: TrayKind;
  /** The page's address as shown, "127.0.0.1:41579". */
  address: string;
  /** The icon's picture: Ledung's coloured PNG on Windows, the silhouette (template) PNG on the Mac. */
  iconFile: string;
  counts(): TrayCounts;
  /** Whether Restart is offered: only when a launcher starts Ledung again. */
  canRestart: boolean;
  onOpen(): void;
  onRestart(): void;
  onExit(): void;
  log(line: string): void;
  /** For tests: what is started instead of the system's helper. */
  spawn?: () => ChildProcess;
  /** Least time between two state lines (default a second). */
  throttleMs?: number;
  /** After a helper that died on its own, it is started again once after this long (default a minute). */
  retryMs?: number;
}

/**
 * How the helper is started (exported for tests): the system's own programs by their full paths, so neither PATH nor
 * a profile changes what runs. It gets only what it needs, by name: the picture and whose child it is (its second net
 * when the pipe stays open).
 *
 * On Windows it is started through cmd.exe, so that it outlives Ledung long enough to remove its icon. Node puts the
 * children it starts in a job that kills them when Node exits, and a killed process's icon stays drawn until the mouse
 * passes over it (acceptance round 1, point 5: a dead icon after Exit, Stop, Restart or a kill). That job lets its
 * members' own children break away, so PowerShell, started by cmd.exe, is not killed with Ledung: it sees its input end
 * and removes the icon, however Ledung stopped. cmd.exe is killed instead, which costs nothing. Starting PowerShell
 * detached instead doesn't work: without a console Windows PowerShell exits before running anything (tried,
 * 2026-11-17). The script goes in the environment, as cmd.exe's command line is too short for it.
 */
export function helperSpawn(kind: TrayKind, iconFile: string): [string, string[], SpawnOptions] {
  const env: NodeJS.ProcessEnv = { ...process.env, LEDUNG_TRAY_ICON: iconFile, LEDUNG_TRAY_PARENT: String(process.pid) };
  if (kind === 'windows') {
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const ps = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = `"${ps}" -NoProfile -NonInteractive -WindowStyle Hidden -Command iex $env:LEDUNG_TRAY_SCRIPT`;
    return [path.join(system, 'cmd.exe'), ['/d', '/s', '/c', `"${command}"`], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true,
      env: { ...env, LEDUNG_TRAY_SCRIPT: WINDOWS_TRAY_SCRIPT },
    }];
  }
  return ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_TRAY_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env }];
}

export class Tray {
  private readonly opts: TrayOptions;
  private child: ChildProcess | null = null;
  private running = false;
  private retried = false;
  private retry: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private lastSent = '';
  private lastSentAt = 0;

  constructor(opts: TrayOptions) {
    this.opts = opts;
  }

  get kind(): TrayKind {
    return this.opts.kind;
  }

  /** How many helpers were started (for tests). */
  starts = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.retried = false;
    this.launch();
  }

  /** Removes the icon: the helper's input closes and it exits by itself. */
  stop(): void {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    if (this.pending) clearTimeout(this.pending);
    this.retry = this.pending = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    // Said and then the input closed: either makes the helper remove its icon and exit.
    if (child.stdin && !child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ stop: true })}
`);
    // A helper that doesn't go within a few seconds is ended.
    const kill = setTimeout(() => child.kill(), 5000);
    kill.unref();
    child.once('exit', () => clearTimeout(kill));
  }

  /** Something that may change the counts happened: the state is sent shortly if it changed. */
  changed(): void {
    if (!this.child || this.pending) return;
    const wait = Math.max(0, this.lastSentAt + (this.opts.throttleMs ?? 1000) - Date.now());
    this.pending = setTimeout(() => {
      this.pending = null;
      this.sendState();
    }, wait);
    this.pending.unref();
  }

  private launch(): void {
    let child: ChildProcess;
    try {
      child = this.opts.spawn?.() ?? this.spawnHelper();
    } catch (e) {
      this.gone(null, `could not start: ${(e as Error).message}`);
      return;
    }
    this.starts++;
    this.child = child;
    this.lastSent = '';
    // Ledung's own exit must not wait for the icon.
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr] as ({ unref?: () => void } | null)[]) s?.unref?.();
    child.stdin?.on('error', () => {});
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', (l) => this.heard(child, l.trim()));
    let said = '';
    child.stderr?.on('data', (d: Buffer) => { if (said.length < 2000) said += d.toString(); });
    child.on('error', (e) => this.gone(child, e.message));
    child.on('exit', (code) => this.gone(child, `ended (code ${code})${said.trim() ? `: ${said.trim().split(/\r?\n/)[0]}` : ''}`));
    this.sendState();
  }

  private spawnHelper(): ChildProcess {
    return spawn(...helperSpawn(this.opts.kind, this.opts.iconFile));
  }

  private heard(child: ChildProcess, word: string): void {
    if (child !== this.child || !WORDS.has(word)) return;
    if (word === 'open') this.opts.onOpen();
    else if (word === 'restart') { if (this.opts.canRestart) this.opts.onRestart(); }
    else if (word === 'exit-confirmed') this.opts.onExit();
    else {
      // Exit asks first only when sessions are working, counted now, not when the menu was drawn (choice C).
      const { working } = this.opts.counts();
      if (working) this.write({ ask: exitQuestion(working) });
      else this.opts.onExit();
    }
  }

  /** A helper that ended or would not start: logged, and started again once after a minute (the design's Settings). */
  private gone(child: ChildProcess | null, why: string): void {
    if (child && child !== this.child) return;
    this.child = null;
    if (!this.running) return;
    this.opts.log(`Tray icon: the helper ${why}.`);
    if (this.retried) {
      this.opts.log('Tray icon: left off until Ledung starts again.');
      return;
    }
    this.retried = true;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.running && !this.child) this.launch();
    }, this.opts.retryMs ?? 60_000);
    this.retry.unref();
  }

  private sendState(): void {
    const counts = this.opts.counts();
    const state = {
      tip: tipLine(this.opts.address, counts.waiting),
      status: statusLine(counts),
      address: this.opts.address,
      waiting: counts.waiting,
      restart: this.opts.canRestart,
    };
    const line = JSON.stringify(state);
    if (line === this.lastSent) return;
    this.lastSent = line;
    this.lastSentAt = Date.now();
    this.write(state);
  }

  private write(message: object): void {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed) stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/** The meta key of the switch: kept per computer, in the data folder, like the update channel. */
const SWITCH_KEY = 'tray-icon';

/**
 * Settings' switch for the icon (choice F): on by default, but off for a Ledung with its own data folder
 * (LEDUNG_DATA_DIR: throwaway copies and tests), so one started by a session doesn't fill the real tray; the config's
 * "trayIcon" changes that default. Switched in Settings, the choice is kept and wins over both.
 */
export class TraySwitch {
  private readonly tray: Tray | null;
  private readonly meta: { get(key: string): string | null; set(key: string, value: string): void };
  private readonly configured: () => boolean | undefined;
  private readonly ownDataDir: boolean;

  constructor(opts: { tray: Tray | null; meta: TraySwitch['meta']; configured: () => boolean | undefined; ownDataDir: boolean }) {
    this.tray = opts.tray;
    this.meta = opts.meta;
    this.configured = opts.configured;
    this.ownDataDir = opts.ownDataDir;
  }

  wanted(): boolean {
    const saved = this.meta.get(SWITCH_KEY);
    if (saved === 'on' || saved === 'off') return saved === 'on';
    return this.configured() ?? !this.ownDataDir;
  }

  /** Starts or stops the icon to match: at start, and when the config's default changes. */
  apply(): void {
    if (!this.tray) return;
    if (this.wanted()) this.tray.start();
    else this.tray.stop();
  }

  set(on: boolean): TrayView {
    if (!this.tray) throw new Error('This system has no tray icon for Ledung yet.');
    this.meta.set(SWITCH_KEY, on ? 'on' : 'off');
    this.apply();
    return this.view();
  }

  view(): TrayView {
    return { kind: this.tray ? this.tray.kind : null, on: !!this.tray && this.wanted() };
  }
}

/** The icon's picture for this Ledung: the built page's copy, else the source's (as iconFiles in shortcuts.ts). */
export function trayIconFile(kind: TrayKind, app: string): string {
  const name = kind === 'windows' ? 'icon-256.png' : 'tray-mac.png';
  const built = path.join(app, 'web', 'dist', name);
  return fs.existsSync(built) ? built : path.join(app, 'web', 'public', name);
}
