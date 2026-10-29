// One live Claude Code session: drives it through the Agent SDK, stores every message,
// and holds permission prompts until Simon decides.
//
// Claude Code runs in a session host (src/host/), so the session survives a Ledung restart: on restart
// Ledung only detaches, and the next Ledung attaches again and gets what it missed. Messages are stored
// as they arrive from the host, each with its sequence number, in one write.
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { query, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { connectHost, type ConnectionHandlers, type HostConnection } from '../host/client.ts';
import type { Runner } from '../runners/runner.ts';
import type { SignInContext } from '../accounts/signin.ts';
import type { Store } from '../store/store.ts';
import type { UsageStopInfo } from '../shared/protocol.ts';
import { promptUsageLine, windowName } from '../usage/stops.ts';
import type { AttachedSource, CompactingInfo, McpServerInfo, PermissionDecision, PermissionMode, PullRequestInfo, ServerEvent, SessionInfo, StoredMessage } from '../shared/protocol.ts';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { AllowedNotes, asSessionUpdate, describeRule, exactRule, rulesFromSuggestions } from './grants.ts';
import {
  buildDelivery, CLEAR_NOTE_SOURCE, COMPACT_ALERT_MINUTES, compactCommand, compactRequester, isClear, isCompact, parseClear, promptContextLine,
  type CompactOutcome, type Management, type ShotInput,
} from './management.ts';
import { mergeAnswered, routePermission, sensitiveHookOutput, type SensitiveRules } from './sensitive.ts';
import { promptTimeLine } from './elapsed.ts';
import { settingsAction, wordsFor, type Word } from './word.ts';
import { promptAwayLine, classify, decide as awayDecide, FLOOR_TIMEOUT_MS, formatLog, type Away } from './away.ts';
import type { AwayInfo } from '../shared/protocol.ts';
import { deskQuestion, questionText, type QuestionDetails } from '../shared/questions.ts';
import { compactionUsage, contextAfterCompact, UsageRecorder, type SessionFacts } from '../usage/recorder.ts';
import { findTickets } from '../usage/links.ts';
import type { PullRequestPoller } from './pr-poll.ts';
import { CONTEXT_TOOLS, instructions, LEDUNG_SERVER, LEDUNG_TOOLS, ledungToolServer, MCP_LIMIT_ENV, mcpLimitFor, SETTINGS_CHANGE_RULE, SETTINGS_CHANGE_TOOLS, SETTINGS_TOOLS, USAGE_PUBLISH_TOOLS, USER_APPROVED_TOOLS, type BoardHandlers, type ManagerHandlers, type ToolHandlers } from './tools.ts';
import type { Boards } from '../board/boards.ts';
import { commandKinds } from '../resources/commands.ts';
import { FRESH_FACTS, pauseReason, type IdleState } from './idle.ts';
import { skillsFromFiles, skillsOff, withSkillsOff, type SkillChoices } from './skills.ts';
import { needsPluginIds, parseSettingsFile, pluginIdsIn, profileOptions, settingsFilePath, type Profile } from './profiles.ts';
import { workflowInstructions, type ProjectWorkflow } from './workflow.ts';
import { promptNudges } from './workflow-nudges.ts';
import { RemoteControl } from './remote-control.ts';
import { McpError, mcpServers, reconnectMcp } from './mcp.ts';
import { boundarySettings, withBoundary } from './boundary.ts';
import { airgapEnvironment, airgapSettings, airgapTempFolder, makeAirgapTempFolder, othersSettings, versionProblem, withAirgapSettings, withOthersSettings } from '../projects/lockdown.ts';
import { userDataDir } from '../platform/paths.ts';
import { startShell, SHELL_TIMEOUT_MS, type ShellKind, type ShellRun } from '../runners/shell-run.ts';
import { bashModeText } from './bang.ts';
import { conversationBefore } from './earlier.ts';
import { attachSources, type SourceContext } from './sources.ts';
import type { SessionRole, ShellBlock } from '../shared/protocol.ts';
import { exercisedLine } from '../platform/exercised.ts';

/** The EXERCISED line of issue #369, once per run. */
let sourcesExercised = false;
/** The EXERCISED line of issue #405, once per run. */
let nudgesExercised = false;

/** The limit on working sessions (step 6), as a session sees it. */
export interface TurnGate {
  /** May this session start a turn now? If not, it waits in line (status 'queued'). */
  mayStart(id: string): boolean;
  /** A turn started or ended: for measuring, and to let the next in line start. */
  started(id: string, trigger: string): void;
  ended(id: string, commands: string[]): void;
  /** The usage stop holding this session's account (issue #278): no new turn starts, as when paused. */
  usageHold?(id: string): UsageStopInfo | undefined;
  /** A session stopped counting as working without ending its turn (held at a tool call): the line may move. */
  freed?(): void;
  /** Every usage stop and where it stands, for a manager's prompt line. */
  usageStops?(): UsageStopInfo[];
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  plan: 'Plan',
};

/** Lines from Claude Code that are protocol or noise, not history. */
const NOT_STORED_TYPES = new Set(['control_request', 'control_response', 'control_cancel_request', 'keep_alive', 'stream_event', 'rate_limit_event']);
const NOT_STORED_SYSTEM = new Set(['thinking_tokens']);
/** Ledung's tool server: in Ledung, never Claude Code's to reconnect (issue #118). */
const OWN_SERVERS = [LEDUNG_SERVER];

/** Multi-turn input for the SDK: an async iterable fed by push(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string, opts: { shouldQuery?: false } = {}): void {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...opts });
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

/** What Claude Code passes with a permission request. */
interface PermissionOpts {
  signal: AbortSignal;
  title?: string;
  decisionReason?: string;
  requestId?: string;
  suggestions?: PermissionUpdate[];
  toolUseID?: string;
}

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  /** Claude Code's suggested rules for "don't ask again". */
  suggestions?: PermissionUpdate[];
  /** Sensitive requests are allowed once at most. */
  sensitive: boolean;
  /** The call it is about, so the note after it can say who allowed it. */
  toolUseID?: string;
}

/** What the skill picker chose for a session (#300): its role, Settings' defaults and its project's own. */
export interface SessionSkills {
  role: SessionRole;
  defaults: SkillChoices;
  project: SkillChoices | undefined;
}

export interface SessionOptions {
  info: SessionInfo;
  runner: Runner;
  store: Store;
  publish: (event: ServerEvent) => void;
  /** A model chosen for this one session; always wins. */
  model?: string;
  /** The project's default model: used unless the profile's settings file names a model. */
  defaultModel?: string;
  /** Claude Code session id to resume in a new host. */
  resume?: string;
  /** Attach to the host already running this session (after a Ledung restart). */
  attachTo?: string;
  /** How sessions refer to the person using Ledung ("Simon"). */
  userName: string;
  management: Management;
  /** For a manager: what its project allows it to decide on the user's behalf. */
  grant?: string;
  /** The project's workflow, if it follows one (issue #21). */
  workflow?: ProjectWorkflow | null;
  /** The project's sensitive patterns (the built-in ones always apply too). */
  sensitive?: Partial<SensitiveRules>;
  /** The managers' project tools run unasked instead of always going to the user (issue #37; opt-in of 2026-10-14). */
  projectToolsUnasked?: boolean;
  /** The project's ticket pattern (step 5c). */
  tickets?: { pattern: string; url: string };
  /** Away mode (issue #35), and the project's dev ship command it may let through. */
  away?: Away;
  devShip?: string | null;
  gate: TurnGate;
  /** The project's Claude account: its name, and the login it puts in the environment (P3). */
  account?: { name: string; env: Record<string, string> } | null;
  /** Who Claude Code found itself logged in as, once the session is up. */
  onAccountInfo?: (info: { email?: string; organization?: string; subscriptionType?: string }) => void;
  /**
   * Whether Claude Code is signed in for its account (issue #333), checked on every start in the session's
   * folder with the settings it gets: refuse with how to sign in, warn and go on when it couldn't tell, or null.
   */
  signInRefusal?: (where: SignInContext) => Promise<{ refuse: string } | { warn: string } | null>;
  /** What it gets of the user's own setup (#20); none: everything (full). */
  profile?: Profile;
  /** Plugin ids turned off whatever the profile where installed (the workflow's and the config's pluginsOff, issues #265, #298). */
  pluginsOff?: string[];
  /** Which of the user's own skills it gets (#300); null or none: all of them (chats). */
  skills?: SessionSkills | null;
  /** Remote Control's name in the Claude app, for a manager (#19); null: no Remote Control. */
  remoteControl?: string | null;
  /** The message boards, for a manager whose project has the board on (decision 9); the tools go to its project's board. */
  board?: Boards | null;
  /** Opens the Claude Code session; default: the SDK's query. A test passes a stand-in to drive start() (#49). */
  query?: typeof query;
  /** While another project is locked: its folders kept from this session (issue #109); null: none locked. */
  lockdown?: ReturnType<typeof othersSettings>;
  /**
   * Its project is in lockdown level B, nearly air-gapped (issue #109): the hosts its shell may reach, the
   * folders whose Claude Code settings it can't change, and whether its shell runs in the sandbox (on
   * this computer; a container is its own wall). null: not level B.
   */
  airgap?: { network: string[]; folders: string[]; sandbox: boolean } | null;
  /** The one pull request poll, in the session manager (issue #252); none: the branch's pull request isn't looked up. */
  pullRequests?: Pick<PullRequestPoller, 'watch' | 'forget'> | null;
}

/**
 * Logins Ledung's own environment may carry; a session with its own account never inherits them. Ledung's
 * CLAUDE_CONFIG_DIR is not one: an account is only the sign-in, and its sessions keep the Claude Code folder
 * every session has, with its conversations and skills (#342).
 */
const LOGIN_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];

/** The environment for Claude Code: Ledung's, with the project's account login instead of any other,
 *  and the tool server limit raised so that Ledung's instructions arrive whole (issue #32). */
export function claudeEnvironment(
  base: NodeJS.ProcessEnv, accountEnv: Record<string, string> | undefined, ledungInstructions: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !(accountEnv && LOGIN_ENV.includes(k))) env[k] = v;
  return { ...env, ...accountEnv, [MCP_LIMIT_ENV]: mcpLimitFor(ledungInstructions, base[MCP_LIMIT_ENV]) };
}

