// How much of the machine's memory is in use, per platform. Node's os.freemem() counts only memory nothing
// holds at all. macOS keeps that near zero on purpose (spare memory holds file cache it gives back at once),
// so total minus free reads as full; Linux's MemFree has the same problem. Here "used" means what can't be
// handed out without swapping, as the system's own monitors show it.
// - macOS: app memory + wired + compressed, as Activity Monitor's "Memory Used", from `vm_stat`.
// - Linux: MemTotal - MemAvailable from /proc/meminfo.
// - Windows: os.freemem() is already the available memory.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Activity Monitor's "Memory Used" from `vm_stat` output: anonymous - purgeable + wired + compressor. Null if unreadable. */
export function parseVmStat(stdout: string): number | null {
  const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (label: string) => Number(stdout.match(new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm'))?.[1]);
  const used = pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor');
  return pageSize > 0 && Number.isFinite(used) ? used * pageSize : null;
}

/** MemTotal - MemAvailable from /proc/meminfo, in bytes. Null if unreadable. */
export function parseMeminfo(text: string): number | null {
  const kb = (label: string) => Number(text.match(new RegExp(`^${label}:\\s+(\\d+) kB`, 'm'))?.[1]);
  const used = kb('MemTotal') - kb('MemAvailable');
  return Number.isFinite(used) ? used * 1024 : null;
}

/** Memory in use, in bytes. Falls back to total minus free if the platform's own figure can't be read. */
export async function memoryUsed(): Promise<number> {
  try {
    if (process.platform === 'darwin') {
      const used = parseVmStat((await run('vm_stat')).stdout);
      if (used !== null) return Math.min(used, os.totalmem());
    } else if (process.platform === 'linux') {
      const used = parseMeminfo(await fs.readFile('/proc/meminfo', 'utf8'));
      if (used !== null) return used;
    }
  } catch {
    // Fall through to Node's figure.
  }
  return os.totalmem() - os.freemem();
}
