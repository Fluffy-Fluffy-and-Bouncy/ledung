// Managers (step 3): where questions go, waking managers, and the manager's tools.
//
// Ownership is checked here: a manager acts only on sessions it started, answers only their
// questions, and can only forward an answer the user actually gave to one of the manager's own
// questions. Nothing a session writes can reach another session as the user's words: forwardAnswer
// copies the user's stored answer, never text the manager supplies (decision of 2026-10-10).
import type { Store } from '../store/store.ts';
import type { AttachedSource, CompactingInfo, MachineInfo, McpServerInfo,PermissionDecision, PermissionInfo, PermissionMode, Priority, ProjectInfo, QuestionInfo, QuestionShot, ServerEvent, ShotVerdict, SessionInfo } from '../shared/protocol.ts';
import { parseProject, type ProjectConfig, type WorkflowConfig } from '../config.ts';
import type { NewProjectArgs, ProjectArgs } from './tools.ts';
import { describeRule, ruleMatches, type GrantRule } from './grants.ts';
import { oneLine } from '../shared/shots.ts';
import { checkTier, reviewAnswerProblem, tiersOf, type QuestionDetails, type ReviewEvidence } from '../shared/questions.ts';
import { CONTEXT_SENTENCE } from '../shared/delivery.ts';
import { contextSize } from '../shared/context-size.ts';
import { lockdownOf, type LockdownLevel } from '../projects/lockdown.ts';
import { applyPatch, changedFields, looseningChanges, looseningRule, parsePatch, patchKey, projectConfigProblem, SETTINGS_FIELDS, settingsView, type SettingsPatch } from '../projects/settings-tools.ts';
import { formatServers } from './mcp.ts';
import type { LinkedComputer } from '../remote/linked.ts';
import type { RelayAdminView, RelayInviteInfo } from '../shared/protocol.ts';
import type { ComputerInfo } from '../shared/computers.ts';
import { USAGE_REPO, type UsagePublishChange, type UsagePublishView } from '../shared/published-usage.ts';
import { stateFor } from './elapsed.ts';

