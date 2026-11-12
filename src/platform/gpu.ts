// GPU readings for resource limits (docs/steps/resource-limits.md, "Measuring the GPU per OS"): every GPU's load and
// memory, and per process the same, so a job's share can be judged. Cumulative busy times are turned into a load by
// differences between samples, as CPU time is in processes.ts.
// - Windows: WDDM's GPU performance counters, read by the measuring PowerShell loop (processes.ts) through the CIM
//   *raw* classes: Get-Counter took 20 s per read on the test PC, and the formatted classes round each row to a whole
//   number. Per process the counters' LocalUsage (DedicatedUsage was wrong there: 4.7 TB for a video player).
//   Names and sizes from DXGI's adapter list (Win32_VideoController's size is capped at 4 GB).
// - Linux: nvidia-smi for NVIDIA; the kernel's per-process DRM figures (/proc/<pid>/fdinfo) for AMD and Intel, and
//   amdgpu's sysfs files for AMD's totals.
// - macOS: ioreg's "Device Utilization %" for the whole GPU; per process isn't readable without root.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GpuAdapterInfo {
  /** Stable within one Ledung: Windows' LUID ("0x00000000_0x000171fe"), Linux's PCI address or nvidia's index, "mac". */
  id: string;
  name: string;
  /** Its own memory in bytes; null: none of its own (integrated) or not known. */
  vramTotal: number | null;
}

/** One reading, as cumulative counters where the platform gives them. */
export interface GpuRaw {
  adapters: GpuAdapterInfo[];
  /** Busy time per process and engine, in seconds, cumulative. Key: `${adapter}|${engine}`. */
  engines: { pid: number; adapter: string; engine: string; busySeconds: number }[];
  /** A load already in percent per adapter (nvidia-smi, sysfs, ioreg); used when no engine times are given for it. */
  adapterLoad: Record<string, number>;
  /** A load already in percent per process (nvidia-smi pmon). */
  processLoad: { pid: number; adapter: string; percent: number }[];
  /** Memory per process on an adapter, in bytes. */
  processMem: { pid: number; adapter: string; bytes: number }[];
  /** Memory used on each adapter, in bytes. */
  adapterMem: Record<string, number>;
  /** Why there is nothing, when there is nothing. */
  problem?: string;
}

export interface GpuReading {
  at: number;
  adapters: (GpuAdapterInfo & { load: number; vramUsed: number | null })[];
  /** Per process: its load (%) per engine and adapter, and its memory per adapter. */
  perPid: Map<number, { engines: Map<string, number>; mem: Map<string, number> }>;
  /** Engines per adapter, `${adapter}|${engine}`, so a group of processes can be summed the same way. */
  problem?: string;
}

export function emptyRaw(problem?: string): GpuRaw {
  return { adapters: [], engines: [], adapterLoad: {}, processLoad: [], processMem: [], adapterMem: {}, ...(problem ? { problem } : {}) };
}

// --- Windows ------------------------------------------------------------------------------------------------------

const WIN_ENGINE = /^pid_(\d+)_luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_(.*)$/i;
const WIN_MEM = /^pid_(\d+)_luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\d+)$/i;
const WIN_ADAPTER = /^luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\d+)$/i;

const luidKey = (high: string, low: string) => `${high.toLowerCase()}_${low.toLowerCase()}`;

/**
 * The GPU lines of one batch from the PowerShell loop (processes.ts):
 * - `G A,<luid>,<vram bytes>,<flags>,<name>` per adapter from DXGI (flags 2: software, skipped);
 * - `G E,<counter instance>,<running time in 100 ns>` per engine row with time;
 * - `G M,<instance>,<local bytes>` per process with memory;
 * - `G D,<instance>,<dedicated bytes>` per adapter;
 * - `G X,<why>` when the counters can't be read.
 */
