// Resource limits (docs/steps/resource-limits.md): the limits, the reservations and their line, the check of running
// jobs against their own share, and new sessions waiting for memory. Ledung does the mechanical part; the session
// declares its job and cuts it back when told (workflow-fit's principle). Decisions are in limits.ts; this keeps the
// state, takes the measuring samples, and acts: tell a session, hold it, lower and restore a job's priority.
import { treeOf, type ProcInfo, type ProcessList } from '../platform/processes.ts';
import { groupLoad, groupMem, mainGpu, type GpuReading } from '../platform/gpu.ts';
import { lower, osPriority, restore, type PriorityControl, type Target } from '../platform/process-control.ts';
import type { Priority, ResourceJobInfo, ResourceLineInfo, ResourcesInfo, SessionRole } from '../shared/protocol.ts';
import { fromGeneric, normaliseKind, toGeneric, type JobStore } from './jobs.ts';
import {
  addAmounts, ALLOWANCE, Averages, DEFAULT_SETTINGS, dimLabel, formatDim, GB, grantPass, isMemory, marginOf, NOT_OVER, overStep, roomReason, unusedOf,
  type Amounts, type LimitSettings, type LineItem, type OverState, type Waiting,
} from './limits.ts';

const LIMITS_KEY = 'resource-limits';
const SETTINGS_KEY = 'resource-settings';
const RESERVATIONS_KEY = 'resource-reservations';
const LOWERED_KEY = 'resource-lowered';
/** A go not used lapses (open choice 9). */
export const LAPSE_MS = 10 * 60_000;
/** A new session counts as this much memory until its kind has been measured (point 9). */
export const SESSION_FIRST_GUESS = 1 * GB;
/** How long a new session's memory is watched for its footprint. */
const FOOTPRINT_MS = 5 * 60_000;
/** Samples (5 s each) with no GPU readings before the page says GPU limits are off: past the read's quick retries. */
const NO_GPU_SAMPLES = 12;
/** Inbox source of Ledung's notices about resources, so a held session still gets them (open choice 1). */
export const RESOURCE_SOURCE = 'ledung:resources';

export interface BookSession {
  id: string;
  title: string;
  project: string;
  role: SessionRole;
  priority: Priority;
  /** Runs on this computer (container projects are out of scope). */
  local: boolean;
  /** In a turn now. */
  busy: boolean;
}

export interface BookContext {
  meta: { get(key: string): string | null; set(key: string, value: string): void };
  jobs: JobStore;
  session(id: string): BookSession | null;
  /** A notice for a session: into its inbox (RESOURCE_SOURCE) and delivered when it is free. */
  tell(id: string, text: string): void;
  /** A hold on a session was lifted: deliver what waits. */
  wake(id: string): void;
  /** Something the page shows changed. */
  changed(): void;
  /** A job the person paused ends (released, its session gone): its processes are resumed, never left frozen. */
  resume?(targets: Target[]): void;
  control?: PriorityControl;
  now?: () => number;
}

export interface BookSample {
  at: number;
  threads: number;
  /** Cores in use on the whole PC. */
  cores: number;
  memUsed: number;
  memTotal: number;
  list: ProcessList;
  prev: ProcessList | null;
  /** Seconds since the previous list. */
  dt: number;
  /** Each live local session's processes (its host's tree, #169) and its host's pid. */
  trees: Map<string, ProcInfo[]>;
  hosts: Map<string, number>;
  gpu: GpuReading | null;
}

export interface ReserveArgs {
  what: string;
  cpu?: number;
  ram_gb?: number;
  gpu?: number;
  vram_gb?: number;
  minutes?: number;
  gpu_device?: string;
}

/** A priority Ledung lowered: what it was, and the process's start time, so a reused pid is never "restored". */
type Lowered = Record<number, { was: number; started: number | null }>;

interface Reservation {
  id: string;
  sessionId: string;
  project: string;
  what: string;
  kind: string;
  /** What the session asked, in dims. */
  asked: Amounts;
  /** What it was given (going), or waits for (waiting). */
  granted: Amounts;
  /** A going reservation's addition that waits in line. */
  extra: Amounts | null;
  state: 'waiting' | 'going';
  since: number;
  goAt: number | null;
  minutes: number | null;
  learnedRuns: number;
  /** The session's processes when it got its go: the job is what appears after. */
  baseline: number[];
  /** The job's processes: pid → start time (Windows) so a reused id is never taken for it. */
  pids: Record<number, number | null>;
  /** Job processes were seen in the last sample (a short-lived call alone doesn't make a job). */
  seenOnce: boolean;
  hadJob: boolean;
  commands: string[];
  peak: Amounts;
  sum: Amounts;
  samples: number;
  over: OverState;
  everOver: boolean;
  lowered: Lowered;
  /** Lowered and couldn't be raised again (macOS, Linux): stays until the job ends. */
  loweredStays: boolean;
  told: boolean;
  /** Suspended by the person from its card. */
  paused: boolean;
  forced: boolean;
  /** The turn ended: release on the next sample if no job process runs. */
  turnEnded: boolean;
  gpu: string | null;
}

interface Unreserved {
  over: OverState;
  lowered: Lowered;
  loweredStays: boolean;
  told: boolean;
  peak: Amounts;
  since: number | null;
}

interface SessionWaiter {
  sessionId: string;
  need: number;
  since: number;
  forced: boolean;
  go: () => void;
}

const now0 = () => Date.now();

function readJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A limit as the page sets it: CPU and GPU in % (1–100), memory in GB (above 0); null: none. */
export function checkLimit(dim: string, value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('The limit must be a number.');
  if (isMemory(dim)) {
    if (n <= 0 || n > 65536) throw new Error('A memory limit is a number of GB above 0.');
    return Math.round(n * GB);
  }
  if (n < 1 || n > 100) throw new Error('A CPU or GPU limit is a percentage from 1 to 100.');
  return Math.round(n);
}

