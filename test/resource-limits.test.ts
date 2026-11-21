// Resource limits (docs/steps/resource-limits.md): the decisions, the GPU readings, the reservations' life, holds and
// priorities, learning, and the page's helpers. Processes and priorities are fakes: nothing here touches the PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import {
  ALLOWANCE, Averages, DEFAULT_SETTINGS, GB, grantPass, marginOf, notFitting, NOT_OVER, overStep, roomReason, unusedOf, type LineItem,
} from '../src/resources/limits.ts';
import { GpuTracker, type GpuReading, groupLoad, groupMem, mainGpu, parseDrmFdinfo, parseIoreg, parseNvidiaGpus, parseNvidiaPmon, parseWindowsGpu } from '../src/platform/gpu.ts';
import { parseWindowsLines, windowsBatchReader, type ProcInfo, type ProcessList } from '../src/platform/processes.ts';
import { ResourceBook, LAPSE_MS, RESOURCE_SOURCE, type BookSample, type BookSession } from '../src/resources/book.ts';
import { JobStore, fromGeneric, toGeneric } from '../src/resources/jobs.ts';
import { detaches, freesResources, heavyKinds } from '../src/resources/commands.ts';
import { FRESH_FACTS, idleStopBlocker } from '../src/sessions/idle.ts';
import { wslHintDue } from '../web/src/usage/machineFold.ts';
import { LOWERED, type PriorityControl } from '../src/platform/process-control.ts';
import { dragMax, dragStep, dragText, dragValue, limitShare, limitText, limitUnits, overFor, parseLimitInput, stepDrag, valueShare } from '../web/src/usage/resourceLimits.ts';
import { commandIsCalls, fileTimeMs, JOB_BUSY, JobActions, jobProcessesNow, jobTargetsNow, provenByCommand, type FreshProcess } from '../src/resources/job-actions.ts';
import { jobActionNote, namesText, stopConfirmText } from '../src/shared/job-notes.ts';
import { hostStill } from '../src/resources/monitor.ts';

// --- Decisions ------------------------------------------------------------------------------------------------------

test('a start fits only if the averaged total plus reserved-but-unused plus the request stays under the limit', () => {
  const limits = { cpu: 50, 'gpu:a': 50 };
  assert.deepEqual(notFitting({ cpu: 20 }, { cpu: 20 }, { cpu: 5 }, limits), []);
  assert.deepEqual(notFitting({ cpu: 20 }, { cpu: 20 }, { cpu: 15 }, limits), ['cpu']);
  // A resource with no limit is never in the way.
  assert.deepEqual(notFitting({ ram: 100 * GB }, { ram: 60 * GB }, {}, limits), []);
  // A 100% GPU job under a 50% limit can never fit: it waits until the limit is raised (point 3).
  assert.deepEqual(notFitting({ 'gpu:a': 100 }, {}, {}, limits), ['gpu:a']);
  assert.deepEqual(unusedOf({ ram: 8 * GB }, { ram: 2 * GB }), { ram: 6 * GB });
  assert.deepEqual(unusedOf({ cpu: 10 }, { cpu: 30 }), { cpu: 0 });
});

test('the line goes by priority then age; a waiting entry holds back only later entries for the same resource', () => {
  const limits = { cpu: 50, 'gpu:a': 50 };
  const items: LineItem[] = [
    { id: 'gpuBig', priority: 'normal' as const, since: 1, need: { 'gpu:a': 45 } },
    { id: 'gpuSmall', priority: 'normal' as const, since: 2, need: { 'gpu:a': 10 } },
    { id: 'cpu', priority: 'normal' as const, since: 3, need: { cpu: 20 } },
    { id: 'urgent', priority: 'critical' as const, since: 4, need: { cpu: 20 } },
    { id: 'cpu2', priority: 'normal' as const, since: 5, need: { cpu: 20 } },
  ];
  const pass = grantPass(items, { cpu: 0, 'gpu:a': 20 }, {}, limits);
  // The critical one first; the second CPU job fits after it; the third doesn't; the small GPU job waits behind the big.
  assert.deepEqual(pass.granted, ['urgent', 'cpu']);
  assert.deepEqual(pass.waiting.get('gpuBig'), { kind: 'room', dims: ['gpu:a'] });
  assert.deepEqual(pass.waiting.get('gpuSmall'), { kind: 'behind', dims: ['gpu:a'], behind: 'gpuBig' });
  assert.equal(pass.waiting.get('cpu2')?.kind, 'room');
  // One asking more than the limit itself holds back no one: only a higher limit helps it (security review, finding 2).
  const never = grantPass([{ id: 'huge', priority: 'normal', since: 1, need: { 'gpu:a': 100 } }, { id: 'small', priority: 'normal', since: 2, need: { 'gpu:a': 10 } }], {}, {}, limits);
  assert.deepEqual(never.granted, ['small']);
  assert.deepEqual(never.waiting.get('huge'), { kind: 'room', dims: ['gpu:a'] });
  // Start now goes above the limits; a held session's entry waits.
  const forced = grantPass([{ ...items[0]!, forced: true }, { ...items[2]!, held: true }], {}, {}, limits);
  assert.deepEqual(forced.granted, ['gpuBig']);
  assert.deepEqual(forced.waiting.get('cpu'), { kind: 'held' });
});

test('a running job counts as over only after its average stays above share plus margin for the whole time, and back only after the same time within it', () => {
  const s = { ...DEFAULT_SETTINGS, overSec: 60 };
  let st = NOT_OVER;
  let r = overStep(st, { cpu: 35 }, { cpu: 30 }, s, 0);
  assert.equal(r.state.since, null, 'within the 10-point margin');
  r = overStep(st, { cpu: 45 }, { cpu: 30 }, s, 1000);
  st = r.state;
  assert.equal(st.over, false);
  r = overStep(st, { cpu: 45 }, { cpu: 30 }, s, 60_000);
  assert.equal(r.change, null, '59 s is not yet a minute');
  r = overStep(r.state, { cpu: 45 }, { cpu: 30 }, s, 61_000);
  assert.equal(r.change, 'over');
  assert.deepEqual(r.state.dims, ['cpu']);
  r = overStep(r.state, { cpu: 39 }, { cpu: 30 }, s, 62_000);
  assert.equal(r.change, null, 'back only once within its share for the whole time too (acceptance test, finding 2)');
  // Back over before that: the clock for "back" starts again, so it doesn't flap.
  r = overStep(r.state, { cpu: 45 }, { cpu: 30 }, s, 90_000);
  assert.equal(r.change, null);
  assert.equal(r.state.over, true);
  r = overStep(r.state, { cpu: 39 }, { cpu: 30 }, s, 100_000);
  r = overStep(r.state, { cpu: 39 }, { cpu: 30 }, s, 159_000);
  assert.equal(r.change, null, '59 s back is not yet a minute');
  r = overStep(r.state, { cpu: 39 }, { cpu: 30 }, s, 160_000);
  assert.equal(r.change, 'back');
  // A spike that drops before the minute is up changes nothing.
  let spike = overStep(NOT_OVER, { cpu: 90 }, { cpu: 30 }, s, 0);
  spike = overStep(spike.state, { cpu: 20 }, { cpu: 30 }, s, 30_000);
  assert.equal(spike.change, null);
  assert.equal(spike.state.since, null);
  // Undeclared resources count as reserving almost nothing (point 7).
  const und = overStep(NOT_OVER, { ram: 1.2 * GB }, { cpu: 30 }, { ...s, overSec: 0 }, 0);
  assert.equal(und.change, 'over');
});

test('memory margins are 10% of the share, at least 0.5 GB; CPU and GPU margins are points', () => {
  assert.equal(marginOf('ram', 2 * GB, DEFAULT_SETTINGS), 0.5 * GB);
  assert.equal(marginOf('vram:a', 20 * GB, DEFAULT_SETTINGS), 2 * GB);
  assert.equal(marginOf('gpu:a', 40, DEFAULT_SETTINGS), 10);
  assert.equal(ALLOWANCE.percent, 5);
});

test('the reason in the line says what is needed and what is left, or that only a higher limit helps', () => {
  assert.equal(roomReason('gpu:a', 100, 10, 0, 50, 'GPU'), 'Waiting for GPU room: needs ~100%, limit 50%');
  assert.equal(roomReason('ram', 12 * GB, 30 * GB, 9 * GB, 48 * GB, 'memory'), 'Waiting for memory room: needs ~12 GB, 9.0 GB left under the 48 GB limit');
});

test('averages cover only the window asked', () => {
  const a = new Averages();
  a.add('pc|cpu', 0, 100);
  a.add('pc|cpu', 20_000, 10);
  a.add('pc|cpu', 25_000, 30);
  assert.equal(a.get('pc|cpu', 25_000, 30), (100 + 10 + 30) / 3);
  assert.equal(a.get('pc|cpu', 25_000, 10), 20);
  assert.deepEqual(a.all('pc', 25_000, 10), { cpu: 20 });
});

// --- GPU readings -------------------------------------------------------------------------------------------------

const LUID = '0x00000000_0x000171FE';
const winBatch = (t: number, runFor: number, extra: string[] = []) => [
  `G A,${LUID},25310527488,0,NVIDIA GeForce RTX 4090`,
  'G A,0x00000000_0x00018204,0,2,Microsoft Basic Render Driver',
  `G E,pid_100_luid_${LUID.replace('_', '_')}_phys_0_eng_0_engtype_3D,${runFor}`,
  `G E,pid_200_luid_${LUID}_phys_0_eng_0_engtype_3D,${t}`,
  `G E,pid_200_luid_${LUID}_phys_0_eng_2_engtype_VideoDecode,${t * 3}`,
  'G E,pid_300_luid_0x00000000_0x00018204_phys_0_eng_0_engtype_3D,500000',
  `G M,pid_100_luid_${LUID}_phys_0,2147483648`,
  `G D,luid_${LUID}_phys_0,7340404736`,
  ...extra,
];

test('Windows GPU lines: adapters from DXGI without the software one, engines, per-process local memory, the adapter total', () => {
  const raw = parseWindowsGpu(winBatch(0, 0));
  assert.deepEqual(raw.adapters, [{ id: '0x00000000_0x000171fe', name: 'NVIDIA GeForce RTX 4090', vramTotal: 25310527488 }]);
  assert.equal(raw.engines.length, 4);
  assert.deepEqual(raw.processMem, [{ pid: 100, adapter: '0x00000000_0x000171fe', bytes: 2147483648 }]);
  assert.equal(raw.adapterMem['0x00000000_0x000171fe'], 7340404736);
  assert.equal(parseWindowsGpu(['G X,Windows GPU performance counters returned nothing']).problem, 'Windows GPU performance counters returned nothing');
});

test('GPU loads come from busy-time differences: the busiest engine for the GPU, a group summed per engine', () => {
  const t = new GpuTracker();
  t.update(parseWindowsGpu(winBatch(0, 0)), 0);
  // 5 s later: pid 100 ran its 3D engine 2 s (40%), pid 200 0.5 s (10%) and its video engine 1.5 s (30%).
  const r = t.update(parseWindowsGpu(winBatch(5_000_000, 20_000_000)), 5000);
  const id = '0x00000000_0x000171fe';
  assert.equal(r.adapters.length, 1, 'the software renderer is left out');
  assert.equal(Math.round(r.adapters[0]!.load), 50);
  assert.equal(r.adapters[0]!.vramUsed, 7340404736);
  assert.equal(Math.round(groupLoad(r, [100], id)), 40);
  assert.equal(Math.round(groupLoad(r, [200], id)), 30, 'its busiest engine');
  assert.equal(Math.round(groupLoad(r, [100, 200], id)), 50);
  assert.equal(groupMem(r, [100, 200], id), 2147483648);
  assert.equal(mainGpu(r), id);
  // A row missing from a batch had no time: a process that started since counts from 0.
  const r2 = t.update(parseWindowsGpu([...winBatch(5_000_000, 20_000_000), `G E,pid_400_luid_${LUID}_phys_0_eng_0_engtype_3D,10000000`]), 10_000);
  assert.equal(Math.round(groupLoad(r2, [400], id)), 20);
});

test('the Windows batch reader passes the GPU lines with their own time, apart from the process list', () => {
  const got: { list: ProcessList; at: number; gpuAt?: number; adapters?: number }[] = [];
  const onLine = windowsBatchReader((list, at, gpu) => got.push({ list, at, gpuAt: gpu?.at, adapters: gpu?.raw.adapters.length }));
  for (const l of ['#BEGIN 1000', '50,1,0,1000', 'G T,1100', `G A,${LUID},1,0,GPU`, '#END', '#BEGIN 2000', '51,1,0,1000', '#END']) onLine(l);
  assert.equal(got.length, 2);
  assert.equal(got[0]!.list.size, 1);
  assert.equal(got[0]!.gpuAt, 1100);
  assert.equal(got[0]!.adapters, 1);
  assert.equal(got[1]!.gpuAt, undefined, 'an older loop with no GPU lines');
});