export class Session {
  readonly id: string;
  private readonly runner: Runner;
  private readonly store: Store;
  private readonly publish: (event: ServerEvent) => void;
  private readonly model: string | undefined;
  private readonly defaultModel: string | undefined;
  private readonly resume: string | undefined;
  private readonly attachTo: string | undefined;
  private readonly userName: string;
  private readonly management: Management;
  private readonly grant: string | undefined;
  private readonly workflow: ProjectWorkflow | null;
  /** The nudges file's problem this session was last told of, so it is told once, not every prompt (issue #405). */
  private nudgesProblemTold: string | null = null;
  private readonly sensitiveRules: Partial<SensitiveRules>;
  private readonly alwaysAsked: readonly string[];
  private readonly ticketConfig: { pattern: string; url: string } | undefined;
  private readonly away: Away | undefined;
  private readonly devShip: string | null;
  private readonly pullRequests: SessionOptions['pullRequests'];
  /** Ends a clear's countdown (clear_session). */
  private clearTimer: NodeJS.Timeout | null = null;
  private readonly input = new InputQueue();
  /** The last thing the session said this turn, for its manager's update. */
  private lastReply = '';
  /** It asked a question this turn: the question itself already tells the manager. */
  private askedThisTurn = false;
  /** Who allowed a call, for the note after it (issue #18). */
  private readonly allowedBy = new AllowedNotes();
  /** Context to attach to a delivered message, by its exact text, picked up by the UserPromptSubmit hook. */
  private readonly contextFor = new Map<string, string>();
  private readonly usage = new UsageRecorder();
  private branch: string | null = null;
  private readonly pending = new Map<string, PendingPermission>();
  private q: Query | null = null;
  private connection: HostConnection | null = null;
  private stopping = false;
  private detaching = false;
  private stderrTail: string[] = [];
  private lastInit = '';
  private backgroundTasks = 0;
  /** Every background task, ambient ones (Monitor, watchers) included: for the idle check, not the label. */
  private allBackgroundTasks = 0;
  /** The last sign of life of any kind; the idle clock counts from here (a Ledung restart resets it). */
  private lastActivity = Date.now();
  /** When the previous prompt arrived, for the time line (issue #265); the latest one stored before this object. */
  private lastPromptAt: number | null;
  /**
   * Resumed, and nothing heard from Claude Code yet. Spike finding 7 saw an empty result (zero turns)
   * here; Claude Code 2.1.295 sends none and waits for the first message (idle stop live test). Should
   * one come, it must not end the turn of a message already delivered.
   */
  private awaitingResumeResult: boolean;
  private finished: Promise<void> = Promise.resolve();
  private readonly gate: TurnGate;
  private readonly account: { name: string; env: Record<string, string> } | null;
  private readonly onAccountInfo: SessionOptions['onAccountInfo'];
  private readonly signInRefusal: SessionOptions['signInRefusal'];
  private readonly profile: Profile | undefined;
  private readonly pluginsOff: string[];
  private readonly skills: SessionSkills | null;
  /** The profile's settings file as read at this start or resume (#20 settingsFile). */
  private fileSettings: Record<string, unknown> | undefined;
  /** A turn is under way (between its start and its result). */
  private turnOpen = false;
  /** The kinds of command run this turn (step 6c). */
  private turnCommands: string[] = [];
  /** The usage stop window this session last said it is held for, so it says so once (issue #278). */
  private heldFor: string | null = null;
  /** Tool calls waiting while a usage stop holds the account. */
  private heldWaiters: (() => void)[] = [];
  /** When the current turn began, whoever started it; null between turns. */
  private turnStartedAt: number | null = null;
  /** Tool calls waiting while the session is paused. */
  private pauseWaiters: (() => void)[] = [];
  private readonly remote: RemoteControl | null;
  private readonly openQuery: typeof query;
  private readonly board: Boards | null;
  private readonly lockdown: ReturnType<typeof othersSettings>;
  private readonly airgap: NonNullable<SessionOptions['airgap']> | null;
  /** Level B on this computer: the session's own temp folder, made at each start (lockdown.ts). */
  private airgapTmp: string | null = null;
  /** The Claude Code program to start, when not the SDK's own copy (issue #341); set at every start and resume. */
  private claudePath: string | undefined;
  /** The `!` command running now (issue #212); one at a time. */
  private shellRun: { command: string; startedAt: number; run: ShellRun } | null = null;
  /** `!` output that waits for the turn under way to end before it goes to Claude. */
  private shellAppends: string[] = [];
  /**
   * `!` output sent and not yet answered: each gives an empty result with no turn (num_turns 0, no call to the
   * model; #212 build step 1, through the host). Those results are no turn's end and no compact's.
   */
  private shellResultsDue = 0;
  private shellResultsToSkip = 0;

  constructor(opts: SessionOptions) {
    this.id = opts.info.id;
    this.lastPromptAt = opts.store.lastUserMessageAt(opts.info.id);
    this.runner = opts.runner;
    this.store = opts.store;
    this.publish = opts.publish;
    this.model = opts.model;
    this.defaultModel = opts.defaultModel;
    this.resume = opts.resume;
    this.attachTo = opts.attachTo;
    // Mid-turn when Ledung restarted: that turn began before any stop it now sees, so it finishes (review 2 of #278, finding 3).
    if (opts.info.status === 'running' || opts.info.status === 'waiting') this.turnStartedAt = 0;
    this.userName = opts.userName;
    this.management = opts.management;
    this.grant = opts.grant;
    this.workflow = opts.workflow ?? null;
    this.sensitiveRules = opts.sensitive ?? {};
    // Settings' actions stay asked whatever projectToolsUnasked says (issue #263).
    this.alwaysAsked = [...(opts.projectToolsUnasked ? [] : USER_APPROVED_TOOLS), ...SETTINGS_TOOLS];
    this.ticketConfig = opts.tickets;
    this.away = opts.away;
    this.devShip = opts.devShip ?? null;
    this.gate = opts.gate;
    this.account = opts.account ?? null;
    this.onAccountInfo = opts.onAccountInfo;
    this.signInRefusal = opts.signInRefusal;
    this.profile = opts.profile;
    this.pluginsOff = opts.pluginsOff ?? [];
    this.skills = opts.skills ?? null;
    this.awaitingResumeResult = !!opts.resume && !opts.attachTo;
    this.openQuery = opts.query ?? query;
    this.board = opts.board ?? null;
    this.pullRequests = opts.pullRequests ?? null;
    this.lockdown = opts.lockdown ?? null;
    this.airgap = opts.airgap ?? null;
    this.remote = opts.remoteControl
      ? new RemoteControl(opts.remoteControl, () => this.publish({ type: 'session', session: this.info }), (text) => this.record('event', { text }))
      : null;
  }

  /** Claude Code's config folder as this session's environment sets it: null when it is Ledung's own (an account only sets the sign-in, #342). */
  private loginFolder(): string | null {
    return this.account?.env.CLAUDE_CONFIG_DIR ?? null;
  }

  /** The manager's tools, bound to this session. */
  private managerHandlers(): ManagerHandlers {
    const m = this.management;
    const id = this.id;
    return {
      startSession: (args) => m.startSession(id, args),
      listSessions: () => m.listSessions(id),
      readSession: (sid, last) => m.readSession(id, sid, last),
      sendMessage: (sid, text) => m.sendMessage(id, sid, text),
      stopSession: (sid) => m.stopSession(id, sid),
      clearSession: (sid, then, seconds) => m.clearSession(id, sid, then, seconds),
      compactSession: (sid, note, then) => m.compactSession(id, sid, note, then),
      archiveSession: (sid) => m.archiveSession(id, sid),
      answerQuestion: (q, answer) => m.answerQuestion(id, q, answer),
      forwardAnswer: (from, to) => m.forwardAnswer(id, from, to),
      listManagers: (computer) => m.listManagersEverywhere(id, computer),
      messageManager: (to, text, computer) => (computer ? m.messageComputerManager(id, computer, to, text) : m.messageManager(id, to, text)),
      decidePermission: (request, behavior, scope, message) => m.decidePermission(id, request, behavior, scope, message),
      listPermissions: () => m.listPermissions(id),
      machineStatus: () => m.machineStatus(id),
      setPriority: (sid, priority, q) => m.setPriority(id, sid, priority, q),
      setPaused: (sid, paused) => m.setPaused(id, sid, paused),
      mcpStatus: (sid) => m.mcpStatus(id, sid),
      reconnectMcp: (sid, name) => m.reconnectMcp(id, sid, name),
      awayLog: (since) => {
        const from = since === undefined ? undefined : Date.parse(since);
        if (from !== undefined && Number.isNaN(from)) throw new Error(`"${since}" is not a date and time; use e.g. 2026-10-13T00:00.`);
        if (!this.away) return 'Away mode is not available here.';
        return formatLog(this.away.log(id, from), this.away.current(), this.userName, this.away.period());
      },
      listProjects: (computer) => m.listProjectsOn(id, computer),
      addProject: (args) => m.addProject(id, args),
      createProject: (args) => m.createProject(id, args),
      startManager: (project, text) => m.startManager(id, project, text),
      stopManager: (project) => m.stopManager(id, project),
      projectSettings: (project) => m.projectSettings(id, project),
      setProjectSettings: (patch) => m.setProjectSettings(id, patch),
      settingsStatus: () => m.settingsStatus(id),
      relayAddress: (relay) => m.relayAddress(id, relay),
      relayAdminKey: () => m.relayAdminKey(id),
      linkCode: () => m.linkCode(id),
      linkComputer: (code, name) => m.linkComputer(id, code, name),
      inviteComputer: (owner, name) => m.inviteComputer(id, owner, name),
      usagePublish: (args) => m.usagePublish(id, args),
    };
  }

  /** The board tools, bound to this manager and its project. */
  private boardHandlers(): BoardHandlers | undefined {
    const board = this.board;
    if (!board) return undefined;
    const project = () => this.store.getSession(this.id)!.project;
    return {
      post: (args) => board.post(this.id, project(), args),
      read: (args) => board.read(project(), args),
      threads: (all) => board.threads(project(), all),
    };
  }

  get info(): SessionInfo {
    const s = this.store.getSession(this.id)!;
    const shell = this.shellRun && { command: this.shellRun.command, startedAt: this.shellRun.startedAt };
    return { ...s, backgroundTasks: this.backgroundTasks, shell, remoteControl: s.status === 'ended' ? null : this.remote?.info ?? null, tickets: findTickets([s.title, s.branch, s.pr?.title], this.ticketConfig) };
  }

  private update(fields: Parameters<Store['updateSession']>[1]): void {
    this.store.updateSession(this.id, fields);
    this.publish({ type: 'session', session: this.info });
  }

