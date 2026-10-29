// Calls to Ledung's API. The sign-in cookie goes along automatically.
import type { Macro } from '../../src/shared/macros.ts';
import type {
  AwayInfo, AwayKind, BoardOwnersView, BoardPeopleView, BoardRepoChoicesView, BoardStatus, BoardThreadsView, BoardThreadView, ProjectBoardView,
  AccountChoices, AccountInfoView, ChatsInfo, ContainerInfoView, FolderListingView, MachineInfo, McpServerInfo, Overview, ProjectInfo, PermissionDecision, PermissionMode, Priority, ProjectFileView, TurnResource, TypicalCost, QuestionInfo, SessionInfo, SessionUsage, StoredMessage, UpdateView, UsageFilter, UsageReport, WorkflowCheckView,
  NewComputerInfo, RelayAdminView, RelayInviteInfo,
  ClaudeCodeView,
  ProfilesView,
  SkillListView, SignInProblem,
  ShortcutAction, ShortcutsView,
} from '../../src/shared/protocol.ts';
import type { ProjectColours } from '../../src/shared/name-colours.ts';
import type { ComputerColour, ComputerInfo } from '../../src/shared/computers.ts';
import type { PaneFolderKey, PaneFolders, SessionChanges, TreeListing } from '../../src/shared/files-pane.ts';
import type { LineComment } from '../../src/shared/line-comments.ts';
import type { SkillChoices } from '../../src/shared/skills.ts';
import type { SharedUsageView, UsagePublishView } from '../../src/shared/published-usage.ts';
/** The words Ledung refuses a request with when it needs the passkey (src/server/passkeys.ts). */
export const PASSKEY_NEEDED = 'This needs your passkey.';
/** The words for a device that has to unlock first (src/server/passkeys.ts). */
export const DEVICE_LOCKED = 'This device is locked: unlock it with its passkey to make changes from here.';
/** How Ledung's refusal of a change without a live page's key begins (src/server/server.ts, requireOpenPage). */
export const OPEN_PAGE_ONLY = "Only Ledung's open page can do this";
/** The page was opened through the public name (always HTTPS); locally it is plain http. */
const remotePage = (): boolean => (globalThis as { location?: { protocol: string } }).location?.protocol === 'https:';

/** The browser's passkey calls (web/src/passkey.ts), set by main.tsx; kept out of here so tests and the core type check need no DOM. */
export type PasskeyCalls = { sign(options: { challenge: string }): Promise<string>; create(options: { challenge: string }): Promise<unknown> };
let passkeys: PasskeyCalls | null = null;
export const setPasskeyCalls = (calls: PasskeyCalls | null) => {
  passkeys = calls;
};
const passkeyCalls = (): PasskeyCalls => {
  if (!passkeys) throw new Error('This browser has no passkeys.');
  return passkeys;
};

/** The words for a passkey check the person turned down, here or in the phone's own prompt. */
export const PASSKEY_CANCELLED = 'The passkey check was cancelled.';
/**
 * What the page shows around a passkey prompt (#179): before it, what is about to happen; after a check that
 * didn't go through, its reason and a retry. Resolves true to go on (Continue, Try again). Set by the page's
 * passkey dialog; without one (tests, a page with no dialog) the prompt comes straight away, as before.
 */
export type PasskeyStep = { kind: 'unlock' | 'sign'; failed?: string };
export type PasskeyPrompter = (step: PasskeyStep) => Promise<boolean>;
let prompter: PasskeyPrompter | null = null;
export const setPasskeyPrompter = (p: PasskeyPrompter | null) => {
  prompter = p;
};
/** A sign-only check is explained the first time on this page; an unlock (at most every 30 minutes) every time. */
let signExplained = false;
export const resetPasskeyExplained = () => {
  signExplained = false;
};