test('Linux and macOS GPU output is read: nvidia-smi, pmon, DRM fdinfo, ioreg', () => {
  assert.deepEqual(parseNvidiaGpus('0, NVIDIA GeForce RTX 3080, 37, 2048, 10240\n'), [{ id: 'nvidia0', name: 'NVIDIA GeForce RTX 3080', load: 37, used: 2048 * 1024 ** 2, total: 10240 * 1024 ** 2 }]);
  const pmon = '# gpu         pid   type     sm    mem    enc    dec     fb   command\n# Idx           #    C/G      %      %      %      %     MB   name\n    0       4242     C     55     20      -      -   1500   python\n    0          -     -      -      -      -      -      -   -\n';
  assert.deepEqual(parseNvidiaPmon(pmon), [{ pid: 4242, adapter: 'nvidia0', percent: 55, bytes: 1500 * 1024 ** 2 }]);
  const fd = 'pos:\t0\nflags:\t02100002\ndrm-driver:\tamdgpu\ndrm-pdev:\t0000:03:00.0\ndrm-client-id:\t17\ndrm-engine-gfx:\t1500000000 ns\ndrm-engine-capacity-gfx:\t1\ndrm-memory-vram:\t524288 KiB\n';
  assert.deepEqual(parseDrmFdinfo(fd), { pdev: '0000:03:00.0', client: '17', engines: { gfx: 1.5 }, vram: 512 * 1024 ** 2 });
  assert.equal(parseDrmFdinfo('pos:\t0\nflags:\t0\n'), null);
  const ioreg = '+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X>\n    {\n      "model" = "Apple M2"\n      "PerformanceStatistics" = {"Device Utilization %"=23,"Renderer Utilization %"=20}\n    }\n';
  assert.deepEqual(parseIoreg(ioreg), [{ name: 'Apple M2', load: 23 }]);
});

// --- The book ------------------------------------------------------------------------------------------------------

interface Rig {
  book: ResourceBook;
  told: { id: string; text: string }[];
  woken: string[];
  priorities: Map<number, number>;
  clock: { now: number };
  jobs: JobStore;
  sessions: Map<string, BookSession>;
  /** `outside`: processes in the PC's list but in no session's tree (other programs, orphans, WSL). */
  tick(trees: Record<string, ProcInfo[]>, opts?: { cpuOf?: Record<number, number>; memUsed?: number; cores?: number; gpu?: GpuReading; outside?: ProcInfo[] }): void;
  resumed: number[];
  meta: Map<string, string>;
  /** Sessions whose resource notice waits to be delivered (round 2: the go's clock starts at delivery). */
  undelivered: Set<string>;
  /** What managers were told. */
  managers: { id: string; text: string }[];
}

function rig(opts: { unix?: boolean } = {}): Rig {
  const store = new Store(openDatabase(':memory:'));
  const jobs = new JobStore(store.database);
  const meta = new Map<string, string>();
  const told: { id: string; text: string }[] = [];
  const woken: string[] = [];
  const priorities = new Map<number, number>();
  // A fake OS: like macOS and Linux with `unix`, a priority can be lowered but not raised again.
  const control: PriorityControl = {
    get: (pid) => priorities.get(pid) ?? 0,
    set: (pid, p) => {
      if (opts.unix && p < (priorities.get(pid) ?? 0)) return false;
      priorities.set(pid, p);
      return true;
    },
  };
  const clock = { now: 1_000_000 };
  const resumed: number[] = [];
  const undelivered = new Set<string>();
  const managers: { id: string; text: string }[] = [];
  const sessions = new Map<string, BookSession>([
    ['s1', { id: 's1', title: 'One', project: 'p', role: 'session', priority: 'normal', local: true, busy: false }],
    ['s2', { id: 's2', title: 'Two', project: 'p', role: 'session', priority: 'normal', local: true, busy: false }],
    ['box', { id: 'box', title: 'In a container', project: 'c', role: 'session', priority: 'normal', local: false, busy: false }],
  ]);
  const book = new ResourceBook({
    meta: { get: (k) => meta.get(k) ?? null, set: (k, v) => void meta.set(k, v) },
    jobs,
    session: (id) => sessions.get(id) ?? null,
    tell: (id, text) => void told.push({ id, text }),
    wake: (id) => void woken.push(id),
    changed: () => {},
    resume: (targets) => void resumed.push(...targets.map((t) => t.pid)),
    undelivered: (id) => undelivered.has(id),
    tellManager: (id, text) => void managers.push({ id, text }),
    control,
    now: () => clock.now,
  });
  let prev: ProcessList | null = null;
  const cpuTotal = new Map<number, number>();
  const tick: Rig['tick'] = (trees, o = {}) => {
    clock.now += 5000;
    const list: ProcessList = new Map();
    const treeMap = new Map<string, ProcInfo[]>();
    const hosts = new Map<string, number>();
    for (const [sid, procs] of Object.entries(trees)) {
      const withCpu = procs.map((p) => {
        const add = (o.cpuOf?.[p.pid] ?? 0) * 5; // cores × 5 s
        cpuTotal.set(p.pid, (cpuTotal.get(p.pid) ?? 0) + add);
        return { ...p, cpuSeconds: cpuTotal.get(p.pid)! };
      });
      for (const p of withCpu) list.set(p.pid, p);
      treeMap.set(sid, withCpu);
      hosts.set(sid, withCpu[0]!.pid);
    }
    for (const p of o.outside ?? []) list.set(p.pid, p);
    const sample: BookSample = { at: clock.now, threads: 16, cores: o.cores ?? 1, memUsed: o.memUsed ?? 10 * GB, memTotal: 64 * GB, list, prev, dt: 5, trees: treeMap, hosts, gpu: o.gpu ?? null };
    book.sample(sample);
    prev = list;
  };
  return { book, told, woken, priorities, clock, jobs, sessions, tick, meta, resumed, undelivered, managers };
}

const proc = (pid: number, ppid: number, mem = 100 * 1024 ** 2): ProcInfo => ({ pid, ppid, cpuSeconds: 0, memBytes: mem, started: pid * 10 });
/** A session's tree: its host (10), Claude Code (11), and what it started. */
const tree = (...work: ProcInfo[]) => [proc(10, 1), proc(11, 10, 300 * 1024 ** 2), ...work];
const tree2 = (...work: ProcInfo[]) => [proc(20, 1), proc(21, 20, 300 * 1024 ** 2), ...work];
/** A process a call started just now, as Windows gives its start time. */
const started = (r: Rig, pid: number, ppid: number, mem = 100 * 1024 ** 2): ProcInfo => ({ ...proc(pid, ppid, mem), started: r.clock.now + 40 });
const rows = (r: Rig) => (r.jobs as unknown as { db: { prepare(q: string): { all(): { commands: string; undeclared: number }[] } } }).db
  .prepare('SELECT commands, undeclared FROM job_runs ORDER BY id').all().map((x) => ({ commands: JSON.parse(x.commands) as string[], unreserved: x.undeclared === 1 }));

test('reserve: go at once when it fits; wait with a reason when not; a raised limit lets it go at once and the session is told', () => {
  const r = rig();
  r.tick({ s1: tree(), s2: tree2() }, { cores: 3.2 }); // 20% of 16 threads
  r.book.setLimit('cpu', 50);
  const go = r.book.reserve('s1', { what: 'Build', cpu: 25 });
  assert.match(go, /^Go: reservation r1 "Build", 25% CPU/);
  const wait = r.book.reserve('s2', { what: 'Train', cpu: 40 });
  assert.match(wait, /^Wait: Waiting for CPU room: needs ~40%, 5% left under the 50% limit; held by 1 other job \(25% booked, 0% used\), other programs 20% \(1st in line\)/);
  assert.match(wait, /Don't start it yet/);
  const line = r.book.info().line;
  assert.equal(line.length, 1);
  assert.equal(line[0]!.sessionId, 's2');
  r.book.setLimit('cpu', 90);
  assert.equal(r.book.info().line.length, 0);
  assert.match(r.told.at(-1)!.text, /^You may go: reservation r2 "Train" \(40% CPU\)/);
  assert.equal(r.told.at(-1)!.id, 's2');
});

test('reserve refuses container sessions, empty requests and nonsense; it reserves only for the calling session', () => {
  const r = rig();
  assert.throws(() => r.book.reserve('box', { what: 'x', cpu: 10 }), /container projects/);
  assert.throws(() => r.book.reserve('s1', { what: '  ', cpu: 10 }), /what/);
  assert.throws(() => r.book.reserve('s1', { what: 'x' }), /Nothing to reserve/);
  assert.throws(() => r.book.reserve('s1', { what: 'x', cpu: 150 }), /at most 100/);
  assert.throws(() => r.book.reserve('s1', { what: 'x', cpu: -1 }), /0 or more/);
  assert.throws(() => r.book.reserve('nobody', { what: 'x', cpu: 1 }), /No such session/);
  assert.equal(r.book.release('s2'), 'You have no reservation.');
  // GPU asked on a PC without GPU readings: only CPU and memory are reserved, and it says why.
  assert.match(r.book.reserve('s1', { what: 'x', cpu: 5, gpu: 50 }), /GPU limits are off/);
});

test('a job is the processes started after the go; released when they end, and recorded for learning', () => {
  const r = rig();
  r.tick({ s1: tree(proc(12, 11)) }); // an MCP server that was there before
  r.book.reserve('s1', { what: 'Build', cpu: 30, ram_gb: 2 });
  r.tick({ s1: tree(proc(12, 11), proc(13, 11), proc(14, 13, GB)) }, { cpuOf: { 14: 4 } });
  r.tick({ s1: tree(proc(12, 11), proc(13, 11), proc(14, 13, GB)) }, { cpuOf: { 14: 4 } });
  const job = r.book.info().jobs[0]!;
  assert.equal(job.processes, 2, 'not the MCP server that was there before');
  assert.equal(Math.round(job.using.cpu!), 25);
  r.tick({ s1: tree(proc(12, 11)) });
  assert.equal(r.book.info().jobs.length, 0);
  const kinds = r.jobs.kinds();
  assert.equal(kinds.length, 1);
  assert.equal(kinds[0]!.kind, 'build');
});

test("a pass ends when the session's work is over: no turn, nothing in the background, no process of it running", () => {
  const r = rig();
  const s1 = r.sessions.get('s1')!;
  const s2 = r.sessions.get('s2')!;
  s1.busy = true;
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Bg', cpu: 10 });
  r.tick({ s1: tree(proc(15, 11)) });
  s1.busy = false;
  r.tick({ s1: tree(proc(15, 11)) });
  assert.equal(r.book.info().jobs.length, 1, 'kept while its process runs');
  r.tick({ s1: tree() });
  assert.equal(r.book.info().jobs.length, 0, 'ended with its process, the turn over');
  s2.busy = true;
  r.tick({ s2: tree2() });
  r.book.reserve('s2', { what: 'Nothing', cpu: 10 });
  r.tick({ s2: tree2() });
  assert.equal(r.book.info().jobs.length, 1, 'kept while the turn that reserved goes on');
  s2.busy = false;
  r.tick({ s2: tree2() });
  assert.equal(r.book.info().jobs.length, 0, 'released: nothing ran');
});

test('a go not used within 10 minutes of reaching the session parks the pass, and the session is told', () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Later', cpu: 10 });
  assert.equal(r.book.info().reserved.cpu, 10);
  r.clock.now += LAPSE_MS;
  r.tick({ s1: tree() });
  assert.equal(r.book.info().jobs[0]!.state, 'parked');
  assert.equal(r.book.info().reserved.cpu ?? 0, 0, 'parked: holds no room');
  assert.match(r.told.at(-1)!.text, /parked: no work started within 10 minutes/);
  r.sessions.get('s1')!.busy = false;
  r.tick({ s1: tree() });
  assert.equal(r.book.info().jobs.length, 0, 'the turn ended with nothing running: the pass ends');
});

test('a job over its share: priority lowered, session held and told; when back, priority restored and hold lifted; nothing killed', () => {
  const r = rig();
  r.book.setSettings({ overSec: 10, averageSec: 5 });
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Crunch', cpu: 10 });
  const busy = { cpuOf: { 13: 8 } }; // 8 cores = 50% of 16 threads, reserved 10%
  r.tick({ s1: tree(proc(13, 11)) }, busy);
  assert.equal(r.book.isHeld('s1'), false, 'not before the time is up');
  r.tick({ s1: tree(proc(13, 11)) }, busy);
  r.tick({ s1: tree(proc(13, 11)) }, busy);
  assert.equal(r.book.isHeld('s1'), true);
  assert.equal(r.priorities.get(13), LOWERED);
  assert.equal(r.priorities.get(11), undefined, 'Claude Code itself is never lowered');
  assert.match(r.told.at(-1)!.text, /over its share/);
  assert.match(r.told.at(-1)!.text, /Nothing is killed/);
  assert.equal(r.book.info().jobs[0]!.state, 'over');
  // Held: no new reservation is granted, and a known heavy command is refused.
  assert.match(r.book.reserve('s1', { what: 'More', cpu: 1 }), /^Wait: Held/);
  // A process it starts while over is lowered too.
  r.tick({ s1: tree(proc(13, 11), proc(16, 13)) }, busy);
  assert.equal(r.priorities.get(16), LOWERED);
  r.tick({ s1: tree(proc(13, 11), proc(16, 13)) }, { cpuOf: { 13: 1 } });
  r.tick({ s1: tree(proc(13, 11), proc(16, 13)) }, { cpuOf: { 13: 1 } });
  r.tick({ s1: tree(proc(13, 11), proc(16, 13)) }, { cpuOf: { 13: 1 } });
  assert.equal(r.book.isHeld('s1'), false);
  assert.equal(r.priorities.get(13), 0, 'restored');
  assert.equal(r.priorities.get(16), 0);
  assert.ok(r.woken.includes('s1'));
  assert.ok(r.told.some((t) => /back within its share/.test(t.text)));
  // The addition that waited while held goes once the hold is lifted.
  assert.match(r.told.at(-1)!.text, /^You may go: reservation r1 "Crunch" \(11% CPU\)/);
});

