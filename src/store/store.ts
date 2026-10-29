// Reads and writes for sessions, messages and permissions.
import type { DatabaseSync } from 'node:sqlite';
import type { LimitRecord, UsageRecord } from '../usage/recorder.ts';
import type {
  LimitInfo,
  GrantInfo,
  PermissionInfo,
  PermissionStatus,
  AttachedSource,
  ConversationLine,
  OriginalQuestion,
  QuestionInfo,
  QuestionShot,
  SessionInfo,
  SessionStatus,
  StoredMessage,
  TurnResource,
} from '../shared/protocol.ts';
import type { IdleFacts } from '../sessions/idle.ts';
import type { AwayRecord } from '../sessions/away.ts';
import { isAskUser, quietTexts, type TurnEntry } from '../shared/quiet-reply.ts';
import { elevates, raisesUac } from '../shared/elevation.ts';
import type { QuestionDetails } from '../shared/questions.ts';
import { trimForStorage } from './trim.ts';
import { exercisedLine } from '../platform/exercised.ts';

type Row = Record<string, any>;

/** Permission rows with their session's runner, which decides whether an elevation raises UAC here (#213). */
const PERMISSION_ROWS = 'SELECT *, (SELECT runner FROM sessions WHERE sessions.id = permissions.session_id) AS session_runner FROM permissions';

