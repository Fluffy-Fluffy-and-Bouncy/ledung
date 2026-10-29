// Keeps the live sessions, starts and resumes them, and routes Simon's input to them.
import { randomUUID } from 'node:crypto';
import type { LedungConfig, LocalProjectConfig, ProjectConfig, SettingName } from '../config.ts';
import { ProjectStore, type StoredProject } from '../projects/store.ts';
import { AccountError, AccountStore, DEFAULT_ACCOUNT, SIGN_IN_ENV, type AccountPlace } from '../accounts/store.ts';
import { removeSignIn } from '../accounts/signin-store.ts';
import type { AccountChoices, AccountInfoView, AwayInfo, AwayKind, SignInProblem } from '../shared/protocol.ts';
import { Away } from './away.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardConfig, parseProject, workflowsOf } from '../config.ts';
import { checkFolder, chosenWorkflow, projectWorkflow, withProfilesWarning, type WorkflowCheck } from './workflow.ts';
import { remoteControlName } from './remote-control.ts';
import { loosensGate } from '../projects/gate.ts';
import { bangRefusal } from './bang.ts';
import { matchSensitive } from './sensitive.ts';
import { AIRGAP_PROFILE, isLocked, levelProblem, lockdownOf, opensUp, othersSettings, overlapProblem, projectFolders, within } from '../projects/lockdown.ts';
import { LATER_SUGGESTIONS, withSuggestions } from '../shared/sensitive-suggestions.ts';
import { isNameColour, parseNameColour } from '../shared/name-colours.ts';
import { ledungTier, reviewAnswerProblem, tiersOf } from '../shared/questions.ts';
import {
  BrowseError, createProjectFolder, defaultProjectsFolder, defaultRoots, isInside, listContainer, listContainers, listLocal,
  type ContainerInfo, type FolderListing,
} from '../projects/browse.ts';
import { hostReachable, listHostRecords, removeHostRecord } from '../host/client.ts';
import { pipePath } from '../host/protocol.ts';
import { DockerRunner } from '../runners/docker-runner.ts';
import { LocalRunner } from '../runners/local-runner.ts';
import { chooseClaude } from '../runners/claude-program.ts';
import { sessionEnv, type Runner } from '../runners/runner.ts';
import type { Store } from '../store/store.ts';
import { lineOrder, mayStart, type LineEntry } from '../resources/line.ts';
import { ResourceMonitor, type MonitorTarget } from '../resources/monitor.ts';
import {
  CHATS,
  PERMISSION_MODES,
  type ChatsInfo,
  PRIORITIES,
  type MachineInfo,
  type McpServerInfo,
  type Priority,
  type PermissionDecision,
  type PermissionMode,
  type ProjectInfo,
  type QuestionInfo,
  type ServerEvent,
  type SessionInfo,
  type SessionRole,
} from '../shared/protocol.ts';
import { resolveWorkFolder, WorkFolderError } from './work-folder.ts';
import { FileError, handoffProblem, hiddenProblem, readProjectFile, readProjectImage, type ProjectFile, type ProjectImage } from './files.ts';
import { listTree, type TreeListing } from './tree.ts';
import type { PaneFolderKey, PaneFolders } from '../shared/files-pane.ts';
import { sessionChanges, type SessionChanges } from './changes.ts';
import { checkLineComments, formatLineComments, lineCommentsMessage, openReviewFor, reviewAnswerWithComments } from '../shared/line-comments.ts';
import { Management, type LinkedMessage, type LinkedPort, type SettingsPort } from './management.ts';
import { findTickets } from '../usage/links.ts';
import { claudeEnvironment, Session, type TurnGate } from './session.ts';
import {
  checkContainerSignIn, checkSignIn, containerSignInHelp, dockerExecArgs, runCommand, sdkClaudeBinary, shellFolder, signInHelp,
  type ContainerPlace, type LoginPlace, type SignIn, type SignInContext,
} from '../accounts/signin.ts';
import { McpError } from './mcp.ts';
import { userDataDir } from '../platform/paths.ts';
import { validateSensitive } from './sensitive.ts';
import { idleReason, idleStopBlocker } from './idle.ts';
import { chooseProfile, FULL_PROFILE, pluginIdsIn, profileByName, profileNames, type Profile } from './profiles.ts';
import { Boards } from '../board/boards.ts';
import { BOARD_FILE_PREFIX, readEvidence } from '../board/attachments.ts';
import type { RepoDirectory } from '../board/repos.ts';
import { BoardStore } from '../board/store.ts';
import { BoardError, type BoardBackend } from '../board/types.ts';
import type { BoardStatus, GitHubBudget } from '../shared/protocol.ts';
import { PullRequestPoller } from './pr-poll.ts';
import { macrosProblem, type Macro } from '../shared/macros.ts';
import { MacroList } from './macro-list.ts';
import { holdingStop, liftKey, nextReset, stopStates, validStop, windowName, type LiftedStops, type UsageStops } from '../usage/stops.ts';
import type { ClaudeCodeView, ConfigStatus, ProfilesView, SkillListView, UsageStopInfo } from '../shared/protocol.ts';
import { effectiveProfiles, readWorkflowProfiles, type EffectiveProfiles } from './workflow-profiles.ts';
import { SkillChoicesSetting, skillsFromFiles, type SkillChoices } from './skills.ts';
import { exercisedLine } from '../platform/exercised.ts';

const LIMIT_KEY = 'max-working-sessions';
/** Usage stops once set in Settings (issue #278), and the ones lifted by hand, by window; kept in meta, so no migration. */
const USAGE_STOPS_KEY = 'usage-stops';
const USAGE_LIFTED_KEY = 'usage-stops-lifted';
/** The chats' own sensitive list, once saved in Settings (issue #211); before that, the suggestions. */
const CHATS_SENSITIVE_KEY = 'chats-sensitive';
/** The chats' name colour (issue #222), one for all of them; kept in meta like their list, so no migration. */
const CHATS_COLOUR_KEY = 'chats-colour';
/** The skill picker's defaults from Settings (#300). */
const SKILL_DEFAULTS_KEY = 'skill-defaults';
/** The macros from Settings (#410), in their order; in meta, so no migration. */
const MACROS_KEY = 'macros';
/** The account chats run on and the one Add project preselects (issue #283), from Settings → Accounts; in meta, so no migration. */
const ACCOUNT_CHOICE_KEYS = { chats: 'chats-account', newProjects: 'new-project-account' } as const;
/** A name the user gives a session (issue #223): as long as a title from a first message may be. */
const MAX_SESSION_NAME = 80;
/** Tell a session's manager when it has waited this long for a free place. */
const WAITING_LONG_MS = 10 * 60 * 1000;

/** A new project with no sensitive list of its own starts with the suggestions (sensitive-always); one that has a list, even an empty one, keeps it. */
function withSuggestedSensitive<T extends object>(config: T): T {
  const raw = config as { sensitive?: { commandPatterns?: string[]; pathPatterns?: string[]; mcpTools?: string[] } };
  if (raw.sensitive !== undefined) return config;
  return { ...config, sensitive: withSuggestions({ commandPatterns: [], pathPatterns: [], mcpTools: [] }) };
}

/** What a resume writes to an ended session, and the events it records first. */
export function resumedState(info: SessionInfo): {
  update: Partial<Pick<SessionInfo, 'status' | 'endedAt' | 'endReason' | 'archivedAt' | 'paused'>>;
  events: string[];
} {
  const events: string[] = [];
  // Resuming an archived session brings it back to the sidebar.
  if (info.archivedAt) events.push('Unarchived: the session is resumed.');
  // A pause holds a running session; it ends with the stop. Kept, it held back the very message that
  // resumed the session (issue #23; "any message to an ended session resumes it and then delivers",
  // decision 2026-10-12).
  if (info.paused) events.push('No longer paused: the session is resumed.');
  return { update: { status: 'starting', endedAt: null, endReason: null, archivedAt: null, paused: false }, events };
}

/** The EXERCISED line of issue #425, once per run. */
let exercised425 = false;

export class SessionManager {
  private readonly live = new Map<string, Session>();
  /** Replaced when the config file changes (issue #353), so it is read when needed, never copied at start. */
  private config: LedungConfig;
  /** The config file's reloads, for Settings (issue #353); null: not watched. */
  private configState: ConfigStatus | null = null;
  private readonly store: Store;
  private readonly publish: (event: ServerEvent) => void;
  private readonly management: Management;
  /** The linked computers (#245), set by the server whenever its public name changes. */
  private linked: LinkedPort | null = null;
  /** Settings' page-only actions for managers (#263), set by the server. */
  private settings: SettingsPort | null = null;
  readonly projectStore: ProjectStore;
  readonly accounts: AccountStore;
  private readonly monitor: ResourceMonitor;
  private readonly gate: TurnGate;
  /** Turns under way: when they started and what started them (step 6c). */
  private readonly turns = new Map<string, { at: number; trigger: string }>();
  /** Sessions whose manager was told they wait long, so it is told once per wait. */
  private readonly toldWaiting = new Set<string>();
  private waitTimer: NodeJS.Timeout | null = null;
  /** Resumes under way, so two messages arriving together start one resume, not two. */
  private readonly resuming = new Map<string, Promise<SessionInfo>>();
  private idleTimer: NodeJS.Timeout | null = null;
  /** Sessions to restart with new lockdown settings once they are free (issue #109). */
  private readonly relaunching = new Set<string>();
  /** Away mode (issue #35): one state for the whole Ledung. */
  readonly away: Away;
  /** The message boards between managers, one per repo the projects name (docs/steps/message-board.md, "Per project"). */
  boards: Boards | null = null;
  /** The one pull request poll for every live session (issue #252). */
  private readonly pullRequests: PullRequestPoller;

  constructor(config: LedungConfig, store: Store, publish: (event: ServerEvent) => void) {
    this.config = config;
    this.store = store;
    // New plan-limit figures may reach or pass a usage stop (issue #278).
    this.publish = (event) => {
      publish(event);
      if (event.type === 'limits') this.refreshStops();
    };
    this.projectStore = new ProjectStore(store.database);
    this.accounts = new AccountStore(store.database);
    // The config file's accounts, then the note in every sign-in folder, also those added in the page (issue #425).
    this.accountsFromConfig();
    for (const a of this.accounts.list()) if (!config.claudeAccounts[a.name]) this.accounts.writeAbout(a.name);
    // When computer control or away mode ends, every manager hears it at once, an idle one too (issue #328).
    this.away = new Away(store, publish, { userName: config.userName, notify: (text) => this.tellManagers(text) });
    this.pullRequests = new PullRequestPoller({
      show: (id, pr) => this.live.get(id)?.showPullRequest(pr),
      onBudget: (github) => this.publish({ type: 'github', github }),
    });
    const imported = this.projectStore.importFromConfig(config.projects);
    if (imported.length) console.log(`Copied ${imported.length} project(s) from the config into Ledung: ${imported.join(', ')}.`);
    const suggested = this.projectStore.addSuggestionsOnce();
    if (suggested) console.log(`Added the suggested sensitive patterns to ${suggested} project(s).`);
    this.addChatsSuggestionsOnce();
    this.management = new Management({
      store,
      userName: config.userName,
      publish,
      wake: (id) => this.live.get(id)?.deliver(),
      resume: (id) => this.resumeIfEnded(id),
      archiveSession: (id, by) => void this.archive(id, by),
      startSession: (project, task, opts) => this.start(project, task, { parentId: opts.parentId, title: opts.title, permissionMode: opts.permissionMode, model: opts.model, profile: opts.profile, cwd: opts.cwd }),
      profilesWarning: (project) => this.profilesFor(this.project(project)).warning,
      stopSession: (id, reason) => this.stop(id, reason),
      projectNames: () => this.projectStore.list().map((p) => p.config.name),
      decidePermission: (permissionId, decision, by) => {
        const p = this.store.getPermission(permissionId);
        return !!p && !!this.live.get(p.sessionId)?.decide(permissionId, decision, by);
      },
      machine: () => this.machine(),
      setPriority: (id, priority, note, by) => this.setPriority(id, priority, note, by),
      setPaused: (id, paused, by) => this.setPaused(id, paused, by),
      mcp: {
        servers: (id) => this.mcpServers(id),
        reconnect: (id, name, by) => this.reconnectMcp(id, name, by),
      },
      projects: () => this.projects(),
      addProject: (config) => this.addProject(this.withFirstWorkflow(config)),
      createProject: (opts) => this.createProject({ ...opts, settings: this.withFirstWorkflow(opts.settings) }),
      ensureManager: (project) => this.ensureManager(project),
      // The page's own save, with its checks (issue #306); the tools decide what they may change and what is asked.
      projectSettings: {
        config: (name) => this.projectStore.get(name)?.config ?? null,
        workflows: () => workflowsOf(this.config),
        check: (name, config) => this.checkSettings(name, config),
        update: (name, config) => this.updateProject(name, config),
      },
      linked: () => this.linked,
      settings: () => this.settings,
      handoffProblem: (id, file) => this.handoffProblem(id, file),
      // The file viewer's own image rules, so a shot that is attached can also be shown (issue #60).
      // A manager's board attachment ("board:...") is from its project's board cache instead.
      shotPath: (id, file) => file.startsWith(BOARD_FILE_PREFIX) ? this.readBoardShot(id, file) : this.readImage(id, file).path,
      evidenceFile: (id, file) => {
        const ev = this.readEvidenceFile(id, file, true);
        return { file: ev.file, kind: ev.kind === 'text' ? 'text' : 'image' };
      },
    });
    this.gate = {
      usageHold: (id) => this.usageHold(id),
      usageStops: () => this.usageStopStates(),
      freed: () => this.dispatch(),
      mayStart: (id) => this.store.getSession(id)?.role === 'manager' || mayStart(id, this.working(), this.limit, this.lineEntries()),
      started: (id, trigger) => {
        this.turns.set(id, { at: Date.now(), trigger });
        this.monitor.beginTurn(id);
      },
      ended: (id, commands) => {
        this.recordTurn(id, commands);
        this.dispatch();
        // A session waiting to take new lockdown settings may now be free (issue #109).
        if (this.relaunching.has(id)) setImmediate(() => void this.relaunchWaiting());
      },
    };
    this.monitor = new ResourceMonitor({
      targets: () => this.targets(),
      withDocker: () => this.projectStore.list().some((p) => p.config.runner === 'docker'),
      onSample: () => this.publish({ type: 'machine', machine: this.machine() }),
    });
    // A stop reached before a restart still holds, and its reset still lifts it (issue #278).
    this.refreshStops();
  }

  // --- The message board (docs/steps/message-board.md) ----------------------------------------------