test('on macOS and Linux a lowered priority that cannot be raised again is shown as staying lowered', () => {
  const r = rig({ unix: true });
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Crunch', cpu: 10 });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(proc(13, 11)) }, { cpuOf: { 13: 8 } });
  assert.equal(r.priorities.get(13), LOWERED);
  r.tick({ s1: tree(proc(13, 11)) }, { cpuOf: { 13: 0.5 } });
  r.tick({ s1: tree(proc(13, 11)) }, { cpuOf: { 13: 0.5 } });
  assert.equal(r.book.info().jobs[0]!.loweredStays, true);
});

test('heavy work without a reservation is held and told to reserve next time; its commands then need a reservation', () => {
  const r = rig();
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  for (let round = 0; round < 2; round++) {
    r.tick({ s1: tree() });
    r.book.callStarted('s1', `train${round}`, ['python train.py'], false);
    const train = started(r, 30 + round, 11);
    for (let i = 0; i < 3; i++) r.tick({ s1: tree(train) }, { cpuOf: { [30 + round]: 6 } });
    r.book.callEnded('s1', `train${round}`);
    assert.equal(r.book.isHeld('s1'), true);
    assert.match(r.told.at(-1)!.text, /without a reservation/);
    assert.match(r.told.at(-1)!.text, /call reserve before heavy work next time/);
    r.tick({ s1: tree() });
    r.tick({ s1: tree() });
    assert.equal(r.book.isHeld('s1'), false);
  }
  const why = r.book.commandRefusal('s1', ['python train.py']);
  assert.match(why ?? '', /call reserve first/);
  // It says where the figure comes from, with no job's name (R4).
  assert.match(why ?? '', /learned this from 2 stretches of unreserved heavy work it ran in, the last on \d{4}-\d\d-\d\d; its calls usually take 15 s/);
  assert.match(why ?? '', /mark "python train\.py" as never needing a reservation/);
  assert.equal(r.book.commandRefusal('s1', ['git status']), null);
  // With a reservation going, it runs.
  r.book.reserve('s1', { what: 'Train', cpu: 40 });
  assert.equal(r.book.commandRefusal('s1', ['python train.py']), null);
  // The person can say it never needs one.
  r.book.release('s1');
  r.jobs.markNever('p', 'python train.py', true);
  assert.equal(r.book.commandRefusal('s1', ['python train.py']), null);
});

// --- Light commands (docs/steps/resource-limits-2.md, R4) ------------------------------------------------------------

test('light commands are never refused, even with old "heavy" marks and a pass waiting; nor is a script never seen to take long', () => {
  const r = rig();
  r.tick({ s1: tree(), s2: tree2() }, { cores: 3.2 });
  // Marks learned the old way (before the migration that adds by_call): every command of a heavy job got its peak.
  const old = ['git status', 'gh issue', 'git worktree list', 'cut', 'check.sh', 'npm run build', 'for', 'const'];
  const db = (r.jobs as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db;
  for (const at of [1, 2]) db.prepare("INSERT INTO job_runs (project, kind, commands, asked, peak, mean, duration_ms, over, undeclared, ended_at, by_call) VALUES ('p', 'nightly build', ?, '{}', ?, '{}', 1, 0, 0, ?, 0)").run(JSON.stringify(old), JSON.stringify({ ram: 6 * GB }), at);
  // A pass waits.
  r.book.setLimit('cpu', 50);
  assert.match(r.book.reserve('s1', { what: 'Big', cpu: 45 }), /^Wait:/);
  for (const command of ['git status', 'gh issue view 12 --json title', 'git -C ../other status --short', 'git worktree list', 'cut -d: -f1 x | sort', 'for f in a b; do echo $f; done']) {
    assert.deepEqual(heavyKinds(command), [], command);
    assert.equal(r.book.commandRefusal('s1', heavyKinds(command)), null, command);
  }
  // An old mark alone refuses nothing (acceptance test round 1): a 3-second script runs at once, and nothing is listed.
  assert.equal(r.book.commandRefusal('s1', heavyKinds('./check.sh --quick')), null);
  assert.equal(r.book.commandRefusal('s1', ['npm run build']), null);
  assert.deepEqual(r.jobs.heavyCommands('p'), []);
  for (let i = 0; i < 3; i++) {
    r.book.callStarted('s2', `c${i}`, ['check.sh'], false);
    r.clock.now += 3000;
    r.book.callEnded('s2', `c${i}`);
  }
  assert.equal(r.jobs.usualMs('p', 'check.sh'), 3000);
  assert.equal(r.book.commandRefusal('s1', ['check.sh']), null);
  // Once a kind is seen to take long, its old marks count again; the refusal says where the figure comes from.
  r.book.callStarted('s2', 'b', ['npm run build'], false);
  r.clock.now += 60_000;
  r.book.callEnded('s2', 'b');
  // s1's pass waits, so it is told to wait (round 2); s2 has none, so it is told to reserve.
  assert.match(r.book.commandRefusal('s1', ['npm run build']) ?? '', /^Wait: your reservation r1 "Big" is waiting for room/);
  const why = r.book.commandRefusal('s2', ['npm run build']);
  assert.match(why ?? '', /"npm run build" usually uses ~6\.0 GB memory: call reserve first/);
  assert.match(why ?? '', /learned this from 2 reserved jobs it ran in, the last on 1970-01-01; its calls usually take 60 s\. If that is wrong/);
  assert.doesNotMatch(why ?? '', /nightly build/, "no job's name reaches a session");
  assert.deepEqual(r.jobs.heavyCommands('p').map((h) => h.command), ['npm run build']);
  // Only the latest ten calls count.
  for (let i = 0; i < 12; i++) r.jobs.addCall('p', 'npm run build', i < 2 ? 1000 : 60_000, 10 + i);
  assert.equal(r.jobs.usualMs('p', 'npm run build'), 60_000);
  assert.equal((r.jobs as unknown as { db: { prepare(q: string): { get(): { n: number } } } }).db.prepare("SELECT COUNT(*) AS n FROM command_calls WHERE kind = 'npm run build'").get().n, 10);
  // Records learned the new way count without durations.
  for (const at of [3, 4]) r.jobs.add({ project: 'p', kind: 'train', commands: ['python train.py'], asked: {}, peak: { ram: 4 * GB }, mean: {}, durationMs: 1, over: false, undeclared: false, endedAt: at });
  assert.match(r.book.commandRefusal('s2', ['python train.py']) ?? '', /call reserve first/);
});

test('quick calls never cancel what a command was measured to use; a call that detaches keeps no duration', () => {
  const r = rig();
  r.tick({ s1: tree(), s2: tree2() });
  // Learned the new way: a call's own processes were busy in two runs.
  for (const at of [1, 2]) r.jobs.add({ project: 'p', kind: 'train', commands: ['python train.py'], asked: {}, peak: { ram: 4 * GB }, mean: {}, durationMs: 1, over: false, undeclared: true, endedAt: at });
  assert.match(r.book.commandRefusal('s1', ['python train.py']) ?? '', /call reserve first/);
  // One quick call (code review of PR #400, round 2): it is still refused.
  r.book.callStarted('s2', 'q', ['python train.py'], false);
  r.clock.now += 200;
  r.book.callEnded('s2', 'q');
  assert.equal(r.jobs.usualMs('p', 'python train.py'), 200);
  assert.match(r.book.commandRefusal('s1', ['python train.py']) ?? '', /call reserve first/);
  // Nor do ten of them.
  for (let i = 0; i < 10; i++) r.jobs.addCall('p', 'python train.py', 200, 10 + i);
  assert.deepEqual(r.jobs.heavyCommands('p').map((h) => h.command), ['python train.py']);
  // A call that detaches is followed like a background one, so its quick return is never kept.
  for (const command of ['python train.py &', 'nohup python train.py > log 2>&1 &', 'setsid python train.py', 'python train.py & disown', 'start /b python train.py', 'cmd /c start python train.py', 'Start-Process python train.py', 'python a.py & python b.py']) {
    assert.equal(detaches(command), true, command);
  }
  for (const command of ['python train.py', 'npm start', 'make && make test', 'npm run build 2>&1 | tee log', 'npm test &> out', '& "C:/x/train.exe" --fast', 'cd a; & ./run.ps1']) {
    assert.equal(detaches(command), false, command);
  }
  r.book.callStarted('s2', 'd', ['make'], detaches('make &'));
  r.clock.now += 100;
  r.book.callEnded('s2', 'd');
  assert.equal(r.jobs.usualMs('p', 'make'), null);
});

test('git, file-reading words and shell syntax are light; real work is not', () => {
  assert.deepEqual(heavyKinds('git status && npm run build'), ['npm run build']);
  assert.deepEqual(heavyKinds('git stash'), ['git stash']);
  assert.deepEqual(heavyKinds('git stash list'), []);
  assert.deepEqual(heavyKinds('git -C repo commit -m x'), ['git commit']);
  assert.deepEqual(heavyKinds('gh pr checks 12 --watch'), []);
  assert.deepEqual(heavyKinds('tr a b < f | jq .x | tee out'), []);
  assert.deepEqual(heavyKinds('for f in *.ts; do npm test; done'), ['npm test']);
  assert.deepEqual(heavyKinds('while true; do sleep 1; done'), []);
  assert.deepEqual(heavyKinds('if make; then echo ok; fi'), ['make']);
  assert.deepEqual(heavyKinds('const a = 1;\nlet b = 2;'), []);
});

test('a job learns only the calls whose own processes are busy: not a short script after the build, nor a loop beside it', () => {
  const r = rig();
  r.tick({ s1: tree() });
  // A status loop in the background, begun before the reservation; it starts a small poll every round.
  r.book.callStarted('s1', 'loop', ['loop.sh'], true);
  const loop = started(r, 50, 11, 5 * 1024 ** 2);
  r.tick({ s1: tree(loop) });
  let pid = 100;
  const poll = () => started(r, pid++, 50, 40 * 1024 ** 2);
  for (let round = 0; round < 2; round++) {
    r.book.reserve('s1', { what: 'Build', ram_gb: 6 });
    // A 6-second script before the build, caught by a sample inside the job.
    r.book.callStarted('s1', `pre${round}`, ['check.sh'], false);
    const pre = started(r, 80 + round, 11, 5 * 1024 ** 2);
    r.tick({ s1: tree(loop, poll(), pre, { ...pre, pid: pre.pid + 200, ppid: pre.pid }) });
    r.book.callEnded('s1', `pre${round}`);
    r.book.callStarted('s1', `build${round}`, ['npm run build'], false);
    const build = started(r, 60 + round, 11, 6 * GB);
    for (let i = 0; i < 3; i++) r.tick({ s1: tree(loop, poll(), build) }, { cpuOf: { [build.pid]: 1 } });
    r.book.callEnded('s1', `build${round}`);
    // The same script after the build, still in the job.
    r.book.callStarted('s1', `post${round}`, ['check.sh'], false);
    const post = started(r, 90 + round, 11, 5 * 1024 ** 2);
    r.tick({ s1: tree(loop, poll(), post) });
    r.book.callEnded('s1', `post${round}`);
    r.tick({ s1: tree(loop) });
    r.tick({ s1: tree(loop) });
    assert.equal(r.book.info().jobs.length, 0, 'the job ended with its processes');
  }
  assert.deepEqual(rows(r).map((x) => x.commands), [['npm run build'], ['npm run build']]);
  assert.deepEqual(r.jobs.heavyCommands('p').map((h) => h.command), ['npm run build']);
  // A background build begun after the go is the job's, though it is never seen to end.
  r.book.reserve('s1', { what: 'Build', ram_gb: 6 });
  r.book.callStarted('s1', 'bg', ['python train.py'], true);
  const bg = started(r, 70, 11, 6 * GB);
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(loop, bg) });
  r.tick({ s1: tree(loop) });
  assert.deepEqual(rows(r).at(-1)!.commands, ['python train.py']);
});

test('heavy work without a reservation learns only its own call: not a loop begun 10 s before it, nor a script after it', () => {
  const r = rig();
  r.book.setSettings({ overSec: 5, averageSec: 15 });
  r.tick({ s1: tree() });
  r.book.callStarted('s1', 'loop', ['loop.sh'], true);
  const loop = started(r, 50, 11, 5 * 1024 ** 2);
  r.tick({ s1: tree(loop) });
  r.tick({ s1: tree(loop, started(r, 51, 50, 40 * 1024 ** 2)) });
  r.book.callStarted('s1', 'build', ['node build.mjs'], false);
  const build = started(r, 60, 11, 4 * GB);
  for (let i = 0; i < 4; i++) r.tick({ s1: tree(loop, build) }, { cpuOf: { 60: 1 } });
  assert.equal(r.book.isHeld('s1'), true);
  r.book.callEnded('s1', 'build');
  // The average lags: the stretch lasts while a short script runs after the build.
  r.book.callStarted('s1', 'post', ['check.sh'], false);
  const post = started(r, 70, 11, 5 * 1024 ** 2);
  r.tick({ s1: tree(loop, post) });
  r.book.callEnded('s1', 'post');
  for (let i = 0; i < 6; i++) r.tick({ s1: tree(loop) });
  assert.equal(r.book.isHeld('s1'), false);
  assert.deepEqual(rows(r), [{ commands: ['node build.mjs'], unreserved: true }]);
});

