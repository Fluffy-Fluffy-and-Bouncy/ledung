// The process's `EXERCISED #N` trace lines (agent-workflow, worker.md "EXERCISED line"): a fix logs one once per run,
// and a log watcher greps it to tell that the fix ran. They name this repository's issues and mean nothing to a user,
// so the npm package never prints them (#422, #428). Every run appends them to exercised.log in the data folder;
// a run from source (a clone, a release, a throwaway test Ledung) prints them as well, where the process reads them.
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGED, userDataDir } from './paths.ts';

/** The trace file in the data folder. */
export const EXERCISED_FILE = 'exercised.log';
/** Past this size the file starts over: one line per fix per run, so it only fills over many runs. */
const MAX_BYTES = 256 * 1024;

export interface ExercisedTarget {
  /** Also print the line on the console; the npm package doesn't. */
  console: boolean;
  /** The file to append it to; null for none. */
  file: () => string | null;
}

const DEFAULT_TARGET: ExercisedTarget = {
  console: !PACKAGED,
  file: () => path.join(userDataDir(), EXERCISED_FILE),
};

/** Logs one `EXERCISED #N …` line; never throws, a trace must not break the path it traces. */
export function exercisedLine(line: string, target: ExercisedTarget = DEFAULT_TARGET): void {
  if (target.console) console.log(line);
  try {
    const file = target.file();
    if (!file) return;
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    const text = `${new Date().toISOString()} ${line}\n`;
    if (size > MAX_BYTES) fs.writeFileSync(file, text);
    else fs.appendFileSync(file, text);
  } catch {
    // An unwritable data folder: the line is lost, the fix runs on.
  }
}
