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
  addAmounts, ALLOWANCE, Averages, DEFAULT_SETTINGS, dimLabel, formatDim, GB, grantPass, isMemory, marginOf, NOT_OVER, notFitting, overStep, roomReason, unusedOf,
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
  /** Background subagents and commands under way (Claude Code's non-ambient background tasks); 0 if not known. */
  background?: number;
  /** Its manager, if any: a manager is told when its session has waited long, and sees its own sessions' jobs by name. */
  parentId?: string | null;
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
  /**
   * A notice from Ledung for this session is still waiting to be delivered (round 2, "Waking"): the go's 10 minutes
   * count from when it reached the session. Absent: delivered at once.
   */
  undelivered?(id: string): boolean;
  /** A notice for a manager about one of its sessions (round 2: a long wait, then the go). */
  tellManager?(managerId: string, text: string): void;
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
  /** A ready or busy pass's addition that waits in line. */
  extra: Amounts | null;
  /**
   * The pass (docs/steps/resource-limits-2.md, "The pass and its states"): waiting in line; ready (the go, holding all
   * of it until the work starts); busy (holding booked minus used); parked (quiet: keeps its place with the session,
   * holds no room). One per session, shared by its subagents.
   */
  state: PassState;
  /** In line since; a parked pass sent back to the line keeps it, so it is first among equals. */
  since: number;
  goAt: number | null;
  /** When the go reached the session (the turn carrying it began): the ready 10 minutes count from here. */
  deliveredAt: number | null;
  minutes: number | null;
  learnedRuns: number;
  /** The session's processes when it got its first go: the job is what appears after. */
  baseline: number[];
  /** The job's processes: pid → start time (Windows) so a reused id is never taken for it. */
  pids: Record<number, number | null>;
  /** Processes of the pass were seen in the last sample. */
  seenOnce: boolean;
  /** Its work was active in the last sample. */
  wasActive: boolean;
  /** It has been busy: what it used is recorded when it ends. */
  hadJob: boolean;
  /** Since when its work has been quiet while busy; null: it isn't. */
  quietSince: number | null;
  /** Its memory at the last active sample: memory growing past this is work. */
  refMem: number;
  parkedAt: number | null;
  /** Its work resumed while parked and didn't fit under the limits (a command Ledung couldn't know was heavy). */
  resumedAbove: boolean;
  /** Its manager was told it has waited long (it is told again at the go). */
  managerTold: boolean;
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
  gpu: string | null;
}

export type PassState = 'waiting' | 'ready' | 'busy' | 'parked';

/** A pass holds room only when ready or busy; parked and waiting hold none (round 2). */
const holdsRoom = (r: { state: PassState }) => r.state === 'ready' || r.state === 'busy';
/** Memory growing by more than this between active samples is work (with CPU or GPU above the allowance). */
const GROW_BYTES = 256 * 1024 ** 2;
/** How soon after a call that detaches a parentless process is taken as its (`python train.py &`, `nohup`). */
const DETACH_WINDOW_MS = 15_000;
/** WSL's virtual machine in the Windows process list (round 2, problem 5); "vmmem" on older WSL. */
const WSL_PROCESS = /^vmmem(wsl)?(\.exe)?$/i;

/** Who looks at a reason: the page sees names; a session or manager sees only its own (security review, finding 5). */
type Viewer = { kind: 'page' } | { kind: 'session'; id: string } | { kind: 'manager'; id: string };

interface Unreserved {
  over: OverState;
  lowered: Lowered;
  loweredStays: boolean;
  told: boolean;
  peak: Amounts;
  since: number | null;
  /** Kinds of the calls whose own processes were busy while it was above the allowance (R4). */
  commands: string[];
}

/** A shell call under way (R4): its kinds, when it began, whether it runs in the background, when it ended. */
interface Call {
  kinds: string[];
  at: number;
  background: boolean;
  /** It leaves its work running and returns (`cmd &`, `nohup`, `start`): what it started may lose its parent at once. */
  detached: boolean;
  /** The call's command, for a detached one: what Pause and Stop compare a timing-only claim with (re-review of PR #476). */
  command: string;
  ended: number | null;
}

/**
 * A detached process taken as a session's: its start time; `seen`: its parent (or itself) was seen under the session's
 * host, so it is proven the session's; otherwise it was claimed on timing alone, and `commands` are the detaching calls
 * it may be the work of. Counting on a timing guess is fine; Pause and Stop act on one only if its command line is one
 * of those calls' (re-review of PR #476: an outside game whose launcher exited between two samples was stopped).
 */
interface Adopted {
  started: number;
  seen: boolean;
  commands: string[];
}

/**
 * How long a call is remembered, to tell whose processes are whose: a background call is never seen to end, and a
 * process a call left running (`cmd &`) outlives it.
 */
const CALL_KEPT_MS = 6 * 3600_000;
/** A process belongs to the call begun last before it started; this much leeway for the clocks' rounding. */
const START_LEEWAY_MS = 250;