  /**
   * Connects the boards the projects name, each to a backend for its repo; start() begins polling. The
   * config's board block from before (one repo for the whole Ledung) is moved into the projects once.
   */
  attachBoards(backendFor: (repo: string) => BoardBackend, directory?: RepoDirectory, cacheDir?: string): Boards {
    const store = this.store;
    this.boards = new Boards({
      store: new BoardStore(store.database), backendFor, directory, cacheDir,
      // A manager attaches files from its own folder, with the file viewer's rules (readFrom).
      attachmentRoot: (managerId) => this.readFrom(managerId, '.', (root) => root), config: boardConfig(this.config), userName: this.config.userName,
      projectNames: () => this.projectStore.list().map((p) => p.config.name),
      // A locked project is off the board unless the user let the board in (issue #109; Martin, 19:12: "off");
      // at level B always, since the board reaches other people's Ledungs.
      closed: (project) => {
        const p = this.projectStore.get(project)?.config;
        if (!p || !isLocked(p)) return false;
        const lock = lockdownOf(p);
        return !lock.board || lock.level === 'B';
      },
      manager: async (project, start) => {
        if (start) return this.ensureManager(project);
        const id = this.projectStore.get(project)?.managerId;
        return id && store.getSession(id) ? id : null;
      },
      inbox: (id, source, text) => void store.addInbox(id, source, text),
      wake: async (id) => {
        await this.resumeIfEnded(id);
        this.live.get(id)?.deliver();
      },
      sensitive: (project) => {
        const p = this.projectStore.get(project)?.config;
        return {
          commandPatterns: [...this.config.sensitive.commandPatterns, ...(p?.sensitive.commandPatterns ?? [])],
          pathPatterns: [...this.config.sensitive.pathPatterns, ...(p?.sensitive.pathPatterns ?? [])],
        };
      },
      askUser: (managerId, question, options, shots) => {
        // Ledung's own question needs a tier like any other (issue #96).
        const details = { tier: ledungTier(this.management.questionTiers(managerId)) };
        const q = store.createQuestion({ sessionId: managerId, question, options, addressedTo: 'user', details, shots: shots ?? null });
        store.addMessage(managerId, 'event', { text: `Ledung asked ${this.config.userName} question #${q.id} about a board post it holds.` });
        this.publish({ type: 'question', question: q });
        return q.id;
      },
      publish: (board) => this.publish({ type: 'board', board }),
    });
    const moved = this.boards.adoptLegacy(this.config.board);
    if (moved.length) console.log(`Board: the config's board ${this.config.board!.repo} is now set in project(s) ${moved.join(', ')}.`);
    return this.boards;
  }

  /** A board attachment as an ask_user screenshot: only for a manager, and only from its own project's board. */
  private readBoardShot(sessionId: string, file: string): string {
    const info = this.store.getSession(sessionId);
    if (!info || info.role !== 'manager' || !this.boards) throw new UserError("Only a manager can attach a board attachment, from its own project's board.");
    try {
      return this.boards.attachmentImage(file, info.project).file;
    } catch (e) {
      throw e instanceof BoardError ? new UserError(e.message) : e;
    }
  }

  /**
   * A review's evidence file (docs/steps/pr-review.md): from the session's folder with the file viewer's
   * rules, or a board attachment, which only a manager can give, from its own project's board when asked
   * (ownBoard) and from any board in use here when the page shows it, as board images are.
   */
  private readEvidenceFile(sessionId: string, file: string, ownBoard: boolean): { file: string; kind: 'png' | 'jpeg' | 'text'; bytes: Buffer } {
    if (!file.startsWith(BOARD_FILE_PREFIX)) {
      const ev = this.readFrom(sessionId, file, readEvidence);
      return { file: ev.path, kind: ev.kind, bytes: ev.bytes };
    }
    const info = this.store.getSession(sessionId);
    if (!info || info.role !== 'manager' || !this.boards) throw new UserError("Only a manager can attach a board attachment, from its own project's board.");
    try {
      return this.boards.attachmentEvidence(file, ownBoard ? info.project : undefined);
    } catch (e) {
      throw e instanceof BoardError ? new UserError(e.message) : e;
    }
  }

  /**
   * A review's text file for the page (GET /api/questions/:id/evidence/:n): only one the review names, and
   * checked again now. Its images go through the image routes, which check them as the file viewer does.
   */
  readEvidenceText(questionId: number, n: number): { file: string; content: string } {
    const q = this.store.getQuestion(questionId);
    const ev = Number.isInteger(n) ? q?.details?.review?.evidence?.[n] : undefined;
    if (!q || !ev || ev.kind !== 'text') throw new UserError('That review has no such text file.');
    const f = this.readEvidenceFile(q.sessionId, ev.file, false);
    if (f.kind !== 'text') throw new UserError(`${ev.file} is no longer a text file.`);
    return { file: f.file, content: f.bytes.toString('utf8') };
  }

  /** A board attachment's image for the page (GET /api/board-attachment). */
  readBoardImage(file: string): ProjectImage {
    try {
      return this.requireBoards().attachmentImage(file);
    } catch (e) {
      throw e instanceof BoardError ? new UserError(e.message) : e;
    }
  }

  /** What is left of the GitHub budget the pull request poll uses, for the page (issue #252). */
  githubBudget(): GitHubBudget[] {
    return this.pullRequests.budgets();
  }

  /** The boards for the page's chip and settings; not attached: none. */

  boardStatus(): BoardStatus {
    return this.boards?.status() ?? { configured: false, identity: null, boards: [], projects: {}, unread: {} };
  }

  /** The boards, or a UserError for the page when they are not attached. */
  requireBoards(): Boards {
    if (!this.boards) throw new UserError('The message board is not available in this Ledung.');
    return this.boards;
  }

  // --- Machine resources (step 6) ---------------------------------------------------------------

  /** Starts measuring and watching the line; main calls this once Ledung is up. */
  startMeasuring(): void {
    this.monitor.start();
    this.waitTimer = setInterval(() => {
      this.checkWaiting();
      void this.relaunchWaiting();
    }, 60000);
    // Always on, as idleStopMinutes can change while Ledung runs (issue #353); checkIdle reads it each time.
    this.idleTimer = setInterval(() => void this.checkIdle(), 60000);
  }

  /** The settings in use: the config file's, with its live changes since the start (issue #353). */
  get currentConfig(): LedungConfig {
    return this.config;
  }

  /**
   * The config file changed (issue #353): its live settings count from now, for new and resumed sessions; running
   * sessions keep what they started with. What the page shows from them is sent again.
   */
  applyConfig(config: LedungConfig, changed: SettingName[]): void {
    this.config = config;
    if (changed.includes('projects')) {
      const imported = this.projectStore.importFromConfig(config.projects);
      if (imported.length) console.log(`Copied ${imported.length} project(s) from the config into Ledung: ${imported.join(', ')}.`);
    }
    if (changed.includes('claudeAccounts')) {
      const touched = this.accountsFromConfig();
      this.publishAccounts();
      // A new folder is empty until someone signs in to it: the banner says so (issue #333).
      if (touched.length) void this.checkSignIns(touched);
    }
    if (changed.includes('usageStops')) this.refreshStops();
    if (changed.includes('maxWorkingSessions')) this.dispatch();
    if (changed.includes('claudeExecutable')) void this.checkClaude().catch(() => undefined);
    this.publish({ type: 'projects', projects: this.projects() });
    this.publish({ type: 'chats', chats: this.chats() });
  }

  configStatus(): ConfigStatus | undefined {
    return this.configState ?? undefined;
  }

  setConfigStatus(status: ConfigStatus): void {
    this.configState = status;
    this.publish({ type: 'config', config: status });
  }

  /** Stops sessions that have been idle for the configured time, to free their processes. */
  async checkIdle(now = Date.now()): Promise<string[]> {
    const minutes = this.config.idleStopMinutes;
    if (minutes <= 0) return [];
    const stopped: string[] = [];
    for (const session of [...this.live.values()]) {
      const state = session.idleState();
      if (!state || idleStopBlocker(state, now, minutes * 60000) !== null) continue;
      try {
        await session.stop(idleReason(minutes), { quiet: true });
        this.live.delete(session.id);
        stopped.push(session.id);
      } catch (e) {
        console.error(`Idle stop of ${session.id}: ${(e as Error).message}`);
      }
    }
    if (stopped.length) this.dispatch();
    return stopped;
  }

  get limit(): number {
    const stored = Number(this.store.getMeta(LIMIT_KEY));
    return stored >= 1 ? stored : this.config.maxWorkingSessions;
  }

  /** A note from Ledung to every manager that has not ended, delivered now (issue #328). */
  private tellManagers(text: string): void {
    for (const s of this.store.listSessions()) {
      if (s.role !== 'manager' || s.status === 'ended') continue;
      this.store.addInbox(s.id, 'ledung', text);
      this.live.get(s.id)?.deliver();
    }
  }