export function parseWindowsGpu(lines: string[]): GpuRaw {
  const raw = emptyRaw();
  for (const full of lines) {
    const line = full.slice(2);
    const kind = line[0];
    const rest = line.slice(2);
    if (kind === 'X') {
      raw.problem = rest.trim() || 'the GPU counters could not be read';
      continue;
    }
    if (kind === 'A') {
      const [luid, vram, flags, ...name] = rest.split(',');
      const m = luid?.match(/^(0x[0-9a-f]+)_(0x[0-9a-f]+)$/i);
      if (!m || (Number(flags) & 2) !== 0) continue;
      const bytes = Number(vram);
      raw.adapters.push({ id: luidKey(m[1]!, m[2]!), name: name.join(',').trim() || 'GPU', vramTotal: bytes > 0 ? bytes : null });
      continue;
    }
    const comma = rest.lastIndexOf(',');
    if (comma < 0) continue;
    const instance = rest.slice(0, comma);
    const value = Number(rest.slice(comma + 1));
    if (!Number.isFinite(value) || value < 0) continue;
    if (kind === 'E') {
      const m = instance.match(WIN_ENGINE);
      if (m) raw.engines.push({ pid: Number(m[1]), adapter: luidKey(m[2]!, m[3]!), engine: `${m[4]}.${m[5]}.${m[6]!.trim()}`, busySeconds: value / 1e7 });
    } else if (kind === 'M') {
      const m = instance.match(WIN_MEM);
      if (m && value > 0) raw.processMem.push({ pid: Number(m[1]), adapter: luidKey(m[2]!, m[3]!), bytes: value });
    } else if (kind === 'D') {
      const m = instance.match(WIN_ADAPTER);
      if (m) raw.adapterMem[luidKey(m[1]!, m[2]!)] = (raw.adapterMem[luidKey(m[1]!, m[2]!)] ?? 0) + value;
    }
  }
  return raw;
}

/**
 * The PowerShell for one GPU read, run inside the measuring loop. DXGI's adapter list is read once (`Add-Type` takes
 * ~0.2 s), the counters every round through the raw CIM classes (~0.1–0.2 s for ~1000 rows on the test PC). No
 * input from outside goes into it.
 */
export const WINDOWS_GPU_SETUP = `
$ledungGpuAdapters = @()
$ledungGpuOk = $true
$ledungGpuRound = 0
$ledungGpuFails = 0
$ledungGpuNext = 0
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class LedungDxgi {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DESC { [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description; public uint VendorId, DeviceId, SubSysId, Revision; public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory; public uint LuidLow; public int LuidHigh; public uint Flags; }
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIAdapter1 { void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent(); void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport(); [PreserveSig] int GetDesc1(out DESC d); }
  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIFactory1 { void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent(); void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter(); [PreserveSig] int EnumAdapters1(uint i, out IDXGIAdapter1 a); }
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IDXGIFactory1 f);
  public static string[] List() {
    var g = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); IDXGIFactory1 f;
    if (CreateDXGIFactory1(ref g, out f) != 0) return new string[0];
    var list = new System.Collections.Generic.List<string>(); IDXGIAdapter1 a;
    for (uint i = 0; i < 16 && f.EnumAdapters1(i, out a) == 0; i++) { DESC d; if (a.GetDesc1(out d) != 0) continue; list.Add(String.Format("0x{0:X8}_0x{1:X8},{2},{3},{4}", d.LuidHigh, d.LuidLow, d.DedicatedVideoMemory, d.Flags, d.Description.Replace(",", " "))); }
    return list.ToArray();
  }
}
'@
  $ledungGpuAdapters = [LedungDxgi]::List()
} catch { }
`;

