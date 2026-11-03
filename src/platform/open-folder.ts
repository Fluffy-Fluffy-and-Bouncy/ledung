// Open a folder in the computer's file manager: Finder, Explorer, or whatever xdg-open picks (issue #414).
import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import path from 'node:path';
import { exercisedLine } from './exercised.ts';

/** How long a program may run before we take it that it worked: some xdg-open stay until the file manager closes. */
const STILL_RUNNING_MS = 3000;
/** Enough of a program's error output for the page. */
const MAX_REASON = 500;

/** The program and arguments that show a folder on this platform; for the tests. */
export function openFolderCommand(folder: string, platform = process.platform): [string, string[]] {
  // Explorer doesn't take forward slashes: it shows Documents instead of the folder, and says nothing.
  return platform === 'win32' ? ['explorer.exe', [path.win32.normalize(folder)]]
    : platform === 'darwin' ? ['open', [folder]]
    : ['xdg-open', [folder]];
}

/** How a platform's program says it failed, and how it is started. */
export interface OpenRun {
  /** Explorer exits with 1 also when the folder opened, so on Windows only a failure to start it counts. */
  exitCodeCounts: boolean;
  /** A folder window is what we are asking for: windowsHide would ask Explorer to open it hidden. */
  windowsHide: boolean;
  stillRunningMs: number;
}

export function openRun(platform = process.platform): OpenRun {
  return { exitCodeCounts: platform !== 'win32', windowsHide: false, stillRunningMs: STILL_RUNNING_MS };
}

/** Runs the program. Resolves when it worked; rejects with the program's own words when it didn't. */
export function runOpener(command: string, args: string[], run: OpenRun): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true, windowsHide: run.windowsHide });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      if (stderr.length < MAX_REASON) stderr += text;
    });
    const settled = () => {
      clearTimeout(timer);
      // Unref, not close: closing the pipe would stop a file manager that writes to it later.
      (child.stderr as Socket).unref();
      child.unref();
    };
    // Past this it is left to itself: Ledung neither waits for it nor stops it.
    const timer = setTimeout(() => {
      settled();
      resolve();
    }, run.stillRunningMs);
    child.on('error', (e) => {
      settled();
      reject(e);
    });
    child.on('close', (code, signal) => {
      settled();
      if (!run.exitCodeCounts || code === 0) resolve();
      else reject(new Error(stderr.trim().slice(0, MAX_REASON) || `${command} stopped with ${code ?? signal}`));
    });
  });
}

let exercised = false;

export async function openFolder(folder: string): Promise<void> {
  const [command, args] = openFolderCommand(folder);
  await runOpener(command, args, openRun());
  if (!exercised) exercisedLine(`EXERCISED #83 ${command} was waited for and opened the folder`);
  exercised = true;
}
