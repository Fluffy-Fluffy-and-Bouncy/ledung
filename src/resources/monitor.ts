// Measures CPU and memory (step 6a): the machine, Docker's virtual machine, and each live session's
// processes. One process list every few seconds for the whole machine; sessions in containers are
// read per container. Also adds up what each turn used, for the per-turn record (step 6c).
import os from 'node:os';
import { listHostRecords } from '../host/client.ts';
import { memoryUsed } from '../platform/memory.ts';
import { containerGroups, containerSessionGroup, dockerVm, type DockerVm } from '../platform/containers.ts';
import { exercisedLine } from '../platform/exercised.ts';
import { ProcessSampler, sessionTree, type ProcInfo, type ProcessList, type TreeMemory } from '../platform/processes.ts';
import { GpuTracker, readGpuPosix, type GpuRaw, type GpuReading } from '../platform/gpu.ts';
import type { ResourceFigures } from '../shared/protocol.ts';

export type MonitorTarget =
  | { id: string; kind: 'local' }
  | { id: string; kind: 'docker'; container: string; user?: string };

export interface TurnTotals {
  cpuSeconds: number;
  peakCores: number;
  peakMem: number;
  samples: number;
}

interface Counter {
  /** CPU seconds seen so far, only ever growing. */
  cpu: number;
  /** For containers: the group's last total, to take differences from. */
  lastGroupCpu?: number;
  figures: ResourceFigures;
}

const DOCKER_EVERY_MS = 30000;

/** One sample for resource limits (src/resources/book.ts): the lists, every local session's processes, the GPU. */
export interface MonitorTick {
  at: number;
  list: ProcessList;
  prev: ProcessList | null;
  dt: number;
  trees: Map<string, ProcInfo[]>;
  hosts: Map<string, number>;
  gpu: GpuReading | null;
}

export class ResourceMonitor {
  readonly intervalSec: number;
  private readonly targets: () => MonitorTarget[];
  private readonly withDocker: () => boolean;
  private readonly onSample: () => void;
  private readonly onTick: ((t: MonitorTick) => void) | null;
  private readonly gpuTracker = new GpuTracker();
  private gpuReading: GpuReading | null = null;
  private gpuBusy = false;
  private sampler: ProcessSampler | null = null;
  private prevList: ProcessList | null = null;
  private prevAt = 0;
  private prevCpuTimes = cpuTimes();
  private readonly counters = new Map<string, Counter>();
  private readonly turns = new Map<string, TurnTotals & { startCpu: number }>();
  private readonly groups = new Map<string, number>();
  /** Local sessions: the processes each held at the last sample (#169). */
  private readonly trees = new Map<string, TreeMemory>();
  private containerBusy = false;
  private dockerAt = 0;
  private dockerBusy = false;
  /** Read with each sample, since on macOS it takes a command (src/platform/memory.ts). */
  private memUsed = os.totalmem() - os.freemem();
  private memBusy = false;
  machineCores = 0;
  docker: DockerVm | null = null;

  constructor(opts: { intervalSec?: number; targets: () => MonitorTarget[]; withDocker: () => boolean; onSample: () => void; onTick?: (t: MonitorTick) => void }) {
    this.intervalSec = opts.intervalSec ?? 5;
    this.targets = opts.targets;
    this.withDocker = opts.withDocker;
    this.onSample = opts.onSample;
    this.onTick = opts.onTick ?? null;
  }

  /** The GPUs' latest reading (resource limits); null before the first. */
  get gpu(): GpuReading | null {
    return this.gpuReading;
  }

  start(): void {
    this.sampler = new ProcessSampler(this.intervalSec, (list, at, gpu) => {
      try {
        this.tick(list, at, gpu);
      } catch (e) {
        console.error(`Measuring: ${(e as Error).message}`);
      }
    });
    this.sampler.start();
  }

  stop(): void {
    this.sampler?.stop();
  }

  /** The latest figures per live session. */
  figures(): Record<string, ResourceFigures> {
    const out: Record<string, ResourceFigures> = {};
    for (const [id, c] of this.counters) out[id] = c.figures;
    return out;
  }