export const WINDOWS_GPU_READ = `
  # After a failed read, try again after 1, 2, 4 and 8 rounds, then every 12th (security review, finding 7): the
  # first reads after a start can come back empty while Windows readies its counters (acceptance test, finding 4).
  # Each read has a timeout so a stuck counter provider can't hang the loop and the CPU figures with it (finding 6).
  $ledungGpuRound++
  if ($ledungGpuOk -or ($ledungGpuRound -ge $ledungGpuNext)) {
    # A driver update or reset gives a GPU a new id: the list is read again every 60th round (finding 8).
    if (($ledungGpuRound % 60 -eq 0) -and ([System.Management.Automation.PSTypeName]'LedungDxgi').Type) { $ledungGpuAdapters = [LedungDxgi]::List() }
    foreach ($a in $ledungGpuAdapters) { [Console]::Out.WriteLine("G A,$a") }
    $ge = Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -Property Name,RunningTime -OperationTimeoutSec 10
    if ($null -eq $ge) {
      $ledungGpuOk = $false
      $ledungGpuFails++
      $ledungGpuNext = $ledungGpuRound + [Math]::Min(12, [Math]::Pow(2, $ledungGpuFails - 1))
      [Console]::Out.WriteLine('G X,Windows GPU performance counters returned nothing')
    } else {
      $ledungGpuOk = $true
      $ledungGpuFails = 0
      foreach ($x in $ge) { if ([uint64]$x.RunningTime -gt 0) { [Console]::Out.WriteLine("G E,$($x.Name),$($x.RunningTime)") } }
      foreach ($x in (Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory -Property Name,LocalUsage -OperationTimeoutSec 10)) { if ([uint64]$x.LocalUsage -gt 0) { [Console]::Out.WriteLine("G M,$($x.Name),$($x.LocalUsage)") } }
      foreach ($x in (Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory -Property Name,DedicatedUsage -OperationTimeoutSec 10)) { [Console]::Out.WriteLine("G D,$($x.Name),$($x.DedicatedUsage)") }
    }
  } else { [Console]::Out.WriteLine('G X,Windows GPU performance counters returned nothing') }
`;

// --- Linux --------------------------------------------------------------------------------------------------------

/** `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaGpus(stdout: string): { id: string; name: string; load: number; used: number; total: number }[] {
  const out: { id: string; name: string; load: number; used: number; total: number }[] = [];
  for (const line of stdout.split('\n')) {
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 5 || !/^\d+$/.test(f[0]!)) continue;
    const num = (s: string) => (/^[\d.]+$/.test(s) ? Number(s) : NaN);
    out.push({ id: `nvidia${f[0]}`, name: f[1]!, load: num(f[2]!) || 0, used: (num(f[3]!) || 0) * 1024 * 1024, total: (num(f[4]!) || 0) * 1024 * 1024 });
  }
  return out;
}

/** `nvidia-smi --query-compute-apps=gpu_bus_id... ` is not needed: `pmon -c 1 -s um` gives index, pid, sm %, and fb MB. */
export function parseNvidiaPmon(stdout: string): { pid: number; adapter: string; percent: number; bytes: number }[] {
  const out: { pid: number; adapter: string; percent: number; bytes: number }[] = [];
  let cols: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#')) {
      if (!cols.length) cols = t.slice(1).trim().split(/\s+/);
      continue;
    }
    const f = t.split(/\s+/);
    // A whole row only: a process name (the last column) can't carry enough columns to forge one (security review, finding 4).
    if (!cols.length || f.length < cols.length) continue;
    const gpu = f[cols.indexOf('gpu')];
    const pid = Number(f[cols.indexOf('pid')]);
    if (!gpu || !/^\d+$/.test(gpu) || !Number.isInteger(pid) || pid <= 0) continue;
    const val = (name: string) => {
      const v = f[cols.indexOf(name)];
      return v !== undefined && /^[\d.]+$/.test(v) ? Number(v) : 0;
    };
    out.push({ pid, adapter: `nvidia${gpu}`, percent: val('sm'), bytes: val('fb') * 1024 * 1024 });
  }
  return out;
}

/**
 * One DRM client's fdinfo (Linux 5.19+ for amdgpu, i915, xe): its device, client id, busy time per engine (ns,
 * cumulative) and memory in VRAM. Null for a file that isn't a DRM client.
 */
export function parseDrmFdinfo(text: string): { pdev: string; client: string; engines: Record<string, number>; vram: number } | null {
  let pdev = '';
  let client = '';
  const engines: Record<string, number> = {};
  let vram = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];
    if (key === 'drm-pdev') pdev = value.trim();
    else if (key === 'drm-client-id') client = value.trim();
    else if (key.startsWith('drm-engine-') && !key.startsWith('drm-engine-capacity-')) {
      const n = value.match(/^(\d+)\s*ns/);
      if (n) engines[key.slice('drm-engine-'.length)] = Number(n[1]) / 1e9;
    } else if (key === 'drm-memory-vram' || key === 'drm-resident-vram') {
      const n = value.match(/^(\d+)\s*(KiB|MiB|GiB)?/);
      if (n) vram = Math.max(vram, Number(n[1]) * ({ KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[n[2] ?? ''] ?? 1));
    }
  }
  return pdev && client ? { pdev, client, engines, vram } : null;
}

