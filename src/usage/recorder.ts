// Turns a session's stream of messages into usage records (step 5): one per model call, with what
// Ledung knows about it (project, role, team, subagent, branch, what started the turn, machine).
// Used live by each session and, for sessions from before step 5, over the stored history.
import os from 'node:os';
import { callCost } from './pricing.ts';

export type Trigger = 'user' | 'answer' | 'manager' | 'ledung' | 'unknown';

export interface UsageRecord {
  sessionId: string;
  /** The model call's id; streamed replies repeat it, so a call is recorded once. */
  messageId: string;
  at: number;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Claude Code's estimate; it doesn't report thinking per call. */
  thinking: number | null;
  cost: number | null;
  project: string;
  role: 'session' | 'manager';
  /** The manager whose team this is: the manager itself, or the one that started the session. */
  team: string | null;
  /** The subagent type when a subagent made the call. */
  subagent: string | null;
  branch: string | null;
  trigger: Trigger;
  machine: string;
  /** The Claude account ("default": the computer's own login). */
  account?: string;
  /** 'compaction': a /compact's own model call, from the result's totals; otherwise a call of a turn. */
  kind?: 'call' | 'compaction';
}

export interface SessionFacts {
  sessionId: string;
  project: string;
  role: 'session' | 'manager';
  team: string | null;
  branch: string | null;
  account?: string;
}

export interface LimitRecord {
  account?: string;
  at: number;
  kind: string;
  status: string;
  utilization: number | null;
  resetsAt: number | null;
  data: unknown;
}

const MACHINE = os.hostname();

export class UsageRecorder {
  /**
   * What started the current work. It holds until something new starts a turn: Claude Code also starts
   * turns on its own (e.g. when a background subagent finishes), and those continue the same work.
   */
  private trigger: Trigger = 'unknown';
  /** Subagent type, and what started the turn that launched it, by the Agent tool call. */
  private readonly subagents = new Map<string, { type: string; trigger: Trigger }>();
  private thinkingSinceLastCall = 0;
  /** The model Claude Code started the session on (init), and the input the main thread sent each model. */
  private initModel: string | null = null;
  private readonly mainInput = new Map<string, number>();

  /**
   * The context window of the session's own model. A result's modelUsage lists every model used,
   * a helper model first and subagents' after (2026-10-13), so the first entry is not the session's.
   * The session's entry is the one matching init's model (keys and init may differ by a `[1m]` suffix
   * or an alias such as "sonnet"), else the one the main thread sent most input to; none otherwise.
   */
  private sessionWindow(modelUsage: unknown): number | undefined {
    if (!modelUsage || typeof modelUsage !== 'object') return undefined;
    const entries = Object.entries(modelUsage as Record<string, any>).filter(([, u]) => typeof u?.contextWindow === 'number');
    const base = (k: string) => k.toLowerCase().replace(/\[.*\]$/, '');
    const init = this.initModel;
    let own = init ? entries.find(([k]) => k.toLowerCase() === init.toLowerCase()) : undefined;
    if (!own && init) {
      const i = base(init);
      const matches = entries.filter(([k]) => base(k) === i || base(k).startsWith(i) || base(k).includes(`-${i}-`));
      // An alias can match several versions; the main thread's busiest one is the session's.
      own = matches.sort((a, b) => this.mainOf(b[0]) - this.mainOf(a[0]))[0];
    }
    own ??= entries.filter(([k]) => this.mainOf(k) > 0).sort((a, b) => this.mainOf(b[0]) - this.mainOf(a[0]))[0];
    return own?.[1].contextWindow;
  }

  private mainOf(key: string): number {
    const k = key.toLowerCase().replace(/\[.*\]$/, '');
    let n = 0;
    for (const [model, input] of this.mainInput) if (model.toLowerCase().replace(/\[.*\]$/, '') === k) n += input;
    return n;
  }

  /** What started the turn that is about to run. */
  /** What started the current turn. */
  get currentTrigger(): Trigger {
    return this.trigger;
  }

  startTurn(trigger: Trigger): void {
    this.trigger = trigger;
  }

  /**
   * Looks at one message from Claude Code. Returns the usage record for a model call, if it is one,
   * and the plan-limit status, if it is one.
   */
  feed(m: any, at: number, facts: SessionFacts): { usage?: UsageRecord; limits?: LimitRecord[]; context?: { tokens: number; window?: number } } {
    if (m?.type === 'system' && m.subtype === 'thinking_tokens' && typeof m.estimated_tokens_delta === 'number') {
      this.thinkingSinceLastCall += Math.max(0, m.estimated_tokens_delta);
      return {};
    }
    if (m?.type === 'rate_limit_event' && m.rate_limit_info) {
      const i = m.rate_limit_info;
      const ms = (t: unknown) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : null);
      const kind = i.rateLimitType ?? 'unknown';
      // The event is about one limit, but carries every window's utilization in unifiedWindows (5-hour and
      // weekly), even far from any warning; its own utilization field is only there near the limit.
      const windows: Record<string, { utilization?: unknown; resetsAt?: unknown }> = i.unifiedWindows && typeof i.unifiedWindows === 'object' ? i.unifiedWindows : {};
      const limits: LimitRecord[] = [{
        account: facts.account ?? 'default',
        at,
        kind,
        status: i.status ?? 'unknown',
        utilization: typeof i.utilization === 'number' ? i.utilization : typeof windows[kind]?.utilization === 'number' ? (windows[kind].utilization as number) : null,
        resetsAt: ms(i.resetsAt) ?? ms(windows[kind]?.resetsAt),
        data: i,
      }];
      for (const [k, w] of Object.entries(windows)) {
        if (k === kind || typeof w?.utilization !== 'number') continue;
        // A window the event isn't about: had it been reached, the event would be about it.
        limits.push({ account: facts.account ?? 'default', at, kind: k, status: 'allowed', utilization: w.utilization, resetsAt: ms(w.resetsAt), data: w });
      }
      return { limits };
    }
    if (m?.type === 'result') {
      const window = this.sessionWindow(m.modelUsage);
      return window ? { context: { tokens: -1, window } } : {};
    }
    if (m?.type === 'system' && m.subtype === 'init' && typeof m.model === 'string') this.initModel = m.model;
    // Claude Code's own placeholder replies (model "<synthetic>", e.g. after an interrupt) cost nothing.
    if (m?.type !== 'assistant' || !m.message?.usage || !m.message.id || m.message.model === '<synthetic>') return {};