test('on macOS and Linux (no start times) a process belongs to the call begun last before the sample it was first seen in', () => {
  const r = rig();
  const bare = (pid: number, ppid: number, mem: number): ProcInfo => ({ pid, ppid, cpuSeconds: 0, memBytes: mem });
  r.tick({ s1: tree() });
  r.book.callStarted('s1', 'loop', ['loop.sh'], true);
  r.tick({ s1: tree(bare(50, 11, 5 * 1024 ** 2)) });
  r.book.reserve('s1', { what: 'Build', ram_gb: 6 });
  r.book.callStarted('s1', 'build', ['make'], false);
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(bare(50, 11, 5 * 1024 ** 2), bare(60, 11, 6 * GB)) });
  r.book.callEnded('s1', 'build');
  r.tick({ s1: tree(bare(50, 11, 5 * 1024 ** 2)) });
  assert.deepEqual(rows(r).map((x) => x.commands), [['make']]);
});

test('after three runs the learned figure replaces the guess, and the answer says so', () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.jobs.add({ project: 'p', kind: 'render tiles', commands: [], asked: { cpu: 10 }, peak: { cpu: 30 + i }, mean: { cpu: 20 }, durationMs: 1000, over: false, undeclared: false, endedAt: i });
  r.tick({ s1: tree() });
  const answer = r.book.reserve('s1', { what: 'Render  Tiles', cpu: 10 });
  // The 90th percentile of 30, 31, 32 is 32, plus the 10-point margin.
  assert.match(answer, /42% CPU \(learned from 3 runs; you asked 10% CPU\)/);
});

test('under a memory limit a new session waits for room and starts when there is; Start now and stopping take it out', () => {
  const r = rig();
  r.tick({ s1: tree() }, { memUsed: 47.5 * GB });
  r.book.setLimit('ram', 48);
  r.sessions.set('new', { id: 'new', title: 'New', project: 'p', role: 'session', priority: 'normal', local: true, busy: false });
  let started = 0;
  assert.equal(r.book.admitSession('new', () => void started++), false);
  assert.equal(started, 0);
  assert.match(r.book.info().line[0]!.reason, /Waiting for memory room: needs ~1\.0 GB/);
  for (let i = 0; i < 7; i++) r.tick({ s1: tree() }, { memUsed: 40 * GB });
  assert.equal(started, 1);
  // A manager never waits; nor does anything with no memory limit.
  r.sessions.set('mgr', { id: 'mgr', title: 'M', project: 'p', role: 'manager', priority: 'normal', local: true, busy: false });
  assert.equal(r.book.admitSession('mgr', () => void started++), true);
  r.book.setLimit('ram', 1);
  r.sessions.set('n2', { id: 'n2', title: 'N2', project: 'p', role: 'session', priority: 'normal', local: true, busy: false });
  assert.equal(r.book.admitSession('n2', () => void started++), false);
  r.book.startNow('n2');
  assert.equal(started, 3);
  r.sessions.set('n3', { id: 'n3', title: 'N3', project: 'p', role: 'session', priority: 'normal', local: true, busy: false });
  r.book.admitSession('n3', () => void started++);
  assert.equal(r.book.dropWaiter('n3'), true);
  assert.equal(r.book.info().line.length, 0);
});

test('limits and reservations survive a restart of Ledung; bad limits are refused', () => {
  const r = rig();
  r.tick({ s1: tree() });
  r.book.setLimit('cpu', 60);
  r.book.reserve('s1', { what: 'Build', cpu: 20 });
  const again = new ResourceBook({
    meta: { get: (k) => r.meta.get(k) ?? null, set: () => {} }, jobs: r.jobs, session: (id) => r.sessions.get(id) ?? null,
    tell: () => {}, wake: () => {}, changed: () => {},
  });
  assert.deepEqual(again.info().limits, { cpu: 60 });
  assert.equal(again.info().jobs.length, 1);
  assert.throws(() => r.book.setLimit('cpu', 0), /1 to 100/);
  assert.throws(() => r.book.setLimit('ram', -2), /above 0/);
  assert.throws(() => r.book.setLimit('disk', 5), /Unknown resource/);
  assert.throws(() => r.book.setSettings({ averageSec: 1 }), /averageSec/);
});

test('notices go to the session in the inbox source a held session still gets', () => {
  assert.equal(RESOURCE_SOURCE, 'ledung:resources');
});

// --- Learning store and the page's helpers ------------------------------------------------------------------------

test('learned figures are kept without the GPU id, so they outlive a reboot that renames the GPU', () => {
  assert.deepEqual(toGeneric({ cpu: 10, 'gpu:a': 40, 'vram:a': 2 * GB, 'gpu:b': 5 }, 'a'), { cpu: 10, gpu: 40, vram: 2 * GB });
  assert.deepEqual(fromGeneric({ gpu: 40, vram: 2 * GB, ram: GB }, 'c'), { 'gpu:c': 40, 'vram:c': 2 * GB, ram: GB });
  assert.deepEqual(fromGeneric({ gpu: 40 }, null), {});
});

test('the page puts the limit line where it belongs and reads what is typed', () => {
  assert.equal(limitShare(50, 'cpu', 100), 0.5);
  assert.equal(limitShare(16 * GB, 'ram', 64 * GB), 0.25);
  assert.equal(limitShare(undefined, 'ram', 64 * GB), null);
  assert.equal(limitText('ram', 48 * GB), '48');
  assert.equal(limitText('gpu:a', 50), '50');
  assert.equal(parseLimitInput('cpu', '55'), 55);
  assert.equal(parseLimitInput('cpu', '0'), undefined);
  assert.equal(parseLimitInput('cpu', '101'), undefined);
  assert.equal(parseLimitInput('ram', '12.5'), 12.5);
  assert.equal(parseLimitInput('ram', ''), undefined);
});

test('dragging a limit line snaps to 5 % or 1 GB, and the far end is no limit (issue #295)', () => {
  assert.equal(dragStep('cpu'), 5);
  assert.equal(dragStep('vram:a'), 1);
  assert.equal(dragValue('gpu:a', 0.52, 100), 50);
  assert.equal(dragValue('cpu', 0.533, 100), 55);
  assert.equal(dragValue('ram', 48.4 / 64, 64 * GB), 48);
  // Never below one step, and dragged off the right end the limit goes.
  assert.equal(dragValue('cpu', 0, 100), 5);
  assert.equal(dragValue('ram', -0.2, 64 * GB), 1);
  assert.equal(dragValue('cpu', 0.99, 100), null);
  assert.equal(dragValue('cpu', 1.3, 100), null);
  assert.equal(dragValue('ram', 63.6 / 64, 64 * GB), null);
  // A total that isn't whole GB: the far end is its whole GB.
  assert.equal(dragMax('ram', 63.9 * GB), 63);
  assert.equal(dragValue('ram', 1, 63.9 * GB), null);
  assert.equal(limitUnits('ram', 12 * GB), 12);
  assert.equal(limitUnits('cpu', undefined), null);
  assert.equal(valueShare('ram', 16, 64 * GB), 0.25);
  assert.equal(valueShare('cpu', null, 100), 1);
  assert.equal(dragText('gpu:a', 50), '50%');
  assert.equal(dragText('ram', 48), '48 GB');
  assert.equal(dragText('ram', null), 'No limit');
});

test('arrow keys move a limit one step onto the grid, and off the end to no limit (issue #295)', () => {
  assert.equal(stepDrag('cpu', 50, 1, 100), 55);
  assert.equal(stepDrag('cpu', 52, -1, 100), 50);
  assert.equal(stepDrag('cpu', 52, 1, 100), 55);
  assert.equal(stepDrag('cpu', 5, -1, 100), 5);
  assert.equal(stepDrag('cpu', 95, 1, 100), null);
  assert.equal(stepDrag('cpu', null, -1, 100), 95);
  assert.equal(stepDrag('cpu', null, 1, 100), null);
  assert.equal(stepDrag('ram', 12.5, 1, 64 * GB), 13);
  assert.equal(stepDrag('ram', 12.5, -1, 64 * GB), 12);
  assert.equal(stepDrag('ram', null, -1, 64 * GB), 63);
});

// --- Findings of the security reviews -----------------------------------------------------------------------------

test("sessions and managers never see another session's job name or title in a reason; Ledung's own kinds can't be named", () => {
  const r = rig();
  r.tick({ s1: tree(), s2: tree2() }, { cores: 3.2 });
  r.book.setLimit('cpu', 50);
  r.book.reserve('s1', { what: 'Secret plan', cpu: 40 });
  const answer = r.book.reserve('s2', { what: 'Mine', cpu: 1 });
  assert.match(answer, /Waiting behind another job/);
  assert.doesNotMatch(answer, /Secret plan/);
  const line = r.book.info().line.find((l) => l.sessionId === 's2')!;
  assert.match(line.reason, /Secret plan/, 'the page may name it');
  assert.doesNotMatch(line.reasonForSessions, /Secret plan/);
  assert.throws(() => r.book.reserve('s1', { what: 'session:session', ram_gb: 30 }), /plain name/);
  assert.throws(() => r.book.reserve('s1', { what: '(unreserved)', cpu: 5 }), /plain name/);
  assert.throws(() => r.book.reserve('s1', { what: 'x', ram_gb: 1e300 }), /more than this PC/);
});

test('managers are never told to reserve, nor held for their own work: they have no reserve tool', () => {
  const r = rig();
  r.sessions.set('mgr', { id: 'mgr', title: 'M', project: 'p', role: 'manager', priority: 'normal', local: true, busy: false });
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  for (let i = 0; i < 3; i++) r.tick({ mgr: tree(proc(40, 11)) }, { cpuOf: { 40: 10 } });
  assert.equal(r.book.isHeld('mgr'), false);
  for (const at of [1, 2]) r.jobs.add({ project: 'p', kind: 'x', commands: ['npm run check'], asked: {}, peak: { cpu: 60 }, mean: {}, durationMs: 1, over: false, undeclared: false, endedAt: at });
  assert.equal(r.book.commandRefusal('mgr', ['npm run check']), null);
  assert.match(r.book.commandRefusal('s1', ['npm run check']) ?? '', /reserve first/);
});

test("a session's own MCP servers within its footprint are not heavy work; a heavy process started before a small reservation still is", () => {
  const r = rig();
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  // Claude Code (300 MB) and two MCP servers (300 MB each): under the 1 GB first guess plus the allowance and margin.
  const mcp = [proc(12, 11, 300 * 1024 ** 2), proc(13, 11, 300 * 1024 ** 2)];
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(...mcp) });
  assert.equal(r.book.isHeld('s1'), false);
  // Heavy work started first, then a tiny reservation: the heavy process is in the baseline, so it is judged as unreserved.
  r.tick({ s1: tree(...mcp, proc(50, 11)) }, { cpuOf: { 50: 8 } });
  r.book.reserve('s1', { what: 'Tiny', cpu: 1 });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(...mcp, proc(50, 11)) }, { cpuOf: { 50: 8 } });
  assert.equal(r.book.isHeld('s1'), true);
  assert.equal(r.priorities.get(50), LOWERED);
  assert.match(r.told.at(-1)!.text, /without a reservation/);
});

test('a lowered pid that ended and was reused by another program is never "restored"', () => {
  const r = rig();
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Crunch', cpu: 10 });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(proc(13, 11)) }, { cpuOf: { 13: 8 } });
  assert.equal(r.priorities.get(13), LOWERED);
  // Pid 13 now belongs to another program (another start time), at that priority by its own choice.
  r.tick({ s1: tree({ ...proc(13, 11), started: 999_999 }) });
  r.book.release('s1');
  assert.equal(r.priorities.get(13), LOWERED, 'left alone');
});

test('a job the person paused is resumed when it ends, never left frozen', () => {
  const r = rig();
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Job', cpu: 10 });
  r.tick({ s1: tree(proc(13, 11)) });
  r.book.setJobPaused('r1', true);
  r.book.release('s1');
  assert.deepEqual(r.resumed, [13]);
});

test("a GPU limit is kept by the GPU's name, so it holds after a reboot gives the GPU a new id", () => {
  const r = rig();
  const reading = (id: string): GpuReading => ({ at: 0, adapters: [{ id, name: 'Test GPU', vramTotal: 8 * GB, load: 10, vramUsed: GB }], perPid: new Map() });
  r.tick({ s1: tree() }, { gpu: reading('old') });
  r.book.setLimit('gpu:old', 50);
  assert.deepEqual(r.book.info().limits, { 'gpu:old': 50 });
  r.tick({ s1: tree() }, { gpu: reading('new') });
  assert.deepEqual(r.book.info().limits, { 'gpu:new': 50 });
  assert.throws(() => r.book.setLimit('gpu:gone', 50), /No such GPU/);
});

test('GPU readings: a pmon row cut short by a process name is ignored; a row missing for a round is no 100% spike', () => {
  const pmon = '# gpu pid type sm mem enc dec fb command\n# Idx # C/G % % % % MB name\n0 4321 C 99\n';
  assert.deepEqual(parseNvidiaPmon(pmon), []);
  const t = new GpuTracker();
  const row = (v: number) => [`G A,${LUID},1,0,GPU`, `G E,pid_100_luid_${LUID}_phys_0_eng_0_engtype_3D,${v}`, `G E,pid_100_luid_${LUID}_phys_0_eng_1_engtype_Copy,${v}`];
  t.update(parseWindowsGpu(row(1e9)), 0);
  t.update(parseWindowsGpu(row(1e9).slice(0, 2)), 5000);
  t.update(parseWindowsGpu(row(1e9).slice(0, 2)), 10000);
  // The Copy row was gone for two rounds; back, it is a new baseline, not its whole lifetime in one interval.
  const r = t.update(parseWindowsGpu(row(1e9 + 5e6)), 15000);
  // The 3D engine ran 0.5 s of the 5 s (10%); the Copy engine's return counts nothing yet.
  assert.equal(Math.round(groupLoad(r, [100], '0x00000000_0x000171fe')), 10);
  assert.equal(r.perPid.get(100)!.engines.has('0x00000000_0x000171fe|1.Copy'), false);
});