  private record(kind: StoredMessage['kind'], data: unknown): void {
    this.publish({ type: 'message', message: this.store.addMessage(this.id, kind, data) });
  }

  /**
   * The program the SDK is told to run. Given none, the SDK looks for its own copy and throws when there is
   * none, as in an npm install, whose package leaves the copies out (#421; review of PR #441). So it gets one
   * whenever it doesn't start the program itself: a reattached session's host already runs the program it
   * started with, and a container runs its own `claude` (DockerRunner.launchSpec), so there the path is only a
   * name for spawnClaudeCodeProcess, which doesn't start it.
   */
  private programPath(): string | undefined {
    if (this.attachTo) return this.info.claudeProgram?.path ?? 'claude';
    if (!this.runner.claudeProgram) return 'claude';
    return this.claudePath;
  }

  async start(): Promise<void> {
    if (!this.attachTo) {
      try {
        await this.runner.prepare();
        // Which Claude Code this start runs (issue #341). None fit to run refuses the start, with how to fix it, after
        // the settings file's and sign-in's own refusals, which say more about this session.
        const claude = await this.runner.claudeProgram?.();
        const noClaude = !!claude && !claude.program;
        // Level B relies on settings an older Claude Code would ignore without a word: refused instead (issue #109).
        // With none fit to run, #341's refusal says how to install or update it, which is clearer.
        if (this.airgap) {
          if (noClaude) throw new Error(claude.problem ?? 'There is no Claude Code to start.');
          const problem = versionProblem(await this.runner.claudeVersion());
          if (problem) throw new Error(problem);
          if (this.airgap.sandbox) this.airgapTmp = makeAirgapTempFolder(airgapTempFolder(this.id));
        }
        // Read on every start and resume, so an edit is picked up; a missing file stops the start.
        const file = this.profile?.settingsFile;
        if (file) this.fileSettings = parseSettingsFile(file, await this.runner.readProjectFile(settingsFilePath(file)));
        // After the settings file: it and the project's own settings can sign a session in (review of #333).
        const settings = { ...this.profile?.settings as Record<string, unknown> | undefined, ...this.fileSettings };
        const signIn = await this.signInRefusal?.({ cwd: this.runner.cwd, settings });
        if (signIn && 'refuse' in signIn) throw new Error(signIn.refuse);
        // Without a Claude Code the sign-in couldn't be asked: the refusal below says why, not a warning.
        if (signIn && !noClaude) this.record('event', { text: signIn.warn });
        if (noClaude) throw new Error(claude.problem ?? 'There is no Claude Code to start.');
        this.claudePath = claude?.program && claude.program.kind !== 'bundled' ? claude.program.path : undefined;
        this.update({ claudeProgram: claude?.program ? { kind: claude.program.kind, path: claude.program.path } : null });
      } catch (e) {
        this.record('event', { text: `Could not start: ${(e as Error).message}` });
        this.update({ status: 'ended', endedAt: Date.now(), endReason: (e as Error).message });
        return;
      }
      // A new host numbers its lines from 1.
      this.store.resetHostSeq(this.id);
      // A new Claude Code process has nothing in the background and nothing scheduled yet.
      this.store.setIdleFacts(this.id, FRESH_FACTS);
      this.record('event', { text: this.resume ? 'Session resumed.' : 'Session started.' });
    }
    const handlers = {
      onLine: (seq: number, at: number, json: string) => this.onHostLine(seq, at, json),
      onStderr: (text: string) => {
        this.stderrTail = [...this.stderrTail, text].slice(-20);
      },
    };
    this.q = this.openQuery({ prompt: this.input, options: await this.claudeOptions(handlers) });
    // Only once the query is open: a reattach that throws is reported by the manager, not first called a success (review of PR #441, round 2).
    if (this.attachTo) this.record('event', { text: 'Ledung restarted; reconnected to the running session.' });
    this.finished = this.readLoop(this.q);
    this.refreshBranch();
    this.startRemoteControl();
    // Which account it really is, for the page (accountInfo waits for Claude Code to be up).
    if (this.onAccountInfo) {
      const q = this.q;
      void q.accountInfo().then((info) => this.onAccountInfo?.(info), () => {});
    }
  }

