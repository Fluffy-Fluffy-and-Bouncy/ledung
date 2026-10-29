// Stopping a session's Claude Code process and everything it started. Runs inside the host.
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { killRecorded, snapshotTree } from '../platform/process-tree.ts';
import type { StopSpec } from './protocol.ts';

const run = promisify(execFile);

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Closes Claude Code's input (its signal to finish), then ends whatever is left. Returns what was ended. */
export async function stopSession(child: ChildProcess, spec: StopSpec): Promise<string[]> {
  if (spec.kind === 'local') {
    // On Windows, background commands outlive claude.exe and can't be found through it afterwards,
    // so the tree is recorded first (docs/steps/step-1a-spike.md, finding 2).
    const recorded = child.pid && child.exitCode === null ? await snapshotTree(child.pid).catch(() => []) : [];
    child.stdin?.end();
    await waitForExit(child, 5000);
    const ended = await killRecorded(recorded).catch(() => []);
    return ended.map((p) => `${p.name} (${p.pid})`);
  }
  child.stdin?.end();
  await waitForExit(child, 5000);
  if (child.exitCode === null) child.kill();
  return stopInContainer(spec);
}

/**
 * The script that ends what is left of a session in its container. It goes by the session's tag, which
 * every process the session started carries in its environment, not by process group: Claude Code
 * puts each command it runs in a group of its own, and dash (the /bin/sh of Debian images) rejects
 * `kill -- -<group>` (container tests, findings 1 and 2).
 */
export function containerStopScript(tag: string): string {
  const pidFile = `/tmp/${tag}.pid`;
  return [
    `cat ${pidFile} >/dev/null 2>&1 || exit 0`,
    `pids=$(grep -l "LEDUNG_TAG=${tag}" /proc/[0-9]*/environ 2>/dev/null | sed 's|/proc/\\([0-9]*\\)/environ|\\1|')`,
    `n=$(echo $pids | wc -w)`,
    `if [ "$n" -gt 0 ]; then kill -TERM $pids 2>/dev/null; sleep 2; kill -KILL $pids 2>/dev/null; echo "$n"; fi`,
    `rm -f ${pidFile}`,
  ].join('; ');
}

/** Ends what is left of the session inside the container (finding 3), if anything still runs. */
export async function stopInContainer(spec: Extract<StopSpec, { kind: 'docker' }>): Promise<string[]> {
  const script = containerStopScript(spec.tag);
  const user = spec.user ? ['-u', spec.user] : [];
  try {
    const { stdout } = await run('docker', ['exec', ...user, spec.container, 'sh', '-c', script], { windowsHide: true });
    const count = Number(stdout.trim() || 0);
    return count > 0 ? [`${count} process(es) in container ${spec.container}`] : [];
  } catch {
    return [];
  }
}