/** Kinds Ledung keeps for itself in the learning store: a session can't name its job like one (security review, finding 6). */
const RESERVED_KIND = /^(session:|\()/i;

export class ResourceBook {
  private readonly ctx: BookContext;
  private readonly control: PriorityControl;
  private readonly now: () => number;
  /**
   * The limits as kept: "cpu", "ram", and a GPU's by its name ("gpu@NVIDIA …", "vram@…"), since Windows gives a GPU a
   * new id at each reboot (security review, finding 9). limitsNow() maps them to the GPUs' ids of the moment.
   */
  private limits: Amounts;
  private settings: LimitSettings;
  private readonly reservations = new Map<string, Reservation>();
  private readonly unreserved = new Map<string, Unreserved>();
  private readonly waiters = new Map<string, SessionWaiter>();
  private readonly averages = new Averages();
  /** Command kinds of long or background calls per session, for an unreserved stretch's record. */
  private readonly recent = new Map<string, { at: number; kind: string }[]>();
  /** New sessions being watched for their footprint: when they started, their peak memory. */
  private readonly footprints = new Map<string, { at: number; peak: number }>();
  /** Priorities lowered before a restart of Ledung, put back at the first sample (finding 12). */
  private pendingRestore: { pid: number; was: number; started: number | null }[];
  private waiting = new Map<string, Waiting>();
  private nextId = 1;
  private gpu: GpuReading | null = null;
  private threads = 1;
  private memTotal = 0;
  private sampled = false;
  /** Samples in a row with no GPU readings: "GPU limits off" only after several (acceptance test, finding 4). */
  private noGpu = 0;
  private lastTrees = new Map<string, ProcInfo[]>();
  private lastList: ProcessList = new Map();
  private lastHosts = new Map<string, number>();

  constructor(ctx: BookContext) {
    this.ctx = ctx;
    this.control = ctx.control ?? osPriority;
    this.now = ctx.now ?? now0;
    this.limits = readJson<Amounts>(ctx.meta.get(LIMITS_KEY), {});
    this.settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<LimitSettings>>(ctx.meta.get(SETTINGS_KEY), {}) };
    // Reservations survive a restart of Ledung, as its sessions do; their processes are found again by id and start.
    for (const r of readJson<Reservation[]>(ctx.meta.get(RESERVATIONS_KEY), [])) {
      if (!r || typeof r.id !== 'string') continue;
      this.reservations.set(r.id, { ...r, over: NOT_OVER, lowered: {}, loweredStays: false, turnEnded: false, seenOnce: r.seenOnce ?? false });
      this.nextId = Math.max(this.nextId, Number(r.id.slice(1)) + 1 || 1);
    }
    this.pendingRestore = readJson<{ pid: number; was: number; started: number | null }[]>(ctx.meta.get(LOWERED_KEY), []);
  }

  // --- Limits and settings, from the page only ------------------------------------------------------------------

  /** The limits by the dims decisions use: a GPU's under its id of the moment; one whose GPU isn't there is left out. */
  private limitsNow(): Amounts {
    const out: Amounts = {};
    for (const [key, v] of Object.entries(this.limits)) {
      if (key === 'cpu' || key === 'ram') out[key] = v;
      const m = key.match(/^(gpu|vram)@(.+)$/);
      if (!m) continue;
      const g = this.gpu?.adapters.find((a) => a.name === m[2]);
      if (g) out[`${m[1]}:${g.id}`] = v;
    }
    return out;
  }

  setLimit(dim: string, value: unknown): void {
    if (!/^(cpu|ram|gpu:[\w.:-]{1,80}|vram:[\w.:-]{1,80})$/.test(dim)) throw new Error('Unknown resource.');
    const v = checkLimit(dim, value);
    let key = dim;
    if (dim.startsWith('gpu:') || dim.startsWith('vram:')) {
      const [kind, id] = dim.split(/:(.*)/s) as [string, string];
      const g = this.gpu?.adapters.find((a) => a.id === id);
      if (!g) throw new Error('No such GPU: its readings are not there.');
      key = `${kind}@${g.name}`;
    }
    if (v === null) delete this.limits[key];
    else this.limits[key] = v;
    this.ctx.meta.set(LIMITS_KEY, JSON.stringify(this.limits));
    // A changed limit is checked at once (point 3): a raised one can let waiting work go straight away.
    this.dispatch();
    this.ctx.changed();
  }

  setSettings(body: Record<string, unknown>): LimitSettings {
    const next = { ...this.settings };
    const num = (key: keyof LimitSettings, min: number, max: number) => {
      if (body[key] === undefined) return;
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number from ${min} to ${max}.`);
      next[key] = n;
    };
    num('averageSec', 5, 600);
    num('marginPoints', 0, 100);
    num('overSec', 5, 3600);
    this.settings = next;
    this.ctx.meta.set(SETTINGS_KEY, JSON.stringify(next));
    this.ctx.changed();
    return next;
  }

  get limitSettings(): LimitSettings {
    return this.settings;
  }

  // --- Reservations ---------------------------------------------------------------------------------------------

  private gpuName(id: string): string | null {
    const main = mainGpu(this.gpu);
    if (id === main) return null;
    return this.gpu?.adapters.find((a) => a.id === id)?.name ?? null;
  }

  private label(dim: string): string {
    return dimLabel(dim, (id) => this.gpuName(id));
  }

  private amountsText(x: Amounts): string {
    return Object.entries(x).map(([d, v]) => `${formatDim(d, v)} ${this.label(d)}`).join(', ');
  }

  /** GPUs a session can name: those with readings, by name. */
  private pickGpu(device: string | undefined): string | null {
    const adapters = this.gpu?.adapters ?? [];
    if (!adapters.length) return null;
    if (!device) return mainGpu(this.gpu);
    const want = device.trim().toLowerCase();
    const hit = adapters.find((a) => a.name.toLowerCase() === want) ?? adapters.find((a) => a.name.toLowerCase().includes(want));
    if (!hit) throw new Error(`No GPU named "${device}". This PC's GPUs: ${adapters.map((a) => a.name).join(', ')}.`);
    return hit.id;
  }

  /** The `reserve` tool: go, or wait with a place in line. A session can only reserve for itself. */
  reserve(sessionId: string, a: ReserveArgs): string {
    const s = this.ctx.session(sessionId);
    if (!s) throw new Error('No such session.');
    if (!s.local) throw new Error('Reservations are for sessions on this computer; container projects are not measured or limited.');
    const what = String(a.what ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!what) throw new Error('Give what: a short name for this kind of job.');
    if (RESERVED_KIND.test(what)) throw new Error('Give what a plain name, not one starting with "session:" or "(".');
    const nums: [keyof ReserveArgs, number][] = [];
    for (const key of ['cpu', 'ram_gb', 'gpu', 'vram_gb'] as const) {
      const v = a[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${key} must be a number, 0 or more.`);
      if ((key === 'cpu' || key === 'gpu') && v > 100) throw new Error(`${key} is a percentage of the whole PC or GPU, at most 100.`);
      if (v > 0) nums.push([key, v]);
    }
    if (!nums.length) throw new Error('Nothing to reserve: give at least one of cpu, ram_gb, gpu, vram_gb.');
    const wantsGpu = nums.some(([k]) => k === 'gpu' || k === 'vram_gb');
    const gpu = wantsGpu ? this.pickGpu(a.gpu_device) : null;
    const notes: string[] = [];
    const asked: Amounts = {};
    for (const [key, v] of nums) {
      if (key === 'cpu') asked.cpu = v;
      else if (key === 'ram_gb') {
        // No more than this PC has (security review, finding 2): a request that can never be met is refused.
        if (this.memTotal > 0 && v * GB > this.memTotal) throw new Error(`ram_gb is more than this PC's ${formatDim('ram', this.memTotal)} of memory.`);
        asked.ram = v * GB;
      } else if (!gpu) continue;
      else if (key === 'gpu') asked[`gpu:${gpu}`] = v;
      else {
        const total = this.gpu?.adapters.find((g) => g.id === gpu)?.vramTotal ?? null;
        if (total !== null && v * GB > total) throw new Error(`vram_gb is more than this GPU's ${formatDim('vram:x', total)} of memory.`);
        asked[`vram:${gpu}`] = v * GB;
      }
    }
    if (wantsGpu && !gpu) notes.push(`GPU limits are off on this PC (${this.gpu?.problem ?? 'no GPU readings'}), so only CPU and memory are reserved.`);
    if (!Object.keys(asked).length) return `Nothing reserved. ${notes.join(' ')}`.trim();
    const kind = normaliseKind(what);
    // What this kind really used, once known, instead of the guess (point 8, open choice 8).
    let need = asked;
    let learnedRuns = 0;
    const learned = this.ctx.jobs.learned(s.project, kind);
    if (learned) {
      const figure = fromGeneric(learned.need, gpu ?? mainGpu(this.gpu));
      const out: Amounts = {};
      for (const [dim, v] of Object.entries(figure)) if (v > 0) out[dim] = v + marginOf(dim, v, this.settings);
      // A resource the session asked for that no run measured (no readings then) keeps the guess.
      for (const [dim, v] of Object.entries(asked)) if (out[dim] === undefined && !(dim in figure)) out[dim] = v;
      if (Object.keys(out).length) {
        need = out;
        learnedRuns = learned.runs;
      }
    }
    const minutes = typeof a.minutes === 'number' && Number.isFinite(a.minutes) && a.minutes > 0 ? a.minutes : null;
    const own = [...this.reservations.values()].filter((r) => r.sessionId === sessionId);
    const going = own.find((r) => r.state === 'going');
    const waiting = own.find((r) => r.state === 'waiting');
    let r: Reservation;
    if (going) {
      // Adds to a going one: the extra is judged as a start; the job keeps its name (finding 16).
      r = going;
      r.extra = addAmounts(r.extra ?? {}, need);
      r.since = this.now();
      r.asked = addAmounts(r.asked, asked);
    } else {
      if (waiting) this.reservations.delete(waiting.id);
      r = {
        id: `r${this.nextId++}`, sessionId, project: s.project, what, kind, asked, granted: need, extra: null, state: 'waiting',
        since: waiting?.since ?? this.now(), goAt: null, minutes, learnedRuns, baseline: [], pids: {}, seenOnce: false, hadJob: false, commands: [],
        peak: {}, sum: {}, samples: 0, over: NOT_OVER, everOver: false, lowered: {}, loweredStays: false, told: false, paused: false, forced: false,
        turnEnded: false, gpu,
      };
      this.reservations.set(r.id, r);
    }
    this.dispatch(r.id);
    this.persist();
    this.ctx.changed();
    const learnedNote = learnedRuns ? ` (learned from ${learnedRuns} runs; you asked ${this.amountsText(asked)})` : '';
    const tail = notes.length ? ` ${notes.join(' ')}` : '';
    if (r.state === 'going' && !r.extra) {
      return `Go: reservation ${r.id} "${r.what}", ${this.amountsText(r.granted)}${learnedNote}. It is released when you call release, when the job's processes end, or at the end of your turn if none run.${tail}`;
    }
    const place = this.placeOf(r.id);
    return `Wait: ${this.reasonOf(r.id, false)}${place ? ` (${ordinal(place)} in line)` : ''}${learnedNote}. Don't start it yet: do other work, and Ledung will tell you when you may go.${tail}`;
  }

  /** The `release` tool, and every other end of a reservation. */
  release(sessionId: string): string {
    const own = [...this.reservations.values()].filter((r) => r.sessionId === sessionId);
    if (!own.length) return 'You have no reservation.';
    for (const r of own) this.end(r);
    this.dispatch();
    this.ctx.changed();
    return `Released ${own.map((r) => `${r.id} "${r.what}"`).join(', ')}.`;
  }

  /** Simon's Start now on an entry in the line: it goes above the limits. */
  startNow(entry: string): void {
    const r = this.reservations.get(entry);
    if (r && (r.state === 'waiting' || r.extra)) {
      r.forced = true;
      this.dispatch();
      this.ctx.changed();
      return;
    }
    const w = this.waiters.get(entry);
    if (w) {
      w.forced = true;
      this.dispatch();
      this.ctx.changed();
      return;
    }
    throw new Error('Nothing of that name waits in the line.');
  }

  /** A turn ended: going reservations with no job process left are released on the next sample (open choice 2). */
  turnEnded(sessionId: string): void {
    for (const r of this.reservations.values()) if (r.sessionId === sessionId && r.state === 'going') r.turnEnded = true;
  }

  /**
   * The command kinds of a call that ran long or in the background (session.ts): only those can be the heavy work,
   * so `git status` between two builds never becomes "heavy" (security review, finding 7).
   */
  noteCommands(sessionId: string, kinds: string[]): void {
    if (!kinds.length) return;
    const at = this.now();
    const list = (this.recent.get(sessionId) ?? []).filter((c) => c.at > at - 15 * 60_000);
    for (const kind of kinds) list.push({ at, kind });
    this.recent.set(sessionId, list.slice(-100));
    for (const r of this.reservations.values()) {
      if (r.sessionId === sessionId && r.state === 'going') for (const k of kinds) if (!r.commands.includes(k) && r.commands.length < 40) r.commands.push(k);
    }
  }

  /**
   * The PreToolUse check (Recognising heavy commands): a known heavy command with no reservation going is refused
   * with the reason; so is one while the session is held for a job over its share (open choice 1). Null: go on.
   * Managers have no reserve tool, so they are never asked to use one (finding 4). It is advisory: a command can be
   * wrapped past it; the check of what really runs is the boundary.
   */
  commandRefusal(sessionId: string, kinds: string[]): string | null {
    const s = this.ctx.session(sessionId);
    if (!s?.local || s.role === 'manager' || !kinds.length) return null;
    const heavy = this.ctx.jobs.heavyCommands(s.project).filter((h) => !h.never && kinds.includes(h.command));
    if (!heavy.length) return null;
    const h = heavy[0]!;
    // The command quoted is this session's own (the match is exact); the figures are numbers. No other session's
    // words reach it (acceptance test, finding 15).
    const own = kinds.find((k) => k === h.command)!;
    const gpu = mainGpu(this.gpu);
    const typical = Object.entries(fromGeneric(h.peak, gpu)).filter(([, v]) => v > 0).map(([d, v]) => `~${formatDim(d, v)} ${this.label(d)}`).join(' and ');
    if (this.isHeld(sessionId)) {
      return `Not now: a job of yours is over its share and your session is held, so Ledung refuses new heavy work. "${own}" usually uses ${typical}. Reduce or stop the running job first.`;
    }
    const going = [...this.reservations.values()].some((r) => r.sessionId === sessionId && r.state === 'going');
    if (going) return null;
    return `This usually uses ${typical} ("${own}", seen ${h.runs} times). Call reserve first, then run it once Ledung says go.`;
  }

  /** Held: a job of this session is over its share. No new turns from others, no new reservation, no known heavy command. */
  isHeld(sessionId: string): boolean {
    if (this.unreserved.get(sessionId)?.over.over) return true;
    for (const r of this.reservations.values()) if (r.sessionId === sessionId && r.over.over) return true;
    return false;
  }

  // --- New sessions under a memory limit (point 9) -----------------------------------------------------------------

  /** What a new session of this kind counts as: ~1 GB at first, then what its kind was measured at. */
  sessionNeed(project: string, role: SessionRole): number {
    return this.ctx.jobs.footprint(project, role) ?? SESSION_FIRST_GUESS;
  }

  /**
   * A new session starts now (`go` called at once and true returned) or waits in the line for memory (false; `go`
   * runs when there is room). Only under a memory limit; managers and container sessions don't wait.
   */
  admitSession(sessionId: string, go: () => void): boolean {
    const s = this.ctx.session(sessionId);
    // Its footprint is measured from when it really starts, not from when it began to wait (finding 14).
    const start = () => {
      this.footprints.set(sessionId, { at: this.now(), peak: 0 });
      go();
    };
    if (!s || !s.local || s.role === 'manager' || this.limits.ram === undefined) {
      start();
      return true;
    }
    this.waiters.set(sessionId, { sessionId, need: this.sessionNeed(s.project, s.role), since: this.now(), forced: false, go: start });
    this.dispatch();
    if (!this.waiters.has(sessionId)) return true;
    this.ctx.changed();
    return false;
  }

  /** A waiting new session was stopped before it started. */
  dropWaiter(sessionId: string): boolean {
    if (!this.waiters.delete(sessionId)) return false;
    this.dispatch();
    this.ctx.changed();
    return true;
  }

  isWaitingToStart(sessionId: string): boolean {
    return this.waiters.has(sessionId);
  }

  // --- The line ---------------------------------------------------------------------------------------------------

  private pcTotals(): Amounts {
    return this.averages.all('pc', this.now(), this.settings.averageSec);
  }

  private usingOf(r: Reservation): Amounts {
    return this.averages.all(`r:${r.id}`, this.now(), this.settings.averageSec);
  }

  /** What going jobs hold but don't use yet. */
  private unused(): Amounts {
    let out: Amounts = {};
    for (const r of this.reservations.values()) if (r.state === 'going') out = addAmounts(out, unusedOf(r.granted, this.usingOf(r)));
    return out;
  }

  private lineItems(): LineItem[] {
    const items: LineItem[] = [];
    for (const r of this.reservations.values()) {
      const s = this.ctx.session(r.sessionId);
      const priority = s?.priority ?? 'normal';
      if (r.state === 'waiting') items.push({ id: r.id, priority, since: r.since, need: r.granted, forced: r.forced, held: this.isHeld(r.sessionId), unmeasured: !this.lastTrees.has(r.sessionId) });
      else if (r.extra) items.push({ id: r.id, priority, since: r.since, need: r.extra, forced: r.forced, held: this.isHeld(r.sessionId) });
    }
    for (const w of this.waiters.values()) {
      items.push({ id: w.sessionId, priority: this.ctx.session(w.sessionId)?.priority ?? 'normal', since: w.since, need: { ram: w.need }, forced: w.forced });
    }
    return items;
  }

  /** Lets go whoever fits now, in order; `quiet` is the reservation whose session hears it in the tool's answer. */
  private dispatch(quiet?: string): void {
    const pass = grantPass(this.lineItems(), this.pcTotals(), this.unused(), this.limitsNow());
    this.waiting = pass.waiting;
    for (const id of pass.granted) {
      const r = this.reservations.get(id);
      if (r) {
        const forced = r.forced;
        r.forced = false;
        if (r.state === 'waiting') {
          r.state = 'going';
          r.goAt = this.now();
          r.baseline = [...(this.lastTrees.get(r.sessionId) ?? []).map((p) => p.pid)];
        } else if (r.extra) {
          r.granted = addAmounts(r.granted, r.extra);
          r.extra = null;
        }
        if (id !== quiet) {
          this.ctx.tell(r.sessionId, `You may go: reservation ${r.id} "${r.what}" (${this.amountsText(r.granted)})${forced ? ', started by the person above the limits' : ''}. Start the job now; it is released when its processes end, when you call release, or if no new process starts within 10 minutes.`);
        }
        continue;
      }
      const w = this.waiters.get(id);
      if (w) {
        this.waiters.delete(id);
        try {
          w.go();
        } catch (e) {
          console.error(`Starting session ${id}: ${(e as Error).message}`);
        }
      }
    }
    if (pass.granted.length) this.persist();
  }

  private placeOf(id: string): number {
    const order = [...this.waiting.keys()];
    const i = order.indexOf(id);
    return i < 0 ? 0 : i + 1;
  }

  /**
   * Why an entry waits. For the page (`named`), who it waits behind by name; for sessions and managers never another
   * session's job name or title, which would carry one session's words to another (security review, finding 5).
   */
  private reasonOf(id: string, named: boolean): string {
    const w = this.waiting.get(id);
    const r = this.reservations.get(id);
    const need = r ? r.extra ?? r.granted : { ram: this.waiters.get(id)?.need ?? 0 };
    if (!w) return 'Waiting';
    if (w.kind === 'held') return 'Held: a job of this session is over its share';
    if (w.kind === 'unmeasured') return "Waiting for its session's processes to be measured (a few seconds)";
    if (w.kind === 'behind') {
      const other = this.reservations.get(w.behind);
      const who = !named ? (other ? 'another job' : 'a new session')
        : other ? `"${other.what}"` : `"${this.ctx.session(w.behind)?.title ?? 'a new session'}"`;
      return `Waiting behind ${who} for ${this.label(w.dims[0]!)} room`;
    }
    const limits = this.limitsNow();
    const dim = w.dims[0]!;
    const reason = roomReason(dim, need[dim] ?? 0, this.pcTotals()[dim] ?? 0, this.unused()[dim] ?? 0, limits[dim] ?? 0, this.label(dim));
    return `${reason}${(need[dim] ?? 0) > (limits[dim] ?? 0) ? ': only a higher limit lets it start' : ''}`;
  }

  // --- Each sample --------------------------------------------------------------------------------------------------

  sample(x: BookSample): void {
    const at = x.at;
    this.threads = Math.max(1, x.threads);
    this.memTotal = x.memTotal;
    this.gpu = x.gpu;
    this.noGpu = x.gpu?.adapters.length ? 0 : this.noGpu + 1;
    this.lastTrees = x.trees;
    this.lastList = x.list;
    this.lastHosts = x.hosts;
    this.restorePending();
    this.sampled = true;
    // The PC's totals.
    this.averages.add('pc|cpu', at, (x.cores / this.threads) * 100);
    this.averages.add('pc|ram', at, x.memUsed);
    for (const g of x.gpu?.adapters ?? []) {
      this.averages.add(`pc|gpu:${g.id}`, at, g.load);
      if (g.vramUsed !== null) this.averages.add(`pc|vram:${g.id}`, at, g.vramUsed);
    }
    const cpuOf = (pids: Iterable<number>) => {
      if (!x.prev || x.dt <= 0) return 0;
      let used = 0;
      for (const pid of pids) {
        const p = x.list.get(pid);
        // A process new since the last list used all its CPU time since then, as in the monitor's treeSample.
        if (p) used += Math.max(0, p.cpuSeconds - (x.prev.get(pid)?.cpuSeconds ?? 0));
      }
      return Math.min(100, (used / x.dt / this.threads) * 100);
    };
    const memOf = (pids: Iterable<number>) => {
      let n = 0;
      for (const pid of pids) n += x.list.get(pid)?.memBytes ?? 0;
      return n;
    };
    const usage = (pids: number[]): Amounts => {
      const out: Amounts = { cpu: cpuOf(pids), ram: memOf(pids) };
      for (const g of x.gpu?.adapters ?? []) {
        out[`gpu:${g.id}`] = groupLoad(x.gpu, pids, g.id);
        out[`vram:${g.id}`] = groupMem(x.gpu, pids, g.id);
      }
      return out;
    };
    // What a session started: below Claude Code itself (not the host, nor Claude Code, its child), and not the
    // console host Windows gives Claude Code at its first shell call, which lives as long as it does and would keep
    // a job "running" forever (try-out of 2026-11-12).
    const workOf = (sessionId: string): ProcInfo[] => {
      const host = x.hosts.get(sessionId);
      const tree = x.trees.get(sessionId) ?? [];
      // Only Claude Code's own: one named so further down is a program the session started, and counts.
      const claude = new Set(tree.filter((p) => p.ppid === host).map((p) => p.pid));
      return tree.filter((p) => p.pid !== host && p.ppid !== host && !(claude.has(p.ppid) && p.name && /^conhost\.exe$/i.test(p.name)));
    };
    // What Ledung may act on: only processes reached from the host through live parents now. A process taken in by
    // #169's rule for counting (its parent gone) may be someone else's that got a reused id (finding 5).
    const actable = (sessionId: string): Set<number> => {
      const host = x.hosts.get(sessionId);
      return new Set(host ? treeOf(x.list, host).map((p) => p.pid).filter((pid) => pid !== host) : []);
    };
    let changed = false;
    const jobPidsOf = new Map<string, Set<number>>();
    for (const r of [...this.reservations.values()]) {
      if (!this.ctx.session(r.sessionId)) {
        this.end(r);
        changed = true;
        continue;
      }
      // No tree this round (its host not found yet): judged on the next one, never ended for it.
      if (r.state !== 'going' || !x.trees.has(r.sessionId)) continue;
      // Its processes: new since the go, still the same process (the start time, where Windows gives one).
      const base = new Set(r.baseline);
      const pids: Record<number, number | null> = {};
      for (const p of workOf(r.sessionId)) {
        const was = r.pids[p.pid];
        if (base.has(p.pid) && was === undefined) continue;
        if (was !== undefined && was !== null && p.started !== undefined && p.started !== was) continue;
        pids[p.pid] = p.started ?? null;
      }
      r.pids = pids;
      const list = Object.keys(pids).map(Number);
      const mine = jobPidsOf.get(r.sessionId) ?? new Set<number>();
      for (const pid of list) mine.add(pid);
      jobPidsOf.set(r.sessionId, mine);
      // A job is processes seen in two samples running: a short call caught once (a git command) isn't one (finding 16).
      if (list.length && r.seenOnce) r.hadJob = true;
      r.seenOnce = list.length > 0;
      if (r.hadJob && !list.length) {
        this.end(r);
        changed = true;
        continue;
      }
      if (r.turnEnded) {
        r.turnEnded = false;
        // Not if a new turn has begun since: its job may be about to start (finding 16).
        if (!list.length && !this.ctx.session(r.sessionId)?.busy) {
          this.end(r);
          changed = true;
          continue;
        }
      }
      if (!r.hadJob && r.goAt !== null && at - r.goAt > LAPSE_MS) {
        this.end(r);
        this.ctx.tell(r.sessionId, `Reservation ${r.id} "${r.what}" lapsed: no new process started within 10 minutes of the go. Reserve again when you are ready.`);
        changed = true;
        continue;
      }
      const u = usage(list);
      for (const [dim, v] of Object.entries(u)) this.averages.add(`r:${r.id}|${dim}`, at, v);
      const avg = this.usingOf(r);
      r.samples++;
      for (const [dim, v] of Object.entries(avg)) {
        r.peak[dim] = Math.max(r.peak[dim] ?? 0, v);
        r.sum[dim] = (r.sum[dim] ?? 0) + v;
      }
      // A job the person suspended isn't judged; it isn't using anything anyway.
      if (r.paused) continue;
      const step = overStep(r.over, avg, r.granted, this.settings, at);
      r.over = step.state;
      if (r.over.over) {
        r.everOver = true;
        const ok = actable(r.sessionId);
        this.lowerAll(r, list.filter((pid) => ok.has(pid)));
      }
      if (step.change === 'over') {
        r.told = true;
        const dims = r.over.dims.map((d) => `reserved ${formatDim(d, r.granted[d] ?? 0)} ${this.label(d)} and has averaged ${formatDim(d, avg[d] ?? 0)}`).join('; ');
        this.ctx.tell(r.sessionId, `Your job "${r.what}" (reservation ${r.id}) ${dims} for over ${Math.round(this.settings.overSec)} s: over its share. Ledung has lowered its processes' priority and holds your session (no new turns from others, no new reservation, no known heavy command) until it is back within its share. Reduce it (fewer workers, a smaller batch) or stop it cleanly. Nothing is killed.`);
        changed = true;
      } else if (step.change === 'back') {
        this.restoreAll(r, r.sessionId);
        if (r.told) this.ctx.tell(r.sessionId, `Your job "${r.what}" is back within its share: its priority and your session are back to normal.`);
        r.told = false;
        this.ctx.wake(r.sessionId);
        changed = true;
      }
    }
    // Work with no reservation (point 7): everything the session runs that isn't a reserved job, Claude Code included,
    // against its usual footprint plus the allowance, so its own MCP servers never count as heavy work (finding 3), and
    // a heavy process started before a small reservation is still judged (finding 1). Managers have no reserve tool.
    for (const [sessionId, tree] of x.trees) {
      const s = this.ctx.session(sessionId);
      if (!s?.local || s.role === 'manager') continue;
      const u0 = this.unreserved.get(sessionId) ?? { over: NOT_OVER, lowered: {}, loweredStays: false, told: false, peak: {}, since: null };
      const jobs = jobPidsOf.get(sessionId) ?? new Set<number>();
      const host = x.hosts.get(sessionId);
      const counted = tree.filter((p) => p.pid !== host && !jobs.has(p.pid)).map((p) => p.pid);
      for (const [dim, v] of Object.entries(usage(counted))) this.averages.add(`s:${sessionId}|${dim}`, at, v);
      const avg = this.averages.all(`s:${sessionId}`, at, this.settings.averageSec);
      const share: Amounts = { ram: this.sessionNeed(s.project, s.role) + ALLOWANCE.bytes };
      const step = overStep(u0.over, avg, share, this.settings, at);
      u0.over = step.state;
      if (u0.over.since !== null) {
        u0.since ??= u0.over.since;
        for (const [dim, v] of Object.entries(avg)) u0.peak[dim] = Math.max(u0.peak[dim] ?? 0, v);
      }
      if (u0.over.over) {
        const ok = actable(sessionId);
        this.lowerAll(u0, workOf(sessionId).map((p) => p.pid).filter((pid) => ok.has(pid) && !jobs.has(pid)));
      }
      if (step.change === 'over') {
        u0.told = true;
        const dims = u0.over.dims.map((d) => `${formatDim(d, avg[d] ?? 0)} ${this.label(d)}`).join(' and ');
        this.ctx.tell(sessionId, `Heavy work without a reservation: what your session runs has averaged ${dims} for over ${Math.round(this.settings.overSec)} s. Ledung has lowered its priority and holds your session (no new turns from others, no new reservation, no known heavy command) until it is back within the small allowance for unreserved work. Reduce it or stop it cleanly, and call reserve before heavy work next time. Nothing is killed.`);
        changed = true;
      } else if (step.change === 'back') {
        this.endUnreserved(sessionId, u0);
        changed = true;
      } else if (!u0.over.over && u0.over.since === null) {
        u0.peak = {};
        u0.since = null;
      }
      this.unreserved.set(sessionId, u0);
    }
    for (const id of [...this.unreserved.keys()]) if (!x.trees.has(id)) {
      const u = this.unreserved.get(id)!;
      if (u.over.over) this.endUnreserved(id, u);
      this.unreserved.delete(id);
      this.averages.drop(`s:${id}`);
    }
    // New sessions' first minutes: their memory, for the next one of their kind.
    for (const [sessionId, f] of [...this.footprints]) {
      const tree = x.trees.get(sessionId);
      const s = this.ctx.session(sessionId);
      if (!s) {
        this.footprints.delete(sessionId);
        continue;
      }
      if (tree) {
        const jobs = jobPidsOf.get(sessionId) ?? new Set<number>();
        f.peak = Math.max(f.peak, tree.filter((p) => !jobs.has(p.pid)).reduce((n, p) => n + p.memBytes, 0));
      }
      if (at - f.at >= FOOTPRINT_MS) {
        this.footprints.delete(sessionId);
        // Not while it was over its allowance: heavy work isn't its footprint.
        if (f.peak > 0 && s.local && !this.unreserved.get(sessionId)?.over.since) {
          this.ctx.jobs.add({ project: s.project, kind: `session:${s.role}`, commands: [], asked: {}, peak: { ram: f.peak }, mean: { ram: f.peak }, durationMs: at - f.at, over: false, undeclared: false, endedAt: at });
        }
      }
    }
    for (const id of [...this.waiters.keys()]) if (!this.ctx.session(id)) this.waiters.delete(id);
    this.dispatch();
    if (changed) this.persist();
  }

  private lowerAll(subject: { lowered: Lowered }, pids: number[]): void {
    let added = false;
    for (const pid of pids) {
      if (pid in subject.lowered) continue;
      const was = lower(pid, this.control);
      if (was !== null) {
        subject.lowered[pid] = { was, started: this.lastList.get(pid)?.started ?? null };
        added = true;
      }
    }
    if (added) this.persistLowered();
  }

  /** Still the process Ledung lowered: in the latest list with the same start time, and still one of the session's. */
  private sameProcess(pid: number, started: number | null, sessionId: string | null): boolean {
    const now = this.lastList.get(pid);
    if (!now) return false;
    if (started !== null && now.started !== undefined && now.started !== started) return false;
    if (sessionId === null) return true;
    return (this.lastTrees.get(sessionId) ?? []).some((p) => p.pid === pid);
  }

  private restoreAll(subject: { lowered: Lowered; loweredStays: boolean }, sessionId: string): void {
    let stays = false;
    const tree = new Set((this.lastTrees.get(sessionId) ?? []).map((p) => p.pid));
    for (const [pid, l] of Object.entries(subject.lowered)) {
      const n = Number(pid);
      if (tree.has(n) && this.sameProcess(n, l.started, sessionId)) {
        if (restore(n, l.was, this.control) === 'refused') stays = true;
      } else if (l.started !== null) {
        // It left the session's tree, or the session ended: put back by its start time alone at the next sample
        // (acceptance test, finding 9). Without a start time (macOS, Linux) it can't be told from a reused pid, so
        // it is left lowered rather than risk raising someone else's (finding 11).
        this.pendingRestore.push({ pid: n, was: l.was, started: l.started });
      }
    }
    subject.lowered = {};
    subject.loweredStays = stays;
    this.persistLowered();
  }

  /**
   * Priorities to put back by start time alone: lowered before a restart of Ledung, or of processes that have left
   * their session. Each is settled at the next sample: put back if it is still the same process and still at
   * Ledung's level, else forgotten. One with no start time is never put back (finding 11).
   */
  private restorePending(): void {
    if (!this.pendingRestore.length) return;
    for (const l of this.pendingRestore) {
      const now = this.lastList.get(l.pid);
      if (!now || l.started === null || now.started === undefined || now.started !== l.started) continue;
      restore(l.pid, l.was, this.control);
    }
    this.pendingRestore = [];
    this.persistLowered();
  }

  private persistLowered(): void {
    const all: { pid: number; was: number; started: number | null }[] = [...this.pendingRestore];
    for (const s of [...this.reservations.values(), ...this.unreserved.values()]) {
      for (const [pid, l] of Object.entries(s.lowered)) all.push({ pid: Number(pid), was: l.was, started: l.started });
    }
    this.ctx.meta.set(LOWERED_KEY, JSON.stringify(all));
  }

  private endUnreserved(sessionId: string, u: Unreserved): void {
    this.restoreAll(u, sessionId);
    if (u.told) this.ctx.tell(sessionId, 'Your work is back within the allowance for unreserved work: its priority and your session are back to normal.');
    u.told = false;
    const s = this.ctx.session(sessionId);
    const at = this.now();
    if (s && Object.keys(u.peak).length) {
      const since = u.since ?? at;
      const gpu = mainGpu(this.gpu);
      const commands = [...new Set((this.recent.get(sessionId) ?? []).filter((c) => c.at >= since - 5 * 60_000).map((c) => c.kind))];
      this.ctx.jobs.add({ project: s.project, kind: '(unreserved)', commands, asked: {}, peak: toGeneric(u.peak, gpu), mean: toGeneric(u.peak, gpu), durationMs: at - since, over: true, undeclared: true, endedAt: at });
    }
    u.peak = {};
    u.since = null;
    u.over = NOT_OVER;
    // Whatever waited behind the hold goes now (finding 12).
    this.ctx.wake(sessionId);
  }

  /** A reservation ends: restore what was lowered, resume what the person paused, and remember what the job used. */
  private end(r: Reservation): void {
    this.reservations.delete(r.id);
    this.restoreAll(r, r.sessionId);
    this.averages.drop(`r:${r.id}`);
    // Never left frozen with no card to resume it from (security review, finding 10).
    if (r.paused) this.ctx.resume?.(Object.entries(r.pids).map(([pid, started]) => ({ pid: Number(pid), started })));
    if (r.over.over) this.ctx.wake(r.sessionId);
    if (r.state === 'going' && r.hadJob && r.samples > 0) {
      const gpu = r.gpu ?? mainGpu(this.gpu);
      const mean: Amounts = {};
      for (const [d, v] of Object.entries(r.sum)) mean[d] = v / r.samples;
      try {
        this.ctx.jobs.add({
          project: r.project, kind: r.kind, commands: r.commands, asked: toGeneric(r.asked, gpu), peak: toGeneric(r.peak, gpu), mean: toGeneric(mean, gpu),
          durationMs: this.now() - (r.goAt ?? this.now()), over: r.everOver, undeclared: false, endedAt: this.now(),
        });
      } catch (e) {
        console.error(`Recording job ${r.id}: ${(e as Error).message}`);
      }
    }
    this.persist();
  }

  private persist(): void {
    const keep = [...this.reservations.values()].map((r) => ({ ...r, over: undefined, lowered: undefined, turnEnded: undefined }));
    this.ctx.meta.set(RESERVATIONS_KEY, JSON.stringify(keep));
  }

  // --- The person's actions on a job's card --------------------------------------------------------------------------

  /** The job's processes now, with their start times, and its session's host, for the person's Pause, Resume and Stop. */
  jobTargets(id: string): { sessionId: string; host: number | null; paused: boolean; targets: Target[] } {
    const r = this.reservations.get(id);
    if (!r || r.state !== 'going') throw new Error('No such job.');
    return { sessionId: r.sessionId, host: this.lastHosts.get(r.sessionId) ?? null, paused: r.paused, targets: Object.entries(r.pids).map(([pid, started]) => ({ pid: Number(pid), started })) };
  }

  setJobPaused(id: string, paused: boolean): void {
    const r = this.reservations.get(id);
    if (!r) throw new Error('No such job.');
    r.paused = paused;
    if (paused && r.over.over) {
      // A paused job isn't over anything: its priority goes back and its session is free.
      this.restoreAll(r, r.sessionId);
      r.over = NOT_OVER;
      this.ctx.wake(r.sessionId);
    }
    this.persist();
    this.ctx.changed();
  }

  // --- What the page shows ------------------------------------------------------------------------------------------

  info(): ResourcesInfo {
    const now = this.now();
    const main = mainGpu(this.gpu);
    const line: ResourceLineInfo[] = [];
    let place = 0;
    for (const id of this.waiting.keys()) {
      place++;
      const r = this.reservations.get(id);
      const w = this.waiters.get(id);
      const common = { reason: this.reasonOf(id, true), reasonForSessions: this.reasonOf(id, false), place };
      if (r) line.push({ id, sessionId: r.sessionId, what: r.what, kind: 'job', need: r.extra ?? r.granted, since: r.since, ...common });
      else if (w) line.push({ id, sessionId: id, what: 'New session', kind: 'session', need: { ram: w.need }, since: w.since, ...common });
    }
    const jobs: ResourceJobInfo[] = [];
    for (const r of this.reservations.values()) {
      if (r.state !== 'going') continue;
      jobs.push({
        id: r.id, sessionId: r.sessionId, what: r.what, granted: r.granted, using: this.usingOf(r), learnedRuns: r.learnedRuns,
        state: r.paused ? 'paused' : r.over.over ? 'over' : 'going', overSince: r.over.over ? r.over.since : null, overDims: r.over.dims,
        lowered: Object.keys(r.lowered).length > 0, loweredStays: r.loweredStays, processes: Object.keys(r.pids).length, goAt: r.goAt ?? now, minutes: r.minutes,
        waitingExtra: r.extra,
      });
    }
    const unreserved = [...this.unreserved.entries()].filter(([, u]) => u.over.over).map(([sessionId, u]) => ({
      sessionId, using: this.averages.all(`s:${sessionId}`, now, this.settings.averageSec), overSince: u.over.since, overDims: u.over.dims,
      lowered: Object.keys(u.lowered).length > 0,
    }));
    return {
      limits: this.limitsNow(),
      settings: { ...this.settings },
      threads: this.threads,
      memTotal: this.memTotal,
      average: this.pcTotals(),
      reserved: this.unused(),
      gpus: (this.gpu?.adapters ?? []).map((g) => ({ id: g.id, name: g.name, vramTotal: g.vramTotal, load: g.load, vramUsed: g.vramUsed, main: g.id === main })),
      gpuNote: this.noGpu < NO_GPU_SAMPLES ? null : `GPU limits off: ${this.gpu?.problem ?? 'no GPU readings on this PC'}.`,
      line,
      jobs,
      unreserved,
    };
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