  /** Away mode from the page (issue #35): until HH:MM, allowing merge, dev ship, computer control; again while away changes it. */
  setAway(until: string, allow: AwayKind[]): AwayInfo {
    try {
      return this.away.start(until, allow);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  // --- Usage stops (issue #278) ------------------------------------------------------------------

  private usageStops(): UsageStops {
    const stored = this.store.getMeta(USAGE_STOPS_KEY);
    return stored ? JSON.parse(stored) as UsageStops : this.config.usageStops ?? {};
  }

  private liftedStops(): LiftedStops {
    const stored = this.store.getMeta(USAGE_LIFTED_KEY);
    return stored ? JSON.parse(stored) as LiftedStops : {};
  }

  /** Every usage stop and where it stands now. */
  usageStopStates(now = Date.now()): UsageStopInfo[] {
    const states = stopStates(this.usageStops(), this.store.latestLimits(), this.liftedStops(), now);
    for (const s of states) if (s.holding) s.since = this.holdingSince.get(s.account) ?? now;
    return states;
  }

  /** The stop holding this session's account, if any: its new turns wait, as when paused. */
  usageHold(id: string): UsageStopInfo | undefined {
    const info = this.store.getSession(id);
    return info ? holdingStop(this.usageStopStates(), info.account ?? DEFAULT_ACCOUNT) : undefined;
  }

  /** Sets a stop from Settings (null: none). A new level also ends a lift by hand: the new level counts. */
  setUsageStop(account: string, kind: string, percent: number | null): UsageStopInfo[] {
    if (!validStop(account, kind, percent)) throw new UserError('A usage stop is a percent from 1 to 100 for a window such as five_hour or seven_day.');
    const stops = structuredClone(this.usageStops());
    if (percent === null) {
      if (stops[account]) delete stops[account]![kind];
      if (stops[account] && !Object.keys(stops[account]!).length) delete stops[account];
    } else {
      (stops[account] ??= {})[kind] = percent;
    }
    this.store.setMeta(USAGE_STOPS_KEY, JSON.stringify(stops));
    const lifted = this.liftedStops();
    delete lifted[liftKey(account, kind)];
    this.store.setMeta(USAGE_LIFTED_KEY, JSON.stringify(lifted));
    return this.refreshStops();
  }

  /** Lifts a reached stop by hand for the rest of its window; it holds again in the next window. */
  liftUsageStop(account: string, kind: string): UsageStopInfo[] {
    const state = this.usageStopStates().find((s) => s.account === account && s.kind === kind);
    if (!state?.holding) throw new UserError('That usage stop is not holding work.');
    const lifted = this.liftedStops();
    lifted[liftKey(account, kind)] = state.resetsAt;
    this.store.setMeta(USAGE_LIFTED_KEY, JSON.stringify(lifted));
    return this.refreshStops();
  }

  /** Accounts a stop holds, and since when (a turn that began before finishes). */
  private holdingSince = new Map<string, number>();
  private stopTimer: NodeJS.Timeout | null = null;
  private toldStops = '[]';

  /**
   * Looks at the stops again after a change (new figures, a new level, a lift, a window's reset): tells the page,
   * says once in each live manager's conversation on a newly held account that work is held, lets held work go
   * where a stop no longer holds, and wakes at the next reset.
   */
  private refreshStops(): UsageStopInfo[] {
    const states = this.usageStopStates();
    const holding = new Set(states.filter((s) => s.holding).map((s) => s.account));
    for (const account of holding) {
      if (this.holdingSince.has(account)) continue;
      const s = holdingStop(states, account)!;
      this.holdingSince.set(account, s.since!);
      const until = s.resetsAt != null ? ` until the window resets (${new Date(s.resetsAt).toLocaleString()})` : '';
      console.log(`Usage stop: ${windowName(s.kind)} usage of account "${account}" reached ${s.percent}%; new turns are held${until}.`);
      for (const live of this.live.values()) {
        const info = this.store.getSession(live.id);
        if (info?.role === 'manager' && (info.account ?? DEFAULT_ACCOUNT) === account && info.status !== 'ended') live.noteHeld(s);
      }
    }
    const freed = [...this.holdingSince.keys()].filter((a) => !holding.has(a));
    for (const a of freed) this.holdingSince.delete(a);
    // Only a change: new figures arrive every turn, and a Ledung with no stops has nothing to say.
    const told = JSON.stringify(states);
    if (told !== this.toldStops) this.publish({ type: 'usageStops', usageStops: states });
    this.toldStops = told;
    for (const s of this.live.values()) {
      if (freed.includes(this.store.getSession(s.id)?.account ?? DEFAULT_ACCOUNT)) s.releaseHeld();
    }
    if (freed.length) this.dispatch();
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const reset = nextReset(states);
    // At most a day ahead (setTimeout's limit is ~24.8 days, and a clock change is caught on the next look).
    if (reset != null) this.stopTimer = setTimeout(() => this.refreshStops(), Math.min(Math.max(reset - Date.now(), 0) + 1000, 24 * 60 * 60 * 1000)).unref();
    return states;
  }

  setLimit(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new UserError('The limit must be a whole number from 1 to 100.');
    this.store.setMeta(LIMIT_KEY, String(n));
    this.publish({ type: 'machine', machine: this.machine() });
    this.dispatch();
  }

  /**
   * Sessions working now: in a turn (running, or waiting on a permission prompt mid-turn, which goes on
   * as soon as it is answered), not paused. Managers, and sessions between turns, don't count.
   */
  private working(): number {
    let n = 0;
    for (const s of this.live.values()) {
      const info = this.store.getSession(s.id);
      // A turn held at a tool call by a usage stop frees its place, as a paused one does (review 2 of #278, finding 2).
      if (info && info.role === 'session' && (info.status === 'running' || info.status === 'waiting') && !info.paused && !s.heldAtToolCall) n++;
    }
    return n;
  }

  private lineEntries(): LineEntry[] {
    const out: LineEntry[] = [];
    for (const s of this.live.values()) {
      const info = this.store.getSession(s.id);
      if (info?.status === 'queued' && !info.paused) out.push({ id: info.id, priority: info.priority, since: info.queuedAt ?? info.createdAt });
    }
    return out;
  }

  /** Lets the sessions in line start, in order, as long as there is room. */
  private dispatch(): void {
    for (const id of lineOrder(this.lineEntries())) this.live.get(id)?.deliver();
  }

  machine(): MachineInfo {
    return {
      at: Date.now(), ...this.monitor.machine(), docker: this.monitor.docker, sessions: this.monitor.figures(),
      working: this.working(), limit: this.limit, line: lineOrder(this.lineEntries()),
    };
  }

  private targets(): MonitorTarget[] {
    const out: MonitorTarget[] = [];
    for (const s of this.live.values()) {
      const info = this.store.getSession(s.id);
      if (!info || info.status === 'ended') continue;
      const project = this.configOrNull(info);
      if (!project) continue;
      out.push(project.runner === 'local' ? { id: info.id, kind: 'local' } : { id: info.id, kind: 'docker', container: project.container, user: project.user });
    }
    return out;
  }

  private recordTurn(id: string, commands: string[]): void {
    const turn = this.turns.get(id);
    this.turns.delete(id);
    const totals = this.monitor.endTurn(id);
    const info = this.store.getSession(id);
    if (!turn || !totals || !info) return;
    try {
      const durationMs = Date.now() - turn.at;
      this.store.addTurnResource({
        sessionId: id, project: info.project, role: info.role, model: info.model, trigger: turn.trigger,
        startedAt: turn.at, durationMs, cpuSeconds: totals.cpuSeconds, samples: totals.samples,
        avgCores: 0, peakCores: totals.peakCores, peakMem: totals.peakMem, commands,
      });
    } catch (e) {
      console.error(`Turn record for ${id}: ${(e as Error).message}`);
    }
  }

  private checkWaiting(): void {
    const line = lineOrder(this.lineEntries());
    for (const id of this.toldWaiting) if (!line.includes(id)) this.toldWaiting.delete(id);
    line.forEach((id, i) => {
      const since = this.store.getSession(id)?.queuedAt;
      if (!since || this.toldWaiting.has(id) || Date.now() - since < WAITING_LONG_MS) return;
      this.toldWaiting.add(id);
      this.management.onWaitingLong(id, Math.round((Date.now() - since) / 60000), i + 1);
    });
    // A compact with no outcome for 10 minutes: its requester is alerted once.
    for (const session of this.live.values()) session.checkCompact();
  }

  /** clear_self: why the handoff file can't be used, or null. A container's files can't be read yet, so only the path is checked there. */
  private handoffProblem(sessionId: string, file: string): string | null {
    const info = this.store.getSession(sessionId);
    if (!info) return 'No such session.';
    const project = this.configOf(info);
    if (project.runner !== 'local') {
      return path.isAbsolute(file) || file.split('/').includes('..') ? 'Give the handoff file relative to the project folder, inside it.' : null;
    }
    return handoffProblem(info.workDir ?? project.path, file);
  }

  setPriority(id: string, priority: Priority, note: string | null, by: string): void {
    if (!PRIORITIES.includes(priority)) throw new UserError(`Unknown priority "${priority}".`);
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    this.store.updateSession(id, { priority, priorityNote: note });
    this.store.addMessage(id, 'event', { text: `Priority set to ${priority} by ${by}.${note && by !== this.config.userName ? ` (${note})` : ''}` });
    this.publish({ type: 'session', session: this.live.get(id)?.info ?? this.store.getSession(id)! });
    this.publish({ type: 'machine', machine: this.machine() });
    this.dispatch();
  }

  /**
   * A name the user gives a session, a chat or a manager (issue #223), from the page only: no tool reaches it. The
   * first-message title only replaces the "New chat"/"New session" placeholders, and a project rename only a manager
   * still called "Manager: <old name>", so a given name stays. Everything else reads the title by id.
   */
  renameSession(id: string, title: unknown): SessionInfo {
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    if (typeof title !== 'string') throw new UserError('The name must be text.');
    const name = title.replace(/\s+/g, ' ').trim();
    if (!name) throw new UserError('The name cannot be empty.');
    if (name.length > MAX_SESSION_NAME) throw new UserError(`The name can be at most ${MAX_SESSION_NAME} characters.`);
    if (name !== info.title) {
      this.store.updateSession(id, { title: name });
      this.publish({ type: 'message', message: this.store.addMessage(id, 'event', { text: `Renamed to "${name}" by ${this.config.userName}.` }) });
      this.publish({ type: 'session', session: this.live.get(id)?.info ?? this.store.getSession(id)! });
    }
    return this.live.get(id)?.info ?? this.store.getSession(id)!;
  }

  setPaused(id: string, paused: boolean, by = this.config.userName): void {
    this.liveSession(id).setPaused(paused, by);
    this.publish({ type: 'machine', machine: this.machine() });
    // A paused session frees its place.
    this.dispatch();
  }

  /** Simon's Cancel on a clear's countdown (clear_session). */
  cancelClear(id: string): void {
    if (!this.liveSession(id).cancelClear(this.config.userName)) throw new UserError('No clear is waiting for this session.');
  }

  startNow(id: string): void {
    const session = this.liveSession(id);
    if (this.store.getSession(id)?.status !== 'queued') throw new UserError('This session is not waiting for a place.');
    session.startNow();
  }

  /** What a Session needs from here, the same for new, resumed and reattached sessions. */
  private sessionOptions(project: ProjectConfig, info: SessionInfo, attaching = false) {
    // The project's account login; a session reattached after a restart already has its own.
    let account: { name: string; env: Record<string, string> } | null = null;
    if (project.account) {
      try {
        account = { name: project.account, env: this.accounts.envFor(project.account, placeOf(project)) };
      } catch (e) {
        if (!attaching) throw new UserError((e as Error).message);
      }
    }
    // The profile it started with (#20); one taken out of the config since stops a new start, so it never
    // quietly gets more than it had. A reattached session already runs with its own.
    let profile: Profile | undefined;
    const profiles = this.profilesFor(project);
    const launch = this.launchSettings(project, info.role);
    if (launch.airgap) {
      // Level B: the airgap profile, whatever profile it was started with (issue #109).
      profile = AIRGAP_PROFILE;
    } else {
      try {
        profile = profileByName(info.profile ?? FULL_PROFILE, profiles.profiles);
      } catch (e) {
        if (!attaching) throw new UserError(withWarning(`${(e as Error).message} The session was started with it.`, profiles));
      }
    }
    return {
      account, profile, pluginsOff: profiles.pluginsOff,
      // The user's own skills it gets (#300); chats are the user's own and keep them all.
      skills: info.project === CHATS ? null : { role: info.role, defaults: this.skillDefaults(), project: project.skills },
      lockdown: launch.others,
      airgap: launch.airgap,
      // A reattached session runs on the account it started with, not a chats' choice changed since (review of #287).
      onAccountInfo: (who: { email?: string; organization?: string; subscriptionType?: string }) => this.noteIdentity((attaching ? info.account : project.account) ?? DEFAULT_ACCOUNT, who),
      // Not signed in: the start says how to sign in instead of failing on the first turn (issue #333). In a
      // container without an account it is the container's own login, which Ledung doesn't look at.
      signInRefusal: project.runner === 'local'
        ? (where: SignInContext) => this.signInRefusal(project.account ?? DEFAULT_ACCOUNT, where)
        : project.account ? () => this.containerSignInRefusal(project.account!, { container: project.container, user: project.user || undefined }) : undefined,
      runner: this.runnerFor(project, info), store: this.store, publish: this.publish, model: info.requestedModel ?? undefined, defaultModel: defaultModelFor(project, info.role),
      // A project the user opted in lets its manager's project tools run unasked (decision of 2026-10-14).
      projectToolsUnasked: project.projectToolsUnasked ?? false,
      userName: this.config.userName, management: this.management, grant: project.managerGrant, tickets: project.tickets, gate: this.gate,
      away: this.away, devShip: project.devShipCommand ?? null,
      // The board tools, for a manager whose project has the board on (decision 9); looked at on every start and resume.
      board: launch.board ? this.boards : null,
      pullRequests: this.pullRequests,
      // Looked at on every start and resume, so a config file written meanwhile is found (issue #21).
      workflow: withProfilesWarning(projectWorkflow(chosenWorkflow(workflowsOf(this.config), project), project), profiles.warning),
      remoteControl: launch.remoteControl,
      sensitive: {
        commandPatterns: [...this.config.sensitive.commandPatterns, ...project.sensitive.commandPatterns],
        pathPatterns: [...this.config.sensitive.pathPatterns, ...project.sensitive.pathPatterns],
        mcpTools: [...this.config.sensitive.mcpTools, ...project.sensitive.mcpTools],
      },
    };
  }

  // --- Lockdown (issue #109) ------------------------------------------------------------------------

  /** Every locked project's folders except this project's own. */
  private lockedFoldersBesides(project: string): string[] {
    return this.projectStore.list().filter((p) => p.config.name !== project && isLocked(p.config)).flatMap((p) => projectFolders(p.config));
  }

  /**
   * What lockdown changes in the settings a session is launched with: Remote Control and the board for a
   * locked project's manager (off unless let in), and, for every session of another project on this
   * computer, the locked folders kept from it (a container doesn't see this computer's folders). `key`
   * says the lockdown part alone in one string, so a change restarts exactly the sessions whose settings
   * it changes; it is the same for every session while nothing is locked (NO_LOCKDOWN_KEY).
   */
  private launchSettings(project: ProjectConfig, role: SessionRole): {
    others: ReturnType<typeof othersSettings>; airgap: { network: string[]; folders: string[]; sandbox: boolean } | null; board: boolean; remoteControl: string | null; key: string;
  } {
    const lock = lockdownOf(project);
    const locked = lock.level !== 'off';
    const others = project.runner === 'local' ? othersSettings(this.lockedFoldersBesides(project.name)) : null;
    const board = role === 'manager' && !!this.boards?.availableFor(project.name);
    const remoteControl = remoteControlName(role, project.name, this.config.remoteControl && (!locked || lock.remoteControl));
    const closed = locked && role === 'manager' ? { board: !lock.board, remoteControl: !lock.remoteControl } : null;
    // Level B: the airgap (its sessions' sandbox runs only on this computer; a container is its own wall).
    const airgap = lock.level === 'B' ? { network: lock.network ?? [], folders: projectFolders(project), sandbox: project.runner === 'local' } : null;
    // Only in the key when set, so every key from before level B existed still matches (NO_LOCKDOWN_KEY).
    return { others, airgap, board, remoteControl, key: JSON.stringify(airgap ? { others, closed, airgap } : { others, closed }) };
  }

  /** Records what lockdown settings a session was launched with, so a later change finds it (issue #109). */
  private noteLaunch(project: ProjectConfig, info: SessionInfo): void {
    this.store.setLaunchKey(info.id, this.launchSettings(project, info.role).key);
  }

  /**
   * After a project's lockdown, or a locked project's folders, changed: every running session whose
   * launch settings that changes is restarted with the new ones once it is free, keeping its
   * conversation (Martin, 2026-10-15: "launch-time settings apply after Ledung restarts that project's
   * sessions"). Ledung's own checks need nothing: they read the setting on every call.
   */
  relaunchChanged(): void {
    for (const s of this.live.values()) {
      const info = this.store.getSession(s.id);
      if (!info || info.status === 'ended') continue;
      const project = this.configOrNull(info);
      if (!project) continue;
      // A session from before lockdown existed has no record: it was launched with none.
      const launched = this.store.launchKey(s.id) ?? NO_LOCKDOWN_KEY;
      if (launched !== this.launchSettings(project, info.role).key) this.relaunching.add(s.id);
    }
    void this.relaunchWaiting();
  }

  /**
   * Restarts the waiting sessions that are free now: idle, not paused, no turn, prompt, background work
   * or wake-up that a restart would lose. The others are tried again at their next turn end and every
   * minute. An open question is no reason to wait: questions are kept, and the answer is delivered after.
   */
  async relaunchWaiting(): Promise<string[]> {
    const done: string[] = [];
    for (const id of [...this.relaunching]) {
      // Another call may have taken it meanwhile (they overlap across awaits; review m1): never twice.
      if (!this.relaunching.has(id)) continue;
      const session = this.live.get(id);
      const info = this.store.getSession(id);
      if (!session || !info || info.status === 'ended') {
        this.relaunching.delete(id);
        continue;
      }
      const state = session.idleState();
      if (!state || state.info.status !== 'idle' || state.info.paused || state.turnOpen || state.pendingPermissions || state.backgroundTasks
        || state.facts?.backgroundTasks || state.facts?.crons) continue;
      this.relaunching.delete(id);
      if (!info.claudeSessionId) continue;
      try {
        await session.stop('Ledung restarted this session to apply lockdown settings; its conversation is kept.', { restart: true });
        this.live.delete(id);
        await this.resume(id);
        done.push(id);
      } catch (e) {
        console.error(`Lockdown restart of ${id}: ${(e as Error).message}`);
      }
    }
    if (done.length) this.dispatch();
    return done;
  }

  /** Sessions waiting to be restarted with new lockdown settings. */
  waitingRelaunch(): string[] {
    return [...this.relaunching];
  }

  /**
   * Whether these settings open a locked project up: a lower level, or the board or Remote Control let
   * in; config null: the project is removed. Only the user does that, from the open page (Martin,
   * 2026-10-15); the server asks for the page's key.
   */
  lockdownOpensUp(name: string, config: Record<string, unknown> | null): boolean {
    const current = this.projectStore.get(name)?.config;
    if (!current) return false;
    if (config === null) return isLocked(current);
    return opensUp(lockdownOf(current), lockdownOf(config as ProjectConfig));
  }

  /**
   * Whether these settings loosen what reaches the user (issue #107): a sensitive pattern removed, a new
   * grant or dev ship command, project tools unasked. name null, or no such project: a new one. Like
   * opening a lockdown up, only the user does that, from the open page; the server asks for its key.
   */
  gateLoosens(name: string | null, config: Record<string, unknown>): boolean {
    return loosensGate((name && this.projectStore.get(name)?.config) || null, config);
  }

  /**
   * A locked project's folders are its own (issue #109): no other project may have its folder or an extra
   * folder inside one, and a project can't be locked while another one's folder is inside its own.
   */
  private checkLockdown(config: ProjectConfig): void {
    const lock = lockdownOf(config);
    const problem = levelProblem(lock);
    if (problem) throw new UserError(problem);
    const mine = projectFolders(config);
    for (const other of this.projectStore.list()) {
      if (other.config.name === config.name) continue;
      if (isLocked(other.config)) {
        for (const f of mine) {
          const hit = overlapProblem(f, other.config.name, projectFolders(other.config));
          if (hit) throw new UserError(hit);
        }
      }
      if (lock.level === 'off') continue;
      for (const f of projectFolders(other.config)) {
        const hit = mine.find((m) => within(m, f));
        if (hit) throw new UserError(`The project "${other.config.name}" has ${f} inside this project's folder ${hit}, and a locked project's folders are its own. Change or remove "${other.config.name}" first.`);
      }
    }
  }

  /** checkLockdown for settings not parsed yet: a settings error reads as one. */
  private checkLockdownOf(raw: unknown): void {
    let config: ProjectConfig;
    try {
      config = parseProject(raw);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    this.checkLockdown(config);
  }

  get userName(): string {
    return this.config.userName;
  }

  questions(): QuestionInfo[] {
    return this.store.listQuestions();
  }

  /**
   * The user's answer to a question; it reaches the session as soon as the session is free. `here`: given on
   * this computer, not through the public name, so it can name a manager's Settings action (issue #263).
   */
  async answerQuestion(id: number, answer: string, here = false): Promise<QuestionInfo> {
    if (!answer.trim()) throw new UserError('The answer is empty.');
    const form = this.store.getQuestion(id)?.details?.review ? reviewAnswerProblem(answer) : null;
    if (form) throw new UserError(form);
    if (!this.store.answerQuestion(id, answer.trim(), 'user', null, here)) throw new UserError('This question is no longer open.');
    const q = this.store.getQuestion(id)!;
    this.publish({ type: 'question', question: q });
    // A question that went to a manager: tell the manager Simon answered it directly.
    this.management.onUserAnswered(q);
    // A held first board post waits for this answer (decision 6). Awaited, so the note on how the post went
    // reaches the manager together with the answer, in one turn rather than two (step 3 live test).
    await this.boards?.onUserAnswered(q).catch((e) => console.error(`Board: ${(e as Error).message}`));
    // An ended session is resumed, and gets the answer once it is up ("Resume and deliver", step 2).
    try {
      await this.resumeIfEnded(q.sessionId);
    } catch (e) {
      throw new UserError(`The answer is saved, but the session could not be resumed: ${(e as Error).message}`);
    }
    this.live.get(q.sessionId)?.deliver();
    return this.store.getQuestion(id)!;
  }

  withdrawQuestion(id: number): void {
    if (!this.store.withdrawQuestion(id, `Withdrawn by ${this.config.userName}.`)) throw new UserError('This question is no longer open.');
    this.publish({ type: 'question', question: this.store.getQuestion(id)! });
  }

  projects(): ProjectInfo[] {
    return this.projectStore.list().map((p) => this.projectInfo(p));
  }

  private publishProjects(): void {
    this.publish({ type: 'projects', projects: this.projects() });
  }

  // --- Projects (projects and accounts, P1) ------------------------------------------------------

  // --- Accounts (projects and accounts, P3) ------------------------------------------------------

  /**
   * The profiles a project's sessions can use (#298): its workflow's file, read now, under this computer's config.
   * Chats and projects that follow no workflow, or one without a profiles file, get the computer's own.
   */
  private profilesFor(project: ProjectConfig): EffectiveProfiles {
    const workflow = chosenWorkflow(workflowsOf(this.config), project);
    const read = workflow && projectWorkflow(workflow, project) ? readWorkflowProfiles(workflow) : null;
    return effectiveProfiles(this.config, read);
  }

  /** A project as the page shows it, with the profiles its sessions can use (#298, review round 1). */
  private projectInfo(p: StoredProject): ProjectInfo {
    return { ...projectInfo(p), profileNames: profileNames(this.profilesFor(p.config).profiles) };
  }

  /** The session profiles there are, "full" first (#20): this computer's and every workflow's (#298). */
  profileNames(): string[] {
    const names = workflowsOf(this.config).flatMap((w) => Object.keys(effectiveProfiles(this.config, readWorkflowProfiles(w)).profiles));
    return profileNames(Object.fromEntries([...names, ...Object.keys(this.config.profiles)].map((n) => [n, true])));
  }

  /** Settings' Claude Code (issue #341): what a session started now runs, or why none can. */
  claudeCodeView(): Promise<ClaudeCodeView> {
    return chooseClaude(this.config.claudeExecutable).catch((e: Error) => ({
      setting: this.config.claudeExecutable, required: null, program: null, installed: null, bundled: null, problem: `Ledung could not look for Claude Code: ${e.message}`,
    }));
  }

  /**
   * The profiles for Settings (#298): per workflow with a profiles file, what its projects' sessions get and where
   * each profile comes from, with the file's problem if any; then what chats and other projects get.
   */
  profilesView(): ProfilesView {
    const group = (workflow: string | null, file: string | null, p: EffectiveProfiles) => ({
      workflow, file, warning: p.warning,
      defaults: { manager: p.defaults.manager ?? null, session: p.defaults.session ?? null },
      pluginsOff: p.pluginsOff,
      profiles: Object.entries(p.profiles).map(([name, profile]) => ({ name, source: p.sources[name]!, about: profile.about ?? null, allow: allowRules(profile.settings), mcp: mcpLines(profile) })),
    });
    const withFile = workflowsOf(this.config).flatMap((w) => {
      const read = readWorkflowProfiles(w);
      return read ? [group(w.name, read.file, effectiveProfiles(this.config, read))] : [];
    });
    return { groups: [...withFile, group(null, null, effectiveProfiles(this.config, null))] };
  }

  /** A project may only name profiles it can use; with its workflow's file broken, the start says so instead. */
  private checkProfiles(config: ProjectConfig): void {
    const profiles = this.profilesFor(config);
    if (profiles.warning) return;
    for (const role of ['manager', 'session'] as const) {
      const name = config?.profiles?.[role];
      if (name === undefined) continue;
      try {
        profileByName(name, profiles.profiles);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
    }
  }

  /**
   * add_project and create_project store the first workflow's name when they name none, as the page does
   * for a new project (review of #132: both ways must agree), so the project keeps it whatever the config's order.
   */
  private withFirstWorkflow(config: ProjectConfig): ProjectConfig {
    const first = workflowsOf(this.config)[0];
    if (!first || config.workflow?.name !== undefined || config.workflow?.use === false) return config;
    return { ...config, workflow: { ...config.workflow, name: first.name } };
  }

  /**
   * A workflow named must be in the config (issue #132), unless the project already had it: one taken out of
   * the config since does not stop the project's other settings from being saved.
   */
  private checkWorkflow(config: ProjectConfig, current: ProjectConfig | undefined): void {
    const name = config?.workflow?.name;
    if (name === undefined || name === current?.workflow?.name) return;
    const names = workflowsOf(this.config).map((w) => w.name);
    if (names.includes(name)) return;
    throw new UserError(names.length
      ? `There is no workflow named "${name}"; the config has ${names.map((n) => `"${n}"`).join(', ')}.`
      : `There is no workflow named "${name}"; the config has none.`);
  }

  private checkAccount(config: ProjectConfig): void {
    if (!config?.account) return;
    const account = this.accounts.get(config.account);
    if (!account) throw new UserError(`There is no account named "${config.account}".`);
  }

  private static IDENTITY_KEY = 'default-account-identity';

  /** Who a session of this account found itself logged in as. */
  private noteIdentity(account: string, who: { email?: string; organization?: string; subscriptionType?: string }): void {
    if (!who.email && !who.organization) return;
    if (account === DEFAULT_ACCOUNT) {
      this.store.setMeta(SessionManager.IDENTITY_KEY, JSON.stringify({ email: who.email ?? null, organization: who.organization ?? null, plan: who.subscriptionType ?? null, seenAt: Date.now() }));
    } else {
      this.accounts.setIdentity(account, who);
    }
    this.publishAccounts();
  }

  accountsEvent(): Extract<import('../shared/protocol.ts').ServerEvent, { type: 'accounts' }> {
    const raw = this.store.getMeta(SessionManager.IDENTITY_KEY);
    const inFile = this.config.claudeAccounts;
    const accounts = this.accounts.list().map((a) => inFile[a.name] ? { ...a, inConfigFile: true, whatItIsFor: inFile[a.name]!.whatItIsFor ?? null } : a);
    return {
      type: 'accounts', accounts, defaultIdentity: raw ? JSON.parse(raw) : null, choices: this.accountChoices(), signedOut: this.signedOut(),
      claudeProblem: this.claudeProblem, configFileProblems: this.accountFileProblems,
    };
  }

  /** What the config file's accounts block asked that couldn't be done, from its last read (issue #425). */
  private accountFileProblems: string[] = [];

  /**
   * The config file's accounts (issue #425), at start and when the block changes: the ones Ledung doesn't have are
   * added, changed folders taken, and the note in each sign-in folder written. The names added or changed, whose
   * sign-in the caller checks.
   */
  private accountsFromConfig(): string[] {
    const block = this.config.claudeAccounts;
    const { added, changed, problems } = this.accounts.fromConfig(block);
    this.accountFileProblems = problems;
    for (const p of problems) console.log(p);
    if (added.length) console.log(`Added the Claude account(s) ${added.join(', ')} from the config file.`);
    if (changed.length) console.log(`Changed the sign-in folders of ${changed.join(', ')} from the config file.`);
    if ((added.length || changed.length) && !exercised425) {
      exercised425 = true;
      exercisedLine('EXERCISED #425 an account added or changed from the config file\'s claudeAccounts');
    }
    return [...added, ...changed];
  }

  // --- Signed in? (issue #333) -------------------------------------------------------------------
  /** What each account's last check found, by name ("default": the computer's own login), and how to sign in where it was out. */
  private readonly signIns = new Map<string, SignIn & { help?: string }>();
  /** Asks Claude Code, in a session's folder and with its settings when given; the tests give their own answers. */
  checkSignInWith: (env: Record<string, string>, where?: SignInContext) => Promise<SignIn> = async (env, where) =>
    // The Claude Code sessions start (issue #341): the user's own, or the SDK's copy when the config says so.
    checkSignIn(env, { where, binary: (await chooseClaude(this.config.claudeExecutable)).program?.path ?? null });

  /** Claude Code missing or too old on this computer (issue #341), for the page's banner; null: none. */
  private claudeProblem: string | null = null;

  /** Looks for the Claude Code sessions run, and tells the page when its problem changed. Never throws. */
  async checkClaude(): Promise<ClaudeCodeView> {
    const view = await this.claudeCodeView();
    if (view.problem !== this.claudeProblem) {
      this.claudeProblem = view.problem;
      this.publishAccounts();
    }
    return view;
  }
  /** Asks Claude Code in a container about a login folder there (#342); the tests give their own answers. */
  checkContainerSignInWith: (place: ContainerPlace, folder: string | null) => Promise<SignIn> = (place, folder) => checkContainerSignIn(place, folder);
  /** Removes a removed account's sign-in from Claude Code's store at that place, and nothing else (#342, R2-M4). Never throws. */
  signOutWith: (place: LoginPlace) => Promise<void> = (place) => removeSignIn(place);

  /**
   * Checks whether Claude Code is signed in for these accounts (all of them and the computer's own login
   * when none are named), and tells the page if that changed. On start, when an account is added and on
   * Check again. Never throws.
   */
  async checkSignIns(names?: string[]): Promise<void> {
    const all = names ?? [DEFAULT_ACCOUNT, ...this.accounts.list().map((a) => a.name)];
    // Check again also looks for Claude Code again (issue #341): its banner has the same button.
    const [claude] = await Promise.all([this.claudeCodeView(), ...all.map((n) => this.checkSignInOf(n))]);
    this.claudeProblem = claude.problem;
    this.publishAccounts();
  }

  /**
   * Where an account's login folders are: on this computer when a local project, chats or Add project use it
   * (or nothing does yet), and in each container its projects run in, once per container and user (#342).
   */
  accountPlaces(name: string): LoginPlace[] {
    const account = this.accounts.get(name);
    if (!account) return [];
    const projects = this.projectStore.list().map((p) => p.config).filter((c) => c.account === name);
    const choices = this.accountChoices();
    const local = !projects.length || projects.some((c) => c.runner === 'local') || choices.chats === name || choices.newProjects === name;
    const places: LoginPlace[] = local ? [{ kind: 'local', folder: account.configDir }] : [];
    const seen = new Set<string>();
    for (const c of projects) {
      if (c.runner !== 'docker') continue;
      const key = `${c.container}\0${c.user ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      places.push({ kind: 'docker', container: c.container, ...(c.user ? { user: c.user } : {}), folder: this.accounts.folderFor(account, 'docker') });
      // Kept, so the account's folder there is signed out when it is removed, after its projects have left it.
      this.accounts.noteContainer(name, { container: c.container, ...(c.user ? { user: c.user } : {}) });
    }
    return places;
  }

  /** Is the login folder there signed in? Claude Code's own answer; never throws. */
  private async checkPlace(place: LoginPlace): Promise<SignIn> {
    try {
      if (place.kind === 'docker') return await this.checkContainerSignInWith(place, place.folder);
      return await this.checkSignInWith(sessionEnv({ env: claudeEnvironment(process.env, { [SIGN_IN_ENV]: place.folder }, '') }));
    } catch (e) {
      return { state: 'unknown', method: null, detail: (e as Error).message, checkedAt: Date.now() };
    }
  }

  /** An account's sign-in: out where any of its folders is out, with how to sign in there. */
  private async checkSignInOf(name: string): Promise<SignIn> {
    if (name === DEFAULT_ACCOUNT || !this.accounts.get(name)) {
      const found = await this.askSignIn(name);
      this.signIns.set(name, found);
      return found;
    }
    const places = this.accountPlaces(name);
    const found = await Promise.all(places.map((p) => this.checkPlace(p)));
    const out = places.filter((_, i) => found[i]!.state === 'out');
    const state: SignIn['state'] = out.length ? 'out' : found.some((f) => f.state === 'unknown') ? 'unknown' : 'in';
    const combined = { state, method: found.find((f) => f.method)?.method ?? null, detail: found.find((f) => f.detail)?.detail ?? null, checkedAt: Date.now() };
    this.signIns.set(name, { ...combined, help: out.map((p) => this.placeHelp(name, p)).join(' ') });
    return combined;
  }

  private placeHelp(name: string, place: LoginPlace): string {
    return place.kind === 'local' ? signInHelp({ name, kind: 'folder', configDir: place.folder }) : containerSignInHelp(name, place, place.folder);
  }

  /** What Claude Code says for this account, with a session's folder and settings when given. Never throws. */
  private async askSignIn(name: string, where?: SignInContext): Promise<SignIn> {
    try {
      // The environment a session of the account gets, as far as its login goes.
      const accountEnv = name === DEFAULT_ACCOUNT ? undefined : this.accounts.envFor(name);
      return await this.checkSignInWith(sessionEnv({ env: claudeEnvironment(process.env, accountEnv, '') }), where);
    } catch (e) {
      return { state: 'unknown', method: null, detail: (e as Error).message, checkedAt: Date.now() };
    }
  }

  /**
   * Whether a session of this account may start: refused with how to sign in only when Claude Code says it
   * is signed out, asked as the session would be (its folder and settings), so a start that would work is never
   * refused (review of #333, point 3). When the check couldn't tell, it starts with a warning. The answer is
   * the session's own: it leaves the banner, which is about the account.
   */
  async signInRefusal(name: string, where: SignInContext): Promise<{ refuse: string } | { warn: string } | null> {
    const found = await this.askSignIn(name, where);
    if (found.state === 'out') return { refuse: this.signInHelpFor(name) };
    if (found.state === 'unknown') return { warn: `Ledung could not check that Claude Code is signed in (${found.detail ?? 'no answer'}); starting anyway.` };
    return null;
  }

  /**
   * A container session of an account (#342): refused with how to sign in when Claude Code in the container says
   * its login folder there is signed out; a check that can't tell refuses nothing.
   */
  async containerSignInRefusal(name: string, place: ContainerPlace): Promise<{ refuse: string } | { warn: string } | null> {
    const account = this.accounts.get(name);
    if (!account) return null;
    this.accounts.noteContainer(name, place);
    const folder = this.accounts.folderFor(account, 'docker');
    // A Claude Code there that answers for an empty sign-in folder would run on another login (R2-I1).
    if ((await this.checkContainerSignInWith(place, null)).state === 'in') {
      return { refuse: `Claude Code in the container "${place.container}" doesn't keep sign-ins per folder, so the account "${name}" can't be used there. Update Claude Code in the container.` };
    }
    const found = await this.checkContainerSignInWith(place, folder);
    return found.state === 'out' ? { refuse: containerSignInHelp(name, place, folder) } : null;
  }

  private signInHelpFor(name: string): string {
    const help = this.signIns.get(name)?.help;
    if (help) return help;
    const account = name === DEFAULT_ACCOUNT ? undefined : this.accounts.get(name);
    return signInHelp(account ? { name, kind: 'folder', configDir: account.configDir } : { name, kind: 'default' });
  }

  /**
   * The accounts in use that the last check found signed out, for the page's banner. The computer's own
   * login only while something uses it: a local project or chats without an account, or Add project's
   * choice; someone who works only with added accounts is not told to sign in on the computer.
   */
  signedOut(): SignInProblem[] {
    const choices = this.accountChoices();
    const defaultUsed = choices.chats === null || choices.newProjects === null
      || this.projectStore.list().some((p) => p.config.runner === 'local' && !p.config.account);
    const names = [...(defaultUsed ? [DEFAULT_ACCOUNT] : []), ...this.accounts.list().map((a) => a.name)];
    return names.filter((n) => this.signIns.get(n)?.state === 'out').map((n) => ({ account: n, help: this.signInHelpFor(n) }));
  }

  /** The accounts chosen for chats and for new projects (issue #283); null: the computer's own login. */
  accountChoices(): AccountChoices {
    // One removed some other way since reads as the default, so a chat never fails on a name that is gone.
    const read = (key: string) => {
      const name = this.store.getMeta(key);
      return name && this.accounts.get(name) ? name : null;
    };
    return { chats: read(ACCOUNT_CHOICE_KEYS.chats), newProjects: read(ACCOUNT_CHOICE_KEYS.newProjects) };
  }

  /** Settings → Accounts' two choices (issue #283); "" or null sets one back to the computer's own login. */
  setAccountChoices(body: { chats?: unknown; newProjects?: unknown }): AccountChoices {
    // Both checked before either is kept, so a refused one never leaves the other half saved (review of #287).
    const chosen: [keyof AccountChoices, string][] = [];
    for (const which of ['chats', 'newProjects'] as const) {
      const value = body[which];
      if (value === undefined) continue;
      if (value !== null && typeof value !== 'string') throw new UserError('An account is chosen by its name.');
      const name = value?.trim() || null;
      if (name && name !== DEFAULT_ACCOUNT && !this.accounts.get(name)) throw new UserError(`There is no account named "${name}".`);
      chosen.push([which, name === DEFAULT_ACCOUNT ? '' : name ?? '']);
    }
    for (const [which, name] of chosen) this.store.setMeta(ACCOUNT_CHOICE_KEYS[which], name);
    this.publishAccounts();
    return this.accountChoices();
  }

  private publishAccounts(): void {
    this.publish(this.accountsEvent());
  }

  addAccount(a: { name: string; kind?: 'folder'; configDir?: string; containerDir?: string }): AccountInfoView {
    try {
      const added = this.accounts.add(a);
      this.publishAccounts();
      // A new login folder is empty until someone signs in to it: the banner says so (issue #333).
      void this.checkSignIns([added.name]);
      return added;
    } catch (e) {
      throw e instanceof AccountError ? new UserError(e.message) : e;
    }
  }

  /**
   * The account's sign-in folder on this computer, for Settings' Open folder (issue #414); made again if it is gone,
   * as adding the account made it, so the file manager has something to show.
   */
  accountFolder(name: string): string {
    const account = this.accounts.get(name);
    if (!account) throw new UserError(`There is no account named "${name}".`);
    fs.mkdirSync(account.configDir, { recursive: true });
    return account.configDir;
  }

  /**
   * Refuses at once (an account in use); the sign-out after it is what the promise waits for: where it signed
   * out, and where it didn't because the folder is another login's too (review of #342, I3).
   */
  removeAccount(name: string): Promise<{ signedOut: string[]; skipped: string[] }> {
    const using = this.projectStore.list().filter((p) => p.config.account === name).map((p) => p.config.name);
    if (using.length) throw new UserError(`The account is used by ${using.join(', ')}. Choose another account there first.`);
    const choices = this.accountChoices();
    const chosen = [choices.chats === name && 'chats', choices.newProjects === name && 'new projects'].filter(Boolean);
    if (chosen.length) throw new UserError(`The account is chosen for ${chosen.join(' and ')}. Choose another one above first.`);
    // Signed out with Claude Code's own logout where its folders are, so no login is left behind: on macOS the
    // Keychain entry stays when a folder is only deleted (#342, Mac probe). The folders themselves stay. Its
    // folder on this computer, and every container its projects ran in (review of #342, I2). A folder that is
    // another login's too (an account from before #342 may share one) is left signed in: logging it out would
    // sign that login out (I3).
    const account = this.accounts.get(name);
    const places: { place: LoginPlace; shared: string | null }[] = [];
    if (account) {
      places.push({ place: { kind: 'local', folder: account.configDir }, shared: this.accounts.sharedWith({ name, configDir: account.configDir }) });
      const folder = this.accounts.folderFor(account, 'docker');
      const shared = this.accounts.sharedWith({ name, containerDir: folder });
      for (const c of this.accounts.containersOf(name)) places.push({ place: { kind: 'docker', ...c, folder }, shared });
    }
    this.accounts.remove(name);
    this.signIns.delete(name);
    this.publishAccounts();
    const label = (p: LoginPlace) => p.kind === 'local' ? p.folder : `${p.folder} in the container "${p.container}"`;
    const skipped = places.filter((p) => p.shared).map((p) => `${label(p.place)} (it is ${p.shared})`);
    const going = places.filter((p) => !p.shared).map((p) => p.place);
    return Promise.all(going.map((p) => this.signOutWith(p))).then(() => ({ signedOut: going.map(label), skipped }));
  }

  // --- Browsing and adding (projects and accounts, P2) ------------------------------------------

  /** The folders the browser may show, and where new projects go by default. */
  private allowedFolders(): string[] {
    return [...defaultRoots(this.config.browseRoots), defaultProjectsFolder(this.config.projectsFolder)];
  }

  /**
   * For the Add project form and the settings: the configured workflows, and whether this folder has the
   * project's config for the one named (none: the first, issue #132).
   */
  workflowCheck(folder: string | undefined, projectConfig: string | undefined, name?: string): WorkflowCheck & { workflows: string[] } {
    if (folder) {
      folder = path.resolve(folder);
      if (!isInside(folder, this.allowedFolders())) throw new UserError('That folder is outside the folders Ledung may use.');
    }
    // A missing file has no real path to check, so check the nearest folder that exists (the path is resolved, so no ".." is left).
    const mayLook = (file: string) => {
      let at = file;
      while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
      return isInside(at, this.allowedFolders());
    };
    const workflows = workflowsOf(this.config);
    const workflow = name ? workflows.find((w) => w.name === name) : workflows[0];
    return { ...checkFolder(workflow, folder, projectConfig, mayLook), workflows: workflows.map((w) => w.name) };
  }

  get projectsFolder(): string {
    return defaultProjectsFolder(this.config.projectsFolder);
  }

  browse(folder?: string): FolderListing {
    const local = this.projectStore.list().flatMap((p) => (p.config.runner === 'local' ? [{ name: p.config.name, path: p.config.path }] : []));
    const roots = defaultRoots(this.config.browseRoots);
    const projects = this.projectsFolder;
    // The projects folder is offered as a starting point too, once it exists.
    const starts = fs.existsSync(projects) && !roots.some((r) => path.resolve(r) === projects) ? [...roots, projects] : roots;
    try {
      return { ...listLocal(folder, this.allowedFolders().filter((f) => fs.existsSync(f)), local), roots: starts };
    } catch (e) {
      throw e instanceof BrowseError ? new UserError(e.message) : e;
    }
  }

  async containers(): Promise<ContainerInfo[]> {
    try {
      return await listContainers();
    } catch (e) {
      throw e instanceof BrowseError ? new UserError(e.message) : e;
    }
  }

  async browseContainer(container: string, user: string | undefined, folder: string | undefined): Promise<FolderListing> {
    if (!container) throw new UserError('Choose a container.');
    const projects = this.projectStore.list().flatMap((p) => (p.config.runner === 'docker' ? [{ name: p.config.name, container: p.config.container, path: p.config.pathInContainer }] : []));
    try {
      return await listContainer(container, user || undefined, folder || undefined, projects);
    } catch (e) {
      throw e instanceof BrowseError ? new UserError(e.message) : e;
    }
  }

  /**
   * A brand-new project: its folder (under the projects folder by default), git, optionally a private
   * GitHub repository; then the project, and its manager started with the task, if one is given.
   */
  async createProject(opts: { parent?: string; github: boolean; task?: string; settings: ProjectConfig }): Promise<{ project: ProjectInfo; warning: string | null; githubUrl: string | null }> {
    const parent = path.resolve(opts.parent || this.projectsFolder);
    let settings: ProjectConfig;
    try {
      settings = parseProject({ ...withSuggestedSensitive(opts.settings), runner: 'local', path: path.join(parent, String(opts.settings.name ?? '')) });
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    if (this.projectStore.get(settings.name)) throw new UserError(`There is already a project named "${settings.name}".`);
    // Before the folder is made, so a refused lockdown or workflow leaves nothing behind (issues #109, #132).
    this.checkLockdown(settings);
    this.checkWorkflow(settings, undefined);
    if (parent === this.projectsFolder) fs.mkdirSync(parent, { recursive: true });
    let made: Awaited<ReturnType<typeof createProjectFolder>>;
    try {
      made = await createProjectFolder(parent, settings.name, this.allowedFolders().filter((f) => fs.existsSync(f)), opts.github);
    } catch (e) {
      throw e instanceof BrowseError ? new UserError(e.message) : e;
    }
    const project = this.addProject({ ...settings, runner: 'local', path: made.path } as ProjectConfig);
    if (opts.task?.trim()) await this.messageManager(project.name, opts.task.trim());
    return { project: this.projects().find((p) => p.name === project.name) ?? project, warning: made.warning, githubUrl: made.githubUrl };
  }

  /** Adds an existing project; its manager is started when first needed (decided 2026-10-11). */
  addProject(config: ProjectConfig): ProjectInfo {
    if (config?.runner === 'local') {
      const folder = path.resolve(String(config.path ?? ''));
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new UserError("That folder doesn't exist.");
      if (!isInside(folder, this.allowedFolders())) throw new UserError('That folder is outside the folders Ledung may use.');
      config = { ...config, path: folder };
    }
    this.checkAccount(config);
    this.checkProfiles(config);
    this.checkWorkflow(config, undefined);
    this.checkLockdownOf(config);
    try {
      const p = this.projectStore.add(withSuggestedSensitive(config));
      this.publishProjects();
      // Locked from the start: the other sessions take its folders' denial (issue #109).
      if (isLocked(p.config)) this.relaunchChanged();
      return this.projectInfo(p);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  /** New settings for a project. Running sessions keep theirs; new and resumed ones get the new ones. */
  updateProject(name: string, config: ProjectConfig): ProjectInfo {
    this.checkSettings(name, config);
    try {
      const p = this.projectStore.update(name, config);
      this.publishProjects();
      // Locked, unlocked or a locked project's folders changed: sessions whose launch settings that changes restart (issue #109).
      this.relaunchChanged();
      return this.projectInfo(p);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  /**
   * A project's new name, from its settings in the open page (issue #116; the server asks for the page's
   * key, and no manager tool calls this), with the page's other settings when given. Its sessions keep running: they read their project from the
   * database, so a running one is not restarted. Its folder stays where it is.
   */
  renameProject(name: string, to: unknown, settings?: ProjectConfig): ProjectInfo {
    if (typeof to !== 'string') throw new UserError('Send the new name.');
    // Settings that would be refused are refused before the rename writes anything (review-116 round 2).
    if (settings) this.checkSettings(name, settings);
    let p;
    try {
      p = this.projectStore.rename(name, to.trim());
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    // The settings saved with it, as one change (review-116 m1). Checked above, so this only fails on
    // something unforeseen, and then the old name comes back.
    if (settings) {
      try {
        this.updateProject(p.config.name, settings);
      } catch (e) {
        if (p.config.name !== name) this.projectStore.rename(p.config.name, name);
        throw e;
      }
    }
    this.boards?.refresh();
    this.publishProjects();
    for (const s of this.sessions()) if (s.project === p.config.name) this.publish({ type: 'session', session: s });
    return this.projectInfo(this.projectStore.get(p.config.name)!);
  }

  /** What updateProject refuses, checked without writing anything, so a rename can check first (review-116 round 2). */
  private checkSettings(name: string, config: ProjectConfig): void {
    const current = this.projectStore.get(name);
    if (current) this.checkAccount({ ...config, runner: current.config.runner } as ProjectConfig);
    this.checkProfiles(config);
    this.checkWorkflow(config, current?.config);
    if (current) {
      const where = current.config.runner === 'local'
        ? { runner: 'local' as const, path: current.config.path }
        : { runner: 'docker' as const, container: current.config.container, pathInContainer: current.config.pathInContainer, user: current.config.user };
      this.checkLockdownOf({ ...config, ...where, name });
    }
  }

  /** A project's name colours (issue #83), set from its manager's ⚙ menu; only palette colours. */
  setProjectColours(name: string, colours: unknown): ProjectInfo {
    try {
      const p = this.projectStore.setColours(name, colours);
      this.publishProjects();
      return this.projectInfo(p);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  /** The projects' sidebar order (issue #88), dragged in the page: these first, in this order. */
  setProjectOrder(names: unknown): ProjectInfo[] {
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) throw new UserError('The order must be a list of project names.');
    try {
      this.projectStore.setOrder(names);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    this.publishProjects();
    return this.projects();
  }

  /**
   * Sessions dragged into a new order in the sidebar (issue #88): siblings in one project, never its
   * manager, which stays first. Which rows are siblings is the page's to keep; moving a session to
   * another project is out of scope, so a list spanning projects is refused.
   */
  setSessionOrder(ids: unknown): void {
    if (!Array.isArray(ids) || !ids.length || !ids.every((n) => typeof n === 'string')) throw new UserError('The order must be a list of session ids.');
    if (new Set(ids).size !== ids.length) throw new UserError('A session is named twice in the order.');
    const sessions = ids.map((id) => this.store.getSession(id));
    if (sessions.some((s) => !s)) throw new UserError('No such session.');
    const project = sessions[0]!.project;
    if (sessions.some((s) => s!.project !== project)) throw new UserError('Sessions can only be ordered within their own project.');
    if (sessions.some((s) => s!.id === this.projectStore.get(project)?.managerId)) throw new UserError("A project's manager stays first; it can't be moved.");
    this.store.setSessionOrder(ids);
    for (const id of ids) this.publish({ type: 'session', session: this.live.get(id)?.info ?? this.store.getSession(id)! });
  }

  /** Takes a project off the list and stops its sessions. Its history stays; its files are never touched. */
  async removeProject(name: string): Promise<void> {
    this.project(name);
    const running = [...this.live.values()].filter((s) => s.info.project === name && s.info.status !== 'ended');
    await Promise.all(running.map((s) => s.stop(`The project "${name}" was removed.`).catch(() => {})));
    for (const s of running) this.live.delete(s.id);
    this.projectStore.remove(name);
    this.boards?.refresh();
    this.publishProjects();
    this.dispatch();
    this.relaunchChanged();
  }

  /**
   * A message to a project's manager: starts the manager the first time, resumes it if it ended,
   * otherwise sends. A project has exactly one manager (decided 2026-10-11).
   */
  /** The linked computers managers may reach (#245); null: none (no public name, or no end to end). */
  setLinked(linked: LinkedPort | null): void {
    this.linked = linked;
  }

  /** Settings' page-only actions, for managers' tools (issue #263). */
  setSettings(settings: SettingsPort | null): void {
    this.settings = settings;
  }

  // What a linked computer's managers get of this one (#245, /link/*): the computer is the one its key names.
  linkManagers(): string {
    return this.management.managersForComputer();
  }

  linkProjects(): string {
    return this.management.projectsForComputer();
  }

  linkMessage(link: { id: string; name: string }, m: LinkedMessage): string {
    return this.management.fromComputer(link, m);
  }

  async messageManager(projectName: string, text: string, here = false): Promise<SessionInfo> {
    if (!text.trim()) throw new UserError('The message is empty.');
    const manager = this.reachableManager(projectName);
    if (!manager) return this.start(projectName, text, { role: 'manager', here });
    await this.send(manager.id, text, here);
    return this.live.get(manager.id)?.info ?? this.store.getSession(manager.id)!;
  }

  /**
   * The project's manager for another manager's start_manager (issue #37): started with no message
   * when it has none that can be reached; the message then goes to its inbox, marked as the sender's.
   */
  async ensureManager(projectName: string): Promise<string> {
    return this.reachableManager(projectName)?.id ?? (await this.start(projectName, undefined, { role: 'manager' })).id;
  }

  /** The project's manager, unless it has none or it never got going (then it is started afresh). */
  private reachableManager(projectName: string): SessionInfo | undefined {
    const project = this.projectStore.get(projectName);
    if (!project) throw new UserError(`There is no project named "${projectName}".`);
    const manager = project.managerId ? this.store.getSession(project.managerId) : undefined;
    if (!manager) return undefined;
    if ((!this.live.has(manager.id) || manager.status === 'ended') && !manager.claudeSessionId) return undefined;
    return manager;
  }

  sessions(): SessionInfo[] {
    return this.store.listSessions().map((s) => {
      const live = this.live.get(s.id);
      if (live) return live.info;
      const tickets = this.projectStore.get(s.project)?.config.tickets;
      return { ...s, tickets: findTickets([s.title, s.branch, s.pr?.title], tickets) };
    });
  }

  private project(name: string): ProjectConfig {
    const project = this.projectStore.get(name)?.config;
    if (!project) throw new UserError(`There is no project named "${name}".`);
    return project;
  }

  /** The settings a session runs with: its project's, or a chat's (issue #211). */
  private configOf(info: SessionInfo): ProjectConfig {
    return info.project === CHATS ? this.chatConfig(info.workDir ?? this.chats().folder) : this.project(info.project);
  }

  /** configOf, or null for a session whose project is gone. */
  private configOrNull(info: SessionInfo): ProjectConfig | null {
    return info.project === CHATS ? this.chatConfig(info.workDir ?? this.chats().folder) : this.projectStore.get(info.project)?.config ?? null;
  }

  // --- Skills (#300) ---------------------------------------------------------------------------------

  // --- Macros (issue #410) -----------------------------------------------------------------------

  /** The macros, in their order; a stored list this version can't read: none. */
  macros(): Macro[] {
    const raw = this.store.getMeta(MACROS_KEY);
    if (!raw) return [];
    try {
      const r = MacroList.safeParse(JSON.parse(raw));
      return r.success && !macrosProblem(r.data) ? r.data : [];
    } catch {
      return [];
    }
  }

  /** The whole list from Settings, replacing the one kept; every page hears it. */
  setMacros(body: unknown): Macro[] {
    const r = MacroList.safeParse((body as { macros?: unknown } | null)?.macros);
    if (!r.success) throw new UserError(`These macros can't be kept: ${r.error.issues[0]?.message ?? 'not valid'}.`);
    const list = r.data.map((m) => ({ ...m, name: m.name.trim() }));
    const problem = macrosProblem(list);
    if (problem) throw new UserError(problem);
    this.store.setMeta(MACROS_KEY, JSON.stringify(list));
    this.publish({ type: 'macros', macros: list });
    return list;
  }

  /** The defaults for every project's manager and sessions, from Settings; a stored value a later version can't read: none. */
  skillDefaults(): SkillChoices {
    const raw = this.store.getMeta(SKILL_DEFAULTS_KEY);
    if (!raw) return {};
    try {
      const r = SkillChoicesSetting.safeParse(JSON.parse(raw));
      return r.success ? r.data : {};
    } catch {
      return {};
    }
  }

  /** New defaults from Settings; new and resumed sessions get them. */
  setSkillDefaults(body: unknown): SkillChoices {
    const r = SkillChoicesSetting.safeParse(body);
    if (!r.success) throw new UserError(`These skill choices can't be used: ${r.error.issues[0]?.message ?? 'not valid'}.`);
    this.store.setMeta(SKILL_DEFAULTS_KEY, JSON.stringify(r.data));
    return r.data;
  }

  /**
   * The user's own skills as a project's sessions see them (its account's login folder, or inside its container),
   * or this computer's own login's without a project; with the plugins there, whose skills go with the plugin.
   */
  async skillList(projectName: string | undefined): Promise<SkillListView> {
    let runner: Runner;
    if (projectName) {
      const project = this.projectStore.get(projectName)?.config;
      if (!project) throw new UserError(`There is no project named "${projectName}".`);
      runner = project.runner === 'local' ? new LocalRunner(project, null, this.config.claudeExecutable) : new DockerRunner(project, 'skills');
      // An account is only the sign-in (#342): its skills are those of the Claude Code folder every session has.
    } else {
      runner = new LocalRunner({ name: 'skills', runner: 'local', path: os.homedir() } as LocalProjectConfig, null, this.config.claudeExecutable);
    }
    const [files, texts] = await Promise.all([runner.skillFiles(null), runner.pluginSettingsTexts(null)]);
    return { skills: skillsFromFiles(files), plugins: pluginIdsIn(texts), defaults: this.skillDefaults() };
  }

  // --- Chats (issue #211) ---------------------------------------------------------------------------

  /** The chats' own sensitive list as saved in Settings; never saved: the suggestions (sensitive-always). */
  private chatsSensitive(): ChatsInfo['sensitive'] {
    const raw = this.store.getMeta(CHATS_SENSITIVE_KEY);
    return raw ? JSON.parse(raw) as ChatsInfo['sensitive'] : withSuggestions({ commandPatterns: [], pathPatterns: [], mcpTools: [] });
  }

  /**
   * Suggestions added to the code later (LATER_SUGGESTIONS, #213) reach a chats list saved before them, each batch
   * once, as they reach projects; one deleted afterwards stays deleted. A list never saved has them already.
   */
  private addChatsSuggestionsOnce(): void {
    for (const batch of LATER_SUGGESTIONS) {
      const key = `chats-${batch.key}`;
      if (this.store.getMeta(key)) continue;
      const raw = this.store.getMeta(CHATS_SENSITIVE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as ChatsInfo['sensitive'];
        this.store.setMeta(CHATS_SENSITIVE_KEY, JSON.stringify({ ...s, commandPatterns: [...s.commandPatterns, ...batch.commandPatterns.filter((p) => !s.commandPatterns.includes(p))] }));
      }
      this.store.setMeta(key, new Date().toISOString());
    }
  }

  chats(): ChatsInfo {
    const c = this.config.chats;
    return {
      folder: path.resolve(c.folder ?? os.homedir()), permissionMode: c.permissionMode, sensitive: this.chatsSensitive(),
      fromConfig: { commandPatterns: c.sensitive.commandPatterns, pathPatterns: c.sensitive.pathPatterns, mcpTools: c.sensitive.mcpTools },
      colour: this.chatsColour(),
    };
  }

  /** A colour a later version may not know reads as none, as for a project's (readColours). */
  private chatsColour(): ChatsInfo['colour'] {
    const raw = this.store.getMeta(CHATS_COLOUR_KEY);
    return isNameColour(raw) ? raw : null;
  }

  /** The chats' name colour from the Chats ⚙ (issue #222); only palette colours, as for a project's (#83). */
  setChatsColour(colour: unknown): ChatsInfo {
    let parsed: ChatsInfo['colour'];
    try {
      parsed = parseNameColour(colour);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    this.store.setMeta(CHATS_COLOUR_KEY, parsed ?? 'none');
    const info = this.chats();
    this.publish({ type: 'chats', chats: info });
    return info;
  }

  /** Whether these chats settings take a pattern out of the list, which only the open page may do (issue #107). */
  chatsLoosen(body: Record<string, unknown>): boolean {
    return loosensGate({ sensitive: this.chatsSensitive() } as ProjectConfig, { sensitive: body.sensitive });
  }

  /** The chats' sensitive list from Settings; new and resumed chats get it. */
  updateChats(body: Record<string, unknown>): ChatsInfo {
    const sent = (typeof body.sensitive === 'object' && body.sensitive !== null ? body.sensitive : {}) as Record<string, unknown>;
    const list = (key: 'commandPatterns' | 'pathPatterns' | 'mcpTools', had: string[]) => {
      const v = sent[key] ?? had;
      if (!Array.isArray(v) || !v.every((p) => typeof p === 'string')) throw new UserError(`sensitive.${key} must be a list of patterns.`);
      return [...new Set(v.map((p) => p.trim()).filter(Boolean))];
    };
    const had = this.chatsSensitive();
    const sensitive = { commandPatterns: list('commandPatterns', had.commandPatterns), pathPatterns: list('pathPatterns', had.pathPatterns), mcpTools: list('mcpTools', had.mcpTools) };
    try {
      validateSensitive(sensitive);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    this.store.setMeta(CHATS_SENSITIVE_KEY, JSON.stringify(sensitive));
    const info = this.chats();
    this.publish({ type: 'chats', chats: info });
    return info;
  }

  /**
   * What a chat runs with, as a local project in its own folder: no workflow, grant or board; the account
   * chosen for chats (issue #283), read again at every start and resume; the config's chats patterns and the
   * chats list from Settings (Ledung adds the global ones, as for a project).
   */
  private chatConfig(workDir: string): LocalProjectConfig {
    const own = this.chatsSensitive();
    const seeds = this.config.chats.sensitive;
    const account = this.accountChoices().chats;
    return {
      name: CHATS, runner: 'local', path: workDir, workflow: { use: false }, permissionMode: this.config.chats.permissionMode,
      ...(account ? { account } : {}),
      sensitive: {
        commandPatterns: [...seeds.commandPatterns, ...own.commandPatterns],
        pathPatterns: [...seeds.pathPatterns, ...own.pathPatterns],
        mcpTools: [...seeds.mcpTools, ...own.mcpTools],
      },
    } as LocalProjectConfig;
  }

  /**
   * A chat's folder as a real path: any folder the page's folder browser may show (Martin, question #293),
   * relative ones from the chats' default folder, never inside a locked project (issue #109). Checked on
   * start and on every resume, so a link changed or a project locked since can't move it.
   */
  private chatFolder(wanted: string | undefined): string {
    const given = path.resolve(this.chats().folder, wanted?.trim() || '.');
    let real: string;
    try {
      real = fs.realpathSync(given);
    } catch {
      throw new UserError(`The folder ${given} does not exist.`);
    }
    if (!fs.statSync(real).isDirectory()) throw new UserError(`${given} is not a folder.`);
    if (!isInside(real, this.allowedFolders())) {
      throw new UserError(`${given} is outside the folders Ledung may use; a chat can start in any folder the folder browser shows (${defaultRoots(this.config.browseRoots).join(', ')}).`);
    }
    for (const p of this.projectStore.list()) {
      if (!isLocked(p.config)) continue;
      const hit = overlapProblem(real, p.config.name, projectFolders(p.config));
      if (hit) throw new UserError(hit);
    }
    return real;
  }

  /**
   * Starts a chat (issue #211): a session with no project, manager or workflow, in a folder of the user's
   * choosing; its questions and prompts go to the user. Defaults (Martin 18:19, question #297): Auto, the
   * computer's own login, Claude Code's own model, the full profile; Remote Control is for managers only.
   */
  async startChat(opts: { folder?: string; model?: string; profile?: string; permissionMode?: PermissionMode; text?: string } = {}): Promise<SessionInfo> {
    if (opts.permissionMode !== undefined && !PERMISSION_MODES.includes(opts.permissionMode)) throw new UserError(`Unknown permission mode "${opts.permissionMode}".`);
    const workDir = this.chatFolder(opts.folder);
    let profile: string;
    try {
      // The full profile unless one is chosen: the config's defaults are for project sessions.
      profile = chooseProfile(opts.profile, 'session', undefined, {}, this.profilesFor(this.chatConfig(workDir)).profiles);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const project = this.chatConfig(workDir);
    if (project.account) {
      try {
        this.accounts.envFor(project.account);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
    }
    const info = this.store.createSession({
      id: randomUUID(), project: CHATS, runner: 'local', role: 'session', title: 'New chat', parentId: null,
      permissionMode: opts.permissionMode ?? project.permissionMode ?? 'auto', requestedModel: opts.model?.trim() || null, profile, workDir,
    });
    if (project.account) this.store.updateSession(info.id, { account: project.account });
    this.publish({ type: 'session', session: info });
    const session = new Session({ info, ...this.sessionOptions(project, info) });
    this.noteLaunch(project, info);
    this.live.set(info.id, session);
    await session.start();
    if (opts.text?.trim() && this.store.getSession(info.id)?.status !== 'ended') session.send(opts.text);
    return session.info;
  }

  private runnerFor(project: ProjectConfig, info: SessionInfo): Runner {
    return project.runner === 'local' ? new LocalRunner(project, info.workDir, this.config.claudeExecutable) : new DockerRunner(project, info.id);
  }

  /**
   * The session's own folder as start_session asks for it: checked against the project folder and its
   * extra folders, as a real path; null for the project folder (decision of 2026-10-14). Only local
   * projects: a container's folders would need their own checks inside the container.
   */
  private workFolder(project: ProjectConfig, wanted: string | undefined): string | null {
    if (wanted === undefined || !wanted.trim()) return null;
    if (project.runner !== 'local') throw new UserError(`A working folder (cwd) is not available for container projects such as "${project.name}"; the session runs in the project folder.`);
    let folder: string | null;
    try {
      folder = resolveWorkFolder(project.path, project.extraFolders ?? [], wanted);
    } catch (e) {
      throw e instanceof WorkFolderError ? new UserError(e.message) : e;
    }
    // A project folder above a locked project's folder: the locked folder itself is not its to work in (issue #109).
    for (const other of this.projectStore.list()) {
      if (folder === null || other.config.name === project.name || !isLocked(other.config)) continue;
      const hit = overlapProblem(folder, other.config.name, projectFolders(other.config));
      if (hit) throw new UserError(hit);
    }
    return folder;
  }

  /**
   * A session's folder on a new start or resume: checked again, so a folder no longer under the project's
   * extra folders (or a link changed since) can't be used. A reattached session already runs where it runs.
   */
  private checkWorkDir(project: ProjectConfig, info: SessionInfo): void {
    if (!info.workDir) return;
    const again = info.project === CHATS ? this.chatFolder(info.workDir) : this.workFolder(project, info.workDir);
    if (again === null || path.relative(again, info.workDir) !== '') {
      throw new UserError(`The session's folder ${info.workDir} no longer leads to the same folder; start a new session.`);
    }
  }

  /** Starts a session, or a manager (role), optionally under a manager (parentId). */
  async start(
    projectName: string,
    firstMessage?: string,
    opts: { role?: SessionRole; parentId?: string; title?: string; permissionMode?: PermissionMode; model?: string; profile?: string; cwd?: string; here?: boolean } = {},
  ): Promise<SessionInfo> {
    const project = this.project(projectName);
    // Managers work in the project folder, so the project keeps one place for its manager.
    if (opts.cwd !== undefined && opts.role === 'manager') throw new UserError('A manager always works in the project folder.');
    const workDir = this.workFolder(project, opts.cwd);
    if (project.account) {
      try {
        this.accounts.envFor(project.account);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
    }
    const role = opts.role ?? 'session';
    let profile: string;
    const profiles = this.profilesFor(project);
    try {
      profile = chooseProfile(opts.profile, role, project.profiles, profiles.defaults, profiles.profiles);
    } catch (e) {
      throw new UserError(withWarning((e as Error).message, profiles));
    }
    // A manager that never got going is replaced; a name the user gave it carries over (issue #223).
    let managerName: string | undefined;
    if (role === 'manager') {
      const current = this.projectStore.get(project.name)?.managerId;
      const existing = current ? this.store.getSession(current) : undefined;
      if (existing && existing.claudeSessionId) {
        throw new UserError(`The project "${project.name}" already has a manager. Open it, or write to it to start it again.`);
      }
      managerName = existing?.title;
    }
    const info = this.store.createSession({
      id: randomUUID(), project: project.name, runner: project.runner, role,
      title: opts.title?.trim() || managerName || (role === 'manager' ? `Manager: ${project.name}` : 'New session'),
      parentId: opts.parentId ?? null, permissionMode: opts.permissionMode ?? project.permissionMode ?? 'default',
      requestedModel: opts.model?.trim() || null, profile, workDir,
    });
    if (project.account) this.store.updateSession(info.id, { account: project.account });
    this.publish({ type: 'session', session: info });
    if (role === 'manager') {
      this.projectStore.setManager(project.name, info.id);
      this.publishProjects();
    }
    const session = new Session({ info, ...this.sessionOptions(project, info) });
    this.noteLaunch(project, info);
    this.live.set(info.id, session);
    await session.start();
    if (firstMessage?.trim() && this.store.getSession(info.id)?.status !== 'ended') {
      if (opts.parentId) {
        // From a manager: delivered as context, so it never passes for the user's words (step 4).
        // Only while it is still "New session": a name the user gave it during start-up stays (#223, review of PR #224).
        if (!opts.title && this.store.getSession(info.id)?.title === 'New session') this.store.updateSession(info.id, { title: firstMessage.replace(/\s+/g, ' ').trim().slice(0, 80) });
        const manager = this.store.getSession(opts.parentId);
        this.store.addInbox(info.id, `manager:${opts.parentId}`, `Your task, from your manager "${manager?.title ?? 'manager'}":\n\n${firstMessage}`);
        session.deliver();
      } else {
        session.send(firstMessage, opts.here === true);
      }
    }
    return session.info;
  }

  /**
   * Starts an ended session again from its Claude Code session id. History stays on the same Ledung
   * session. One resume at a time per session: a second call gets the one under way.
   */
  resume(id: string): Promise<SessionInfo> {
    const under = this.resuming.get(id);
    if (under) return under;
    const resuming = this.startResumed(id).finally(() => this.resuming.delete(id));
    this.resuming.set(id, resuming);
    return resuming;
  }

  private async startResumed(id: string): Promise<SessionInfo> {
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    if (this.live.has(id) && info.status !== 'ended') throw new UserError('The session is still running.');
    if (!info.claudeSessionId) throw new UserError('This session never got far enough to be resumed.');
    const project = this.configOf(info);
    // In the folder it started in: Claude Code finds a conversation by its working folder.
    this.checkWorkDir(project, info);
    // A stopped session's host stays on its pipe for a moment after Claude Code exits; a new host must
    // not start (nor Ledung connect to the old one) until it is gone. Found when a message came 1 s
    // after a stop (idle stop live test).
    const pipe = pipePath(id);
    for (let i = 0; i < 50 && (await hostReachable(pipe, 300)); i++) await new Promise((r) => setTimeout(r, 100));
    const { update, events } = resumedState(info);
    for (const text of events) this.publish({ type: 'message', message: this.store.addMessage(id, 'event', { text }) });
    this.store.updateSession(id, update);
    const options = this.sessionOptions(project, info);
    this.store.updateSession(id, { account: project.account ?? null });
    const session = new Session({ info: this.store.getSession(id)!, ...options, resume: info.claudeSessionId });
    this.noteLaunch(project, info);
    this.live.set(id, session);
    this.publish({ type: 'session', session: session.info });
    await session.start();
    // Hand over what waited for it (answers, messages). Claude Code no longer sends the empty result
    // on resume that used to trigger this (spike finding 7; idle stop live test).
    session.deliver();
    return session.info;
  }

  /**
   * Takes an ended session out of the sidebar; nothing about it is deleted. Simon may archive any ended
   * session, a manager only its own (checked in Management). A project's manager is never archived.
   */
  archive(id: string, by = this.config.userName): SessionInfo {
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    if (info.role === 'manager') throw new UserError("A project's manager can't be archived.");
    if (info.status !== 'ended') throw new UserError('Only an ended session can be archived. Stop it first.');
    if (info.archivedAt) return info;
    this.setArchived(id, Date.now(), `Archived by ${by}.`);
    return this.store.getSession(id)!;
  }

  unarchive(id: string, by = this.config.userName): SessionInfo {
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    if (info.archivedAt) this.setArchived(id, null, `Unarchived by ${by}.`);
    return this.store.getSession(id)!;
  }

  private setArchived(id: string, at: number | null, event: string): void {
    this.store.updateSession(id, { archivedAt: at });
    this.publish({ type: 'message', message: this.store.addMessage(id, 'event', { text: event }) });
    this.publish({ type: 'session', session: this.live.get(id)?.info ?? this.store.getSession(id)! });
  }

  /**
   * A file from the session's folder (its project folder, or its own), read-only (the page's file viewer). The
   * Files pane (issue #225) names which of its folders with `folder`; left out, links resolve as in the chat.
   */
  readFile(sessionId: string, link: string, folder?: PaneFolderKey): ProjectFile {
    return this.readFrom(sessionId, link, readProjectFile, folder);
  }

  /** A PNG or JPEG from the session's project folder, read-only, for the file viewer. */
  readImage(sessionId: string, link: string, folder?: PaneFolderKey): ProjectImage {
    return this.readFrom(sessionId, link, readProjectImage, folder);
  }

  // --- The Files pane (issue #225, a test feature) --------------------------------------------------

  /** A session, its local project and the folder it works in, or why the pane has nothing to show. */
  private paneSession(sessionId: string): { info: SessionInfo; project: LocalProjectConfig } {
    const info = this.store.getSession(sessionId);
    if (!info) throw new UserError('No such session.');
    const project = this.configOf(info);
    if (project.runner !== 'local') throw new UserError('Showing files from a container project is not available yet.');
    return { info, project };
  }

  /**
   * Where the session works now: the worktree it entered itself with EnterWorktree, when that is still a
   * folder the project allows (start_session's rules); else its own folder or the project folder. Ledung
   * starts a worker in the project folder and the worker moves itself, so only the session knows (#225).
   */
  private sessionFolder(info: SessionInfo, project: LocalProjectConfig): string {
    const start = info.workDir ?? project.path;
    if (info.project === CHATS) return start;
    const call = this.store.lastToolCall(info.id, ['EnterWorktree', 'ExitWorktree']);
    if (!call || call.name !== 'EnterWorktree' || call.isError) return start;
    const given = typeof call.input.path === 'string' && call.input.path ? path.resolve(start, call.input.path)
      : /worktree at (.+?) on branch /.exec(call.result ?? '')?.[1]
        ?? (typeof call.input.name === 'string' ? path.join(start, '.claude', 'worktrees', call.input.name) : null);
    if (!given) return start;
    try {
      return resolveWorkFolder(project.path, project.extraFolders ?? [], given) ?? project.path;
    } catch {
      return start;
    }
  }

  /** The folders a chat's file viewer and tree never show from (Martin, question #317). */
  private settingsFolders(): string[] {
    return [path.join(os.homedir(), 'AppData'), path.join(os.homedir(), 'Library'), userDataDir()];
  }

  /** The folders the Files pane offers: where the session works, and the project folder when that is another one. */
  paneFolders(sessionId: string): PaneFolders {
    const { info, project } = this.paneSession(sessionId);
    const own = this.sessionFolder(info, project);
    const folders: PaneFolders['folders'] = [{ key: 'session', path: own, label: info.project === CHATS ? "This chat's folder" : "This session's folder" }];
    const same = (a: string, b: string) => { try { return path.relative(fs.realpathSync(a), fs.realpathSync(b)) === ''; } catch { return a === b; } };
    if (info.project !== CHATS && !same(own, project.path)) {
      folders[0]!.label = "This session's worktree";
      folders.push({ key: 'project', path: project.path, label: 'Project folder' });
    }
    return { folders };
  }

  private paneRoot(sessionId: string, folder: PaneFolderKey | undefined): { info: SessionInfo; root: string } {
    const { info, project } = this.paneSession(sessionId);
    if (folder === 'project' && info.project !== CHATS) return { info, root: project.path };
    return { info, root: folder === 'session' ? this.sessionFolder(info, project) : info.workDir ?? project.path };
  }

  /** One folder of the tree, with the viewer's rules (src/sessions/tree.ts). */
  async listFolder(sessionId: string, folder: PaneFolderKey, rel: string): Promise<TreeListing> {
    const { info, root } = this.paneRoot(sessionId, folder);
    try {
      // A chat's folder can be anywhere under the browse roots, so it gets the viewer's chat rules (#211, question
      // #317); a project's own folder may itself sit under AppData, as the viewer allows.
      const chat = info.project === CHATS;
      const refused = [...(chat ? this.settingsFolders() : []), ...this.lockedFoldersBesides(info.project)];
      return await listTree(root, rel, { refused, hiddenFrom: chat ? this.allowedFolders() : [] });
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
  }

  /** What the session changed, in the folder it works in (src/sessions/changes.ts). */
  async changes(sessionId: string): Promise<SessionChanges> {
    const { info, project } = this.paneSession(sessionId);
    const own = this.sessionFolder(info, project);
    // A chat may run in the home folder: its diff drops what its viewer would not show.
    const hidden = info.project === CHATS ? (p: string) => p.split('/').some((s) => s.startsWith('.') || s.startsWith('$')) : undefined;
    return sessionChanges(own, { hidden });
  }

  /** Who line comments on this session's changes reach: the open review's asker, else its manager, else itself. */
  lineCommentsTarget(sessionId: string): { review: QuestionInfo | null; to: string } {
    const info = this.store.getSession(sessionId);
    if (!info) throw new UserError('No such session.');
    const review = openReviewFor(sessionId, this.store.listQuestions());
    return { review, to: review?.sessionId ?? info.parentId ?? sessionId };
  }

  /**
   * Sends line comments as the user's own words: with an open review, as its answer (Changes needed with them,
   * or Accept with them as notes); without one, as one message to the session's manager (to the session itself
   * when it has none). The manager hands them on as a review round (issue #225, decision of 2026-10-18).
   */
  async sendLineComments(sessionId: string, body: { verdict?: unknown; text?: unknown; comments?: unknown }): Promise<{ sentTo: string; reviewId: number | null }> {
    const checked = checkLineComments(body.comments);
    if ('problem' in checked) throw new UserError(checked.problem);
    const text = typeof body.text === 'string' ? body.text : '';
    const info = this.store.getSession(sessionId)!;
    const { review, to } = this.lineCommentsTarget(sessionId);
    // The session's name; each comment's commit says which state of its branch it was written on.
    const list = formatLineComments(checked.comments, info.title);
    if (review) {
      if (body.verdict !== 'accept' && body.verdict !== 'changes') throw new UserError('Say whether the comments go with Accept or Changes needed.');
      await this.answerQuestion(review.id, reviewAnswerWithComments(body.verdict, text, list));
      return { sentTo: to, reviewId: review.id };
    }
    await this.send(to, lineCommentsMessage(this.config.userName, text, list, to === sessionId ? null : info.title));
    return { sentTo: to, reviewId: null };
  }

  private readFrom<T>(sessionId: string, link: string, read: (root: string, link: string) => T, folder?: PaneFolderKey): T {
    const { info, root } = this.paneRoot(sessionId, folder);
    try {
      if (info.project === CHATS) {
        // Also Windows' AppData, macOS's Library and Ledung's own data folder, wherever it is (Martin, question #317).
        const hidden = hiddenProblem(root, link, this.allowedFolders(), this.settingsFolders());
        if (hidden) throw new UserError(hidden);
      }
      // Through the Files pane, a locked project's folder stays shut as in its tree (issue #225).
      if (folder && this.lockedFoldersBesides(info.project).some((f) => within(f, path.resolve(root, decodeURIComponent(link.replace(/[?#].*$/, '')))))) {
        throw new UserError("That file is in a locked project's folder.");
      }
      // The session's own folder when it has one (decision of 2026-10-14): links in its chat are relative to it.
      return read(root, link);
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
  }

  private liveSession(id: string): Session {
    const session = this.live.get(id);
    if (!session || session.info.status === 'ended') throw new UserError('The session is not running. Resume it first.');
    return session;
  }

  /**
   * Simon's message; an ended session is resumed first and gets it once it is up. `here`: typed on this computer,
   * not through the public name, so it can name a manager's Settings action (issue #263).
   */
  async send(id: string, text: string, here = false): Promise<void> {
    if (!text.trim()) throw new UserError('The message is empty.');
    await this.resumeIfEnded(id);
    this.liveSession(id).send(text, here);
  }

  /** Resumes the session if it has ended (or isn't live); a resume already under way is waited for. */
  async resumeIfEnded(id: string): Promise<void> {
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    if (!this.resuming.has(id) && this.live.has(id) && info.status !== 'ended') return;
    const after = await this.resume(id);
    if (after.status === 'ended') throw new UserError(`The session could not be resumed: ${after.endReason ?? 'unknown reason'}`);
  }

  async setPermissionMode(id: string, mode: string): Promise<void> {
    if (!PERMISSION_MODES.includes(mode as PermissionMode)) throw new UserError(`Unknown permission mode "${mode}".`);
    try {
      await this.liveSession(id).setPermissionMode(mode as PermissionMode, 'user');
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(`Could not change the permission mode: ${(e as Error).message}`);
    }
  }

  interrupt(id: string): Promise<void> {
    return this.liveSession(id).interrupt();
  }

  // --- "!" commands from the message box (issue #212) ------------------------------------------------
  // People only: the server's route is the one way in, and no manager or session tool calls these.

  /** Why "!" is refused in this session (lockdown, decision 5 of #212), or null. */
  shellRefusal(id: string): string | null {
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    const project = this.configOf(info);
    const folder = info.workDir ?? (project.runner === 'local' ? project.path : project.pathInContainer);
    const others = this.projectStore.list().filter((p) => isLocked(p.config)).map((p) => ({ name: p.config.name, config: p.config }));
    return bangRefusal({ name: project.name, runner: project.runner, lockdown: lockdownOf(project) }, folder, others);
  }

  /** The shell a "!" command runs in on this computer (decision 6 of #212), for the message box's hint. */
  bangShellName(): string {
    return process.platform !== 'win32' ? 'bash' : this.config.windowsShell === 'powershell' ? 'PowerShell' : 'Git Bash';
  }

  /** The sensitive rule a "!" command matches in this session, for the page's ask (decision 3 of #212); null: none. */
  shellCheck(id: string, command: string): { rule: string | null; refused: string | null } {
    const refused = this.shellRefusal(id);
    return { rule: refused ? null : this.shellSensitive(id, command), refused };
  }

  /** The session's sensitive lists (the config's and its project's, as it runs with), against a "!" command. */
  private shellSensitive(id: string, command: string): string | null {
    const project = this.configOf(this.store.getSession(id)!);
    const rules = {
      commandPatterns: [...this.config.sensitive.commandPatterns, ...project.sensitive.commandPatterns],
      pathPatterns: [], mcpTools: [],
    };
    // Matched as the shell it runs in: PowerShell's commands whole, line by line (#213).
    const tool = project.runner === 'local' && this.bangShellName() === 'PowerShell' ? 'PowerShell' : 'Bash';
    return matchSensitive(tool, { command }, rules)?.rule ?? null;
  }

  /**
   * Runs Simon's "!" command in the session (an ended one is resumed first, as for a message). A command
   * matching the sensitive list runs only once the page has asked (`confirmed`). Answers once it has started;
   * the block and its output follow in the history.
   */
  async runShell(id: string, command: string, confirmed: boolean): Promise<void> {
    if (!command.trim()) throw new UserError('Write a command after the "!".');
    const refused = this.shellRefusal(id);
    if (refused) throw new UserError(refused);
    // Before a resume, so an unconfirmed match starts nothing.
    const rule = this.shellSensitive(id, command);
    if (rule && !confirmed) throw new UserError(`This matches ${rule}; confirm it in the page to run it.`);
    await this.resumeIfEnded(id);
    const session = this.liveSession(id);
    let started: Promise<void>;
    try {
      started = session.runShell(command, this.config.windowsShell);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    started.catch((e) => console.error(`"!" command in ${id}: ${(e as Error).message}`));
  }

  /** Stop on a running "!" command. */
  async stopShell(id: string): Promise<void> {
    if (!(await this.liveSession(id).stopShell('stopped'))) throw new UserError('No "!" command is running in this session.');
  }

  /** Ends every running "!" command before a restart: they don't survive it (issue #212, out of scope). */
  async endShells(): Promise<void> {
    await Promise.all([...this.live.values()].map((s) => s.stopShell('restart').catch(() => false)));
  }

  /** A running session's MCP servers (issue #118); Claude Code's refusal comes back as the reason. */
  async mcpServers(id: string): Promise<McpServerInfo[]> {
    try {
      return await this.liveSession(id).mcpServers();
    } catch (e) {
      throw e instanceof McpError ? new UserError(e.message) : e;
    }
  }

  /** Restarts one MCP server in a running session; `by` is recorded in its history. */
  async reconnectMcp(id: string, name: string, by = 'user'): Promise<McpServerInfo[]> {
    if (!name.trim()) throw new UserError('Say which MCP server to reconnect.');
    try {
      return await this.liveSession(id).reconnectMcp(name, by);
    } catch (e) {
      throw e instanceof McpError ? new UserError(e.message) : e;
    }
  }

  /** From the page unless a reason says otherwise: then it is the person using Ledung, by name. */
  async stop(id: string, reason = `Stopped by ${this.config.userName}.`): Promise<void> {
    await this.liveSession(id).stop(reason);
    this.live.delete(id);
    this.dispatch();
  }

  decide(permissionId: string, decision: PermissionDecision): void {
    const permission = this.store.getPermission(permissionId);
    if (!permission) throw new UserError('No such permission request.');
    const session = this.live.get(permission.sessionId);
    if (!session || !session.decide(permissionId, decision, 'user')) {
      throw new UserError('This request is no longer waiting for an answer.');
    }
    // A prompt that went to a manager: tell the manager Simon decided it directly.
    this.management.onUserDecidedPermission(this.store.getPermission(permissionId)!);
  }

  /**
   * After a Ledung restart: reconnects to every session whose host is still running. Hosts that are
   * gone, or belong to sessions this database doesn't know, are forgotten. Returns the attached ids.
   */
  async attachRunningHosts(): Promise<string[]> {
    const attached: string[] = [];
    for (const record of listHostRecords()) {
      const info = this.store.getSession(record.sessionId);
      if (!info || info.status === 'ended' || !(await hostReachable(record.pipe))) {
        // A host for a session we don't know can't be ours to stop; it ends itself after its grace time.
        removeHostRecord(record.sessionId);
        continue;
      }
      let project: ProjectConfig;
      try {
        project = this.configOf(info);
      } catch {
        removeHostRecord(record.sessionId);
        continue;
      }
      // Waiting requests are re-sent by the host and turn the status back to waiting.
      // A session still 'starting' has had no message yet (every turn sets 'running' as it begins), so it stays
      // as it is: turned to 'running' it showed as thinking until spoken to (issue #226).
      if (info.status === 'waiting' || info.status === 'stopping') this.store.updateSession(info.id, { status: 'running' });
      // In line before the restart: still in line; it starts when the line moves (dispatch below).
      const session = new Session({ info: this.store.getSession(info.id)!, ...this.sessionOptions(project, info, true), attachTo: record.pipe });
      this.live.set(info.id, session);
      try {
        await session.start();
      } catch (e) {
        // One host that can't be reattached is reported on its session and must not stop Ledung's start (review
        // of PR #441). Its host ends itself after its grace time, as for a session of no project above.
        this.live.delete(info.id);
        session.detach();
        const reason = `Could not reconnect after Restart Ledung: ${(e as Error).message}`;
        console.error(`${info.id}: ${reason}`);
        this.store.addMessage(info.id, 'event', { text: reason });
        this.store.updateSession(info.id, { status: 'ended', endedAt: Date.now(), endReason: reason });
        continue;
      }
      attached.push(info.id);
    }
    this.dispatch();
    // A host keeps the settings it was launched with: one launched before a lockdown change takes it now (issue #109).
    this.relaunchChanged();
    return attached;
  }

  /** Lets go of every live session without stopping them; used when Ledung restarts. */
  detachAll(): void {
    this.monitor.stop();
    this.away.stop();
    if (this.waitTimer) clearInterval(this.waitTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const session of this.live.values()) session.detach();
    this.live.clear();
  }

  /** Stops every live session; used when Ledung is closed. Sessions can be resumed afterwards. */
  async shutdown(reason = 'Ledung was shut down. Resume to continue.'): Promise<void> {
    this.monitor.stop();
    this.away.stop();
    if (this.waitTimer) clearInterval(this.waitTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    await Promise.all([...this.live.values()].map((s) => s.stop(reason).catch(() => {})));
    this.live.clear();
  }
}

/**
 * The project's model for a session of this role, used when the session asked for none and its profile's
 * settings file names none (session.ts). A manager has its own (decision of 2026-10-13); empty: the sessions'.
 * None at all: no model is passed, so Claude Code takes the one in the project's Claude settings.
 */
export function defaultModelFor(project: Pick<ProjectConfig, 'model' | 'managerModel'>, role: SessionRole): string | undefined {
  return (role === 'manager' && project.managerModel?.trim()) || project.model?.trim() || undefined;
}

/** The lockdown part of every session's launch settings while no project is locked (issue #109). */
export const NO_LOCKDOWN_KEY = JSON.stringify({ others: null, closed: null });

/** An error whose message is meant for Simon, returned to the page as is. */
export class UserError extends Error {}

function projectInfo(p: StoredProject): ProjectInfo {
  const c = p.config;
  return {
    name: c.name,
    runner: c.runner,
    where: c.runner === 'local' ? c.path : `${c.container}:${c.pathInContainer}`,
    ...(c.runner === 'local' ? { path: c.path } : { container: c.container, pathInContainer: c.pathInContainer, user: c.user }),
    account: c.account ?? null,
    model: c.model ?? null,
    managerModel: c.managerModel ?? null,
    permissionMode: c.permissionMode ?? null,
    managerGrant: c.managerGrant ?? null,
    projectToolsUnasked: c.projectToolsUnasked ?? false,
    projectSettingsTools: c.projectSettingsTools ?? false,
    publishUsageName: c.publishUsageName ?? false,
    usageRepo: c.usageRepo ?? null,
    profiles: { manager: c.profiles?.manager ?? null, session: c.profiles?.session ?? null },
    sensitive: { commandPatterns: c.sensitive.commandPatterns, pathPatterns: c.sensitive.pathPatterns, mcpTools: c.sensitive.mcpTools },
    devShipCommand: c.devShipCommand ?? null,
    tickets: c.tickets ?? null,
    questionTiers: tiersOf(c.questionTiers),
    extraFolders: c.runner === 'local' ? c.extraFolders ?? [] : [],
    workflow: c.workflow ?? null,
    managerId: p.managerId,
    createdAt: p.createdAt,
    colours: p.colours,
    lockdown: lockdownOf(c),
    skills: c.skills ?? {},
  };
}

/** The permissions.allow rules in a profile's inline settings, for Settings (question #708). */
function allowRules(settings: Record<string, unknown> | undefined): string[] {
  const allow = (settings?.permissions as { allow?: unknown } | undefined)?.allow;
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : [];
}

/** A profile's own MCP servers as Settings lists them: what each runs or reaches (review of #298). */
function mcpLines(profile: Profile): string[] {
  if (typeof profile.mcpServers !== 'object') return [];
  return Object.entries(profile.mcpServers).map(([name, s]) => `${name}: ${'url' in s ? s.url : [s.command, ...(s.args ?? [])].join(' ')}`);
}

/** A profile error with the workflow's profiles file problem after it, when that is why the profile is missing (#298). */
const withWarning = (message: string, profiles: EffectiveProfiles) => (profiles.warning ? `${message} ${profiles.warning}` : message);

/** Where a project's sessions run, for its account's login folder. */
function placeOf(project: ProjectConfig): AccountPlace {
  return project.runner === 'docker' ? 'docker' : 'local';
}