/** What managers need of the linked computers (#245): who they are, and one call to one of them. */
export interface LinkedPort {
  list(): LinkedComputer[];
  callLinked(id: string, route: string, body: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/**
 * Settings' page-only actions for managers (issue #263): the same calls Settings' routes make, set by the server.
 * Nothing secret comes back: the admin key and the Cloudflare token stay in the data folder (the view has a hash
 * and a yes/no); codes come back because they are meant to be pasted on another computer. Throws with the reason.
 */
export interface SettingsPort {
  relay(): RelayAdminView;
  setRelay(relay: string): RelayAdminView;
  makeAdminKey(): RelayAdminView;
  invite(owner: string, name?: string): Promise<RelayInviteInfo & { code: string }>;
  linkCode(): { code: string; expiresAt: number };
  link(code: string, name?: string): Promise<LinkedComputer>;
  /** The linked computers, and why linking is not possible here (null: it is). */
  links(): { problem: string | null; links: LinkedComputer[] };
  computers(): ComputerInfo[];
  /** Publishing usage on this computer (issue #376); left out or null: not available here. */
  usagePublish?(): UsagePublishView | null;
  /** The page's own switch (Settings → Claude & usage → Publish usage), without its sign-in. */
  configureUsagePublish?(next: UsagePublishChange): Promise<UsagePublishView>;
}

/** A message from a manager on a linked computer, as /link/message carries it. */
export interface LinkedMessage { fromId: string; fromTitle: string; fromProject: string; fromLocked: boolean; toId: string; text: string }

// Limits between computers (docs/steps/manager-link.md, "Loops and floods"); messages on one computer have none.
export const LINK_MAX_CHARS = 4000;
export const LINK_SENDS_PER_HOUR = 20;
export const LINK_WAKES_PER_HOUR = 6;
export const LINK_BURST_MS = 5000;
/** How long list_managers waits for each linked computer before calling it offline. */
export const LINK_LIST_MS = 3000;
const HOUR_MS = 3600_000;

export interface ManagementContext {
  store: Store;
  userName: string;
  publish(event: ServerEvent): void;
  /** Delivers the session's waiting answers and inbox if it is free. */
  wake(sessionId: string): void;
  /** Starts an ended session again; what waits for it is delivered once it is up (idle stop and archive). */
  resume(sessionId: string): Promise<void>;
  startSession(project: string, task: string, opts: { parentId: string; title?: string; permissionMode?: PermissionMode; model?: string; profile?: string; cwd?: string }): Promise<SessionInfo>;
  /** Why the project's workflow profiles file can't be used, or null (#298); the start_session reply says so. */
  profilesWarning?(project: string): string | null;
  /** reason: who stopped it, recorded as the session's end reason (issue #17). */
  stopSession(id: string, reason: string): Promise<void>;
  /** Archives an ended session; `by` is recorded, e.g. 'manager "Manager: p"'. */
  archiveSession(id: string, by: string): void;
  projectNames(): string[];
  /** Passes a decision to the live session waiting on the request. False if it no longer waits. */
  decidePermission(permissionId: string, decision: PermissionDecision, by: string): boolean;
  /** Step 6: the machine as measured now, and changes to a session's place in line. */
  machine(): MachineInfo;
  setPriority(id: string, priority: Priority, note: string | null, by: string): void;
  setPaused(id: string, paused: boolean, by: string): void;
  /**
   * A running session's MCP servers, and reconnecting one (issue #118); the error says why not. Left out
   * where nothing can reach a live session (tests of other parts): the tools then say it is unavailable.
   */
  mcp?: {
    servers(id: string): Promise<McpServerInfo[]>;
    reconnect(id: string, name: string, by: string): Promise<McpServerInfo[]>;
  };
  /** Projects (issue #37): the same calls the page makes. */
  projects(): ProjectInfo[];
  addProject(config: ProjectConfig): ProjectInfo;
  createProject(opts: { parent?: string; github: boolean; settings: ProjectConfig }): Promise<{ project: ProjectInfo; warning: string | null; githubUrl: string | null }>;
  /** The project's manager, started (with no message) if it has none that can be reached. */
  ensureManager(project: string): Promise<string>;
  /**
   * Projects' workflow settings for project_settings and set_project_settings (issue #306): the stored settings,
   * the configured workflows and the page's own save. Left out: the tools say they are not available.
   */
  projectSettings?: {
    config(name: string): ProjectConfig | null;
    workflows(): WorkflowConfig[];
    /** What update would refuse, checked without saving; throws with the reason. */
    check(name: string, config: ProjectConfig): void;
    update(name: string, config: ProjectConfig): ProjectInfo;
  };
  /** The clock for the limits between computers; tests move it. Default: Date.now. */
  now?(): number;
  /** The person's other Ledungs this one is linked with (#245); null or left out: none. */
  linked?(): LinkedPort | null;
  /** Settings' page-only actions (issue #263); null or left out: not available. */
  settings?(): SettingsPort | null;
  /** Why a session's handoff file can't be used for its clear (clear_self), or null if it can. */
  handoffProblem(sessionId: string, file: string): string | null;
  /**
   * A screenshot's path relative to the session's project folder, after the file viewer's checks (inside
   * the folder, a real PNG or JPEG); throws with the reason otherwise (issue #60).
   */
  shotPath(sessionId: string, file: string): string;
  /**
   * A review's evidence file (docs/steps/pr-review.md), checked as a board attachment is (inside the folder
   * or the board cache, its kind by its first bytes, its size): its path as stored and its kind; throws with
   * the reason otherwise. Left out in tests of other parts: a review with evidence is then refused.
   */
  evidenceFile?(sessionId: string, file: string): { file: string; kind: 'image' | 'text' };
}

/** A screenshot as ask_user takes it (issue #60). */
export interface ShotInput {
  file: string;
  group?: string;
  look_for: string;
  done_when?: string;
  facts?: string[];
  opinions?: { who: string; text: string; verdict?: ShotVerdict }[];
}

export class ManagementError extends Error {}

/** A fetched source in a few words, for a manager's note (issue #369). */
function sourceLabel(s: AttachedSource): string {
  if ('error' in s) return s.named;
  if (s.kind === 'reply') return `a reply of ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (s.kind === 'comment') return `the ${s.what} ${s.url}`;
  return `question #${s.question.id}`;
}

/** The fixed answers to a manager's question about a request (issue #51). */
export const ALLOW_ONCE = 'Allow once';
export const DENY = 'Deny';

/** Only the "Allow once" answer allows; any other denies, with the user's words as the reason. */
export function decisionFromAnswer(answer: string, userName: string): PermissionDecision {
  const a = answer.trim();
  if (a.toLowerCase() === ALLOW_ONCE.toLowerCase()) return { behavior: 'allow', scope: 'once' };
  return { behavior: 'deny', message: a.toLowerCase() === DENY.toLowerCase() ? `${userName} denied this.` : `${userName} denied this: ${a}` };
}

/**
 * A title inside the part of a question Ledung writes: one line, no Markdown that could fake a block
 * (titles are chosen by managers, so one could otherwise add a second "Command" above the real one;
 * review of PR #53).
 */
export function plainTitle(title: string): string {
  return title.replace(/[`*_\[\]<>#|~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * The request as the user must see it before allowing it, in a code block no input can close. A
 * command, and anything in a sensitive request, is never cut, since "Allow once" allows all of it
 * (Martin, 2026-10-13, questions #72 and #80); other input (an ordinary file's content) is cut at `limit`.
 */
export function requestText(p: Pick<PermissionInfo, 'toolName' | 'input'> & { sensitive?: string | null }, limit = 4000): string {
  const bash = p.toolName === 'Bash';
  let body = bash ? String(p.input.command ?? '') : JSON.stringify(p.input, null, 2);
  let cut = '';
  if (!bash && !p.sensitive && body.length > limit) {
    cut = `\n\n(${body.length - limit} more characters not shown; the whole request is in the session's chat.)`;
    body = body.slice(0, limit);
  }
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${bash ? 'Command' : `Tool ${p.toolName}`}:\n\n${fence}\n${body}\n${fence}${cut}`;
}

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** A message from another computer, cut at the limit with a note (manager-link.md, "Loops and floods"). */
const cut = (text: string) => (text.length > LINK_MAX_CHARS
  ? `${text.slice(0, LINK_MAX_CHARS)}\n\n[cut by Ledung: ${text.length - LINK_MAX_CHARS} more characters; ask for the rest in parts]`
  : text);

export class Management {
  private readonly ctx: ManagementContext;

  constructor(ctx: ManagementContext) {
    this.ctx = ctx;
  }

  private get store(): Store {
    return this.ctx.store;
  }

  title(sessionId: string): string {
    return this.store.getSession(sessionId)?.title ?? 'an unknown session';
  }

  /** The manager that started this session, if any. */
  managerOf(sessionId: string): SessionInfo | undefined {
    const parentId = this.store.getSession(sessionId)?.parentId;
    const parent = parentId ? this.store.getSession(parentId) : undefined;
    return parent?.role === 'manager' ? parent : undefined;
  }

  /** Who a session's question goes to: its manager, or the user. */
  addresseeFor(sessionId: string): string {
    return this.managerOf(sessionId)?.id ?? 'user';
  }

  /**
   * Hands the session what waits for it: wakes it, or resumes it first if it has ended, so a message
   * or answer to a stopped session is never left waiting for a Resume click. True if it was resumed.
   */
  private async reach(sessionId: string): Promise<boolean> {
    if (this.store.getSession(sessionId)?.status !== 'ended') {
      this.ctx.wake(sessionId);
      return false;
    }
    try {
      await this.ctx.resume(sessionId);
    } catch (e) {
      throw new ManagementError(`It is kept for the session, but the session could not be resumed: ${(e as Error).message}`);
    }
    return true;
  }

  private tell(sessionId: string, source: string, text: string): void {
    this.store.addInbox(sessionId, source, text);
    this.ctx.wake(sessionId);
  }

  // --- events from sessions -------------------------------------------------------------------

  onQuestionAsked(q: QuestionInfo): void {
    if (q.addressedTo === 'user') return;
    const options = q.options ? `\n\nSuggested answers: ${q.options.map((o) => `"${o}"`).join(', ')}` : '';
    // Its attached sources travel with it (issue #369, decision a on PR #378's review): said here, so the manager
    // knows the original box on its own question will show them and it need not copy them.
    const attached = (q.sources ?? []).filter((s) => !('error' in s));
    const sources = attached.length
      ? `\n\nIt attached ${attached.length === 1 ? 'a source' : `${attached.length} sources`} (${attached.map(sourceLabel).join('; ')}). ` +
        `When you ask with about_question: ${q.id}, ${this.ctx.userName} sees them word for word in its "Original question" box, so you need not copy them.`
      : '';
    this.tell(
      q.addressedTo,
      'ledung',
      `Ledung: session "${this.title(q.sessionId)}" (${q.sessionId}) asked question #${q.id}:\n\n${q.question}${options}${sources}\n\n` +
        `Answer it with answer_question if your standing grant covers it; otherwise ask ${this.ctx.userName} with ask_user (about_question: ${q.id}) and pass the answer on with forward_answer.`,
    );
  }

  /**
   * A turn ended. `pause` (why the session is not done: background work or a wake-up, see pauseReason):
   * the note waits in the manager's inbox without waking it, and the next turn end replaces it. Nothing
   * running means the session is done or waits for someone, so the manager is woken (decided 2026-10-13).
   */
  onTurnFinished(sessionId: string, lastReply: string, pause: string | null = null): void {
    const manager = this.managerOf(sessionId);
    if (!manager) return;
    const source = `${TURN_NOTE_SOURCE}:${sessionId}`;
    this.store.dropInbox(this.store.undeliveredInbox(manager.id).filter((i) => i.source === source).map((i) => i.id));
    const reply = `Its last reply began:\n\n${short(lastReply, 600) || '(no text)'}`;
    const who = `Ledung: session "${this.title(sessionId)}" (${sessionId})`;
    if (pause) this.store.addInbox(manager.id, source, `${who} finished a turn, but ${pause}, so it is not done; you are woken when it is. ${reply}`);
    else this.tell(manager.id, source, `${who} finished a turn with nothing running: it is done or waits for someone. ${reply}`);
  }

  /**
   * `quiet` (an idle stop): the note waits for the manager's next message instead of waking it, since
   * nothing needs doing and a message to the session resumes it (docs/steps/idle-stop-and-archive.md).
   */
  onEnded(sessionId: string, reason: string, quiet = false): void {
    const manager = this.managerOf(sessionId);
    if (!manager) return;
    const text = `Ledung: session "${this.title(sessionId)}" (${sessionId}) ended: ${reason}`;
    if (quiet) this.store.addInbox(manager.id, 'ledung', `${text} A message to it resumes it.`);
    else this.tell(manager.id, 'ledung', text);
  }

  /** A session has waited for a free place for a while (step 6). */
  onWaitingLong(sessionId: string, minutes: number, place: number): void {
    const manager = this.managerOf(sessionId);
    if (!manager) return;
    this.tell(manager.id, 'ledung',
      `Ledung: session "${this.title(sessionId)}" (${sessionId}) has waited ${minutes} minutes for a free place; it is number ${place} in line. ` +
      'machine_status shows the line; set_priority can move it ahead.');
  }

  /**
   * The user answered a question. One a manager asked about a permission request (issue #51) decides
   * that request with the user's stored answer, never with anything the manager wrote.
   */
  onUserAnswered(q: QuestionInfo): void {
    if (q.aboutRequest) this.applyUserAnswer(q);
    if (q.addressedTo === 'user') return;
    this.tell(q.addressedTo, 'ledung', `Ledung: ${this.ctx.userName} answered question #${q.id} from "${this.title(q.sessionId)}" directly: ${q.answer}`);
  }

  /**
   * A grant that covers this request: the session's own, or one the user gave its manager's session,
   * which carries down to the sessions the manager started (want 13). Grants a manager gave never
   * carry further. Sensitive requests are checked before this and never reach it.
   */
  grantFor(sessionId: string, toolName: string, input: Record<string, unknown>): { rule: string; grantedBy: string } | null {
    const own = this.store.grants(sessionId);
    const manager = this.managerOf(sessionId);
    const inherited = manager ? this.store.grants(manager.id).filter((g) => g.grantedBy === 'user') : [];
    for (const g of [...own, ...inherited]) {
      const rule: GrantRule = { toolName: g.toolName, ruleContent: g.ruleContent };
      if (ruleMatches(rule, toolName, input)) {
        const via = own.includes(g) ? '' : ` (carried down from manager "${manager!.title}")`;
        return { rule: describeRule(rule) + via, grantedBy: g.grantedBy };
      }
    }
    return null;
  }

  /** A prompt from one of a manager's sessions: wake the manager. */
  onPermissionAsked(p: PermissionInfo): void {
    if (p.addressedTo === 'user') return;
    const what = p.toolName === 'Bash' ? `run: ${String(p.input.command ?? '')}` : `use ${p.toolName}: ${JSON.stringify(p.input).slice(0, 300)}`;
    if (p.sensitive) {
      this.tell(
        p.addressedTo,
        'ledung',
        `Ledung: session "${this.title(p.sessionId)}" (${p.sessionId}) asks permission for a sensitive call (${p.sensitive}), to ${what}\n` +
          `Request ${p.id}${p.reason ? `; reason given: ${p.reason}` : ''}. The session waits until it is decided. ` +
          `Only ${this.ctx.userName} can allow it: ask with ask_user, giving about_request: "${p.id}" and a short note on why it is needed. ` +
          `Ledung writes the question with the exact request and applies ${this.ctx.userName}'s answer itself. You may deny it with decide_permission.`,
      );
      return;
    }
    this.tell(
      p.addressedTo,
      'ledung',
      `Ledung: session "${this.title(p.sessionId)}" (${p.sessionId}) asks permission to ${what}\n` +
        `Request ${p.id}${p.reason ? `; reason given: ${p.reason}` : ''}. The session waits until it is decided. ` +
        `Decide with decide_permission (scope "once", or "session" for this request and its repeats), within your standing grant; when unsure, deny with a message or ask ${this.ctx.userName}.`,
    );
  }

  /** The user decided a prompt that was addressed to a manager. */
  onUserDecidedPermission(p: PermissionInfo): void {
    if (p.addressedTo === 'user') return;
    this.tell(p.addressedTo, 'ledung', `Ledung: ${this.ctx.userName} decided request ${p.id} from "${this.title(p.sessionId)}" directly: ${p.status}.`);
  }

  // --- the manager's tools --------------------------------------------------------------------

  decidePermission(managerId: string, permissionId: string, behavior: 'allow' | 'deny', scope: 'once' | 'session', message?: string): string {
    const p = this.store.getPermission(permissionId);
    if (!p || p.addressedTo !== managerId) throw new ManagementError(`Request ${permissionId} is not from one of your sessions.`);
    if (p.status !== 'pending') throw new ManagementError(`Request ${permissionId} is already ${p.status}.`);
    // Issue #51: a sensitive request reaches the manager, but runs only on the user's own answer.
    if (p.sensitive && behavior === 'allow') {
      throw new ManagementError(
        `Request ${permissionId} is sensitive (${p.sensitive}): only ${this.ctx.userName} can allow it. ` +
          `Ask with ask_user, giving about_request: "${p.id}"; Ledung applies the answer. You may deny it.`,
      );
    }
    if (!this.ctx.decidePermission(permissionId, { behavior, scope, message }, managerId)) {
      throw new ManagementError(`Request ${permissionId} is no longer waiting.`);
    }
    return behavior === 'allow'
      ? `Allowed ${scope === 'session' ? 'for the rest of that session' : 'once'}; recorded as your decision.`
      : 'Denied; the session is told why if you gave a message.';
  }

  listPermissions(managerId: string): string {
    const waiting = this.store.pendingPermissions().filter((p) => p.addressedTo === managerId);
    if (!waiting.length) return 'No permission requests are waiting for you.';
    return waiting
      .map((p) => {
        const asked = p.sensitive ? this.store.openQuestionAboutRequest(p.id) : undefined;
        const note = p.sensitive ? ` [sensitive: ${p.sensitive}; ${asked ? `asked ${this.ctx.userName} in question #${asked.id}` : `only ${this.ctx.userName} can allow it`}]` : '';
        return `- request ${p.id} from "${this.title(p.sessionId)}": ${p.toolName} ${p.toolName === 'Bash' ? String(p.input.command ?? '') : JSON.stringify(p.input).slice(0, 200)}${note}`;
      })
      .join('\n');
  }

  /** The question tiers of a session's project (issue #96); the five when it has none of its own. */
  questionTiers(sessionId: string): string[] {
    const project = this.store.getSession(sessionId)?.project;
    return tiersOf(this.ctx.projects().find((p) => p.name === project)?.questionTiers);
  }

  /**
   * Every question needs a tier from its project's list, whoever asks (Martin, 2026-10-15, issue #96):
   * the fields with the tier as the project spells it, or a ManagementError listing the tiers.
   */
  withTier(sessionId: string, details: QuestionDetails | null): QuestionDetails {
    const r = checkTier(details?.tier, this.questionTiers(sessionId));
    if ('problem' in r) throw new ManagementError(r.problem);
    return { ...details, tier: r.tier };
  }

  /**
   * ask_user with about_request (issue #51): the question the user sees about one of the manager's
   * sessions' requests. Ledung writes the request itself, so a manager can't change or hide what would
   * run; the manager's note follows, marked as its own. The answers are fixed: see decisionFromAnswer.
   */
  requestQuestion(managerId: string, requestId: string, note: string): { question: string; options: string[] } {
    const p = this.store.getPermission(requestId);
    if (!p || p.addressedTo !== managerId) throw new ManagementError(`Request ${requestId} is not from one of your sessions. list_permissions shows them.`);
    if (p.status !== 'pending') throw new ManagementError(`Request ${requestId} is already ${p.status}.`);
    const asked = this.store.openQuestionAboutRequest(requestId);
    if (asked) throw new ManagementError(`You already asked about request ${requestId} in question #${asked.id}.`);
    const manager = plainTitle(this.title(managerId));
    const what = p.sensitive ? `a sensitive call (${p.sensitive})` : 'a call';
    const question =
      `**Session "${plainTitle(this.title(p.sessionId))}" asks permission for ${what}**, through its manager "${manager}".\n\n` +
      `${requestText(p)}\n\n` +
      `"${ALLOW_ONCE}" allows exactly this request, once. Any other answer denies it, and your words reach the session as the reason.` +
      (note.trim() ? `\n\n**Note from manager "${manager}"** (the manager's words, not Ledung's):\n\n${note.trim()}` : '');
    return { question, options: [ALLOW_ONCE, DENY] };
  }

  /**
   * ask_user's screenshots (issue #60), checked when asked so a bad one is refused with its reason while
   * the session can still fix it. A manager asking about one of its sessions' questions without
   * screenshots of its own passes that question's on, so the user judges them in the screenshot view.
   */
  screenshots(sessionId: string, shots: ShotInput[] | undefined, aboutQuestion: number | null): QuestionShot[] | null {
    if (!shots?.length) {
      const about = aboutQuestion === null ? undefined : this.store.getQuestion(aboutQuestion);
      return about?.shots && this.store.getSession(about.sessionId)?.parentId === sessionId ? about.shots : null;
    }
    return shots.map((s, i) => {
      let path: string;
      try {
        path = this.ctx.shotPath(sessionId, s.file.trim().replace(/\\/g, '/'));
      } catch (e) {
        throw new ManagementError(`Screenshot ${i + 1} (${s.file}) can't be attached: ${(e as Error).message} Nothing was asked.`);
      }
      const clean = (t: string | undefined) => t?.trim() || null;
      return {
        path,
        // One line: the group heads the strip and its shots' lines in the answer.
        group: clean(s.group && oneLine(s.group)) ?? 'Screenshots',
        lookFor: s.look_for.trim(),
        doneWhen: clean(s.done_when),
        facts: (s.facts ?? []).map((f) => f.trim()).filter(Boolean),
        opinions: (s.opinions ?? []).filter((o) => o.text.trim()).map((o) => ({ who: o.who.trim() || 'Someone', text: o.text.trim(), verdict: o.verdict ?? null })),
      };
    });
  }

  /**
   * A review's evidence files, checked when asked so a bad one is refused with its reason while the session
   * can still fix it (as screenshots, issue #60). Each keeps its caption and gets its kind.
   */
  reviewEvidence(sessionId: string, evidence: ReviewEvidence[]): ReviewEvidence[] {
    return evidence.map((e, i) => {
      try {
        if (!this.ctx.evidenceFile) throw new Error('Evidence files are not available here.');
        const checked = this.ctx.evidenceFile(sessionId, e.file.trim().replace(/\\/g, '/'));
        return { file: checked.file, caption: oneLine(e.caption), kind: checked.kind };
      } catch (err) {
        throw new ManagementError(`Evidence ${i + 1} (${e.file}) can't be attached: ${(err as Error).message} Nothing was asked.`);
      }
    });
  }

  /** A permission request stopped waiting: a question still open about it is withdrawn (issue #51). */
  onRequestClosed(requestId: string): void {
    const q = this.store.openQuestionAboutRequest(requestId);
    if (!q || !this.store.withdrawQuestion(q.id, 'The request it was about is no longer waiting.')) return;
    this.ctx.publish({ type: 'question', question: this.store.getQuestion(q.id)! });
  }

  /** Decides the request a manager's question was about with the user's stored answer to it. */
  private applyUserAnswer(q: QuestionInfo): void {
    if (q.answeredBy !== 'user' || q.answer === null || !q.aboutRequest) return;
    const p = this.store.getPermission(q.aboutRequest);
    if (!p || p.addressedTo !== q.sessionId) return;
    const decision = decisionFromAnswer(q.answer, this.ctx.userName);
    const applied = p.status === 'pending' && this.ctx.decidePermission(p.id, decision, 'user');
    const outcome = !applied
      ? `it was no longer waiting (${this.store.getPermission(p.id)?.status ?? 'gone'}), so nothing was changed`
      : decision.behavior === 'allow' ? 'it is allowed, once' : 'it is denied, with the answer as the reason';
    this.store.addInbox(q.sessionId, 'ledung', `Ledung: ${this.ctx.userName}'s answer to question #${q.id} decided request ${p.id} from "${this.title(p.sessionId)}": ${outcome}.`);
  }

  private ownSession(managerId: string, id: string): SessionInfo {
    const s = this.store.getSession(id);
    if (!s || s.parentId !== managerId) throw new ManagementError(`Session ${id} is not one you started. Use list_sessions to see yours.`);
    return s;
  }

  /** Always in the manager's own project, so its sessions use its account (decided 2026-10-11). */
  async startSession(managerId: string, args: { task: string; title?: string; permissionMode?: PermissionMode; model?: string; profile?: string; cwd?: string }): Promise<string> {
    const manager = this.store.getSession(managerId)!;
    const project = manager.project;
    if (!this.ctx.projectNames().includes(project)) throw new ManagementError(`Your project "${project}" has been removed.`);
    const s = await this.ctx.startSession(project, args.task, { parentId: managerId, title: args.title, permissionMode: args.permissionMode, model: args.model, profile: args.profile, cwd: args.cwd });
    if (s.status === 'ended') throw new ManagementError(`The session could not start: ${s.endReason ?? 'unknown reason'}`);
    const warning = this.ctx.profilesWarning?.(project);
    return `Started session "${s.title}" (${s.id}) in ${project}${s.workDir ? `, working in ${s.workDir}` : ''}, profile "${s.profile ?? 'full'}". Ledung wakes you when it asks a question, ends, or finishes a turn with nothing running.${warning ? ` Note: ${warning}` : ''}`;
  }

  /** Archived sessions are left out, with their count, so the list stays short. */
  listSessions(managerId: string): string {
    const all = this.store.childSessions(managerId);
    if (!all.length) {
      const me = this.store.getSession(managerId);
      return `You have not started any sessions.${me && contextLine(me) ? ` You${contextLine(me)}.` : ''}`;
    }
    const sessions = all.filter((s) => !s.archivedAt);
    const archived = all.length - sessions.length;
    const open = this.store.listQuestions(0).filter((q) => q.status === 'open');
    const now = Date.now();
    const lines = sessions.map((s) => {
      const questions = open.filter((q) => q.sessionId === s.id).map((q) => `#${q.id}`);
      return `- "${s.title}" (${s.id}) in ${s.project}${s.workDir ? ` (folder ${s.workDir})` : ''}: ${stateFor(s, now)}${s.status === 'ended' && s.endReason ? ` (${s.endReason})` : ''}` +
        `${contextLine(s)}${questions.length ? `; open questions ${questions.join(', ')}` : ''}`;
    });
    const me = this.store.getSession(managerId);
    if (me && contextLine(me)) lines.push(`You${contextLine(me)}.`);
    if (archived) lines.push(`${archived} archived session${archived === 1 ? '' : 's'} not listed; send_message to one resumes it.`);
    return lines.join('\n');
  }

  /** Only the manager's own sessions, and only once ended (idle stop and archive). */
  archiveSession(managerId: string, id: string): string {
    const s = this.ownSession(managerId, id);
    if (s.archivedAt) return `"${s.title}" is already archived.`;
    if (s.status !== 'ended') throw new ManagementError(`"${s.title}" is still ${s.status}. Stop it first (stop_session), then archive it.`);
    this.ctx.archiveSession(id, `manager "${this.title(managerId)}"`);
    return `Archived "${s.title}". Nothing is deleted; send_message to it resumes and unarchives it.`;
  }

  readSession(managerId: string, id: string, last = 20): string {
    this.ownSession(managerId, id);
    const lines: string[] = [];
    for (const m of this.store.listMessages(id, { limit: 400 })) {
      const time = new Date(m.at).toLocaleTimeString();
      if (m.kind === 'user') lines.push(`[${time}] ${m.data.from === 'ledung' ? 'Delivered by Ledung' : this.ctx.userName}: ${short(m.data.text, 800)}`);
      else if (m.kind === 'event') lines.push(`[${time}] (${m.data.text})`);
      else if (m.kind === 'shell') lines.push(`[${time}] ${this.ctx.userName} ran: !${short(m.data.command, 300)} (${m.data.cut ? `ended: ${m.data.cut}` : `exit code ${m.data.exitCode}`})`);
      else if (m.kind === 'sdk' && m.data.type === 'assistant' && m.data.parent_tool_use_id == null) {
        for (const b of m.data.message?.content ?? []) {
          if (b.type === 'text' && b.text.trim()) lines.push(`[${time}] Claude: ${short(b.text, 1200)}`);
          if (b.type === 'tool_use') lines.push(`[${time}] (tool: ${b.name})`);
        }
      }
    }
    const shown = lines.slice(-Math.max(1, Math.min(last, 100)));
    return shown.length ? shown.join('\n') : 'No messages yet.';
  }

  /** To an ended session too: it is resumed, then gets the message. */
  async sendMessage(managerId: string, id: string, text: string): Promise<string> {
    const s = this.ownSession(managerId, id);
    this.store.addInbox(id, `manager:${managerId}`, `Message from your manager "${this.title(managerId)}":\n\n${text}`);
    return (await this.reach(id))
      ? `"${s.title}" had ended; it is resumed and gets your message once it is up.`
      : `Sent to "${s.title}". It arrives when the session is free.`;
  }

  /**
   * Clears a session's conversation, as if the user typed /clear. Ledung only carries it out; when to
   * clear is the workflow's rule. `id` omitted: the manager itself, once its current turn ends. When the
   * session is free a countdown starts that the user can cancel in the page (the change of watch);
   * `then` is delivered into the fresh conversation, so the session knows how to pick up.
   */
  async clearSession(managerId: string, id: string | undefined, then?: string, seconds = CLEAR_SECONDS): Promise<string> {
    const self = !id || id === managerId;
    const s = self ? this.store.getSession(managerId)! : this.ownSession(managerId, id);
    const busy = this.pendingClearOrCompact(s.id);
    if (busy) return `A ${busy} of "${s.title}" is already waiting or under way; only one at a time.`;
    const wait = Math.round(Math.min(Math.max(seconds, CLEAR_MIN_SECONDS), CLEAR_MAX_SECONDS));
    this.store.addInbox(s.id, `${CLEAR_SOURCE}:${wait}:${managerId}`, self ? 'Clear requested by the session itself.' : `Clear requested by manager "${this.title(managerId)}".`);
    const note = then?.trim();
    if (note) {
      this.store.addInbox(s.id, CLEAR_NOTE_SOURCE, self
        ? `Your conversation was cleared at your own request (clear_session). Your note to yourself:

${note}`
        : `Your conversation was cleared by your manager "${this.title(managerId)}". Message from your manager:

${note}`);
    }
    const after = `${this.ctx.userName} gets ${wait} s to cancel it; you are told if they do.`;
    if (self) return `Your conversation is cleared after this turn ends${note ? ', then your note arrives' : ''}. ${after} Finish what you are doing and end your turn.`;
    return (await this.reach(s.id))
      ? `"${s.title}" had ended; it is resumed and cleared once it is up. ${after}`
      : `"${s.title}" is cleared when it is free${note ? ', then gets your message' : ''}. ${after}`;
  }

  /** The user cancelled a clear: whoever asked for it is told (the manager, or the session that asked for its own). */
  onClearCancelled(sessionId: string, requesterId: string, by: string): void {
    if (requesterId === sessionId) {
      this.store.addInbox(sessionId, 'ledung', `Ledung: ${by} cancelled the clear you asked for; your conversation is kept.`);
      if (this.store.getSession(sessionId)?.role === 'session') {
        this.quietToManager(sessionId, `Ledung: ${by} cancelled the clear session "${this.title(sessionId)}" (${sessionId}) asked for itself; its conversation is kept.`);
      }
      return;
    }
    if (!this.store.getSession(requesterId)) return;
    this.tell(requesterId, 'ledung', `Ledung: ${by} cancelled the clear of "${this.title(sessionId)}" (${sessionId}); its conversation is kept.`);
  }

  /** "clear" or "compact" if one is waiting, counting down or running for the session (one at a time, decided 2026-10-13). */
  pendingClearOrCompact(sessionId: string): 'clear' | 'compact' | null {
    if (this.store.getSession(sessionId)?.compacting) return 'compact';
    for (const i of this.store.undeliveredInbox(sessionId)) {
      if (isClear(i.source)) return 'clear';
      if (isCompact(i.source)) return 'compact';
    }
    return null;
  }

  /**
   * Queues a compact (/compact) behind what already waits, like a clear but with no countdown (decided
   * 2026-10-13: nothing is lost). The note goes to the summarizer only; `then` is delivered once the
   * compact is over, headed with how it went. Returns why not, or null.
   */
  private queueCompact(target: SessionInfo, requester: string, note: string | undefined, then: string | undefined): string | null {
    const busy = this.pendingClearOrCompact(target.id);
    if (busy) return `A ${busy} of "${target.title}" is already waiting or under way; only one at a time.`;
    this.store.addInbox(target.id, `${COMPACT_SOURCE}:${requester}`, note ?? '');
    const text = then?.trim();
    if (text) this.store.addInbox(target.id, `${COMPACT_NOTE_SOURCE}:${requester}`, text);
    return null;
  }

  /** compact_session: one of the manager's sessions, or (id omitted) the manager itself after this turn. */
  async compactSession(managerId: string, id: string | undefined, instructions?: string, then?: string): Promise<string> {
    const self = !id || id === managerId;
    const s = self ? this.store.getSession(managerId)! : this.ownSession(managerId, id);
    const refused = this.queueCompact(s, managerId, compactNote(instructions), then);
    if (refused) return refused;
    const note = then?.trim();
    if (self) return `Your conversation is compacted after this turn ends${note ? ', then your note arrives' : ''}. Finish what you are doing and end your turn.`;
    return (await this.reach(s.id))
      ? `"${s.title}" had ended; it is resumed and compacted once it is up. You are told if the compact fails.`
      : `"${s.title}" is compacted when it is free${note ? ', then gets your message' : ''}. You are told if the compact fails.`;
  }

  /** compact_self: a session compacts itself after this turn. */
  compactSelf(sessionId: string, instructions?: string, then?: string): string {
    const refused = this.queueCompact(this.store.getSession(sessionId)!, sessionId, compactNote(instructions), then);
    if (refused) return refused;
    return `Your conversation is compacted after this turn ends${then?.trim() ? ', then your note arrives' : ''}. Finish what you are doing and end your turn.`;
  }

  /** clear_self: a session clears itself once it has written a handoff (decided 2026-10-13), with clear_session's countdown. */
  clearSelf(sessionId: string, handoffFile: string, then?: string, seconds = CLEAR_SECONDS): string {
    const busy = this.pendingClearOrCompact(sessionId);
    if (busy) return `A ${busy} of your conversation is already waiting or under way; only one at a time.`;
    const file = handoffFile.trim().replace(/\\/g, '/');
    const problem = this.ctx.handoffProblem(sessionId, file);
    if (problem) throw new ManagementError(problem);
    const wait = Math.round(Math.min(Math.max(seconds, CLEAR_MIN_SECONDS), CLEAR_MAX_SECONDS));
    this.store.addInbox(sessionId, `${CLEAR_SOURCE}:${wait}:${sessionId}`, `Clear requested by the session itself (handoff: ${file}).`);
    const extra = then?.trim();
    this.store.addInbox(sessionId, CLEAR_NOTE_SOURCE,
      `Your conversation was cleared at your own request (clear_self). Your handoff note is ${file}: read it first and continue from there.` +
        (extra ? `\n\nYour note to yourself:\n\n${extra}` : ''));
    return `Your conversation is cleared after this turn ends, then you are pointed at ${file}. ${this.ctx.userName} gets ${wait} s to cancel it; you are told if they do. Finish what you are doing and end your turn.`;
  }

  /** A clear went in. A session that asked for its own: its manager is told quietly. */
  onCleared(sessionId: string, requesterId: string, what: string): void {
    if (requesterId !== sessionId || this.store.getSession(sessionId)?.role !== 'session') return;
    this.quietToManager(sessionId, `Ledung: session "${this.title(sessionId)}" (${sessionId}) cleared its own conversation. ${what}`);
  }

  /**
   * A compact is over. The note after it is headed with how it went; the requester hears of a failure
   * (no retry, nothing to the user; decided 2026-10-13). A session's own compact: its manager quietly.
   */
  onCompactEnded(sessionId: string, c: CompactingInfo, outcome: CompactOutcome): void {
    const self = c.requester === sessionId;
    const title = this.title(sessionId);
    const noteItem = this.store.undeliveredInbox(sessionId).find((i) => i.source === `${COMPACT_NOTE_SOURCE}:${c.requester}`);
    if (noteItem) this.store.setInboxText(noteItem.id, compactNoteText(outcome, self, this.title(c.requester), noteItem.text));
    const what = outcome.kind === 'success' ? `was compacted${figures(c)}`
      : outcome.kind === 'failed' ? `could not be compacted: ${outcome.reason} Its context is unchanged.`
        : outcome.kind === 'nothing' ? 'had nothing to compact yet; its context is unchanged.'
          : 'ended during the compact; its context is unchanged.';
    if (self) {
      // The session hears of a failure through its note, or through this line when it gave none.
      if ((outcome.kind === 'failed' || outcome.kind === 'nothing') && !noteItem) {
        this.store.addInbox(sessionId, 'ledung', outcome.kind === 'failed'
          ? `Ledung: the compact you asked for failed (${outcome.reason}); your context is unchanged.`
          : 'Ledung: there was nothing to compact yet; your context is unchanged.');
      }
      if (this.store.getSession(sessionId)?.role === 'session') {
        this.quietToManager(sessionId, `Ledung: session "${title}" (${sessionId}) asked to compact itself and ${what}`);
      }
      return;
    }
    // A manager hears only what didn't work; an end is reported anyway (onEnded).
    if (outcome.kind === 'success' || outcome.kind === 'ended' || !this.store.getSession(c.requester)) return;
    this.tell(c.requester, 'ledung', `Ledung: the compact you asked for: "${title}" (${sessionId}) ${what}`);
  }

  /** No outcome for 10 minutes: the requester is told; for a session's own compact its manager is woken too (decided 2026-10-13). */
  onCompactStuck(sessionId: string, c: CompactingInfo, minutes: number): void {
    const self = c.requester === sessionId;
    const text = `Ledung: the compact of "${this.title(sessionId)}" (${sessionId}) has run ${minutes} minutes with no result. ` +
      `It may still finish; Interrupt in the page${self ? '' : ' or stop_session'} ends it.`;
    if (self) {
      this.store.addInbox(sessionId, 'ledung', text);
      const manager = this.managerOf(sessionId);
      if (manager) this.tell(manager.id, 'ledung', text);
      return;
    }
    if (this.store.getSession(c.requester)) this.tell(c.requester, 'ledung', text);
  }

  /** Waits for the manager's next turn instead of waking it (as for an idle stop). */
  private quietToManager(sessionId: string, text: string): void {
    const manager = this.managerOf(sessionId);
    if (manager) this.store.addInbox(manager.id, 'ledung', text);
  }

  async stopSession(managerId: string, id: string): Promise<string> {
    const s = this.ownSession(managerId, id);
    if (s.status === 'ended') return `Session "${s.title}" has already ended.`;
    await this.ctx.stopSession(id, `Stopped by manager "${this.store.getSession(managerId)?.title ?? managerId}".`);
    return `Stopped "${s.title}".`;
  }

  /**
   * ask_user's about_question must name a question one of the asker's sessions asked it (review of PR #373, finding 1):
   * the page shows that question inside this one and says the answer goes there, and forward_answer only reaches those.
   */
  checkAboutQuestion(managerId: string, questionId: number): void {
    const q = this.store.getQuestion(questionId);
    if (!q || q.addressedTo !== managerId) throw new ManagementError(`Question #${questionId} is not from one of your sessions, so about_question can't name it. Nothing was asked.`);
  }

  private openQuestionOfOwnSession(managerId: string, questionId: number): QuestionInfo {
    const q = this.store.getQuestion(questionId);
    if (!q || q.addressedTo !== managerId) throw new ManagementError(`Question #${questionId} is not from one of your sessions.`);
    if (q.status !== 'open') throw new ManagementError(`Question #${questionId} is already ${q.status}.`);
    return q;
  }

  /** The manager decides itself, under its standing grant. */
  async answerQuestion(managerId: string, questionId: number, answer: string): Promise<string> {
    const q = this.openQuestionOfOwnSession(managerId, questionId);
    if (!answer.trim()) throw new ManagementError('The answer is empty.');
    const form = q.details?.review ? reviewAnswerProblem(answer) : null;
    if (form) throw new ManagementError(`Question #${q.id} is a review. ${form}`);
    this.store.answerQuestion(q.id, answer.trim(), managerId);
    this.ctx.publish({ type: 'question', question: this.store.getQuestion(q.id)! });
    await this.reach(q.sessionId);
    return `Answered question #${q.id}; it reaches "${this.title(q.sessionId)}" marked as your decision under your standing grant.`;
  }

  /** Passes on the user's answer to one of the manager's own questions, verbatim. */
  async forwardAnswer(managerId: string, userQuestionId: number, toQuestionId: number): Promise<string> {
    const source = this.store.getQuestion(userQuestionId);
    if (!source || source.sessionId !== managerId) throw new ManagementError(`Question #${userQuestionId} is not one you asked.`);
    if (source.status !== 'answered' || source.answeredBy !== 'user' || source.answer === null) {
      throw new ManagementError(`Question #${userQuestionId} has no answer from ${this.ctx.userName} yet.`);
    }
    const target = this.openQuestionOfOwnSession(managerId, toQuestionId);
    const form = target.details?.review ? reviewAnswerProblem(source.answer) : null;
    if (form) throw new ManagementError(`Question #${target.id} is a review, and ${this.ctx.userName}'s answer to #${source.id} is not in a review's form. ${form}`);
    this.store.answerQuestion(target.id, source.answer, 'user', source.id);
    this.ctx.publish({ type: 'question', question: this.store.getQuestion(target.id)! });
    await this.reach(target.sessionId);
    return `Forwarded ${this.ctx.userName}'s answer to question #${target.id}, word for word.`;
  }

  machineStatus(managerId: string): string {
    const m = this.ctx.machine();
    const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
    const lines = [
      `This computer: CPU ${m.cores.toFixed(1)} of ${m.cpus} cores in use; memory ${gb(m.memUsed)} of ${gb(m.memTotal)}.`,
      m.docker ? `Docker: CPU ${m.docker.cores.toFixed(1)} of ${m.docker.cpus} cores; memory ${gb(m.docker.memUsed)} of ${gb(m.docker.memTotal)}.` : 'Docker: not measured.',
      `Sessions working: ${m.working} of a limit of ${m.limit}. Waiting for a place: ${m.line.length}.`,
    ];
    const own = this.store.childSessions(managerId).filter((s) => s.status !== 'ended');
    for (const s of own) {
      const f = m.sessions[s.id];
      const place = m.line.indexOf(s.id);
      lines.push(`- "${s.title}" (${s.id}): ${s.status}${place >= 0 ? `, number ${place + 1} in line` : ''}, priority ${s.priority}${s.paused ? ', paused' : ''}` +
        `${f ? `; ${f.cores.toFixed(1)} cores, ${gb(f.memBytes)}` : ''}`);
    }
    return lines.join('\n');
  }

  /** normal or high on the manager's own judgement; critical only on the user's answer to one of its questions. */
  setPriority(managerId: string, id: string, priority: Priority, userQuestion?: number): string {
    const s = this.ownSession(managerId, id);
    let note: string;
    if (priority === 'critical') {
      const q = userQuestion ? this.store.getQuestion(userQuestion) : undefined;
      if (!q || q.sessionId !== managerId || q.status !== 'answered' || q.answeredBy !== 'user') {
        throw new ManagementError(
          `critical needs ${this.ctx.userName}'s directive: ask ${this.ctx.userName} with ask_user, and when the answer asks for it, set critical with user_question set to that question's number. Without it, use normal or high.`,
        );
      }
      note = `critical, on ${this.ctx.userName}'s answer to #${q.id}, set by manager "${this.title(managerId)}"`;
    } else {
      note = `${priority}, set by manager "${this.title(managerId)}"`;
    }
    this.ctx.setPriority(id, priority, note, `manager "${this.title(managerId)}"`);
    return `"${s.title}" now has priority ${priority}.`;
  }

  setPaused(managerId: string, id: string, paused: boolean): string {
    const s = this.ownSession(managerId, id);
    if (s.status === 'ended') throw new ManagementError(`Session ${id} has ended.`);
    this.ctx.setPaused(id, paused, `manager "${this.title(managerId)}"`);
    return `${paused ? 'Paused' : 'Resumed'} "${s.title}".`;
  }

  /**
   * MCP servers (issue #118): one of the manager's running sessions, or (id omitted) the manager itself.
   * Only servers the session already has, so this holds at lockdown level B too.
   */
  async mcpStatus(managerId: string, id: string | undefined): Promise<string> {
    const s = this.mcpTarget(managerId, id);
    const servers = await this.mcpContext().servers(s.id);
    return `MCP servers of ${s.id === managerId ? 'your own session' : `"${s.title}"`}:\n${formatServers(servers)}`;
  }

  async reconnectMcp(managerId: string, id: string | undefined, name: string): Promise<string> {
    const s = this.mcpTarget(managerId, id);
    const servers = await this.mcpContext().reconnect(s.id, name, `manager "${this.title(managerId)}"`);
    const now = servers.find((x) => x.name === name);
    return `Reconnected "${name}" in ${s.id === managerId ? 'your own session' : `"${s.title}"`}; it is now ${now?.status ?? 'not listed'}.` +
      `${now?.error ? ` Error: ${now.error}` : ''} Its conversation is kept.`;
  }

  private mcpTarget(managerId: string, id: string | undefined): SessionInfo {
    const s = !id || id === managerId ? this.store.getSession(managerId)! : this.ownSession(managerId, id);
    if (s.status === 'ended' || s.status === 'stopping') throw new ManagementError(`"${s.title}" is not running; its MCP servers start with it.`);
    return s;
  }

  private mcpContext(): NonNullable<ManagementContext['mcp']> {
    if (!this.ctx.mcp) throw new ManagementError('MCP server status is not available in this Ledung.');
    return this.ctx.mcp;
  }

  // --- Lockdown (issue #109) ------------------------------------------------------------------------
  // A locked project is closed to other projects' managers: they see its name only, can't message it
  // (except one reply to each of its messages), start or stop its manager. Its own manager keeps every
  // tool it has. Read from the project's settings on every call, so a change applies at once.

  /** The project's lockdown level; off for a project that is gone. */
  private lockLevel(project: string): LockdownLevel {
    const p = this.ctx.projects().find((x) => x.name === project);
    return p ? lockdownOf(p).level : 'off';
  }

  /** The project when it is locked and the caller belongs to another one; else null. */
  private lockedAgainst(callerId: string, project: string): string | null {
    return this.lockLevel(project) !== 'off' && this.store.getSession(callerId)?.project !== project ? project : null;
  }

  /**
   * Level B (issue #109): its manager can't reach other managers or projects. It doesn't get those tools;
   * this refuses them all the same, for a manager launched before the change, until Ledung restarts it.
   */
  private airgapped(callerId: string): void {
    const project = this.store.getSession(callerId)?.project;
    if (project && this.lockLevel(project) === 'B') {
      throw new ManagementError(`The project "${project}" is in lockdown level B (nearly air-gapped): its manager can't reach other managers or projects.`);
    }
  }

  /**
   * Why a session's attached sources may not be fetched from GitHub (issue #369), or null: a nearly air-gapped
   * project (level B) reaches nothing outside, and an asker naming a link shouldn't make Ledung do it for it.
   */
  offlineReason(sessionId: string): string | null {
    const project = this.store.getSession(sessionId)?.project;
    return project && this.lockLevel(project) === 'B'
      ? `the project "${project}" is in lockdown level B (nearly air-gapped), so Ledung fetches nothing from GitHub for it.`
      : null;
  }

  listManagers(managerId: string): string {
    this.airgapped(managerId);
    const managers = this.store.listSessions().filter((s) => s.role === 'manager' && s.id !== managerId && s.status !== 'ended');
    if (!managers.length) return 'There are no other managers running.';
    return managers.map((m) => this.lockedAgainst(managerId, m.project)
      // By name only (Martin, 19:12, "as recommended"): no id, title or state.
      ? `- ${m.project}: locked; its manager can't be reached from other projects`
      : `- "${m.title}" (${m.id}) for ${m.project}: ${m.status}`).join('\n');
  }

  /**
   * Never to a manager that has ended, idle-stopped or not (issue #46): resuming it is start_manager's, which the
   * user approves, so a stop they approved can't be undone by a message. Nothing is kept for it.
   */
  async messageManager(fromId: string, toId: string, text: string): Promise<string> {
    return this.toManager(fromId, toId, text, false);
  }

  /** `resume`: only for start_manager, once the user has approved it. */
  private async toManager(fromId: string, toId: string, text: string, resume: boolean): Promise<string> {
    const to = this.store.getSession(toId);
    if (!to || to.role !== 'manager' || to.id === fromId) throw new ManagementError(`${toId} is not another manager. Use list_managers.`);
    this.airgapped(fromId);
    const from = this.store.getSession(fromId);
    let body = `Message from manager "${this.title(fromId)}" (${fromId}):\n\n${text}`;
    const locked = this.lockedAgainst(fromId, to.project);
    if (locked) {
      // One answer per message the locked manager sent (Martin, 19:12, "do as recommended"), marked as a reply.
      // Level B takes none, even to a message it sent while it was A.
      if (this.lockLevel(to.project) === 'B') {
        throw new ManagementError(`The project "${locked}" is in lockdown level B (nearly air-gapped): managers of other projects can't message it.`);
      }
      if (!this.store.takeReplyAllowance(fromId, toId)) {
        throw new ManagementError(`The project "${locked}" is locked: managers of other projects can't message it. Its manager may write to you; you can answer each of its messages once.`);
      }
      if (!resume && to.status === 'ended') {
        this.store.addReplyAllowance(fromId, toId); // not used up by a reply that isn't sent
        throw new ManagementError(`Manager "${to.title}" is not running, so your reply was not sent. ${this.ctx.userName} can start it, in the page.`);
      }
      body = `Reply from manager "${this.title(fromId)}" (${fromId}) of ${from?.project ?? 'another project'}, to your message:\n\n${text}`;
    } else if (!resume && to.status === 'ended') {
      throw new ManagementError(`Manager "${to.title}" of "${to.project}" is not running, so your message was not sent. To start it with your message, use start_manager, which ${this.ctx.userName} approves.`);
    } else if (from && this.lockedAgainst(toId, from.project)) {
      this.store.addReplyAllowance(toId, fromId);
      body += `\n\n(Ledung: the project "${from.project}" is locked. You can answer this message once, with message_manager to ${fromId}; it can't be reached otherwise.)`;
    }
    this.store.addInbox(toId, `manager:${fromId}`, body);
    const sent = locked ? 'Reply sent' : 'Sent';
    return (await this.reach(toId)) ? `Manager "${to.title}" had ended; it is resumed and gets your message once it is up.` : `${sent} to manager "${to.title}".`;
  }

  // --- managers on the person's linked computers (#245, docs/steps/manager-link.md step 2) -------
  // Trusted exactly as managers on this computer (Martin, 2026-10-20 08:32: "the connection is secure, we need to
  // trust in it"): the same marking with the computer's name added, the same lockdown, the same rule for an ended
  // manager. Only the limits on waking are added, because two computers double the managers that can wake each other.

  /** Sends per sending manager in the last hour, and wakes per (sender, receiver) pair, as times. */
  private readonly linkSends = new Map<string, number[]>();
  private readonly linkWakes = new Map<string, number[]>();
  /** Pairs told this hour that they are paused for waking. */
  private readonly linkPausedNoted = new Map<string, number>();
  /** Receivers with a merged wake on its way, and when their last wake from another computer was. */
  private readonly linkBurst = new Map<string, { at: number; timer: NodeJS.Timeout | null }>();

  private now(): number {
    return this.ctx.now?.() ?? Date.now();
  }

  private recent(map: Map<string, number[]>, key: string): number[] {
    const since = this.now() - HOUR_MS;
    const times = (map.get(key) ?? []).filter((t) => t > since);
    map.set(key, times);
    return times;
  }

  /** The linked computer a manager named, by the name this Ledung gave it or its public name. */
  private linkedComputer(name: string): { port: LinkedPort; computer: LinkedComputer } {
    const port = this.ctx.linked?.() ?? null;
    const all = port?.list() ?? [];
    const wanted = name.trim().toLowerCase();
    const computer = all.find((c) => c.name.toLowerCase() === wanted || c.publicName === wanted || c.id === name);
    if (!port || !computer) {
      throw new ManagementError(all.length
        ? `"${name}" is not a linked computer. Linked: ${all.map((c) => `"${c.name}"`).join(', ')}.`
        : 'This computer is linked with no other computer (Settings → Linked computers).');
    }
    return { port, computer };
  }

  /** list_managers: this computer's, then each linked computer's (or one computer's only). */
  async listManagersEverywhere(managerId: string, computer?: string): Promise<string> {
    this.airgapped(managerId);
    const port = this.ctx.linked?.() ?? null;
    const computers = computer ? [this.linkedComputer(computer).computer] : port?.list() ?? [];
    if (!computer && !computers.length) return this.listManagers(managerId);
    const parts = computer ? [] : [`On this computer:\n${this.listManagers(managerId)}`];
    const lists = await Promise.all(computers.map(async (c) => {
      try {
        const answer = await port!.callLinked(c.id, '/link/managers', {}, LINK_LIST_MS);
        const text = typeof answer.text === 'string' ? answer.text : 'There are no managers running.';
        return `On your computer "${c.name}" (give message_manager computer "${c.name}"):\n${text}`;
      } catch (e) {
        return `On your computer "${c.name}": ${(e as Error).message}`;
      }
    }));
    return [...parts, ...lists].join('\n\n');
  }

  /** What a linked computer's list_managers shows of this one: the same lines as a manager of another project here. */
  managersForComputer(): string {
    const managers = this.store.listSessions().filter((s) => s.role === 'manager' && s.status !== 'ended');
    if (!managers.length) return 'There are no managers running.';
    return managers.map((m) => this.lockLevel(m.project) !== 'off'
      ? `- ${m.project}: locked; its manager can't be reached from other projects`
      : `- "${m.title}" (${m.id}) for ${m.project}: ${m.status}`).join('\n');
  }

  /** list_projects on a linked computer, or here. */
  async listProjectsOn(managerId: string, computer?: string): Promise<string> {
    if (!computer) return this.listProjects(managerId);
    this.airgapped(managerId);
    const { port, computer: c } = this.linkedComputer(computer);
    const answer = await port.callLinked(c.id, '/link/projects', {}, LINK_LIST_MS * 5);
    return `Projects on your computer "${c.name}":\n${typeof answer.text === 'string' ? answer.text : 'There are no projects.'}`;
  }

  /** What a linked computer's list_projects shows of this one: names and their managers, no folders or settings. */
  projectsForComputer(): string {
    const projects = this.ctx.projects();
    if (!projects.length) return 'There are no projects.';
    return projects.map((p) => {
      if (this.lockLevel(p.name) !== 'off') return `- "${p.name}": locked`;
      const mgr = p.managerId ? this.store.getSession(p.managerId) : undefined;
      return `- "${p.name}": ${mgr ? `manager "${mgr.title}" (${mgr.id}) ${mgr.status}` : 'no manager yet'}`;
    }).join('\n');
  }

  /** message_manager with a computer: to that manager on that linked computer. */
  async messageComputerManager(fromId: string, computer: string, toId: string, text: string): Promise<string> {
    this.airgapped(fromId);
    const { port, computer: c } = this.linkedComputer(computer);
    // Refused here with the limit, so nothing is cut on the way (review 254, Minor 3); the receiver still cuts, for a
    // sender that doesn't check.
    if (text.length > LINK_MAX_CHARS) {
      throw new ManagementError(`Not sent: a message to another computer is at most ${LINK_MAX_CHARS} characters, and this one has ${text.length}. Split it into parts and say how many there are.`);
    }
    const sends = this.recent(this.linkSends, fromId);
    if (sends.length >= LINK_SENDS_PER_HOUR) {
      throw new ManagementError(`You have sent ${LINK_SENDS_PER_HOUR} messages to other computers in the last hour, the limit; not sent. Put the rest in fewer messages, or ask ${this.ctx.userName}.`);
    }
    const from = this.store.getSession(fromId);
    const fromLocked = !!from && this.lockLevel(from.project) !== 'off';
    const body: LinkedMessage = { fromId, fromTitle: this.title(fromId), fromProject: from?.project ?? '', fromLocked, toId, text };
    const answer = await port.callLinked(c.id, '/link/message', body as unknown as Record<string, unknown>);
    sends.push(this.now());
    // A locked project's manager may get one answer to each message it sent, as on one computer.
    if (fromLocked) this.store.addReplyAllowance(`${c.id}/${toId}`, fromId);
    return typeof answer.text === 'string' ? `${answer.text} (on your computer "${c.name}")` : `Sent to your computer "${c.name}".`;
  }

  /**
   * /link/message: a message from manager `m.fromId` on the linked computer `link`, whose name and id come from the
   * link key, never from the message. Delivered as message_manager delivers here.
   */
  fromComputer(link: { id: string; name: string }, m: LinkedMessage): string {
    const to = this.store.getSession(m.toId);
    if (!to || to.role !== 'manager') throw new ManagementError(`${plainTitle(m.toId)} is not a manager there. Use list_managers with that computer.`);
    const sender = `${link.id}/${m.fromId}`;
    const title = plainTitle(m.fromTitle) || 'a manager';
    const level = this.lockLevel(to.project);
    let body = `Message from manager "${title}" (${plainTitle(m.fromId)}) of ${plainTitle(m.fromProject) || 'a project'} on your computer "${link.name}":\n\n${cut(m.text)}`;
    if (level === 'B') throw new ManagementError(`The project "${to.project}" is in lockdown level B (nearly air-gapped): managers of other projects can't message it.`);
    if (level !== 'off') {
      if (!this.store.takeReplyAllowance(sender, to.id)) throw new ManagementError(`The project "${to.project}" is locked: managers of other projects can't message it. Its manager may write to you; you can answer each of its messages once.`);
      if (to.status === 'ended') {
        this.store.addReplyAllowance(sender, to.id);
        throw new ManagementError(`Manager "${to.title}" is not running, so your reply was not sent.`);
      }
      body = `Reply from manager "${title}" (${plainTitle(m.fromId)}) of ${plainTitle(m.fromProject) || 'a project'} on your computer "${link.name}", to your message:\n\n${cut(m.text)}`;
    } else if (to.status === 'ended') {
      throw new ManagementError(`Manager "${to.title}" of "${to.project}" is not running, so your message was not sent. ${this.ctx.userName} can start it there.`);
    }
    if (m.fromLocked) body += `\n\n(Ledung: its project is locked. You can answer this message once, with message_manager to ${plainTitle(m.fromId)} on computer "${link.name}"; it can't be reached otherwise.)`;
    else body += `\n\n(Answer with message_manager to ${plainTitle(m.fromId)}, computer "${link.name}".)`;
    this.store.addInbox(to.id, `manager:${link.id}/${m.fromId}`, body);
    this.wakeFromComputer(sender, to.id);
    return `Sent to manager "${to.title}".`;
  }

  /** Wakes `toId` for a message from another computer, within the caps: merged bursts, and so many wakes an hour per pair. */
  private wakeFromComputer(sender: string, toId: string): void {
    const pair = `${sender}>${toId}`;
    const wakes = this.recent(this.linkWakes, pair);
    if (wakes.length >= LINK_WAKES_PER_HOUR) {
      const noted = this.linkPausedNoted.get(pair);
      if (noted === undefined || this.now() - noted >= HOUR_MS) {
        this.linkPausedNoted.set(pair, this.now());
        this.store.addInbox(toId, 'ledung', `Ledung: that manager on another computer has woken you ${LINK_WAKES_PER_HOUR} times this hour. Its messages still arrive, but wait for your next turn instead of waking you; tell it "no reply needed" or ask ${this.ctx.userName} if this goes on.`);
      }
      return;
    }
    const now = this.now();
    const burst = this.linkBurst.get(toId);
    if (burst && now - burst.at < LINK_BURST_MS) {
      // Messages close together become one wake: the one already on its way, or one when the burst ends.
      if (burst.timer) return;
      wakes.push(now);
      burst.timer = setTimeout(() => {
        burst.timer = null;
        burst.at = this.now();
        this.ctx.wake(toId);
      }, LINK_BURST_MS - (now - burst.at));
      burst.timer.unref?.();
      return;
    }
    wakes.push(now);
    this.linkBurst.set(toId, { at: now, timer: null });
    this.ctx.wake(toId);
  }

  // Other projects (issue #37). add_project, create_project, start_manager and stop_manager only run once
  // the user has approved the call in Ledung (sensitive, decision of 2026-10-13); these are what runs then.

  listProjects(managerId: string): string {
    this.airgapped(managerId);
    const own = this.store.getSession(managerId)?.project;
    const projects = this.ctx.projects();
    if (!projects.length) return 'There are no projects.';
    return projects.map((p) => {
      if (this.lockedAgainst(managerId, p.name)) return `- "${p.name}": locked`;
      const mgr = p.managerId ? this.store.getSession(p.managerId) : undefined;
      const manager = mgr ? `manager "${mgr.title}" (${mgr.id}) ${mgr.status}` : 'no manager yet';
      const settings = [p.model && `model ${p.model}`, p.managerModel && `manager's model ${p.managerModel}`, p.permissionMode && `mode ${p.permissionMode}`, p.account && `account ${p.account}`].filter(Boolean).join(', ');
      return `- "${p.name}"${p.name === own ? ' (yours)' : ''}: ${p.where}${settings ? `; ${settings}` : ''}; ${manager}`;
    }).join('\n');
  }

  // --- Settings' page-only actions (issue #263) ---------------------------------------------------------
  // Each tool but settings_status is a sensitive call (SETTINGS_RULE): the user allows it in Ledung, or their own
  // words typed or answered on this computer name it (Session.settingsOnWord). None at lockdown level B.

  private settingsPort(managerId: string): SettingsPort {
    this.airgapped(managerId);
    const port = this.ctx.settings?.() ?? null;
    if (!port) throw new ManagementError('Settings actions are not available in this Ledung.');
    return port;
  }

  /** settings_status: what Settings shows of the relay, linked computers and computer tabs; nothing secret. */
  settingsStatus(managerId: string): string {
    const port = this.settingsPort(managerId);
    const relay = port.relay();
    const { problem, links } = port.links();
    return [
      `Relay (Settings → Relay): ${relay.relay ?? 'no address set'}; admin key ${relay.keySha256 ? `made, SHA-256 ${relay.keySha256}` : 'not made'}; Cloudflare token ${relay.tokenSet ? 'set' : 'not set'}.`,
      `Linked computers: ${links.length ? links.map((l) => `"${l.name}" (${l.publicName})`).join(', ') : 'none'}.${problem ? ` Linking: ${problem}` : ''}`,
      `Computer tabs: ${port.computers().map((c) => `"${c.name}" (id "${c.id}"${c.here ? ', this computer' : ''})`).join(', ') || 'none'}.`,
      usagePublishLine(port.usagePublish?.() ?? null),
    ].join('\n');
  }

  relayAddress(managerId: string, relay: string): string {
    const view = this.settingsPort(managerId).setRelay(relay);
    return `The relay's address is now ${view.relay ?? 'not set'}.`;
  }

  relayAdminKey(managerId: string): string {
    const view = this.settingsPort(managerId).makeAdminKey();
    return `Made a new relay admin key (it replaces any earlier one and stays in Ledung's data folder). Its SHA-256, for the relay's config as "adminKeySha256": ${view.keySha256}`;
  }

  linkCode(managerId: string): string {
    const { code, expiresAt } = this.settingsPort(managerId).linkCode();
    return `Link code, valid until ${new Date(expiresAt).toLocaleTimeString()}, to paste on the other computer (Settings → Linked computers, or its manager's link_computer): ${code}`;
  }

  async linkComputer(managerId: string, code: string, name?: string): Promise<string> {
    const linked = await this.settingsPort(managerId).link(code, name);
    return `Linked with "${linked.name}" (${linked.publicName}).`;
  }

  async inviteComputer(managerId: string, owner: string, name?: string): Promise<string> {
    const invite = await this.settingsPort(managerId).invite(owner, name);
    return `Invited a computer for ${invite.owner} as ${invite.host}, until ${new Date(invite.expiresAt).toLocaleString()}. Its join code, shown once, for Settings → Relay → Join with a code on that computer: ${invite.code}`;
  }

  // --- Publishing usage (issue #376) -------------------------------------------------------------------
  // Settings → Claude & usage → Publish usage, for a manager: it sends this computer's usage to a GitHub repository
  // others read, so switching it on or moving it to another repo is a sensitive call the user allows in Ledung (the
  // same hook and checks as set_project_settings); switching off runs at once. Never at lockdown level B.

  /**
   * What a usage_publish call would do: the switch the page would send, what it makes of the accounts, and the rule its
   * prompt names (null: none). Anything that shares more asks (#380): on from off, another repo, every account where
   * only some were on, or an account switched on; switching accounts off or everything off runs at once.
   */
  private usagePublishPlan(managerId: string, raw: unknown): {
    port: SettingsPort; next: UsagePublishChange; after: { on: boolean; repo: string | null; all: boolean; accounts: string[] }; rule: string | null;
  } {
    const port = this.settingsPort(managerId);
    const view = port.usagePublish?.() ?? null;
    if (!view || !port.configureUsagePublish) throw new ManagementError('Publishing usage is not available in this Ledung.');
    const input = usagePublishInput(raw);
    const repo = input.repo ?? view.repo;
    if (repo !== null && !USAGE_REPO.test(repo)) throw new ManagementError(`Write the repository as owner/name; "${repo}" is not.`);
    const was = { on: view.enabled, all: view.allAccounts, accounts: view.accounts };
    const accountsGiven = input.allAccounts !== undefined || input.accounts !== undefined;
    let after: { on: boolean; repo: string | null; all: boolean; accounts: string[] };
    if (input.enabled === false) after = { on: false, repo, all: false, accounts: [] };
    else if (accountsGiven) {
      const kept = new Set(was.accounts);
      for (const [a, on] of Object.entries(input.accounts ?? {})) if (on) kept.add(a); else kept.delete(a);
      const all = input.allAccounts ?? was.all;
      const accounts = [...kept].sort();
      after = { on: all || accounts.length > 0, repo, all, accounts };
    } else if (input.enabled === true) after = was.on ? { ...was, repo } : { on: true, repo, all: true, accounts: [] };
    else after = { ...was, repo };
    if (after.on && !repo) throw new ManagementError('Give the repository to publish to, as owner/name.');
    if (input.enabled === true && accountsGiven && !after.on) throw new ManagementError('Switching publishing on needs an account switched on, or allAccounts: true.');
    let rule: string | null = null;
    const where = `the GitHub repository "${repo}"`;
    const reads = 'where everyone with access to it reads it';
    if (after.on && (!was.on || view.repo !== repo)) {
      const which = !accountsGiven ? '' : after.all ? ' (every Claude account, ones added later too)' : ` (the account${after.accounts.length > 1 ? 's' : ''} ${after.accounts.map((a) => `"${a}"`).join(', ')})`;
      // Switching on also starts the projects' own repos: the prompt names them, so it shows all it allows (review of PR #382, finding 3).
      const own = new Map<string, string[]>();
      if (!was.on) {
        for (const p of this.ctx.projects()) {
          if (!p.usageRepo || p.usageRepo.toLowerCase() === repo!.toLowerCase()) continue;
          let names = own.get(p.usageRepo);
          if (!names) own.set(p.usageRepo, (names = []));
          names.push(p.name);
        }
      }
      const also = [...own].map(([r, names]) => `, and ${names.map((n) => `"${n}"`).join(', ')} to "${r}"`).join('');
      rule = `publishing this computer's usage${which} to ${where}${was.on ? ` instead of "${view.repo}"` : ''}${also}, ${also ? 'where everyone with access to each reads it' : reads}`;
    } else if (after.on && after.all && !was.all) {
      rule = `publishing the usage of every Claude account on this computer, ones added later too, to ${where}, ${reads}`;
    } else if (after.on && !after.all) {
      const added = after.accounts.filter((a) => !was.all && !was.accounts.includes(a));
      if (added.length) rule = `publishing the usage of the account${added.length > 1 ? 's' : ''} ${added.map((a) => `"${a}"`).join(', ')} to ${where}, ${reads}`;
    }
    // Without account fields the page's old switch goes as before; with them, the accounts as they will be.
    const next: UsagePublishChange = accountsGiven ? { enabled: after.on, repo, allAccounts: after.all, accounts: after.accounts } : { enabled: after.on, repo };
    return { port, next, after, rule };
  }

  /** The PreToolUse hook's answer for usage_publish, as settingsChange is set_project_settings'. */
  usagePublishChange(managerId: string, raw: unknown, note = true): { deny: string } | { ask: string } | { allow: true } {
    let rule: string | null;
    try {
      rule = this.usagePublishPlan(managerId, raw).rule;
    } catch (e) {
      return { deny: (e as Error).message };
    }
    if (rule) return { ask: rule };
    if (note) this.noteUnasked(usagePublishKey(managerId, raw));
    return { allow: true };
  }

  /** The user allowed this usage_publish call; shown: the rule its prompt showed. */
  noteApprovedUsagePublish(managerId: string, raw: unknown, shown: string | null): void {
    this.noteApproval(usagePublishKey(managerId, raw), shown);
  }

  /** usage_publish: on (with the user's allow, for exactly what their prompt showed) or off (at once). */
  async usagePublish(managerId: string, raw: unknown): Promise<string> {
    const { port, next, after, rule } = this.usagePublishPlan(managerId, raw);
    const key = usagePublishKey(managerId, raw);
    const approved = this.takeApproval(key);
    const unasked = approved === undefined && this.takeUnasked(key);
    if (rule !== null && approved !== rule) {
      throw new ManagementError(approved !== undefined || unasked
        ? `Publishing on this computer changed while ${this.ctx.userName} was asked, so this is no longer what they allowed; nothing changed. Call it again to ask ${this.ctx.userName}.`
        : `Switching publishing on sends this computer's usage out, and ${this.ctx.userName} did not allow it; nothing changed.`);
    }
    const before = port.usagePublish!()!;
    const sameAccounts = before.allAccounts === after.all && JSON.stringify(before.accounts) === JSON.stringify(after.accounts);
    if (before.enabled === after.on && (!after.on || (before.repo === after.repo && sameAccounts))) {
      return `Nothing to change: publishing is ${before.enabled ? `on, to "${before.repo}"` : 'off'} on this computer already.`;
    }
    const view = await port.configureUsagePublish!(next);
    return usagePublishLine(view);
  }

  async addProject(managerId: string, args: ProjectArgs): Promise<string> {
    this.airgapped(managerId);
    const p = this.ctx.addProject(projectConfig(args, args.folder));
    return `Added the project "${p.name}" (${p.where}). Its manager starts when first needed: start_manager.`;
  }

  async createProject(managerId: string, args: NewProjectArgs): Promise<string> {
    this.airgapped(managerId);
    const made = await this.ctx.createProject({ parent: args.parent, github: args.github === true, settings: projectConfig(args, '') });
    const lines = [`Created the project "${made.project.name}" in ${made.project.where}.`];
    if (made.githubUrl) lines.push(`GitHub repository: ${made.githubUrl}`);
    if (made.warning) lines.push(`Warning: ${made.warning}`);
    if (args.task?.trim()) lines.push(await this.startManager(managerId, made.project.name, args.task.trim()));
    return lines.join('\n');
  }

  async startManager(managerId: string, project: string, text: string): Promise<string> {
    this.otherProject(managerId, project);
    const id = await this.ctx.ensureManager(project);
    await this.toManager(managerId, id, text, true);
    return `Manager "${this.title(id)}" (${id}) of "${project}" runs and gets your message.`;
  }

  async stopManager(managerId: string, project: string): Promise<string> {
    const p = this.otherProject(managerId, project);
    const mgr = p.managerId ? this.store.getSession(p.managerId) : undefined;
    if (!mgr || mgr.status === 'ended') return `The project "${project}" has no manager running.`;
    await this.ctx.stopSession(mgr.id, `Stopped by manager "${this.title(managerId)}" with stop_manager.`);
    return `Stopped manager "${mgr.title}". message_manager doesn't reach it now; start_manager starts it again.`;
  }

  // --- Projects' workflow settings (issue #306) --------------------------------------------------------
  // Only with the acting manager's project's toggle on, and never on a locked project, its own included: its
  // settings are the user's, in the page. Reads are free. A change that loosens what reaches the user is a
  // sensitive call (Martin's a on question #687, 2026-10-23); the session's PreToolUse hook asks settingsChange.

  /** Changes the hook let run unasked, by patchKey, until the tool runs them: what was judged is what runs. */
  private unaskedChanges = new Map<string, number>();
  /** Changes the user allowed, by patchKey, with the rule their prompt showed (review of #306, M2 and M3). */
  private approvedChanges = new Map<string, (string | null)[]>();

  /** The settings port, once the acting manager may use it here. */
  private settingsTools(managerId: string): NonNullable<ManagementContext['projectSettings']> {
    this.airgapped(managerId);
    const port = this.ctx.projectSettings;
    if (!port) throw new ManagementError("Projects' settings are not available in this Ledung.");
    const own = this.store.getSession(managerId)?.project;
    if (!this.ctx.projects().find((p) => p.name === own)?.projectSettingsTools) {
      throw new ManagementError(`Reading and changing projects' workflow settings is off for your project. ${this.ctx.userName} can switch it on in your project's settings ("Its manager reads and changes workflow settings of your projects").`);
    }
    return port;
  }

  /** A project whose settings the manager may read and change: there, and not locked. */
  private settingsTarget(port: NonNullable<ManagementContext['projectSettings']>, project: string): ProjectConfig {
    const config = port.config(project);
    if (!config) throw new ManagementError(`There is no project named "${project}". Use list_projects.`);
    if (lockdownOf(config).level !== 'off') {
      throw new ManagementError(`The project "${project}" is locked: no manager reads or changes its settings, its own included. ${this.ctx.userName} can, in the page.`);
    }
    return config;
  }

  /** project_settings: one project's workflow settings, or every project's, as JSON; a locked project shows as "locked". */
  projectSettings(managerId: string, project?: string): string {
    const port = this.settingsTools(managerId);
    const workflows = port.workflows();
    if (project !== undefined) return JSON.stringify({ [project]: settingsView(this.settingsTarget(port, project), workflows) }, null, 2);
    const all: Record<string, unknown> = {};
    for (const p of this.ctx.projects()) {
      const c = port.config(p.name);
      if (c) all[p.name] = lockdownOf(c).level === 'off' ? settingsView(c, workflows) : 'locked';
    }
    return JSON.stringify(all, null, 2);
  }

  /** The project's settings after the patch, checked as the page's save checks them; throws with the reason. */
  private patched(managerId: string, patch: SettingsPatch): { port: NonNullable<ManagementContext['projectSettings']>; before: ProjectConfig; after: ProjectConfig } {
    const port = this.settingsTools(managerId);
    const before = this.settingsTarget(port, patch.project);
    let after: ProjectConfig;
    try {
      after = parseProject(applyPatch(before, patch));
      // Only a workflow the call gives: one set in the page stays the user's (review of #306, M1).
      const outside = patch.workflow ? projectConfigProblem(after) : null;
      if (outside) throw new Error(outside);
      port.check(patch.project, after);
    } catch (e) {
      throw new ManagementError(`These settings can't be saved: ${(e as Error).message}`);
    }
    return { port, before, after };
  }

  /**
   * What the PreToolUse hook does with a set_project_settings call: refuse it (with the tool's own reason, so a
   * refused call never becomes a prompt), ask the user (a change that loosens what reaches them, with before and
   * after), or let it run unasked. A call it lets run is noted (note), so the tool runs exactly what was judged.
   */
  settingsChange(managerId: string, input: unknown, note = true): { deny: string } | { ask: string } | { allow: true } {
    const parsed = parsePatch(input);
    if ('problem' in parsed) {
      return parsed.unknown
        ? { deny: `set_project_settings changes only ${SETTINGS_FIELDS.join(', ')}; ${parsed.problem}` }
        : { ask: `Ledung could not check this change (${parsed.problem}), so it asks` };
    }
    let loosening: string[];
    try {
      const { before, after } = this.patched(managerId, parsed.patch);
      loosening = looseningChanges(before, after);
    } catch (e) {
      return { deny: (e as Error).message };
    }
    const rule = looseningRule(parsed.patch.project, loosening);
    if (rule) return { ask: rule };
    if (!note) return { allow: true };
    this.noteUnasked(patchKey(managerId, parsed.patch));
    return { allow: true };
  }

  /** A call the hook let run unasked, until the tool runs it. */
  private noteUnasked(key: string): void {
    this.unaskedChanges.set(key, (this.unaskedChanges.get(key) ?? 0) + 1);
    // A call let through that never reached the tool must not keep its place for ever.
    if (this.unaskedChanges.size > 200) this.unaskedChanges.delete(this.unaskedChanges.keys().next().value!);
  }

  /** Whether the hook let this call run unasked, used up. */
  private takeUnasked(key: string): boolean {
    const unasked = this.unaskedChanges.get(key) ?? 0;
    if (unasked > 1) this.unaskedChanges.set(key, unasked - 1);
    else this.unaskedChanges.delete(key);
    return unasked > 0;
  }

  private noteApproval(key: string, shown: string | null): void {
    this.approvedChanges.set(key, [...(this.approvedChanges.get(key) ?? []), shown]);
    if (this.approvedChanges.size > 200) this.approvedChanges.delete(this.approvedChanges.keys().next().value!);
  }

  /** The user allowed this set_project_settings call; shown: the rule its prompt showed. Called before the tool runs. */
  noteApprovedSettings(managerId: string, input: unknown, shown: string | null): void {
    const parsed = parsePatch(input);
    if (!('patch' in parsed)) return;
    this.noteApproval(patchKey(managerId, parsed.patch), shown);
  }

  /** The oldest approval waiting for this call, used up; undefined: none. */
  private takeApproval(key: string): string | null | undefined {
    const list = this.approvedChanges.get(key);
    if (!list?.length) return undefined;
    const [first, ...rest] = list;
    if (rest.length) this.approvedChanges.set(key, rest);
    else this.approvedChanges.delete(key);
    return first;
  }

  /**
   * set_project_settings: the patch, saved as the page saves it, once what it loosens now is checked against what was
   * decided. Approved by the user: it may loosen exactly what their prompt showed, nothing else (the target may have
   * changed while the prompt waited; review of #306, M2). Let through unasked by the hook: nothing. Neither: nothing
   * either, so a call that somehow skipped the hook and the prompt can't loosen anything (M3).
   */
  setProjectSettings(managerId: string, patch: SettingsPatch): string {
    const { port, before, after } = this.patched(managerId, patch);
    const key = patchKey(managerId, patch);
    const now = looseningRule(patch.project, looseningChanges(before, after));
    const approved = this.takeApproval(key);
    if (approved !== undefined) {
      if (now !== null && now !== approved) {
        throw new ManagementError(`The settings of "${patch.project}" changed while ${this.ctx.userName} was asked, so this change now loosens more than they allowed; nothing was saved. Call it again to ask ${this.ctx.userName}.`);
      }
    } else {
      const unasked = this.takeUnasked(key);
      if (now !== null) {
        throw new ManagementError(unasked
          ? `The settings of "${patch.project}" changed meanwhile, and this change now loosens what reaches ${this.ctx.userName}; nothing was saved. Call it again to ask ${this.ctx.userName}.`
          : `This change loosens what reaches ${this.ctx.userName} and ${this.ctx.userName} did not allow it; nothing was saved.`);
      }
    }
    const changed = changedFields(before, after);
    if (!changed.length) return `Nothing to change: "${patch.project}" has these settings already.`;
    try {
      port.update(patch.project, after);
    } catch (e) {
      throw new ManagementError(`These settings can't be saved: ${(e as Error).message}`);
    }
    return `Saved ${changed.join(', ')} for "${patch.project}". Its manager and sessions get them when they next start or resume; running ones keep theirs.`;
  }

  /** Another project than the manager's own: its own manager is itself, and its own sessions use start_session. */
  private otherProject(managerId: string, project: string): ProjectInfo {
    this.airgapped(managerId);
    const p = this.ctx.projects().find((x) => x.name === project);
    if (!p) throw new ManagementError(`There is no project named "${project}". Use list_projects.`);
    if (p.name === this.store.getSession(managerId)?.project) throw new ManagementError(`"${project}" is your own project; you are its manager.`);
    // Refused outright, approval or not: the user starts and stops a locked project's manager in the page (issue #109).
    if (this.lockedAgainst(managerId, p.name)) {
      throw new ManagementError(`The project "${p.name}" is locked: managers of other projects can't start or stop its manager. ${this.ctx.userName} can, in the page.`);
    }
    return p;
  }
}

/** A project's settings from a manager's tool call; a sensitive list left out gets the suggestions. */
function projectConfig(args: Omit<ProjectArgs, 'folder'>, folder: string): ProjectConfig {
  const config: Record<string, unknown> = { name: args.name, runner: 'local', path: folder };
  for (const [k, v] of Object.entries({ model: args.model, permissionMode: args.permissionMode, managerGrant: args.managerGrant, account: args.account, tickets: args.tickets })) {
    if (v !== undefined) config[k] = v;
  }
  // Anyone may lock a project (issue #109); only the user opens one up, in the page.
  if (args.lockdown && args.lockdown !== 'off') config.lockdown = { level: args.lockdown };
  // A named workflow is stored by name, so the project keeps it whatever the config's order (issue #132).
  if (args.workflow !== undefined) config.workflow = args.workflow.trim().toLowerCase() === 'none' ? { use: false } : { name: args.workflow.trim() };
  if (args.sensitive) {
    config.sensitive = { commandPatterns: args.sensitive.commandPatterns ?? [], pathPatterns: args.sensitive.pathPatterns ?? [], mcpTools: args.sensitive.mcpTools ?? [] };
  }
  return config as ProjectConfig;
}

/** A waiting clear (clear_session) is an inbox item "clear:<seconds>:<requester>"; Session.deliver carries it out. */
export const CLEAR_SOURCE = 'clear';
/** A session's "finished a turn" note for its manager ("turn-note:<session>"); a newer one replaces a waiting one. */
export const TURN_NOTE_SOURCE = 'turn-note';
/** The note delivered after a clear; dropped with the clear when it is cancelled. */
export const CLEAR_NOTE_SOURCE = 'clear-note';
/** The countdown before a clear, during which the user can cancel it. Never shorter than the minimum. */
export const CLEAR_SECONDS = 30;
export const CLEAR_MIN_SECONDS = 10;
export const CLEAR_MAX_SECONDS = 600;
export const isClear = (source: string) => source.startsWith(`${CLEAR_SOURCE}:`);
export function parseClear(source: string): { seconds: number; requester: string } {
  const [, seconds, ...requester] = source.split(':');
  return { seconds: Number(seconds) || CLEAR_SECONDS, requester: requester.join(':') };
}

/** A waiting compact is an inbox item "compact:<requester>" whose text is the note for the summary; Session.deliver carries it out. */
export const COMPACT_SOURCE = 'compact';
/** The note delivered after a compact ("compact-note:<requester>"); its heading is set once the outcome is known. */
export const COMPACT_NOTE_SOURCE = 'compact-note';
export const isCompact = (source: string) => source.startsWith(`${COMPACT_SOURCE}:`);
export const compactRequester = (source: string) => source.slice(COMPACT_SOURCE.length + 1);
/** The note for the summary: one line, at most this long (decided 2026-10-13). */
export const COMPACT_NOTE_MAX = 200;
/** No outcome after this long: the requester is alerted (decided 2026-10-13). */
export const COMPACT_ALERT_MINUTES = 10;

/** The note for the summary as Ledung passes it on: one line; refused rather than cut when too long, so the caller knows. */
export function compactNote(instructions: string | undefined): string | undefined {
  const note = instructions?.replace(/\s+/g, ' ').trim();
  if (!note) return undefined;
  if (note.length > COMPACT_NOTE_MAX) {
    throw new ManagementError(`The instructions are ${note.length} characters; at most ${COMPACT_NOTE_MAX}, on one line. Lasting rules belong in the project's CLAUDE.md under "## Compact Instructions".`);
  }
  return note;
}

/**
 * The input pushed for a compact. A note bends the rule that pushed text is a closed list of fixed
 * strings (findings 7), so Ledung writes the label and the requester only the one line inside it.
 */
export function compactCommand(note: string | null, requester: string, userName: string): string {
  return note ? `/compact Additional instructions from Ledung, requested by ${requester} (not from ${userName}): ${note}` : '/compact';
}

export type CompactOutcome =
  | { kind: 'success' }
  | { kind: 'failed'; reason: string }
  /** Too little to compact: a result with no boundary and no failure (findings 3). */
  | { kind: 'nothing' }
  /** The session ended (stopped, or Claude Code exited) before the compact did. */
  | { kind: 'ended' };

const kTokens = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`);

/** ": 70k → 2.4k in 16 s." from the boundary's figures, or "." without them. */
function figures(c: Pick<CompactingInfo, 'pre' | 'post' | 'durationMs'>): string {
  if (c.pre == null || c.post == null) return '.';
  return `: ${kTokens(c.pre)} → ${kTokens(c.post)}${c.durationMs != null ? ` in ${Math.round(c.durationMs / 1000)} s` : ''}.`;
}

/** The note after a compact, headed with how it went. */
export function compactNoteText(outcome: CompactOutcome, self: boolean, requesterTitle: string, note: string): string {
  const from = self ? 'Your note to yourself' : `Message from your manager "${requesterTitle}"`;
  const asked = self ? 'you asked for' : `your manager "${requesterTitle}" asked for`;
  const how = outcome.kind === 'success'
    ? (self ? 'Your conversation was compacted at your own request.' : `Your conversation was compacted by your manager "${requesterTitle}".`)
    : outcome.kind === 'failed' ? `The compact ${asked} failed (${outcome.reason}); your context is unchanged.`
      : outcome.kind === 'nothing' ? `There was nothing to compact yet; your context is unchanged.`
        : 'The session ended before the compact finished; your context is unchanged.';
  return `${how} ${from}:\n\n${note}`;
}

/** "context 142k of 200k", so a workflow can decide when to clear. */
export function contextLine(s: SessionInfo): string {
  if (s.contextTokens == null) return '';
  return `; context ${contextSize(s.contextTokens, s.contextWindow)}`;
}

/**
 * "Your context: 142k of 200k tokens." on every prompt, so a workflow's rule for clearing has its number
 * every turn (agent-manager's ctx-meter did this; issue #18). Empty until the session has a context size.
 */
export function promptContextLine(s: SessionInfo | undefined): string {
  if (s?.contextTokens == null) return '';
  return `Your context: ${contextSize(s.contextTokens, s.contextWindow)} tokens.`;
}

// The fixed sentence lives in src/shared so the page can recognise it (issue #64).
export { CONTEXT_SENTENCE };

export interface Delivery {
  /** What arrives as the user message: only the user's own words, behind fixed headers, plus the fixed sentence. */
  userText: string;
  /** Everything else, attached as context (not the user's words). Empty when there is none. */
  context: string;
}

/**
 * How waiting answers and inbox messages reach a session (step 4, findings in
 * docs/steps/step-4a-findings.md). Claude Code's permission layer takes whatever arrives as a user
 * message as the user's own words, so only text the user typed travels there: an answer from the
 * user, direct or forwarded by a manager, appears as "Answer to your question #N:" and the user's
 * text, nothing else. Questions (written by sessions), a manager's own decisions, its instructions,
 * tasks and Ledung's updates go in the context. Injected input stays a closed list of fixed texts.
 */
export function buildDelivery(
  userName: string,
  answers: QuestionInfo[],
  inbox: { text: string }[],
  titleOf: (id: string) => string,
): Delivery {
  const userParts: string[] = [];
  const context: string[] = [];
  for (const q of answers) {
    if (q.answeredBy === 'user') {
      userParts.push(`Answer to your question #${q.id}:\n\n${q.answer}`);
      context.push(
        `The answer to your question #${q.id} above is ${userName}'s own${q.forwardedFrom !== null ? ', passed on unchanged by your manager' : ''}. ` +
          `The question was:\n\n${q.question}`,
      );
    } else {
      context.push(
        `Your manager "${titleOf(q.answeredBy ?? '')}" decided, under its standing grant, on your question #${q.id}: ${q.answer}\n` +
          `This is the manager's decision, not ${userName}'s. The question was:\n\n${q.question}`,
      );
    }
  }
  for (const item of inbox) context.push(item.text);
  // Anything besides the user's own answers: the fixed sentence points to it.
  if (inbox.length || answers.some((q) => q.answeredBy !== 'user')) userParts.push(CONTEXT_SENTENCE(userName));
  return { userText: userParts.join('\n\n'), context: context.join('\n\n---\n\n') };
}

