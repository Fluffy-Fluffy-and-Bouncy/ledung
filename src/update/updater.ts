// Settings' "Update Ledung" (issue #100): check origin/main in the source folder the running release
// was built from, then pull, install, release and restart. The new release is the one
// `npm run release` builds, so an update is exactly what the person would type by hand (Martin,
// 2026-10-15, Ledung question #92: "a) Pull main, release, restart").
//
// Every step runs in the source folder, never in the release Ledung runs from, and nothing is
// restarted until the release has been built: a refusal or a failed step leaves the running Ledung
// as it was, and current.json is only rewritten by the release's last step.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { exercisedLine } from '../platform/exercised.ts';
import { killRecorded, listAll, treeFrom } from '../platform/process-tree.ts';
import type { UpdateStepView, UpdateView } from '../shared/protocol.ts';
import { CHANNEL_TAG, CHANNELS, compareVersions, displayVersion, offeredVersion, type Channel } from '../shared/version.ts';

/** The branch updates come from; any other is out of scope (#100). */
const BRANCH = 'main';
/** Lines of a failing step's output shown on the page. */
const TAIL_LINES = 15;
const MAX_CHANGES = 50;

/** What a release records about itself (scripts/release.ts writes it beside the release's files). */
export interface ReleaseInfo {
  source: string;
  /** The commit the release was built from; null when its source was not a git clone. */
  commit: string | null;
  releasedAt?: string;
}

/**
 * A command the updater runs: the program, its arguments, for npm whether it needs a shell, and how
 * long it may take before it is stopped (GIT_LIMIT_MS when left out).
 */
export type Command = { cmd: string; args: string[]; shell?: boolean; limitMs?: number };

// A hung step would leave the update running for ever (review of PR #101); these are generous.
const GIT_LIMIT_MS = 2 * 60_000;
const INSTALL_LIMIT_MS = 10 * 60_000;
const RELEASE_LIMIT_MS = 15 * 60_000;

export interface UpdaterOptions {
  /** The folder the running Ledung runs from (appDir()). */
  appDir: string;
  /** The user data folder: the update's steps build the release into it. */
  dataDir: string;
  /** The config the running Ledung uses; the new release points at the same one. */
  configPath: string;
  /** Restarts Ledung the way the Restart button does; undefined without the launcher. */
  onRestart?: () => void;
  /** npm install and npm run release; tests replace them so no real release is built. */
  install?: Command;
  release?: Command;
  /** The environment for every step (process.env by default). */
  env?: NodeJS.ProcessEnv;
  /** The installed version when Ledung runs from the npm package: there is no git source to pull (#105). */
  npmVersion?: string;
  /** Where the update channel is kept (the database's meta table); without it the channel is Public. */
  meta?: { get(key: string): string | null; set(key: string, value: string): void };
  /** npm view ledung dist-tags --json and npm install -g ledung@<version>; tests replace them so npm is not asked. */
  distTags?: Command;
  npmInstall?: (spec: string) => Command;
}

/** What the page says about updating an npm-installed Ledung on the Public channel (#105). */
export const NPM_REASON = 'Ledung was installed from npm, so updates come from npm: run npm install -g ledung, then press Restart Ledung.';
/** The same on the Dev channel (#461). */
export const NPM_DEV_REASON = 'Ledung was installed from npm, so updates come from npm: run npm install -g ledung@dev, then press Restart Ledung.';

/** The package an npm install updates. */
const PACKAGE = 'ledung';
const CHANNEL_KEY = 'update-channel';
/** The EXERCISED line of issue #461, once per run. */
let devCheckTraced = false;

