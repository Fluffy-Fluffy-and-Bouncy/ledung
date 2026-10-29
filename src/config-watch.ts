// Live reload of the config file (issue #353): Ledung watches the file and, when it changes, reads and checks it with
// the same schema as at start. Live settings apply at once; restart-only ones are named for the page; a bad file is
// refused and the running settings stay. Only the file drives it: no API writes the config.
import fs from 'node:fs';
import path from 'node:path';
import { changedSettings, configProblem, SETTING_RELOAD, withLiveSettings, type LedungConfig, type SettingName } from './config.ts';
import type { ConfigStatus } from './shared/protocol.ts';
import { exercisedLine } from './platform/exercised.ts';

export interface ConfigWatcherOptions {
  file: string;
  /** The config Ledung started with. */
  started: LedungConfig;
  /** The live settings changed: the config to run on now, and which settings changed. */
  apply: (config: LedungConfig, changed: SettingName[]) => void;
  /** The status changed (a reload, a refused file, a restart-only change). */
  onStatus?: (status: ConfigStatus) => void;
  /** Saves come in bursts of events (write, rename, attributes): one read after they settle. */
  debounceMs?: number;
  /** How often the file's stat is compared, as a backstop for a save the watch missed; 0 for none. */
  pollMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

let exercised358 = false;

export class ConfigWatcher {
  private readonly opts: ConfigWatcherOptions;
  private current: LedungConfig;
  private lastText: string | null = null;
  private state: ConfigStatus;
  private watcher: fs.FSWatcher | null = null;
  private watching: { dir: string; name: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private stamp = '';

  constructor(opts: ConfigWatcherOptions) {
    this.opts = opts;
    this.current = opts.started;
    this.state = { file: opts.file, readAt: this.now(), reloaded: false, problem: null, restartFor: [] };
    try {
      this.lastText = fs.readFileSync(opts.file, 'utf8');
    } catch {
      // Read again on the first change.
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  status(): ConfigStatus {
    return { ...this.state, restartFor: [...this.state.restartFor] };
  }

  /**
   * Watches the file's folder rather than the file: an editor that saves to a temporary file and renames it over the
   * config replaces the file a watch on it would follow. The folder and name watched are the file's real ones
   * (issue #388): on Windows, libuv aborts the whole process inside fs.watch when the folder is given by an 8.3 short
   * name (C:\Users\ADMINI~1\...), which no try/catch can stop, and only realpathSync.native expands those. A config
   * given through a link is watched where its file really is, so an edit of the file the link points at is seen.
   */
  start(): void {
    let real: { dir: string; name: string };
    try {
      real = realFile(this.opts.file);
    } catch (e) {
      this.opts.log?.(`The config file can't be watched, so changes need Restart Ledung: ${(e as Error).message}`);
      return;
    }
    try {
      this.watcher = fs.watch(real.dir, { persistent: false }, (_event, changed) => {
        if (changed === null || changed.toString() === real.name) this.soon();
      });
      this.watcher.on('error', (e) => this.opts.log?.(`Watching the config file stopped: ${e.message}`));
      this.watching = real;
    } catch (e) {
      this.opts.log?.(`The config file can't be watched, so changes need Restart Ledung: ${(e as Error).message}`);
      return;
    }
    // The backstop (issue #358): on macOS the folder watch goes live a moment after fs.watch returns, and a save in
    // that moment is never reported, so a cheap stat on a slow timer catches what the watch missed.
    this.stamp = this.fileStamp();
    const pollMs = this.opts.pollMs ?? 2000;
    if (pollMs > 0) {
      this.poll = setInterval(() => {
        const stamp = this.fileStamp();
        if (stamp === this.stamp) return;
        this.stamp = stamp;
        if (this.timer) return;
        if (!exercised358) {
          exercised358 = true;
          exercisedLine('EXERCISED #358 config change found by the stat backstop');
        }
        this.soon();
      }, pollMs);
      this.poll.unref();
    }
  }

  /** What the backstop compares: a rename over the file changes its inode, an edit in place its time or size. */
  private fileStamp(): string {
    try {
      const s = fs.statSync(this.opts.file);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code ?? 'error';
    }
  }

  /** The real folder and file name being watched, or null when the watch is not running. */
  watched(): { dir: string; name: string } | null {
    return this.watching && { ...this.watching };
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watching = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private soon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, this.opts.debounceMs ?? 300);
  }

  /** Reads the file now and applies it; false when nothing changed. */
  check(): boolean {
    // What the watch saw, the backstop need not see again.
    if (this.poll) this.stamp = this.fileStamp();
    let text: string;
    try {
      text = fs.readFileSync(this.opts.file, 'utf8');
    } catch (e) {
      // Between an editor's delete and its new file; the next event reads it again.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.refuse('The config file is missing.');
      return this.refuse(`The config file can't be read (${(e as NodeJS.ErrnoException).code ?? 'error'}).`);
    }
    if (text === this.lastText) return false;
    this.lastText = text;
    const read = configProblem(text);
    if ('problem' in read) return this.refuse(read.problem);
    const next = withLiveSettings(this.current, read.config);
    const changed = changedSettings(this.current, next);
    const restartFor = changedSettings(this.current, read.config).filter((k) => SETTING_RELOAD[k] === 'restart');
    this.current = next;
    this.state = { ...this.state, readAt: this.now(), reloaded: true, problem: null, restartFor };
    if (changed.length) {
      this.opts.apply(next, changed);
    }
    this.opts.log?.(`Config reloaded${changed.length ? `: ${changed.join(', ')} applied` : ''}${restartFor.length ? `; Restart Ledung to apply ${restartFor.join(', ')}` : ''}.`);
    this.opts.onStatus?.(this.status());
    return true;
  }

  private refuse(problem: string): boolean {
    // A refused file is read again when it changes, even back to what was running.
    this.lastText = null;
    if (problem === this.state.problem) return false;
    this.state = { ...this.state, problem };
    this.opts.log?.(`The changed config file was not applied, the running settings stay: ${problem}`);
    this.opts.onStatus?.(this.status());
    return true;
  }
}

/**
 * The real folder and name of the config file, long names and links resolved. A file missing at start (it is read
 * again on the first change) keeps its given name in its folder's real path; a folder that can't be resolved throws.
 */
function realFile(file: string): { dir: string; name: string } {
  let full: string;
  try {
    full = fs.realpathSync.native(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return { dir: fs.realpathSync.native(path.dirname(file)), name: path.basename(file) };
  }
  return { dir: path.dirname(full), name: path.basename(full) };
}