/** Work above the small allowance in one sample: what makes a call's processes busy (R4). */
const busyNow = (u: Amounts) => Object.entries(u).some(([dim, v]) => v > (isMemory(dim) ? ALLOWANCE.bytes : ALLOWANCE.percent));

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
  /** Shell calls per session, by tool call id: a job learns only the kinds whose own processes were busy (R4). */
  private readonly calls = new Map<string, Map<string, Call>>();
  /** When a session's process was first seen, where the system gives no start time (macOS, Linux). */
  private readonly firstSeen = new Map<number, number>();
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
  /**
   * Processes a session started detached whose parent was gone before a sample saw them (round 2): taken into the
   * session's work for counting and learning; the person's Pause and Stop on the job's card reach those proven the
   * session's (seen under its host, or with the detaching call's command line; re-review of PR #476)
   * (acceptance test 3 of PR #476: a `nohup` job's card could neither pause nor stop it).
   */
  private readonly adopted = new Map<string, Map<number, Adopted>>();
  /**
   * Processes taken by timing alone that the person's Stop left alone: no longer the job's, and never taken again
   * while they are the same process (pid → start time), so a stopped job's card goes away instead of staying for an
   * outside program (acceptance test 5 of PR #476).
   */
  private readonly disowned = new Map<number, number>();
  /** Each session's host tree in the last sample, without what was adopted: what "seen under its host" means. */
  private lastHostTrees = new Map<string, ProcInfo[]>();
  /** WSL's memory, from the Windows process list; 0: not running or not Windows. */
  private wslBytes = 0;
  /** The largest other program by memory (name, bytes), for the page's "who holds the room". */
  private biggestOther: { name: string; bytes: number } | null = null;
  /** Ledung's sessions' own use outside passes (Claude Code, light work), per dim. */
  private sessionsUse: Amounts = {};

  constructor(ctx: BookContext) {
    this.ctx = ctx;
    this.control = ctx.control ?? osPriority;
    this.now = ctx.now ?? now0;
    this.limits = readJson<Amounts>(ctx.meta.get(LIMITS_KEY), {});
    this.settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<LimitSettings>>(ctx.meta.get(SETTINGS_KEY), {}) };
    // Reservations survive a restart of Ledung, as its sessions do; their processes are found again by id and start.
    for (const r of readJson<(Omit<Reservation, 'state'> & { state: PassState | 'going' })[]>(ctx.meta.get(RESERVATIONS_KEY), [])) {
      if (!r || typeof r.id !== 'string') continue;
      // A reservation kept by a Ledung before passes: "going" is busy once it had a job, else ready.
      const state: PassState = r.state === 'going' ? (r.hadJob ? 'busy' : 'ready') : r.state;
      this.reservations.set(r.id, {
        ...r, state, over: NOT_OVER, lowered: {}, loweredStays: false, seenOnce: r.seenOnce ?? false, wasActive: r.wasActive ?? false,
        deliveredAt: r.deliveredAt ?? r.goAt ?? null, quietSince: null, refMem: r.refMem ?? 0, parkedAt: r.parkedAt ?? null,
        resumedAbove: r.resumedAbove ?? false, managerTold: r.managerTold ?? false,
      });
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
      const adapters = this.gpu?.adapters ?? [];
      let g = adapters.find((a) => a.name === m[2]);
      // "<name> #1" from when copies of one card were listed (a virtual display's copy, hidden since #304, or a second
      // card taken out) is the card that is left alone under that name, unless a limit was set on that name since.
      const first = m[2]!.match(/^(.+) #1$/);
      if (!g && first && this.limits[`${m[1]}@${first[1]}`] === undefined) {
        const same = adapters.filter((a) => a.name === first[1]);
        if (same.length === 1) g = same[0];
      }
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
      // The "#1" limit limitsNow() carries over is replaced by this one, so clearing this doesn't bring it back.
      delete this.limits[`${key} #1`];
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
    num('parkSec', 30, 3600);
    num('tellManagerMin', 5, 24 * 60);
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
    // One pass per session, shared by its subagents (round 2, "Subagents"): a second call acts on it.
    let parked = [...this.reservations.values()].find((r) => r.sessionId === sessionId && r.state === 'parked');
    if (parked && parked.kind !== kind) {
      // Another kind of job: the parked one's record is kept apart, and a new pass starts.
      this.end(parked);
      parked = undefined;
    }
    const own = [...this.reservations.values()].filter((r) => r.sessionId === sessionId);
    const going = own.find(holdsRoom);
    const waiting = own.find((r) => r.state === 'waiting');
    let r: Reservation;
    if (going) {
      // Adds to a ready or busy pass: the extra is judged as a start; the job keeps its name (finding 16).
      r = going;
      r.extra = addAmounts(r.extra ?? {}, need);
      r.since = this.now();
      r.asked = addAmounts(r.asked, asked);
    } else if (parked) {
      // A parked pass asked again: back into the line as a new start, with what it learned so far.
      r = parked;
      r.state = 'waiting';
      r.granted = need;
      r.asked = asked;
      r.since = this.now();
      r.minutes = minutes;
      r.learnedRuns = learnedRuns;
    } else {
      // A waiting pass that had its go (a parked one sent back into the line) may have a paused or lowered job and
      // what it used to record: ended properly, never just dropped (code review of PR #476, finding 3).
      if (waiting && waiting.goAt !== null) this.end(waiting);
      else if (waiting) this.reservations.delete(waiting.id);
      r = {
        id: `r${this.nextId++}`, sessionId, project: s.project, what, kind, asked, granted: need, extra: null, state: 'waiting',
        since: waiting?.since ?? this.now(), goAt: null, deliveredAt: null, minutes, learnedRuns, baseline: [], pids: {}, seenOnce: false, wasActive: false, hadJob: false,
        quietSince: null, refMem: 0, parkedAt: null, resumedAbove: false, managerTold: waiting?.managerTold ?? false, commands: [],
        peak: {}, sum: {}, samples: 0, over: NOT_OVER, everOver: false, lowered: {}, loweredStays: false, told: false, paused: false, forced: false, gpu,
      };
      this.reservations.set(r.id, r);
    }
    this.dispatch(r.id);
    this.persist();
    this.ctx.changed();
    const learnedNote = learnedRuns ? ` (learned from ${learnedRuns} runs; you asked ${this.amountsText(asked)})` : '';
    const tail = notes.length ? ` ${notes.join(' ')}` : '';
    if (holdsRoom(r) && !r.extra) {
      return `Go: reservation ${r.id} "${r.what}", ${this.amountsText(r.granted)}${learnedNote}. ${this.passTerms()}${tail}`;
    }
    const place = this.placeOf(r.id);
    return `Wait: ${this.reasonOf(r.id, { kind: 'session', id: sessionId })}${place ? ` (${ordinal(place)} in line)` : ''}${learnedNote}. Don't start it yet: do other work, and Ledung will tell you when you may go. A subagent told this stops and tells its parent.${tail}`;
  }

  /** What a pass is, in the go's words (round 2, "In short"). */
  private passTerms(): string {
    const park = Math.round(this.settings.parkSec / 60) || 1;
    return `It is a pass for your session and its subagents: kept until you call release or your work is over (no turn, nothing in the background, no process of it running). It holds room while the work is busy; after ${park} min quiet it parks and holds none, and is checked against the limits when heavy work starts again.`;
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

  /**
   * The session's pass as idle stop and the page see it (round 2, "Waking"): waiting in line, or ready (the go given,
   * the work not started). A session with either is never stopped for being idle.
   */
  passWaits(sessionId: string): 'waiting' | 'ready' | null {
    for (const r of this.reservations.values()) {
      if (r.sessionId !== sessionId) continue;
      if (r.state === 'waiting' || r.extra) return 'waiting';
      if (r.state === 'ready') return 'ready';
    }
    return null;
  }

  /**
   * A shell call starts (session.ts), with its kinds (light ones already left out). A job learns a kind only if the
   * call's own processes were busy in one of its samples (R4, busyCalls): a `git status` between two builds, or a
   * background loop started before the build, never gets the build's peak (security review, finding 7). `detached`:
   * the call leaves its work running (`&`, `nohup`), whose processes may be orphaned before a sample sees them.
   */
  callStarted(sessionId: string, callId: string, kinds: string[], background: boolean, detached = false, command = ''): void {
    if (!kinds.length) return;
    const calls = this.calls.get(sessionId) ?? new Map<string, Call>();
    calls.set(callId, { kinds, at: this.now(), background, detached, command: detached ? command.slice(0, 4000) : '', ended: null });
    if (calls.size > 100) calls.delete(calls.keys().next().value!);
    this.calls.set(sessionId, calls);
  }

  /** A shell call ended: how long it took is kept per kind, for the 10-second rule (R4). */
  callEnded(sessionId: string, callId: string): void {
    const call = this.calls.get(sessionId)?.get(callId);
    if (!call || call.background || call.ended !== null) return;
    call.ended = this.now();
    const s = this.ctx.session(sessionId);
    if (!s?.local) return;
    try {
      for (const k of call.kinds) this.ctx.jobs.addCall(s.project, k, call.ended - call.at, call.ended);
    } catch (e) {
      console.error(`Recording a call's duration: ${(e as Error).message}`);
    }
  }

  /**
   * The kinds of the calls whose own processes are busy in this sample (R4; acceptance test round 1). Each process
   * belongs to the call begun last before its top process (the call's shell, a child of Claude Code) started, and a
   * call counts only if its processes in `pids` are together above the small allowance now. So a short script after
   * a build, or a background loop begun beside it, never gets the build's peak: their own processes are never busy.
   * `work` is the session's whole work tree (workOf), so a job's process is traced to its shell even if the shell is
   * older than the job.
   */
  private busyCalls(sessionId: string, work: ProcInfo[], pids: number[], usage: (pids: number[]) => Amounts, at: number): string[] {
    const calls = [...(this.calls.get(sessionId)?.values() ?? [])];
    if (!calls.length || !pids.length) return [];
    const byPid = new Map(work.map((p) => [p.pid, p]));
    const groups = new Map<number, number[]>();
    for (const pid of pids) {
      let top = byPid.get(pid);
      if (!top) continue;
      for (let hops = 0; hops < 64; hops++) {
        const parent = byPid.get(top.ppid);
        if (!parent || parent.pid === top.pid) break;
        top = parent;
      }
      const group = groups.get(top.pid);
      if (group) group.push(pid);
      else groups.set(top.pid, [pid]);
    }
    const out: string[] = [];
    for (const [top, members] of groups) {
      if (!busyNow(usage(members))) continue;
      // Windows gives a start time; elsewhere the sample it was first seen in, which may be a little late.
      const started = byPid.get(top)?.started ?? this.firstSeen.get(top) ?? at;
      let owner: Call | null = null;
      for (const c of calls) if (c.at <= started + START_LEEWAY_MS && (!owner || c.at > owner.at)) owner = c;
      if (owner) out.push(...owner.kinds);
    }
    return out;
  }

  /** Old calls are forgotten, and so are the processes no longer running. */
  private pruneCalls(at: number, list: ProcessList): void {
    for (const [sessionId, calls] of this.calls) {
      if (!this.ctx.session(sessionId)) {
        this.calls.delete(sessionId);
        continue;
      }
      for (const [id, c] of calls) if (at - c.at > CALL_KEPT_MS) calls.delete(id);
    }
    for (const pid of this.firstSeen.keys()) if (!list.has(pid)) this.firstSeen.delete(pid);
  }

  /**
   * The PreToolUse check (Recognising heavy commands): a known heavy command with no reservation going is refused
   * with the reason; so is one while the session is held for a job over its share (open choice 1). Null: go on.
   * Managers have no reserve tool, so they are never asked to use one (finding 4). It is advisory: a command can be
   * wrapped past it; the check of what really runs is the boundary.
   */
  commandRefusal(sessionId: string, kinds: string[], opts: { freeing?: boolean; subagent?: boolean } = {}): string | null {
    const s = this.ctx.session(sessionId);
    if (!s?.local || s.role === 'manager' || !kinds.length) return null;
    // A call that only frees resources (a lock's release, stopping its own processes) always runs: refusing it held
    // a session in a deadlock (issue #356, 2026-11-19).
    if (opts.freeing) return null;
    const heavy = this.ctx.jobs.heavyCommands(s.project).filter((h) => !h.never && kinds.includes(h.command));
    if (!heavy.length) return null;
    const h = heavy[0]!;
    // The command quoted is this session's own (the match is exact); the figures are numbers. No other session's
    // words reach it (acceptance test, finding 15): where the figure comes from is counts and a date, never a job's name.
    const own = kinds.find((k) => k === h.command)!;
    const gpu = mainGpu(this.gpu);
    const typical = Object.entries(fromGeneric(h.peak, gpu)).filter(([, v]) => v > 0).map(([d, v]) => `~${formatDim(d, v)} ${this.label(d)}`).join(' and ');
    const from = [h.reserved ? `${h.reserved} reserved job${h.reserved === 1 ? '' : 's'}` : '', h.unreserved ? `${h.unreserved} stretch${h.unreserved === 1 ? '' : 'es'} of unreserved heavy work` : '']
      .filter(Boolean).join(' and ');
    const took = h.usualMs !== null ? `; its calls usually take ${Math.round(h.usualMs / 1000)} s` : '';
    const source = `Ledung learned this from ${from} it ran in, the last on ${new Date(h.lastAt).toISOString().slice(0, 10)}${took}. If that is wrong, the person using Ledung can mark "${own}" as never needing a reservation on the usage page.`;
    const toParent = opts.subagent ? " Your session's reservation is waiting for room. Stop here and tell your parent; Ledung will tell it when it may go." : '';
    if (this.isHeld(sessionId)) {
      return `Not now: a job of yours is over its share and your session is held, so Ledung refuses new heavy work. "${own}" usually uses ${typical}. Reduce or stop the running job first; commands that stop it or release a lock always run. ${source}`;
    }
    const pass = [...this.reservations.values()].find((r) => r.sessionId === sessionId);
    if (pass && holdsRoom(pass)) return null;
    if (pass?.state === 'parked') {
      // Parked → busy is checked against the limits like a new start (round 2, open choice 2: refused at once if it
      // doesn't fit, back in the line with its original time).
      if (this.resumeFits(pass)) {
        this.toReady(pass, true);
        this.persist();
        this.ctx.changed();
        return null;
      }
      pass.state = 'waiting';
      pass.parkedAt = null;
      this.dispatch(pass.id);
      this.persist();
      this.ctx.changed();
      if (holdsRoom(pass)) return null;
      const place = this.placeOf(pass.id);
      return `Wait: your reservation ${pass.id} "${pass.what}" was parked, and there is no room to resume it now. ${this.reasonOf(pass.id, { kind: 'session', id: sessionId })}${place ? ` (${ordinal(place)} in line)` : ''}. "${own}" usually uses ${typical}. Don't start it yet: do other work, and Ledung will tell you when you may go.${toParent}`;
    }
    if (pass?.state === 'waiting') {
      const place = this.placeOf(pass.id);
      return `Wait: your reservation ${pass.id} "${pass.what}" is waiting for room: ${this.reasonOf(pass.id, { kind: 'session', id: sessionId })}${place ? ` (${ordinal(place)} in line)` : ''}. "${own}" usually uses ${typical}; run it once Ledung says go.${toParent}`;
    }
    return `"${own}" usually uses ${typical}: call reserve first, then run it once Ledung says go. ${source}`;
  }

  /** A parked pass's work may start again: what it holds back now fits under the limits beside everyone else's. */
  private resumeFits(r: Reservation): boolean {
    // A parked pass holds nothing, so unused() is everyone else's; what it uses now is already in the PC's total.
    // Every dim it books counts, also one it already uses all of: work already past the line doesn't fit (code review
    // of PR #476, finding 2), where notFitting would skip a dim with nothing left to ask.
    const rest = unusedOf(r.granted, this.usingOf(r));
    const total = this.pcTotals();
    const unused = this.unused();
    const limits = this.limitsNow();
    return Object.entries(r.granted).every(([dim, g]) => !(g > 0) || limits[dim] === undefined || (total[dim] ?? 0) + (unused[dim] ?? 0) + (rest[dim] ?? 0) <= limits[dim]!);
  }

  /** The go, or a parked pass resuming: it holds all its room until the work starts. `reached`: the session knows now. */
  private toReady(r: Reservation, reached: boolean): void {
    const at = this.now();
    if (r.goAt === null) r.baseline = [...(this.lastTrees.get(r.sessionId) ?? []).map((p) => p.pid)];
    r.state = 'ready';
    r.goAt = at;
    r.deliveredAt = reached ? at : null;
    r.parkedAt = null;
    r.quietSince = null;
    r.seenOnce = false;
    r.wasActive = false;
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

  /** What ready and busy passes hold but don't use yet; parked ones hold nothing (round 2). */
  private unused(): Amounts {
    let out: Amounts = {};
    for (const r of this.reservations.values()) if (holdsRoom(r)) out = addAmounts(out, unusedOf(r.granted, this.usingOf(r)));
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
          // The go's 10 minutes count from when it reaches the session (round 2, open choice 3): at once in the
          // tool's own answer, else when the turn carrying "You may go" starts.
          this.toReady(r, id === quiet);
        } else if (r.extra) {
          r.granted = addAmounts(r.granted, r.extra);
          r.extra = null;
        }
        if (id !== quiet) {
          this.ctx.tell(r.sessionId, `You may go: reservation ${r.id} "${r.what}" (${this.amountsText(r.granted)})${forced ? ', started by the person above the limits' : ''}. Start the job now. ${this.passTerms()}`);
        }
        if (r.managerTold) {
          r.managerTold = false;
          this.tellManagerOf(r.sessionId, (title) => `${title} may go now: its reservation "${r.what}" got room.`);
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
  private reasonOf(id: string, viewer: Viewer): string {
    const w = this.waiting.get(id);
    const r = this.reservations.get(id);
    const need = r ? r.extra ?? r.granted : { ram: this.waiters.get(id)?.need ?? 0 };
    if (!w) return 'Waiting';
    if (w.kind === 'held') return 'Held: a job of this session is over its share';
    if (w.kind === 'unmeasured') return "Waiting for its session's processes to be measured (a few seconds)";
    if (w.kind === 'behind') {
      const other = this.reservations.get(w.behind);
      const otherSession = other?.sessionId ?? w.behind;
      const who = !this.mayName(viewer, otherSession) ? (other ? 'another job' : 'a new session')
        : other ? `"${other.what}"` : `"${this.ctx.session(w.behind)?.title ?? 'a new session'}"`;
      return `Waiting behind ${who} for ${this.label(w.dims[0]!)} room`;
    }
    const limits = this.limitsNow();
    const dim = w.dims[0]!;
    const reason = roomReason(dim, need[dim] ?? 0, this.pcTotals()[dim] ?? 0, this.unused()[dim] ?? 0, limits[dim] ?? 0, this.label(dim));
    if ((need[dim] ?? 0) > (limits[dim] ?? 0)) return `${reason}: only a higher limit lets it start`;
    const held = this.holders(dim, viewer, r?.id ?? null);
    return held ? `${reason}; held by ${held}` : reason;
  }

  /**
   * Whether a viewer may see a session's job name and title: the page always; a session only its own; a manager its
   * own sessions' (round 2, "Who holds the room"; security review, finding 5).
   */
  private mayName(viewer: Viewer, sessionId: string): boolean {
    if (viewer.kind === 'page') return true;
    if (viewer.kind === 'session') return viewer.id === sessionId;
    return this.ctx.session(sessionId)?.parentId === viewer.id;
  }

  /**
   * Who holds the room on one resource, largest first, at most three (round 2, problem 6): passes (booked and used),
   * WSL, and other programs (the PC's total minus Ledung's sessions and WSL). On the page by name; for sessions and
   * managers other sessions' jobs only as a count with figures, never a name or title.
   */
  private holders(dim: string, viewer: Viewer, self: string | null): string {
    const f = (v: number) => formatDim(dim, v);
    const small = isMemory(dim) ? 0.1 * GB : 1;
    type Holder = { size: number; text: string };
    const out: Holder[] = [];
    const anon = { n: 0, parked: 0, booked: 0, used: 0 };
    let passUse = 0;
    for (const r of this.reservations.values()) {
      if (r.id === self || r.state === 'waiting') continue;
      const used = this.usingOf(r)[dim] ?? 0;
      const booked = holdsRoom(r) ? r.granted[dim] ?? 0 : 0;
      passUse += used;
      if (Math.max(used, booked) < small) continue;
      if (this.mayName(viewer, r.sessionId)) {
        const title = this.ctx.session(r.sessionId)?.title ?? 'a session';
        out.push({ size: Math.max(used, booked), text: `"${r.what}" (${title}${r.state === 'parked' ? ', parked' : ''}: ${f(booked)} booked, ${f(used)} used)` });
      } else {
        anon.n++;
        if (r.state === 'parked') anon.parked++;
        anon.booked += booked;
        anon.used += used;
      }
    }
    if (anon.n) {
      const kind = anon.parked === anon.n ? `parked job${anon.n === 1 ? '' : 's'}` : `other job${anon.n === 1 ? '' : 's'}`;
      out.push({ size: Math.max(anon.booked, anon.used), text: `${anon.n} ${kind} (${f(anon.booked)} booked, ${f(anon.used)} used)` });
    }
    const wsl = dim === 'ram' ? this.wslBytes : 0;
    if (wsl >= small) out.push({ size: wsl, text: `WSL ${f(wsl)}` });
    const others = Math.max(0, (this.pcTotals()[dim] ?? 0) - passUse - (this.sessionsUse[dim] ?? 0) - wsl);
    if (others >= small) {
      const big = viewer.kind === 'page' && dim === 'ram' && this.biggestOther && this.biggestOther.bytes >= small ? ` (most: ${this.biggestOther.name} ${f(this.biggestOther.bytes)})` : '';
      out.push({ size: others, text: `other programs ${f(others)}${big}` });
    }
    return out.sort((a, b) => b.size - a.size).slice(0, 3).map((h) => h.text).join(', ');
  }

  /** A notice to a session's manager, with its session's title (the manager's own session, so it may be named). */
  private tellManagerOf(sessionId: string, text: (title: string) => string): void {
    const s = this.ctx.session(sessionId);
    if (!s?.parentId || !this.ctx.tellManager) return;
    this.ctx.tellManager(s.parentId, text(`Your session "${s.title}"`));
  }

  // --- Each sample --------------------------------------------------------------------------------------------------

  /**
   * A heavy job started detached (`python train.py &`, `nohup`, `start`) can lose its parent before any sample sees
   * it, and then it is no session's (issue #356 comments): a parentless process that started within a few seconds
   * after exactly one session's detaching call is taken into that session's work, with what it starts, for as long
   * as it is the same process. Counted and learned from; Pause and Stop on its job's card reach it only if it was seen
   * under the host or its command line is the call's (jobTargets, re-review of PR #476).
   */
  private withAdopted(x: BookSample): Map<string, ProcInfo[]> {
    const inTrees = new Set<number>();
    for (const t of x.trees.values()) for (const p of t) inTrees.add(p.pid);
    // Still the same processes.
    for (const [sessionId, kept] of this.adopted) {
      if (!x.trees.has(sessionId)) {
        this.adopted.delete(sessionId);
        continue;
      }
      for (const [pid, a] of kept) if (x.list.get(pid)?.started !== a.started) kept.delete(pid);
    }
    for (const [pid, started] of this.disowned) if (x.list.get(pid)?.started !== started) this.disowned.delete(pid);
    const detached: { sessionId: string; at: number; command: string }[] = [];
    for (const [sessionId, calls] of this.calls) {
      if (!x.trees.has(sessionId)) continue;
      for (const c of calls.values()) if (c.detached && x.at - c.at < 10 * 60_000) detached.push({ sessionId, at: c.at, command: c.command });
    }
    // Without the previous list, where a parent was can't be told.
    if (detached.length && x.prev) for (const p of x.list.values()) {
      const started = p.started;
      if (started === undefined || inTrees.has(p.pid) || x.list.has(p.ppid)) continue;
      if ([...this.adopted.values()].some((m) => m.has(p.pid)) || this.disowned.get(p.pid) === started) continue;
      // Its parent was in a session's tree last time, or came and went between two lists (the detaching shell). One
      // whose parent was another program's (an app's launcher that has exited, an updater) is no session's, whenever
      // it started (code review of PR #476, finding 4). A process already in the last list was judged then: it is
      // the session's only if it or its parent was in that session's tree.
      const lastIn = (pid: number) => [...this.lastTrees].filter(([, t]) => t.some((q) => q.pid === pid)).map(([id]) => id);
      const parentIn = x.prev.has(p.pid) ? new Set([...lastIn(p.pid), ...lastIn(p.ppid)]) : x.prev.has(p.ppid) ? new Set(lastIn(p.ppid)) : null;
      const calls = detached.filter((c) => (!parentIn || parentIn.has(c.sessionId)) && started >= c.at - START_LEEWAY_MS && started <= c.at + DETACH_WINDOW_MS);
      const owners = new Set(calls.map((c) => c.sessionId));
      // Two sessions detached at about the same time: whose it is can't be told, so it is no one's.
      if (owners.size !== 1) continue;
      const [owner] = owners;
      // Seen under the host: it, or its parent, was in the host's own tree last time, not only in what was adopted.
      const underHost = (pid: number) => this.lastHostTrees.get(owner!)?.some((q) => q.pid === pid) === true;
      const seen = x.prev.has(p.pid) ? underHost(p.pid) || underHost(p.ppid) : x.prev.has(p.ppid) && underHost(p.ppid);
      const kept = this.adopted.get(owner!) ?? new Map<number, Adopted>();
      kept.set(p.pid, { started, seen, commands: calls.map((c) => c.command).filter(Boolean) });
      this.adopted.set(owner!, kept);
    }
    if (!this.adopted.size) return x.trees;
    const trees = new Map(x.trees);
    for (const [sessionId, kept] of this.adopted) {
      const tree = [...(trees.get(sessionId) ?? [])];
      const have = new Set(tree.map((p) => p.pid));
      for (const pid of kept.keys()) for (const p of treeOf(x.list, pid)) if (!have.has(p.pid) && !inTrees.has(p.pid)) {
        have.add(p.pid);
        tree.push(p);
      }
      trees.set(sessionId, tree);
    }
    return trees;
  }

  sample(x0: BookSample): void {
    const at = x0.at;
    this.threads = Math.max(1, x0.threads);
    this.memTotal = x0.memTotal;
    this.gpu = x0.gpu;
    this.noGpu = x0.gpu?.adapters.length ? 0 : this.noGpu + 1;
    const x: BookSample = { ...x0, trees: this.withAdopted(x0) };
    this.lastHostTrees = x0.trees;
    this.lastTrees = x.trees;
    this.lastList = x.list;
    this.lastHosts = x.hosts;
    this.restorePending();
    this.sampled = true;
    for (const tree of x.trees.values()) for (const p of tree) if (p.started === undefined && !this.firstSeen.has(p.pid)) this.firstSeen.set(p.pid, at);
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
    const waitingBooked = new Map<string, number>();
    for (const r of [...this.reservations.values()]) {
      const s = this.ctx.session(r.sessionId);
      if (!s) {
        this.end(r);
        changed = true;
        continue;
      }
      // In line: its manager hears once when it has waited long (round 2, open choice 4), with who holds the room.
      if ((r.state === 'waiting' || r.extra) && !r.managerTold && s.parentId && at - r.since >= this.settings.tellManagerMin * 60_000) {
        r.managerTold = true;
        const why = this.reasonOf(r.id, { kind: 'manager', id: s.parentId });
        this.tellManagerOf(r.sessionId, (title) => `${title} has waited ${Math.round((at - r.since) / 60_000)} min for its reservation "${r.what}": ${why}. Ledung tells it when it may go; nothing to do unless the wait matters.`);
        changed = true;
      }
      // Never had a go, or no tree this round (its host not found yet): judged on the next one, never ended for it.
      if (r.goAt === null || !x.trees.has(r.sessionId)) continue;
      // Its processes: new since the first go, still the same process (the start time, where Windows gives one).
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
      const u = usage(list);
      for (const [dim, v] of Object.entries(u)) this.averages.add(`r:${r.id}|${dim}`, at, v);
      // Work under the pass: CPU or GPU above the small allowance, memory growing (round 2, "Idle bookings"), or memory
      // above what it booked: a job that takes its memory at once and then runs one thread is work too (acceptance
      // test 2 of PR #476, F2).
      const booked = Math.max(r.granted.ram ?? 0, ALLOWANCE.bytes);
      const active = list.length > 0 && (Object.entries(u).some(([d, v]) => !isMemory(d) && v > ALLOWANCE.percent) || (u.ram ?? 0) > r.refMem + GROW_BYTES || (u.ram ?? 0) > booked);
      if (active) r.refMem = u.ram ?? 0;
      else r.refMem = Math.min(r.refMem, u.ram ?? 0);
      // A ready pass's work starts when its processes are seen in two samples in a row, active in either (a job that
      // loads its memory at once and then waits on the disk is still work); a short call caught once, a git command,
      // isn't (finding 16). A parked pass needs two active samples in a row: a leftover daemon's one blip of CPU
      // doesn't take its room back. So does a parked pass sent back into the line (a refused command): its processes
      // are still claimed for it, so work it starts anyway must be judged here, or nothing would (code review of
      // PR #476, finding 2).
      const idle = r.state === 'parked' || r.state === 'waiting';
      const starts = idle ? active && r.seenOnce && r.wasActive : list.length > 0 && r.seenOnce && (active || r.wasActive);
      r.seenOnce = list.length > 0;
      r.wasActive = active;
      // Still in line: it keeps its place, and the session's turn being over doesn't end it. It holds no room, so its
      // processes aren't claimed for it: they are the session's, judged by the unreserved check below up to what it had
      // booked (a leftover daemon under it holds no one), and seen on the page as the session's (acceptance test 2, F2).
      if (r.state === 'waiting' && !starts) {
        waitingBooked.set(r.sessionId, (waitingBooked.get(r.sessionId) ?? 0) + (r.granted.ram ?? 0));
        continue;
      }
      const mine = jobPidsOf.get(r.sessionId) ?? new Set<number>();
      for (const pid of list) mine.add(pid);
      jobPidsOf.set(r.sessionId, mine);
      if (r.deliveredAt === null && !this.ctx.undelivered?.(r.sessionId)) r.deliveredAt = at;
      if (r.state === 'ready' && starts) {
        r.state = 'busy';
        r.hadJob = true;
        r.quietSince = null;
        changed = true;
      } else if (idle && starts) {
        // Work started again without asking first (a command Ledung didn't know was heavy): checked like a new start;
        // it can't be stopped, so above the limits it runs, judged against its share, and its card says so.
        r.resumedAbove = !this.resumeFits(r);
        r.state = 'busy';
        r.parkedAt = null;
        r.quietSince = null;
        changed = true;
      } else if (r.state === 'busy') {
        if (active) r.quietSince = null;
        else if ((r.quietSince ??= at) && at - r.quietSince >= this.settings.parkSec * 1000) {
          // Quiet: it keeps its place with the session but holds no room (a build's leftover daemon, a pause).
          r.state = 'parked';
          r.parkedAt = at;
          r.quietSince = null;
          r.resumedAbove = false;
          changed = true;
        }
      } else if (r.state === 'ready' && r.deliveredAt !== null && at - r.deliveredAt > LAPSE_MS) {
        r.state = 'parked';
        r.parkedAt = at;
        this.ctx.tell(r.sessionId, `Reservation ${r.id} "${r.what}" is parked: no work started within 10 minutes of the go, so it holds no room now. When you start the job, Ledung checks it against the limits; if there is no room then, you are told to wait.`);
        changed = true;
      }
      // The pass ends when the session's work is over: no turn, nothing in the background (a subagent or a command),
      // no process of it running. Not before the go has reached the session.
      if (r.deliveredAt !== null && !s.busy && !(s.background ?? 0) && !list.length) {
        this.end(r);
        changed = true;
        continue;
      }
      // Learned from its busy stretches only, so parked time doesn't lower the mean.
      if (r.state === 'busy') {
        // The calls whose own processes in the job are busy now are the job's (R4).
        for (const k of this.busyCalls(r.sessionId, workOf(r.sessionId), list, usage, at)) if (!r.commands.includes(k) && r.commands.length < 40) r.commands.push(k);
        r.samples++;
        for (const [dim, v] of Object.entries(this.usingOf(r))) {
          r.peak[dim] = Math.max(r.peak[dim] ?? 0, v);
          r.sum[dim] = (r.sum[dim] ?? 0) + v;
        }
      }
      const avg = this.usingOf(r);
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
        this.ctx.tell(r.sessionId, `Your job "${r.what}" (reservation ${r.id}) ${dims} for over ${Math.round(this.settings.overSec)} s: over its share. Ledung has lowered its processes' priority and holds your session (no new turns from others, no new reservation, no known heavy command) until it is back within its share. Reduce it (fewer workers, a smaller batch) or stop it cleanly; commands that stop it or release a lock always run. Nothing is killed.`);
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
      const u0 = this.unreserved.get(sessionId) ?? { over: NOT_OVER, lowered: {}, loweredStays: false, told: false, peak: {}, since: null, commands: [] };
      const jobs = jobPidsOf.get(sessionId) ?? new Set<number>();
      const host = x.hosts.get(sessionId);
      const counted = tree.filter((p) => p.pid !== host && !jobs.has(p.pid)).map((p) => p.pid);
      for (const [dim, v] of Object.entries(usage(counted))) this.averages.add(`s:${sessionId}|${dim}`, at, v);
      const avg = this.averages.all(`s:${sessionId}`, at, this.settings.averageSec);
      const share: Amounts = { ram: this.sessionNeed(s.project, s.role) + ALLOWANCE.bytes + (waitingBooked.get(sessionId) ?? 0) };
      const step = overStep(u0.over, avg, share, this.settings, at);
      u0.over = step.state;
      if (u0.over.since !== null) {
        u0.since ??= u0.over.since;
        for (const [dim, v] of Object.entries(avg)) u0.peak[dim] = Math.max(u0.peak[dim] ?? 0, v);
        // The calls whose own processes are busy now are the stretch's (R4), not every call made while it lasts.
        const own = workOf(sessionId).filter((p) => !jobs.has(p.pid));
        for (const k of this.busyCalls(sessionId, own, own.map((p) => p.pid), usage, at)) if (!u0.commands.includes(k) && u0.commands.length < 40) u0.commands.push(k);
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
        u0.commands = [];
      }
      this.unreserved.set(sessionId, u0);
    }
    for (const id of [...this.unreserved.keys()]) if (!x.trees.has(id)) {
      const u = this.unreserved.get(id)!;
      if (u.over.over) this.endUnreserved(id, u);
      this.unreserved.delete(id);
      this.averages.drop(`s:${id}`);
    }
    // Who holds the room (round 2, problems 5 and 6): Ledung's sessions outside passes, WSL's virtual machine (read
    // from the process list; nothing runs inside WSL), and the largest other program by name, for the page only.
    let sessionsUse: Amounts = {};
    const ledung = new Set<number>();
    for (const [sessionId, tree] of x.trees) {
      const jobs = jobPidsOf.get(sessionId) ?? new Set<number>();
      for (const p of tree) ledung.add(p.pid);
      sessionsUse = addAmounts(sessionsUse, usage(tree.filter((p) => !jobs.has(p.pid)).map((p) => p.pid)));
    }
    for (const [dim, v] of Object.entries(sessionsUse)) this.averages.add(`ledung|${dim}`, at, v);
    this.sessionsUse = this.averages.all('ledung', at, this.settings.averageSec);
    let wsl = 0;
    const byName = new Map<string, number>();
    for (const p of x.list.values()) {
      if (p.name && WSL_PROCESS.test(p.name)) wsl += p.memBytes;
      else if (p.name && !ledung.has(p.pid)) byName.set(p.name, (byName.get(p.name) ?? 0) + p.memBytes);
    }
    this.wslBytes = wsl;
    let biggest: { name: string; bytes: number } | null = null;
    for (const [name, bytes] of byName) if (!biggest || bytes > biggest.bytes) biggest = { name, bytes };
    this.biggestOther = biggest;
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
    this.pruneCalls(at, x.list);
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
      this.ctx.jobs.add({ project: s.project, kind: '(unreserved)', commands: u.commands, asked: {}, peak: toGeneric(u.peak, gpu), mean: toGeneric(u.peak, gpu), durationMs: at - since, over: true, undeclared: true, endedAt: at });
    }
    u.peak = {};
    u.since = null;
    u.commands = [];
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
    if (r.hadJob && r.samples > 0) {
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
    const keep = [...this.reservations.values()].map((r) => ({ ...r, over: undefined, lowered: undefined }));
    this.ctx.meta.set(RESERVATIONS_KEY, JSON.stringify(keep));
  }

  // --- The person's actions on a job's card --------------------------------------------------------------------------

  /**
   * The job's processes now, with their start times, its session's host, and the detached ones among them whose
   * parent is gone (not under the host, so the action looks them up on their own; acceptance test 3 of PR #476), for
   * the person's Pause, Resume and Stop: `adopted`, seen under the host, are the session's; `guessed`, taken by timing
   * alone, are acted on only if their command line is one of the detaching calls' (re-review of PR #476).
   */
  jobTargets(id: string): { sessionId: string; what: string; host: number | null; paused: boolean; targets: Target[]; adopted: number[]; guessed: { pid: number; commands: string[] }[] } {
    const r = this.reservations.get(id);
    if (!r || r.goAt === null) throw new Error('No such job.');
    const mine = [...(this.adopted.get(r.sessionId) ?? [])].filter(([pid]) => r.pids[pid] !== undefined);
    return {
      sessionId: r.sessionId,
      what: r.what,
      host: this.lastHosts.get(r.sessionId) ?? null,
      paused: r.paused,
      targets: Object.entries(r.pids).map(([pid, started]) => ({ pid: Number(pid), started })),
      adopted: mine.filter(([, a]) => a.seen).map(([pid]) => pid),
      guessed: mine.filter(([, a]) => !a.seen).map(([pid, a]) => ({ pid, commands: a.commands })),
    };
  }

  /**
   * Detached processes whose command line was just proven the session's: remembered as seen, so a paused job's Resume
   * or Stop never depends on reading command lines again (third code review of PR #476). Only while the same process:
   * withAdopted drops an entry whose start time changes.
   */
  prove(id: string, pids: number[]): void {
    const r = this.reservations.get(id);
    const kept = r ? this.adopted.get(r.sessionId) : undefined;
    for (const pid of pids) {
      const a = kept?.get(pid);
      if (a) a.seen = true;
    }
  }

  /**
   * After the person's Stop: the processes it left alone (taken by timing alone, their command not the session's) are
   * no longer the job's, so its card goes away once the session's own work is over (acceptance test 5 of PR #476).
   * What Stop ended or found gone leaves the card at once and the job is no longer paused, so the card doesn't say
   * "Paused by you" with Stop active for the seconds until the next sample (acceptance test 6 of PR #476).
   */
  disown(id: string, pids: number[], ended: number[] = []): void {
    const r = this.reservations.get(id);
    if (!r) return;
    const kept = this.adopted.get(r.sessionId);
    for (const pid of pids) {
      const started = kept?.get(pid)?.started ?? r.pids[pid] ?? null;
      kept?.delete(pid);
      delete r.pids[pid];
      if (started !== null) this.disowned.set(pid, started);
    }
    // One that didn't end comes back with the next sample; only Stop's own targets are dropped here.
    for (const pid of ended) delete r.pids[pid];
    r.paused = false;
    this.persist();
    this.ctx.changed();
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
      const common = { reason: this.reasonOf(id, { kind: 'page' }), reasonForSessions: this.reasonOf(id, { kind: 'session', id: r?.sessionId ?? id }), place };
      if (r) line.push({ id, sessionId: r.sessionId, what: r.what, kind: 'job', need: r.extra ?? r.granted, since: r.since, ...common });
      else if (w) line.push({ id, sessionId: id, what: 'New session', kind: 'session', need: { ram: w.need }, since: w.since, ...common });
    }
    const jobs: ResourceJobInfo[] = [];
    for (const r of this.reservations.values()) {
      // Every pass that has had its go, parked ones too (a parked one sent back to the line shows as parked).
      if (r.goAt === null) continue;
      const pass = r.state === 'waiting' ? 'parked' : r.state;
      jobs.push({
        id: r.id, sessionId: r.sessionId, what: r.what, granted: r.granted, using: this.usingOf(r), learnedRuns: r.learnedRuns,
        state: r.paused ? 'paused' : r.over.over ? 'over' : pass, deliveredAt: r.deliveredAt, quietSince: r.quietSince, parkedAt: r.parkedAt, resumedAbove: r.resumedAbove, overSince: r.over.over ? r.over.since : null, overDims: r.over.dims,
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
      wsl: this.wslBytes > 0 ? this.wslBytes : null,
    };
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
