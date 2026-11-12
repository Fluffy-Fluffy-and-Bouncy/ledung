// Keeps the live sessions, starts and resumes them, and routes Simon's input to them.
import { randomUUID } from 'node:crypto';
import type { DockerProjectConfig, LedungConfig, LocalProjectConfig, ProjectConfig, SettingName } from '../config.ts';
import { ProjectStore, type StoredProject } from '../projects/store.ts';
import { AccountError, AccountStore, DEFAULT_ACCOUNT, SIGN_IN_ENV, type AccountPlace } from '../accounts/store.ts';
import { removeSignIn } from '../accounts/signin-store.ts';
import type { AccountChoices, AccountInfoView, AwayInfo, AwayKind, HeavyCommandInfo, JobKindInfo, SignInProblem } from '../shared/protocol.ts';
import { Away } from './away.ts';
import { Orders } from './orders.ts';
import { ChatImageError, type ChatImages } from './chat-images.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardConfig, parseProject, workflowsOf } from '../config.ts';
import { checkFolder, chosenWorkflow, projectWorkflow, withProfilesWarning, type WorkflowCheck } from './workflow.ts';
import { backToShared, findFlow, flowInstructions, flowPlaces, readFlows, readFlowView, saveFlowFiles, workflowPlace, type FlowPlace } from './flow-files.ts';
import { originInfo } from './flow-origin.ts';
import type { FlowView } from '../shared/flow.ts';
import { remoteControlName } from './remote-control.ts';
import { loosensGate } from '../projects/gate.ts';
import { bangRefusal } from './bang.ts';
import { matchSensitive } from './sensitive.ts';
import { AIRGAP_PROFILE, isLocked, levelProblem, lockdownOf, opensUp, othersSettings, overlapProblem, projectFolders, within } from '../projects/lockdown.ts';
import { LATER_SUGGESTIONS, withLaterBatch, withSuggestions } from '../shared/sensitive-suggestions.ts';
import { isNameColour, parseNameColour } from '../shared/name-colours.ts';
import { ACCEPTED, ledungTier, questionText, reviewAnswerProblem, tiersOf, type QuestionDetails } from '../shared/questions.ts';
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
import { ResourceBook, RESOURCE_SOURCE } from '../resources/book.ts';
import { JobStore } from '../resources/jobs.ts';
import { JobActions, jobTargetsNow } from '../resources/job-actions.ts';
import { mainGpu } from '../platform/gpu.ts';
import { actOn, type Target } from '../platform/process-control.ts';
import { snapshotTree } from '../platform/process-tree.ts';
import { machineSender } from '../shared/machine-shown.ts';
import {
  CHATS,
  PERMISSION_MODES,
  type ChatsInfo,
  MODEL_CHOICES,
  type ModelChoice,
  effortLevel,
  unknownEffort,
  type EffortLevel,
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
import { saveIntoWorktree, type Saved } from './save-file.ts';
import { FileError, handoffProblem, hiddenProblem, readProjectFile, readProjectImage, type ProjectFile, type ProjectImage } from './files.ts';
import { listTree, type TreeListing } from './tree.ts';
import type { PaneFolderKey, PaneFolders } from '../shared/files-pane.ts';
import { sessionChanges, type SessionChanges } from './changes.ts';
import {
  CONTAINER_FILE_PREFIX, CONTAINER_IMAGE_MAX_BYTES, containerGit, diffHidden, keepCopy, listContainerFolder, pruneCopies, readContainerBytes, readContainerImage, readContainerText, readCopy,
  type ContainerAccess, type ContainerExec,
} from './container-files.ts';
import { checkLineComments, formatLineComments, lineCommentsMessage, openReviewFor, reviewAnswerWithComments } from '../shared/line-comments.ts';
import { Management, type LinkedMessage, type LinkedPort, type SettingsPort } from './management.ts';
import { findTickets } from '../usage/links.ts';
import { claudeEnvironment, Session, type TurnGate } from './session.ts';
import {
  checkContainerSignIn, checkSignIn, containerSignInHelp, dockerExecArgs, runCommand, sdkClaudeBinary, shellFolder, shownSignIn, signInCommand, signInHelp, tokenCommand,
  type ContainerPlace, type LoginPlace, type SignIn, type SignInContext,
} from '../accounts/signin.ts';
import { McpError } from './mcp.ts';
import { appDir, envSetting, PACKAGED, userDataDir } from '../platform/paths.ts';
import { validateSensitive } from './sensitive.ts';
import { idleReason, idleStopBlocker } from './idle.ts';
import { chooseProfile, FULL_PROFILE, pluginIdsIn, profileByName, profileNames, type Profile } from './profiles.ts';
import { Boards } from '../board/boards.ts';
import { BOARD_FILE_PREFIX, bytesKind, MAX_IMAGE_BYTES as EVIDENCE_IMAGE_MAX_BYTES, MAX_TEXT_BYTES as EVIDENCE_TEXT_MAX_BYTES, readEvidence, readLinkOutgoing, type AttachmentKind, type OutgoingFile } from '../board/attachments.ts';
import { outgoingFinding } from '../board/outgoing.ts';
import { LinkedFileError, LinkedFiles, LINKED_FILE_PREFIX, parseFileMeta, type ByteTotals } from '../remote/linked-files.ts';
import { LinkedOutbox, type StreamOffer } from '../remote/linked-outbox.ts';
import { linkOutgoing, zipProblem, type OutgoingStream } from '../remote/stream-kinds.ts';
import { sensitiveInText } from '../board/address.ts';
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
import { SecretError, type Secrets, type SecretScope } from '../secrets/secrets.ts';
import { cleanStaleRuntime, metaPlaceBook, SessionSecrets, type PlaceBook } from '../secrets/live.ts';
import { DockerSecretRuntime, LocalSecretRuntime } from '../secrets/runtime.ts';
import type { SecretInfo, SecretLifetime } from '../shared/secrets.ts';
import { FlowRunError, FlowRuns, lastReplyOf } from './flow-runs.ts';
import { dockerWorktreeHost, localWorktreeHost } from './run-worktrees.ts';
import { RunStore } from './run-store.ts';
import type { FlowRun } from '../shared/flow-run.ts';
import type { RunBlock } from '../shared/protocol.ts';
import type { ProposeHandlers, RunHandlers } from './tools.ts';
import { buildProposal, ProposalStore, proposalSummary, type ProposedChange } from './flow-propose.ts';
import type { FlowProposal } from '../shared/flow-proposal.ts';

/** The meta key, with the project's name, that says "Record where this came from" was dismissed (workflow-origin.md, section 4). */
const ORIGIN_DISMISSED = 'flow-origin-dismissed:';

/** Ledung's own plugin with the "workflow building" skill (part 3e, #1577), shipped beside src/ and web/. */
export const WORKFLOW_PLUGIN = () => path.join(appDir(), 'plugins', 'ledung-workflow');
/** The skill's text without its front matter: the guide flow_propose gives a manager that can't load the plugin. */
export function workflowGuide(dir = WORKFLOW_PLUGIN()): string {
  const text = fs.readFileSync(path.join(dir, 'skills', 'workflow-building', 'SKILL.md'), 'utf8');
  return text.replace(/^---[\s\S]*?\n---\n+/, '');
}

const LIMIT_KEY = 'max-working-sessions';
/** New sessions waiting for memory to start, with their first message (resource limits, acceptance test finding 12). */
const WAITERS_KEY = 'resource-waiters';
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
let exercised96 = false;
let exercised160 = false;

/** How long the sidebar's read of which projects have a flow waits for one project (a container's docker exec). */
const WORKFLOWS_READ_MS = 5000;
/** How long one answer to it is shared by every page that asks. */
const WORKFLOWS_FRESH_MS = 3000;

export class SessionManager {
  private readonly live = new Map<string, Session>();
  /** Replaced when the config file changes (issue #353), so it is read when needed, never copied at start. */
  private config: LedungConfig;
  /** The config file's reloads, for Settings (issue #353); null: not watched. */
  private configState: ConfigStatus | null = null;
  private readonly store: Store;
  private readonly publish: (event: ServerEvent) => void;
  private readonly management: Management;
  /** Runs through the projects' flows (workflow part 3). */
  readonly flowRuns: FlowRuns;
  /** Managers' proposed workflow changes (part 3e). */
  private readonly proposals: ProposalStore;
  /** The linked computers (#245), set by the server whenever its public name changes. */
  private linked: LinkedPort | null = null;
  /** Settings' page-only actions for managers (#263), set by the server. */
  private settings: SettingsPort | null = null;
  /** Files managers on linked computers sent (issue #158), and the bytes counted per link. */
  readonly linkedFiles: LinkedFiles;
  /** The snapshots of files streamed to linked computers (issue #159). */
  readonly linkedOutbox: LinkedOutbox;
  readonly projectStore: ProjectStore;
  readonly accounts: AccountStore;
  private readonly monitor: ResourceMonitor;
  /** Resource limits and reservations (docs/steps/resource-limits.md). */
  private readonly book: ResourceBook;
  readonly jobs: JobStore;
  /** One action at a time per job (Pause, Resume, Stop). */
  private readonly jobActions = new JobActions();
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
  /** Orders on record (issue #105): the person's word, allowing one command in a manager and the session it sent it to. */
  readonly orders: Orders;
  /** The message boards between managers, one per repo the projects name (docs/steps/message-board.md, "Per project"). */
  boards: Boards | null = null;
  /** Locked secrets (issue #468); null: none in this Ledung (tests that don't attach them). */
  private secrets: Secrets | null = null;
  private secretBook: PlaceBook | null = null;
  private secretsDir = '';
  /** Images sent with the person's messages (issue #128); null: none in this Ledung (tests that don't attach them). */
  private chatImages: ChatImages | null = null;
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
    // When an away period ends, its orders that are not done ask whether they stay (issue #105).
    this.away = new Away(store, publish, { userName: config.userName, notify: (text) => this.tellManagers(text), onEnded: (since, end) => void this.orders.settleAway(since, end) });
    this.orders = new Orders({
      store, userName: config.userName, publish,
      tierOf: (managerId) => this.management.questionTiers(managerId)[0],
      tell: (id, text) => {
        this.store.addInbox(id, 'ledung', text);
        this.live.get(id)?.deliver();
      },
    });
    this.pullRequests = new PullRequestPoller({
      show: (id, pr) => this.live.get(id)?.showPullRequest(pr),
      onBudget: (github) => this.publish({ type: 'github', github }),
      enterpriseHosts: () => this.config.githubHosts,
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
      orders: this.orders,
      away: () => this.away.current(),
      wake: (id) => this.live.get(id)?.deliver(),
      resume: (id) => this.resumeIfEnded(id),
      archiveSession: (id, by) => void this.archive(id, by),
      startSession: (project, task, opts) => this.start(project, task, { parentId: opts.parentId, title: opts.title, permissionMode: opts.permissionMode, model: opts.model, effort: opts.effort, profile: opts.profile, cwd: opts.cwd, before: opts.before }),
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
      onRunSessionTurn: (id, reply) => this.flowRuns.onSessionTurn(id, reply),
      // The page's own save, with its checks (issue #306); the tools decide what they may change and what is asked.
      projectSettings: {
        config: (name) => this.projectStore.get(name)?.config ?? null,
        workflows: () => workflowsOf(this.config),
        check: (name, config) => this.checkSettings(name, config),
        update: (name, config) => this.updateProject(name, config),
      },
      linked: () => this.linked,
      settings: () => this.settings,
      linkedFiles: () => this.linkedFiles,
      outgoingFiles: (managerId, names) => this.outgoingFiles(managerId, names),
      snapshotOutgoing: (managerId, linkId, toId, file) => this.snapshotOutgoing(managerId, linkId, toId, file),
      linkedOutbox: () => this.linkedOutbox,
      saveLinkedFile: (managerId, sessionId, handle, rel) => this.saveLinkedFile(managerId, sessionId, handle, rel),
      handoffProblem: (id, file) => this.handoffProblem(id, file),
      // The file viewer's own image rules, so a shot that is attached can also be shown (issue #60).
      // A manager's board attachment ("board:...") is from its project's board cache instead.
      // A container project's file is a copy Ledung kept when the question was asked (keepContainerFiles, issue #122).
      // A file a manager on a linked computer sent this one ("linked:...") is the copy kept in the data folder (issue #158).
      shotPath: (id, file) => file.startsWith(BOARD_FILE_PREFIX) ? this.readBoardShot(id, file)
        : file.startsWith(LINKED_FILE_PREFIX) ? (this.readLinkedCopy(id, file, ['png', 'jpeg']), file)
        : file.startsWith(CONTAINER_FILE_PREFIX) ? (this.readContainerCopy(id, file, ['png', 'jpeg']), file) : this.readImageHere(id, file).path,
      keepContainerFiles: (id, files) => this.keepContainerFiles(id, files),
      evidenceFile: (id, file) => {
        const ev = this.readEvidenceFile(id, file, true);
        return { file: ev.file, kind: ev.kind === 'text' ? 'text' : 'image' };
      },
    });
    this.proposals = new ProposalStore(store.database);
    this.linkedFiles = new LinkedFiles(store.database, () => this.linkedFilesDir(), () => boardConfig(this.config).evidenceDays, Date.now, () => ({
      maxFileBytes: this.config.linkedFiles.maxFileMB * 1024 * 1024,
      maxMessageBytes: this.config.linkedFiles.maxMessageMB * 1024 * 1024,
    }));
    this.linkedOutbox = new LinkedOutbox(store.database, () => this.linkedOutboxDir(), () => boardConfig(this.config).evidenceDays);
    this.flowRuns = new FlowRuns({
      runs: new RunStore(store.database),
      getSession: (id) => this.store.getSession(id),
      managerOf: (project) => this.projectStore.get(project)?.managerId ?? null,
      flows: (project) => {
        const config = this.projectStore.get(project)?.config;
        return config ? readFlows(this.flowPlacesOf(config)) : Promise.resolve(null);
      },
      following: (project) => this.projectStore.get(project)?.config.followFlow !== false,
      // A coordinator that ended is resumed, as a continued block's session is (final review of part 3, finding 3).
      tell: (id, text) => {
        this.store.addInbox(id, 'ledung', text);
        void this.resumeIfEnded(id).then(() => this.live.get(id)?.deliver(), (e: Error) => {
          // One that can't be resumed: its project's manager is told what it was told, so the run is not stranded.
          const s = this.store.getSession(id);
          const manager = s ? this.projectStore.get(s.project)?.managerId : null;
          console.warn(`Workflow: could not resume ${id} to tell it: ${e.message}`);
          if (!manager || manager === id) return;
          this.store.addInbox(manager, 'ledung', `Ledung could not resume "${s!.title}" (${id}), which coordinates a run, to tell it this (${e.message}); you may coordinate its runs:\n\n${text}`);
          void this.resumeIfEnded(manager).then(() => this.live.get(manager)?.deliver(), () => {});
        });
      },
      changed: (project) => this.publish({ type: 'runs', project, runs: this.flowRuns.list(project) }),
      // Part 3b: a block's session is started under the run's coordinator with the block's settings, its step from Ledung.
      startSession: async (b) => {
        const s = await this.start(b.project, b.task, {
          parentId: b.coordinator, title: b.title, model: b.model, profile: b.profile, runBlock: b.runBlock, ...(b.cwd ? { cwd: b.cwd, runWorktree: true } : {}),
          intro: `Your step, from Ledung's workflow (run ${b.runBlock.run}, block ${b.runBlock.block}):`,
        });
        // A start that failed ends the session rather than throwing (review of 3b, finding 2).
        if (s.status === 'ended') throw new Error(`the session could not start: ${s.endReason ?? 'unknown reason'}.`);
        return s;
      },
      stopSession: async (id, reason) => {
        if (this.store.getSession(id)?.status !== 'ended') await this.stop(id, reason);
      },
      continueSession: async (id, text, runBlock, fresh) => {
        this.store.updateSession(id, { runBlock });
        this.publish({ type: 'session', session: this.store.getSession(id)! });
        const step = `Your next step, from Ledung's workflow (run ${runBlock.run}, block ${runBlock.block}):\n\n${text}`;
        // A fresh context first (part 3f): the step comes as the note after the compact or clear.
        if (fresh) {
          await this.management.freshStep(id, fresh.by, fresh.context, step);
          return;
        }
        this.store.addInbox(id, 'ledung', step);
        await this.resumeIfEnded(id);
        this.live.get(id)?.deliver();
      },
      archiveSession: (id, by) => void this.archive(id, by),
      worktreeHost: (name) => {
        const config = this.projectStore.get(name)?.config;
        if (!config) return null;
        const env = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
        return config.runner === 'local'
          ? localWorktreeHost(config.path, (command, cwd) => new LocalRunner(config, cwd, this.config.claudeExecutable).shell(command, this.config.windowsShell, env()))
          // Its own tag per setup, the run's folder in it, so two setups in one container never stop each other (final review, 6).
          : dockerWorktreeHost(config, (command, cwd) => new DockerRunner(config, `worktree-${path.posix.basename(cwd)}-${randomUUID().slice(0, 8)}`, cwd).shell(command, null, env()));
      },
      worktreeSetup: (name) => this.projectStore.get(name)?.config.worktreeSetup,
      sessionsOf: (name, run) => this.store.listSessions().filter((s) => s.project === name && s.runBlock?.run === run).map((s) => s.id),
      // Real paths on both sides: a session's folder is its real path, a worktree's is under the configured one, which may
      // go through a link (final review of part 3, finding 4).
      workingIn: (name, folder) => {
        const local = this.projectStore.get(name)?.config.runner === 'local';
        const real = (p: string) => {
          try {
            return local ? fs.realpathSync.native(p) : p;
          } catch {
            return p;
          }
        };
        const at = real(folder);
        return this.store.listSessions().filter((s) => s.project === name && s.status !== 'ended' && s.workDir && real(s.workDir) === at).map((s) => s.title);
      },
      lastReply: (id) => lastReplyOf(this.store.listMessages(id, { limit: 200 })),
      ask: (a) => {
        const q = this.store.createQuestion({ sessionId: a.coordinator, question: a.question, options: a.options, addressedTo: 'user', details: a.details });
        this.publish({ type: 'question', question: q });
        return q;
      },
      markDelivered: (id) => this.store.markDelivered([id]),
      withdraw: (id, reason) => {
        if (this.store.withdrawQuestion(id, reason)) this.publish({ type: 'question', question: this.store.getQuestion(id)! });
      },
      tiers: (project) => tiersOf(this.projectStore.get(project)?.config.questionTiers),
      userName: config.userName,
    });
    this.gate = {
      usageHold: (id) => this.usageHold(id),
      usageStops: () => this.usageStopStates(),
      freed: () => this.dispatch(),
      mayStart: (id) => this.store.getSession(id)?.role === 'manager' || mayStart(id, this.working(), this.limit, this.lineEntries()),
      started: (id, trigger, at) => {
        this.turns.set(id, { at: at ?? Date.now(), trigger });
        this.monitor.beginTurn(id);
      },
      ended: (id, commands, waits) => {
        this.recordTurn(id, commands, waits);
        this.book.turnEnded(id);
        this.dispatch();
        // A session waiting to take new lockdown settings may now be free (issue #109).
        if (this.relaunching.has(id)) setImmediate(() => void this.relaunchWaiting());
      },
    };
    Object.assign(this.gate, {
      reserve: (id: string, args: Parameters<ResourceBook['reserve']>[1]) => this.book.reserve(id, args),
      release: (id: string) => this.book.release(id),
      resourceFacts: () => {
        const gpu = this.monitor.gpu;
        const main = mainGpu(gpu);
        const names = [...(gpu?.adapters ?? [])].sort((a, b) => (a.id === main ? -1 : b.id === main ? 1 : 0)).map((a) => a.name);
        return { threads: os.cpus().length, gpus: names };
      },
      resourceHeld: (id: string) => this.book.isHeld(id),
      commandCheck: (id: string, kinds: string[]) => {
        this.book.noteCommands(id, kinds);
        return this.book.commandRefusal(id, kinds);
      },
    } satisfies Partial<TurnGate>);
    this.jobs = new JobStore(store.database);
    this.book = new ResourceBook({
      meta: { get: (key) => this.store.getMeta(key), set: (key, value) => this.store.setMeta(key, value) },
      jobs: this.jobs,
      session: (id) => {
        const info = this.store.getSession(id);
        if (!info || info.status === 'ended') return null;
        return {
          id, title: info.title, project: info.project, role: info.role, priority: info.priority, local: info.runner === 'local',
          busy: info.status === 'running' || info.status === 'waiting',
        };
      },
      // A paused job that ends is resumed, never left frozen (security review of the resource limits, finding 10).
      resume: (targets) => void actOn(targets, 'resume').catch((e: Error) => console.error(`Resuming a job: ${e.message}`)),
      tell: (id, text) => {
        this.store.addInbox(id, RESOURCE_SOURCE, text);
        this.live.get(id)?.deliver();
      },
      wake: (id) => this.live.get(id)?.deliver(),
      // A limit set, a reservation, a go: always sent (#230's sender, without onlyIfChanged).
      changed: () => this.publishMachine(),
    });
    this.monitor = new ResourceMonitor({
      targets: () => this.targets(),
      withDocker: () => this.projectStore.list().some((p) => p.config.runner === 'docker'),
      // Only what the page would show differently (#230): a sample every 5 s went to every page.
      onSample: () => this.publishMachine(true),
      onTick: (t) => {
        const m = this.monitor.machine();
        this.book.sample({ ...t, threads: m.cpus, cores: m.cores, memUsed: m.memUsed, memTotal: m.memTotal });
      },
    });
    // A stop reached before a restart still holds, and its reset still lifts it (issue #278).
    this.refreshStops();
  }

  // --- Images in the message box (issue #128) --------------------------------------------------------

  /** Where pasted, dropped and picked images are kept: the data folder's "chat-images" (src/main.ts), a temp folder in tests. */
  attachChatImages(images: ChatImages): void {
    this.chatImages = images;
  }

  private images(): ChatImages {
    if (!this.chatImages) throw new UserError('Images are not available in this Ledung.');
    return this.chatImages;
  }

  /** Keeps an image the person is about to send to this session; only the page's own message box uploads them. */
  uploadImage(sessionId: string, bytes: Buffer): { id: string } {
    if (!this.store.getSession(sessionId)) throw new UserError('No such session.');
    try {
      return { id: this.images().save(sessionId, bytes).id };
    } catch (e) {
      throw e instanceof ChatImageError ? new UserError(e.message) : e;
    }
  }

  /** An image sent to this session, for its history. */
  readChatImage(sessionId: string, id: string): { type: string; bytes: Buffer } {
    if (!this.store.getSession(sessionId)) throw new UserError('No such session.');
    try {
      return this.images().read(sessionId, id);
    } catch (e) {
      throw e instanceof ChatImageError ? new UserError(e.message) : e;
    }
  }

  // --- Locked secrets (issue #468) -------------------------------------------------------------------

  /** Gives sessions their locked secrets, and blanks the values in everything stored. localDir: local sessions' runtime files. */
  attachSecrets(secrets: Secrets, localDir: string): void {
    this.secrets = secrets;
    this.secretsDir = localDir;
    this.secretBook = metaPlaceBook({ get: (k) => this.store.getMeta(k), set: (k, v) => this.store.setMeta(k, v) });
    this.store.setBlanker({ text: (s) => secrets.blank(s), deep: (d) => secrets.blankDeep(d) });
    secrets.onChange = (change) => this.secretsChanged(change);
  }

  private sessionSecrets(project: ProjectConfig, info: SessionInfo): SessionSecrets | null {
    if (!this.secrets || !this.secretBook) return null;
    const runtime = project.runner === 'local'
      ? new LocalSecretRuntime(this.secretsDir, info.id)
      : new DockerSecretRuntime({ container: project.container, user: project.user || undefined }, info.id);
    return new SessionSecrets({ secrets: this.secrets, scope: { sessionId: info.id, project: info.project }, runtime, book: this.secretBook });
  }

  private secretScope(id: string): SecretScope {
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    return { sessionId: id, project: info.project };
  }

  private async secretCall<T>(call: (secrets: Secrets) => Promise<T>): Promise<T> {
    if (!this.secrets) throw new UserError('Locked secrets are not available in this Ledung.');
    try {
      return await call(this.secrets);
    } catch (e) {
      throw e instanceof SecretError ? new UserError(e.message) : e;
    }
  }

  /** The secrets a session may use, for the page: never a value. */
  secretList(id: string): SecretInfo[] {
    const scope = this.secretScope(id);
    return this.live.get(id)?.secretList() ?? this.secrets?.list(scope) ?? [];
  }

  /** Locks a value for a session (the page's 🔑); what the page sees of it. */
  async addSecret(id: string, name: string, value: string, lifetime: SecretLifetime): Promise<SecretInfo> {
    const added = await this.secretCall((s) => s.add(this.secretScope(id), name, value, lifetime));
    return this.secretList(id).find((x) => x.id === added.id) ?? added;
  }

  async editSecret(id: string, secretId: string, edit: { name?: string; lifetime?: SecretLifetime }): Promise<SecretInfo> {
    const edited = await this.secretCall((s) => s.edit(this.secretScope(id), secretId, edit));
    return this.secretList(id).find((x) => x.id === edited.id) ?? edited;
  }

  async removeSecret(id: string, secretId: string): Promise<void> {
    await this.secretCall((s) => s.remove(this.secretScope(id), secretId));
  }

  /** The running sessions a change reaches get it in their next command; the pages showing them are told. */
  private secretsChanged(change: { sessionId: string } | { project: string }): void {
    const ids = 'sessionId' in change
      ? [change.sessionId]
      : [...this.live.values()].filter((s) => s.info.project === change.project).map((s) => s.id);
    for (const id of ids) {
      void (this.live.get(id)?.secretsChanged() ?? Promise.resolve()).then(() => {
        if (this.store.getSession(id)) this.publish({ type: 'secrets', sessionId: id, secrets: this.secretList(id) });
      });
    }
  }

  /**
   * At Ledung's start, once the running sessions are reattached: the "once" secrets of sessions that ended had
   * their turn, and every runtime file of a session no longer running goes (the manager's addition 1 on #1565).
   */
  async cleanSecretsAtStart(running: readonly string[]): Promise<void> {
    if (!this.secrets || !this.secretBook) return;
    await this.secrets.dropOnceExcept(new Set(running));
    // Asked at each deletion, not a list from before: a session started meanwhile keeps its files (review of #468, finding 2).
    const live = { has: (id: string) => running.includes(id) || this.live.has(id) };
    const containers = this.projectStore.list().map((p) => p.config).filter((p) => p.runner === 'docker')
      .map((p) => ({ container: p.container, user: p.user || undefined }));
    const unique = [...new Map(containers.map((c) => [`${c.container}:${c.user ?? ''}`, c])).values()];
    await cleanStaleRuntime({ book: this.secretBook, live, localDir: this.secretsDir, containers: unique, log: (line) => console.log(line) });
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
      // A locked secret's value never reaches the board (issue #468).
      blank: (text) => this.secrets?.blank(text) ?? text,
      holdsSecret: (text) => this.secrets?.holdsValue(text) ?? false,
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
    if (file.startsWith(LINKED_FILE_PREFIX)) {
      const copy = this.readLinkedCopy(sessionId, file, ['png', 'jpeg', 'text']);
      return { file, kind: copy.kind, bytes: copy.bytes };
    }
    if (file.startsWith(CONTAINER_FILE_PREFIX)) {
      const copy = this.readContainerCopy(sessionId, file, ['png', 'jpeg', 'text']);
      if (copy.kind === 'text' && copy.bytes.length > EVIDENCE_TEXT_MAX_BYTES) throw new UserError(`${copy.path} is too large.`);
      return { file, kind: copy.kind, bytes: copy.bytes };
    }
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
      this.linkedFiles.prune();
      this.linkedOutbox.prune();
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
    this.publishMachine();
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

  /** A sample that changes nothing on the page isn't sent (#230). */
  private readonly sendMachine = machineSender((machine) => this.publish({ type: 'machine', machine }));

  /** Sends the machine's figures to the pages; with `onlyIfChanged`, only when what they show differs from the last ones sent. */
  private publishMachine(onlyIfChanged = false): void {
    this.sendMachine(this.machine(), onlyIfChanged);
  }

  machine(): MachineInfo {
    return {
      at: Date.now(), ...this.monitor.machine(), docker: this.monitor.docker, sessions: this.monitor.figures(),
      working: this.working(), limit: this.limit, line: lineOrder(this.lineEntries()), resources: this.book.info(),
    };
  }

  // --- Resource limits (docs/steps/resource-limits.md): from the page only ---------------------------------------

  setResourceLimit(dim: string, value: unknown): void {
    try {
      this.book.setLimit(dim, value);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  setResourceSettings(body: Record<string, unknown>): void {
    try {
      this.book.setSettings(body);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  resourceStartNow(id: string): void {
    try {
      this.book.startNow(id);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  /**
   * A job's processes to act on, found just now: the job's processes still under its session's host in a fresh list,
   * plus what they started since the last sample (acceptance test, finding 5), with their start times, which Windows
   * checks again on the handle it acts through (security review, finding 1).
   */
  private async freshJobTargets(id: string): Promise<{ sessionId: string; paused: boolean; targets: Target[] }> {
    let job: ReturnType<ResourceBook['jobTargets']>;
    try {
      job = this.book.jobTargets(id);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    if (!job.host) throw new UserError("This job's session is not measured right now; try again in a few seconds.");
    return { sessionId: job.sessionId, paused: job.paused, targets: jobTargetsNow(job.targets, await snapshotTree(job.host), job.host) };
  }

  /**
   * The person's Pause or Resume on a job's card: suspends or resumes its processes. Never automatic. One action
   * per job at a time, checked before anything is awaited (acceptance test, finding 1).
   */
  pauseJob(id: string, paused: boolean): Promise<void> {
    return this.jobActions.run(id, async () => {
      const job = await this.freshJobTargets(id);
      // Windows counts suspends: a second Pause would need two Resumes.
      if (job.paused === paused) throw new UserError(paused ? 'This job is already paused.' : 'This job is not paused.');
      let done: number;
      try {
        done = (await actOn(job.targets, paused ? 'suspend' : 'resume')).done;
      } catch (e) {
        throw new UserError(`Could not ${paused ? 'pause' : 'resume'} the job: ${(e as Error).message}`);
      }
      if (!done) throw new UserError(`Could not ${paused ? 'pause' : 'resume'} the job: none of its processes could be reached.`);
      this.book.setJobPaused(id, paused);
      this.store.addInbox(job.sessionId, RESOURCE_SOURCE, `${this.config.userName} ${paused ? 'paused' : 'resumed'} your job (reservation ${id}) from its card${paused ? ': its processes are suspended until resumed; their memory stays taken' : ''}.`);
      this.live.get(job.sessionId)?.deliver();
    }).catch((e: Error) => {
      throw e instanceof UserError ? e : new UserError(e.message);
    });
  }

  /** The person's Stop on a job's card, after a confirm in the page: ends its processes. */
  stopJob(id: string): Promise<void> {
    return this.jobActions.run(id, async () => {
      const job = await this.freshJobTargets(id);
      let done: number;
      try {
        done = (await actOn(job.targets, 'end')).done;
      } catch (e) {
        throw new UserError(`Could not stop the job: ${(e as Error).message}`);
      }
      if (!done) throw new UserError('Could not stop the job: none of its processes could be reached.');
      this.store.addInbox(job.sessionId, RESOURCE_SOURCE, `${this.config.userName} stopped your job (reservation ${id}) from its card: ${done} of its processes were ended.`);
      this.live.get(job.sessionId)?.deliver();
    }).catch((e: Error) => {
      throw e instanceof UserError ? e : new UserError(e.message);
    });
  }

  jobKinds(): JobKindInfo[] {
    return this.jobs.kinds();
  }

  heavyCommands(): HeavyCommandInfo[] {
    return this.jobs.heavyCommands();
  }

  forgetJobKind(project: string, kind: string): void {
    this.jobs.forget(project, kind);
  }

  markCommand(project: string, command: string, never: boolean): void {
    this.jobs.markNever(project, command, never);
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

  private recordTurn(id: string, commands: string[], waits?: [number, number][]): void {
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
        avgCores: 0, peakCores: totals.peakCores, peakMem: totals.peakMem, commands, waits,
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
    this.publishMachine();
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
    this.publishMachine();
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
      // Read from the stored session on every start, resume and reattach, so it is kept as the model is (issue #202).
      effort: info.requestedEffort ?? undefined, defaultEffort: defaultEffortFor(project, info.role),
      // A project the user opted in lets its manager's project tools run unasked (decision of 2026-10-14).
      projectToolsUnasked: project.projectToolsUnasked ?? false,
      userName: this.config.userName, management: this.management, grant: project.managerGrant, tickets: project.tickets, gate: this.gate,
      away: this.away, devShip: project.devShipCommand ?? null, orders: this.orders,
      // The board tools, for a manager whose project has the board on (decision 9); looked at on every start and resume.
      board: launch.board ? this.boards : null,
      pullRequests: this.pullRequests,
      secrets: this.sessionSecrets(project, info),
      // The person's images, read when their message goes in (issue #128).
      images: this.chatImages,
      // Looked at on every start and resume, so a config file written meanwhile is found (issue #21).
      workflow: withProfilesWarning(projectWorkflow(chosenWorkflow(workflowsOf(this.config), project), project), profiles.warning),
      // A manager is told where its project's flow is (issue #310), looked for on every start and resume too; with the
      // run tools' line when Ledung follows it (workflow part 3).
      flow: info.role === 'manager' && info.project !== CHATS ? () => flowInstructions(this.flowPlacesOf(project), project.followFlow !== false) : undefined,
      // The run tools only where there is a flow to follow (part 3, "keeping context small").
      runs: info.project !== CHATS ? () => this.runHandlers(project, info.id) : undefined,
      // A manager whose project follows its workflow builds and changes it by proposing (part 3e); with the "workflow
      // building" skill as Ledung's own plugin where Claude Code runs on this computer, else the guide from the tool (#1577).
      propose: info.role === 'manager' && info.project !== CHATS && project.followFlow !== false ? this.proposeHandlers(project, info.id) : null,
      ledungPlugins: info.role === 'manager' && info.project !== CHATS && project.followFlow !== false && project.runner === 'local' ? [WORKFLOW_PLUGIN()] : [],
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
    // A proposed workflow change is saved on Accepted (part 3e), before the answer reaches the manager.
    await this.settleProposal(q);
    // A person block's answer moves its run (workflow part 3b).
    await this.flowRuns.onAnswered(q).catch((e) => console.error(`Workflow: ${(e as Error).message}`));
    // A keep-it question about an order (issue #105): Keep puts it back in force, Drop ends it.
    this.orders.answered(q);
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
    // A person block's question: its run goes back to its coordinator (workflow part 3b).
    this.flowRuns.onWithdrawn(this.store.getQuestion(id)!);
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

  /** The builder's save running per project (#311): the next waits for it. */
  private readonly flowSaves = new Map<string, Promise<void>>();

  /** Where a project's flow may be (issue #310): its own folder, then the shared workflow it follows. */
  private flowPlacesOf(project: ProjectConfig): FlowPlace[] {
    const container = project.runner === 'docker' ? new DockerRunner(project, 'flow') : null;
    const workflows = workflowsOf(this.config);
    // All the workflows, so a project whose folder is one of theirs can't save into it (ledung#109).
    return flowPlaces(project, chosenWorkflow(workflows, project), container ? {
      read: (files, max, budget) => container.readInsideProject(files, max, budget),
      list: () => container.listFlowFolder(),
      write: (files) => container.writeFlowFiles(files),
    } : undefined, workflows);
  }

  /**
   * The run tools for one session (workflow part 3), or null when its project doesn't follow a flow: switched off, or no
   * flow.json there. An error reaches the session as the tool's answer.
   */
  private async runHandlers(project: ProjectConfig, sessionId: string): Promise<RunHandlers | null> {
    if (project.followFlow === false) return null;
    // As the tools read it, so they are offered only when they can work (review of 3a).
    if (!(await readFlows(this.flowPlacesOf(project)).catch(() => null))) return null;
    const plain = async (fn: () => Promise<string>) => {
      try {
        return await fn();
      } catch (e) {
        throw e instanceof FlowRunError ? new Error(e.message) : e;
      }
    };
    return {
      // A block's session does its step and starts no runs (final review of part 3, finding 2).
      ...(this.store.getSession(sessionId)?.runBlock ? {} : { start: (a: Parameters<NonNullable<RunHandlers['start']>>[0]) => plain(() => this.flowRuns.start(sessionId, a)) }),
      step: (a) => plain(() => this.flowRuns.step(sessionId, a)),
      status: (run) => plain(() => this.flowRuns.status(sessionId, run)),
    };
  }

  /** flow_propose for one manager (part 3e): a container project's manager gets the guide from it too. */
  private proposeHandlers(project: ProjectConfig, managerId: string): ProposeHandlers {
    return {
      propose: (changes, why) => this.proposeFlow(managerId, changes, why),
      ...(project.runner === 'docker' ? { guide: () => workflowGuide() } : {}),
    };
  }

  /**
   * A manager's proposed workflow change (part 3e): checked as the builder checks a save, kept, and put to the person as
   * a review with the flows before and after; nothing is written until it is accepted.
   */
  async proposeFlow(managerId: string, changes: ProposedChange[], why: string): Promise<string> {
    const manager = this.store.getSession(managerId);
    if (!manager || manager.role !== 'manager') throw new Error('Only a manager proposes workflow changes.');
    const project = this.project(manager.project);
    // A plain read: a proposal needs no origin parts (review of part b).
    const view = await this.plainFlowView(project.name);
    let data;
    try {
      data = await buildProposal(view, changes, why, profileNames(this.profilesFor(project).profiles));
    } catch (e) {
      throw e instanceof FileError ? new Error(`${e.message} Nothing was proposed.`) : e;
    }
    const proposal = this.proposals.create(project.name, managerId, data);
    const faults = data.problems.filter((p) => !p.hint);
    const hints = data.problems.filter((p) => p.hint);
    const listed = (list: typeof faults) => list.slice(0, 12).map((p) => `- ${p.at}: ${p.message}`).join('\n');
    const tiers = tiersOf(project.questionTiers);
    const details: QuestionDetails = {
      title: `Workflow change: ${why.trim().split('\n')[0]!.slice(0, 160)}`,
      tier: tiers.find((t) => /process/i.test(t)) ?? tiers[0],
      flowProposal: proposal.id,
      review: {
        solving: why.trim(),
        done: `${manager.title} proposes this change to ${project.name}'s workflow:\n\n${proposalSummary(data)}\n\nThe diagrams below show each flow before and after. Accepted saves it into the project's .ledung/workflow.`,
        notes: (faults.length
          ? `The checks find ${faults.length === 1 ? 'one problem' : `${faults.length} problems`} in the workflow as it would be:\n\n${listed(faults)}`
          : `The checks find no problems in the workflow as it would be.${hints.length ? ` Hints:\n\n${listed(hints)}` : ''}`)
          // workflow-origin.md, section 5: only Ledung writes a copy's origin.
          + (data.originKept ? '\n\nOrigin kept as recorded: the proposed flow.json left out or changed where this copy came from, and only Ledung writes that.' : ''),
      },
    };
    const q = this.store.createQuestion({ sessionId: managerId, question: questionText(undefined, details), options: null, addressedTo: 'user', details });
    this.proposals.setQuestion(proposal.id, q.id);
    this.publish({ type: 'question', question: q });
    return `Your change is put to ${this.config.userName} as review #${q.id}, with the flows before and after.${faults.length ? ` The checks find ${faults.length} problem${faults.length === 1 ? '' : 's'} (said in the review):\n${listed(faults)}\nIf they are real, propose again with them fixed and withdraw review #${q.id}.` : ''} ` +
      'Accepted saves it; Changes needed comes back with the note. End your turn now.';
  }

  /** A proposal for the page's review (part 3e). */
  flowProposal(name: string, id: number): FlowProposal {
    const p = this.proposals.get(id);
    if (!p || p.project !== name) throw new UserError('There is no such proposal in this project.');
    const { manager: _, ...shown } = p;
    return shown;
  }

  /**
   * The person answered a proposal's review (part 3e): Accepted saves it through the builder's save (each file the
   * version read when it was proposed), Changes needed declines it; the manager is told how the save went.
   */
  private async settleProposal(q: QuestionInfo): Promise<void> {
    const p = q.details?.flowProposal ? this.proposals.get(q.details.flowProposal) : undefined;
    // Only the review it was put as: the one link from an answer to a write (review of 3e).
    if (!p || p.question !== q.id || p.state !== 'open' || q.answer === null) return;
    const accepted = q.answer.trim() === ACCEPTED || q.answer.trim().startsWith(`${ACCEPTED}`);
    if (!accepted) {
      this.proposals.setState(p.id, 'declined');
      return;
    }
    try {
      // What the person saw checked must still be the workflow it is saved into (review of 3e): any file changed since,
      // also one the proposal doesn't write (a flow it runs, a brief), and it is not saved.
      const now = (await this.plainFlowView(p.project)).versions;
      const moved = [...new Set([...Object.keys(p.read ?? {}), ...Object.keys(now)])].filter((f) => (p.read ?? {})[f] !== now[f]);
      if (moved.length) throw new Error(`the workflow changed since it was proposed (${moved.slice(0, 5).join(', ')}), so what was checked is not what would be saved.`);
      await this.saveFlow(p.project, p.writes);
      this.proposals.setState(p.id, 'saved');
      this.store.addInbox(p.manager, 'ledung', `Ledung: ${this.config.userName} accepted review #${q.id}, and your workflow change is saved into ${p.project}'s .ledung/workflow (${p.writes.map((w) => w.path).join(', ')}). The workflow page shows it. Run tools added for a project that had no flow come with your next start.`);
    } catch (e) {
      this.proposals.setState(p.id, 'failed');
      this.store.addInbox(p.manager, 'ledung', `Ledung: ${this.config.userName} accepted review #${q.id}, but the change could not be saved: ${(e as Error).message} Read the workflow files again and propose it anew.`);
    }
  }

  /** The person stops a run from the Runs list (final review of part 3, finding 3). */
  async stopRunFromPage(name: string, run: string): Promise<void> {
    if (!this.projectStore.get(name)) throw new UserError(`There is no project named "${name}".`);
    try {
      await this.flowRuns.stopByPerson(name, run, this.config.userName);
    } catch (e) {
      throw e instanceof FlowRunError ? new UserError(e.message) : e;
    }
  }

  /** The person starts a queued run past its limit (part 3f). */
  async startRunAnyway(name: string, run: string): Promise<void> {
    if (!this.projectStore.get(name)) throw new UserError(`There is no project named "${name}".`);
    try {
      await this.flowRuns.startAnyway(name, run, this.config.userName);
    } catch (e) {
      throw e instanceof FlowRunError ? new UserError(e.message) : e;
    }
  }

  /**
   * Which projects have a workflow, a flow found in their own folder or a shared workflow's (one that can't be read
   * counts: its page says why), for the sidebar's Workflow row (Simon, 2026-11-04). Only flow.json is read.
   */
  workflowsPresent(): Promise<Record<string, boolean>> {
    // One read at a time, and its answer shared for a few seconds: a save tells every open page at once, and each asks
    // (second review of the row: a docker exec per container project per page).
    const now = Date.now();
    if (this.workflowsRead && now - this.workflowsRead.at < WORKFLOWS_FRESH_MS) return this.workflowsRead.answer;
    const answer = this.readWorkflowsPresent();
    this.workflowsRead = { at: now, answer };
    answer.catch(() => { this.workflowsRead = null; });
    return answer;
  }

  private workflowsRead: { at: number; answer: Promise<Record<string, boolean>> } | null = null;

  private async readWorkflowsPresent(): Promise<Record<string, boolean>> {
    const projects = this.projectStore.list().map((p) => p.config);
    // A container's read that fails says "refused" for every file (review of the row): only a local refusal is a flow
    // that is there but unreadable. A container slow to answer counts as none rather than holding every project's row.
    const has = (p: ProjectConfig) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        findFlow(this.flowPlacesOf(p)).then((f) => f !== null && ('text' in f || p.runner === 'local' || f.place.kind === 'workflow'), () => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), WORKFLOWS_READ_MS); }),
      ]).finally(() => clearTimeout(timer));
    };
    const found = await Promise.all(projects.map(has));
    return Object.fromEntries(projects.map((p, i) => [p.name, found[i]!]));
  }

  /** A project's runs for the workflow page (part 3), the latest changed first. */
  flowRunsOf(name: string): FlowRun[] {
    if (!this.projectStore.get(name)) throw new UserError(`There is no project named "${name}".`);
    return this.flowRuns.list(name);
  }

  /** The workflow page (issue #310, part 1): a project's flow with its texts and the checks' problems, read-only. */
  async flowView(name: string): Promise<FlowView> {
    const project = this.projectStore.get(name)?.config;
    if (!project) throw new UserError(`There is no project named "${name}".`);
    const places = this.flowPlacesOf(project);
    const view = await this.plainFlowView(name);
    // workflow-origin.md: what a split-off records, whether a copy's original changed since, "Record where this came
    // from". Each part fails on its own (originInfo), so a split-off never loses its origin to another part's error.
    const workflows = workflowsOf(this.config).map((w) => ({ name: w.name, folder: w.folder, place: workflowPlace(w) }));
    const origin = await originInfo(view, places, workflows, { dismissed: this.store.getMeta(`${ORIGIN_DISMISSED}${project.name}`) !== null });
    return { ...view, ...origin };
  }

  /** The flow as read, with its checks, and none of the origin parts: for a proposal and its Accept (review of part b). */
  private async plainFlowView(name: string): Promise<FlowView> {
    const project = this.projectStore.get(name)?.config;
    if (!project) throw new UserError(`There is no project named "${name}".`);
    // A block's profile is checked against what the project's sessions can use: the config and its workflow's profiles file (#298).
    return readFlowView(project.name, this.flowPlacesOf(project), profileNames(this.profilesFor(project).profiles));
  }

  /** The person dismissed "Record where this came from" for a project's older copy (workflow-origin.md, section 4). */
  async dismissAdoptOrigin(name: string): Promise<FlowView> {
    if (!this.projectStore.get(name)) throw new UserError(`There is no project named "${name}".`);
    this.store.setMeta(`${ORIGIN_DISMISSED}${name}`, new Date().toISOString());
    return this.flowView(name);
  }

  /**
   * The builder saves (issue #311, part 2, design decision 4): the files straight into the project's own
   * .ledung/workflow, each the version the page read, then the workflow as it now reads.
   */
  async saveFlow(name: string, files: unknown): Promise<FlowView> {
    const project = this.projectStore.get(name)?.config;
    if (!project) throw new UserError(`There is no project named "${name}".`);
    const places = this.flowPlacesOf(project);
    const own = places.find((p) => p.kind === 'project');
    // A project whose folder is a shared workflow's: refused with the reason (ledung#109).
    if (!own) throw new UserError(places.find((p) => p.readOnly)?.readOnly ?? `Ledung can't write into ${name}'s folder.`);
    // One save per project at a time, so two that read the same versions can't both pass the check (review of #311, finding 2).
    const before = this.flowSaves.get(project.name) ?? Promise.resolve();
    const saving = before.then(() => saveFlowFiles(own, files));
    this.flowSaves.set(project.name, saving.catch(() => {}));
    try {
      await saving;
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
    console.log(`Workflow: saved ${Array.isArray(files) ? files.length : 0} file(s) into ${own.folder} from the builder.`);
    // Every open page's Workflow row: the project may have a flow now (2026-11-04).
    this.workflowsRead = null;
    this.publish({ type: 'workflows' });
    return this.flowView(name);
  }

  /**
   * ledung#110 "Back to shared": the project's own flow.json and flows/ are removed, so the shared workflow it follows
   * counts again; then the workflow as it now reads. One save at a time per project, as the builder's.
   */
  async backToSharedFlow(name: string, versions: Record<string, string>): Promise<FlowView> {
    const project = this.projectStore.get(name)?.config;
    if (!project) throw new UserError(`There is no project named "${name}".`);
    const before = this.flowSaves.get(project.name) ?? Promise.resolve();
    const going = before.then(() => backToShared(this.flowPlacesOf(project), versions));
    this.flowSaves.set(project.name, going.then(() => {}, () => {}));
    try {
      const files = await going;
      console.log(`Workflow: ${name} went back to its shared workflow's flow; removed ${files.join(', ')}.`);
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
    this.workflowsRead = null;
    this.publish({ type: 'workflows' });
    return this.flowView(name);
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
    const accounts = this.accounts.list().map((a) => this.accountView(inFile[a.name] ? { ...a, inConfigFile: true, whatItIsFor: inFile[a.name]!.whatItIsFor ?? null } : a));
    const identity = raw ? JSON.parse(raw) : null;
    const defaultKind = shownSignIn(this.signIns.get(DEFAULT_ACCOUNT));
    return {
      type: 'accounts', accounts,
      defaultIdentity: defaultKind ? { email: null, organization: null, plan: null, seenAt: null, ...identity, signInKind: defaultKind } : identity,
      choices: this.accountChoices(), signedOut: this.signedOut(),
      claudeProblem: this.claudeProblem, claudeLooked: this.claudeProblem ? this.claudeLooked : [], configFileProblems: this.accountFileProblems,
    };
  }

  /** An account as the page shows it: how it is signed in (from the last check) and the commands to sign it in (#85). */
  private accountView(a: AccountInfoView): AccountInfoView {
    const data = envSetting('DATA_DIR');
    return {
      ...a, signInKind: shownSignIn(this.signIns.get(a.name)), loginCommand: signInCommand(a.configDir),
      tokenCommand: tokenCommand(a.name, { packaged: PACKAGED, appDir: appDir(), dataDir: data ? path.resolve(data) : undefined, platform: process.platform }),
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
  /** Where that last look went (#455), shown under the banner so a "not found" can be acted on. */
  private claudeLooked: string[] = [];

  /** Looks for the Claude Code sessions run, and tells the page when its problem changed. Never throws. */
  async checkClaude(): Promise<ClaudeCodeView> {
    const view = await this.claudeCodeView();
    this.claudeLooked = view.looked ?? [];
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
    this.claudeLooked = claude.looked ?? [];
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
    const local = !projects.length || projects.some((c) => c.runner === 'local') || choices.chats === name || choices.newProjects === name
      || [...this.live.values()].some((s) => s.info.project === CHATS && s.info.account === name && s.info.status !== 'ended');
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
    const combined = { state, method: found.find((f) => f.method)?.method ?? null, kind: found.find((f) => f.kind)?.kind ?? null, detail: found.find((f) => f.detail)?.detail ?? null, checkedAt: Date.now() };
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
      || this.projectStore.list().some((p) => p.config.runner === 'local' && !p.config.account)
      || [...this.live.values()].some((s) => s.info.project === CHATS && !s.info.account && s.info.status !== 'ended');
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
      return this.accountView(added);
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
    // A chat started on it from New chat (issue #119) would be signed out under its feet.
    const chats = [...this.live.values()].filter((s) => s.info.project === CHATS && s.info.account === name && s.info.status !== 'ended').length;
    if (chats) throw new UserError(`The account is used by ${chats === 1 ? 'a running chat' : `${chats} running chats`}. Stop ${chats === 1 ? 'it' : 'them'} first.`);
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
    // "Record where this came from" stays dismissed under the new name (review of part d).
    if (p.config.name !== name && this.store.getMeta(`${ORIGIN_DISMISSED}${name}`) !== null) {
      this.store.setMeta(`${ORIGIN_DISMISSED}${p.config.name}`, this.store.getMeta(`${ORIGIN_DISMISSED}${name}`)!);
      this.store.deleteMeta(`${ORIGIN_DISMISSED}${name}`);
    }
    this.boards?.refresh();
    this.publishProjects();
    for (const s of this.sessions()) if (s.project === p.config.name) this.publish({ type: 'session', session: s });
    return this.projectInfo(this.projectStore.get(p.config.name)!);
  }

  /**
   * What updateProject refuses, checked without writing anything, so a rename can check first (review-116 round 2).
   * The page's save doesn't send where a project is, so it is filled in as the store does: every check sees the project
   * that would be stored. Without it a project's workflow, and so that workflow's profiles, looked absent (#96).
   */
  private checkSettings(name: string, config: ProjectConfig): void {
    const current = this.projectStore.get(name);
    // Nothing to check against: the store's own "no project" refusal says what is wrong.
    if (!current) return;
    const where = current.config.runner === 'local'
      ? { runner: 'local' as const, path: current.config.path }
      : { runner: 'docker' as const, container: current.config.container, pathInContainer: current.config.pathInContainer, user: current.config.user };
    const full = { ...config, ...where, name };
    this.checkAccount(full);
    this.checkProfiles(full);
    const namesProfile = config.profiles?.manager ?? config.profiles?.session;
    if (!exercised96 && namesProfile && config.runner === undefined) {
      exercised96 = true;
      exercisedLine('EXERCISED #96 a project naming a profile checked on the page\'s save with its stored place');
    }
    this.checkWorkflow(full, current.config);
    this.checkLockdownOf(full);
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
    this.flowRuns.stopProject(name, `the project "${name}" was removed`);
    // A later project of the same name is offered "Record where this came from" afresh (review of part d).
    this.store.deleteMeta(`${ORIGIN_DISMISSED}${name}`);
    // Its secrets, the project's and its sessions', go with it (issue #468).
    void this.secrets?.dropProject(name).catch((e) => console.error(`Secrets of ${name}: ${(e as Error).message}`));
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
    // Streamed files a restart cut off are fetched again from where they stopped, once (issue #159).
    if (linked && !this.streamsResumed) {
      this.streamsResumed = true;
      this.management.resumeStreams();
    }
  }

  private streamsResumed = false;

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

  /** The settings a session runs with: its project's, or a chat's (issue #211) on its own account (issue #119). */
  private configOf(info: SessionInfo): ProjectConfig {
    return info.project === CHATS ? this.chatConfig(info.workDir ?? this.chats().folder, info.account) : this.project(info.project);
  }

  /** configOf, or null for a session whose project is gone. */
  private configOrNull(info: SessionInfo): ProjectConfig | null {
    return info.project === CHATS ? this.chatConfig(info.workDir ?? this.chats().folder, info.account) : this.projectStore.get(info.project)?.config ?? null;
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
        this.store.setMeta(CHATS_SENSITIVE_KEY, JSON.stringify({ ...s, commandPatterns: withLaterBatch(s.commandPatterns, batch) }));
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
   * What a chat runs with, as a local project in its own folder: no workflow, grant or board; its own account
   * (issue #119; null: the computer's own login), kept on resume, or the one chosen for chats (issue #283) when
   * none is given or the chat's has been removed since; the config's chats patterns and the chats list from
   * Settings (Ledung adds the global ones, as for a project).
   */
  private chatConfig(workDir: string, own?: string | null): LocalProjectConfig {
    const account = own === undefined || (own !== null && !this.accounts.get(own)) ? this.accountChoices().chats : own;
    return this.chatConfigOn(workDir, account);
  }

  private chatConfigOn(workDir: string, account: string | null): LocalProjectConfig {
    const own = this.chatsSensitive();
    const seeds = this.config.chats.sensitive;
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
   * The account is New chat's choice (issue #119): a name, or "default" for the computer's own login; left
   * out, the one chosen for chats in Settings.
   */
  async startChat(opts: { folder?: string; model?: string; effort?: unknown; profile?: string; permissionMode?: PermissionMode; account?: unknown; text?: string } = {}): Promise<SessionInfo> {
    if (opts.permissionMode !== undefined && !PERMISSION_MODES.includes(opts.permissionMode)) throw new UserError(`Unknown permission mode "${opts.permissionMode}".`);
    const effort = chosenEffort(opts.effort);
    const account = this.chatAccount(opts.account);
    const workDir = this.chatFolder(opts.folder);
    let profile: string;
    try {
      // The full profile unless one is chosen: the config's defaults are for project sessions.
      profile = chooseProfile(opts.profile, 'session', undefined, {}, this.profilesFor(this.chatConfigOn(workDir, account)).profiles);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const project = this.chatConfigOn(workDir, account);
    if (project.account) {
      try {
        this.accounts.envFor(project.account);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
    }
    const info = this.store.createSession({
      id: randomUUID(), project: CHATS, runner: 'local', role: 'session', title: 'New chat', parentId: null,
      permissionMode: opts.permissionMode ?? project.permissionMode ?? 'auto', requestedModel: opts.model?.trim() || null, requestedEffort: effort, profile, workDir,
    });
    if (project.account) this.store.updateSession(info.id, { account: project.account });
    this.publish({ type: 'session', session: info });
    const session = new Session({ info, ...this.sessionOptions(project, info) });
    this.noteLaunch(project, info);
    this.live.set(info.id, session);
    let textHeld = false;
    const now = await this.admitted(info.id, async () => {
      if (this.store.getSession(info.id)?.status === 'ended') return;
      await session.start();
      if (!textHeld && opts.text?.trim() && this.store.getSession(info.id)?.status !== 'ended') session.send(opts.text);
    });
    // Waiting for memory: the chat's first message is held at once, as for a session (finding 3).
    if (!now && opts.text?.trim()) {
      session.send(opts.text);
      textHeld = true;
    }
    return session.info;
  }

  /** New chat's account (issue #119): a known one by name, "default" or "" for the computer's own login, left out for Settings' choice. */
  private chatAccount(wanted: unknown): string | null {
    if (wanted === undefined || wanted === null) return this.accountChoices().chats;
    if (typeof wanted !== 'string') throw new UserError('An account is chosen by its name.');
    const name = wanted.trim();
    if (!name || name === DEFAULT_ACCOUNT) return null;
    if (!this.accounts.get(name)) throw new UserError(`There is no account named "${name}".`);
    return name;
  }

  private runnerFor(project: ProjectConfig, info: SessionInfo): Runner {
    return project.runner === 'local' ? new LocalRunner(project, info.workDir, this.config.claudeExecutable) : new DockerRunner(project, info.id, info.workDir);
  }

  /**
   * The session's own folder as start_session asks for it: checked against the project folder and its
   * extra folders, as a real path; null for the project folder (decision of 2026-10-14). Only local
   * projects: a container's folders would need their own checks inside the container.
   */
  private workFolder(project: ProjectConfig, wanted: string | undefined, runWorktree = false): string | null {
    if (wanted === undefined || !wanted.trim()) return null;
    // A container session may work in its run's worktree, and only there (workflow part 3f): Ledung made it inside the
    // project folder, so it is checked by its form; the runner checks it is there before every start.
    if (project.runner !== 'local' && runWorktree && path.posix.relative(project.pathInContainer, wanted).match(/^\.ledung\/worktrees\/run-\d+$/)) return wanted;
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
    // A run's session in its worktree, in a container too (review of 3f: its resume was refused).
    const again = info.project === CHATS ? this.chatFolder(info.workDir) : this.workFolder(project, info.workDir, !!info.runBlock);
    if (again === null || path.relative(again, info.workDir) !== '') {
      throw new UserError(`The session's folder ${info.workDir} no longer leads to the same folder; start a new session.`);
    }
  }

  /** Starts a session, or a manager (role), optionally under a manager (parentId). */
  async start(
    projectName: string,
    firstMessage?: string,
    opts: {
      role?: SessionRole; parentId?: string; title?: string; permissionMode?: PermissionMode; model?: string; profile?: string; cwd?: string; here?: boolean; before?: string;
      /** One of Claude Code's effort levels (issue #202); an unknown one is refused before anything starts. */
      effort?: string;
      /** A block's session (workflow part 3b): the run and block it serves, and the heading of its task in place of the manager's. */
      runBlock?: RunBlock; intro?: string;
      /** `cwd` is its run's worktree (part 3f): allowed in a container project too. */
      runWorktree?: boolean;
    } = {},
  ): Promise<SessionInfo> {
    const project = this.project(projectName);
    const effort = chosenEffort(opts.effort);
    // Managers work in the project folder, so the project keeps one place for its manager.
    if (opts.cwd !== undefined && opts.role === 'manager') throw new UserError('A manager always works in the project folder.');
    const workDir = this.workFolder(project, opts.cwd, opts.runWorktree === true);
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
      requestedModel: opts.model?.trim() || null, requestedEffort: effort, profile, workDir,
    });
    if (project.account) this.store.updateSession(info.id, { account: project.account });
    if (opts.runBlock) this.store.updateSession(info.id, { runBlock: opts.runBlock });
    this.publish({ type: 'session', session: this.store.getSession(info.id)! });
    if (role === 'manager') {
      this.projectStore.setManager(project.name, info.id);
      this.publishProjects();
    }
    const session = new Session({ info, ...this.sessionOptions(project, info) });
    this.noteLaunch(project, info);
    this.live.set(info.id, session);
    // The person's first message, when the session has to wait for memory, is held at once: before anything typed
    // while it waits, and naming it (acceptance test, finding 3).
    let firstHeld = false;
    const begin = async () => {
      if (this.store.getSession(info.id)?.status === 'ended') return;
      await session.start();
      if (!firstHeld) this.deliverFirst(session, info.id, firstMessage, opts);
    };
    if (!(await this.admitted(info.id, begin, { text: firstMessage, parentId: opts.parentId })) && firstMessage?.trim() && !opts.parentId) {
      session.send(firstMessage, opts.here === true);
      firstHeld = true;
    }
    return session.info;
  }

  /**
   * A new session starts at once, or under a memory limit waits in the resource line until it fits (resource limits,
   * point 9): then the caller gets it back still "starting", and it starts when there is room. True: started.
   */
  private async admitted(id: string, begin: () => Promise<void>, first?: { text?: string; parentId?: string }): Promise<boolean> {
    const session = this.live.get(id);
    let started: Promise<void> = Promise.resolve();
    const now = this.book.admitSession(id, () => {
      this.forgetWaiter(id);
      if (session) session.waitingToStart = false;
      started = begin().then(() => session?.deliver());
      started.catch((e: Error) => console.error(`Starting session ${id}: ${e.message}`));
    });
    if (!now) {
      // While it waits, the person's messages are held for its start (acceptance test, finding 3), and it is kept on
      // record so a restart of Ledung can say why it never ran and give its manager the task back (finding 12).
      if (session) session.waitingToStart = true;
      this.keepWaiter(id, first);
      this.publish({ type: 'message', message: this.store.addMessage(id, 'event', { text: 'Waiting for memory before starting: see the line under the Machine bars. Messages you send now go in once it starts.' }) });
      return false;
    }
    await started;
    return true;
  }

  private waitersOnRecord(): { id: string; text?: string; parentId?: string }[] {
    try {
      const v = JSON.parse(this.store.getMeta(WAITERS_KEY) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private keepWaiter(id: string, first?: { text?: string; parentId?: string }): void {
    this.store.setMeta(WAITERS_KEY, JSON.stringify([...this.waitersOnRecord().filter((w) => w.id !== id), { id, text: first?.text?.slice(0, 20000), parentId: first?.parentId }]));
  }

  private forgetWaiter(id: string): void {
    const list = this.waitersOnRecord();
    if (list.some((w) => w.id === id)) this.store.setMeta(WAITERS_KEY, JSON.stringify(list.filter((w) => w.id !== id)));
  }

  /**
   * After a restart of Ledung: sessions that were still waiting for memory never ran, so they can't be resumed. Their
   * end reason says so, and a manager that started one gets its task back to start it again (finding 12).
   */
  settleWaitersAfterRestart(): void {
    for (const w of this.waitersOnRecord()) {
      const info = this.store.getSession(w.id);
      if (!info || info.claudeSessionId) continue;
      this.store.updateSession(w.id, { status: 'ended', endReason: 'It was waiting for memory to start when Ledung restarted, so it never ran. Start a new one.' });
      if (w.parentId && this.store.getSession(w.parentId)) {
        this.store.addInbox(w.parentId, 'ledung', `Your session "${info.title}" (${w.id}) was still waiting for memory to start when Ledung restarted, so it never ran. Start it again if it is still needed.${w.text ? ` Its task was:\n\n${w.text}` : ''}`);
        void this.resumeIfEnded(w.parentId).then(() => this.live.get(w.parentId!)?.deliver(), () => {});
      }
    }
    this.store.setMeta(WAITERS_KEY, '[]');
  }

  /** The first message of a new session (start), once it runs. */
  private deliverFirst(session: Session, id: string, firstMessage: string | undefined, opts: { parentId?: string; title?: string; before?: string; intro?: string; here?: boolean }): void {
    const info = { id };
    if (firstMessage?.trim() && this.store.getSession(info.id)?.status !== 'ended') {
      if (opts.parentId) {
        // From a manager: delivered as context, so it never passes for the user's words (step 4).
        // Only while it is still "New session": a name the user gave it during start-up stays (#223, review of PR #224).
        if (!opts.title && this.store.getSession(info.id)?.title === 'New session') this.store.updateSession(info.id, { title: firstMessage.replace(/\s+/g, ' ').trim().slice(0, 80) });
        const manager = this.store.getSession(opts.parentId);
        // An order's words come first, before anything of the manager's (issue #105).
        this.store.addInbox(info.id, `manager:${opts.parentId}`, `${opts.before ? `${opts.before}

` : ''}${opts.intro ?? `Your task, from your manager "${manager?.title ?? 'manager'}":`}

${firstMessage}`);
        session.deliver();
      } else {
        session.send(firstMessage, opts.here === true);
      }
    }
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
    // Its secrets for this session go with it, but those kept until removed (issue #468).
    void this.secrets?.endSession(id).catch((e) => console.error(`Secrets of ${id}: ${(e as Error).message}`));
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
   * A container project's is read in its container (issue #122).
   */
  async readFile(sessionId: string, link: string, folder?: PaneFolderKey): Promise<ProjectFile> {
    const { project, root } = this.paneRoot(sessionId, folder);
    if (project.runner === 'docker') return this.fromContainer(() => readContainerText(this.containerAccess(project), root, link));
    return this.readFrom(sessionId, link, readProjectFile, folder);
  }

  /**
   * A PNG or JPEG from the session's project folder, read-only, for the file viewer; from its container for a
   * container project. A copy Ledung kept for a question ("container:...") is read from the copies.
   */
  async readImage(sessionId: string, link: string, folder?: PaneFolderKey): Promise<ProjectImage> {
    if (link.startsWith(LINKED_FILE_PREFIX)) {
      const copy = this.readLinkedCopy(sessionId, link, ['png', 'jpeg']);
      return { path: copy.path, type: copy.kind === 'png' ? 'image/png' : 'image/jpeg', bytes: copy.bytes };
    }
    if (link.startsWith(CONTAINER_FILE_PREFIX)) {
      const copy = this.readContainerCopy(sessionId, link, ['png', 'jpeg']);
      return { path: copy.path, type: copy.kind === 'png' ? 'image/png' : 'image/jpeg', bytes: copy.bytes };
    }
    const { project, root } = this.paneRoot(sessionId, folder);
    if (project.runner === 'docker') return this.fromContainer(() => readContainerImage(this.containerAccess(project), root, link));
    return this.readImageHere(sessionId, link, folder);
  }

  private readImageHere(sessionId: string, link: string, folder?: PaneFolderKey): ProjectImage {
    return this.readFrom(sessionId, link, readProjectImage, folder);
  }

  // --- A container project's files (issue #122) --------------------------------------------------------

  /** How a container project's files are read; tests put a fake in its place. */
  containerExecFor: (project: DockerProjectConfig) => ContainerExec = (project) => new DockerRunner(project, 'files').fileExec();
  /** Where the copies of container files for questions are kept. */
  containerCopiesDir = (): string => path.join(userDataDir(), 'container-files');
  /** Where copies of files from linked computers are kept (issue #158); tests move it. */
  linkedFilesDir = (): string => path.join(userDataDir(), 'linked-files');
  /** Where snapshots of files streamed to linked computers wait to be fetched (issue #159); tests move it. */
  linkedOutboxDir = (): string => path.join(userDataDir(), 'linked-outbox');

  // --- Files between managers on linked computers (issue #158) ----------------------------------------

  /** A copy a manager on a linked computer sent this session, by its handle: only the manager it was sent to. */
  private readLinkedCopy(sessionId: string, handle: string, kinds: readonly AttachmentKind[]): { path: string; kind: AttachmentKind; bytes: Buffer } {
    try {
      return this.linkedFiles.read(sessionId, handle, kinds);
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
  }

  /**
   * save_linked_file (issue #160): the copy `handle` names, which a linked computer sent `managerId`, written into the
   * worktree `sessionId` works in now. Management checked the session is the manager's own and neither project is
   * locked; here, in the refine notes' order: the copy (its own, delivered, not pruned, bytes unchanged), the folder
   * (a container's is inside the container: not yet), then the path and the write (src/sessions/save-file.ts).
   */
  saveLinkedFile(managerId: string, sessionId: string, handle: string, rel: string): Saved {
    // A streamed copy (issue #159) by its file, never read whole; the writer checks its copy's SHA-256 against it.
    let copy: ReturnType<LinkedFiles['source']>;
    try {
      copy = this.linkedFiles.source(managerId, handle);
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
    const { info, project } = this.paneSession(sessionId);
    if (project.runner !== 'local') throw new UserError(`"${info.title}" works in a container project; saving a file from a linked computer into a container is not available yet. Nothing was saved.`);
    const rules = {
      pathPatterns: [...this.config.sensitive.pathPatterns, ...project.sensitive.pathPatterns],
      refused: this.lockedFoldersBesides(info.project),
    };
    let saved: Saved;
    try {
      // The bytes read() returned and checked; the data folder is not read again after the checks (refine notes, 6).
      saved = saveIntoWorktree(this.sessionFolder(info, project), rel, copy.kind, 'bytes' in copy ? copy.bytes : { file: copy.file, sha: copy.sha }, rules);
    } catch (e) {
      throw e instanceof FileError ? new UserError(`Not saved: ${e.message}`) : e;
    }
    if (!exercised160) {
      exercised160 = true;
      exercisedLine('EXERCISED #160 a file from a linked computer saved into a session\'s worktree');
    }
    return saved;
  }

  /**
   * The files a manager sends to a linked computer: from its own folder with the file viewer's rules (readFrom), PNG,
   * JPEG or text by their first bytes, then the board's outgoing checks with the project's sensitive patterns and the
   * locked secrets. The reason for the first that can't go; nothing is sent then.
   */
  private outgoingFiles(managerId: string, names: string[]): (OutgoingFile | OutgoingStream)[] {
    const rules = this.outgoingRules(managerId);
    return names.map((name) => {
      let f: OutgoingFile | OutgoingStream;
      try {
        f = this.readFrom(managerId, name.trim().replace(/\\/g, '/'), linkOutgoing);
      } catch (e) {
        throw new UserError(`Not sent: attachment ${name}: ${(e as Error).message}`);
      }
      // Audio or a zip (issue #159): its path checked now, as an image's is; a zip's entries on the snapshot.
      if ('streamed' in f) {
        const sensitive = sensitiveInText(f.inside, rules);
        if (sensitive) throw new UserError(`Not sent: attachment ${f.inside}: ${sensitive}, one of the project's sensitive patterns.`);
        return f;
      }
      const found = outgoingFinding(f, rules, (text) => this.secrets?.holdsValue(text) ?? false);
      if (!found) return f;
      if ('sensitive' in found) throw new UserError(`Not sent: attachment ${f.inside}: ${found.sensitive}, one of the project's sensitive patterns.`);
      if ('locked' in found) throw new UserError(`Not sent: attachment ${f.inside} contains a secret locked in Ledung. Leave it out.`);
      throw new UserError(`Not sent: attachment ${f.inside} contains what looks like ${found.token}. Leave it out.`);
    });
  }

  /** The sensitive patterns a manager's outgoing files are checked against: the config's and its project's. */
  private outgoingRules(managerId: string): { commandPatterns: string[]; pathPatterns: string[] } {
    const info = this.store.getSession(managerId);
    if (!info) throw new UserError('No such session.');
    const project = this.projectStore.get(info.project)?.config;
    return {
      commandPatterns: [...this.config.sensitive.commandPatterns, ...(project?.sensitive.commandPatterns ?? [])],
      pathPatterns: [...this.config.sensitive.pathPatterns, ...(project?.sensitive.pathPatterns ?? [])],
    };
  }

  /**
   * A streamed file's snapshot for the linked computer `linkId`'s manager `toId` (issue #159), made from the file the
   * checks above passed; a zip is then checked entry by entry on the snapshot, so what was checked is what is fetched.
   * Refused: the snapshot goes again, and the reason names the entry.
   */
  private async snapshotOutgoing(managerId: string, linkId: string, toId: string, f: OutgoingStream): Promise<StreamOffer> {
    let offer: StreamOffer;
    try {
      offer = await this.linkedOutbox.snapshot(f.real, { linkId, from: managerId, to: toId, name: f.name, inside: f.inside, kind: f.kind });
    } catch (e) {
      throw new UserError(`Not sent: attachment ${f.inside}: ${(e as Error).message}`);
    }
    if (f.kind !== 'zip') return offer;
    const rules = this.outgoingRules(managerId);
    const problem = await zipProblem(this.linkedOutbox.fileOf(linkId, offer.id, offer.kind), {
      name: (entry) => sensitiveInText(entry, { commandPatterns: [], pathPatterns: rules.pathPatterns }),
      text: (entry, text) => {
        const found = outgoingFinding({ inside: entry, text }, rules, (t) => this.secrets?.holdsValue(t) ?? false);
        if (!found) return null;
        if ('sensitive' in found) return `${found.sensitive}, one of the project's sensitive patterns`;
        if ('locked' in found) return 'it contains a secret locked in Ledung';
        return `it contains what looks like ${found.token}`;
      },
    });
    if (problem) {
      this.linkedOutbox.drop([offer.id]);
      throw new UserError(`Not sent: attachment ${f.inside}: ${problem}. Nothing was sent.`);
    }
    return offer;
  }

  /**
   * /link/file-get from the linked computer `linkId` (issue #159): the snapshot its message named, for the manager it
   * named, while the sending manager's project is not locked. The file to stream and its size.
   */
  linkFileGet(linkId: string, query: URLSearchParams): { file: string; size: number; id: string } {
    return this.linkedOutbox.serve(linkId, query, (session) => {
      const s = this.store.getSession(session);
      const project = s ? this.projectStore.get(s.project)?.config : undefined;
      return !!project && lockdownOf(project).level !== 'off';
    });
  }

  /** A streamed file's bytes went to the linked computer `linkId` (issue #159): counted; read to its end, noted. */
  linkFileSent(linkId: string, id: string, bytes: number, toEnd: boolean): void {
    this.linkedFiles.count(linkId, 'sent', bytes);
    if (toEnd) this.linkedOutbox.fetched(id);
  }

  /**
   * /link/file from the linked computer `linkId` (issue #158): only for a manager here whose project is not locked
   * (Martin, question #598), checked and kept as pending until the message naming it comes. Its id back.
   */
  linkFile(linkId: string, query: URLSearchParams, bytes: Buffer): { id: string } {
    const meta = parseFileMeta(query);
    const to = this.store.getSession(meta.to);
    if (!to || to.role !== 'manager') throw new LinkedFileError(400, `${meta.to.slice(0, 100)} is not a manager there. Use list_managers with that computer.`);
    const project = this.projectStore.get(to.project)?.config;
    if (project && lockdownOf(project).level !== 'off') throw new LinkedFileError(403, 'No files go to or from a locked project; not sent. Send the message without them.');
    return { id: this.linkedFiles.receive(linkId, meta, bytes) };
  }

  /** The bytes of files sent to and received from a linked computer, today and this month (issue #158). */
  linkBytes(linkId: string): ByteTotals {
    return this.linkedFiles.totals(linkId);
  }

  /**
   * The project's exec and the rules besides its folder: every other locked project's folder in the same container
   * stays shut (lockdown, issue #109), and the sensitive path patterns (the config's and the project's) are not shown.
   */
  private containerAccess(project: DockerProjectConfig): ContainerAccess {
    const locked = this.projectStore.list().map((p) => p.config)
      .filter((p): p is DockerProjectConfig => p.name !== project.name && p.runner === 'docker' && p.container === project.container && isLocked(p))
      .map((p) => p.pathInContainer);
    return {
      exec: this.containerExecFor(project), container: project.container, project: project.pathInContainer, locked,
      pathPatterns: [...this.config.sensitive.pathPatterns, ...project.sensitive.pathPatterns],
    };
  }

  private async fromContainer<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
  }

  /** A copy kept for one of the session's project's questions, by the name the question stores. */
  private readContainerCopy(sessionId: string, ref: string, kinds: readonly ('png' | 'jpeg' | 'text')[]): { path: string; kind: 'png' | 'jpeg' | 'text'; bytes: Buffer } {
    const info = this.store.getSession(sessionId);
    if (!info) throw new UserError('No such session.');
    try {
      return readCopy(this.containerCopiesDir(), info.project, ref, kinds);
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
  }

  /**
   * ask_user's screenshots and a review's evidence from a container project: read from the container now, with the
   * file viewer's rules and the attachment limits, and kept in Ledung, so the question's page shows them later with
   * the container stopped too. Each comes back as the name the question stores; a local project's come back as given.
   */
  private async keepContainerFiles(sessionId: string, files: { file: string; as: 'shot' | 'evidence' }[]): Promise<string[]> {
    const info = this.store.getSession(sessionId);
    if (!info) throw new UserError('No such session.');
    const project = this.configOf(info);
    if (project.runner !== 'docker') return files.map((f) => f.file);
    const access = this.containerAccess(project);
    const root = info.workDir ?? project.pathInContainer;
    this.pruneContainerCopies(info.project);
    const kept: string[] = [];
    const count = { shot: 0, evidence: 0 };
    for (const f of files) {
      const n = ++count[f.as];
      try {
        kept.push(await this.keepContainerFile(access, root, info.project, f));
      } catch (e) {
        if (!(e instanceof FileError)) throw e;
        // As ask's own checks say it (management.ts), so the session can fix it.
        throw new UserError(`${f.as === 'shot' ? 'Screenshot' : 'Evidence'} ${n} (${f.file}) can't be attached: ${e.message} Nothing was asked.`);
      }
    }
    return kept;
  }

  /**
   * Copies no question names, kept over a day, go (security review of #122, finding 3): those of an ask that was then
   * refused, or one asked again with other files. At most once an hour per project.
   */
  private prunedCopies = new Map<string, number>();
  private pruneContainerCopies(project: string): void {
    const now = Date.now();
    if (now - (this.prunedCopies.get(project) ?? 0) < 60 * 60 * 1000) return;
    this.prunedCopies.set(project, now);
    try {
      pruneCopies(this.containerCopiesDir(), project, this.store.containerCopyRefs(), now - 24 * 60 * 60 * 1000);
    } catch (e) {
      console.error(`Container file copies of ${project}: ${(e as Error).message}`);
    }
  }

  private async keepContainerFile(access: ContainerAccess, root: string, project: string, f: { file: string; as: 'shot' | 'evidence' }): Promise<string> {
    if (f.file.startsWith(BOARD_FILE_PREFIX) || f.file.startsWith(CONTAINER_FILE_PREFIX) || f.file.startsWith(LINKED_FILE_PREFIX)) return f.file;
    if (f.as === 'shot') {
      const image = await readContainerImage(access, root, f.file, CONTAINER_IMAGE_MAX_BYTES);
      return keepCopy(this.containerCopiesDir(), project, image.path, image.bytes);
    }
    // Evidence: the kinds and limits of an attachment (src/board/attachments.ts), by the real file's name and first bytes;
    // a text file named as one is read only up to its own limit.
    const max = /\.(md|txt|log)$/i.test(f.file) ? EVIDENCE_TEXT_MAX_BYTES : EVIDENCE_IMAGE_MAX_BYTES;
    const ev = await readContainerBytes(access, root, f.file, max, (inside) => (/\.(png|jpe?g|md|txt|log)$/i.test(inside) ? null : `${inside} is not a PNG or JPEG image or a .txt, .log or .md text file.`));
    const kind = bytesKind(ev.bytes, ev.path);
    if (!kind) throw new FileError(/\.(png|jpe?g)$/i.test(ev.path) ? `${ev.path} is not really a ${/\.png$/i.test(ev.path) ? 'PNG' : 'JPEG'} image.` : `${ev.path} is not a text file.`);
    if (kind === 'text' && ev.bytes.length > EVIDENCE_TEXT_MAX_BYTES) throw new FileError(`${ev.path} is too large (${Math.round(ev.bytes.length / 1024)} KB; a text file is at most 512 KB).`);
    return keepCopy(this.containerCopiesDir(), project, ev.path, ev.bytes);
  }

  // --- The Files pane (issue #225, a test feature) --------------------------------------------------

  /** A session and its project. */
  private paneSession(sessionId: string): { info: SessionInfo; project: ProjectConfig } {
    const info = this.store.getSession(sessionId);
    if (!info) throw new UserError('No such session.');
    return { info, project: this.configOf(info) };
  }

  /**
   * Where the session works now: the worktree it entered itself with EnterWorktree, when that is still a
   * folder the project allows (start_session's rules); else its own folder or the project folder. Ledung
   * starts a worker in the project folder and the worker moves itself, so only the session knows (#225).
   */
  private sessionFolder(info: SessionInfo, project: ProjectConfig): string {
    // A container session works in the project folder or the run's worktree Ledung gave it (workflow part 3f).
    if (project.runner === 'docker') return info.workDir ?? project.pathInContainer;
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
    const projectFolder = project.runner === 'docker' ? project.pathInContainer : project.path;
    if (info.project !== CHATS && (project.runner === 'docker' ? path.posix.relative(own, projectFolder) !== '' : !same(own, projectFolder))) {
      folders[0]!.label = "This session's worktree";
      folders.push({ key: 'project', path: projectFolder, label: 'Project folder' });
    }
    return { folders };
  }

  private paneRoot(sessionId: string, folder: PaneFolderKey | undefined): { info: SessionInfo; project: ProjectConfig; root: string } {
    const { info, project } = this.paneSession(sessionId);
    const projectFolder = project.runner === 'docker' ? project.pathInContainer : project.path;
    if (folder === 'project' && info.project !== CHATS) return { info, project, root: projectFolder };
    return { info, project, root: folder === 'session' ? this.sessionFolder(info, project) : info.workDir ?? projectFolder };
  }

  /** One folder of the tree, with the viewer's rules (src/sessions/tree.ts). */
  async listFolder(sessionId: string, folder: PaneFolderKey, rel: string): Promise<TreeListing> {
    const { info, project, root } = this.paneRoot(sessionId, folder);
    if (project.runner === 'docker') return this.fromContainer(() => listContainerFolder(this.containerAccess(project), root, rel));
    try {
      // A chat's folder can be anywhere under the browse roots, so it gets the viewer's chat rules (#211, question
      // #317); a project's own folder may itself sit under AppData, as the viewer allows, so a project keeps only
      // Ledung's own data folder shut, for a project folder that holds it (Project-Ledung#474).
      const chat = info.project === CHATS;
      const refused = [...(chat ? this.settingsFolders() : [userDataDir()]), ...this.lockedFoldersBesides(info.project)];
      return await listTree(root, rel, { refused, hiddenFrom: chat ? this.allowedFolders() : [] });
    } catch (e) {
      throw e instanceof FileError ? new UserError(e.message) : e;
    }
  }

  /** What the session changed, in the folder it works in (src/sessions/changes.ts). */
  async changes(sessionId: string): Promise<SessionChanges> {
    const { info, project } = this.paneSession(sessionId);
    const own = this.sessionFolder(info, project);
    if (project.runner === 'docker') {
      // git runs in the container, hardened as here (src/sessions/container-files.ts); docker's failure is said plainly.
      const access = this.containerAccess(project);
      return this.fromContainer(() => sessionChanges(own, { hidden: diffHidden(access, own), git: (args, o) => containerGit(access, own, args, o) }));
    }
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
    const { info, project, root } = this.paneRoot(sessionId, folder);
    // A container's files are read in the container (readFile, readImage, keepContainerFiles); not from this computer's disk.
    if (project.runner !== 'local') throw new UserError('Attaching files from a container project here is not available yet.');
    try {
      if (info.project === CHATS) {
        // Also Windows' AppData, macOS's Library and Ledung's own data folder, wherever it is (Martin, question #317).
        const hidden = hiddenProblem(root, link, this.allowedFolders(), this.settingsFolders());
        if (hidden) throw new UserError(hidden);
      }
      // Both checks below on the file's real path, so a link inside the folder can't lead around them (Project-Ledung#474).
      const real = realTarget(root, link);
      // Ledung's data folder stays shut to a project's session too, as it is to a chat's, wherever the project is.
      if (real && info.project !== CHATS && nativeWithin(userDataDir(), real)) {
        throw new UserError("That file is in Ledung's data folder, where its settings and sign-ins are kept; it is not shown.");
      }
      // Through the Files pane, a locked project's folder stays shut as in its tree (issue #225).
      if (folder && real && this.lockedFoldersBesides(info.project).some((f) => nativeWithin(f, real))) {
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
  /** images: names of images uploaded to this session (issue #128); only the person's own messages from the page carry them. */
  async send(id: string, text: string, here = false, images?: unknown): Promise<void> {
    let names: string[] = [];
    if (images !== undefined && images !== null) {
      if (!this.store.getSession(id)) throw new UserError('No such session.');
      try {
        names = this.images().check(id, images);
      } catch (e) {
        throw e instanceof ChatImageError ? new UserError(e.message) : e;
      }
    }
    if (!text.trim() && !names.length) throw new UserError('The message is empty.');
    // A command (/clear, /compact…) is run from text alone; with images it would be neither (security review of #128).
    if (names.length && text.trimStart().startsWith('/')) throw new UserError('A command starting with "/" can\'t carry images; send them in a message of their own.');
    await this.resumeIfEnded(id);
    this.liveSession(id).send(text, here, names);
  }

  /** Resumes the session if it has ended (or isn't live); a resume already under way is waited for. */
  async resumeIfEnded(id: string): Promise<void> {
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    if (!this.resuming.has(id) && this.live.has(id) && info.status !== 'ended') return;
    const after = await this.resume(id);
    if (after.status === 'ended') throw new UserError(`The session could not be resumed: ${after.endReason ?? 'unknown reason'}`);
  }

  /**
   * The sidebar menu's Change model: opus, sonnet, haiku, or null for the project's default. A running session
   * changes from its next reply; an ended one keeps it for its resume. Either way it is the session's
   * requestedModel, which a resume starts with, as start_session's model is.
   */
  async setModel(id: string, model: unknown): Promise<SessionInfo> {
    if (model !== null && !MODEL_CHOICES.includes(model as ModelChoice)) throw new UserError(`Choose ${MODEL_CHOICES.join(', ')} or the project's default.`);
    const chosen = model as ModelChoice | null;
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    if (info.status === 'stopping') throw new UserError('The session is stopping; change its model once it has ended.');
    const live = this.live.get(id);
    if (live && info.status !== 'ended') {
      try {
        await live.setModel(chosen, 'user');
      } catch (e) {
        throw new UserError(`Could not change the model: ${(e as Error).message}`);
      }
      return live.info;
    }
    if (chosen !== info.requestedModel) {
      this.store.updateSession(id, { requestedModel: chosen });
      this.publish({ type: 'message', message: this.store.addMessage(id, 'event', { text: `Model set to ${chosen ?? "the project's default"} by ${this.config.userName}; it applies when the session is resumed.` }) });
      this.publish({ type: 'session', session: this.store.getSession(id)! });
    }
    return this.store.getSession(id)!;
  }

  /**
   * The sidebar menu's Effort (issue #202): one of Claude Code's levels, or null for the project's default. As
   * setModel: a running session changes from its next reply, an ended one keeps it for its resume; either way it is
   * the session's requestedEffort, which a resume starts with, as start_session's effort is.
   */
  async setEffort(id: string, effort: unknown): Promise<SessionInfo> {
    const chosen = effort === null ? null : effortLevel(effort);
    if (effort !== null && !chosen) throw new UserError(`${unknownEffort(effort)} Or null for the project's default.`);
    const info = this.store.getSession(id);
    if (!info) throw new UserError('No such session.');
    if (info.status === 'stopping') throw new UserError('The session is stopping; change its effort once it has ended.');
    const live = this.live.get(id);
    if (live && info.status !== 'ended') {
      try {
        await live.setEffort(chosen, 'user');
      } catch (e) {
        throw new UserError(`Could not change the effort: ${(e as Error).message}`);
      }
      return live.info;
    }
    if (chosen !== (info.requestedEffort ?? null)) {
      this.store.updateSession(id, { requestedEffort: chosen });
      this.publish({ type: 'message', message: this.store.addMessage(id, 'event', { text: `Effort set to ${chosen ?? "the project's default"} by ${this.config.userName}; it applies when the session is resumed.` }) });
      this.publish({ type: 'session', session: this.store.getSession(id)! });
    }
    return this.store.getSession(id)!;
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
    // One still waiting for memory to start is taken out of the line and ends; it never ran (resource limits).
    if (this.book.dropWaiter(id)) {
      this.forgetWaiter(id);
      this.store.updateSession(id, { status: 'ended', endedAt: Date.now(), endReason: reason });
      this.publish({ type: 'message', message: this.store.addMessage(id, 'event', { text: reason }) });
      this.publish({ type: 'session', session: this.store.getSession(id)! });
      this.live.delete(id);
      return;
    }
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

/**
 * The project's effort for a session of this role (issue #202), as defaultModelFor: a manager has its own; empty:
 * the sessions'. None at all: no effort is passed, so Claude Code takes its own default.
 */
export function defaultEffortFor(project: Pick<ProjectConfig, 'effort' | 'managerEffort'>, role: SessionRole): EffortLevel | undefined {
  return (role === 'manager' && project.managerEffort) || project.effort || undefined;
}

/** A start's effort as given: none (left out, null or blank), or one of the levels; anything else is refused with the levels there are. */
function chosenEffort(value: unknown): EffortLevel | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  const level = effortLevel(value);
  if (!level) throw new UserError(unknownEffort(value));
  return level;
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
    effort: c.effort ?? null,
    managerEffort: c.managerEffort ?? null,
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
    followFlow: c.followFlow !== false,
    worktreeSetup: c.worktreeSetup ?? null,
    managerId: p.managerId,
    createdAt: p.createdAt,
    colours: p.colours,
    lockdown: lockdownOf(c),
    skills: c.skills ?? {},
  };
}

/**
 * The real path a viewer link in `root` leads to (as readProjectFile reads it: #fragment dropped, maybe URL-encoded),
 * links resolved, or null when there is no such file; the read itself then says so. The native realpath gives the
 * long name and the case on disk on Windows, as the tree's checks use (Project-Ledung#474).
 */
function realTarget(root: string, link: string): string | null {
  let wanted = link.replace(/[?#].*$/, '');
  try {
    wanted = decodeURIComponent(wanted);
  } catch {
    // Not encoded; used as is, as readProjectFile does.
  }
  try {
    // From the root's real path by the same call readProjectFile uses, so ".." in the link means the same folder to both.
    return fs.realpathSync.native(path.resolve(fs.realpathSync(root), wanted));
  } catch {
    return null;
  }
}

/** Is the real path `real` the folder `folder` or inside it? Native real paths on both sides, as the tree compares. */
function nativeWithin(folder: string, real: string): boolean {
  let at: string;
  try {
    at = fs.realpathSync.native(folder);
  } catch {
    at = path.resolve(folder);
  }
  const rel = path.relative(at, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