test('heavy commands are found inside the usual wrappers', () => {
  assert.deepEqual(heavyKinds('nohup python train.py &'), ['python train.py']);
  assert.deepEqual(heavyKinds('bash -c "python train.py --epochs 3"'), ['python train.py']);
  assert.deepEqual(heavyKinds('(npm run build)'), ['npm run build']);
  assert.deepEqual(heavyKinds('env CUDA=1 python train.py'), ['python train.py']);
  assert.deepEqual(heavyKinds('cmd /c npm run build'), ['npm run build']);
  assert.deepEqual(heavyKinds('git status'), [], 'light (R4)');
});

test("Claude Code's own console host on Windows is never a job, so a reservation still ends with its job", () => {
  const r = rig();
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Build', cpu: 10 });
  const conhost = { ...proc(19, 11, 5 * 1024 ** 2), name: 'conhost.exe' };
  r.tick({ s1: tree(conhost, proc(13, 11)) }, { cpuOf: { 13: 2 } });
  r.tick({ s1: tree(conhost, proc(13, 11)) }, { cpuOf: { 13: 2 } });
  assert.equal(r.book.info().jobs[0]!.processes, 1);
  r.tick({ s1: tree(conhost) });
  assert.equal(r.book.info().jobs.length, 0, 'ended: only the console host is left');
  assert.equal(parseWindowsLines(['100,50,0,2000,0,conhost.exe'])!.get(100)!.name, 'conhost.exe');
});

// --- Acceptance test of PR #261, round 1 ------------------------------------------------------------------------------

test('two Pauses at once suspend once, and one Resume runs the job again (finding 1)', async () => {
  // Windows counts suspends: a model of one process's suspend count, acted on after a slow fresh process list.
  let count = 0;
  let paused = false;
  const actions = new JobActions();
  const pause = (want: boolean) => actions.run('r1', async () => {
    await new Promise((r) => setTimeout(r, 30)); // the fresh process list
    if (paused === want) throw new Error(want ? 'This job is already paused.' : 'This job is not paused.');
    count += want ? 1 : -1;
    paused = want;
  });
  const results = await Promise.allSettled([pause(true), pause(true)]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal((results[1] as PromiseRejectedResult).reason.message, JOB_BUSY);
  assert.equal(count, 1, 'suspended once');
  await pause(false);
  assert.equal(count, 0, 'running again after one Resume');
  // Stop waits its turn too, and the guard is free again after a failure.
  const p = pause(true);
  await assert.rejects(actions.run('r1', async () => {}), /still under way/);
  await p;
  await assert.rejects(pause(true), /already paused/);
  assert.equal(actions.isBusy('r1'), false);
});

test("Pause and Stop act on the job's processes now: what they started since the last sample too, never the host, Claude Code or its console host (finding 5)", () => {
  const ft = (ms: number) => String((BigInt(ms) + 11644473600000n) * 10000n);
  const fresh: FreshProcess[] = [
    { pid: 10, ppid: 1, started: ft(1000), name: 'node.exe' },
    { pid: 11, ppid: 10, started: ft(2000), name: 'claude.exe' },
    { pid: 19, ppid: 11, started: ft(2100), name: 'conhost.exe' },
    { pid: 13, ppid: 11, started: ft(3000), name: 'bash.exe' },
    { pid: 14, ppid: 13, started: ft(3100), name: 'make.exe' },
    { pid: 15, ppid: 14, started: ft(9000), name: 'cc.exe' }, // started since the last sample
    { pid: 16, ppid: 11, started: ft(9500), name: 'node.exe' }, // reused pid of a job process: another start time
  ];
  const out = jobTargetsNow([{ pid: 13, started: 3000 }, { pid: 14, started: 3100 }, { pid: 16, started: 4000 }, { pid: 11, started: 2000 }], fresh, 10);
  assert.deepEqual(out.map((t) => t.pid).sort(), [13, 14, 15]);
  assert.equal(out.find((t) => t.pid === 15)!.started, 9000);
  assert.equal(fileTimeMs('0'), null);
  assert.equal(fileTimeMs('Thu Nov 12 08:00:00 2026'), null);
});

test("no go before the session's processes are known, not even with Start now (finding 6)", () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  const answer = r.book.reserve('s1', { what: 'Early', cpu: 10 });
  assert.match(answer, /^Wait: Waiting for its session's processes to be measured/);
  r.book.startNow('r1');
  assert.equal(r.book.info().jobs.length, 0);
  r.tick({ s1: tree(proc(12, 11)) });
  assert.equal(r.book.info().jobs.length, 1);
  assert.match(r.told.at(-1)!.text, /^You may go: reservation r1/);
  // The MCP server that was there is the baseline, not the job.
  r.tick({ s1: tree(proc(12, 11)) });
  assert.equal(r.book.info().jobs[0]!.processes, 0);
});

test("a host's pid is the session's host only while its start time fits the record (finding 7)", () => {
  const list: ProcessList = new Map([[10, { pid: 10, ppid: 1, cpuSeconds: 0, memBytes: 0, started: 100_000 }], [20, { pid: 20, ppid: 1, cpuSeconds: 0, memBytes: 0 }]]);
  assert.equal(hostStill(list, 10, 100_500), true);
  assert.equal(hostStill(list, 10, 50_000), false, 'started long after the record: a reused pid');
  assert.equal(hostStill(list, 10, 200_000), false, 'started long before the record');
  assert.equal(hostStill(list, 20, 100_000), true, 'no start time (ps): trusted, as before');
});

test('a lowered process that left the session is put back by its start time; without one (macOS, Linux) it is left alone (findings 9, 11)', () => {
  const r = rig();
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Crunch', cpu: 10 });
  const job = proc(13, 11);
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(job) }, { cpuOf: { 13: 8 } });
  assert.equal(r.priorities.get(13), LOWERED);
  // It leaves the session's tree but runs on (here under another program): its reservation ends, and the next
  // sample puts its priority back by its start time.
  r.tick({ s1: tree(), other: [proc(70, 1), { ...job, ppid: 70 }] });
  assert.equal(r.book.info().jobs.length, 0);
  r.tick({ s1: tree(), other: [proc(70, 1), { ...job, ppid: 70 }] });
  assert.equal(r.priorities.get(13), 0, 'put back by its start time');
  // Without a start time: never put back once outside the session.
  const r2 = rig();
  r2.book.setSettings({ overSec: 5, averageSec: 5 });
  r2.tick({ s1: tree() });
  r2.book.reserve('s1', { what: 'Crunch', cpu: 10 });
  const bare = { ...proc(13, 11), started: undefined };
  for (let i = 0; i < 3; i++) r2.tick({ s1: tree(bare) }, { cpuOf: { 13: 8 } });
  r2.tick({ s1: tree(), other: [proc(70, 1), { ...bare, ppid: 70 }] });
  r2.tick({ s1: tree(), other: [proc(70, 1), { ...bare, ppid: 70 }] });
  assert.equal(r2.priorities.get(13), LOWERED);
});

test('identical GPUs get their own names, so each has its own limit (finding 10)', () => {
  const t = new GpuTracker();
  const r = t.update(parseWindowsGpu(['G A,0x0_0x1,1000,0,RTX 4090', 'G A,0x0_0x2,1000,0,RTX 4090']), 0);
  assert.deepEqual(r.adapters.map((a) => a.name), ['RTX 4090 #1', 'RTX 4090 #2']);
  const b = rig();
  b.tick({ s1: tree() }, { gpu: r });
  b.book.setLimit('gpu:0x0_0x2', 40);
  assert.deepEqual(b.book.info().limits, { 'gpu:0x0_0x2': 40 });
});

// #304: on a PC with one RTX 3080 Ti, Parsec's virtual display adapter and a virtual monitor driver, DXGI listed the
// card three times, same name and 12 GB each, under three ids; D3DKMT said the two extra ids can't render (indirect
// display adapters). The reader marks those with flag 256. Lines as read on that PC, 2026-11-12.
const CARD = 'NVIDIA GeForce RTX 3080 Ti';
const pcAdapters = (noRender: number) => [
  `G A,0x00000000_0x00011183,12673089536,0,${CARD}`,
  `G A,0x00000000_0x0001FECE,12673089536,${noRender},${CARD}`,
  `G A,0x00000000_0x0001D451,12673089536,${noRender},${CARD}`,
  'G A,0x00000000_0x000122F7,0,2,Microsoft Basic Render Driver',
];

test('virtual display adapters are left out of the GPUs; a real one with only shared memory stays (#304)', () => {
  // Premise: without the kernel's "can't render" the copies are listed, as the Machine panel showed them.
  const before = new GpuTracker().update(parseWindowsGpu(pcAdapters(0)), 0);
  assert.deepEqual(before.adapters.map((a) => a.name), [`${CARD} #1`, `${CARD} #2`, `${CARD} #3`]);
  const r = new GpuTracker().update(parseWindowsGpu([
    ...pcAdapters(256),
    // An integrated GPU with no memory of its own renders: it stays. A remote adapter is left out like the software one.
    'G A,0x00000000_0x00000A01,0,0,Intel(R) UHD Graphics 770',
    'G A,0x00000000_0x00000A02,0,1,Remote Display Adapter',
  ]), 0);
  assert.deepEqual(r.adapters.map((a) => [a.id, a.name, a.vramTotal]), [
    ['0x00000000_0x00011183', CARD, 12673089536],
    ['0x00000000_0x00000a01', 'Intel(R) UHD Graphics 770', null],
  ]);
  assert.equal(mainGpu(r), '0x00000000_0x00011183', 'the card stays the main GPU');
  // Alone, the shared-memory GPU is the main one.
  assert.equal(mainGpu(new GpuTracker().update(parseWindowsGpu(['G A,0x0_0x1,0,0,Intel(R) UHD Graphics 770', 'G A,0x0_0x2,0,256,Virtual Display Driver']), 0)), '0x0_0x1');
});

test("limits and reservations on a GPU that is hidden now don't break the page or the line; the card's limit carries over (#304)", () => {
  const b = rig();
  const real = '0x00000000_0x00011183';
  const copy = '0x00000000_0x0001fece';
  b.tick({ s1: tree() }, { gpu: new GpuTracker().update(parseWindowsGpu(pcAdapters(0)), 0) });
  b.book.setLimit(`gpu:${real}`, 60);
  b.book.setLimit(`gpu:${copy}`, 10);
  assert.match(b.book.reserve('s1', { what: 'Render', gpu: 50, gpu_device: `${CARD} #2` }), /wait/i);
  assert.deepEqual(b.book.info().line.map((l) => Object.keys(l.need)), [[`gpu:${copy}`]]);
  // The copies are hidden from here on.
  b.tick({ s1: tree() }, { gpu: new GpuTracker().update(parseWindowsGpu(pcAdapters(256)), 0) });
  const info = b.book.info();
  assert.deepEqual(info.gpus.map((g) => [g.id, g.name, g.main]), [[real, CARD, true]]);
  // The card's limit, kept as "#1", is the card's still; the hidden copy's limit stops counting.
  assert.deepEqual(info.limits, { [`gpu:${real}`]: 60 });
  // Nothing limits the hidden id any more, so the job waiting on it goes, and the line is empty.
  assert.deepEqual(info.line, []);
  assert.equal(info.jobs.length, 1);
  // Set again on the card, then cleared: the old "#1" limit doesn't come back.
  b.book.setLimit(`gpu:${real}`, 70);
  assert.deepEqual(b.book.info().limits, { [`gpu:${real}`]: 70 });
  b.book.setLimit(`gpu:${real}`, null);
  assert.deepEqual(b.book.info().limits, {});
});

test('the card says seconds under a minute (finding 14)', () => {
  assert.equal(overFor(20_000), '20 s');
  assert.equal(overFor(90_000), '2 min');
});

test('a failed GPU read is no baseline: the next read is not a whole lifetime in one interval', () => {
  const t = new GpuTracker();
  const row = (v: number) => [`G A,${LUID},1,0,GPU`, `G E,pid_100_luid_${LUID}_phys_0_eng_0_engtype_3D,${v}`];
  t.update(parseWindowsGpu([`G A,${LUID},1,0,GPU`, 'G X,Windows GPU performance counters returned nothing']), 0);
  const first = t.update(parseWindowsGpu(row(9e9)), 5000);
  assert.equal(first.adapters[0]!.load, 0, 'the first real read is the baseline');
  const r = t.update(parseWindowsGpu(row(9e9 + 5e6)), 10000);
  assert.equal(Math.round(r.adapters[0]!.load), 10);
});

// --- Round 2 (docs/steps/resource-limits-2.md): the pass, subagents, waking, who holds the room, WSL ------------------

const MB = 1024 ** 2;
const tree3 = (...work: ProcInfo[]) => [proc(30, 1), proc(31, 30, 300 * MB), ...work];
const addSession = (r: Rig, id: string, extra: Partial<BookSession> = {}) => r.sessions.set(id, { id, title: id, project: 'p', role: 'session', priority: 'normal', local: true, busy: true, ...extra });

