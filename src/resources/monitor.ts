// Measures CPU and memory (step 6a): the machine, Docker's virtual machine, and each live session's
// processes. One process list every few seconds for the whole machine; sessions in containers are
// read per container. Also adds up what each turn used, for the per-turn record (step 6c).
import os from 'node:os';
import { listHostRecords } from '../host/client.ts';
import { memoryUsed } from '../platform/memory.ts';
import { containerGroups, containerSessionGroup, dockerVm, type DockerVm } from '../platform/containers.ts';
import { ProcessSampler, treeOf, type ProcessList } from '../platform/processes.ts';
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

export class ResourceMonitor {
  readonly intervalSec: number;
  private readonly targets: () => MonitorTarget[];
  private readonly withDocker: () => boolean;
  private readonly onSample: () => void;
  private sampler: ProcessSampler | null = null;
  private prevList: ProcessList | null = null;
  private prevAt = 0;
  private prevCpuTimes = cpuTimes();
  private readonly counters = new Map<string, Counter>();
  private readonly turns = new Map<string, TurnTotals & { startCpu: number }>();
  private readonly groups = new Map<string, number>();
  private containerBusy = false;
  private dockerAt = 0;
  private dockerBusy = false;
  /** Read with each sample, since on macOS it takes a command (src/platform/memory.ts). */
  private memUsed = os.totalmem() - os.freemem();
  private memBusy = false;
  machineCores = 0;
  docker: DockerVm | null = null;

  constructor(opts: { intervalSec?: number; targets: () => MonitorTarget[]; withDocker: () => boolean; onSample: () => void }) {
    this.intervalSec = opts.intervalSec ?? 5;
    this.targets = opts.targets;
    this.withDocker = opts.withDocker;
    this.onSample = opts.onSample;
  }

  start(): void {
    this.sampler = new ProcessSampler(this.intervalSec, (list, at) => {
      try {
        this.tick(list, at);
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

  private tick(list: ProcessList, at: number): void {
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

    // Local sessions: the tree under the session's host process.
    const dt = (at - this.prevAt) / 1000;
    const hostPids = new Map(listHostRecords().map((r) => [r.sessionId, r.hostPid]));
    for (const t of targets) {
      if (t.kind !== 'local') continue;
      const pid = hostPids.get(t.id);
      const tree = pid ? treeOf(list, pid) : [];
      let used = 0;
      if (this.prevList) {
        for (const p of tree) used += Math.max(0, p.cpuSeconds - (this.prevList.get(p.pid)?.cpuSeconds ?? 0));
      }
      const mem = tree.reduce((n, p) => n + p.memBytes, 0);
      this.count(t.id, used, this.prevList && dt > 0 ? used / dt : 0, mem);
    }
    this.prevList = list;
    this.prevAt = at;

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
          this.count(t.id, delta, prev === undefined || dt <= 0 ? 0 : delta / dt, usage.memBytes);
          this.counters.get(t.id)!.lastGroupCpu = usage.cpuSeconds;
        }
      }
    } finally {
      this.containerBusy = false;
    }
  }
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