    const launched = m.parent_tool_use_id ? this.subagents.get(m.parent_tool_use_id) : undefined;
    const sub = m.parent_tool_use_id ? launched?.type ?? 'subagent' : null;
    if (!sub) {
      for (const b of m.message.content ?? []) {
        if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
          this.subagents.set(b.id, { type: String(b.input?.subagent_type ?? 'general-purpose'), trigger: this.trigger });
        }
      }
    }
    const u = m.message.usage;
    const t = {
      input: Number(u.input_tokens ?? 0),
      output: Number(u.output_tokens ?? 0),
      cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
      cacheRead: Number(u.cache_read_input_tokens ?? 0),
    };
    const model = String(m.message.model ?? 'unknown');
    if (!sub) this.mainInput.set(model, (this.mainInput.get(model) ?? 0) + t.input + t.cacheRead + t.cacheWrite);
    const thinking = !sub && this.thinkingSinceLastCall ? this.thinkingSinceLastCall : null;
    if (!sub) this.thinkingSinceLastCall = 0;
    return {
      usage: {
        sessionId: facts.sessionId,
        messageId: String(m.message.id),
        at,
        model,
        ...t,
        thinking,
        cost: callCost(model, t),
        project: facts.project,
        role: facts.role,
        team: facts.team,
        subagent: sub,
        branch: facts.branch,
        account: facts.account ?? 'default',
        trigger: launched?.trigger ?? this.trigger,
        machine: MACHINE,
      },
      // The main thread's input for this call is how full its context is.
      context: sub ? undefined : { tokens: t.input + t.cacheRead + t.cacheWrite },
    };
  }
}

/**
 * The context figure right after a compact, until the next reply measures it. post_tokens leaves out the
 * fixed part (system prompt and tools, ~25k; findings 4), and pre_tokens can't give it either: in the
 * live test of 2026-10-13 it was 78.0k for a context of 77.8k once, and 1.9k for one of about 24k
 * another time. The session's smallest call (the fixed part plus its first message) stands in for the
 * fixed part: 28.4k where the next reply measured 23.6k. Without one, post alone.
 */
export function contextAfterCompact(smallestCall: number | null, post: number): number {
  return smallestCall == null ? post : smallestCall + post;
}

type Totals = Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;

/**
 * A manual compact's own model calls, which come as no assistant message and leave the result's usage
 * at zero (findings 3). The result's modelUsage is a running total that includes them (probe of
 * 2026-10-13), so the compaction is this result's totals minus the previous result's. A resumed process
 * goes on from the totals its transcript saved (same probe), so the previous result may be from an
 * earlier process; a clear resets the totals, so after one the baseline is zero.
 *
 * `before`: the session's stored Claude Code messages before this result, oldest first. Returns the
 * records (none if this result is no manual compact), or null if the cost can't be known.
 */
export function compactionUsage(before: any[], result: any, at: number, facts: SessionFacts & { trigger: Trigger }): UsageRecord[] | null {
  let boundary: string | null = null;
  let reset = false;
  let baseline: Totals | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    const m = before[i];
    if (m?.type === 'result') {
      baseline = m.modelUsage && typeof m.modelUsage === 'object' ? m.modelUsage : {};
      break;
    }
    if (m?.type === 'system' && m.subtype === 'compact_boundary' && m.compact_metadata?.trigger === 'manual' && !m.parent_tool_use_id) boundary ??= String(m.uuid ?? at);
    if (m?.type === 'conversation_reset') reset = true;
  }
  if (!boundary || result?.num_turns !== 0) return [];
  if (reset) baseline = {};
  if (!baseline) return null;
  const now: Totals = result.modelUsage && typeof result.modelUsage === 'object' ? result.modelUsage : {};
  const records: UsageRecord[] = [];
  for (const [model, u] of Object.entries(now)) {
    const b = baseline[model] ?? {};
    const d = (k: keyof Totals[string]) => Number(u?.[k] ?? 0) - Number(b[k] ?? 0);
    const t = { input: d('inputTokens'), output: d('outputTokens'), cacheRead: d('cacheReadInputTokens'), cacheWrite: d('cacheCreationInputTokens') };
    if (Object.values(t).some((n) => n < 0 || !Number.isFinite(n))) return null;
    if (!t.input && !t.output && !t.cacheRead && !t.cacheWrite) continue;
    records.push({
      sessionId: facts.sessionId,
      messageId: `compact:${boundary}${Object.keys(now).length > 1 ? `:${model}` : ''}`,
      at, model, ...t, thinking: null, cost: callCost(model, t),
      project: facts.project, role: facts.role, team: facts.team, subagent: null, branch: facts.branch,
      account: facts.account ?? 'default', trigger: facts.trigger, machine: MACHINE, kind: 'compaction',
    });
  }
  return records;
}