test('a pass parks after 2 minutes quiet and its booking leaves the bar; work under it again needs no new reserve (R1)', () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.tick({ s1: tree() });
  r.book.setLimit('ram', 30);
  assert.match(r.book.reserve('s1', { what: 'Build', ram_gb: 8, cpu: 20 }), /pass for your session and its subagents/);
  const build = proc(13, 11, 4 * GB);
  r.tick({ s1: tree(build) }, { cpuOf: { 13: 3 } });
  assert.equal(r.book.info().jobs[0]!.state, 'ready', 'one active sample is not yet work');
  r.tick({ s1: tree(build) }, { cpuOf: { 13: 3 } });
  assert.equal(r.book.info().jobs[0]!.state, 'busy');
  assert.ok((r.book.info().reserved.ram ?? 0) > 3 * GB, 'busy: holds booked minus used');
  // The build is done; the compiler server it left idles, using almost nothing.
  const daemon = proc(14, 13, 200 * MB);
  let ticks = 0;
  while (r.book.info().jobs[0]!.state === 'busy' && ticks < 40) {
    r.tick({ s1: tree(daemon) });
    ticks++;
  }
  assert.equal(r.book.info().jobs[0]!.state, 'parked');
  assert.ok(ticks >= 24 && ticks <= 26, `parked after about 2 minutes quiet (${ticks} samples)`);
  assert.equal(r.book.info().reserved.ram ?? 0, 0, 'parked: its booking leaves the bar');
  assert.equal(r.book.info().jobs.length, 1, 'kept: the session is still in its turn and the daemon runs');
  // A second run under the same pass, without a new reserve: busy again, and it fits.
  const again = proc(15, 11, 3 * GB);
  r.tick({ s1: tree(daemon, again) }, { cpuOf: { 15: 3 } });
  r.tick({ s1: tree(daemon, again) }, { cpuOf: { 15: 3 } });
  const job = r.book.info().jobs[0]!;
  assert.equal(job.state, 'busy');
  assert.equal(job.resumedAbove, false);
  assert.equal(r.book.info().jobs.length, 1, 'one pass');
});

test('the 2026-11-15 case: two finished builds with leftover idle processes no longer hold the room; the third goes within about 2 minutes', () => {
  const r = rig();
  addSession(r, 's3', { title: 'Three' });
  for (const id of ['s1', 's2']) r.sessions.get(id)!.busy = true;
  const pc = { memUsed: 6 * GB };
  r.tick({ s1: tree(), s2: tree2(), s3: tree3() }, pc);
  r.book.setLimit('ram', 30);
  assert.match(r.book.reserve('s1', { what: 'Build A', ram_gb: 12 }), /^Go:/);
  assert.match(r.book.reserve('s2', { what: 'Build B', ram_gb: 12 }), /^Go:/);
  assert.match(r.book.reserve('s3', { what: 'Build C', ram_gb: 10 }), /^Wait:/);
  const a = proc(13, 11, 2 * GB);
  const b = proc(23, 21, 2 * GB);
  for (let i = 0; i < 4; i++) r.tick({ s1: tree(a), s2: tree2(b), s3: tree3() }, { ...pc, cpuOf: { 13: 4, 23: 4 } });
  assert.deepEqual(r.book.info().jobs.map((j) => j.state), ['busy', 'busy']);
  assert.equal(r.book.info().line.length, 1);
  // Both finish; each leaves a daemon behind (a compiler server, a watcher).
  const finished = r.clock.now;
  const da = proc(14, 11, 150 * MB);
  const db = proc(24, 21, 150 * MB);
  while (r.book.info().line.length && r.clock.now - finished < 10 * 60_000) r.tick({ s1: tree(da), s2: tree2(db), s3: tree3() }, pc);
  const waited = r.clock.now - finished;
  assert.equal(r.book.info().line.length, 0, 'the third has its go');
  assert.ok(waited <= 130_000, `within about 2 minutes (${waited / 1000} s)`);
  assert.match(r.told.find((t) => t.id === 's3')!.text, /^You may go: reservation r3 "Build C"/);
  assert.deepEqual(r.book.info().jobs.filter((j) => j.sessionId !== 's3').map((j) => j.state), ['parked', 'parked']);
});

test("a background subagent's job runs under the session's pass after the main turn has ended; the pass ends when it is over (R1, R2)", () => {
  const r = rig();
  const s1 = r.sessions.get('s1')!;
  s1.busy = true;
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Tests', cpu: 30 });
  // The main turn ends with a tester subagent in the background, which hasn't started its job yet.
  s1.busy = false;
  s1.background = 1;
  r.tick({ s1: tree() });
  assert.equal(r.book.info().jobs.length, 1, 'kept: a background subagent runs');
  // A subagent's reserve acts on the same pass: one pass, the extra added.
  assert.match(r.book.reserve('s1', { what: 'Tests', cpu: 10 }), /^Go:/);
  assert.equal(r.book.info().jobs.length, 1);
  assert.equal(r.book.info().jobs[0]!.granted.cpu, 40);
  const job = proc(16, 11, 1 * GB);
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(job) }, { cpuOf: { 16: 4 } });
  assert.equal(r.book.info().jobs[0]!.state, 'busy');
  assert.equal(r.book.commandRefusal('s1', ['npm test']), null);
  s1.background = 0;
  r.tick({ s1: tree() });
  assert.equal(r.book.info().jobs.length, 0, 'over: no turn, nothing in the background, nothing running');
  assert.equal(r.jobs.kinds()[0]!.kind, 'tests', 'what it used is recorded');
});

test('a parked pass whose known heavy command starts again: it goes if it fits; if not, it is refused and back in line with its original time (open choice 2)', () => {
  const r = rig();
  addSession(r, 's3', { title: 'Three' });
  for (const id of ['s1', 's2']) r.sessions.get(id)!.busy = true;
  r.book.setSettings({ parkSec: 30 });
  for (const at of [1, 2]) r.jobs.add({ project: 'p', kind: 'build', commands: ['npm run build'], asked: {}, peak: { ram: 6 * GB }, mean: {}, durationMs: 60_000, over: false, undeclared: false, endedAt: at });
  const pc = { memUsed: 10 * GB };
  r.tick({ s1: tree(), s2: tree2(), s3: tree3() }, pc);
  r.book.setLimit('ram', 30);
  r.book.reserve('s1', { what: 'Build', ram_gb: 8 });
  const first = r.book.info().jobs[0]!.goAt;
  const job = proc(13, 11, 1 * GB);
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(job), s2: tree2(), s3: tree3() }, { ...pc, cpuOf: { 13: 4 } });
  for (let i = 0; i < 8; i++) r.tick({ s1: tree(), s2: tree2(), s3: tree3() }, pc);
  assert.equal(r.book.info().jobs[0]!.state, 'parked');
  // It fits: the command runs, and the pass holds its room again.
  assert.equal(r.book.commandRefusal('s1', ['npm run build']), null);
  assert.equal(r.book.info().jobs[0]!.state, 'ready');
  assert.equal(r.book.info().reserved.ram, 8 * GB);
  // The go not used: 10 minutes on it parks again.
  r.clock.now += LAPSE_MS;
  r.tick({ s1: tree(), s2: tree2(), s3: tree3() }, pc);
  // Now someone else takes the room, and a later reservation waits.
  assert.match(r.book.reserve('s2', { what: 'Train', ram_gb: 15 }), /^Go:/);
  r.clock.now += 1000;
  assert.match(r.book.reserve('s3', { what: 'Other', ram_gb: 8 }), /^Wait:/);
  assert.equal(r.book.info().jobs.find((j) => j.sessionId === 's1')!.state, 'parked');
  const why = r.book.commandRefusal('s1', ['npm run build'], { subagent: true }) ?? '';
  assert.match(why, /^Wait: your reservation r1 "Build" was parked, and there is no room to resume it now/);
  assert.match(why, /Stop here and tell your parent/);
  const line = r.book.info().line;
  assert.equal(line[0]!.id, 'r1', 'first among equals: it keeps its original time');
  assert.ok(line[0]!.since < first + 1, 'its original time');
  assert.equal(r.book.passWaits('s1'), 'waiting');
  // Still waiting: a second try is told to wait, not to reserve.
  assert.match(r.book.commandRefusal('s1', ['npm run build']) ?? '', /^Wait: your reservation r1 "Build" is waiting for room/);
});

test('work under a parked pass that starts without asking and does not fit runs, judged against its share, and its card says so', () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.sessions.get('s2')!.busy = true;
  r.book.setSettings({ parkSec: 30 });
  const pc = { memUsed: 10 * GB };
  r.tick({ s1: tree(), s2: tree2() }, pc);
  r.book.setLimit('ram', 30);
  r.book.reserve('s1', { what: 'Build', ram_gb: 8 });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(proc(13, 11)), s2: tree2() }, { ...pc, cpuOf: { 13: 4 } });
  for (let i = 0; i < 8; i++) r.tick({ s1: tree(proc(13, 11)), s2: tree2() }, pc);
  assert.equal(r.book.info().jobs[0]!.state, 'parked');
  r.book.reserve('s2', { what: 'Train', ram_gb: 15 });
  for (let i = 0; i < 2; i++) r.tick({ s1: tree(proc(13, 11)), s2: tree2() }, { ...pc, cpuOf: { 13: 4 } });
  const card = r.book.info().jobs.find((j) => j.sessionId === 's1')!;
  assert.equal(card.state, 'busy');
  assert.equal(card.resumedAbove, true);
});

test('heavy work under a parked pass sent back into the line is still judged against its share (code review of PR #476, finding 2)', () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.sessions.get('s2')!.busy = true;
  r.book.setSettings({ parkSec: 30, overSec: 10, averageSec: 5 });
  for (const at of [1, 2]) r.jobs.add({ project: 'p', kind: 'build', commands: ['npm run build'], asked: {}, peak: { ram: 6 * GB }, mean: {}, durationMs: 60_000, over: false, undeclared: false, endedAt: at });
  const pc = { memUsed: 10 * GB };
  r.tick({ s1: tree(), s2: tree2() }, pc);
  r.book.setLimit('ram', 30);
  r.book.reserve('s1', { what: 'Build', ram_gb: 8 });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(proc(13, 11)), s2: tree2() }, { ...pc, cpuOf: { 13: 4 } });
  for (let i = 0; i < 8; i++) r.tick({ s1: tree(), s2: tree2() }, pc);
  assert.equal(r.book.info().jobs[0]!.state, 'parked');
  assert.match(r.book.reserve('s2', { what: 'Train', ram_gb: 15 }), /^Go:/);
  assert.match(r.book.commandRefusal('s1', ['npm run build']) ?? '', /^Wait: your reservation r1 "Build" was parked/);
  assert.equal(r.book.passWaits('s1'), 'waiting');
  // An unknown command runs anyway: 12 GB and 8 cores for 3 minutes.
  const big = started(r, 50, 11, 12 * GB);
  for (let i = 0; i < 36; i++) r.tick({ s1: tree(big), s2: tree2() }, { memUsed: 22 * GB, cpuOf: { 50: 8 } });
  const card = r.book.info().jobs.find((j) => j.sessionId === 's1')!;
  assert.equal(card.state, 'over');
  assert.equal(card.resumedAbove, true);
  assert.equal(r.book.isHeld('s1'), true);
  assert.equal(r.book.info().line.length, 0, 'out of the line: its work started');
});

/** A parked pass (8 GB booked) refused and sent back into the line, as in the finding-2 test above. */
function backInLine() {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.sessions.get('s2')!.busy = true;
  r.book.setSettings({ parkSec: 30, overSec: 10, averageSec: 5 });
  for (const at of [1, 2]) r.jobs.add({ project: 'p', kind: 'build', commands: ['npm run build'], asked: {}, peak: { ram: 6 * GB }, mean: {}, durationMs: 60_000, over: false, undeclared: false, endedAt: at });
  const pc = { memUsed: 10 * GB };
  r.tick({ s1: tree(), s2: tree2() }, pc);
  r.book.setLimit('ram', 30);
  r.book.reserve('s1', { what: 'Build', ram_gb: 8 });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(proc(13, 11)), s2: tree2() }, { ...pc, cpuOf: { 13: 4 } });
  for (let i = 0; i < 8; i++) r.tick({ s1: tree(), s2: tree2() }, pc);
  assert.equal(r.book.info().jobs[0]!.state, 'parked');
  assert.match(r.book.reserve('s2', { what: 'Train', ram_gb: 15 }), /^Go:/);
  assert.match(r.book.commandRefusal('s1', ['npm run build']) ?? '', /^Wait: your reservation r1 "Build" was parked/);
  assert.equal(r.book.passWaits('s1'), 'waiting');
  return r;
}

test('memory taken at once above the booking, then one thread, under a pass back in the line is judged (acceptance test 2 of PR #476, F2)', () => {
  const r = backInLine();
  // 10 GB at once against 8 GB booked, then one thread of 16 (3 points, under the CPU allowance), for 3 minutes.
  const hog = started(r, 50, 11, 10 * GB);
  for (let i = 0; i < 36; i++) r.tick({ s1: tree(hog), s2: tree2() }, { memUsed: 20 * GB, cpuOf: { 50: 0.5 } });
  const card = r.book.info().jobs.find((j) => j.sessionId === 's1')!;
  assert.equal(card.state, 'over');
  assert.equal(card.resumedAbove, true);
  assert.equal(r.book.isHeld('s1'), true);
  assert.equal(r.book.info().line.length, 0, 'out of the line: its work started');
});