/** One passkey signature for exactly this request, explained first and retried while the person asks to. */
async function signFor(method: string, path: string, text: string): Promise<string> {
  // The unlock's notice also says the signature that may follow, so that one goes straight on (#179).
  const kind = path === '/api/device-unlock' ? 'unlock' : 'sign';
  if (prompter && (kind === 'unlock' || !signExplained)) {
    if (!(await prompter({ kind }))) throw new Error(PASSKEY_CANCELLED);
    // Only once read and accepted: after a Cancel the next signature is explained again (#184 review).
    signExplained = true;
  }
  for (;;) {
    // A fresh challenge each try: the last one may have run out while the phone's prompt was open.
    const options = await call<{ challenge: string }>('POST', '/api/passkey-challenge', { method, path, body: text });
    try {
      return await passkeyCalls().sign(options);
    } catch (e) {
      const failed = e instanceof Error ? e.message : String(e);
      if (!prompter || !(await prompter({ kind, failed }))) throw e;
    }
  }
}

/** A paired device as Settings lists it (issue #160). */
export type LinkedComputerInfo = { id: string; name: string; publicName: string; linkedAt: number; lastUsedAt: number | null };
export type DeviceInfo ={ id: string; name: string; createdAt: number; lastUsedAt: number | null; passkey: boolean; passkeyAt: number | null; kind: 'phone' | 'computer'; pairedVia?: string | null };

/** The live connection's key (#104): Ledung decides nothing sensitive without it. Null while there is no connection. */
let pageKey: string | null = null;
let keyWaiters: Array<(key: string) => void> = [];
/** A hello on the live connection brings its key. */
export const connectionHello = (key: string | null) => {
  pageKey = key;
  if (key) keyWaiters.splice(0).forEach((resolve) => resolve(key));
};
/** The connection closed and its key died with it; a change waits for the next hello's key. */
export const connectionClosed = () => {
  pageKey = null;
};
/**
 * Replaces a live connection that is dead without having closed (#303): set by the page, which owns the connection.
 * A computer that slept, or a framed page whose connection through the relay dropped at the far end, keeps a socket
 * the browser still thinks open: no close comes, so neither does a new key.
 */
let reconnect: (() => void) | null = null;
let live: WebSocket | null = null;
export const setReconnect = (fn: (() => void) | null) => {
  reconnect = fn;
};
/** Opens the live connection with its key's end tied to it here, where a test can drive it (#104 test review). */
export function openConnection(url: string): WebSocket {
  const ws = new WebSocket(url);
  live = ws;
  // Only the newest connection's close ends the key: a replaced one (#303) may close after its successor's hello.
  ws.addEventListener('close', () => {
    if (live === ws) connectionClosed();
  });
  return ws;
}

/** How long a change waits for the live connection to come back (a dropped connection, Restart Ledung). */
const KEY_WAIT_MS = 5000;

/** The live connection's key, waiting for the page to reconnect when it has none; null if it doesn't in time. */
function liveKey(): Promise<string | null> {
  if (pageKey) return Promise.resolve(pageKey);
  return new Promise((resolve) => {
    const got = (key: string) => {
      clearTimeout(timer);
      resolve(key);
    };
    const timer = setTimeout(() => {
      keyWaiters = keyWaiters.filter((w) => w !== got);
      resolve(null);
    }, KEY_WAIT_MS);
    keyWaiters.push(got);
  });
}