async function readLinux(pids: number[]): Promise<GpuRaw> {
  const raw = emptyRaw();
  // NVIDIA, through its own tool when it is there.
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000 });
    for (const g of parseNvidiaGpus(stdout)) {
      raw.adapters.push({ id: g.id, name: g.name, vramTotal: g.total || null });
      raw.adapterLoad[g.id] = g.load;
      raw.adapterMem[g.id] = g.used;
    }
    if (raw.adapters.length) {
      const pmon = await run('nvidia-smi', ['pmon', '-c', '1', '-s', 'um'], { timeout: 4000 }).catch(() => ({ stdout: '' }));
      for (const p of parseNvidiaPmon(pmon.stdout)) {
        raw.processLoad.push({ pid: p.pid, adapter: p.adapter, percent: p.percent });
        if (p.bytes > 0) raw.processMem.push({ pid: p.pid, adapter: p.adapter, bytes: p.bytes });
      }
    }
  } catch {
    // No NVIDIA tool: the DRM figures below.
  }
  // AMD and Intel: each process's DRM clients, one count per client (a client can be open on several files).
  // Only processes this user can read: another user's (a root display server) is left out of the totals.
  const seen = new Set<string>();
  const devices = new Set<string>();
  const clientsOf = async (pid: number) => {
    const out: { pid: number; info: NonNullable<ReturnType<typeof parseDrmFdinfo>> }[] = [];
    let fds: string[];
    try {
      fds = await fs.readdir(`/proc/${pid}/fdinfo`);
    } catch {
      return out;
    }
    for (const fd of fds) {
      try {
        if (!(await fs.readlink(`/proc/${pid}/fd/${fd}`)).startsWith('/dev/dri/')) continue;
        const info = parseDrmFdinfo(await fs.readFile(`/proc/${pid}/fdinfo/${fd}`, 'utf8'));
        if (info) out.push({ pid, info });
      } catch {
        // Closed meanwhile.
      }
    }
    return out;
  };
  for (let i = 0; i < pids.length; i += 64) {
    for (const { pid, info } of (await Promise.all(pids.slice(i, i + 64).map(clientsOf))).flat()) {
      if (seen.has(`${info.pdev}|${info.client}`)) continue;
      seen.add(`${info.pdev}|${info.client}`);
      devices.add(info.pdev);
      for (const [engine, s] of Object.entries(info.engines)) raw.engines.push({ pid, adapter: info.pdev, engine, busySeconds: s });
      if (info.vram > 0) raw.processMem.push({ pid, adapter: info.pdev, bytes: info.vram });
    }
  }
  for (const pdev of devices) {
    if (!/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/i.test(pdev)) continue;
    const dir = path.join('/sys/bus/pci/devices', pdev);
    const num = async (f: string) => Number((await fs.readFile(path.join(dir, f), 'utf8').catch(() => '')).trim()) || 0;
    const total = await num('mem_info_vram_total');
    const vendor = (await fs.readFile(path.join(dir, 'vendor'), 'utf8').catch(() => '')).trim();
    raw.adapters.push({ id: pdev, name: vendor === '0x1002' ? `AMD GPU ${pdev}` : vendor === '0x8086' ? `Intel GPU ${pdev}` : `GPU ${pdev}`, vramTotal: total > 0 ? total : null });
    const busy = await fs.readFile(path.join(dir, 'gpu_busy_percent'), 'utf8').catch(() => null);
    if (busy !== null && /^\d+/.test(busy.trim())) raw.adapterLoad[pdev] = Number(busy.trim());
    if (total > 0) raw.adapterMem[pdev] = await num('mem_info_vram_used');
  }
  if (!raw.adapters.length) raw.problem = 'no GPU readings: no nvidia-smi, and no GPU in use by your processes reports its figures';
  return raw;
}