test('memory growing under a pass back in the line is still caught, from under its booking to above it (acceptance test 2 of PR #476, F2)', () => {
  const r = backInLine();
  const job = started(r, 50, 11);
  for (let i = 0; i < 36; i++) {
    const mem = Math.min(2 * GB + i * 512 * MB, 12 * GB);
    r.tick({ s1: tree({ ...job, memBytes: mem }), s2: tree2() }, { memUsed: 10 * GB + mem, cpuOf: { 50: 0.5 } });
    if (i === 3) assert.equal(r.book.info().jobs.find((j) => j.sessionId === 's1')!.state, 'busy', 'growing is work: out of the line');
  }
  assert.equal(r.book.info().jobs.find((j) => j.sessionId === 's1')!.state, 'over');
  assert.equal(r.book.isHeld('s1'), true);
});

test('a pass back in the line claims none of its processes: work that is never active twice in a row is judged as unreserved (acceptance test 2 of PR #476, F2)', () => {
  const r = backInLine();
  r.book.setSettings({ averageSec: 30 });
  // Bursts of 6 cores every other sample: never two active samples in a row, 19 points on average.
  const job = started(r, 50, 11, 1 * GB);
  for (let i = 0; i < 12; i++) r.tick({ s1: tree(job), s2: tree2() }, { memUsed: 11 * GB, cpuOf: { 50: i % 2 ? 0 : 6 } });
  assert.equal(r.book.passWaits('s1'), 'waiting', 'still in line');
  assert.equal(r.book.info().unreserved.length, 1, 'judged as the session\'s unreserved work');
  assert.equal(r.book.isHeld('s1'), true);
});

test('a leftover daemon under a pass back in the line, within what it had booked, holds no one (acceptance test 2 of PR #476, F2)', () => {
  const r = backInLine();
  const daemon = proc(14, 11, 3 * GB);
  for (let i = 0; i < 12; i++) r.tick({ s1: tree(daemon), s2: tree2() }, { memUsed: 13 * GB });
  assert.equal(r.book.passWaits('s1'), 'waiting');
  assert.equal(r.book.info().unreserved.length, 0);
  assert.equal(r.book.isHeld('s1'), false);
});

test('a paused job whose pass went back into the line is resumed when a new reservation replaces it (code review of PR #476, finding 3)', () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.sessions.get('s2')!.busy = true;
  r.book.setSettings({ parkSec: 30 });
  for (const at of [1, 2]) r.jobs.add({ project: 'p', kind: 'build', commands: ['npm run build'], asked: {}, peak: { ram: 6 * GB }, mean: {}, durationMs: 60_000, over: false, undeclared: false, endedAt: at });
  const pc = { memUsed: 10 * GB };
  r.tick({ s1: tree(), s2: tree2() }, pc);
  r.book.setLimit('ram', 30);
  r.book.reserve('s1', { what: 'Build', ram_gb: 8 });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(proc(13, 11)), s2: tree2() }, { ...pc, cpuOf: { 13: 4 } });
  for (let i = 0; i < 8; i++) r.tick({ s1: tree(proc(13, 11)), s2: tree2() }, pc);
  assert.equal(r.book.info().jobs[0]!.state, 'parked');
  r.book.setJobPaused('r1', true);
  r.book.reserve('s2', { what: 'Train', ram_gb: 15 });
  assert.match(r.book.commandRefusal('s1', ['npm run build']) ?? '', /^Wait:/);
  r.book.reserve('s1', { what: 'Tests', ram_gb: 4 });
  assert.deepEqual(r.resumed, [13]);
  assert.ok(!r.book.info().jobs.some((j) => j.id === 'r1'));
  assert.equal(rows(r).length, 3, 'r1 recorded beside the two seeded runs');
});

test('a call that only frees resources always runs, even while the session is held (issue #356, 2026-11-19)', () => {
  for (const c of ['node scripts/emulator-lock.mjs release', 'taskkill /PID 1234 /F', 'npm run stop', './gradlew --stop', 'docker compose down', 'adb emu kill', './stop-emulator.sh']) {
    assert.equal(freesResources(c), true, c);
  }
  for (const c of ['npm run build', 'python train.py --kill-after 10', 'node emulator-lock.mjs release && npm run build', 'git status', 'node emulator.mjs start']) {
    assert.equal(freesResources(c), false, c);
  }
  // Release builds and a stray word are not freeing: only the command's own subcommand counts (code review of PR #476, finding 1).
  for (const c of ['cargo build --release', 'dotnet build -c Release', 'cmake --build . --config Release', 'flutter build apk --release', 'python train.py --epochs 50 stop',
    'node burn.mjs release', 'node scripts/build.mjs --out dist/release', 'npm run release', 'npm run build -- --stop-on-error', 'gradle assembleRelease']) {
    assert.equal(freesResources(c), false, c);
  }
  for (const c of ['docker stop db', 'npm run emulator:stop', 'node release-lock.mjs', 'python scripts/unlock.py', 'pkill -f train.py', 'node emulator-lock.mjs unlock']) {
    assert.equal(freesResources(c), true, c);
  }
  const r = rig();
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  for (const at of [1, 2]) r.jobs.add({ project: 'p', kind: '(unreserved)', commands: ['node scripts/emulator-lock.mjs'], asked: {}, peak: { ram: 4 * GB }, mean: {}, durationMs: 1, over: true, undeclared: true, endedAt: at });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(proc(40, 11, 3 * GB)) }, { cpuOf: { 40: 10 } });
  assert.equal(r.book.isHeld('s1'), true);
  const kinds = heavyKinds('node scripts/emulator-lock.mjs release');
  assert.deepEqual(kinds, ['node scripts/emulator-lock.mjs']);
  assert.match(r.book.commandRefusal('s1', kinds) ?? '', /^Not now: .*commands that stop it or release a lock always run/);
  assert.equal(r.book.commandRefusal('s1', kinds, { freeing: true }), null);
});

test("the go's 10 minutes count from when it reaches the session; until then it holds its room and its session isn't idle-stopped (R3)", () => {
  const r = rig();
  const s1 = r.sessions.get('s1')!;
  r.tick({ s1: tree(), s2: tree2() }, { cores: 3.2 });
  r.book.setLimit('cpu', 30);
  assert.match(r.book.reserve('s1', { what: 'Train', cpu: 20 }), /^Wait:/);
  assert.equal(r.book.passWaits('s1'), 'waiting');
  const idle = { info: { role: 'session' as const, status: 'idle' as const, paused: false }, turnOpen: false, pendingPermissions: 0, openQuestions: 0, waitingDeliveries: 0, backgroundTasks: 0, facts: FRESH_FACTS, lastActivity: 0 };
  assert.equal(idleStopBlocker({ ...idle, reservation: r.book.passWaits('s1') }, 10 * 3600_000, 3600_000), 'waiting for its reservation');
  // The go is given while the working line is full: it waits in the session's inbox.
  r.undelivered.add('s1');
  r.book.setLimit('cpu', 90);
  assert.match(r.told.at(-1)!.text, /^You may go/);
  for (let i = 0; i < 15 * 12; i++) r.tick({ s1: tree(), s2: tree2() });
  const job = r.book.info().jobs[0]!;
  assert.equal(job.state, 'ready', 'not lapsed: the go has not reached it');
  assert.equal(job.deliveredAt, null);
  assert.equal(r.book.info().reserved.cpu, 20, 'the room is promised to it');
  assert.equal(r.book.passWaits('s1'), 'ready');
  assert.equal(idleStopBlocker({ ...idle, reservation: r.book.passWaits('s1') }, 10 * 3600_000, 3600_000), 'waiting for its reservation');
  // It reaches the session (a turn starts with it); 10 minutes from then it parks.
  r.undelivered.delete('s1');
  s1.busy = true;
  r.tick({ s1: tree(), s2: tree2() });
  const reached = r.book.info().jobs[0]!.deliveredAt!;
  assert.equal(reached, r.clock.now);
  r.clock.now += LAPSE_MS - 10_000;
  r.tick({ s1: tree(), s2: tree2() });
  assert.equal(r.book.info().jobs[0]!.state, 'ready');
  r.clock.now += 10_000;
  r.tick({ s1: tree(), s2: tree2() });
  assert.equal(r.book.info().jobs[0]!.state, 'parked');
  assert.equal(r.book.passWaits('s1'), null, 'parked: idle stop may end it');
  assert.equal(idleStopBlocker({ ...idle, reservation: null }, 10 * 3600_000, 3600_000), null);
});

test('the manager is told once when its session has waited 30 minutes, with who holds the room but no other session\'s words, and again at the go (R3, R6)', () => {
  const r = rig();
  r.sessions.get('s1')!.parentId = 'boss';
  r.sessions.get('s2')!.busy = true;
  r.sessions.get('s2')!.parentId = 'someone-else';
  const pc = { memUsed: 8 * GB };
  r.tick({ s1: tree(), s2: tree2() }, pc);
  r.book.setLimit('ram', 20);
  r.book.reserve('s2', { what: 'Secret plan', ram_gb: 10 });
  assert.match(r.book.reserve('s1', { what: 'Fix tests', ram_gb: 6 }), /^Wait:/);
  for (let i = 0; i < 6; i++) r.tick({ s1: tree(), s2: tree2(proc(23, 21, 2 * GB)) }, { ...pc, cpuOf: { 23: 4 } });
  assert.equal(r.managers.length, 0);
  r.clock.now += 30 * 60_000;
  r.tick({ s1: tree(), s2: tree2(proc(23, 21, 2 * GB)) }, { ...pc, cpuOf: { 23: 4 } });
  r.tick({ s1: tree(), s2: tree2(proc(23, 21, 2 * GB)) }, { ...pc, cpuOf: { 23: 4 } });
  assert.equal(r.managers.length, 1, 'once');
  assert.equal(r.managers[0]!.id, 'boss');
  assert.match(r.managers[0]!.text, /^Your session "One" has waited \d+ min for its reservation "Fix tests": Waiting for memory room: .*; held by 1 other job \(10 GB booked, 2\.0 GB used\)/);
  assert.doesNotMatch(r.managers[0]!.text, /Secret plan|Two/);
  r.book.release('s2');
  assert.match(r.managers.at(-1)!.text, /^Your session "One" may go now/);
});

test("who holds the room: named on the page; for sessions other jobs only as counts and figures; WSL and other programs by name (R5, R6)", () => {
  const r = rig();
  r.sessions.get('s2')!.busy = true;
  const wsl = { pid: 900, ppid: 4, cpuSeconds: 0, memBytes: 6 * GB, started: 1, name: 'vmmemWSL' };
  const chrome = [{ pid: 901, ppid: 4, cpuSeconds: 0, memBytes: 1 * GB, started: 1, name: 'chrome.exe' }, { pid: 902, ppid: 901, cpuSeconds: 0, memBytes: 1.5 * GB, started: 2, name: 'chrome.exe' }];
  const pc = { memUsed: 13 * GB, outside: [wsl, ...chrome] };
  r.tick({ s1: tree(), s2: tree2() }, pc);
  assert.equal(r.book.info().wsl, 6 * GB);
  r.book.setLimit('ram', 20);
  r.book.reserve('s2', { what: 'Secret plan', ram_gb: 3 });
  for (let i = 0; i < 3; i++) r.tick({ s1: tree(), s2: tree2(proc(23, 21, 1 * GB)) }, { ...pc, cpuOf: { 23: 4 } });
  const answer = r.book.reserve('s1', { what: 'Mine', ram_gb: 6 });
  assert.match(answer, /^Wait: Waiting for memory room: .*; held by WSL 6\.0 GB, other programs .*, 1 other job \(3\.0 GB booked, 1\.0 GB used\)/);
  assert.doesNotMatch(answer, /Secret plan|Two|chrome/);
  const line = r.book.info().line[0]!;
  assert.match(line.reason, /"Secret plan" \(Two: 3\.0 GB booked, 1\.0 GB used\)/);
  assert.match(line.reason, /other programs [\d.]+ GB \(most: chrome\.exe 2\.5 GB\)/);
  assert.doesNotMatch(line.reasonForSessions, /Secret plan|Two|chrome/);
  // Without WSL: nothing about it.
  const r2 = rig();
  r2.tick({ s1: tree() });
  assert.equal(r2.book.info().wsl, null);
  assert.equal(wslHintDue({ wsl: 6 * GB, limits: { ram: 20 * GB } }, 64 * GB), true);
  assert.equal(wslHintDue({ wsl: 6 * GB, limits: {} }, 64 * GB), false);
  assert.equal(wslHintDue({ wsl: null, limits: { ram: 1 * GB } }, 64 * GB), false);
});

