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
import { heavyKinds } from '../src/resources/commands.ts';
import { LOWERED, type PriorityControl } from '../src/platform/process-control.ts';
import { limitShare, limitText, parseLimitInput } from '../web/src/usage/resourceLimits.ts';

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

test('a running job counts as over only after its average stays above share plus margin for the whole time, and is back at once', () => {
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
  tick(trees: Record<string, ProcInfo[]>, opts?: { cpuOf?: Record<number, number>; memUsed?: number; cores?: number; gpu?: GpuReading }): void;
  resumed: number[];
  meta: Map<string, string>;
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
    const sample: BookSample = { at: clock.now, threads: 16, cores: o.cores ?? 1, memUsed: o.memUsed ?? 10 * GB, memTotal: 64 * GB, list, prev, dt: 5, trees: treeMap, hosts, gpu: o.gpu ?? null };
    book.sample(sample);
    prev = list;
  };
  return { book, told, woken, priorities, clock, jobs, sessions, tick, meta, resumed };
}

const proc = (pid: number, ppid: number, mem = 100 * 1024 ** 2): ProcInfo => ({ pid, ppid, cpuSeconds: 0, memBytes: mem, started: pid * 10 });
/** A session's tree: its host (10), Claude Code (11), and what it started. */
const tree = (...work: ProcInfo[]) => [proc(10, 1), proc(11, 10, 300 * 1024 ** 2), ...work];
const tree2 = (...work: ProcInfo[]) => [proc(20, 1), proc(21, 20, 300 * 1024 ** 2), ...work];

test('reserve: go at once when it fits; wait with a reason when not; a raised limit lets it go at once and the session is told', () => {
  const r = rig();
  r.tick({ s1: tree(), s2: tree2() }, { cores: 3.2 }); // 20% of 16 threads
  r.book.setLimit('cpu', 50);
  const go = r.book.reserve('s1', { what: 'Build', cpu: 25 });
  assert.match(go, /^Go: reservation r1 "Build", 25% CPU/);
  const wait = r.book.reserve('s2', { what: 'Train', cpu: 40 });
  assert.match(wait, /^Wait: Waiting for CPU room: needs ~40%, 5% left under the 50% limit \(1st in line\)/);
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

test('at the end of a turn a going reservation with no job running is released; one with a background job is kept', () => {
  const r = rig();
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Bg', cpu: 10 });
  r.tick({ s1: tree(proc(15, 11)) });
  r.book.turnEnded('s1');
  r.tick({ s1: tree(proc(15, 11)) });
  assert.equal(r.book.info().jobs.length, 1, 'kept while its process runs');
  r.book.reserve('s2', { what: 'Nothing', cpu: 10 });
  r.book.turnEnded('s2');
  r.tick({ s1: tree(proc(15, 11)), s2: tree2() });
  assert.equal(r.book.info().jobs.filter((j) => j.sessionId === 's2').length, 0, 'released: nothing ran');
});

test('a go not used within 10 minutes lapses, and the session is told', () => {
  const r = rig();
  r.tick({ s1: tree() });
  r.book.reserve('s1', { what: 'Later', cpu: 10 });
  r.clock.now += LAPSE_MS;
  r.tick({ s1: tree() });
  assert.equal(r.book.info().jobs.length, 0);
  assert.match(r.told.at(-1)!.text, /lapsed/);
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
  assert.equal(r.book.info().jobs[0]!.loweredStays, true);
});

test('heavy work without a reservation is held and told to reserve next time; its commands then need a reservation', () => {
  const r = rig();
  r.book.setSettings({ overSec: 5, averageSec: 5 });
  for (let round = 0; round < 2; round++) {
    r.tick({ s1: tree() });
    r.book.noteCommands('s1', ['python train.py']);
    for (let i = 0; i < 3; i++) r.tick({ s1: tree(proc(30 + round, 11)) }, { cpuOf: { [30 + round]: 6 } });
    assert.equal(r.book.isHeld('s1'), true);
    assert.match(r.told.at(-1)!.text, /without a reservation/);
    assert.match(r.told.at(-1)!.text, /call reserve before heavy work next time/);
    r.tick({ s1: tree() });
    assert.equal(r.book.isHeld('s1'), false);
  }
  const why = r.book.commandRefusal('s1', ['python train.py']);
  assert.match(why ?? '', /Call reserve first/);
  assert.equal(r.book.commandRefusal('s1', ['git status']), null);
  // With a reservation going, it runs.
  r.book.reserve('s1', { what: 'Train', cpu: 40 });
  assert.equal(r.book.commandRefusal('s1', ['python train.py']), null);
  // The person can say it never needs one.
  r.book.release('s1');
  r.jobs.markNever('p', 'python train.py', true);
  assert.equal(r.book.commandRefusal('s1', ['python train.py']), null);
});

test('after three runs the learned figure replaces the guess, and the answer says so', () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.jobs.add({ project: 'p', kind: 'render tiles', commands: [], asked: { cpu: 10 }, peak: { cpu: 30 + i }, mean: { cpu: 20 }, durationMs: 1000, over: false, undeclared: false, endedAt: i });
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
  assert.deepEqual(heavyKinds('git status'), ['git status']);
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