  /**
   * A manager's `gh pr merge N` that the user already said yes to, as an answer to one of its own questions
   * about #N in the last two days: allowed without asking again, recorded with the question (decided
   * 2026-10-13; agent-manager's gate did the same with the owner's word in the lead pane). Null: as before.
   */
  private mergeOnAnswer(toolName: string, input: Record<string, unknown>, toolUseId: string | undefined): Record<string, unknown> | null {
    if (toolName !== 'Bash' || typeof input.command !== 'string') return null;
    if (this.store.getSession(this.id)?.role !== 'manager') return null;
    const since = Date.now() - 2 * 24 * 3600 * 1000;
    const own = this.store.listQuestions(500, false).filter((q) => q.sessionId === this.id && (q.answeredAt ?? 0) > since);
    // The user's own words typed into the manager count as well, as the lead pane did in agent-manager:
    // a stored user message without `from` is theirs; Ledung's deliveries carry from: 'ledung'. Ids < 0.
    const typed = this.store.listMessages(this.id, { limit: 400 })
      .filter((m) => m.kind === 'user' && !m.data.from && typeof m.data.text === 'string' && m.at > since)
      .map((m, k) => ({ id: -(k + 1), question: m.data.text as string, answer: m.data.text as string, answeredBy: 'user', typed: true, at: m.at }));
    const hit = mergeAnswered(input.command, this.sensitiveRules, [...own, ...typed]);
    if (!hit) return null;
    const said = hit.questionId < 0
      ? `in what they typed at ${new Date(typed[-hit.questionId - 1]!.at).toLocaleTimeString()}`
      : `in their answer to question #${hit.questionId}`;
    const why = `${this.userName} said yes to merging #${hit.pr} ${said}`;
    this.record('event', { text: `Merge of #${hit.pr} allowed: ${why}.` });
    this.allowedBy.answered(toolUseId, why);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `Allowed by Ledung: ${why}.` } };
  }

  /**
   * A manager's Settings action (issue #263) that the user's own words already name: allowed without a prompt,
   * once per word and action, and recorded with the word. Only words given on this computer count, typed into
   * this manager or answering one of its own questions, in the last two days (Martin's b on question #447): from
   * the phone the prompt comes, signed with its passkey. A session's, a manager's or a board post's words never
   * count, nor a delivered message (it carries `from`). Null: asked like every sensitive call.
   */
  private settingsOnWord(toolName: string, input: Record<string, unknown>, toolUseId: string | undefined): Record<string, unknown> | null {
    const action = settingsAction(toolName);
    if (!action || this.store.getSession(this.id)?.role !== 'manager') return null;
    const since = Date.now() - 2 * 24 * 3600 * 1000;
    const said = new Map<string, string>();
    const answers: Word[] = this.store.listQuestions(500, false)
      .filter((q) => q.sessionId === this.id && q.answeredBy === 'user' && q.answer !== null && (q.answeredAt ?? 0) > since
        && !q.aboutRequest && !q.forwardedFrom && this.store.answeredHere(q.id))
      .map((q) => {
        said.set(`q${q.id}`, `in their answer to question #${q.id}`);
        // The question's options as the desk shows them: only an option the user picked can name the action; the
        // question's prose and the manager's recommendation never do (lead's review, rounds 3 and 4).
        return { key: `q${q.id}`, text: q.answer!, ask: { options: deskQuestion(q).options } };
      });
    const typed: Word[] = this.store.listMessages(this.id, { limit: 400 })
      .filter((m) => m.kind === 'user' && !m.data.from && m.data.here === true && typeof m.data.text === 'string' && m.at > since)
      .map((m) => {
        said.set(`m${m.id}`, `in what they typed at ${new Date(m.at).toLocaleTimeString()}`);
        return { key: `m${m.id}`, text: m.data.text as string };
      });
    // One instruction runs once: every word that tells it is used up together (useWord is atomic), so the same
    // instruction typed and then said yes to as the manager's question can't run it twice (review of #263, finding 2).
    const fresh = wordsFor(action, input, [...typed.reverse(), ...answers]).filter((w) => this.store.useWord(this.id, w.key, action));
    const word = fresh[0];
    if (!word) return null;
    const why = `${this.userName} asked for this (${action.replace(/_/g, ' ')}) ${said.get(word.key)}`;
    this.record('event', { text: `Settings action allowed: ${why}.` });
    this.allowedBy.named(toolUseId, why);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `Allowed by Ledung: ${why}.` } };
  }

  /**
   * The PreToolUse hook's answer for set_project_settings (issue #306): refused, asked of the user as a sensitive
   * call when it loosens what reaches them (Martin's a on question #687), else allowed, unless the project's own
   * sensitive lists name the tool. Only a manager has the tool; anyone else's call is refused. usage_publish the
   * same way: asked when it switches publishing on or moves it (issue #376).
   */
  private settingsChangeHook(toolName: string, raw: unknown): Record<string, unknown> {
    const out = (permissionDecision: 'allow' | 'ask' | 'deny', permissionDecisionReason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });
    if (this.store.getSession(this.id)?.role !== 'manager') return out('deny', "Only a manager changes projects' settings.");
    let decision: ReturnType<Management['settingsChange']>;
    try {
      decision = USAGE_PUBLISH_TOOLS.includes(toolName) ? this.management.usagePublishChange(this.id, raw) : this.management.settingsChange(this.id, raw);
    } catch (e) {
      return out('ask', `Ledung could not check this change (${(e as Error).message}), so it asks.`);
    }
    if ('deny' in decision) return out('deny', decision.deny);
    if ('ask' in decision) return out('ask', `Sensitive: ${decision.ask}`);
    const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const own = sensitiveHookOutput(toolName, input, this.sensitiveRules);
    return 'hookSpecificOutput' in own ? own : out('allow', USAGE_PUBLISH_TOOLS.includes(toolName)
      ? 'Allowed by Ledung: switching publishing off, or leaving it as it is.'
      : "Allowed by Ledung: a change to a project's settings that loosens nothing.");
  }

  /** The rule a set_project_settings prompt names: what it loosens, with before and after (issue #306). */
  private settingsChangeRule(toolName: string, input: Record<string, unknown>): string {
    try {
      const d = USAGE_PUBLISH_TOOLS.includes(toolName) ? this.management.usagePublishChange(this.id, input, false) : this.management.settingsChange(this.id, input, false);
      if ('ask' in d) return d.ask;
    } catch {
      // The plain rule below.
    }
    return SETTINGS_CHANGE_RULE;
  }

  /** Remote Control for a manager, at once, new, resumed or reattached alike: the call waits for Claude Code
   *  to be up, and answers before the first turn ends, also while it waits on a permission prompt (#49 probe,
   *  SDK 0.3.295, 2026-10-13: the link at 1.8 s, the first result at 9.6 s). It used to wait for a new
   *  manager's first result (#19's first probe), which kept a manager stuck on a prompt out of the Claude app. */
  private startRemoteControl(): void {
    if (this.remote && this.q) void this.remote.enable(this.q);
  }

  /** Claude Code's options for this session: its profile's (#20), then Ledung's own, with Ledung's tool server last. */
  async claudeOptions(handlers: ConnectionHandlers): Promise<Options> {
    // The profile's options (#20). Plugins go off one by one, by the ids the session's own settings name;
    // a running process being reattached already has its plugins, so it isn't asked again.
    const pluginIds = this.profile && needsPluginIds(this.profile, this.pluginsOff) && !this.attachTo
      ? pluginIdsIn(await this.runner.pluginSettingsTexts(this.loginFolder()))
      : [];
    const profile = this.profile ? profileOptions(this.profile, pluginIds, this.fileSettings, this.pluginsOff) : {};
    // The user's own skills its project's picker turns off (#300), by the ones found where it runs, so a skill
    // added since is covered by its role's default; a reattached process already has its skills.
    if (this.skills && !this.attachTo) {
      const found = skillsFromFiles(await this.runner.skillFiles(this.loginFolder())).map((k) => k.name);
      const off = skillsOff(found, this.skills.role, this.skills.defaults, this.skills.project);
      profile.settings = withSkillsOff(profile.settings as Record<string, unknown> | undefined, off) as Options['settings'];
    }
    const role = this.store.getSession(this.id)!.role;
    const manager = this.management.managerOf(this.id);
    const tools: ToolHandlers = {
      userName: this.userName,
      role,
      asksWhom: manager ? `your manager "${manager.title}"` : this.userName,
      grant: this.grant,
      tiers: () => this.management.questionTiers(this.id),
      // Part of Ledung's instructions, so the length limit worked out from them covers it (#32).
      workflow: this.workflow ? workflowInstructions(this.workflow, role) : undefined,
      ask: (question, options, about, aboutRequest, details, shots, sources) => this.ask(question, options, about, aboutRequest, details, shots, sources),
      attach: (sources) => attachSources(sources, this.sourceContext()),
      withdraw: (id, reason) => this.withdraw(id, reason),
      manager: role === 'manager' ? this.managerHandlers() : undefined,
      board: role === 'manager' ? this.boardHandlers() : undefined,
      airgap: !!this.airgap,
      self: role === 'manager' ? undefined : {
        compact: (note, then) => this.management.compactSelf(this.id, note, then),
        clear: (file, then, seconds) => this.management.clearSelf(this.id, file, then, seconds),
      },
    };
    // Level B's own temp folder; a reattached session already runs with it.
    const tmp = this.airgap?.sandbox ? this.airgapTmp ?? airgapTempFolder(this.id) : null;
    // Ledung's data folder and the hosts' sockets are out of every session's reach (#104).
    const boundary = boundarySettings({ dataDir: userDataDir(), ownLoginFolder: this.loginFolder() ?? process.env.CLAUDE_CONFIG_DIR ?? null });
    return {
      ...profile,
      // And another project's locked folders, while one is (issue #109); none locked: unchanged. Level B's
      // airgap last, so nothing before it keeps a way out.
      settings: withAirgapSettings(
        withOthersSettings(withBoundary(profile.settings as Record<string, unknown> | undefined, boundary), this.lockdown),
        this.airgap && airgapSettings({ network: this.airgap.network, folders: [this.runner.cwd, ...this.airgap.folders], sandbox: this.airgap.sandbox, tmp }),
      ) as Options['settings'],
      cwd: this.runner.cwd,
      // Claude Code's own option beats the settings file's model, so the project's default is left out when the file names one.
      model: this.model ?? (this.fileSettings?.model === undefined ? this.defaultModel : undefined),
      // Level B keeps only what Claude Code and a shell need of Ledung's environment (issue #109).
      env: claudeEnvironment(this.airgap ? airgapEnvironment(process.env, tmp) : process.env, this.account?.env, instructions(tools)),
      resume: this.attachTo ? undefined : this.resume,
      // Always explicit: without it a session may pick a mode from its settings (spike finding 1).
      permissionMode: this.store.getSession(this.id)!.permissionMode,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      mcpServers: {
        ...profile.mcpServers,
        // Ledung's own server last, so no profile can replace it (validateProfiles refuses the name too).
        [LEDUNG_SERVER]: ledungToolServer(tools),
      },
      canUseTool: (toolName, input, opts) =>
        // Ledung's own tools never need a prompt; the project tools only when the project opted in (2026-10-14).
        unaskedTool(toolName, this.alwaysAsked) ? Promise.resolve({ behavior: 'allow' as const, updatedInput: input }) : this.onPermission(toolName, input, opts),
      // The user's own Claude Code, or the SDK's copy when the config says "bundled" (issue #341).
      pathToClaudeCodeExecutable: this.programPath(),
      spawnClaudeCodeProcess: (o) => {
        this.connection = connectHost(this.id, this.attachTo ? { attachTo: this.attachTo, fromSeq: this.store.hostSeq(this.id) } : { launch: this.runner.launchSpec(o) }, handlers);
        // Shaped like the process the SDK expects; see HostConnection.
        return this.connection as never;
      },
      hooks: {
        // Pause (step 6): the next tool call waits until resumed; the command already running finishes.
        // Then the sensitive check (sensitive-always): Claude Code allows some things itself (Accept edits,
        // session rules, project settings, the Auto classifier), so Ledung's check in onPermission would
        // never see them. "Ask" sends a match to onPermission, in every mode.
        PreToolUse: [{ timeout: 7 * 24 * 3600, hooks: [async (input, toolUseId) => {
          await this.whilePaused();
          await this.whileHeld();
          const i = input as { tool_name?: string; tool_input?: unknown };
          const toolName = i.tool_name ?? '';
          // Compacting or clearing is for the main session only, never a subagent (decided 2026-10-13).
          if (CONTEXT_TOOLS.includes(toolName) && (input as { agent_id?: string }).agent_id) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'Only the main session can compact or clear, not a subagent.' } };
          }
          if (unaskedTool(toolName, this.alwaysAsked)) return {};
          if (SETTINGS_CHANGE_TOOLS.includes(toolName)) return this.settingsChangeHook(toolName, i.tool_input);
          // Level B: no subagent in the cloud, which would take the project's files off this computer (issue #109).
          if (this.airgap && toolName === 'Agent' && (i.tool_input as { isolation?: unknown } | undefined)?.isolation === 'remote') {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'This project is nearly air-gapped (lockdown level B): no remote agents.' } };
          }
          const toolInput = i.tool_input && typeof i.tool_input === 'object' ? i.tool_input as Record<string, unknown> : {};
          const merge = this.mergeOnAnswer(toolName, toolInput, toolUseId);
          if (merge) return merge;
          const named = this.settingsOnWord(toolName, toolInput, toolUseId);
          if (named) return named;
          return sensitiveHookOutput(toolName, toolInput, this.sensitiveRules, this.alwaysAsked);
        }] }],
        // After a call someone in Ledung allowed: say who, so the session never guesses. A call that
        // failed was allowed all the same, and without its note would read as allowed by the session's mode.
        PostToolUse: [{ hooks: [async (input) => {
          const note = this.allowedBy.take((input as { tool_use_id?: string }).tool_use_id);
          return note === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: note } };
        }] }],
        PostToolUseFailure: [{ hooks: [async (input) => {
          const note = this.allowedBy.take((input as { tool_use_id?: string }).tool_use_id);
          return note === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PostToolUseFailure' as const, additionalContext: note } };
        }] }],
        // Idle stop: at the end of each turn Claude Code says what still runs in the background and what
        // will wake the session later; a session with either is never stopped for being idle.
        Stop: [{ hooks: [async (input) => {
          try {
            const i = input as { background_tasks?: unknown[]; session_crons?: unknown[] };
            this.store.setIdleFacts(this.id, {
              backgroundTasks: Array.isArray(i.background_tasks) ? i.background_tasks.length : 0,
              crons: Array.isArray(i.session_crons) ? i.session_crons.length : null,
            });
          } catch (e) {
            console.error(`Idle facts for session ${this.id}: ${(e as Error).message}`);
          }
          return {};
        }] }],
        // Sessions know the time, without Ledung changing what Simon typed (want 9).
        // Delivered messages carry their context here, not in the user's words (step 4).
        UserPromptSubmit: [{ hooks: [async (input) => {
          const prompt = (input as { prompt?: string }).prompt ?? '';
          const attached = this.contextFor.get(prompt);
          if (attached !== undefined) this.contextFor.delete(prompt);
          // How full its context is, every turn (a manager otherwise sees it only in list_sessions).
          const info = this.store.getSession(this.id);
          // The workflow's nudges that apply at this size, right under it (issue #405).
          const nudges = promptNudges(this.workflow?.nudgesFile, info, this.nudgesProblemTold);
          this.nudgesProblemTold = nudges.told;
          if (nudges.lines.length && !nudgesExercised) {
            nudgesExercised = true;
            exercisedLine('EXERCISED #405 a workflow nudge or its file\'s problem added to a prompt');
          }
          const context = [promptContextLine(info), ...nudges.lines].filter(Boolean).join('\n');
          // A manager sees the plan's windows every turn, so it can plan around them (issue #278).
          const usage = info?.role === 'manager'
            ? promptUsageLine(this.store.latestLimits(), this.gate.usageStops?.() ?? [], info.account ?? 'default', Date.now())
            : '';
          // A manager is told every turn while the user is away, next to its context (issue #35).
          const away = promptAwayLine(info, this.away?.current() ?? null, this.userName);
          // How much time has passed, not only what time it is (issue #265).
          const now = new Date();
          const time = [promptTimeLine(now, this.lastPromptAt, info?.createdAt ?? null), context, usage, away].filter(Boolean).join('\n');
          this.lastPromptAt = now.getTime();
          return {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit' as const,
              additionalContext: attached ? `${time}\n\nDelivered by Ledung (not from ${this.userName}):\n\n${attached}` : time,
            },
          };
        }] }],
      },
    };
  }

  private usageFacts(): SessionFacts {
    const info = this.store.getSession(this.id)!;
    return {
      sessionId: this.id, project: info.project, role: info.role,
      team: info.role === 'manager' ? this.id : this.management.managerOf(this.id)?.id ?? null,
      branch: this.branch,
      account: info.account ?? 'default',
    };
  }

  /** Reads the branch again (on start and after each turn), then has its pull request looked up; tells the page what changed. */
  private refreshBranch(): void {
    void this.runner.currentBranch().then((branch) => {
      if (branch !== this.branch) {
        this.branch = branch;
        if (this.store.getSession(this.id)) this.update({ branch });
      }
      if (this.stopping || this.detaching || !branch || branch === 'HEAD') return;
      // The poll in the session manager looks it up with the other sessions, and every few minutes while live (issue #252).
      this.pullRequests?.watch(this.id, this.runner);
    });
  }

  /** The pull request the poll found for the branch (null: none); the page is told only of a change. */
  showPullRequest(pr: PullRequestInfo | null): void {
    if (this.stopping || this.detaching) return;
    const current = this.store.getSession(this.id);
    if (current && JSON.stringify(current.pr) !== JSON.stringify(pr)) this.update({ pr });
  }

  /** Usage, plan limits and context from one line (step 5). Never lets a recording problem reach the session. */
  private recordUsage(m: any, at: number): void {
    try {
      const out = this.usage.feed(m, at, this.usageFacts());
      if (out.usage) this.store.addUsage(out.usage);
      if (out.limits && out.limits.map((l) => this.store.addLimit(l)).some(Boolean)) this.publish({ type: 'limits', limits: this.store.latestLimits() });
      // Right after a compact or clear, not at the next reply, so a "compact above X" rule doesn't fire
      // again on the old figure (decided 2026-10-13). Main session only.
      if (m?.type === 'system' && m.subtype === 'compact_boundary' && !m.parent_tool_use_id && typeof m.compact_metadata?.post_tokens === 'number') {
        this.update({ contextTokens: contextAfterCompact(this.store.smallestCall(this.id), m.compact_metadata.post_tokens) });
      }
      if (m?.type === 'conversation_reset') this.update({ contextTokens: null });
      if (m?.type === 'result') this.recordCompaction(m, at);
      if (out.context) {
        const fields: Parameters<Store['updateSession']>[1] = {};
        if (out.context.tokens >= 0) fields.contextTokens = out.context.tokens;
        if (out.context.window) fields.contextWindow = out.context.window;
        this.update(fields);
      }
    } catch (e) {
      console.error(`Usage for session ${this.id}: ${(e as Error).message}`);
    }
  }

  /** A manual compact's own cost, from the result's running totals; called before the result is stored. */
  private recordCompaction(m: any, at: number): void {
    if (m.num_turns !== 0) return;
    const before = this.store.listMessages(this.id, { limit: 400 }).filter((x) => x.kind === 'sdk').map((x) => x.data);
    const c = this.store.getSession(this.id)?.compacting;
    const trigger = c && c.requester !== this.id ? 'manager' : 'ledung';
    const records = compactionUsage(before, m, at, { ...this.usageFacts(), trigger });
    if (records === null) this.record('event', { text: 'The cost of this compact is not known.' });
    for (const r of records ?? []) this.store.addUsage(r);
  }

  /** Every line from the host is stored (or skipped) together with its number, before the SDK sees it. */
  private onHostLine(seq: number, at: number, json: string): void {
    let data: any = null;
    try {
      const m = JSON.parse(json);
      if (m.type !== 'keep_alive') this.lastActivity = Date.now();
      // The empty result a `!` command's output gives: not stored, not counted, not a turn's end (#212).
      const shellResult = m.type === 'result' && m.num_turns === 0 && this.shellResultsDue > 0;
      if (shellResult) {
        this.shellResultsDue--;
        this.shellResultsToSkip++;
      } else {
        this.recordUsage(m, at);
      }
      // A turn's result: every `!` message sent before it has had its empty result, or Claude Code merged it into
      // this turn and gives none (sdk.d.ts: "merged into the next user message that does query"), so none is due.
      if (m.type === 'result' && m.num_turns > 0) this.shellResultsDue = 0;
      if (!shellResult && !NOT_STORED_TYPES.has(m.type) && !(m.type === 'system' && NOT_STORED_SYSTEM.has(m.subtype))) data = m;
      if (m.type === 'system' && m.subtype === 'init') {
        // Each turn repeats the init message; keep it only when something changed (spike finding 8).
        const key = JSON.stringify([m.session_id, m.model, m.claude_code_version, m.cwd, m.permissionMode]);
        if (key === this.lastInit) data = null;
        this.lastInit = key;
      }
    } catch {
      // Not JSON: nothing to store, but the number still counts as handled.
    }
    const stored = this.store.addHostLine(this.id, seq, at, data);
    if (stored) this.publish({ type: 'message', message: stored });
  }

  private async readLoop(q: Query): Promise<void> {
    let error: string | null = null;
    try {
      for await (const m of q) this.onMessage(m);
    } catch (e) {
      error = (e as Error).message;
    }
    // Detaching for a restart: the session goes on in its host; leave everything as it is.
    if (this.detaching || this.stopping) return;
    this.endTurn();
    this.endPermissions('The session ended.');
    this.endCompact({ kind: 'ended' });
    this.pullRequests?.forget(this.id);
    const exit = this.connection?.exitInfo;
    const tail = (exit?.stderr || this.stderrTail.join('\n')).split('\n').slice(-5).join('\n');
    const reason = exit
      ? `Claude Code exited${exit.code ? ` with code ${exit.code}` : ''}.${exit.code && tail ? `\n${tail}` : ''}`
      : `The session's host stopped unexpectedly${error ? `: ${error}` : '.'}`;
    this.record('event', { text: reason });
    this.backgroundTasks = 0;
    this.update({ status: 'ended', endedAt: Date.now(), endReason: reason });
    this.management.onEnded(this.id, reason);
  }

  private onMessage(m: SDKMessage): void {
    if (m.type === 'system' && m.subtype === 'init') {
      this.update({ claudeSessionId: m.session_id, model: m.model, claudeVersion: m.claude_code_version, cwd: m.cwd });
    }
    if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      this.backgroundTasks = m.tasks.filter((t) => !t.ambient).length;
      this.allBackgroundTasks = m.tasks.length;
      this.publish({ type: 'session', session: this.info });
    }
    if (m.type === 'assistant') {
      // A turn Claude Code started itself (a queued message, a finished background task): measure it too.
      if (!this.turnOpen) this.beginTurn(this.usage.currentTrigger);
      for (const b of m.message.content) {
        if (b.type === 'tool_use' && (b.name === 'Bash' || b.name === 'PowerShell')) {
          this.turnCommands.push(...commandKinds(String((b.input as { command?: unknown })?.command ?? '')));
        }
      }
    }
    if (m.type === 'assistant' && m.parent_tool_use_id == null) {
      const said = m.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
      if (said) this.lastReply = said;
    }
    const status = this.store.getSession(this.id)?.status;
    if (m.type === 'assistant') this.awaitingResumeResult = false;
    if ((m as { type: string; subtype?: string }).type === 'system' && (m as { subtype?: string }).subtype === 'bridge_state') {
      this.remote?.onBridgeState(m as { state?: unknown });
    }
    this.followCompact(m);
    if (m.type === 'result' && m.num_turns === 0 && this.shellResultsToSkip > 0) {
      this.shellResultsToSkip--;
      return;
    }
    if (m.type === 'result') {
      // An empty result right after a resume, while a delivered message's turn is open: not that turn's end.
      const emptyResume = this.awaitingResumeResult && m.num_turns === 0;
      this.awaitingResumeResult = false;
      if (emptyResume && this.turnOpen) return;
      if (status !== 'idle' && this.pending.size === 0) this.update({ status: 'idle' });
      // A real turn ended (not the empty one on resume): tell the manager, unless a question already did.
      if (m.num_turns > 0 && !this.askedThisTurn) {
        // Background work or a wake-up means Claude Code starts the next turn itself: a pause, no wake (2026-10-13).
        this.management.onTurnFinished(this.id, this.lastReply, pauseReason(this.allBackgroundTasks, this.store.idleFacts(this.id)));
      }
      if (m.num_turns > 0) this.refreshBranch();
      this.askedThisTurn = false;
      this.lastReply = '';
      this.turnStartedAt = null;
      this.endTurn();
      // `!` output that came during the turn, before anything else is handed over (#212).
      for (const text of this.shellAppends.splice(0)) this.appendContext(text);
      // The turn is over: hand over anything that waited for it (decided 2026-10-10).
      this.deliver();
    } else if (m.type === 'assistant' && status !== 'running' && this.pending.size === 0) {
      // A turn Claude Code started itself (a wake-up, a /loop) begins here.
      this.turnStartedAt ??= Date.now();
      this.update({ status: 'running' });
    }
  }

  /**
   * A compact under way (compact_session, compact_self). What is known is written to the database as it
   * comes, so a Ledung restart in the middle loses nothing. A failure shows only in the status message,
   * since its result looks like success (findings 3). The result ends it.
   */
  private followCompact(m: SDKMessage): void {
    const c = this.store.getSession(this.id)?.compacting;
    if (!c) return;
    const x = m as {
      type: string; subtype?: string; parent_tool_use_id?: string | null; compact_result?: string; compact_error?: string;
      compact_metadata?: { pre_tokens?: number; post_tokens?: number; duration_ms?: number };
    };
    if (x.type === 'system' && x.subtype === 'status' && x.compact_result === 'failed') {
      this.update({ compacting: { ...c, outcome: 'failed', error: x.compact_error || 'no reason given' } });
    } else if (x.type === 'system' && x.subtype === 'compact_boundary' && !x.parent_tool_use_id) {
      const meta = x.compact_metadata ?? {};
      this.update({ compacting: { ...c, outcome: 'success', pre: meta.pre_tokens, post: meta.post_tokens, durationMs: meta.duration_ms } });
    } else if (m.type === 'result') {
      const text = typeof (m as { result?: unknown }).result === 'string' ? (m as { result: string }).result : '';
      const outcome: CompactOutcome = c.outcome === 'failed' ? { kind: 'failed', reason: c.error ?? 'no reason given' }
        : c.outcome === 'success' ? { kind: 'success' }
          // In case the status message is missing: the result's text names the error.
          : text.startsWith('Error during compaction') ? { kind: 'failed', reason: text.replace(/^Error during compaction:\s*/, '') }
            : { kind: 'nothing' };
      this.endCompact(outcome);
    }
  }

  /** The compact is over: the chat says how (the divider says it for a success), the requester and the note learn it. */
  private endCompact(outcome: CompactOutcome): void {
    const c = this.store.getSession(this.id)?.compacting;
    if (!c) return;
    if (outcome.kind === 'failed') this.record('event', { text: `Compact failed: ${outcome.reason}` });
    else if (outcome.kind === 'nothing') this.record('event', { text: 'Nothing to compact yet; the context is unchanged.' });
    else if (outcome.kind === 'ended') this.record('event', { text: 'The session ended during the compact; the context is unchanged.' });
    this.update({ compacting: null });
    this.management.onCompactEnded(this.id, c, outcome);
  }

  /** The 10-minute alert (decided 2026-10-13), once; read from the database, so a restart neither repeats nor loses it. */
  checkCompact(now = Date.now()): void {
    const c = this.store.getSession(this.id)?.compacting;
    if (!c || c.alerted || now - c.startedAt < COMPACT_ALERT_MINUTES * 60000) return;
    this.update({ compacting: { ...c, alerted: true } });
    this.management.onCompactStuck(this.id, c, Math.round((now - c.startedAt) / 60000));
  }

  /**
   * A permission prompt (step 4): covered by a grant → allowed, unless sensitive; otherwise → the
   * session's manager, or the user if it has none. A sensitive one goes to the manager too (issue #51),
   * but only the user allows it, directly or through the manager's question about it.
   */
  private onPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: PermissionOpts,
  ): Promise<PermissionResult> {
    let route = routePermission(toolName, input, this.sensitiveRules, this.alwaysAsked, () => this.management.grantFor(this.id, toolName, input));
    // A projects' settings change comes here only when the hook asked: the user's alone, never a grant's (issue #306).
    if (SETTINGS_CHANGE_TOOLS.includes(toolName) && !('sensitive' in route)) route = { sensitive: { rule: this.settingsChangeRule(toolName, input) } };
    if ('grant' in route) {
      const { grant } = route;
      const who = grant.grantedBy === 'user' ? this.userName : `manager "${this.management.title(grant.grantedBy)}"`;
      this.record('event', { text: `Allowed under a grant from ${who}: ${grant.rule}` });
      this.allowedBy.granted(opts.toolUseID, who, grant.rule);
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const sensitive = 'sensitive' in route ? route.sensitive : null;
    // Away mode (issue #35): only a manager's sensitive Bash call, only while the user is away, and not
    // a request the host re-sent after a restart (that one is already a prompt on screen).
    const away = sensitive ? this.away?.current() : null;
    if (sensitive && away && toolName === 'Bash' && typeof input.command === 'string'
      && !(opts.requestId && this.store.pendingPermissionByRequest(this.id, opts.requestId))) {
      const info = this.store.getSession(this.id);
      if (info?.role === 'manager') return this.awayPermission(away, input.command, toolName, input, opts, sensitive, null);
      // A session its manager started: its dev ship too, recorded in the manager's record (issue #408).
      const manager = this.shipManager(info, away, input.command);
      if (manager) return this.awayPermission(away, input.command, toolName, input, opts, sensitive, { managerId: manager, title: info!.title });
    }
    return this.askPermission(toolName, input, opts, sensitive);
  }

  /**
   * The manager that started this session, in this project, when away mode allows dev ship and the command
   * is the project's dev ship or looks like one (issue #408); otherwise null, and away mode stays out of it.
   */
  private shipManager(info: SessionInfo | undefined, away: AwayInfo, command: string): string | null {
    if (!info || !this.devShip || !away.allow.includes('devShip')) return null;
    const parent = this.management.managerOf(info.id);
    if (!parent || parent.project !== info.project) return null;
    const p = classify(command, this.devShip);
    return p.kind === 'devShip' || (p.kind === 'other' && p.shipLike) ? parent.id : null;
  }

  /**
   * Away mode's decision on a manager's sensitive command, or on its session's dev ship (issue #408): allowed,
   * noted and recorded; or held, and then the same prompt as always, with away mode's reason on it.
   */
  private async awayPermission(
    away: AwayInfo,
    command: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: PermissionOpts,
    sensitive: { rule: string },
    fromSession: { managerId: string; title: string } | null,
  ): Promise<PermissionResult> {
    const decision = await awayDecide(away, this.userName, command, this.devShip,
      (pr, repo, fields) => this.runner.pullRequestView(pr, repo, fields, FLOOR_TIMEOUT_MS));
    // Back may have been pressed while the floors were checked.
    if (decision.allowed && !this.away?.current()) {
      decision.allowed = false;
      decision.reason = `held for ${this.userName}: ${this.userName} came back`;
    }
    if (fromSession) this.away?.record(fromSession.managerId, command, { ...decision, reason: `${decision.reason} (run by its session "${fromSession.title}")` });
    else this.away?.record(this.id, command, decision);
    if (decision.allowed) {
      this.record('event', { text: decision.reason });
      this.allowedBy.away(opts.toolUseID, decision.reason);
      return { behavior: 'allow', updatedInput: input };
    }
    return this.askPermission(toolName, input, { ...opts, decisionReason: [opts.decisionReason, `Away mode ${decision.reason}.`].filter(Boolean).join(' · ') }, sensitive);
  }

  /** The prompt: to the manager, or the user if it has none; a sensitive one only the user allows (issue #51). */
  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: PermissionOpts,
    sensitive: { rule: string } | null,
  ): Promise<PermissionResult> {
    // A request the host re-sent after a restart is the one already on screen.
    const existing = opts.requestId ? this.store.pendingPermissionByRequest(this.id, opts.requestId) : undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      this.publish({ type: 'permission', permission: existing });
    } else {
      const permission = this.store.createPermission({
        id, sessionId: this.id, toolName, input, title: opts.title ?? null, reason: opts.decisionReason ?? null, requestId: opts.requestId,
        addressedTo: this.management.addresseeFor(this.id), sensitive: sensitive?.rule ?? null,
      });
      this.record('permission', { permissionId: id, toolName, input, title: permission.title, reason: permission.reason });
      this.publish({ type: 'permission', permission });
      this.management.onPermissionAsked(permission);
    }
    this.update({ status: 'waiting' });
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { toolName, input, resolve, suggestions: opts.suggestions, sensitive: !!sensitive, toolUseID: opts.toolUseID });
      opts.signal.addEventListener('abort', () => {
        // On a restart the request stays waiting: the host re-sends it to the next Ledung.
        if (this.detaching) this.pending.delete(id);
        else this.finishPermission(id, 'cancelled', 'ledung', 'The request was withdrawn.');
      }, { once: true });
    });
  }

  /**
   * A decision on a permission request or question, by the user or (step 4) a manager. Returns false
   * if it was no longer pending. "This session" adds the request's rules for the rest of the session,
   * in Claude Code and in Ledung's grants; never for a sensitive request.
   */
  decide(permissionId: string, decision: PermissionDecision, by: string): boolean {
    const p = this.pending.get(permissionId);
    if (!p) return false;
    if (decision.behavior === 'allow') {
      // What the user allowed, with what its prompt showed, so the tool saves only that (review of #306, M2).
      if (SETTINGS_CHANGE_TOOLS.includes(p.toolName)) {
        const shown = this.store.getPermission(permissionId)?.sensitive ?? null;
        if (USAGE_PUBLISH_TOOLS.includes(p.toolName)) this.management.noteApprovedUsagePublish(this.id, p.input, shown);
        else this.management.noteApprovedSettings(this.id, p.input, shown);
      }
      const updatedInput = decision.answers ? { ...p.input, answers: decision.answers } : p.input;
      const scope = decision.scope === 'session' && !p.sensitive && !decision.answers ? 'session' : 'once';
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (scope === 'session') {
        const suggested = rulesFromSuggestions(p.suggestions);
        const rules = suggested.length ? suggested : [exactRule(p.toolName, p.input)];
        for (const r of rules) this.store.addGrant(this.id, r.toolName, r.ruleContent, by);
        updatedPermissions = asSessionUpdate(rules);
        this.record('event', { text: `Allowed for the rest of this session: ${rules.map(describeRule).join(', ')}` });
      }
      return this.finishPermission(permissionId, 'allowed', by, null, { behavior: 'allow', updatedInput, updatedPermissions }, decision.answers, scope);
    }
    const message = decision.message?.trim() || (by === 'user' ? `${this.userName} denied this.` : 'Your manager denied this.');
    return this.finishPermission(permissionId, 'denied', by, message, { behavior: 'deny', message });
  }

  private finishPermission(
    id: string,
    status: 'allowed' | 'denied' | 'cancelled',
    by: string,
    message: string | null,
    result?: PermissionResult,
    answers?: Record<string, string>,
    scope: 'once' | 'session' | null = null,
  ): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.lastActivity = Date.now();
    this.store.decidePermission(id, status, by, message, scope);
    if (status === 'allowed') {
      const who = by === 'user' ? this.userName : `your manager "${this.management.title(by)}"`;
      this.allowedBy.decided(p.toolUseID, who, scope, p.sensitive, this.userName);
    }
    p.resolve(result ?? { behavior: 'deny', message: message ?? 'Cancelled.' });
    this.management.onRequestClosed(id);
    this.record('decision', { permissionId: id, behavior: status, by, message, answers, scope });
    this.publish({ type: 'permission', permission: this.store.getPermission(id)! });
    if (this.pending.size === 0 && !this.stopping) this.update({ status: 'running' });
    return true;
  }

  /** Withdraws every waiting request, including ones from before a restart not yet re-sent. */
  private endPermissions(reason: string): void {
    for (const id of [...this.pending.keys()]) this.finishPermission(id, 'cancelled', 'ledung', reason);
    for (const id of this.store.cancelPendingPermissions(this.id, reason)) {
      this.publish({ type: 'permission', permission: this.store.getPermission(id)! });
      this.management.onRequestClosed(id);
    }
  }

  /**
   * ask_user: stores the question; it goes to this session's manager, or to the user. A manager's
   * question about a request (issue #51) is written by Ledung, with the manager's text as its note.
   * Screenshots (issue #60) are checked first: a bad one refuses the whole question.
   */
  private ask(
    question: string, options: string[] | null, aboutQuestion: number | null, aboutRequest: string | null = null, details: QuestionDetails | null = null, shotInput?: ShotInput[],
    sources: AttachedSource[] | null = null,
  ) {
    // Checked first, so a question without a valid tier is refused before anything else happens (issue #96).
    details = this.management.withTier(this.id, details);
    if (aboutQuestion !== null) this.management.checkAboutQuestion(this.id, aboutQuestion);
    // A question about a request is Ledung's own text, so of the asker's structured fields only where it goes in the queue applies.
    if (aboutRequest) {
      const { tier, rank, refs } = details;
      ({ question, options } = this.management.requestQuestion(this.id, aboutRequest, question));
      details = { tier, ...(rank !== undefined ? { rank } : {}), ...(refs?.length ? { refs } : {}) };
    }
    // A review's evidence files are checked like screenshots, and its text names them as stored (docs/steps/pr-review.md).
    const review = aboutRequest ? undefined : details.review;
    if (review?.evidence) {
      details = { ...details, review: { ...review, evidence: this.management.reviewEvidence(this.id, review.evidence) } };
      question = questionText(undefined, details);
    }
    const shots = aboutRequest || review ? null : this.management.screenshots(this.id, shotInput, aboutQuestion);
    // What it had just before asking, kept with the question so "the points above" stay on its page (issue #368);
    // left out when it attached what it points at (issue #369), unless none of that could be fetched.
    const attached = !!sources?.some((s) => !('error' in s));
    const earlier = attached ? null : conversationBefore(this.store.listMessages(this.id, { limit: 300 }));
    const q = this.store.createQuestion({
      sessionId: this.id, question, options, addressedTo: this.management.addresseeFor(this.id), aboutQuestion, aboutRequest, details, shots, earlier, sources,
    });
    if (attached && !sourcesExercised) {
      sourcesExercised = true;
      exercisedLine('EXERCISED #369 a question asked with the sources it attached');
    }
    this.askedThisTurn = true;
    this.record('question', { questionId: q.id });
    this.publish({ type: 'question', question: q });
    this.management.onQuestionAsked(q);
    return q;
  }

  /** What attaching a source needs (issue #369): this session's own store reads, rules and `gh` login. */
  private sourceContext(): SourceContext {
    return {
      askerId: this.id,
      getSession: (id) => this.store.getSession(id),
      listSessions: () => this.store.listSessions(),
      getQuestion: (id) => this.store.getQuestion(id),
      listMessages: (id, opts) => this.store.listMessages(id, opts),
      repliesBetween: (id, from, to) => this.store.repliesBetween(id, from, to),
      offline: () => this.management.offlineReason(this.id),
      ghApi: (args, timeoutMs) => this.runner.ghApi(args, null, timeoutMs),
      now: () => Date.now(),
    };
  }

  /** withdraw_question: only the session's own open questions. */
  private withdraw(id: number, reason: string): string {
    const q = this.store.getQuestion(id);
    if (!q || q.sessionId !== this.id) return `There is no question #${id} from this session.`;
    if (q.status !== 'open') return `Question #${id} is already ${q.status}.`;
    this.store.withdrawQuestion(id, reason);
    this.publish({ type: 'question', question: this.store.getQuestion(id)! });
    return `Question #${id} is withdrawn.`;
  }

  private beginTurn(trigger: string): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.turnStartedAt = Date.now();
    this.turnCommands = [];
    this.gate.started(this.id, trigger);
  }

  private endTurn(): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.gate.ended(this.id, [...new Set(this.turnCommands)]);
    this.turnCommands = [];
  }

  /**
   * Sends what is waiting for this session (Simon's held messages, answers, then inbox messages) as one
   * message, if it is free: idle (or starting, or in line), not stopping, not paused, and there is a
   * free place under the limit (step 6) or `force` (Simon's Start now). A busy session gets it when
   * its turn ends (onMessage calls this on every result).
   */
  deliver(force = false): void {
    if (!this.q || this.stopping || this.detaching || this.pending.size) return;
    // 'starting' counts as free: a session that hasn't had its first message yet is waiting for one.
    const info = this.store.getSession(this.id);
    const status = info?.status;
    if (status !== 'idle' && status !== 'starting' && status !== 'queued') return;
    // A clear (clear_session) waits in the inbox in order: what came before it is delivered first. Then a
    // countdown the user can cancel, then "/clear" goes in alone, as if typed, and everything after it
    // arrives in the fresh conversation.
    const waiting = this.store.undeliveredInbox(this.id);
    // A compact waits in line the same way, with no countdown (decided 2026-10-13).
    const clearAt = waiting.findIndex((i) => isClear(i.source) || isCompact(i.source));
    const compacting = clearAt === 0 && isCompact(waiting[0]!.source);
    const clearing = clearAt === 0 && !compacting;
    const held = clearAt >= 0 ? [] : this.store.heldMessages(this.id);
    const answers = clearAt >= 0 ? [] : this.store.undeliveredAnswers(this.id);
    const inbox = clearAt >= 0 ? waiting.slice(0, clearAt) : waiting;
    if (!held.length && !answers.length && !inbox.length && !clearing && !compacting) {
      if (status === 'queued') this.update({ status: 'idle', queuedAt: null });
      return;
    }
    if (info!.paused && !force) return;
    // A usage stop holds Start now too: only Lift, a raised level or the reset release it (review 1 of #278, finding 6).
    const hold = this.gate.usageHold?.(this.id);
    if (hold) {
      this.noteHeld(hold);
      // Out of the line, so a held account doesn't keep another account's sessions waiting (finding 2).
      if (status === 'queued') this.update({ status: 'idle', queuedAt: null });
      return;
    }
    this.heldFor = null;
    if (clearing && this.countingDown(waiting[0]!, info!)) return;
    if (!force && !this.gate.mayStart(this.id)) {
      if (status !== 'queued') this.update({ status: 'queued', queuedAt: Date.now() });
      return;
    }
    if (compacting) {
      this.startCompact(waiting[0]!);
      return;
    }
    if (clearing) {
      this.store.markInboxDelivered([waiting[0]!.id]);
      this.record('event', { text: 'Conversation cleared.' });
      this.management.onCleared(this.id, parseClear(waiting[0]!.source).requester, waiting[0]!.text);
      this.usage.startTurn('manager');
      this.pushInput('/clear');
      this.lastActivity = Date.now();
      this.update({ status: 'running', queuedAt: null, clearDue: null, clearedAt: Date.now() });
      this.beginTurn('manager');
      return;
    }
    const { userText: deliveredText, context } = buildDelivery(this.userName, answers, inbox, (id) => this.management.title(id));
    this.store.markDelivered(answers.map((a) => a.id));
    this.store.markInboxDelivered(inbox.map((i) => i.id));
    this.store.setHeldMessages(this.id, []);
    // Simon's held messages are already in the history (send() stored them); only Ledung's part is new.
    if (answers.length || inbox.length) {
      this.record('user', { text: deliveredText, from: 'ledung', answerTo: answers.map((a) => a.id), context: context || undefined });
    }
    if (status === 'queued') this.record('event', { text: force ? `Started now by ${this.userName}, above the limit.` : 'A place came free; starting.' });
    const userText = [...held, deliveredText].filter(Boolean).join('\n\n');
    const trigger = held.length ? 'user'
      : answers.some((a) => a.answeredBy === 'user') ? 'answer'
        : answers.length || inbox.some((i) => i.source.startsWith('manager:')) ? 'manager'
          : 'ledung';
    this.usage.startTurn(trigger);
    if (context) this.contextFor.set(userText, context);
    this.pushInput(userText);
    this.lastActivity = Date.now();
    this.update({ status: 'running', queuedAt: null });
    this.beginTurn(trigger);
    for (const a of answers) this.publish({ type: 'question', question: this.store.getQuestion(a.id)! });
  }

  /** Pushes /compact (with the note, labelled) as if typed; the note after it waits for the outcome. */
  private startCompact(item: { id: number; source: string; text: string }): void {
    const requester = compactRequester(item.source);
    const note = item.text.trim() || null;
    const who = requester === this.id ? 'the session itself' : `manager "${this.management.title(requester)}"`;
    const compacting: CompactingInfo = { requester, startedAt: Date.now(), note };
    this.store.markInboxDelivered([item.id]);
    this.record('event', { text: `Compact requested by ${who}.${note ? ` Note for the summary: ${note}` : ''}` });
    const trigger = requester === this.id ? 'ledung' : 'manager';
    this.usage.startTurn(trigger);
    this.pushInput(compactCommand(note, who, this.userName));
    this.lastActivity = Date.now();
    this.update({ status: 'running', queuedAt: null, compacting });
    this.beginTurn(trigger);
  }

  /**
   * Starts a turn's input. A slash command (/clear) ends with a zero-turn result and nothing said before
   * it: that result is its end, not the empty one on resume, so it must not wait for another (#24).
   */
  private pushInput(text: string): void {
    if (text.startsWith('/')) this.awaitingResumeResult = false;
    this.input.push(text);
  }

  /** True while the clear's countdown runs: starts it the first time, and wakes deliver() when it is up. */
  private countingDown(item: { source: string; text: string }, info: SessionInfo): boolean {
    let due = info.clearDue;
    if (due == null) {
      const { seconds } = parseClear(item.source);
      due = Date.now() + seconds * 1000;
      this.update({ clearDue: due });
      this.record('event', { text: `${item.text} Clearing in ${seconds} s; Cancel keeps the conversation.` });
    }
    const left = due - Date.now();
    if (left <= 0) return false;
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => this.deliver(), left + 50);
    return true;
  }

  /** Cancels a waiting clear and the note meant for after it; whoever asked is told. False if none waits. */
  cancelClear(by: string): boolean {
    const waiting = this.store.undeliveredInbox(this.id);
    const at = waiting.findIndex((i) => isClear(i.source));
    if (at < 0) return false;
    const drop = [waiting[at]!.id];
    if (waiting[at + 1]?.source === CLEAR_NOTE_SOURCE) drop.push(waiting[at + 1]!.id);
    this.store.markInboxDelivered(drop);
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    this.update({ clearDue: null });
    this.record('event', { text: `Clear cancelled by ${by}; the conversation is kept.` });
    this.management.onClearCancelled(this.id, parseClear(waiting[at]!.source).requester, by);
    this.deliver();
    return true;
  }

  /**
   * Simon's message. During a turn it goes straight in (the turn already has its place); otherwise it
   * waits for a free place like everything else (step 6), shown in the history right away.
   */
  /** here: typed on this computer (issue #263), kept with the message for settingsOnWord. */
  send(text: string, here = false): void {
    if (!this.q || this.stopping) throw new Error('The session is not running.');
    const info = this.store.getSession(this.id)!;
    // A chat starts as "New chat" (issue #211); either is named after the first message.
    if (info.title === 'New session' || info.title === 'New chat') this.update({ title: text.replace(/\s+/g, ' ').trim().slice(0, 80) || info.title });
    this.record('user', here ? { text, here: true } : { text });
    this.lastActivity = Date.now();
    if (info.clearDue != null) this.cancelClear(`${this.userName} (wrote to the session)`);
    if (info.status === 'running' || info.status === 'waiting') {
      this.usage.startTurn('user');
      // Not pushInput: this joins the turn already running, whose resume guard must stay (review of #24).
      this.input.push(text);
      return;
    }
    this.store.setHeldMessages(this.id, [...this.store.heldMessages(this.id), text]);
    this.deliver();
  }

  /**
   * Simon's `!` command (issue #212): run in the session's folder through its runner, its block stored in the
   * history, and its output given to Claude as context with no turn (shouldQuery: false), right away or,
   * during a turn, when that turn ends. Throws at once when it can't start; the promise is its end.
   */
  runShell(command: string, kind: ShellKind, timeoutMs = SHELL_TIMEOUT_MS): Promise<void> {
    if (!this.q || this.stopping || this.detaching) throw new Error('The session is not running.');
    if (this.shellRun) throw new Error('A "!" command is still running in this session; wait for it or stop it.');
    const spec = this.runner.shell(command, kind, this.shellEnvironment());
    const run = startShell(spec, { timeoutMs });
    this.shellRun = { command, startedAt: Date.now(), run };
    this.lastActivity = Date.now();
    this.publish({ type: 'session', session: this.info });
    return this.shellEnded(command, spec.shellName, run, timeoutMs);
  }

  private async shellEnded(command: string, shellName: string, run: ShellRun, timeoutMs: number): Promise<void> {
    const r = await run.done;
    this.shellRun = null;
    const toClaude = r.cut !== 'restart' && !this.stopping && !this.detaching;
    const block: ShellBlock = {
      command, shell: shellName, cwd: this.runner.cwd, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, cut: r.cut,
      truncated: r.truncated, durationMs: r.durationMs, toClaude,
    };
    this.record('shell', block);
    this.lastActivity = Date.now();
    if (toClaude) {
      const text = bashModeText(command, r, timeoutMs);
      const status = this.store.getSession(this.id)?.status;
      if (this.turnOpen || status === 'running' || status === 'waiting') this.shellAppends.push(text);
      else this.appendContext(text);
    }
    this.publish({ type: 'session', session: this.info });
  }

  /** Stop on a running `!` command: it and everything it started end; false when none runs. */
  async stopShell(why: 'stopped' | 'restart' = 'stopped'): Promise<boolean> {
    const running = this.shellRun;
    if (!running) return false;
    await running.run.stop(why);
    return true;
  }

  /** Context for Claude with no model turn: appended to the transcript, merged into the next message (#212). */
  private appendContext(text: string): void {
    this.shellResultsDue++;
    this.input.push(text, { shouldQuery: false });
  }

  /** A `!` command's environment: Claude Code's for this session, with its project's login (#212, Security). */
  private shellEnvironment(): Record<string, string> {
    const base = this.airgap ? airgapEnvironment(process.env, this.airgapTmp) : process.env;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v !== undefined && !(this.account && LOGIN_ENV.includes(k))) env[k] = v;
    return { ...env, ...this.account?.env };
  }

  /** Says once per stop and window, in the conversation, that this session's work is held (issue #278). */
  noteHeld(hold: UsageStopInfo): void {
    const key = `${hold.kind}:${hold.resetsAt}`;
    if (this.heldFor === key) return;
    this.heldFor = key;
    const when = hold.resetsAt != null ? 'it is lifted in Settings or the window resets' : 'it is lifted in Settings';
    this.record('event', { text: `Held: the ${windowName(hold.kind)} usage stop at ${hold.percent}% is reached. What waits, and any turn Claude Code starts itself, goes on when ${when}.` });
  }

  /**
   * A usage stop holds a turn Claude Code starts itself (a /loop, a wake-up, a cron, a finished background task) at
   * its first tool call, as pause does; a turn that began before the stop was reached finishes (review 1 of #278).
   */
  private async whileHeld(): Promise<void> {
    for (;;) {
      if (this.stopping) return;
      const hold = this.gate.usageHold?.(this.id);
      // No known start: the turn began after the last result, so after the stop.
      if (!hold || (this.turnStartedAt ?? Date.now()) < (hold.since ?? 0)) return;
      this.noteHeld(hold);
      const waiting = new Promise<void>((resolve) => this.heldWaiters.push(resolve));
      // Its place under the working limit is free now: let the line move.
      this.gate.freed?.();
      await waiting;
    }
  }

  /** A tool call waits for a usage stop to lift: the session doesn't count as working meanwhile. */
  get heldAtToolCall(): boolean {
    return this.heldWaiters.length > 0;
  }

  /** A stop on this session's account no longer holds: held tool calls go on, then what waited is delivered. */
  releaseHeld(): void {
    for (const w of this.heldWaiters.splice(0)) w();
    this.deliver();
  }

  /** Simon's Start now: starts the waiting work above the limit, for one turn. */
  startNow(): void {
    this.deliver(true);
  }

  /** Pause or resume by hand (step 6). Pausing lets the running command finish; the next tool call waits. */
  setPaused(paused: boolean, by: string): void {
    const info = this.store.getSession(this.id);
    if (!info || info.paused === paused) return;
    this.update({ paused });
    this.record('event', { text: `${paused ? 'Paused' : 'Resumed'} by ${by}.` });
    if (!paused) {
      for (const w of this.pauseWaiters.splice(0)) w();
      this.deliver();
    }
  }

  private whilePaused(): Promise<void> {
    if (!this.store.getSession(this.id)?.paused || this.stopping) return Promise.resolve();
    return new Promise((resolve) => this.pauseWaiters.push(resolve));
  }

  /** Changes how permission prompts are handled, immediately, even mid-turn. */
  async setPermissionMode(mode: PermissionMode, by: string): Promise<void> {
    if (!this.q || this.stopping) throw new Error('The session is not running.');
    await this.q.setPermissionMode(mode);
    this.record('event', { text: `Permission mode set to ${PERMISSION_MODE_LABELS[mode]} by ${by === 'user' ? this.userName : by}.` });
    this.update({ permissionMode: mode });
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    for (const id of [...this.pending.keys()]) this.finishPermission(id, 'cancelled', 'ledung', 'Interrupted.');
    await this.q.interrupt();
    this.record('event', { text: 'Interrupted.' });
  }

  /** Its MCP servers and their status, from Claude Code (issue #118). */
  async mcpServers(): Promise<McpServerInfo[]> {
    if (!this.q || this.stopping) throw new McpError('The session is not running.');
    return mcpServers(this.q, OWN_SERVERS);
  }

  /** Restarts one of its MCP servers in the running Claude Code; the conversation stays (issue #118). */
  async reconnectMcp(name: string, by: string): Promise<McpServerInfo[]> {
    if (!this.q || this.stopping) throw new McpError('The session is not running.');
    const after = await reconnectMcp(this.q, name, OWN_SERVERS);
    const now = after.find((s) => s.name === name);
    this.record('event', { text: `MCP server "${name}" reconnected by ${by === 'user' ? this.userName : by}${now ? `: ${now.status}` : ''}.` });
    return after;
  }

  /** What the idle check needs to know about this session now. */
  idleState(): IdleState | null {
    const info = this.store.getSession(this.id);
    if (!info || !this.q || this.stopping || this.detaching) return null;
    return {
      info, turnOpen: this.turnOpen, pendingPermissions: this.pending.size,
      openQuestions: this.store.openQuestionCount(this.id),
      waitingDeliveries: this.store.heldMessages(this.id).length + this.store.undeliveredAnswers(this.id).length + this.store.undeliveredInbox(this.id).length,
      backgroundTasks: this.allBackgroundTasks, facts: this.store.idleFacts(this.id), lastActivity: this.lastActivity,
    };
  }

  /**
   * Ends the session: the host stops Claude Code and everything it started. `quiet`: the manager is
   * told without being woken (an idle stop). `restart`: it is resumed straight after, so it isn't told at all.
   */
  async stop(reason = 'Stopped.', opts: { quiet?: boolean; restart?: boolean } = {}): Promise<void> {
    if (this.stopping || this.detaching || !this.q) return;
    this.stopping = true;
    this.pullRequests?.forget(this.id);
    if (this.clearTimer) clearTimeout(this.clearTimer);
    if (this.store.getSession(this.id)?.clearDue != null) this.update({ clearDue: null });
    for (const w of [...this.pauseWaiters.splice(0), ...this.heldWaiters.splice(0)]) w();
    await this.stopShell('stopped');
    this.endTurn();
    this.update({ status: 'stopping' });
    this.endPermissions('The session is stopping.');
    if (this.remote) await this.remote.disable(this.q);
    const connection = this.connection;
    if (connection && connection.exitCode === null) {
      const exited = new Promise<void>((resolve) => connection.once('exit', () => resolve()));
      connection.stop();
      // The host closes Claude Code's input, waits for it, then ends anything left over.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 20000))]);
    }
    this.input.close();
    this.q.close();
    await Promise.race([this.finished, new Promise((r) => setTimeout(r, 3000))]);
    this.endCompact({ kind: 'ended' });
    this.record('event', { text: reason });
    this.backgroundTasks = 0;
    this.update({ status: 'ended', endedAt: Date.now(), endReason: reason });
    // Stopped only to start again with new settings (issue #109): nothing for its manager.
    if (!opts.restart) this.management.onEnded(this.id, reason, opts.quiet);
  }

  /** Lets go of the session without stopping it, for a Ledung restart. The host keeps it running. */
  detach(): void {
    if (this.stopping || this.detaching) return;
    this.detaching = true;
    this.pullRequests?.forget(this.id);
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.connection?.kill();
    this.input.close();
    this.q?.close();
  }
}

/** A Ledung tool that runs without a prompt: any but the project tools, and those too when not always asked. */
export function unaskedTool(toolName: string, alwaysAsked: readonly string[]): boolean {
  return LEDUNG_TOOLS.includes(toolName) || (USER_APPROVED_TOOLS.includes(toolName) && !alwaysAsked.includes(toolName));
}
