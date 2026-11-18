// Starting Ledung from the app when none runs (issue #362, epic #357 choice 3): the app runs the installed `ledung`
// command, `ledung --no-open`, which starts Ledung in the background and returns once it answers (src/cli.ts,
// src/platform/background.ts). Never a core from the clone with the real data folder: one real Ledung per computer,
// the npm one. No Electron in this file, so the root tests run it (test/desktop.test.ts).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';

/**
 * A test points the start at a worktree with this: the path of a Node script, normally `<worktree>/src/cli.ts`, run as
 * `node <script> --no-open` instead of the `ledung` command, so no session ever runs the real one (CLAUDE.local.md on
 * magto-mini). Read with LEDUNG_CONFIG and LEDUNG_DATA_DIR, which pick the throwaway Ledung.
 */
export const START_SCRIPT_ENV = 'LEDUNG_DESKTOP_START';

/** What the start runs: the command and its arguments. */
export interface StartCommand {
  command: string;
  args: string[];
}

export function startCommand(env: NodeJS.ProcessEnv = process.env): StartCommand {
  const script = env[START_SCRIPT_ENV];
  if (script) return { command: 'node', args: [path.resolve(script), '--no-open'] };
  return { command: 'ledung', args: ['--no-open'] };
}

/** Variables `npm start` adds besides its npm_* ones (npm 11, checked on macOS 2026-11-17). */
const NPM_ADDED = ['INIT_CWD', 'NODE', 'COLOR'];

/** A PATH entry `npm start` put in front: a node_modules/.bin folder (this folder's Electron among them) or node-gyp's. */
function npmPathEntry(entry: string): boolean {
  const parts = entry.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1);
  return (last === '.bin' && parts.at(-2) === 'node_modules') || last === 'node-gyp-bin';
}

/**
 * The environment the start runs with: the app's own, minus what Electron and `npm start` add, so the background
 * Ledung looks as if started from a terminal (#362). No ELECTRON_* (a session would inherit ELECTRON_RUN_AS_NODE,
 * #361), no npm_*, none of npm's other additions, and PATH without npm's node_modules/.bin entries. The test start's
 * own setting goes too; LEDUNG_CONFIG and LEDUNG_DATA_DIR stay, since they pick which Ledung starts.
 */
export function startEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith('ELECTRON_') || upper.startsWith('NPM_') || NPM_ADDED.includes(upper) || upper === START_SCRIPT_ENV) continue;
    clean[name] = value;
  }
  // Windows spells it Path, and environment names are not case-sensitive there.
  const pathName = Object.keys(clean).find((name) => name.toUpperCase() === 'PATH');
  if (pathName !== undefined) {
    const sep = platform === 'win32' ? ';' : ':';
    clean[pathName] = (clean[pathName] ?? '').split(sep).filter((entry) => entry !== '' && !npmPathEntry(entry)).join(sep);
  }
  return clean;
}

export type StartResult = { ok: true } | { ok: false; line: string };

/**
 * The line worth showing from what the command printed: the last error line (`Error: listen EADDRINUSE …`), else the
 * last line; never Node's closing `Node.js v24…` line or a stack frame, which say nothing about what failed.
 */
export function lastLine(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !/^Node\.js v\d/.test(line) && !/^at /.test(line));
  return lines.findLast((line) => /^(\w*Error|Error)\b/.test(line)) ?? lines.at(-1) ?? '';
}

/**
 * Where the command is on the start's PATH, as the system's shell would find it, or null when it is not there. Looked
 * up first, so a missing command is the same "not found" on every system: on Windows the shell would otherwise turn
 * it into an exit code and a sentence of its own (self-check finding 1). PATHEXT on Windows (ledung is ledung.cmd).
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const get = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] ?? '';
  const exts = platform === 'win32' ? ['', ...get('PATHEXT').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  // A Windows Path entry may be quoted ("C:\Program Files\nodejs"), as cmd accepts (self-check round 2).
  const dirs = path.isAbsolute(command) ? [''] : get('PATH').split(platform === 'win32' ? ';' : ':')
    .map((dir) => (platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir)).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = dir ? path.join(dir, command + ext) : command + ext;
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
        else if (ext === '') continue; // Windows runs a file by its extension: a bare name is not a program.
        return file;
      } catch {
        // Not here, or not runnable.
      }
    }
  }
  return null;
}

/** Past this the start is given up on; `ledung` itself returns after at most 60 s (background.ts READY_MS). */
const START_MS = 75_000;

