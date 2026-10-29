import fs from 'node:fs';

/** Errors Windows gives while something still holds a file or folder for a moment. */
const HELD = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE']);
const TRIES = 25;
const WAIT_MS = 200;

/**
 * Removes a test's temp folder. On Windows a file still open, or a folder some process still has as its working
 * folder (a child a test started, a virus scanner, the search indexer), can't be deleted, and a bare rmSync then
 * fails the run with EPERM (issue #268). rmSync's own maxRetries doesn't help: on Node 24 it gives up on EPERM at
 * once (measured 0 ms with a child sitting in the folder), so the retries are here, for up to 5 s. Close what the
 * test opened first: this is the net for what is let go a moment late.
 */
export function removeTemp(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= TRIES || !HELD.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MS);
    }
  }
}