test('a heavy job started detached is taken as its session\'s, so its pass counts and learns it and Pause and Stop on its card reach it; two sessions detaching at once claim nothing', () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Train', cpu: 30, ram_gb: 4 });
  r.book.callStarted('s1', 'd1', ['python train.py'], true, true, 'nohup python train.py > train.log 2>&1 &');
  // Its shell ended before any sample: the trainer's parent id names a process that is gone.
  const started77 = r.clock.now + 1000;
  for (let i = 1; i <= 3; i++) r.tick({ s1: tree() }, { outside: [{ pid: 77, ppid: 999, cpuSeconds: i * 20, memBytes: 3 * GB, started: started77 }] });
  const job = r.book.info().jobs[0]!;
  assert.equal(job.processes, 1);
  assert.equal(job.state, 'busy');
  // Pause and Stop on its card reach it, though it is under no host (acceptance test 3 of PR #476): its parent was
  // never seen, so it was taken by timing alone, and the action checks its command line against the detaching call's
  // (re-review of PR #476); the fresh list is looked at from it as well, so what it started since is reached too.
  const targets = r.book.jobTargets(job.id);
  assert.deepEqual(targets.adopted, []);
  assert.deepEqual(targets.guessed, [{ pid: 77, commands: ['nohup python train.py > train.log 2>&1 &'] }]);
  const ft = (ms: number) => String((BigInt(ms) + 11644473600000n) * 10000n);
  const all: FreshProcess[] = [
    { pid: 10, ppid: 1, started: ft(1000), name: 'node.exe' },
    { pid: 11, ppid: 10, started: ft(2000), name: 'claude.exe' },
    { pid: 77, ppid: 999, started: ft(started77), name: 'python.exe' },
    { pid: 78, ppid: 77, started: ft(started77 + 500), name: 'python.exe' },
    { pid: 500, ppid: 4, started: ft(500), name: 'other.exe' },
  ];
  const lines = [{ pid: 77, started: ft(started77), command: '"C:\\Python312\\python.exe" train.py', cwd: null }];
  const proven = provenByCommand(targets.guessed, all, lines, [], () => false);
  assert.deepEqual(proven, [77]);
  const now = jobTargetsNow(targets.targets, jobProcessesNow(all, targets.host!, proven), targets.host!);
  assert.deepEqual(now.map((t) => t.pid).sort(), [77, 78]);
  // Without the adopted roots (as before acceptance test 3's fix) nothing was reached.
  assert.deepEqual(jobTargetsNow(targets.targets, jobProcessesNow(all, targets.host!, []), targets.host!), []);
  // Another process at that pid now (a reused id), or one whose working folder is outside the session's: left alone.
  assert.deepEqual(provenByCommand(targets.guessed, all, [{ ...lines[0]!, started: ft(started77 + 9) }], [], () => false), []);
  assert.deepEqual(provenByCommand(targets.guessed, all, [{ ...lines[0]!, cwd: '/home/me/elsewhere' }], ['/home/me/project'], (f, c) => c.startsWith(f)), []);
  assert.deepEqual(provenByCommand(targets.guessed, all, [{ ...lines[0]!, cwd: '/home/me/project/sub' }], ['/home/me/project'], (f, c) => c.startsWith(f)), [77]);
  r.sessions.get('s1')!.busy = false;
  r.tick({ s1: tree() });
  assert.equal(r.book.info().jobs.length, 0);
  assert.deepEqual(rows(r).at(-1)!.commands, ['python train.py']);
  // Two sessions detach at the same moment: whose the orphan is can't be told.
  const r2 = rig();
  r2.sessions.get('s1')!.busy = true;
  r2.tick({ s1: tree(), s2: tree2() });
  r2.book.reserve('s1', { what: 'A', cpu: 30 });
  r2.book.callStarted('s1', 'a', ['python a.py'], true, true);
  r2.book.callStarted('s2', 'b', ['python b.py'], true, true);
  const at = r2.clock.now + 500;
  for (let i = 1; i <= 3; i++) r2.tick({ s1: tree(), s2: tree2() }, { outside: [{ pid: 78, ppid: 998, cpuSeconds: i * 20, memBytes: 3 * GB, started: at }] });
  assert.equal(r2.book.info().jobs[0]!.processes, 0);
});

test("an outside program taken by timing alone is counted but Pause and Stop never touch it; one seen under the host is the session's (re-review of PR #476)", () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Daemon', cpu: 30, ram_gb: 4 });
  r.book.callStarted('s1', 'd1', ['node daemon.mjs'], true, true, 'nohup node daemon.mjs &');
  // The person starts a game: its launcher exits between two samples, so the game's parent is never seen, and it
  // starts within the detaching call's window.
  const game = { pid: 88, ppid: 990, cpuSeconds: 0, memBytes: 3 * GB, started: r.clock.now + 2000, name: 'game.exe' };
  for (let i = 1; i <= 3; i++) r.tick({ s1: tree() }, { outside: [{ ...game, cpuSeconds: i * 20 }] });
  const job = r.book.info().jobs[0]!;
  assert.equal(job.processes, 1, 'counted: a timing guess is fine for counting');
  const targets = r.book.jobTargets(job.id);
  assert.deepEqual(targets.adopted, []);
  assert.deepEqual(targets.guessed.map((g) => g.pid), [88]);
  const ft = (ms: number) => String((BigInt(ms) + 11644473600000n) * 10000n);
  const all: FreshProcess[] = [
    { pid: 10, ppid: 1, started: ft(100), name: 'node.exe' },
    { pid: 11, ppid: 10, started: ft(110), name: 'claude.exe' },
    { pid: 88, ppid: 990, started: ft(game.started), name: 'game.exe' },
    { pid: 89, ppid: 88, started: ft(game.started + 100), name: 'game-helper.exe' },
  ];
  // Stop never touches it: its command is not the session's call.
  const proven = provenByCommand(targets.guessed, all, [{ pid: 88, started: ft(game.started), command: '"C:\\Games\\Game\\game.exe" --launcher-token abc', cwd: null }], [], () => false);
  assert.deepEqual(proven, []);
  assert.deepEqual(jobTargetsNow(targets.targets, jobProcessesNow(all, targets.host!, [...targets.adopted, ...proven]), targets.host!), []);
  // A detached job whose shell a sample saw under the host is proven the session's, without its command.
  const r2 = rig();
  r2.sessions.get('s1')!.busy = true;
  r2.tick({ s1: tree() });
  r2.book.reserve('s1', { what: 'Train', cpu: 30, ram_gb: 4 });
  r2.book.callStarted('s1', 'd2', ['python train.py'], true, true, 'python train.py &');
  const shell = proc(40, 11);
  const trainer = { pid: 41, ppid: 40, cpuSeconds: 0, memBytes: 3 * GB, started: r2.clock.now + 500 };
  r2.tick({ s1: tree(shell, trainer) });
  for (let i = 1; i <= 2; i++) r2.tick({ s1: tree() }, { outside: [{ ...trainer, cpuSeconds: i * 20 }] });
  const t2 = r2.book.jobTargets(r2.book.info().jobs[0]!.id);
  assert.deepEqual(t2.adopted, [41]);
  assert.deepEqual(t2.guessed, []);
});

test("after Stop, an outside program it left alone is off the job for good, so the stopped job's card goes away (acceptance test 5 of PR #476)", () => {
  const r = rig();
  r.sessions.get('s1')!.busy = true;
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Daemon', cpu: 30, ram_gb: 3 });
  r.book.callStarted('s1', 'd1', ['node daemon.mjs'], true, true, 'nohup node daemon.mjs &');
  const game = { pid: 88, ppid: 990, cpuSeconds: 0, memBytes: 2 * GB, started: r.clock.now + 2000, name: 'game.exe' };
  for (let i = 1; i <= 3; i++) r.tick({ s1: tree() }, { outside: [{ ...game, cpuSeconds: i * 20 }] });
  const job = r.book.info().jobs[0]!;
  assert.equal(job.processes, 1);
  r.book.disown(job.id, [88]);
  assert.equal(r.book.info().jobs[0]!.processes, 0, 'off the card at once');
  // The game runs on: never taken again while it is the same process, and the pass ends with the session's work.
  r.sessions.get('s1')!.busy = false;
  for (let i = 4; i <= 6; i++) r.tick({ s1: tree() }, { outside: [{ ...game, cpuSeconds: i * 20 }] });
  assert.equal(r.book.info().jobs.length, 0, 'the card goes away');
  // A later process that reuses the id is judged afresh.
  r.sessions.get('s1')!.busy = true;
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Daemon 2', cpu: 30, ram_gb: 3 });
  r.book.callStarted('s1', 'd2', ['node daemon.mjs'], true, true, 'nohup node daemon.mjs &');
  const again = { ...game, started: r.clock.now + 1000 };
  for (let i = 1; i <= 3; i++) r.tick({ s1: tree() }, { outside: [{ ...again, cpuSeconds: i * 20 }] });
  assert.equal(r.book.info().jobs[0]!.processes, 1);
});

test('the Stop confirm counts only what it will end and names what it leaves alone; the note after says the same (acceptance test 5 of PR #476)', () => {
  assert.equal(stopConfirmText('build W1', { act: 2, others: 0, names: [] }), 'Stop "build W1"? Its 2 processes will be ended, and the session told.');
  assert.equal(stopConfirmText('build W1', { act: 2, others: 2, names: ['game.exe', 'conhost.exe'] }),
    'Stop "build W1"? Its 2 processes will be ended, and the session told. 2 others Ledung only guessed belong to it (game.exe and conhost.exe) are left alone and taken off the job; Stop never ends them.');
  assert.equal(stopConfirmText('build W1', { act: 0, others: 1, names: ['game.exe'] }),
    'Stop "build W1"? None of its own processes are still running; the session will be told. 1 other Ledung only guessed belongs to it (game.exe) is left alone and taken off the job; Stop never ends it.');
  assert.equal(jobActionNote('stop', 'build W1', { done: 2, leftAlone: ['game.exe', 'conhost.exe'] }),
    'Stopped "build W1": 2 processes ended. Left alone: game.exe and conhost.exe. Ledung only guessed they belong to the job, from when they started, so it doesn\'t end them; no longer counted as the job\'s.');
  assert.equal(jobActionNote('stop', 'build W1', { done: 1, leftAlone: [] }), 'Stopped "build W1": 1 process ended.');
  assert.equal(jobActionNote('pause', 'build W1', { done: 2, leftAlone: ['game.exe'] }),
    'Paused "build W1". Left alone: game.exe. Ledung only guessed it belongs to the job, from when it started, so it doesn\'t pause it.');
  assert.equal(jobActionNote('pause', 'build W1', { done: 2, leftAlone: [] }), null);
  assert.equal(jobActionNote('resume', 'build W1', { done: 2, leftAlone: [] }), null);
  assert.equal(namesText(['a.exe', 'b.exe', 'c.exe']), 'a.exe, b.exe and c.exe');
});

test('a process command line is a detaching call\'s only if its program and each argument are words of the call', () => {
  assert.equal(commandIsCalls('"C:\\Program Files\\nodejs\\node.exe" daemon.mjs', 'nohup node daemon.mjs > out.log 2>&1 &'), true);
  assert.equal(commandIsCalls('/usr/bin/python3 /home/me/p/train.py --epochs 3', 'cd /home/me/p && nohup python3 train.py --epochs 3 &'), true);
  assert.equal(commandIsCalls('python.exe train.py', 'start /b python train.py'), true);
  assert.equal(commandIsCalls('"C:\\Games\\game.exe"', 'nohup node daemon.mjs &'), false);
  assert.equal(commandIsCalls('node other.mjs', 'nohup node daemon.mjs &'), false);
  assert.equal(commandIsCalls('node daemon.mjs --inspect', 'nohup node daemon.mjs &'), false);
  assert.equal(commandIsCalls('', 'nohup node daemon.mjs &'), false);
  // A quoted argument stays one word, operators inside it included (tried on Windows' real command line).
  assert.equal(commandIsCalls('"C:\\Program Files\\nodejs\\node.exe" -e "setTimeout(()=>{}, 20000)" daemon.mjs', 'nohup node -e "setTimeout(()=>{}, 20000)" daemon.mjs&'), true);
});

test("a program another program started is never taken as a detaching session's, however close in time (code review of PR #476, finding 4)", () => {
  const r = rig();
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  const launcher = { pid: 4242, ppid: 4, cpuSeconds: 0, memBytes: 50 * 1024 ** 2, started: 5, name: 'launcher.exe' };
  r.tick({ s1: tree() }, { outside: [launcher] });
  r.book.callStarted('s1', 'd', ['python train.py'], true, true);
  // 8 s later the launcher starts a game and exits: the game's parent was never in s1's tree.
  r.clock.now += 3000;
  const game = { pid: 5000, ppid: 4242, cpuSeconds: 0, memBytes: 6 * GB, started: r.clock.now + 5000, name: 'game.exe' };
  r.tick({ s1: tree() }, { outside: [launcher, game] });
  for (let i = 1; i <= 6; i++) r.tick({ s1: tree() }, { outside: [{ ...game, cpuSeconds: i * 40 }] });
  assert.equal(r.book.info().unreserved.length, 0);
  assert.equal(r.book.isHeld('s1'), false);
});

test('a reservation kept by a Ledung before passes loads as a pass: busy once it had a job, else ready', () => {
  const r = rig();
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Build', cpu: 20 });
  const kept = JSON.parse(r.meta.get('resource-reservations')!) as Record<string, unknown>[];
  for (const [hadJob, want] of [[true, 'busy'], [false, 'ready']] as const) {
    const old = kept.map((k) => ({ ...k, state: 'going', hadJob, deliveredAt: undefined, quietSince: undefined, refMem: undefined, parkedAt: undefined, resumedAbove: undefined, managerTold: undefined }));
    const again = new ResourceBook({
      meta: { get: (k) => (k === 'resource-reservations' ? JSON.stringify(old) : null), set: () => {} }, jobs: r.jobs, session: (id) => r.sessions.get(id) ?? null,
      tell: () => {}, wake: () => {}, changed: () => {},
    });
    assert.equal(again.info().jobs[0]!.state, want);
  }
});
