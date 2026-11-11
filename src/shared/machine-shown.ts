// What the page shows of the machine's figures (#230, audit O6). The server sends a `machine` event only
// when this changes: it measured every 5 s and sent each sample to every page, though a figure that moved
// in a digit the page doesn't show changed nothing on screen. The formatters live here so that the page
// and this comparison can't drift apart (web/src/usage/MachinePanel.tsx re-exports them).
import type { MachineInfo } from './protocol.ts';

export function formatCores(n: number): string {
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${n >= 0.95 && n < 1.05 ? 'core' : 'cores'}`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** A load meter as MachinePanel's Load shows it: its percentage and its colour (busy from 80 %, full from 95 %). */
function percent(used: number, total: number): string {
  const share = total > 0 ? used / total : 0;
  return `${Math.round(share * 100)}${share >= 0.95 ? '!' : share >= 0.8 ? '^' : ''}`;
}

/**
 * Everything of `m` that reaches the screen, as it reads there; two infos with the same key look the
 * same on the page. Its time (`at`) is left out: no page shows it.
 */
export function machineShown(m: MachineInfo): string {
  const d = m.docker;
  return JSON.stringify([
    m.cpus, formatCores(m.cores), percent(m.cores, m.cpus),
    formatBytes(m.memUsed), formatBytes(m.memTotal), percent(m.memUsed, m.memTotal),
    d && [formatCores(d.cores), formatBytes(d.memUsed), formatBytes(d.memTotal), percent(d.memUsed, d.memTotal)],
    Object.entries(m.sessions).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, f]) => [id, formatCores(f.cores), formatBytes(f.memBytes)]),
    m.working, m.limit, m.line,
  ]);
}

/**
 * Wraps `send` for the machine's figures: with `onlyIfChanged` (a sample) it sends only when what the
 * page shows differs from the last one sent; without (the limit or a pause changed), always.
 */
export function machineSender(send: (m: MachineInfo) => void): (m: MachineInfo, onlyIfChanged?: boolean) => void {
  let last: string | null = null;
  return (m, onlyIfChanged = false) => {
    const shown = machineShown(m);
    if (onlyIfChanged && shown === last) return;
    last = shown;
    send(m);
  };
}
