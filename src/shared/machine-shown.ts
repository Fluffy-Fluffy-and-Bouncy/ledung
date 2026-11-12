// When the machine's figures are worth sending to the pages (#230, audit O6). The server measured every 5 s
// and sent each sample to every page, though most samples changed nothing a person would notice. The
// formatters live here so that the page and this comparison can't drift apart (web/src/usage/MachinePanel.tsx
// re-exports them).
import type { MachineInfo } from './protocol.ts';

export function formatCores(n: number): string {
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${n >= 0.95 && n < 1.05 ? 'core' : 'cores'}`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** A load meter's level, as MachinePanel's Load colours it: busy from 80 %, full from 95 %. */
export function meterLevel(share: number): 'good' | 'warning' | 'critical' {
  return share >= 0.95 ? 'critical' : share >= 0.8 ? 'warning' : 'good';
}
const level = meterLevel;

const share = (used: number, total: number): number => (total > 0 ? used / total : 0);

/**
 * A whole-machine meter is sent again once it moves this far (5 points of 100) or changes level. Shown to
 * 0.1 core, a computer's own CPU moved on 12 of 12 samples with nothing working, so an idle Ledung sent a
 * `machine` event every 5 s anyway; 5 points is a change a person reading a load gauge notices (decided by
 * the lead on Ledung question #2064, option a).
 */
export const METER_STEP = 0.05;

/** The meters of the whole machine and Docker's VM, as shares of their total: CPU, memory, then Docker's CPU and memory. */
export function machineMeters(m: MachineInfo): number[] {
  const d = m.docker;
  return [share(m.cores, m.cpus), share(m.memUsed, m.memTotal), ...(d ? [share(d.cores, d.cpus), share(d.memUsed, d.memTotal)] : [])];
}

/**
 * Everything else of `m` that reaches the screen, as it reads there: each session's figures, the
 * working count, the limit and the line exactly, and of the meters what doesn't move with load (the
 * totals, whether Docker runs). Its time (`at`) is left out: no page shows it.
 */
export function machineExact(m: MachineInfo): string {
  const d = m.docker;
  return JSON.stringify([
    m.cpus, formatBytes(m.memTotal), d && [d.cpus, formatBytes(d.memTotal)],
    Object.entries(m.sessions).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, f]) => [id, formatCores(f.cores), formatBytes(f.memBytes)]),
    m.working, m.limit, m.line,
  ]);
}

/** Whether a meter moved far enough since the last one sent to be sent again: METER_STEP, or a new level. */
export function meterMoved(was: number, now: number): boolean {
  // A hair under the step, so a move of exactly 5 points isn't lost to floating point.
  return Math.abs(now - was) >= METER_STEP - 1e-9 || level(now) !== level(was);
}

/**
 * Wraps `send` for the machine's figures. With `onlyIfChanged` (a sample) it sends only when a session's
 * figures, the working count, the limit or the line show differently, or a whole-machine meter moved
 * (meterMoved) since the last one sent; without (the limit or a pause changed by hand), always.
 */
export function machineSender(send: (m: MachineInfo) => void): (m: MachineInfo, onlyIfChanged?: boolean) => void {
  let last: { exact: string; meters: number[] } | null = null;
  return (m, onlyIfChanged = false) => {
    const exact = machineExact(m);
    const meters = machineMeters(m);
    const same = last !== null && exact === last.exact && meters.length === last.meters.length
      && meters.every((v, i) => !meterMoved(last!.meters[i]!, v));
    if (onlyIfChanged && same) return;
    last = { exact, meters };
    send(m);
  };
}
