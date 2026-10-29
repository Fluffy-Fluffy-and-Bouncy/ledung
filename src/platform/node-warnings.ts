// Node's own warnings on the console of the `ledung` command (#428). Ledung's database is node:sqlite, and older Node 24
// releases (24.14.1 does, 24.21 no longer) print "ExperimentalWarning: SQLite is an experimental feature" at every
// start, when it loads. That one warning is dropped, by a preload (src/preload.ts) the command starts Ledung with: an
// ESM import of node:sqlite loads before any of Ledung's own code runs, so only --import is early enough. Every other
// warning still shows.
import { pathToFileURL } from 'node:url';
import { exercisedLine } from './exercised.ts';
import { PACKAGED } from './paths.ts';

let exercised = false;

/** True for the one warning dropped: node:sqlite's ExperimentalWarning, matched on its type and its text. */
export function isSqliteWarning(warning: unknown, typeOrOptions?: unknown): boolean {
  const type = typeof typeOrOptions === 'string'
    ? typeOrOptions
    : warning instanceof Error ? warning.name : (typeOrOptions as { type?: unknown } | undefined)?.type;
  const text = warning instanceof Error ? warning.message : warning;
  return type === 'ExperimentalWarning' && typeof text === 'string' && text.startsWith('SQLite is an experimental feature');
}

/** Wraps process.emitWarning so the SQLite warning is never emitted; the rest pass through unchanged. */
export function dropSqliteWarning(): void {
  const emit = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteWarning(warning, rest[0])) {
      if (!exercised) {
        exercised = true;
        exercisedLine('EXERCISED #428 Node\'s SQLite warning kept off the console');
      }
      return;
    }
    return (emit as (...a: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
}

/**
 * Node's arguments for one start of Ledung's core by the `ledung` command. The preload sits next to the core's entry:
 * dist/preload.js beside dist/main.js in the package, src/preload.ts beside src/main.ts in source.
 */
export function coreArgs(entry: string, passthrough: string[], restarted: boolean, packaged = PACKAGED): string[] {
  const preload = new URL(packaged ? './preload.js' : './preload.ts', pathToFileURL(entry)).href;
  const args = ['--import', preload, entry, ...passthrough];
  if (restarted && !args.includes('--no-open')) args.push('--no-open');
  return args;
}