// --- macOS --------------------------------------------------------------------------------------------------------

/** `ioreg -r -d 1 -w 0 -c IOAccelerator`: each accelerator's "Device Utilization %". */
export function parseIoreg(stdout: string): { name: string; load: number }[] {
  const out: { name: string; load: number }[] = [];
  const blocks = stdout.split(/\n(?=\+-o )/);
  for (const b of blocks) {
    const util = b.match(/"Device Utilization %"\s*=\s*(\d+)/);
    if (!util) continue;
    const name = b.match(/"model"\s*=\s*"([^"]*)"/)?.[1] ?? b.match(/\+-o\s+(\S+)/)?.[1] ?? 'GPU';
    out.push({ name, load: Number(util[1]) });
  }
  return out;
}

async function readMac(): Promise<GpuRaw> {
  const raw = emptyRaw();
  try {
    const { stdout } = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
    parseIoreg(stdout).forEach((g, i) => {
      // Apple's GPUs share memory with the CPU: no GPU memory of their own (counted in Memory).
      raw.adapters.push({ id: `mac${i}`, name: g.name, vramTotal: null });
      raw.adapterLoad[`mac${i}`] = g.load;
    });
  } catch {
    // Nothing.
  }
  if (!raw.adapters.length) raw.problem = 'no GPU readings: ioreg reported no GPU load';
  return raw;
}

/** One GPU read for macOS and Linux; on Windows the measuring loop brings it with each process list. */
export function readGpuPosix(pids: number[]): Promise<GpuRaw> {
  if (process.platform === 'darwin') return readMac();
  if (process.platform === 'linux') return readLinux(pids);
  return Promise.resolve(emptyRaw('GPU readings are not available on this system'));
}

// --- From cumulative counters to loads ----------------------------------------------------------------------------

/** Keeps the last cumulative times, so each reading becomes loads over the time since. */
export class GpuTracker {
  private prev: Map<string, number> | null = null;
  private carried = new Set<string>();
  private prevAt = 0;
  private names = new Map<string, GpuAdapterInfo>();