/** The release the running Ledung came from, or null when it runs straight from a source folder. */
export function readRunningRelease(appDir: string): ReleaseInfo | null {
  const own = readJson(path.join(appDir, 'release.json'));
  if (own && typeof own.source === 'string') {
    return { source: own.source, commit: typeof own.commit === 'string' ? own.commit : null, releasedAt: str(own.releasedAt) };
  }
  return null;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm.cmd only starts through a shell on Windows; the arguments are fixed, nothing the page sends.
const NPM_INSTALL: Command = { cmd: npm, args: ['install', '--no-audit', '--no-fund'], shell: process.platform === 'win32', limitMs: INSTALL_LIMIT_MS };
const NPM_RELEASE: Command = { cmd: npm, args: ['run', 'release'], shell: process.platform === 'win32', limitMs: RELEASE_LIMIT_MS };
// npm itself, so the person's own registry and proxy settings apply, as they do to the install after it. The spec is
// ledung@<a version npm reported>, checked to be one before it is used.
const NPM_DIST_TAGS: Command = { cmd: npm, args: ['view', PACKAGE, 'dist-tags', '--json'], shell: process.platform === 'win32' };
const npmGlobalInstall = (spec: string): Command => ({ cmd: npm, args: ['install', '-g', spec, '--no-audit', '--no-fund'], shell: process.platform === 'win32', limitMs: INSTALL_LIMIT_MS });

export class Updater {
  private readonly opts: UpdaterOptions;
  private check: UpdateView['check'] = null;
  private npmCheck: UpdateView['npmCheck'] = null;
  private checkError: string | null = null;
  private checking = false;
  private steps: UpdateStepView[] = [];
  private updating = false;
  private refused: string | null = null;
  private restarting = false;

  constructor(opts: UpdaterOptions) {
    this.opts = opts;
  }

  /** The release to update from; never one for an npm install, whatever current.json says. */
  private running(): ReleaseInfo | null {
    return this.opts.npmVersion ? null : readRunningRelease(this.opts.appDir);
  }

  /** Public or Dev (#461); Public until chosen otherwise. A clone install keeps updating from main either way. */
  channel(): Channel {
    return this.opts.meta?.get(CHANNEL_KEY) === 'dev' ? 'dev' : 'public';
  }

  setChannel(channel: Channel): UpdateView {
    if (!CHANNELS.includes(channel)) throw new Error(`The channel is ${CHANNELS.join(' or ')}.`);
    if (!this.opts.meta) throw new Error('The update channel cannot be kept here.');
    this.opts.meta.set(CHANNEL_KEY, channel);
    // The last check was of the other channel's version.
    this.npmCheck = null;
    return this.view();
  }

  view(): UpdateView {
    const running = this.running();
    const npm = this.opts.npmVersion;
    const channel = this.channel();
    return {
      available: !!running,
      reason: running ? undefined : npm ? (channel === 'dev' ? NPM_DEV_REASON : NPM_REASON) : 'This Ledung runs straight from a source folder, not from a release, so it has nothing to update. Start it from a release (npm run release).',
      npm: npm ? { version: npm } : undefined,
      channel,
      canRestart: !!this.opts.onRestart,
      running: running ? { commit: running.commit, source: running.source, releasedAt: running.releasedAt } : null,
      check: this.check,
      npmCheck: this.npmCheck,
      checkError: this.checkError,
      checking: this.checking,
      steps: this.steps,
      updating: this.updating,
      refused: this.refused,
      restarting: this.restarting,
    };
  }

  /** Check for updates: on npm the channel's version (#461), otherwise origin/main in the source folder. */
  checkForUpdates(): Promise<UpdateView> {
    return this.opts.npmVersion ? this.runNpmCheck() : this.runCheck();
  }

  /** Update Ledung: on npm installs the channel's version and restarts (#461), otherwise pulls main and releases. */
  runUpdate(): UpdateView {
    return this.opts.npmVersion ? this.startNpmUpdate() : this.startUpdate();
  }

  /** Asks npm for the channel's version and says whether it is newer than the installed one. */
  async runNpmCheck(): Promise<UpdateView> {
    const installed = this.opts.npmVersion;
    if (!installed || this.checking || this.updating) return this.view();
    this.checking = true;
    this.checkError = null;
    try {
      const channel = this.channel();
      const offered = offeredVersion(channel, await this.distTags());
      this.npmCheck = { checkedAt: new Date().toISOString(), channel, offered, upToDate: !offered || compareVersions(offered, installed) <= 0 };
      if (channel === 'dev' && !devCheckTraced) {
        devCheckTraced = true;
        exercisedLine(`EXERCISED #461 npm update check followed the dev tag (${offered ?? 'none'})`);
      }
    } catch (e) {
      this.checkError = (e as Error).message;
    } finally {
      this.checking = false;
    }
    return this.view();
  }

  private async distTags(): Promise<Record<string, string>> {
    const r = await this.run(this.opts.distTags ?? NPM_DIST_TAGS, this.opts.dataDir);
    if (r.timedOut || r.code !== 0) throw new Error(`npm view ${PACKAGE} dist-tags failed:\n${r.tail}`);
    try {
      const tags = JSON.parse(r.out) as unknown;
      if (tags && typeof tags === 'object') {
        return Object.fromEntries(Object.entries(tags).filter((e): e is [string, string] => typeof e[1] === 'string'));
      }
    } catch {
      // Falls through to the error below.
    }
    throw new Error(`npm view ${PACKAGE} dist-tags did not answer with its tags:\n${r.tail}`);
  }

  /** Installs the channel's version globally with npm, then restarts into it; refusals as for a git update. */
  startNpmUpdate(): UpdateView {
    const installed = this.opts.npmVersion;
    if (!installed || this.updating) return this.view();
    if (this.checking) {
      this.refused = 'A check for updates is still running. Update again when it has finished.';
      this.steps = [];
      return this.view();
    }
    this.refused = null;
    this.steps = [];
    if (!this.opts.onRestart) {
      this.refused = 'This Ledung was not started by the ledung command, so it cannot restart itself into the new version. Start it with ledung first.';
      return this.view();
    }
    this.updating = true;
    void this.npmUpdate(installed).finally(() => {
      this.updating = false;
    });
    return this.view();
  }

  private async npmUpdate(installed: string): Promise<void> {
    const channel = this.channel();
    this.steps = [`Ask npm for the ${channel === 'dev' ? 'Dev' : 'Public'} version`, `npm install -g ${PACKAGE}@${CHANNEL_TAG[channel]}`, 'Restart Ledung'].map((label) => ({ label, state: 'waiting' }));
    const step = (i: number, state: UpdateStepView['state'], output?: string, label?: string) => {
      this.steps = this.steps.map((s, j) => (j === i ? { ...s, state, output, label: label ?? s.label } : s));
    };
    const refuse = (i: number, reason: string, output?: string) => {
      step(i, 'failed', output);
      this.refused = `${reason} The running Ledung was not changed.`;
    };

    step(0, 'running');
    let offered: string | null;
    try {
      offered = offeredVersion(channel, await this.distTags());
    } catch (e) {
      return refuse(0, 'npm could not be asked for the version.', (e as Error).message);
    }
    if (!offered) return refuse(0, `npm has no ${channel === 'dev' ? 'Dev' : 'Public'} version of ${PACKAGE}.`);
    this.npmCheck = { checkedAt: new Date().toISOString(), channel, offered, upToDate: compareVersions(offered, installed) <= 0 };
    // Never down: a Dev install switched to Public keeps its newer build until a public release passes it.
    if (this.npmCheck.upToDate) return refuse(0, `${displayVersion(installed)} is already the newest on this channel.`);
    step(0, 'done');

    const spec = `${PACKAGE}@${offered}`;
    step(1, 'running', undefined, `npm install -g ${spec}`);
    const command = this.opts.npmInstall?.(spec) ?? npmGlobalInstall(spec);
    const result = await this.run(command, this.opts.dataDir);
    if (result.timedOut) return refuse(1, `npm install -g ${spec} did not finish within ${Math.round((command.limitMs ?? GIT_LIMIT_MS) / 60_000)} minutes and was stopped.`, result.tail);
    if (result.code !== 0) return refuse(1, `npm install -g ${spec} failed (exit code ${result.code}).`, result.tail);
    step(1, 'done', result.tail);

    step(2, 'running');
    this.restarting = true;
    // As for a git update: answer the page's next poll first, then restart into the installed files.
    setTimeout(() => this.opts.onRestart?.(), 1500);
  }

  /** Fetches origin/main in the source folder and says what is new since the running release. */
  async runCheck(): Promise<UpdateView> {
    const running = this.running();
    if (!running) return this.view();
    if (this.checking || this.updating) return this.view();
    this.checking = true;
    this.checkError = null;
    try {
      this.check = await this.compare(running);
    } catch (e) {
      this.checkError = (e as Error).message;
    } finally {
      this.checking = false;
    }
    return this.view();
  }

  private async compare(running: ReleaseInfo): Promise<NonNullable<UpdateView['check']>> {
    const src = running.source;
    if (!fs.existsSync(path.join(src, '.git'))) throw new Error(`The source folder ${src} is not a git clone.`);
    const fetched = await this.run({ cmd: 'git', args: ['fetch', 'origin', BRANCH] }, src);
    if (fetched.code !== 0) throw new Error(`git fetch origin ${BRANCH} failed:\n${fetched.tail}`);
    const latest = (await this.git(src, ['rev-parse', `origin/${BRANCH}`])).trim();
    // The running commit may be missing from the clone (a release built elsewhere): then it counts as unknown.
    const known = running.commit && (await this.run({ cmd: 'git', args: ['cat-file', '-e', `${running.commit}^{commit}`] }, src)).code === 0;
    const base = known ? running.commit! : 'HEAD';
    // First-parent commits on main: one per merged pull request, which is what a person calls a change.
    const behind = Number((await this.git(src, ['rev-list', '--count', '--first-parent', `${base}..origin/${BRANCH}`])).trim()) || 0;
    const diff = await this.git(src, ['diff', `${base}`, `origin/${BRANCH}`, '--', 'CHANGELOG.md']);
    return {
      checkedAt: new Date().toISOString(),
      latest,
      commitKnown: !!known,
      behind,
      upToDate: !!known && behind === 0,
      changes: changelogAdded(diff).slice(0, MAX_CHANGES),
    };
  }

  /**
   * Starts the update and returns at once; the page follows it through view(). Refusals and
   * failures are steps marked failed plus a reason, never an exception the page has to catch.
   */
  startUpdate(): UpdateView {
    if (this.updating) return this.view();
    // A check and an update both fetch in the source folder; two git commands at once in one clone
    // can trip over its lock (review of PR #101).
    if (this.checking) {
      this.refused = 'A check for updates is still running. Update again when it has finished.';
      this.steps = [];
      return this.view();
    }
    const running = this.running();
    this.refused = null;
    this.steps = [];
    if (!running) {
      this.refused = this.view().reason!;
      return this.view();
    }
    if (!this.opts.onRestart) {
      this.refused = 'This Ledung was not started by the launcher, so it cannot restart itself into the new release. Restart it once from its console window first.';
      return this.view();
    }
    this.updating = true;
    void this.update(running.source).finally(() => {
      this.updating = false;
    });
    return this.view();
  }

  private async update(src: string): Promise<void> {
    const labels = ['Check the source folder', `git pull --ff-only origin ${BRANCH}`, 'npm install', 'npm run release', 'Restart Ledung'];
    this.steps = labels.map((label) => ({ label, state: 'waiting' }));
    const step = (i: number, state: UpdateStepView['state'], output?: string) => {
      this.steps = this.steps.map((s, j) => (j === i ? { ...s, state, output } : s));
    };
    const refuse = (i: number, reason: string, output?: string) => {
      step(i, 'failed', output);
      this.refused = `${reason} The running Ledung was not changed.`;
    };

    step(0, 'running');
    const problem = await this.precheck(src);
    if (problem) return refuse(0, problem.reason, problem.output);
    step(0, 'done');

    const commands: Command[] = [
      { cmd: 'git', args: ['pull', '--ff-only', 'origin', BRANCH] },
      this.opts.install ?? NPM_INSTALL,
      this.opts.release ?? NPM_RELEASE,
    ];
    for (const [k, command] of commands.entries()) {
      const i = k + 1;
      step(i, 'running');
      const result = await this.run(command, src);
      if (result.timedOut) {
        const limit = command.limitMs ?? GIT_LIMIT_MS;
        const took = limit >= 60_000 ? `${Math.round(limit / 60_000)} minutes` : `${Math.round(limit / 1000)} seconds`;
        return refuse(i, `${labels[i]} did not finish within ${took} and was stopped.`, result.tail);
      }
      if (result.code !== 0) return refuse(i, `${labels[i]} failed (exit code ${result.code}).`, result.tail);
      step(i, 'done', result.tail);
    }

    step(4, 'running');
    this.restarting = true;
    // Answer the page's next poll first, so it sees the release finished; the restart closes the server.
    setTimeout(() => this.opts.onRestart?.(), 1500);
  }

  /** Why the source folder can't be updated: changes, another branch, or main has gone its own way. */
  private async precheck(src: string): Promise<{ reason: string; output?: string } | null> {
    if (!fs.existsSync(path.join(src, '.git'))) return { reason: `The source folder ${src} is not a git clone.` };
    // Untracked files don't stop a pull; changed tracked files would be released without being committed.
    const status = await this.run({ cmd: 'git', args: ['status', '--porcelain', '--untracked-files=no'] }, src);
    if (status.code !== 0) return { reason: 'git status failed in the source folder.', output: status.tail };
    if (status.out.trim()) {
      return { reason: `The source folder ${src} has uncommitted changes. Commit or discard them, then update again.`, output: status.tail };
    }
    const branch = (await this.run({ cmd: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'] }, src)).out.trim();
    if (branch !== BRANCH) return { reason: `The source folder ${src} is on ${branch === 'HEAD' ? 'no branch' : `branch ${branch}`}, not ${BRANCH}.` };
    const fetched = await this.run({ cmd: 'git', args: ['fetch', 'origin', BRANCH] }, src);
    if (fetched.code !== 0) return { reason: `git fetch origin ${BRANCH} failed.`, output: fetched.tail };
    const ff = await this.run({ cmd: 'git', args: ['merge-base', '--is-ancestor', 'HEAD', `origin/${BRANCH}`] }, src);
    if (ff.code !== 0) {
      return { reason: `${BRANCH} in the source folder has commits that are not on origin/${BRANCH}, so the pull is not a fast-forward.` };
    }
    return null;
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const r = await this.run({ cmd: 'git', args }, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.tail}`);
    return r.out;
  }

  /** Runs one step, keeping all of stdout and the last lines of stdout and stderr together. */
  private run(command: Command, cwd: string): Promise<{ code: number; out: string; tail: string; timedOut?: boolean }> {
    // Settings meant for this Ledung are not the step's, except where the release must land: the
    // same data folder and config as the running Ledung (CLAUDE.md, sessions don't inherit LEDUNG_*).
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.opts.env ?? process.env)) {
      if (v !== undefined && !k.startsWith('LEDUNG_')) env[k] = v;
    }
    env.LEDUNG_DATA_DIR = this.opts.dataDir;
    env.LEDUNG_CONFIG = this.opts.configPath;
    env.GIT_TERMINAL_PROMPT = '0';
    return new Promise((resolve) => {
      let out = '';
      let all = '';
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (r: { code: number; out: string; tail: string; timedOut?: boolean }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const child = spawn(command.cmd, command.args, { cwd, env, shell: command.shell ?? false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      // Out of time: stop the step and everything it started (npm runs node, which runs the tests). One process
      // list serves both to find them and to check they still run: under load each list can take seconds (#251).
      timer = setTimeout(() => {
        const pid = child.pid;
        void (pid ? listAll().then((list) => killRecorded(treeFrom(list, pid), list)) : Promise.resolve([])).catch(() => {}).finally(() => {
          finish({ code: -1, out, tail: tail(all), timedOut: true });
        });
      }, command.limitMs ?? GIT_LIMIT_MS);
      child.stdout.on('data', (d: Buffer) => { out += d; all += d; });
      child.stderr.on('data', (d: Buffer) => { all += d; });
      child.on('error', (e) => finish({ code: -1, out, tail: e.message }));
      child.on('close', (code) => finish({ code: code ?? -1, out, tail: tail(all) }));
    });
  }
}

/** The changelog bullets a diff adds, without the leading "- ". */
export function changelogAdded(diff: string): string[] {
  return diff.split(/\r?\n/).filter((l) => l.startsWith('+- ')).map((l) => l.slice(3).trim());
}

function tail(text: string): string {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-TAIL_LINES).join('\n');
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