/** The words a refusal carries, read from a copy so the answer can still be read. */
const errorOf = async (res: Response): Promise<string | undefined> => ((await res.clone().json().catch(() => ({}))) as { error?: string }).error;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The exact text sent, once: through the public name a passkey signs its hash (#160).
  const text = body === undefined ? undefined : JSON.stringify(body);
  const send = (key: string | null, passkey?: string) => {
    const headers: Record<string, string> = text === undefined ? {} : { 'Content-Type': 'application/json' };
    if (key) headers['X-Ledung-Page'] = key;
    if (passkey) headers['X-Ledung-Passkey'] = passkey;
    return fetch(path, { method, credentials: 'same-origin', headers, body: text });
  };
  const change = method !== 'GET';
  let key = change ? await liveKey() : null;
  let res = await send(key);
  // Refused for the very key the page still holds: Ledung no longer has its connection, though no close reached
  // the page (#303). A new connection brings a new key; the old one is dropped, so it can't be used again.
  // Judged after reading the refusal, so of two changes refused together only the first replaces the connection.
  if (change && res.status === 403 && key && reconnect && (await errorOf(res))?.startsWith(OPEN_PAGE_ONLY) && pageKey === key) {
    connectionClosed();
    reconnect();
  }
  // Refused with a key that died with its connection (Restart Ledung, a dropped connection): Ledung refuses
  // before doing anything, so once the page has its new key the same request goes again, once (#104 review).
  if (change && res.status === 403 && pageKey !== key) {
    const fresh = await liveKey();
    if (fresh) res = await send((key = fresh));
  }
  // Through the public name, a page-key action also needs the passkey; Ledung refused before doing anything,
  // so the same request goes again with a signature over a challenge issued for exactly it.
  const refusal = async () => (change && remotePage() && res.status === 403 ? errorOf(res) : undefined);
  // Through the public name a device is read-only until its passkey unlocks it for 30 minutes (Martin,
  // 2026-10-17 12:54): refused as locked, the page unlocks (one passkey prompt) and sends the same request again.
  if ((await refusal()) === DEVICE_LOCKED) {
    await call('POST', '/api/device-unlock', {});
    res = await send(key);
  }
  if (change && remotePage() && res.status === 403) {
    if ((await refusal()) === PASSKEY_NEEDED) {
      res = await send(key, await signFor(method, path, text ?? ''));
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status}).`);
  return data as T;
}

export const api = {
  messages: (sessionId: string, beforeId?: number) =>
    call<StoredMessage[]>('GET', `/api/sessions/${sessionId}/messages?limit=500${beforeId ? `&before=${beforeId}` : ''}`),
  /** The messages after `afterId`, oldest first, at most 500: what a reconnecting page missed. */
  messagesAfter: (sessionId: string, afterId: number) =>
    call<StoredMessage[]>('GET', `/api/sessions/${sessionId}/messages?limit=500&after=${afterId}`),
  start: (project: string, profile?: string) => call<SessionInfo>('POST', '/api/sessions', { project, role: 'session', ...(profile ? { profile } : {}) }),
  /** A chat (issue #211): left out, the chats' default folder and mode, Claude Code's model and the full profile. */
  startChat: (opts: { folder?: string; model?: string; profile?: string; permissionMode?: PermissionMode }) => call<SessionInfo>('POST', '/api/chats-new', opts),
  updateChats: (sensitive: ChatsInfo['sensitive']) => call<ChatsInfo>('POST', '/api/chats', { sensitive }),
  setChatsColour: (colour: ChatsInfo['colour']) => call<ChatsInfo>('POST', '/api/chats-colour', { colour }),
  /** A computer tab's name or colour (issue #240); null: the config's again. */
  editComputer: (id: string, edit: { name?: string | null; colour?: ComputerColour | null }) => call<ComputerInfo[]>('POST', '/api/computers', { id, ...edit }),
  send: (sessionId: string, text: string) => call('POST', `/api/sessions/${sessionId}/messages`, { text }),
  /** A "!" command (issue #212): whether it is refused here, and the sensitive rule it matches, before it runs. */
  shellCheck: (sessionId: string, command: string) =>
    call<{ rule: string | null; refused: string | null }>('GET', `/api/sessions/${sessionId}/shell-check?command=${encodeURIComponent(command)}`),
  /** Runs it; through the public name signed with the passkey, each command on its own. */
  shell: (sessionId: string, command: string, confirmed: boolean) => call('POST', `/api/sessions/${sessionId}/shell`, { command, confirmed }),
  shellStop: (sessionId: string) => call('POST', `/api/sessions/${sessionId}/shell-stop`, {}),
  setPermissionMode: (sessionId: string, mode: PermissionMode) => call('POST', `/api/sessions/${sessionId}/permission-mode`, { mode }),
  interrupt: (sessionId: string) => call('POST', `/api/sessions/${sessionId}/interrupt`, {}),
  mcpServers: (sessionId: string) => call<McpServerInfo[]>('GET', `/api/sessions/${sessionId}/mcp`),
  reconnectMcp: (sessionId: string, name: string) => call<McpServerInfo[]>('POST', `/api/sessions/${sessionId}/mcp-reconnect`, { name }),
  stop: (sessionId: string) => call('POST', `/api/sessions/${sessionId}/stop`, {}),
  resume: (sessionId: string) => call<SessionInfo>('POST', `/api/sessions/${sessionId}/resume`, {}),
  archive: (sessionId: string) => call<SessionInfo>('POST', `/api/sessions/${sessionId}/archive`, {}),
  unarchive: (sessionId: string) => call<SessionInfo>('POST', `/api/sessions/${sessionId}/unarchive`, {}),
  /** A name of the user's own for a session, chat or manager (issue #223). */
  rename: (sessionId: string, title: string) => call<SessionInfo>('POST', `/api/sessions/${sessionId}/rename`, { title }),
  restart: () => call('POST', '/api/restart', {}),
  /** The first-run question and Settings → Shortcuts (issue #415). */
  shortcuts: () => call<ShortcutsView>('GET', '/api/shortcuts'),
  shortcutsAct: (action: ShortcutAction) => call<ShortcutsView>('POST', '/api/shortcuts', { action }),
  updateStatus: () => call<UpdateView>('GET', '/api/update'),
  updateCheck: () => call<UpdateView>('POST', '/api/update-check', {}),
  update: () => call<UpdateView>('POST', '/api/update', {}),
  /** Look the CAA record up now while Ledung waits for it (issue #202). */
  certificateCheck: () => call('POST', '/api/certificate-check', {}),
  // Join with a code and Leave this relay (issue #237).
  remoteLink: () => call<{ source: 'config' | 'joined' | null; publicName: string | null }>('GET', '/api/remote-link'),
  remoteJoin: (code: string) => call<{ publicName: string; record: string | null }>('POST', '/api/remote-join', { code }),
  remoteLeave: () => call('POST', '/api/remote-leave', {}),
  // Settings → Relay on the relay admin's Ledung (issue #237); the key and the token never come back.
  relayAdmin: () => call<RelayAdminView>('GET', '/api/relay-admin'),
  setRelayAdmin: (change: { relay?: string; cloudflareToken?: string }) => call<RelayAdminView>('POST', '/api/relay-admin', change),
  makeRelayAdminKey: () => call<RelayAdminView>('POST', '/api/relay-admin-key', {}),
  relayComputers: () => call<{ invites: RelayInviteInfo[]; computers: NewComputerInfo[] }>('GET', '/api/relay-computers'),
  relayInvite: (owner: string, name?: string) => call<RelayInviteInfo & { code: string }>('POST', '/api/relay-invite', { owner, ...(name ? { name } : {}) }),
  revokeRelayInvite: (id: string) => call('POST', `/api/relay-invites/${encodeURIComponent(id)}/revoke`, {}),
  approveComputer: (name: string) => call<{ record: string }>('POST', `/api/relay-computers/${encodeURIComponent(name)}/approve`, {}),
  /** Without a token: the admin added the record by hand, so the card goes. */
  computerAdded: (name: string) => call('POST', `/api/relay-computers/${encodeURIComponent(name)}/added`, {}),
  usage: (f: UsageFilter) =>
    call<UsageReport>('GET', `/api/usage?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString()}`),
  sessionUsage: (sessionId: string) => call<SessionUsage>('GET', `/api/sessions/${sessionId}/usage`),
  overview: () => call<Overview>('GET', '/api/overview'),
  answerQuestion: (id: number, answer: string) => call<QuestionInfo>('POST', `/api/questions/${id}/answer`, { answer }),
  withdrawQuestion: (id: number) => call('POST', `/api/questions/${id}/withdraw`, {}),
  /** A review's n-th evidence file, when it is text (docs/steps/pr-review.md). */
  evidenceText: (id: number, n: number) => call<{ file: string; content: string }>('GET', `/api/questions/${id}/evidence/${n}`),
  /** `folder`: which of the session's folders the Files pane means (issue #225); left out, as a chat link resolves. */
  file: (sessionId: string, path: string, folder?: PaneFolderKey) =>
    call<ProjectFileView>('GET', `/api/sessions/${sessionId}/file?path=${encodeURIComponent(path)}${folder ? `&in=${folder}` : ''}`),
  // The Files pane (issue #225, a test feature).
  paneFolders: (sessionId: string) => call<PaneFolders>('GET', `/api/sessions/${sessionId}/folders`),
  tree: (sessionId: string, folder: PaneFolderKey, path: string) =>
    call<TreeListing>('GET', `/api/sessions/${sessionId}/tree?in=${folder}&path=${encodeURIComponent(path)}`),
  changes: (sessionId: string) => call<SessionChanges>('GET', `/api/sessions/${sessionId}/changes`),
  sendLineComments: (sessionId: string, body: { verdict: 'accept' | 'changes' | null; text: string; comments: LineComment[] }) =>
    call<{ sentTo: string; reviewId: number | null }>('POST', `/api/sessions/${sessionId}/line-comments`, body),
  decide: (permissionId: string, decision: PermissionDecision) => call('POST', `/api/permissions/${permissionId}`, decision),
  projects: () => call<ProjectInfo[]>('GET', '/api/projects'),
  setProjectColours: (project: string, colours: ProjectColours) =>
    call<ProjectInfo>('POST', `/api/projects/${encodeURIComponent(project)}/colours`, colours),
  /** The sidebar order (issue #88): all projects, or one row's siblings, in their new order. */
  orderProjects: (names: string[]) => call<ProjectInfo[]>('POST', '/api/projects-order', { names }),
  orderSessions: (ids: string[]) => call('POST', '/api/sessions-order', { ids }),
  accounts: () => call<{ accounts: AccountInfoView[]; defaultIdentity: unknown; choices: AccountChoices; signedOut?: SignInProblem[]; claudeProblem?: string | null; configFileProblems?: string[] }>('GET', '/api/accounts'),
  /** Check again on the sign-in banner (issue #333). */
  checkSignIn: () => call('POST', '/api/signin-check'),
  addAccount: (a: { name: string; containerDir?: string }) => call<AccountInfoView>('POST', '/api/accounts', a),
  setAccountChoices: (c: Partial<AccountChoices>) => call<AccountChoices>('POST', '/api/account-choices', c),
  openAccountFolder: (name: string) => call('POST', `/api/accounts/${encodeURIComponent(name)}/open-folder`, {}),
  removeAccount: (name: string) => call('POST', `/api/accounts/${encodeURIComponent(name)}/remove`, {}),
  addProject: (settings: Record<string, unknown>) => call<ProjectInfo>('POST', '/api/projects', settings),
  createProject: (body: { parent?: string; github: boolean; task?: string; settings: Record<string, unknown> }) =>
    call<{ project: ProjectInfo; warning: string | null; githubUrl: string | null }>('POST', '/api/projects-new', body),
  updateProject: (name: string, settings: Record<string, unknown>) => call<ProjectInfo>('POST', `/api/projects/${encodeURIComponent(name)}`, settings),
  /** A new name (issue #116); only the open page can, so it goes with the page's key like every change. */
  renameProject: (name: string, to: string, settings?: Record<string, unknown>) =>
    call<ProjectInfo>('POST', `/api/projects/${encodeURIComponent(name)}/rename`, { name: to, ...(settings ? { settings } : {}) }),
  removeProject: (name: string) => call('POST', `/api/projects/${encodeURIComponent(name)}/remove`, {}),
  messageManager: (name: string, text: string) => call<SessionInfo>('POST', `/api/projects/${encodeURIComponent(name)}/manager`, { text }),
  browse: (path?: string) => call<FolderListingView>('GET', `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  containers: () => call<ContainerInfoView[]>('GET', '/api/containers'),
  /** The user's own skills where the project's sessions run (none: this computer's own login), and Settings' defaults (#300). */
  skills: (project?: string) => call<SkillListView>('GET', `/api/skills${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  setSkillDefaults: (choices: SkillChoices) => call<SkillChoices>('POST', '/api/skill-defaults', choices),
  setMacros: (macros: Macro[]) => call<Macro[]>('POST', '/api/macros', { macros }),
  /** The session profiles, where each comes from, and a workflow's profiles file that can't be used (#298). */
  profiles: () => call<ProfilesView>('GET', '/api/profiles'),
  /** Which Claude Code new sessions run, or why none can (#341); asking also refreshes the page's banner. */
  claudeCode: () => call<ClaudeCodeView>('GET', '/api/claude-code'),
  browseContainer: (container: string, user: string, path?: string) =>
    call<FolderListingView>('GET', `/api/browse-container?${new URLSearchParams({ container, user, path: path ?? '' }).toString()}`),
  workflowCheck: (path?: string, config?: string, workflow?: string) =>
    call<WorkflowCheckView>('GET', `/api/workflow-check?${new URLSearchParams({ path: path ?? '', config: config ?? '', workflow: workflow ?? '' }).toString()}`),
  projectsFolder: () => call<{ path: string }>('GET', '/api/projects-folder'),
  machine: () => call<MachineInfo>('GET', '/api/machine'),
  setLimit: (limit: number) => call('POST', '/api/limit', { limit }),
  setUsageStop: (account: string, kind: string, percent: number | null) => call('POST', '/api/usage-stops', { account, kind, percent }),
  liftUsageStop: (account: string, kind: string) => call('POST', '/api/usage-lift', { account, kind }),
  away: (until: string, allow: AwayKind[]) => call<AwayInfo>('POST', '/api/away', { until, allow }),
  back: () => call('DELETE', '/api/away'),
  setPriority: (sessionId: string, priority: Priority) => call('POST', `/api/sessions/${sessionId}/priority`, { priority }),
  setPaused: (sessionId: string, paused: boolean) => call('POST', `/api/sessions/${sessionId}/pause`, { paused }),
  cancelClear: (sessionId: string) => call('POST', `/api/sessions/${sessionId}/cancel-clear`, {}),
  startNow: (sessionId: string) => call('POST', `/api/sessions/${sessionId}/start-now`, {}),
  turns: (sessionId: string) => call<TurnResource[]>('GET', `/api/sessions/${sessionId}/turns`),
  board: () => call<BoardStatus>('GET', '/api/board'),
  boardThreads: () => call<BoardThreadsView>('GET', '/api/board-threads'),
  boardThread: (repo: string, id: string) => call<BoardThreadView>('GET', `/api/board-thread?${new URLSearchParams({ repo, id }).toString()}`),
  boardPeople: (project: string) => call<BoardPeopleView>('GET', `/api/board-projects/${encodeURIComponent(project)}/people`),
  boardRepos: (project: string, refresh = false) => call<BoardRepoChoicesView>('GET', `/api/board-projects/${encodeURIComponent(project)}/repos${refresh ? '?refresh=1' : ''}`),
  boardOwners: () => call<BoardOwnersView>('GET', '/api/board-owners'),
  // Publishing usage to a shared repo (issue #363).
  usagePublish: () => call<UsagePublishView>('GET', '/api/usage-publish'),
  setUsagePublish: (enabled: boolean, repo: string | null, accounts?: { allAccounts: boolean; accounts: string[] }) => call<UsagePublishView>('POST', '/api/usage-publish', { enabled, repo, ...accounts }),
  usagePublishRepos: (refresh = false) => call<BoardRepoChoicesView>('GET', `/api/usage-publish-repos${refresh ? '?refresh=1' : ''}`),
  revealUsageKey: () => call<{ key: string | null }>('POST', '/api/usage-key-reveal', {}),
  setUsageKey: (key: string) => call<UsagePublishView>('POST', '/api/usage-key', { key }),
  takeLinkedUsageKey: () => call<UsagePublishView>('POST', '/api/usage-key', { fromLinked: true }),
  sharedUsage: (fresh = false) => call<SharedUsageView>('GET', `/api/usage-shared${fresh ? '?fresh=1' : ''}`),
  removeSharedUsage: (id: string) => call<SharedUsageView>('POST', '/api/usage-shared-remove', { id, confirm: true }),
  createBoardRepo: (owner: string, name: string) => call<{ repo: string; private: boolean }>('POST', '/api/board-repos', { owner, name, confirm: true }),
  setBoardProject: (name: string, setting: { enabled: boolean; repo: string | null; allow: string[]; channels: string[]; frontDesk: boolean }) =>
    call<ProjectBoardView>('POST', `/api/board-projects/${encodeURIComponent(name)}`, setting),
  typicalCosts: (days = 30) => call<TypicalCost[]>('GET', `/api/typical-costs?days=${days}`),
  // Linked computers (issue #245): linked and unlinked on this computer only.
  links: () => call<{ publicName: string | null; problem: string | null; links: LinkedComputerInfo[] }>('GET', '/api/links'),
  linkCode: () => call<{ code: string; expiresAt: number }>('POST', '/api/links-code', {}),
  joinLink: (code: string, name: string) => call<LinkedComputerInfo>('POST', '/api/links-join', { code, name }),
  unlink: (id: string) => call('POST', `/api/links/${encodeURIComponent(id)}/remove`, {}),
  /** Pair through the link (issue #273): a linked computer's pairing code for its frame here; this computer's page only. */
  linkDevicePair: (id: string) => call<{ url: string; expiresAt: number }>('POST', '/api/link-device-pair', { id }),
  dismissLinkPairing: (id: string) => call('POST', `/api/link-pairings/${encodeURIComponent(id)}/dismiss`, {}),
  // Paired devices (issue #160): managed on this computer; a device sees only itself.
  devices: () => call<{ publicName: string | null; devices: DeviceInfo[] }>('GET', '/api/devices'),
  /** A pairing code for a phone or, to show this Ledung in a frame on another computer's page, a computer (issue #241). */
  pairDevice: (kind: 'phone' | 'computer' = 'phone') => call<{ url: string; expiresAt: number; kind: 'phone' | 'computer' }>('POST', '/api/devices-pair', { kind }),
  revokeDevice: (id: string) => call('POST', `/api/devices/${encodeURIComponent(id)}/revoke`, {}),
  thisDevice: () => call<{ remote: false } | { remote: true; device: DeviceInfo; mayAddPasskey: boolean; unlockedUntil: number | null }>('GET', '/api/device'),
  /** Unlocks this device for ordinary changes for 30 minutes, or logs a computer on until it logs out (one passkey prompt). */
  unlockDevice: () => call<{ unlockedUntil: number }>('POST', '/api/device-unlock', {}),
  /** A one-time link to set this device's passkey up on this Ledung's own page, in a window of its own (issue #241). */
  passkeyEnrolLink: () => call<{ url: string; expiresAt: number }>('POST', '/api/passkey-enrol-link', {}),
  /** Logs this computer device off, or locks this phone (issue #241). */
  logOutDevice: () => call<{ unlockedUntil: null }>('POST', '/api/device-logout', {}),
  // Push notifications to this phone (issue #246).
  pushState: () => call<{ publicKey: string; on: boolean }>('GET', '/api/push'),
  pushOn: (subscription: unknown) => call<{ on: boolean }>('POST', '/api/push', { subscription }),
  pushOff: () => call<{ on: boolean }>('POST', '/api/push-off', {}),
  renameDevice: (name: string) => call<DeviceInfo>('POST', '/api/device-name', { name }),
  /** Sets up this device's passkey: Ledung's options, the phone's Face ID or fingerprint, the answer back. */
  addPasskey: async () => {
    const options = await call<{ challenge: string }>('POST', '/api/passkey-options', {});
    return call<DeviceInfo>('POST', '/api/passkey', { response: await passkeyCalls().create(options) });
  },
};
