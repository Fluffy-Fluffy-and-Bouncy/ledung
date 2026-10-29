// CPU and memory inside Docker containers (step 6): per session, the processes of its process tree
// (everything under the pid the Docker runner wrote when it started Claude Code); and Docker's
// virtual machine as a whole. All through the `docker` command; failures just mean no figures.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TICKS_PER_SECOND = 100;
const PAGE_BYTES = 4096;

export interface GroupUsage {
  cpuSeconds: number;
  memBytes: number;
}

/**
 * Parses /proc/<pid>/stat lines; sums CPU and memory over each root process and everything under it.
 * By process tree, not group: Claude Code runs each command it starts in a group of its own, so the
 * session's group holds only Claude Code itself (container tests, finding 1).
 */
export function parseProcTrees(text: string, roots: number[]): Map<number, GroupUsage> {
  const procs = new Map<number, { ppid: number; cpu: number; mem: number }>();
  for (const line of text.split('\n')) {
    const close = line.lastIndexOf(')');
    if (close < 0) continue;
    const pid = Number(line.slice(0, line.indexOf(' ')));
    const f = line.slice(close + 2).split(' ');
    const cpu = (Number(f[11]) + Number(f[12])) / TICKS_PER_SECOND;
    const mem = Number(f[21]) * PAGE_BYTES;
    if (!pid || Number.isNaN(cpu)) continue;
    procs.set(pid, { ppid: Number(f[1]), cpu, mem: Number.isNaN(mem) ? 0 : mem });
  }
  const children = new Map<number, number[]>();
  for (const [pid, p] of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), pid]);
  const out = new Map<number, GroupUsage>();
  for (const root of roots) {
    if (!procs.has(root)) continue;
    const g = { cpuSeconds: 0, memBytes: 0 };
    const seen = new Set<number>();
    for (const todo = [root]; todo.length;) {
      const pid = todo.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      g.cpuSeconds += procs.get(pid)!.cpu;
      g.memBytes += procs.get(pid)!.mem;
      todo.push(...(children.get(pid) ?? []));
    }
    out.set(root, g);
  }
  return out;
}

/** CPU and memory of each session's process tree in a container, or null if it can't be read. */
export async function containerGroups(container: string, roots: number[], user?: string): Promise<Map<number, GroupUsage> | null> {
  try {
    const u = user ? ['-u', user] : [];
    const { stdout } = await run('docker', ['exec', ...u, container, 'sh', '-c', 'cat /proc/[0-9]*/stat 2>/dev/null'], {
      windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024,
    });
    return parseProcTrees(stdout, roots);
  } catch {
    return null;
  }
}

/** The session's process group id: the pid the Docker runner wrote when it started Claude Code. */
export async function containerSessionGroup(container: string, tag: string, user?: string): Promise<number | null> {
  try {
    const u = user ? ['-u', user] : [];
    const { stdout } = await run('docker', ['exec', ...u, container, 'cat', `/tmp/${tag}.pid`], { windowsHide: true, timeout: 10000 });
    const pid = Number(stdout.trim());
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export interface DockerVm {
  memTotal: number;
  memUsed: number;
  cpus: number;
  /** CPU in use across all containers, in cores. */
  cores: number;
}

/** "1.2GiB / 7.6GiB" → bytes of the first part. */
export function parseDockerBytes(text: string): number {
  const m = text.trim().match(/^([\d.]+)\s*([KMGT]?i?B)/i);
  if (!m) return 0;
  const units: Record<string, number> = { b: 1, kib: 1024, kb: 1e3, mib: 1024 ** 2, mb: 1e6, gib: 1024 ** 3, gb: 1e9, tib: 1024 ** 4, tb: 1e12 };
  return Number(m[1]) * (units[m[2]!.toLowerCase()] ?? 1);
}

/** Docker's virtual machine: its size, and what its containers use now. Null when Docker isn't running. */
export async function dockerVm(): Promise<DockerVm | null> {
  try {
    const info = JSON.parse((await run('docker', ['info', '--format', '{{json .}}'], { windowsHide: true, timeout: 15000 })).stdout);
    const stats = (await run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { windowsHide: true, timeout: 20000 })).stdout;
    let memUsed = 0;
    let cores = 0;
    for (const line of stats.split('\n').filter(Boolean)) {
      const s = JSON.parse(line);
      memUsed += parseDockerBytes(String(s.MemUsage ?? '0B'));
      cores += (Number.parseFloat(String(s.CPUPerc ?? '0')) || 0) / 100;
    }
    return { memTotal: Number(info.MemTotal ?? 0), memUsed, cpus: Number(info.NCPU ?? 0), cores };
  } catch {
    return null;
  }
}