  machine(): { cpus: number; cores: number; memTotal: number; memUsed: number } {
    return { cpus: os.cpus().length, cores: this.machineCores, memTotal: os.totalmem(), memUsed: this.memUsed };
  }

  /** A turn starts: totals from here on. */
  beginTurn(id: string): void {
    this.turns.set(id, { startCpu: this.counters.get(id)?.cpu ?? 0, cpuSeconds: 0, peakCores: 0, peakMem: 0, samples: 0 });
  }

  /** A turn ends: what it used, or null if it wasn't being measured. */
  endTurn(id: string): TurnTotals | null {
    const t = this.turns.get(id);
    this.turns.delete(id);
    if (!t) return null;
    return { cpuSeconds: Math.max(0, (this.counters.get(id)?.cpu ?? 0) - t.startCpu), peakCores: t.peakCores, peakMem: t.peakMem, samples: t.samples };
  }

  private tick(list: ProcessList, at: number, gpu?: { raw: GpuRaw; at: number }): void {
    // The GPU (resource limits): on Windows in the same batch; elsewhere read beside it, the latest reading kept.
    if (gpu) this.gpuReading = this.gpuTracker.update(gpu.raw, gpu.at);
    else if (process.platform !== 'win32' && !this.gpuBusy) {
      this.gpuBusy = true;
      const pids = [...list.keys()];
      // A read that hangs is given up after 20 s, so the next round can try again (security review, finding 6).
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('GPU read timed out')), 20_000).unref());
      void Promise.race([readGpuPosix(pids), timeout])
        .then((raw) => { this.gpuReading = this.gpuTracker.update(raw, Date.now()); }, () => {})
        .finally(() => { this.gpuBusy = false; });
    }
    // An old reading is no reading: decisions are never taken on a frozen GPU figure.
    if (this.gpuReading && at - this.gpuReading.at > Math.max(30_000, this.intervalSec * 4000)) this.gpuReading = null;
    if (!this.memBusy) {
      this.memBusy = true;
      void memoryUsed()
        .then((used) => { this.memUsed = used; })
        .finally(() => { this.memBusy = false; });
    }
    const now = cpuTimes();
    const busy = now.busy - this.prevCpuTimes.busy;
    const total = now.total - this.prevCpuTimes.total;
    this.machineCores = total > 0 ? (busy / total) * os.cpus().length : 0;
    this.prevCpuTimes = now;

    const targets = this.targets();
    const live = new Set(targets.map((t) => t.id));
    for (const id of this.counters.keys()) if (!live.has(id)) this.counters.delete(id);
    for (const id of this.groups.keys()) if (!live.has(id)) this.groups.delete(id);
    for (const id of this.trees.keys()) if (!live.has(id)) this.trees.delete(id);

    // Local sessions: the tree under the session's host process, turn or not, and what left it (#169).
    const dt = (at - this.prevAt) / 1000;
    const hostPids = new Map(listHostRecords().map((r) => [r.sessionId, r.hostPid]));
    const trees = new Map<string, ProcInfo[]>();
    for (const t of targets) {
      if (t.kind !== 'local') continue;
      const pid = hostPids.get(t.id);
      const s = treeSample(this.prevList, list, pid, dt, os.cpus().length, this.trees.get(t.id) ?? null);
      this.trees.set(t.id, s.memory);
      if (pid) trees.set(t.id, s.tree);
      this.count(t.id, s.cpuSeconds, s.cores, s.memBytes);
    }
    const prev = this.prevList;
    this.prevList = list;
    this.prevAt = at;
    if (this.onTick) {
      try {
        this.onTick({ at, list, prev, dt, trees, hosts: hostPids, gpu: this.gpuReading });
      } catch (e) {
        console.error(`Resource limits: ${(e as Error).message}`);
      }
    }

    void this.sampleContainers(targets.filter((t) => t.kind === 'docker') as Extract<MonitorTarget, { kind: 'docker' }>[], dt);
    if (this.withDocker() && !this.dockerBusy && at - this.dockerAt >= DOCKER_EVERY_MS) {
      this.dockerBusy = true;
      this.dockerAt = at;
      void dockerVm().then((vm) => {
        this.docker = vm;
        this.dockerBusy = false;
      });
    }
    this.onSample();
  }

  private count(id: string, cpuDelta: number, cores: number, mem: number): void {
    const c = this.counters.get(id) ?? { cpu: 0, figures: { cores: 0, memBytes: 0 } };
    c.cpu += cpuDelta;
    c.figures = { cores, memBytes: mem };
    this.counters.set(id, c);
    const turn = this.turns.get(id);
    if (turn) {
      turn.samples++;
      turn.peakCores = Math.max(turn.peakCores, cores);
      turn.peakMem = Math.max(turn.peakMem, mem);
    }
  }

  /** Container sessions: their process group, one read per container. Skipped while the last read runs. */
  private async sampleContainers(targets: Extract<MonitorTarget, { kind: 'docker' }>[], dt: number): Promise<void> {
    if (!targets.length || this.containerBusy) return;
    this.containerBusy = true;
    try {
      const byContainer = new Map<string, typeof targets>();
      for (const t of targets) byContainer.set(t.container, [...(byContainer.get(t.container) ?? []), t]);
      for (const [container, list] of byContainer) {
        for (const t of list) {
          if (!this.groups.has(t.id)) {
            const g = await containerSessionGroup(container, `ledung-${t.id}`, t.user);
            if (g) this.groups.set(t.id, g);
          }
        }
        const groups = await containerGroups(container, list.flatMap((t) => this.groups.get(t.id) ?? []), list[0]!.user);
        if (!groups) continue;
        for (const t of list) {
          const g = this.groups.get(t.id);
          const usage = g ? groups.get(g) : undefined;
          if (!usage) continue;
          const prev = this.counters.get(t.id)?.lastGroupCpu;
          // Processes that ended take their CPU time with them: never count a drop as negative.
          const delta = prev === undefined ? 0 : Math.max(0, usage.cpuSeconds - prev);
          this.count(t.id, delta, prev === undefined || dt <= 0 ? 0 : capCores(delta / dt, os.cpus().length), usage.memBytes);
          this.counters.get(t.id)!.lastGroupCpu = usage.cpuSeconds;
        }
      }
    } finally {
      this.containerBusy = false;
    }
  }
}