interface UsagePublishInput { enabled?: boolean; repo: string | null; allAccounts?: boolean; accounts?: Record<string, boolean> }

/** usage_publish's input; throws with the reason. */
function usagePublishInput(raw: unknown): UsagePublishInput {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw new ManagementError('Give enabled: true to publish, false to stop.');
  if (r.allAccounts !== undefined && typeof r.allAccounts !== 'boolean') throw new ManagementError('Give allAccounts as true or false.');
  const accounts = r.accounts;
  if (accounts !== undefined && (!accounts || typeof accounts !== 'object' || Array.isArray(accounts) || !Object.entries(accounts).every(([a, on]) => a.length > 0 && typeof on === 'boolean'))) {
    throw new ManagementError('Give accounts as { "<account name>": true or false }, "default" for this computer\'s own login.');
  }
  if (r.enabled === undefined && r.allAccounts === undefined && accounts === undefined) throw new ManagementError('Give enabled: true to publish, false to stop, or the accounts to publish.');
  if (r.repo !== undefined && r.repo !== null && typeof r.repo !== 'string') throw new ManagementError('Give the repository as owner/name.');
  return {
    ...(r.enabled !== undefined ? { enabled: r.enabled as boolean } : {}),
    repo: typeof r.repo === 'string' && r.repo.trim() ? r.repo.trim() : null,
    ...(r.allAccounts !== undefined ? { allAccounts: r.allAccounts as boolean } : {}),
    ...(accounts !== undefined ? { accounts: Object.fromEntries(Object.entries(accounts as Record<string, boolean>).sort(([a], [b]) => a.localeCompare(b))) } : {}),
  };
}