/** How long a failed exit waits for its output to close before it gives its line from what came (#385). */
const DRAIN_MS = 1_000;

/**
 * Runs the start command and waits for it to return. A command that can't be run, that exits with an error or that
 * doesn't return in time gives one line saying what failed; nothing here throws, so no Electron error dialog can come
 * of it (Mac spike surprise 3). The command is detached: quitting the app while it waits leaves the start going, and
 * one that doesn't return in time is left running, not killed, since it may still be bringing Ledung up.
 *
 * It finishes when the command exits, not when its output closes (#385): on Windows the background Ledung that
 * `ledung --no-open` leaves running inherits the output pipes through ledung.cmd and cmd, so they stay open while
 * Ledung runs and their close never comes. A failed exit waits a moment for the output that is still on its way,
 * for the line it shows.
 */
export function runStart(cmd: StartCommand = startCommand(), env: NodeJS.ProcessEnv = startEnv(), timeoutMs = START_MS): Promise<StartResult> {
  const shown = [path.basename(cmd.command), ...cmd.args.map((a) => (path.isAbsolute(a) ? path.basename(a) : a))].join(' ');
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (result: StartResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolve(result);
    };
    let drain: ReturnType<typeof setTimeout> | undefined;
    const file = findOnPath(cmd.command, env);
    if (file === null) {
      resolve({ ok: false, line: `Could not start Ledung: the "${path.basename(cmd.command)}" command was not found. Install Ledung, or start it from a terminal.` });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      const options = { env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[] };
      // `ledung` is ledung.cmd on Windows, which Node runs only through the shell. One quoted command line, so a path
      // with spaces holds together and Node gives no warning about arguments with a shell; they are fixed, never the
      // person's text.
      child = /\.(cmd|bat)$/i.test(file)
        ? spawn([file, ...cmd.args].map((a) => `"${a}"`).join(' '), { ...options, shell: true })
        : spawn(file, cmd.args, options);
    } catch (e) {
      resolve({ ok: false, line: `Could not run "${shown}": ${(e as Error).message}` });
      return;
    }
    const timer = setTimeout(() => finish({ ok: false, line: `"${shown}" did not finish within ${timeoutMs / 1000} s.` }), timeoutMs);
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4096);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        line: e.code === 'ENOENT'
          ? `Could not start Ledung: the "${path.basename(cmd.command)}" command was not found. Install Ledung, or start it from a terminal.` // Gone since it was looked up.
          : `Could not run "${shown}": ${e.message}`,
      });
    });
    const failed = (code: number | null, signal: NodeJS.Signals | null): StartResult => {
      const said = lastLine(output);
      return { ok: false, line: `"${shown}" ${code === null ? `was stopped (${signal})` : `exited with code ${code}`}${said ? `: ${said}` : '.'}` };
    };
    // Once the command has exited, the app stops waiting on its pipes: a process it left behind may hold them open for
    // as long as it runs (#385). Unref, not close, as open-folder.ts does: closing them would break that process's
    // next write. Not on the time limit: that command still runs.
    const letGo = () => {
      (child.stdout as Socket | null)?.unref();
      (child.stderr as Socket | null)?.unref();
    };
    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish({ ok: true });
        letGo();
      }
      // The output closes right after the exit unless something the command left holds it; either way, not longer.
      else drain = setTimeout(() => {
        finish(failed(code, signal));
        letGo();
      }, DRAIN_MS);
    });
    child.on('close', (code, signal) => finish(code === 0 ? { ok: true } : failed(code, signal)));
    child.unref();
  });
}