function toSession(r: Row): SessionInfo {
  return {
    id: r.id,
    project: r.project,
    runner: r.runner,
    title: r.title,
    status: r.status,
    role: r.role ?? 'session',
    permissionMode: r.permission_mode ?? 'default',
    claudeSessionId: r.claude_session_id ?? null,
    model: r.model ?? null,
    claudeVersion: r.claude_version ?? null,
    claudeProgram: r.claude_program ? JSON.parse(r.claude_program) : null,
    cwd: r.cwd ?? null,
    createdAt: Number(r.created_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    endReason: r.end_reason ?? null,
    parentId: r.parent_id ?? null,
    backgroundTasks: 0,
    remoteControl: null,
    branch: r.branch ?? null,
    contextTokens: r.context_tokens == null ? null : Number(r.context_tokens),
    contextWindow: r.context_window == null ? null : Number(r.context_window),
    pr: r.pr ? JSON.parse(r.pr) : null,
    tickets: [],
    priority: r.priority ?? 'normal',
    priorityNote: r.priority_note ?? null,
    paused: !!r.paused,
    queuedAt: r.queued_at == null ? null : Number(r.queued_at),
    account: r.account ?? null,
    requestedModel: r.requested_model ?? null,
    profile: r.profile ?? null,
    clearDue: r.clear_due == null ? null : Number(r.clear_due),
    clearedAt: r.cleared_at == null ? null : Number(r.cleared_at),
    compacting: r.compacting ? JSON.parse(r.compacting) : null,
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    position: r.position == null ? null : Number(r.position),
    workDir: r.work_dir ?? null,
    statusSince: r.status_since == null ? null : Number(r.status_since),
    uac: raisesUac(r.runner, process.platform),
  };
}

function toMessage(r: Row): StoredMessage {
  return { id: Number(r.id), sessionId: r.session_id, at: Number(r.at), kind: r.kind, data: JSON.parse(r.data) };
}

function toPermission(r: Row): PermissionInfo {
  const input = JSON.parse(r.input);
  return {
    id: r.id,
    sessionId: r.session_id,
    at: Number(r.at),
    toolName: r.tool_name,
    input,
    title: r.title ?? null,
    reason: r.reason ?? null,
    status: r.status,
    addressedTo: r.addressed_to ?? 'user',
    sensitive: r.sensitive ?? null,
    scope: r.scope ?? null,
    decidedBy: r.decided_by ?? null,
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    message: r.message ?? null,
    uac: raisesUac(r.session_runner, process.platform) && elevates(r.tool_name, input),
  };
}

function toQuestion(r: Row): QuestionInfo {
  return {
    id: Number(r.id),
    sessionId: r.session_id,
    askedAt: Number(r.asked_at),
    question: r.question,
    options: r.options ? JSON.parse(r.options) : null,
    addressedTo: r.addressed_to,
    status: r.status,
    answer: r.answer ?? null,
    answeredAt: r.answered_at == null ? null : Number(r.answered_at),
    answeredBy: r.answered_by ?? null,
    deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
    withdrawnReason: r.withdrawn_reason ?? null,
    aboutQuestion: r.about_question == null ? null : Number(r.about_question),
    forwardedFrom: r.forwarded_from == null ? null : Number(r.forwarded_from),
    aboutRequest: r.about_request ?? null,
    details: r.details ? JSON.parse(r.details) : null,
    shots: r.shots ? JSON.parse(r.shots) : null,
    original: null,
    earlier: r.earlier ? JSON.parse(r.earlier) : null,
    sources: r.sources ? JSON.parse(r.sources) : null,
  };
}

let originalExercised = false;

export interface InboxItem {
  id: number;
  sessionId: string;
  createdAt: number;
  /** 'ledung', 'manager:<id>' (from its manager, or another manager). */
  source: string;
  text: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** The database itself, for the other stores that share it (projects). */
  get database(): DatabaseSync {
    return this.db;
  }

  createSession(
    s: Pick<SessionInfo, 'id' | 'project' | 'runner' | 'title' | 'parentId' | 'permissionMode'> & { role?: SessionInfo['role']; requestedModel?: string | null; profile?: string | null; workDir?: string | null },
  ): SessionInfo {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (id, project, runner, title, status, permission_mode, created_at, status_since, parent_id, role, requested_model, profile, work_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.project, s.runner, s.title, 'starting', s.permissionMode, now, now, s.parentId, s.role ?? 'session', s.requestedModel ?? null, s.profile ?? null, s.workDir ?? null);
    return this.getSession(s.id)!;
  }

  getSession(id: string): SessionInfo | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return r ? toSession(r) : undefined;
  }

  listSessions(): SessionInfo[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all().map(toSession);
  }

  /** Sessions dragged into this order among their siblings in the sidebar (issue #88): 0, 1, 2, … */
  setSessionOrder(ids: string[]): void {
    const set = this.db.prepare('UPDATE sessions SET position = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      ids.forEach((id, i) => set.run(i, id));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  updateSession(
    id: string,
    fields: Partial<Pick<SessionInfo,
      'status' | 'title' | 'permissionMode' | 'claudeSessionId' | 'model' | 'claudeVersion' | 'claudeProgram' | 'cwd' | 'endedAt' | 'endReason' | 'branch' | 'contextTokens' | 'contextWindow' | 'pr'
      | 'priority' | 'priorityNote' | 'paused' | 'queuedAt' | 'account' | 'archivedAt' | 'clearDue' | 'clearedAt' | 'compacting'>>,
  ): void {
    const columns: Record<string, string> = {
      pr: 'pr',
      priority: 'priority',
      account: 'account',
      archivedAt: 'archived_at',
      clearDue: 'clear_due',
      clearedAt: 'cleared_at',
      compacting: 'compacting',
      priorityNote: 'priority_note',
      paused: 'paused',
      queuedAt: 'queued_at',
      branch: 'branch',
      contextTokens: 'context_tokens',
      contextWindow: 'context_window',
      status: 'status',
      title: 'title',
      permissionMode: 'permission_mode',
      claudeSessionId: 'claude_session_id',
      model: 'model',
      claudeVersion: 'claude_version',
      claudeProgram: 'claude_program',
      cwd: 'cwd',
      endedAt: 'ended_at',
      endReason: 'end_reason',
    };
    const entries = Object.entries(fields).filter(([k]) => k in columns);
    if (entries.length === 0) return;
    // A status that changes restarts its clock (issue #265); the same status set again keeps it.
    const since = fields.status !== undefined ? ', status_since = CASE WHEN status IS ? THEN status_since ELSE ? END' : '';
    const sql = `UPDATE sessions SET ${entries.map(([k]) => `${columns[k]} = ?`).join(', ')}${since} WHERE id = ?`;
    const values = entries.map(([k, v]) => ((k === 'pr' || k === 'compacting' || k === 'claudeProgram') && v ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v ?? null) as string | number | null);
    if (since) values.push(fields.status!, Date.now());
    this.db.prepare(sql).run(...values, id);
  }

  /** What one turn used (step 6c). */
  addTurnResource(t: TurnResource & { project: string; role: string; cpuSeconds: number; samples: number }): void {
    this.db
      .prepare(`INSERT INTO turn_resources (session_id, project, role, model, trigger, started_at, duration_ms, cpu_seconds, peak_cores, peak_mem, samples, commands)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.sessionId, t.project, t.role, t.model, t.trigger, t.startedAt, Math.round(t.durationMs), t.cpuSeconds, t.peakCores, Math.round(t.peakMem), t.samples, JSON.stringify(t.commands));
  }

  /** Turn records, newest last: one session's, or every session's since a time. */
  turnResources(where: { sessionId?: string; since?: number; role?: string }): (TurnResource & { project: string; role: string })[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (where.sessionId) { clauses.push('session_id = ?'); args.push(where.sessionId); }
    if (where.since) { clauses.push('started_at >= ?'); args.push(where.since); }
    if (where.role) { clauses.push('role = ?'); args.push(where.role); }
    const sql = `SELECT * FROM turn_resources${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY started_at`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => {
      const durationMs = Number(r.duration_ms);
      return {
        sessionId: r.session_id, project: r.project, role: r.role, model: r.model ?? null, trigger: r.trigger,
        startedAt: Number(r.started_at), durationMs,
        avgCores: durationMs > 0 ? Number(r.cpu_seconds) / (durationMs / 1000) : 0,
        peakCores: Number(r.peak_cores), peakMem: Number(r.peak_mem), commands: JSON.parse(r.commands),
      };
    });
  }

  /** Simon's messages that wait for a free place (step 6), oldest first. */
  heldMessages(id: string): string[] {
    const r = this.db.prepare('SELECT held FROM sessions WHERE id = ?').get(id) as { held: string | null } | undefined;
    return r?.held ? JSON.parse(r.held) : [];
  }

  setHeldMessages(id: string, texts: string[]): void {
    this.db.prepare('UPDATE sessions SET held = ? WHERE id = ?').run(texts.length ? JSON.stringify(texts) : null, id);
  }

  /** Sessions the database still thinks are running, e.g. after Ledung was stopped abruptly. */
  markUnfinishedSessionsEnded(reason: string, except: string[] = []): number {
    const now = Date.now();
    const statuses: SessionStatus[] = ['starting', 'idle', 'queued', 'running', 'waiting', 'stopping'];
    const keep = except.length ? ` AND id NOT IN (${except.map(() => '?').join(',')})` : '';
    const result = this.db
      .prepare(`UPDATE sessions SET status = 'ended', ended_at = ?, status_since = ?, end_reason = ? WHERE status IN (${statuses.map(() => '?').join(',')})${keep}`)
      .run(now, now, reason, ...statuses, ...except);
    const keepPermissions = except.length ? ` AND session_id NOT IN (${except.map(() => '?').join(',')})` : '';
    this.db
      .prepare(`UPDATE permissions SET status = 'cancelled', decided_at = ?, decided_by = 'ledung' WHERE status = 'pending'${keepPermissions}`)
      .run(now, ...except);
    return Number(result.changes);
  }

  /** The last host sequence number stored for the session. */
  hostSeq(sessionId: string): number {
    const r = this.db.prepare('SELECT host_seq FROM sessions WHERE id = ?').get(sessionId) as { host_seq: number } | undefined;
    return Number(r?.host_seq ?? 0);
  }

  /** Starts counting host lines from zero again (a new host for the session). */
  resetHostSeq(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET host_seq = 0 WHERE id = ?').run(sessionId);
  }

  /**
   * Records that the host's line `seq` has been handled, storing `data` with it if given.
   * Both happen in one write, so a crash can never store a message without its number or the
   * other way round. Tool results are stored cut, and images without their data (issue #349, src/store/trim.ts).
   */
  addHostLine(sessionId: string, seq: number, at: number, data: unknown | null): StoredMessage | null {
    this.db.exec('BEGIN');
    try {
      const r = data === null
        ? undefined
        : this.db.prepare('INSERT INTO messages (session_id, at, kind, data, seq) VALUES (?, ?, ?, ?, ?) RETURNING *')
            .get(sessionId, at, 'sdk', JSON.stringify(trimForStorage(data)), seq);
      this.db.prepare('UPDATE sessions SET host_seq = ? WHERE id = ? AND host_seq < ?').run(seq, sessionId, seq);
      this.db.exec('COMMIT');
      return r ? toMessage(r) : null;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addMessage(sessionId: string, kind: StoredMessage['kind'], data: unknown, at = Date.now()): StoredMessage {
    const r = this.db
      .prepare('INSERT INTO messages (session_id, at, kind, data) VALUES (?, ?, ?, ?) RETURNING *')
      .get(sessionId, at, kind, JSON.stringify(data));
    return toMessage(r!);
  }

  /**
   * The newest `limit` messages of a session, oldest first; with `beforeId`, the ones before it; with `afterId`,
   * the first `limit` after it, so a page that reconnects adds what it missed instead of reloading (issue #178).
   */
  listMessages(sessionId: string, opts: { beforeId?: number; afterId?: number; limit?: number } = {}): StoredMessage[] {
    const limit = Math.min(opts.limit ?? 500, 5000);
    if (opts.afterId) {
      return this.db.prepare('SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(sessionId, opts.afterId, limit).map(toMessage);
    }
    const rows = opts.beforeId
      ? this.db.prepare('SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(sessionId, opts.beforeId, limit)
      : this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit);
    return rows.map(toMessage).reverse();
  }

  /** The session's replies stored from `from` until before `to`, oldest first: a source named by its time (issue #369). */
  repliesBetween(sessionId: string, from: number, to: number): StoredMessage[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? AND kind = 'sdk' AND at >= ? AND at < ? AND data LIKE '{"type":"assistant"%' ORDER BY id LIMIT 200`)
      .all(sessionId, from, to).map(toMessage);
  }

  /** When the session's latest user message was stored (issue #265); null: none yet. */
  lastUserMessageAt(sessionId: string): number | null {
    const r = this.db.prepare(`SELECT MAX(at) AS at FROM messages WHERE session_id = ? AND kind = 'user'`).get(sessionId) as { at: number | null } | undefined;
    return r?.at == null ? null : Number(r.at);
  }

  /**
   * The session's own last call of one of the tools `names` (not a subagent's), with its result's text, or null
   * (the Files pane finds the worktree a session entered this way, issue #225). Newest twenty candidates only.
   */
  lastToolCall(sessionId: string, names: readonly string[]): { name: string; input: Record<string, unknown>; result: string | null; isError: boolean } | null {
    const likes = names.map(() => 'data LIKE ?').join(' OR ');
    const rows = this.db
      .prepare(`SELECT data FROM messages WHERE session_id = ? AND kind = 'sdk' AND data LIKE '{"type":"assistant"%' AND (${likes}) ORDER BY id DESC LIMIT 20`)
      .all(sessionId, ...names.map((n) => `%"name":"${n}"%`)) as { data: string }[];
    for (const row of rows) {
      const m = JSON.parse(row.data);
      if (m.parent_tool_use_id != null) continue;
      const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
      const call = [...blocks].reverse().find((b: any) => b?.type === 'tool_use' && names.includes(b.name));
      if (!call) continue;
      const res = this.db
        .prepare(`SELECT data FROM messages WHERE session_id = ? AND kind = 'sdk' AND data LIKE '{"type":"user"%' AND data LIKE ? ORDER BY id DESC LIMIT 1`)
        .get(sessionId, `%"tool_use_id":"${String(call.id).replace(/[%"\\]/g, '')}"%`) as { data: string } | undefined;
      const block = res ? (JSON.parse(res.data).message?.content ?? []).find?.((b: any) => b?.type === 'tool_result' && b.tool_use_id === call.id) : null;
      const content = block?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : null;
      return { name: call.name, input: call.input ?? {}, result: text, isError: block?.is_error === true };
    }
    return null;
  }

  /**
   * Records a model call. Streamed replies repeat a call's id with growing output, so a repeat keeps
   * the largest figures instead of adding a second record.
   */
  addUsage(u: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage (session_id, message_id, at, model, input, cache_write, cache_read, output, thinking, cost, project, role, team, subagent, branch, trigger, machine, account, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, message_id) DO UPDATE SET
           input = MAX(input, excluded.input), cache_write = MAX(cache_write, excluded.cache_write),
           cache_read = MAX(cache_read, excluded.cache_read), output = MAX(output, excluded.output),
           thinking = COALESCE(thinking, excluded.thinking), cost = MAX(COALESCE(cost, 0), COALESCE(excluded.cost, 0))`,
      )
      .run(u.sessionId, u.messageId, u.at, u.model, u.input, u.cacheWrite, u.cacheRead, u.output, u.thinking, u.cost,
        u.project, u.role, u.team, u.subagent, u.branch, u.trigger, u.machine, u.account ?? 'default', u.kind ?? 'call');
  }

  /** The session's smallest main-thread call (its fixed part plus a first message), for the context figure after a compact. */
  smallestCall(sessionId: string): number | null {
    const r = this.db.prepare("SELECT MIN(input + cache_read + cache_write) AS n FROM usage WHERE session_id = ? AND subagent IS NULL AND kind = 'call'").get(sessionId) as { n: number | null };
    return r.n == null ? null : Number(r.n);
  }

  /**
   * Keeps a plan-limit status if it differs from the last one of its kind; one that doesn't only notes that it was
   * seen again, so the page can say how old the figures are (issue #360). Returns true if the page should hear of it:
   * kept, or seen again in a later minute than it was last, so a busy account sends the list about once a minute
   * instead of on every reply.
   */
  addLimit(l: LimitRecord): boolean {
    const account = l.account ?? 'default';
    const last = this.db.prepare('SELECT id, at, seen_at, status, utilization, resets_at FROM limits WHERE kind = ? AND account = ? ORDER BY id DESC LIMIT 1').get(l.kind, account) as
      | { id: number; at: number; seen_at: number | null; status: string; utilization: number | null; resets_at: number | null }
      | undefined;
    if (last && last.status === l.status && last.utilization === l.utilization && last.resets_at === l.resetsAt) {
      const seen = Number(last.seen_at ?? last.at);
      if (l.at <= seen) return false;
      this.db.prepare('UPDATE limits SET seen_at = ? WHERE id = ?').run(l.at, last.id);
      // Once per clock minute: measured from the previous confirmation instead, steady notices under a minute apart
      // would never reach the page (review of #361, Important 1).
      return Math.floor(l.at / 60_000) > Math.floor(seen / 60_000);
    }
    this.db.prepare('INSERT INTO limits (at, kind, status, utilization, resets_at, data, account) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(l.at, l.kind, l.status, l.utilization, l.resetsAt, JSON.stringify(l.data), account);
    return true;
  }

  /** The latest state of each kind of limit, per account. */
  latestLimits(): LimitInfo[] {
    return (this.db.prepare(
      `SELECT l.* FROM limits l JOIN (SELECT account, kind, MAX(id) AS id FROM limits GROUP BY account, kind) last ON last.id = l.id ORDER BY l.account, l.kind`,
    ).all() as Record<string, any>[]).map((r) => ({
      account: r.account ?? 'default', kind: r.kind, status: r.status, utilization: r.utilization ?? null, resetsAt: r.resets_at == null ? null : Number(r.resets_at), at: Number(r.at),
      seenAt: Number(r.seen_at ?? r.at),
    }));
  }

  /** The first lines of a session's last reply, and when (for the Overview). The short line after ask_user is
   *  not a reply: the question is shown instead (decisions, 2026-10-12). */
  lastReply(sessionId: string): { text: string; at: number } | null {
    const rows = this.db
      .prepare(`SELECT at, kind, data FROM messages WHERE session_id = ? AND (kind = 'user' OR (kind = 'sdk' AND (data LIKE '{"type":"assistant"%' OR data LIKE '{"type":"result"%'))) ORDER BY id DESC LIMIT 30`)
      .all(sessionId) as { at: number; kind: string; data: string }[];
    rows.reverse();
    const entries: TurnEntry[] = [];
    const found: { text: string; at: number; question?: string }[] = [];
    for (const r of rows) {
      const m = r.kind === 'user' ? { type: 'user' } : JSON.parse(r.data);
      if (m.type !== 'assistant') {
        entries.push({ kind: 'end' });
        found.push({ text: '', at: 0 });
        continue;
      }
      if (m.parent_tool_use_id) continue;
      for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_use') {
          entries.push({ kind: 'tool', name: b.name });
          // A structured question may have no text of its own: its title, else its issue (issue #59).
          found.push({ text: '', at: 0, question: isAskUser(b.name) ? String(b.input?.question ?? b.input?.title ?? b.input?.issue ?? '') : undefined });
        } else if (b.type === 'text' && b.text.trim()) {
          entries.push({ kind: 'text', text: b.text });
          found.push({ text: b.text.trim().slice(0, 400), at: Number(r.at) });
        }
      }
    }
    const quiet = quietTexts(entries);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.kind !== 'text') continue;
      if (!quiet.has(i)) return { text: found[i]!.text, at: found[i]!.at };
      // Hidden line: show the question it follows.
      for (let j = i - 1; j >= 0; j--) {
        const q = found[j]!.question;
        if (q) return { text: q.trim().slice(0, 400), at: found[i]!.at };
      }
    }
    return null;
  }

  usageCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n);
  }

  // Lockdown (issue #109) keeps two small records in meta, so it needs no table of its own.

  /** A manager may answer one more message from a locked project's manager: one per message it got. */
  addReplyAllowance(replierId: string, lockedId: string): void {
    const key = `lockdown-replies:${replierId}:${lockedId}`;
    this.setMeta(key, String((Number(this.getMeta(key)) || 0) + 1));
  }

  /** Uses up one allowance for this reply; false when there is none left. */
  takeReplyAllowance(replierId: string, lockedId: string): boolean {
    const key = `lockdown-replies:${replierId}:${lockedId}`;
    const left = Number(this.getMeta(key)) || 0;
    if (left <= 0) return false;
    if (left === 1) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.setMeta(key, String(left - 1));
    return true;
  }

  /** The lockdown part of the settings a session was launched with; null: not recorded (launched before lockdown). */
  launchKey(sessionId: string): string | null {
    return this.getMeta(`lockdown-launch:${sessionId}`);
  }

  setLaunchKey(sessionId: string, key: string): void {
    this.setMeta(`lockdown-launch:${sessionId}`, key);
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Every stored message of a session, oldest first (for filling in usage from history). */
  allMessages(sessionId: string): StoredMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId).map(toMessage);
  }

  createQuestion(q: {
    sessionId: string; question: string; options: string[] | null; addressedTo: string; aboutQuestion?: number | null; aboutRequest?: string | null;
    details?: QuestionDetails | null; shots?: QuestionShot[] | null; earlier?: ConversationLine[] | null; sources?: AttachedSource[] | null;
  }): QuestionInfo {
    const r = this.db
      .prepare('INSERT INTO questions (session_id, asked_at, question, options, addressed_to, status, about_question, about_request, details, shots, earlier, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(q.sessionId, Date.now(), q.question, q.options ? JSON.stringify(q.options) : null, q.addressedTo, 'open', q.aboutQuestion ?? null, q.aboutRequest ?? null,
        q.details ? JSON.stringify(q.details) : null, q.shots?.length ? JSON.stringify(q.shots) : null, q.earlier ? JSON.stringify(q.earlier) : null,
        q.sources?.length ? JSON.stringify(q.sources) : null);
    return this.withOriginal(toQuestion(r!));
  }

  /**
   * The question with the one it is about, read here so the page can show it however old it is: the page keeps
   * only the recent questions (issue #368). Only a question that went to the asker, as forward_answer requires, so
   * a number naming another project's question shows nothing of it (review of PR #373, finding 1).
   */
  private withOriginal(q: QuestionInfo): QuestionInfo {
    if (q.aboutQuestion === null) return q;
    const r = this.db.prepare('SELECT id, session_id, asked_at, question, options, details, status, sources FROM questions WHERE id = ? AND addressed_to = ?').get(q.aboutQuestion, q.sessionId);
    if (!r) return q;
    const o = toQuestion(r);
    const original: OriginalQuestion = {
      id: o.id, sessionId: o.sessionId, askedAt: o.askedAt, question: o.question, options: o.options, details: o.details, status: o.status,
      // Only when it attached some, so an original without any reads as before (issue #368).
      ...(o.sources?.length ? { sources: o.sources } : {}),
    };
    if (!originalExercised) {
      originalExercised = true;
      exercisedLine('EXERCISED #368 a question sent with the original it is about');
    }
    return { ...q, original };
  }

  /** What the last Stop hook said about background work and scheduled wake-ups (idle stop). */
  idleFacts(sessionId: string): IdleFacts | null {
    const r = this.db.prepare('SELECT idle_facts FROM sessions WHERE id = ?').get(sessionId) as { idle_facts: string | null } | undefined;
    return r?.idle_facts ? JSON.parse(r.idle_facts) : null;
  }

  setIdleFacts(sessionId: string, facts: IdleFacts): void {
    this.db.prepare('UPDATE sessions SET idle_facts = ? WHERE id = ?').run(JSON.stringify(facts), sessionId);
  }

  /** The session's own questions still waiting for an answer. */
  openQuestionCount(sessionId: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE session_id = ? AND status = 'open'`).get(sessionId) as { n: number }).n);
  }

  /** Sessions a manager started. */
  childSessions(managerId: string): SessionInfo[] {
    return this.db.prepare('SELECT * FROM sessions WHERE parent_id = ? ORDER BY created_at').all(managerId).map(toSession);
  }

  /** Puts a message in a session's inbox; Ledung delivers it when the session is free. */
  addInbox(sessionId: string, source: string, text: string): InboxItem {
    const r = this.db
      .prepare('INSERT INTO inbox (session_id, created_at, source, text) VALUES (?, ?, ?, ?) RETURNING *')
      .get(sessionId, Date.now(), source, text) as Record<string, any>;
    return { id: Number(r.id), sessionId: r.session_id, createdAt: Number(r.created_at), source: r.source, text: r.text };
  }

  undeliveredInbox(sessionId: string): InboxItem[] {
    return (this.db.prepare('SELECT * FROM inbox WHERE session_id = ? AND delivered_at IS NULL ORDER BY id').all(sessionId) as Record<string, any>[])
      .map((r) => ({ id: Number(r.id), sessionId: r.session_id, createdAt: Number(r.created_at), source: r.source, text: r.text }));
  }

  /** Rewrites a waiting inbox item, e.g. the note after a compact once its outcome is known. */
  setInboxText(id: number, text: string): void {
    this.db.prepare('UPDATE inbox SET text = ? WHERE id = ? AND delivered_at IS NULL').run(text, id);
  }

  /** Removes waiting inbox items (a note that a newer one replaces). */
  dropInbox(ids: number[]): void {
    for (const id of ids) this.db.prepare('DELETE FROM inbox WHERE id = ? AND delivered_at IS NULL').run(id);
  }

  markInboxDelivered(ids: number[]): void {
    const now = Date.now();
    for (const id of ids) this.db.prepare('UPDATE inbox SET delivered_at = ? WHERE id = ?').run(now, id);
  }

  getQuestion(id: number): QuestionInfo | undefined {
    const r = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    return r ? this.withOriginal(toQuestion(r)) : undefined;
  }

  /**
   * Open questions (oldest first), then the `recent` most recently closed ones. `refs` false leaves out the original,
   * the kept conversation and the attached sources, for Ledung's own reads that never show them and run on every
   * manager Bash call (review of PR #373, finding 3).
   */
  listQuestions(recent = 50, refs = true): QuestionInfo[] {
    const read = (r: Row) => toQuestion(refs ? r : { ...r, earlier: null, sources: null });
    const open = this.db.prepare(`SELECT * FROM questions WHERE status = 'open' ORDER BY asked_at`).all().map(read);
    const closed = this.db
      .prepare(`SELECT * FROM questions WHERE status != 'open' ORDER BY COALESCE(answered_at, asked_at) DESC LIMIT ?`)
      .all(recent)
      .map(read);
    return refs ? [...open, ...closed].map((q) => this.withOriginal(q)) : [...open, ...closed];
  }

  /**
   * Records an answer. `forwardedFrom`: the answer is the user's answer to that question, passed on
   * verbatim by a manager. `here`: the user answered on this computer, not through the public name (issue #263).
   * Returns false if the question was no longer open.
   */
  answerQuestion(id: number, answer: string, by: string, forwardedFrom: number | null = null, here = false): boolean {
    const r = this.db
      .prepare(`UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, answered_by = ?, forwarded_from = ?, answered_here = ? WHERE id = ? AND status = 'open'`)
      .run(answer, Date.now(), by, forwardedFrom, here ? 1 : 0, id);
    return Number(r.changes) === 1;
  }

  /** The user answered this question on this computer (issue #263); false for any other answer. */
  answeredHere(id: number): boolean {
    const r = this.db.prepare('SELECT answered_here FROM questions WHERE id = ?').get(id) as { answered_here: number } | undefined;
    return r?.answered_here === 1;
  }

  /** Takes up the user's word `word` for `action` in this session (issue #263): true the first time only. */
  useWord(sessionId: string, word: string, action: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO words_used (session_id, word, action, used_at) VALUES (?, ?, ?, ?)').run(sessionId, word, action, Date.now());
    return Number(r.changes) === 1;
  }

  /** The open question a manager asked about this permission request, if any (issue #51). */
  openQuestionAboutRequest(requestId: string): QuestionInfo | undefined {
    const r = this.db.prepare(`SELECT * FROM questions WHERE about_request = ? AND status = 'open'`).get(requestId);
    return r ? toQuestion(r) : undefined;
  }

  /** Returns false if the question was no longer open. */
  withdrawQuestion(id: number, reason: string): boolean {
    const r = this.db
      .prepare(`UPDATE questions SET status = 'withdrawn', withdrawn_reason = ?, answered_at = ? WHERE id = ? AND status = 'open'`)
      .run(reason, Date.now(), id);
    return Number(r.changes) === 1;
  }

  /** Answers that haven't reached their session yet, oldest first. */
  undeliveredAnswers(sessionId: string): QuestionInfo[] {
    return this.db
      .prepare(`SELECT * FROM questions WHERE session_id = ? AND status = 'answered' AND delivered_at IS NULL ORDER BY answered_at`)
      .all(sessionId)
      .map(toQuestion);
  }

  markDelivered(ids: number[]): void {
    const now = Date.now();
    for (const id of ids) this.db.prepare('UPDATE questions SET delivered_at = ? WHERE id = ?').run(now, id);
  }

  createPermission(
    p: Pick<PermissionInfo, 'id' | 'sessionId' | 'toolName' | 'input' | 'title' | 'reason'> &
      { requestId?: string | null; addressedTo?: string; sensitive?: string | null },
  ): PermissionInfo {
    this.db
      .prepare('INSERT INTO permissions (id, session_id, at, tool_name, input, title, reason, status, request_id, addressed_to, sensitive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.sessionId, Date.now(), p.toolName, JSON.stringify(p.input), p.title, p.reason, 'pending', p.requestId ?? null, p.addressedTo ?? 'user', p.sensitive ?? null);
    return this.getPermission(p.id)!;
  }

  addGrant(sessionId: string, toolName: string, ruleContent: string | undefined, grantedBy: string): void {
    this.db
      .prepare('INSERT INTO grants (session_id, tool_name, rule_content, granted_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, toolName, ruleContent ?? null, grantedBy, Date.now());
  }

  grants(sessionId: string): { toolName: string; ruleContent?: string; grantedBy: string; id: number; createdAt: number }[] {
    return (this.db.prepare('SELECT * FROM grants WHERE session_id = ? ORDER BY id').all(sessionId) as Record<string, any>[]).map((r) => ({
      id: Number(r.id), toolName: r.tool_name, ruleContent: r.rule_content ?? undefined, grantedBy: r.granted_by, createdAt: Number(r.created_at),
    }));
  }

  grantInfos(sessionId: string): GrantInfo[] {
    return this.grants(sessionId).map((g) => ({
      id: g.id, sessionId, rule: g.ruleContent ? `${g.toolName}(${g.ruleContent})` : g.toolName, grantedBy: g.grantedBy, createdAt: g.createdAt,
    }));
  }

  /** A request still waiting, by Claude Code's request id: how a request re-sent after a restart is recognised. */
  pendingPermissionByRequest(sessionId: string, requestId: string): PermissionInfo | undefined {
    const r = this.db
      .prepare(`${PERMISSION_ROWS} WHERE session_id = ? AND request_id = ? AND status = 'pending'`)
      .get(sessionId, requestId);
    return r ? toPermission(r) : undefined;
  }

  /** Withdraws the session's requests that are still waiting (it ended). Returns their ids. */
  cancelPendingPermissions(sessionId: string, reason: string): string[] {
    const rows = this.db.prepare(`SELECT id FROM permissions WHERE session_id = ? AND status = 'pending'`).all(sessionId) as { id: string }[];
    this.db
      .prepare(`UPDATE permissions SET status = 'cancelled', decided_by = 'ledung', decided_at = ?, message = ? WHERE session_id = ? AND status = 'pending'`)
      .run(Date.now(), reason, sessionId);
    return rows.map((r) => r.id);
  }

  getPermission(id: string): PermissionInfo | undefined {
    const r = this.db.prepare(`${PERMISSION_ROWS} WHERE id = ?`).get(id);
    return r ? toPermission(r) : undefined;
  }

  pendingPermissions(): PermissionInfo[] {
    return this.db.prepare(`${PERMISSION_ROWS} WHERE status = 'pending' ORDER BY at`).all().map(toPermission);
  }

  /** Records a decision. Returns false if the request was no longer pending. */
  decidePermission(
    id: string, status: Exclude<PermissionStatus, 'pending'>, decidedBy: string, message: string | null, scope: 'once' | 'session' | null = null,
  ): boolean {
    const result = this.db
      .prepare(`UPDATE permissions SET status = ?, decided_by = ?, decided_at = ?, message = ?, scope = ? WHERE id = ? AND status = 'pending'`)
      .run(status, decidedBy, Date.now(), message, scope, id);
    return Number(result.changes) === 1;
  }

  /** Away mode's decision on a manager's sensitive call (issue #35). */
  addAwayRecord(r: Omit<AwayRecord, 'id'>): void {
    this.db.prepare('INSERT INTO away_log (at, session_id, kind, command, pr, repo, floors, allowed, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.at, r.sessionId, r.kind, r.command, r.pr, r.repo, JSON.stringify(r.floors), r.allowed ? 1 : 0, r.reason);
  }

  awayRecords(sessionId: string, since: number): AwayRecord[] {
    return (this.db.prepare('SELECT * FROM away_log WHERE session_id = ? AND at >= ? ORDER BY id').all(sessionId, since) as Record<string, any>[]).map((r) => ({
      id: Number(r.id), at: Number(r.at), sessionId: r.session_id, kind: r.kind, command: r.command, pr: r.pr === null ? null : Number(r.pr),
      repo: r.repo ?? null, floors: JSON.parse(r.floors), allowed: r.allowed === 1 || r.allowed === 1n, reason: r.reason,
    }));
  }
}