/** The same call, the same key, between the hook and the tool. */
function usagePublishKey(managerId: string, raw: unknown): string {
  let input: UsagePublishInput | null = null;
  try {
    input = usagePublishInput(raw);
  } catch { /* a call the hook refused never runs */ }
  return `${managerId}\nusage_publish\n${JSON.stringify(input)}`;
}

/** Publishing on this computer, in one line, for settings_status and usage_publish. */
function usagePublishLine(view: UsagePublishView | null): string {
  if (!view) return 'Publishing usage (Settings → Claude & usage): not available here.';
  const state = view.enabled ? `on, to "${view.repo}" as "${view.computer}"` : `off${view.repo ? ` (last repository "${view.repo}")` : ''}`;
  const last = view.lastPublishedAt ? `; last published ${new Date(view.lastPublishedAt).toLocaleString()}` : view.enabled ? '; not published yet' : '';
  const error = view.error ? `; the last try failed, tried again: ${view.error}` : '';
  const removals = view.pendingRemovals?.length ? `; this computer's file still to be removed from ${view.pendingRemovals.map((r) => `"${r}"`).join(', ')}` : '';
  const accounts = !view.enabled ? '' : view.allAccounts ? ' Accounts published: all, ones added later too.' : ` Accounts published: ${view.accounts.map((a) => `"${a}"`).join(', ')}.`;
  const own = view.projectRepos?.length ? ` Projects with a usage repository of their own: ${view.projectRepos.map((r) => `${r.projects.map((p) => `"${p}"`).join(', ')} to "${r.repo}"`).join('; ')}.` : '';
  return `Publishing usage (Settings → Claude & usage): ${state}${last}${error}${removals}.${accounts}${own} Which projects show by name is each project's publishUsageName, and where each goes its usageRepo (project_settings).`;
}