/**
 * Cores in use can't be more than the machine has threads. A higher figure is a measuring artefact
 * (two samples closer together than the CPU times they carry), so it is held at the thread count (#157).
 */
export function capCores(cores: number, threads: number): number {
  return threads > 0 ? Math.min(cores, threads) : cores;
}

let exercised169 = false;

/**
 * One session's sample: the CPU its processes used since the last list (`prev`, the whole
 * machine's, so a process that joins late is still counted from its last reading), the cores that
 * is over `dt` seconds, and its memory. Its processes are the tree under `root` plus, given the
 * `memory` of the last sample, those that have left that tree since (`sessionTree`, #169); the new
 * memory is returned for the next sample. With no last list there is nothing to compare.
 */
export function treeSample(prev: ProcessList | null, list: ProcessList, root: number | undefined, dt: number, threads: number, memory: TreeMemory | null = null): { cpuSeconds: number; cores: number; memBytes: number; memory: TreeMemory; tree: ProcInfo[] } {
  const { tree, memory: next } = sessionTree(list, root, memory);
  let used = 0;
  if (prev) for (const p of tree) used += Math.max(0, p.cpuSeconds - (prev.get(p.pid)?.cpuSeconds ?? 0));
  const memBytes = tree.reduce((n, p) => n + p.memBytes, 0);
  if (!exercised169 && root && tree.length > sessionTree(list, root, null).tree.length) {
    exercised169 = true;
    exercisedLine('EXERCISED #169 a session counted a process that had left its host\'s tree');
  }
  return { cpuSeconds: used, cores: prev && dt > 0 ? capCores(used / dt, threads) : 0, memBytes, memory: next, tree };
}

function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
    total += t;
    busy += t - c.times.idle;
  }
  return { busy, total };
}