  update(raw: GpuRaw, at: number): GpuReading {
    // Two cards of the same model get "#1", "#2" in the system's order, so each has its own limit and can be named
    // in reserve (acceptance test, finding 10). Limits are kept by this name, which survives a reboot.
    const count = new Map<string, number>();
    for (const a of raw.adapters) count.set(a.name, (count.get(a.name) ?? 0) + 1);
    const nth = new Map<string, number>();
    for (const a of raw.adapters) {
      const k = (nth.get(a.name) ?? 0) + 1;
      nth.set(a.name, k);
      this.names.set(a.id, count.get(a.name)! > 1 ? { ...a, name: `${a.name} #${k}` } : a);
    }
    const times = new Map<string, number>();
    for (const e of raw.engines) times.set(`${e.pid}|${e.adapter}|${e.engine}`, (times.get(`${e.pid}|${e.adapter}|${e.engine}`) ?? 0) + e.busySeconds);
    const dt = (at - this.prevAt) / 1000;
    const perPid = new Map<number, { engines: Map<string, number>; mem: Map<string, number> }>();
    const pidEntry = (pid: number) => {
      let p = perPid.get(pid);
      if (!p) perPid.set(pid, (p = { engines: new Map(), mem: new Map() }));
      return p;
    };
    const engineTotals = new Map<string, number>();
    const prevPids = new Set([...(this.prev?.keys() ?? [])].map((k) => k.split('|')[0]!));
    if (this.prev && dt > 0) {
      for (const [key, t] of times) {
        // A row with no time last round was not printed: it was 0 (processes.ts prints only rows with time), but only
        // for a process new since then. A known process's row that went missing for a round (a partial read) is a new
        // baseline, not a whole lifetime of busy time in one interval (security review, finding 9).
        const before = this.prev.get(key);
        if (before === undefined && prevPids.has(key.split('|')[0]!)) continue;
        const d = Math.max(0, t - (before ?? 0));
        if (d <= 0) continue;
        const [pid, adapter, engine] = key.split('|') as [string, string, string];
        const pct = Math.min(100, (d / dt) * 100);
        const ek = `${adapter}|${engine}`;
        pidEntry(Number(pid)).engines.set(ek, (pidEntry(Number(pid)).engines.get(ek) ?? 0) + pct);
        engineTotals.set(ek, (engineTotals.get(ek) ?? 0) + pct);
      }
    }
    // Rows missing this round are kept for one more, so a gap of one round doesn't reset them; an exited process's go after that.
    const carried = new Set<string>();
    if (this.prev && raw.engines.length) {
      for (const [key, t] of this.prev) {
        if (times.has(key) || this.carried.has(key)) continue;
        times.set(key, t);
        carried.add(key);
      }
    }
    // A read with no engine rows (failed, or the counters not ready yet) is no baseline: the next read would count
    // every process's whole lifetime as one interval (seen in the merge check: 100% right after a failed first read).
    if (raw.engines.length) {
      this.carried = carried;
      this.prev = times;
      this.prevAt = at;
    }
    for (const p of raw.processLoad) pidEntry(p.pid).engines.set(`${p.adapter}|load`, p.percent);
    for (const m of raw.processMem) pidEntry(m.pid).mem.set(m.adapter, (pidEntry(m.pid).mem.get(m.adapter) ?? 0) + m.bytes);
    // With an adapter list, only its GPUs: Windows' list leaves out the software renderer, which the counters include.
    const ids = new Set<string>(raw.adapters.length ? raw.adapters.map((a) => a.id) : [...Object.keys(raw.adapterMem), ...[...engineTotals.keys()].map((k) => k.split('|')[0]!)]);
    // One the list doesn't name but that has memory of its own in use (a new id after a driver reset) is kept too.
    if (raw.adapters.length) for (const [id, used] of Object.entries(raw.adapterMem)) if (used > 0) ids.add(id);
    const adapters = [...ids].map((id) => {
      const info = this.names.get(id) ?? { id, name: 'GPU', vramTotal: null };
      let load = raw.adapterLoad[id];
      if (load === undefined) {
        load = 0;
        // As Task Manager: the busiest engine's load.
        for (const [k, v] of engineTotals) if (k.startsWith(`${id}|`)) load = Math.max(load, v);
      }
      return { ...info, load: Math.min(100, load), vramUsed: raw.adapterMem[id] ?? null };
    });
    return { at, adapters, perPid, ...(raw.problem && !adapters.length ? { problem: raw.problem } : {}) };
  }
}

/** A group of processes' load on one adapter: per engine the sum over the processes, then the busiest engine. */
export function groupLoad(reading: GpuReading | null, pids: Iterable<number>, adapter: string): number {
  if (!reading) return 0;
  const sums = new Map<string, number>();
  for (const pid of pids) {
    const p = reading.perPid.get(pid);
    if (!p) continue;
    for (const [k, v] of p.engines) if (k.startsWith(`${adapter}|`)) sums.set(k, (sums.get(k) ?? 0) + v);
  }
  let max = 0;
  for (const v of sums.values()) max = Math.max(max, v);
  return Math.min(100, max);
}

/** A group of processes' memory on one adapter, in bytes. */
export function groupMem(reading: GpuReading | null, pids: Iterable<number>, adapter: string): number {
  if (!reading) return 0;
  let n = 0;
  for (const pid of pids) n += reading.perPid.get(pid)?.mem.get(adapter) ?? 0;
  return n;
}

/**
 * The GPU that limits and reservations mean by default: the one with the most memory of its own; with none known,
 * the busiest. Integrated GPUs with no memory of their own come after any with some.
 */
export function mainGpu(reading: GpuReading | null): string | null {
  if (!reading?.adapters.length) return null;
  const sorted = [...reading.adapters].sort((a, b) => (b.vramTotal ?? 0) - (a.vramTotal ?? 0) || (b.vramUsed ?? 0) - (a.vramUsed ?? 0) || b.load - a.load);
  return sorted[0]!.id;
}
