import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { CHATS, PERMISSION_MODES, PRIORITIES, projectLabel, type AwayInfo, type BoardStatus, type ChatsInfo, type GitHubBudget, type CompactingInfo, type MachineInfo, type McpServerInfo, type PermissionMode, type Priority, type ProjectInfo, type RemoteControlInfo, type SessionInfo } from '../../src/shared/protocol.ts';
import { AddProjectView, ProjectSettingsView, ProjectStartView } from './projects/ProjectViews.tsx';
import { ChatsSettingsView, NewChatView } from './chats/ChatViews.tsx';
import { api } from './api.ts';
import { MessageList, formatTime } from './components/MessageList.tsx';
import { WorkingIndicator } from './components/WorkingIndicator.tsx';
import { SailingShip, shipMode } from './components/SailingShip.tsx';
import { FileViewer } from './components/FileViewer.tsx';
import { FilesPane } from './components/FilesPane.tsx';
import type { PaneFolderKey } from '../../src/shared/files-pane.ts';
import { WaitingView, waitingCount } from './components/WaitingView.tsx';
import { ArchivedView } from './components/ArchivedView.tsx';
import { AwayBanner, AwayMarker, AwayPanel } from './components/AwayPanel.tsx';
import { awayBannerShown } from './awayBanner.ts';
import { SettingsView } from './components/SettingsView.tsx';
import { SettingsFrame, type UpdateState } from './components/SettingsFrame.tsx';
import { bannerView, tabOf, tabView } from './settingsGroups.ts';
import { ProblemText } from './components/ClaudeCodeSettings.tsx';
import { usageStopLine } from './components/UsageStopsSettings.tsx';
import { BoardChip } from './components/BoardViews.tsx';
import { MacroChips } from './components/MacroChips.tsx';
import { fillMacro, keyOf, macroAction, macrosFor, type Macro } from '../../src/shared/macros.ts';
import { BoardListView, BoardThreadPage } from './components/BoardView.tsx';
import { boardChip, connectionMark } from './boardMarks.ts';
import { parseThreadOpenId, threadFromHash, threadHash, threadOpenId } from './boardView.ts';
import { Named, sessionColour } from './components/ProjectName.tsx';
import { NameEditor } from './components/NameEditor.tsx';
import { siblingOrder } from './sidebarOrder.ts';
import { useSidebarDrag } from './sidebarDrag.ts';
import { foldRows, readFolded, readFoldedSessions, toggleFolded, writeFolded, writeFoldedSessions, type FoldedRow, type Hidden } from './sidebarFold.ts';
import { conversationFromHash, conversationHash, conversationOf, messageFromHash, messageHash, type CameFrom } from './conversation.ts';

/** The sidebar group for sessions of projects that were removed. */
const REMOVED_PROJECTS = 'Removed projects';

/** Whether a session belongs to a sidebar group: its project, Chats (issue #211), or "Removed projects". */
function inGroup(s: SessionInfo, group: string, known: Set<string>): boolean {
  return group === REMOVED_PROJECTS ? !known.has(s.project) && s.project !== CHATS : s.project === group;
}

/** A session's row in the sidebar; drag: the siblings it can be dragged among, null when it stays put (issue #88). */
type Row = { s: SessionInfo; depth: number; drag: string | null };
import { projectAccountShown, stripAccount } from './limitAccount.ts';
import { githubBudgetClass, githubBudgetLine, githubBudgetsShown } from './githubBudget.ts';
import { escapeLeaves, isSettingsView, leaveSettings, stepsInto, type SettingsSteps } from './settingsNav.ts';
import { deskStepsInto, isDeskView, leaveShots } from './deskNav.ts';
import { backToList, deskFallback, phoneClass, type ListSteps } from './phonePane.ts';
import { NARROW_QUERY } from './sidebarSize.ts';
import { useDraft } from './useDraft.ts';
import { useStableCallback } from './useStableCallback.ts';
import { canInterrupt, escapeClosesMenu, isToolCallsKey, MCP_STATUS_LABEL, sessionControls, showsMcp, TOOL_CALLS_KEY } from './sessionMenu.ts';
import { formatTokens, LimitMeters, pct, prLabel } from './usage/charts.tsx';
import { contextShare } from './usage/SessionsTab.tsx';
import { SessionUsagePanel } from './usage/SessionUsage.tsx';
import { UsageView } from './usage/UsageView.tsx';
import type { Overview } from '../../src/shared/protocol.ts';
import { bangAsk, bangCommand, bangHint } from '../../src/shared/bang.ts';
import { SidebarResizer } from './components/SidebarResizer.tsx';
import { useComposerHeight } from './components/ComposerResizer.tsx';
import { nameTint, withChatsColour } from './nameTint.ts';
import { LockdownFrame } from './components/LockdownFrame.tsx';
import { frameLevel, LOCK_HINT } from './lockdownFrame.ts';
import { useLedung, type Connection } from './useLedung.ts';
import { STATUS_LABEL, statusLook } from './sessionStatus.ts';
import { useNotifications } from './useNotifications.ts';
import { formatBytes, formatCores, MachinePanel, PRIORITY_LABEL } from './usage/MachinePanel.tsx';
import { usePlainTyping } from './usePlainTyping.ts';
import { coarsePointer } from './coarsePointer.ts';
import { enterSends } from './phoneKeyboard.ts';
import { useStatusDot } from './useStatusDot.ts';
import { rowStatus } from './statusDot.ts';
import { useCompactSidebar } from './useCompactSidebar.ts';
import { compactRows, rowTooltip } from './compactSidebar.ts';
import { useArchivedLink } from './useArchivedLink.ts';
import { showsArchivedLink } from './archivedLink.ts';
import { computerFrame, computerStyle, frameAnswer, inFrame, shownComputerOf } from './computerFrame.ts';
import { ComputerFrames, ComputerTabs } from './components/ComputerTabs.tsx';
import { useInstallApp } from './useInstallApp.ts';
import { InstallNotice } from './components/InstallApp.tsx';
import { ShortcutNotice } from './components/Shortcuts.tsx';

/** Shown in a frame on another computer's page (issue #241): fixed for the page's life. */
const IN_FRAME = inFrame();
// The page that frames this one asks whether it is paired (issue #286): this page runs only for a paired device, so
// it says yes; listening from the start, before the frame's load event that the question follows.
if (IN_FRAME) {
  window.addEventListener('message', (e) => {
    const answer = frameAnswer(e.data, e.source === window.parent);
    if (answer) window.parent.postMessage(answer, e.origin);
  });
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  plan: 'Plan',
};

const MODE_HINT: Record<PermissionMode, string> = {
  default: 'Every action that needs permission asks you.',
  acceptEdits: 'File edits go through; commands still ask you.',
  auto: 'Routine actions are approved automatically; you are asked about the rest.',
  plan: 'Read-only: Claude plans but changes nothing.',
};

/**
 * What the main area shows: a session (its id), a view ("waiting", "usage", "overview" for Usage → Sessions, issue #400, "settings",
 * "add", "accounts", "board", "chat" for New chat, "chats" for the chats' settings), a board thread ("bt:<repo>#<id>"), a
 * project whose manager hasn't started ("p:<name>"), a project's tab in Settings ("ps:<name>", a group of it
 * "ps:<name>/<group>", issue #366), its archived sessions ("a:<name>"), a question in Waiting for you ("q:<number>"), a
 * group of Settings' Ledung tab ("settings:<group>", issue #365) or of the Chats tab ("chats:<group>", #366). "accounts"
 * is the old Accounts page, now in Settings → Claude & usage.
 */
const VIEWS = ['waiting', 'usage', 'overview', 'board', 'settings', 'add', 'accounts', 'chat', 'chats'];

const isSessionId = (id: string | null) => !!id && !VIEWS.includes(id) && !id.includes(':');

function viewFromHash(): string | null {
  const question = location.hash.match(/^#\/waiting\/q\/(\d+)$/);
  if (question) return `q:${question[1]}`;
  const thread = threadFromHash(location.hash);
  if (thread) return threadOpenId(thread.repo, thread.id);
  const view = location.hash.match(/^#\/(waiting|usage|overview|board|settings|add|accounts|chat|chats)$/);
  if (view) return view[1]!;
  const group = location.hash.match(/^#\/(settings|chats)\/([a-z]+)$/);
  if (group) return `${group[1]}:${group[2]}`;
  const projectGroup = location.hash.match(/^#\/ps\/([^/]+)\/([a-z]+)$/);
  if (projectGroup) return `ps:${decodeURIComponent(projectGroup[1]!)}/${projectGroup[2]}`;
  const project = location.hash.match(/^#\/(p|ps|a)\/(.+)$/);
  if (project) return `${project[1]}:${decodeURIComponent(project[2]!)}`;
  return (conversationFromHash(location.hash) ?? messageFromHash(location.hash))?.sessionId ?? null;
}

function hashFor(id: string | null): string {
  if (!id) return '';
  if (VIEWS.includes(id)) return `#/${id}`;
  const thread = parseThreadOpenId(id);
  if (thread) return threadHash(thread.repo, thread.id);
  if (id.startsWith('q:')) return `#/waiting/q/${id.slice(2)}`;
  if (id.startsWith('settings:')) return `#/settings/${id.slice('settings:'.length)}`;
  if (id.startsWith('chats:')) return `#/chats/${id.slice('chats:'.length)}`;
  const tab = tabView(id);
  if (tab?.project != null && tab.group) return `#/ps/${encodeURIComponent(tab.project)}/${tab.group}`;
  const project = id.match(/^(p|ps|a):(.+)$/);
  if (project) return `#/${project[1]}/${encodeURIComponent(project[2]!)}`;
  return `#/s/${id}`;
}

/** How many steps into Waiting for you this history entry is (0 outside), so its Close can go back past all of them (issue #59). */
const deskState = () => (history.state ?? {}) as { ledungDesk?: number; ledungDeskRoot?: boolean; ledungFrom?: CameFrom };
const deskDepth = (): number => Number(deskState().ledungDesk ?? 0);
/** The view was entered with no view of Ledung's before it (a reload, a bookmark, a typed address): Close can't go back to one. */
const deskRoot = (): boolean => deskState().ledungDeskRoot === true;
/** An entry Ledung didn't make (the first load or a typed hash) that shows Waiting for you starts its own chain. */
function markDeskRoot(id: string | null) {
  if (isDeskView(id) && deskState().ledungDesk === undefined) history.replaceState({ ...deskState(), ledungDesk: 0, ledungDeskRoot: true }, '');
}

/** How many steps into Settings this history entry is, so Escape and the ⚙ can go back past all of them (issue #78). */
function settingsSteps(): SettingsSteps {
  const state = (history.state ?? {}) as { ledungSettings?: number; ledungSettingsRoot?: boolean };
  return { depth: Number(state.ledungSettings ?? 0), root: state.ledungSettingsRoot === true };
}
/** Settings entered with no screen of Ledung's before it (a reload, a bookmark, a typed address): leaving goes to the start page. */
function markSettingsRoot(id: string | null) {
  if (isSettingsView(id) && (history.state ?? {}).ledungSettings === undefined) history.replaceState({ ...(history.state ?? {}), ledungSettings: 1, ledungSettingsRoot: true }, '');
}

const SIDEBAR_KEY = 'ledung.waitingSidebar';

function readTechnical(sessionId: string): boolean {
  try {
    return localStorage.getItem(`ledung.technical.${sessionId}`) === '1';
  } catch {
    return false;
  }
}

export function App() {
  const [openId, setOpenId] = useState<string | null>(viewFromHash());
  // The whole address, so moving between a conversation and the same conversation at a question renders too.
  const [hash, setHash] = useState(location.hash);
  const ledung = useLedung(isSessionId(openId) ? openId : null);
  const [error, setError] = useState<string | null>(null);
  // The other computer (by id) whose page shows here (issue #241), null for this one's; and those opened so far, kept loaded.
  const [shownComputer, setShownComputer] = useState<string | null>(null);
  const [openedComputers, setOpenedComputers] = useState<string[]>([]);

  useEffect(() => {
    markDeskRoot(viewFromHash());
    markSettingsRoot(viewFromHash());
    const onHash = () => { markDeskRoot(viewFromHash()); markSettingsRoot(viewFromHash()); setOpenId(viewFromHash()); setHash(location.hash); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const open = (id: string | null) => {
    const hash = hashFor(id);
    if (hash !== location.hash) {
      // Opening Waiting for you, a question in it, or the queue again are history entries; Back and Forward step through them.
      const desk = deskStepsInto(openId, { depth: deskDepth(), root: deskRoot() }, id);
      const settings = stepsInto(openId, settingsSteps(), id);
      location.hash = hash;
      // ledungFromList: opened from the list, so a phone's ← can go back to it instead of stacking it again (#171).
      history.replaceState({ ...(history.state ?? {}), ledungDesk: desk.depth, ledungDeskRoot: desk.root, ledungSettings: settings.depth, ledungSettingsRoot: settings.root, ledungFromList: openId === null }, '');
    }
    setOpenId(id);
    setHash(location.hash);
  };
  /** The same view under a new name (a renamed project, issue #116): it replaces the entry, so Back never finds the old name. */
  const reopen = (id: string) => {
    history.replaceState(history.state, '', hashFor(id));
    setOpenId(id);
    setHash(location.hash);
  };
  /**
   * Go to conversation (issue #61): the conversation of the manager who owns the question, scrolled to it. A
   * history entry of its own, so Back returns to the queue or question it was opened from.
   */
  /** `sessionId`: that session's conversation instead of the one the question is answered in (issue #368). */
  const goToConversation = (questionId: number, sessionId?: string) => {
    const q = ledung.questions[questionId];
    if (!q) return;
    const from: CameFrom | undefined = openId === 'waiting' ? 'queue' : openId?.startsWith('q:') ? (ledung.questions[Number(openId.slice(2))]?.shots ? 'shots' : 'question') : undefined;
    const conv = sessionId ?? conversationOf(q);
    location.hash = conversationHash(conv, questionId);
    history.replaceState({ ...(history.state ?? {}), ledungDesk: 0, ledungDeskRoot: false, ledungFrom: from }, '');
    setOpenId(conv);
    setHash(location.hash);
  };
  /** An attached reply's link (issue #369): the session's conversation at that message, Back returning as above. */
  const goToMessage = (sessionId: string, messageId: number) => {
    const from: CameFrom | undefined = openId === 'waiting' ? 'queue' : openId?.startsWith('q:') ? (ledung.questions[Number(openId.slice(2))]?.shots ? 'shots' : 'question') : undefined;
    location.hash = messageHash(sessionId, messageId);
    history.replaceState({ ...(history.state ?? {}), ledungDesk: 0, ledungDeskRoot: false, ledungFrom: from }, '');
    setOpenId(sessionId);
    setHash(location.hash);
  };
  /** Close in Waiting for you: back to the view that was open before it. */
  const closeDesk = () => {
    const depth = deskDepth();
    // Entered from another view: back past every step inside to it. Entered directly: there is none, so Usage → Sessions (the old Overview).
    if (depth > 0 && !deskRoot()) history.go(-depth);
    else open(deskFallback(window.matchMedia(NARROW_QUERY).matches));
  };
  /** The ← of a pane on a phone (issue #171): back to the list. */
  const toList = () => {
    if ('back' in backToList(history.state as ListSteps | null)) history.back();
    else open(null);
  };
  /** Verdicts sent: back to the view the screenshots were opened from, not on to the next question (issue #92). */
  const leaveShotsView = () => {
    if ('back' in leaveShots(deskDepth())) history.back();
    else open('waiting');
  };

  /** Escape or the ⚙ again in Settings: back to the screen it was opened from, or the start page when there is none. */
  const closeSettings = () => {
    const to = leaveSettings(settingsSteps());
    if ('back' in to) history.go(-to.back);
    else open(null);
  };
  const inSettings = isSettingsView(openId);
  const closeSettingsRef = useRef(closeSettings);
  closeSettingsRef.current = closeSettings;
  useEffect(() => {
    if (!inSettings) return;
    // On the document, so a field that uses Escape itself (and says so with preventDefault) handles it first.
    const onKey = (e: KeyboardEvent) => {
      if (!escapeLeaves(e)) return;
      e.preventDefault();
      closeSettingsRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inSettings]);

  // The mouse's back and forward buttons step through history too. Chrome and Firefox do that themselves; Safari
  // doesn't, so a step the browser didn't take within a moment is taken here (never twice).
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      const before = location.href;
      const back = e.button === 3;
      setTimeout(() => { if (location.href === before) (back ? history.back() : history.forward()); }, 100);
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, []);

  // The sidebar can be hidden in Waiting for you; remembered in the browser.
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === 'hidden'; } catch { return false; }
  });
  const toggleSidebar = () => {
    setSidebarHidden(!sidebarHidden);
    try { localStorage.setItem(SIDEBAR_KEY, sidebarHidden ? 'shown' : 'hidden'); } catch { /* private mode: kept for this visit only */ }
  };
  const noSidebar = isDeskView(openId) && sidebarHidden;

  const questions = useMemo(() => Object.values(ledung.questions).sort((a, b) => b.id - a.id), [ledung.questions]);
  const permissions = useMemo(() => Object.values(ledung.permissions), [ledung.permissions]);
  const waiting = waitingCount(questions, permissions) + ledung.newComputers.length + ledung.linkPairings.length;
  const installApp = useInstallApp();
  const notify = useNotifications({ loaded: ledung.loaded, questions, permissions, sessions: ledung.sessions, usageStops: ledung.usageStops, onOpenSession: open });

  // The count in the tab title, visible from another tab or the phone's tab switcher.
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Project Ledung` : 'Project Ledung';
  }, [waiting]);

  const pendingBySession = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of permissions) if (p.status === 'pending') counts[p.sessionId] = (counts[p.sessionId] ?? 0) + 1;
    // Ledung also lists pending prompts addressed to managers; the badge counts them on the session that asked.
    for (const q of questions) if (q.status === 'open') counts[q.sessionId] = (counts[q.sessionId] ?? 0) + 1;
    return counts;
  }, [permissions, questions]);

  const session = ledung.sessions.find((s) => s.id === openId) ?? null;

  // The pages inside the Settings frame (issue #365): the Ledung, Chats and project tabs, each with its side menu of
  // groups (#366), and the Add project page.
  const settingsTab = tabOf(openId);
  const settingsProject = settingsTab?.startsWith('ps:') ? ledung.projects.find((p) => p.name === settingsTab.slice(3)) : undefined;
  const settingsBody: ((update: UpdateState) => ReactNode) | null =
    settingsTab === 'ledung' ? (update) => (
      <SettingsView view={openId!} update={update} run={run} board={ledung.board} remote={ledung.remote} throughPublicName={ledung.throughPublicName} newComputers={ledung.newComputers} projects={ledung.projects} computers={ledung.computers} sessions={ledung.sessions}
        accounts={ledung.accounts} accountChoices={ledung.accountChoices} defaultIdentity={ledung.defaultIdentity} accountProblems={ledung.accountProblems} usageStops={ledung.usageStops} macros={ledung.macros} canRestart={ledung.canRestart} source={ledung.source} config={ledung.configStatus} hellos={ledung.hellos} notify={notify} onOpen={open} />
    ) : settingsTab === 'add' ? () => (
      <AddProjectView run={run} accounts={ledung.accounts} defaultAccount={ledung.accountChoices.newProjects} profiles={ledung.profiles} lockdownB={ledung.lockdownB} onAdded={(p) => open(p.managerId ?? `p:${p.name}`)} />
    ) : settingsTab === 'chats' ? () => (
      <ChatsSettingsView view={openId!} chats={ledung.chats} run={run} onOpen={open} />
    ) : settingsProject ? () => (
      // Keyed by the project, not the group, so what is typed stays while moving between the tab's groups.
      <ProjectSettingsView key={settingsProject.name} view={openId!} board={ledung.board} projects={ledung.projects} project={settingsProject} run={run} accounts={ledung.accounts} profiles={settingsProject.profileNames ?? ledung.profiles} lockdownB={ledung.lockdownB} onOpen={open} onRemoved={() => open(null)} onRenamed={reopen} />
    ) : null;

  // The limits strip follows the selected project's account and keeps the last one over views with no project.
  const [lastAccount, setLastAccount] = useState<string | null>(() => {
    try { return localStorage.getItem('ledung.limitAccount'); } catch { return null; }
  });
  const strip = stripAccount(openId, ledung.sessions, ledung.projects, lastAccount);
  const stripAcc = strip.account;
  useEffect(() => {
    if (!strip.remember || strip.account === lastAccount) return;
    setLastAccount(strip.account);
    try { localStorage.setItem('ledung.limitAccount', strip.account); } catch { /* private mode: kept for this visit only */ }
  }, [strip.remember, strip.account, lastAccount]);
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const banners = (
    <>
      {ledung.updated && (
        <div className="banner updated">
          <span>Ledung was updated — reload</span>
          <button className="small primary" onClick={() => location.reload()}>Reload</button>
        </div>
      )}
      {ledung.away && awayBannerShown(ledung.away, session) && <AwayBanner away={ledung.away} run={run} />}
      {installApp.notice && <InstallNotice app={installApp} run={run} />}
      <ShortcutNotice run={run} />
      {ledung.usageStops.filter((s) => s.holding).map((s) => (
        <div key={`${s.account}:${s.kind}`} className="banner updated">
          <span>{usageStopLine(s)}</span>
          <button className="small" onClick={() => void run(() => api.liftUsageStop(s.account, s.kind))}>Lift</button>
          <button className="small" onClick={() => open(bannerView('usageStop'))}>Settings</button>
        </div>
      ))}
      {/* Claude Code missing or too old (issue #341): how to install or update it, and Check again once done. */}
      {ledung.claudeProblem && (
        <div className="banner updated signin" role="alert">
          <span><ProblemText text={ledung.claudeProblem} /></span>
          <button className="small primary" onClick={() => void run(() => api.checkSignIn())}>Check again</button>
          <button className="small" onClick={() => open(bannerView('claudeProblem'))}>Settings</button>
        </div>
      )}
      {/* A changed config file that was refused (issue #353): the settings in use stay. */}
      {ledung.configStatus?.problem && (
        <div className="banner updated signin" role="alert">
          <span>The config file was changed but not applied: {ledung.configStatus.problem}</span>
          <button className="small" onClick={() => open(bannerView('configProblem'))}>Settings</button>
        </div>
      )}
      {/* Claude Code not signed in for an account in use (issue #333): how to, and Check again once done. */}
      {ledung.signedOut.map((s) => (
        <div key={`signin:${s.account}`} className="banner updated signin">
          {/* What to type is between backticks in the help: shown as code. */}
          <span>{s.help.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</span>
          <button className="small primary" onClick={() => void run(() => api.checkSignIn())}>Check again</button>
          {s.account !== 'default' && <button className="small" onClick={() => open('settings:claude')}>Accounts</button>}
        </div>
      ))}
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error} <span className="muted">(click to dismiss)</span>
        </div>
      )}
    </>
  );

  // The computer tabs, and the remote frame when this page came through the public name (issue #232). Another
  // computer's page shows here in a frame (issue #241); in such a frame this page draws neither.
  const frame = computerFrame(ledung.computers, ledung.throughPublicName, IN_FRAME);
  // A computer whose tab is gone (unlinked, issue #273) shows nothing more: this computer's page comes back.
  const shown = shownComputerOf(ledung.computers, shownComputer);
  const showComputer = (id: string | null) => {
    setShownComputer(id);
    if (id && !openedComputers.includes(id)) setOpenedComputers((list) => [...list, id]);
  };

  return (
    <div className={`page${frame.remote ? ' remote' : ''}`} style={computerStyle(frame.here)}>
      <ComputerTabs frame={frame} shown={shown} onShow={showComputer} waiting={waiting} />
      <ComputerFrames computers={ledung.computers} opened={openedComputers} shown={shown} throughPublicName={ledung.throughPublicName} framed={IN_FRAME} />
      <div className={`app ${phoneClass(openId)}${noSidebar ? ' no-sidebar' : ''}`} hidden={shown !== null}>
        {/* On a phone the list is the whole screen and the main area is hidden, so its notices show above the list. */}
        {openId === null && <div className="phone-banners">{banners}</div>}
        <Sidebar
          sessions={ledung.sessions}
          projects={ledung.projects}
          chats={ledung.chats}
          pending={pendingBySession}
          waiting={waiting}
          limits={ledung.limits}
          usageStops={ledung.usageStops}
          github={ledung.github}
          stripAccount={stripAcc}
          overview={ledung.overview}
          machine={ledung.machine}
          run={run}
          openId={openId}
          onOpen={open}
          onCloseSettings={closeSettings}
          profiles={ledung.profiles}
          onStart={(project, profile) => run(async () => open((await api.start(project, profile)).id))}
          connection={ledung.connection}
          board={ledung.board}
        />
        {!noSidebar && <SidebarResizer />}
        <main className="main">
          {banners}
          {/* A session has its ← in its own header; every other pane gets this bar, shown only on a phone. */}
          {openId !== null && !session && <div className="phone-bar"><button className="phone-back" onClick={toList}>← List</button></div>}
          {openId === 'usage' || openId === 'overview' ? (
            <UsageView
              sessionsOpen={openId === 'overview'}
              onSessions={(on) => open(on ? 'overview' : 'usage')}
              sessions={ledung.sessions}
              overview={ledung.overview}
              machine={ledung.machine}
              waitingBySession={pendingBySession}
              onOpenSession={open}
            />
          ) :  isDeskView(openId) ? (
            <WaitingView
              questions={questions}
              permissions={permissions}
              sessions={ledung.sessions}
              projects={ledung.projects}
              chats={ledung.chats}
              userName={ledung.userName}
              questionId={openId?.startsWith('q:') ? Number(openId.slice(2)) : null}
              onOpenQuestion={(id) => open(id === null ? 'waiting' : `q:${id}`)}
              onOpenSession={open}
              onGoToConversation={goToConversation}
              onGoToMessage={goToMessage}
              onClose={closeDesk}
              onLeaveShots={leaveShotsView}
              sidebarHidden={sidebarHidden}
              onToggleSidebar={toggleSidebar}
              newComputers={ledung.newComputers}
              linkPairings={ledung.linkPairings}
              run={run}
            />
          ) : openId === 'board' ? (
            <BoardListView board={ledung.board} onOpen={open} onOpenSettings={() => open('settings')} />
          ) : parseThreadOpenId(openId) ? (
            <BoardThreadPage key={openId} repo={parseThreadOpenId(openId)!.repo} id={parseThreadOpenId(openId)!.id} board={ledung.board} projects={ledung.projects} onOpen={open} onBack={() => open('board')} />
          ) : settingsBody ? (
            <SettingsFrame view={openId!} projects={ledung.projects} source={ledung.source} canRestart={ledung.canRestart} hellos={ledung.hellos} onOpen={open}>
              {settingsBody}
            </SettingsFrame>
          ) : openId === 'chat' ? (
            <NewChatView chats={ledung.chats} profiles={ledung.profiles} run={run} onStarted={open} />
          ) : openId?.startsWith('a:') ? (
            <ArchivedView
              key={openId}
              title={projectLabel(openId.slice(2))}
              sessions={ledung.sessions.filter((s) => s.archivedAt && inGroup(s, openId.slice(2), new Set(ledung.projects.map((p) => p.name))))}
              overview={ledung.overview}
              run={run}
              onOpenSession={open}
            />
          ) : openId?.startsWith('p:') && ledung.projects.some((p) => p.name === openId.slice(2)) ? (
            <ProjectStartView key={openId} project={ledung.projects.find((p) => p.name === openId.slice(2))!} run={run} onStarted={open} />
          ) : session ? (
            <SessionView
              key={session.id}
              session={session}
              ledung={ledung}
              pendingCount={pendingBySession[session.id] ?? 0}
              run={run}
              focusQuestion={conversationFromHash(hash)?.questionId ?? null}
              focusMessage={messageFromHash(hash)?.messageId ?? null}
              cameFrom={deskState().ledungFrom ?? null}
              onOpenQuestion={(id) => open(`q:${id}`)}
              onOpenBoardThread={(repo, id) => open(threadOpenId(repo, id))}
              onBack={toList}
            />
          ) : (
            <div className="empty">
              <h1>Project Ledung</h1>
              <p>{ledung.projects.length ? 'Open a project on the left to talk to its manager.' : 'No projects yet. Add one to start talking to its manager.'}</p>
              <div className="empty-actions">
                {!ledung.projects.length && <button className="primary" onClick={() => open('add')}>Add a project</button>}
                <button onClick={() => open('chat')}>New chat</button>
                <button onClick={() => open('settings')}>Settings</button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Sidebar(props: {
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  /** For the chats' name colour (issue #222). */
  chats: ChatsInfo | null;
  pending: Record<string, number>;
  waiting: number;
  limits: ReturnType<typeof useLedung>['limits'];
  usageStops: ReturnType<typeof useLedung>['usageStops'];
  github: GitHubBudget[];
  stripAccount: string;
  overview: Overview | null;
  machine: MachineInfo | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
  openId: string | null;
  onOpen: (id: string) => void;
  onCloseSettings: () => void;
  /** The session profiles there are, "full" first (#20); a project's own list is on it (#298). */
  profiles: string[];
  /** profile left out: the project's. */
  onStart: (project: string, profile?: string) => void;
  connection: Connection;
  board: BoardStatus | null;
}) {
  // A tree per project: the project, its manager with the sessions it runs, then sessions started
  // outside the manager (and earlier managers). Sessions of removed projects come last. Projects and
  // siblings keep the order they were dragged into (issue #88), else as before.
  // Archived sessions leave the tree; each project links to its own (idle stop and archive).
  const shown = props.sessions.filter((s) => !s.archivedAt);
  const childrenOf = (id: string) => shown.filter((s) => s.parentId === id).sort(siblingOrder);
  const known = new Set(props.projects.map((p) => p.name));
  // drag: the siblings a row can be dragged among (sidebarDrag.ts); null for the manager, which stays first,
  // and in "Removed projects", whose rows belong to no one project.
  const withChildren = (s: SessionInfo, drag: string | null, movable: boolean): Row[] =>
    [{ s, depth: 0, drag }, ...childrenOf(s.id).map((c) => ({ s: c, depth: 1, drag: movable ? `c:${s.id}` : null }))];
  const rowsFor = (inProject: (s: SessionInfo) => boolean, managerId: string | null, project: string | null) => {
    const ids = new Set(shown.filter(inProject).map((s) => s.id));
    const manager = managerId ? shown.find((s) => s.id === managerId) : undefined;
    const top = shown.filter((s) => inProject(s) && s.id !== managerId && (!s.parentId || !ids.has(s.parentId))).sort(siblingOrder);
    return [...(manager ? withChildren(manager, null, !!project) : []), ...top.flatMap((s) => withChildren(s, project ? `t:${project}` : null, !!project))];
  };
  // Chats first (issue #211), a group of their own apart from every project, always shown for its New chat.
  const groups = [
    { name: CHATS, project: null as ProjectInfo | null, rows: rowsFor((s) => s.project === CHATS, null, CHATS) },
    ...props.projects.map((p) => ({ name: p.name, project: p as ProjectInfo | null, rows: rowsFor((s) => s.project === p.name, p.managerId, p.name) })),
    { name: REMOVED_PROJECTS, project: null, rows: rowsFor((s) => !known.has(s.project) && s.project !== CHATS, null, null) },
  ].map((g) => ({ ...g, archived: props.sessions.filter((s) => s.archivedAt && inGroup(s, g.name, known)).length }))
    .filter((g) => g.project || g.name === CHATS || g.rows.length || g.archived);

  // Folded projects and sessions, kept in this browser (issue #149); gone projects and sessions drop out on the next fold.
  const [folded, setFolded] = useState(() => readFolded(localStorage));
  const [foldedSessions, setFoldedSessions] = useState(() => readFoldedSessions(localStorage));
  const fold = (name: string) => setFolded((f) => {
    const next = toggleFolded(f, name, (n) => n === REMOVED_PROJECTS || n === CHATS || known.has(n));
    writeFolded(localStorage, next);
    return next;
  });
  const foldSession = (id: string) => setFoldedSessions((f) => {
    const next = toggleFolded(f, id, (n) => shown.some((s) => s.id === n));
    writeFoldedSessions(localStorage, next);
    return next;
  });
  /** "+3" for hidden rows, marked while any of them works. */
  const hiddenChip = (h: Hidden | null, what: string) => h && h.count > 0 && (
    <span className={`hidden-count${h.working ? ' working' : ''}`} title={`${h.count} ${what} hidden${h.working ? ', at least one working' : ''}`}>
      {h.working && <span className="dot running" />}+{h.count}
    </span>
  );

  // "+ Session" asks for a profile only when there is more than "full" to choose from.
  const [choosing, setChoosing] = useState<string | null>(null);
  /** The session whose name is being typed in its row (issue #223). */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [chosen, setChosen] = useState('');
  const newSession = (name: string, names: string[]) => {
    if (names.length <= 1) return props.onStart(name);
    setChosen('');
    setChoosing(choosing === name ? null : name);
  };

  const { nav, drag, handlers } = useSidebarDrag((group, ids) =>
    void props.run(() => (group === 'projects' ? api.orderProjects(ids) : api.orderSessions(ids))));
  /** Where the drop marker goes in a project's rows: before one row, or after one (the last place). */
  const markerIn = (rows: Row[]): { before?: string; after?: string } | null => {
    if (!drag || drag.slot === null || drag.group === 'projects') return null;
    const siblings = rows.filter((r) => r.drag === drag.group);
    if (!siblings.length) return null;
    if (drag.slot < siblings.length) return { before: siblings[drag.slot]!.s.id };
    // Last place among top-level sessions: below the last one's own sessions too, which end the project's rows.
    return { after: drag.group.startsWith('t:') ? rows[rows.length - 1]!.s.id : siblings[siblings.length - 1]!.s.id };
  };
  const movableProjects = groups.filter((g) => g.project).map((g) => g.name);
  const projectMarker = drag?.group === 'projects' && drag.slot !== null
    ? (drag.slot < movableProjects.length ? { before: movableProjects[drag.slot] } : { after: movableProjects[movableProjects.length - 1] })
    : null;
  // Indented like the rows it falls between, so a line next to a manager's sessions says which level it is on.
  const marker = <div className={`drop-marker${drag?.group.startsWith('c:') ? ' child' : ''}`} aria-hidden="true" />;

  // The status dot, or with it switched off the status as the row's tooltip (#151).
  const [dotShown] = useStatusDot();
  // The Compact sidebar step (#153): which rows a card keeps; what it hides goes in its tooltip.
  const [compact] = useCompactSidebar();
  const shows = compactRows(compact);
  // "Archived (N)" at the end of each group, unless switched off in Settings (#157).
  const [archivedShown] = useArchivedLink();
  // The caret sits beside the row's button, not in it (no button inside a button), and carries no data-drag.
  const item = ({ s, depth, drag: group, hidden, folds, folded: isFolded }: FoldedRow<Row>) => {
    const time = `${formatTime(s.createdAt)}${s.backgroundTasks > 0 ? ` · ${s.backgroundTasks} in background` : ''}`;
    const usage = (() => {
      // Tokens today (a manager's includes its team) · context · branch.
      const own = props.overview?.sessions[s.id]?.today ?? 0;
      const team = s.role === 'manager'
        ? props.sessions.filter((c) => c.parentId === s.id).reduce((n, c) => n + (props.overview?.sessions[c.id]?.today ?? 0), own)
        : own;
      const ctx = contextShare(s);
      const res = s.status !== 'ended' ? props.machine?.sessions[s.id] : undefined;
      const place = props.machine?.line.indexOf(s.id) ?? -1;
      const parts = [
        // A chat's folder (issue #211): chats in different folders look alike otherwise.
        s.project === CHATS && s.workDir ? `in ${s.workDir.split(/[\\/]/).filter(Boolean).pop()}` : '',
        place >= 0 ? `number ${place + 1} in line` : '',
        s.paused ? 'paused' : '',
        s.priority !== 'normal' ? PRIORITY_LABEL[s.priority].toLowerCase() : '',
        res && (res.cores >= 0.05 || res.memBytes > 0) ? `${formatCores(res.cores)} · ${formatBytes(res.memBytes)}` : '',
        team ? `${formatTokens(team)}${s.role === 'manager' && team !== own ? ' team' : ''} today` : '',
        ctx != null && s.status !== 'ended' ? `ctx ${pct(ctx)}` : '',
        s.pr ? prLabel(s.pr) : s.branch ?? '',
      ].filter(Boolean);
      return parts.join(' · ');
    })();
    return (
      <div className="session-row">
        {folds && (
          <button className="fold-caret session-caret" aria-expanded={!isFolded} aria-label={`${isFolded ? 'Unfold' : 'Fold'} the sessions of ${s.title}`}
            title={isFolded ? 'Show the sessions it runs' : 'Fold the sessions it runs away'} onClick={() => foldSession(s.id)}>
            {isFolded ? '▸' : '▾'}
          </button>
        )}
        {renaming === s.id ? (
          <div className={`session-item renaming${s.id === props.openId ? ' open' : ''}${depth ? ' child' : ''}`}>
            <NameEditor value={s.title} label={`New name for ${s.title}`} onDone={() => setRenaming(null)} onSave={(name) => props.run(() => api.rename(s.id, name))} />
          </div>
        ) : (
        <button
          className={`session-item${s.id === props.openId ? ' open' : ''}${depth ? ' child' : ''}${drag?.id === s.id ? ' dragging' : ''}${rowStatus(dotShown, s).ended ? ' ended-row' : ''}`}
          title={rowTooltip(compact, rowStatus(dotShown, s).tooltip, time, usage)}
          onClick={() => props.onOpen(s.id)}
          onDoubleClick={() => setRenaming(s.id)}
          data-drag={group ?? undefined}
          data-drag-id={group ? s.id : undefined}
        >
          {rowStatus(dotShown, s).dot && <span className={`dot ${statusLook(s)}`} title={STATUS_LABEL[s.status]} />}
          <span className="session-text">
            <span className="session-title">{s.role === 'manager' && <span className="chip">Manager</span>} <Named colour={sessionColour(s, withChatsColour(props.projects, props.chats))}>{s.title}</Named></span>
            {shows.time && <span className="session-sub">{time}</span>}
            {shows.usage && usage && <span className="session-sub usage-line">{usage}</span>}
          </span>
          {(() => {
            const mode = shipMode(s, props.sessions);
            return mode && <span className={`session-ship ${statusLook(s)}`}><SailingShip mode={mode} width={10} sizeButton={false} hideWhenSunk maxSize={shows.shipMax} /></span>;
          })()}
          {hiddenChip(hidden, hidden?.count === 1 ? 'sub-session' : 'sub-sessions')}
          {(props.pending[s.id] ?? 0) + (hidden?.pending ?? 0) ? <span className="badge">{(props.pending[s.id] ?? 0) + (hidden?.pending ?? 0)}</span> : null}
        </button>
        )}
      </div>
    );
  };

  const conn = connectionMark(props.connection);
  return (
    <aside className="sidebar">
      <LimitMeters account={props.stripAccount} limits={props.limits} stops={props.usageStops} run={props.run} />
      {githubBudgetsShown(props.github, Date.now()).map((b) => (
        <div key={`${b.container ?? ''} ${b.host}`} className={`github-budget muted ${githubBudgetClass(b)}`} title="What is left of the GitHub budget Ledung's pull request checks use (the worst of GitHub's readings). Under 20 % left they run every 10 minutes, under 5 % not until the reset.">
          {githubBudgetLine(b, (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
        </div>
      ))}
      <MachinePanel machine={props.machine} sessions={props.sessions} onOpen={props.onOpen} run={props.run} />
      <button className={`waiting-entry${isDeskView(props.openId) ? ' open' : ''}${props.waiting ? ' has-items' : ''}`} onClick={() => props.onOpen('waiting')}>
        <span>Waiting for you</span>
        {props.waiting ? <span className="badge">{props.waiting}</span> : <span className="muted">nothing</span>}
      </button>
      <nav className="session-list" data-compact={compact > 1 ? compact : undefined} ref={nav} {...handlers}>
        {!props.projects.length && <p className="muted project-empty">No projects yet. Add one in Settings (⚙ below).</p>}
        {groups.map((g) => ({ ...g, isFolded: folded.includes(g.name), view: foldRows(g.rows, { foldedSessions, folded: folded.includes(g.name), openId: props.openId, pending: props.pending }) })).map((g) => (
          <Fragment key={g.name}>
            {projectMarker?.before === g.name && marker}
            <div className={`project-group${drag?.group === 'projects' && drag.id === g.name ? ' dragging' : ''}`}>
              <LockdownFrame level={frameLevel(g.project)}>
                <div className="project-row">
                  <button className="fold-caret" aria-expanded={!g.isFolded} aria-label={`${g.isFolded ? 'Unfold' : 'Fold'} ${g.name}`} title={g.isFolded ? 'Show its sessions' : 'Fold its sessions away'} onClick={() => fold(g.name)}>
                    {g.isFolded ? '▸' : '▾'}
                  </button>
                  {g.project ? (
                    <button
                      className={`project-name${props.openId === `p:${g.name}` || (g.project.managerId && props.openId === g.project.managerId) ? ' open' : ''}`}
                      title={`${g.project.where}${g.project.managerId ? '' : ' · manager not started yet'}`}
                      onClick={() => props.onOpen(g.project!.managerId ?? `p:${g.name}`)}
                      data-drag="projects"
                      data-drag-id={g.name}
                    >
                      {(() => {
                        // The account over the name, for every project not on this computer's own login (Martin, #394, Ledung question #388).
                        const account = projectAccountShown(g.project.account);
                        const name = <Named colour={g.project.colours.manager}>{g.name}</Named>;
                        return account ? (
                          <span className="project-name-stack">
                            <span className="project-account" title={`Runs on the Claude account ${account}`}>{account}</span>
                            <span className="project-name-text">{name}</span>
                          </span>
                        ) : name;
                      })()}
                    </button>
                  ) : g.name === CHATS ? (
                    <button className={`project-name${props.openId === 'chat' ? ' open' : ''}`} title="Sessions of your own with no project, workflow or manager" onClick={() => props.onOpen('chat')}><Named colour={props.chats?.colour ?? null}>Chats</Named></button>
                  ) : <span className="project-name muted">{g.name}</span>}
                  {hiddenChip(g.view.project, g.view.project?.count === 1 ? 'session' : 'sessions')}
                  {g.view.project?.pending ? <span className="badge">{g.view.project.pending}</span> : null}
                  {g.name === CHATS && (
                    <span className="project-actions">
                      {shows.plusOnly
                        ? <button className="mini" title="New chat" aria-label="New chat" onClick={() => props.onOpen('chat')}>+</button>
                        : <button className="small" title="A Claude Code session of your own, with no project" onClick={() => props.onOpen('chat')}>+ Chat</button>}
                      <button className={`${shows.plusOnly ? 'mini cog' : 'small'}${tabOf(props.openId) === 'chats' ? ' on' : ''}`} title="Chats settings" aria-label="Settings of chats" onClick={() => props.onOpen('chats')}>⚙</button>
                    </span>
                  )}
                  {g.project && (
                    <span className="project-actions">
                      {shows.plusOnly ? (
                        <button className="mini" title={`New session in ${g.name}`} aria-label={`New session in ${g.name}`} onClick={() => newSession(g.name, g.project?.profileNames ?? props.profiles)}>+</button>
                      ) : (
                        <button className="small" title="A session of your own in this project, outside its manager" onClick={() => newSession(g.name, g.project?.profileNames ?? props.profiles)}>+ Session</button>
                      )}
                      <button className={`${shows.plusOnly ? 'mini cog' : 'small'}${tabOf(props.openId) === `ps:${g.name}` ? ' on' : ''}`} title="Project settings" aria-label={`Settings of ${g.name}`} onClick={() => props.onOpen(`ps:${g.name}`)}>⚙</button>
                    </span>
                  )}
                </div>
                {g.project && choosing === g.name && (
                  <div className="start-row">
                    <select aria-label={`Profile for a new session in ${g.name}`} value={chosen} onChange={(e) => setChosen(e.target.value)}
                      title="Its session profile: what it gets of your own plugins, MCP servers, tools and settings">
                      <option value="">{g.project.profiles.session ? `Project's: ${g.project.profiles.session}` : "Project's profile"}</option>
                      {(g.project.profileNames ?? props.profiles).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <button className="small primary" onClick={() => { setChoosing(null); props.onStart(g.name, chosen || undefined); }}>Start</button>
                    <button className="small" onClick={() => setChoosing(null)}>Cancel</button>
                  </div>
                )}
                {(() => {
                  const at = markerIn(g.view.rows);
                  return g.view.rows.map((r) => (
                    <Fragment key={r.s.id}>
                      {at?.before === r.s.id && marker}
                      {item(r)}
                      {at?.after === r.s.id && marker}
                    </Fragment>
                  ));
                })()}
                {showsArchivedLink(archivedShown, g.archived, g.isFolded) && (
                  <button className={`archived-link${props.openId === `a:${g.name}` ? ' open' : ''}`} onClick={() => props.onOpen(`a:${g.name}`)}>
                    Archived ({g.archived})
                  </button>
                )}
              </LockdownFrame>
            </div>
            {projectMarker?.after === g.name && marker}
          </Fragment>
        ))}
      </nav>
      <div className={`connection ${props.connection}`}>
        <button
          className={`icon settings-cog${isSettingsView(props.openId) ? ' on' : ''}`}
          title={isSettingsView(props.openId) ? 'Close settings (Esc)' : 'Settings: accounts, restart Ledung, add a project'}
          aria-label={isSettingsView(props.openId) ? 'Close settings' : 'Settings'}
          aria-pressed={isSettingsView(props.openId)}
          onClick={() => (isSettingsView(props.openId) ? props.onCloseSettings() : props.onOpen('settings'))}
        >⚙</button>
        {/* Usage and the board are chips here, not buttons at the top (issue #400, Ledung question #393), on one row. The
            connection is the board chip's border, or the Usage chip's when there is no board (Ledung question #397). */}
        <span className="footer-chips">
        <button
          className={`board-chip usage-chip${boardChip(props.board) ? '' : ` ${conn.className}`}${props.openId === 'usage' || props.openId === 'overview' ? ' on' : ''}`}
          title={`${boardChip(props.board) ? '' : `${conn.text} `}Usage: tokens per day, project and model, shared usage, and every live session`}
          aria-pressed={props.openId === 'usage' || props.openId === 'overview'}
          onClick={() => props.onOpen('usage')}
        >Usage{props.overview ? ` · ${formatTokens(props.overview.todayTokens)} today` : ''}</button>
        <BoardChip board={props.board} open={props.openId === 'board' || !!parseThreadOpenId(props.openId)} connection={conn} onClick={() => props.onOpen('board')} />
        </span>
      </div>
    </aside>
  );
}

export function SessionView(props: {
  session: SessionInfo;
  ledung: ReturnType<typeof useLedung>;
  pendingCount: number;
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** The question to scroll to and highlight (issue #61), or null. */
  focusQuestion: number | null;
  /** The message to scroll to and highlight, an attached reply's (issue #369), or null. */
  focusMessage?: number | null;
  /** Opened from Waiting for you with Go to conversation: where Back returns. */
  cameFrom: CameFrom | null;
  onOpenQuestion: (id: number) => void;
  /** Opens a board thread in the Board view. */
  onOpenBoardThread: (repo: string, id: string) => void;
  /** The ← to the list, shown only on a phone (issue #171). */
  onBack: () => void;
}) {
  const { session, ledung, run } = props;
  const [showTechnical, setShowTechnical] = useState(() => readTechnical(session.id));
  /** Files opened from links, newest last; empty when the file panel is closed. */
  const [files, setFiles] = useState<string[]>([]);
  const [showUsage, setShowUsage] = useState(false);
  /** On a phone the header is one line; a tap on it shows the rest (issue #171). Desktop shows it all regardless. */
  const [headDetails, setHeadDetails] = useState(false);
  /** Its name being typed in the header (issue #223). */
  const [renaming, setRenaming] = useState(false);
  useEffect(() => setRenaming(false), [session.id]);
  /**
   * The message box keeps its own text, so typing redraws only the box (issue #323); Quote hands its text to the
   * box through this, set by the Composer.
   */
  const quoteInto = useRef<((quoted: string) => void) | null>(null);
  const quote = useCallback((who: string, at: number, text: string) => {
    const body = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    quoteInto.current?.(`> ${who}, ${formatTime(at)}:\n${body.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`);
  }, []);
  /** The Files pane (issue #225, a test feature), and the file opened from it with the folder it is in. */
  const [pane, setPane] = useState(false);
  const [paneFile, setPaneFile] = useState<{ stack: string[]; folder: PaneFolderKey } | null>(null);
  const openFile = useCallback((path: string) => {
    setShowUsage(false);
    setPane(false);
    setPaneFile(null);
    setFiles((stack) => [...stack, path]);
  }, []);
  const paneQuestions = useMemo(() => Object.values(ledung.questions), [ledung.questions]);
  const togglePane = () => {
    setShowUsage(false);
    setFiles([]);
    setPaneFile(null);
    setPane((v) => !v);
  };
  const ended = session.status === 'ended';
  const controls = sessionControls(session);
  const lock = frameLevel(ledung.projects.find((p) => p.name === session.project));
  // The session's name colour: its message box (#133) and its own messages (#269).
  const tint = useMemo(() => nameTint(session, withChatsColour(ledung.projects, ledung.chats)), [session.project, session.role, ledung.projects, ledung.chats]);
  // The conversation is memoized (issue #323): what it is given keeps its identity unless what it shows changed.
  // Not a stable callback: MessageList calls it from its own layout effect, before this view's effects would have
  // updated one, and ledung.loadEarlier works from the messages it was made with (review of #323).
  const loadEarlier = useCallback(() => run(ledung.loadEarlier), [ledung.loadEarlier]);
  const titleOf = useCallback((id: string) => ledung.sessions.find((s) => s.id === id)?.title ?? 'unknown', [ledung.sessions]);
  const openQuestion = useStableCallback(props.onOpenQuestion);
  const boardRepo = ledung.board?.projects[session.project]?.repo;
  const openBoardThread = useStableCallback((id: string) => props.onOpenBoardThread(boardRepo!, id));

  const toggleTechnical = () => {
    setShowTechnical((v) => {
      try {
        localStorage.setItem(`ledung.technical.${session.id}`, v ? '0' : '1');
      } catch {
        // Not remembered; fine.
      }
      return !v;
    });
  };
  // Macros (issue #410): the global ones and this project's, as chips in the info bar and by their keybinds. None while
  // the message box takes nothing.
  const takesText = !(session.status === 'stopping' || (session.status === 'ended' && !session.claudeSessionId));
  const macros = useMemo(() => (takesText ? macrosFor(ledung.macros ?? [], session.project) : []), [ledung.macros, session.project, takesText]);
  const fireMacro = useStableCallback((m: Macro, other: boolean) => {
    const filled = fillMacro(m.text, session);
    if (macroAction(m, filled, other) === 'send') void run(() => api.send(session.id, filled.text));
    else quoteInto.current?.(filled.text);
  });
  useEffect(() => {
    const keyed = macros.filter((m) => m.key);
    if (!keyed.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || e.defaultPrevented) return;
      const key = keyOf(e);
      const m = key && keyed.find((x) => x.key === key);
      if (!m) return;
      e.preventDefault();
      fireMacro(m, false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [macros]);
  // Ctrl+O toggles tool calls anywhere on the page, the message box included (issue #81).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isToolCallsKey(e)) return;
      e.preventDefault();
      toggleTechnical();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session.id]);

  return (
    <LockdownFrame level={lock} fill>
      <header className={`session-head${headDetails ? ' details' : ''}`}>
        <button className="phone-back" aria-label="Back to the list" title="Back to the list" onClick={props.onBack}>←</button>
        <div className="session-head-text" onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) setHeadDetails((v) => !v); }}>
          <h2>
            <span className={`dot ${statusLook(session)} phone-dot`} title={STATUS_LABEL[session.status]} />
            {session.role === 'manager' && <span className="chip">Manager</span>}{' '}
            {renaming
              ? <NameEditor value={session.title} label={`New name for ${session.title}`} onDone={() => setRenaming(false)} onSave={(name) => run(() => api.rename(session.id, name))} />
              : <>
                <Named colour={sessionColour(session, withChatsColour(ledung.projects, ledung.chats))}>{session.title}</Named>
                <button className="icon rename" title="Rename" aria-label={`Rename ${session.title}`} onClick={() => setRenaming(true)}>✎</button>
              </>}
          </h2>
          {session.parentId && (
            <div className="muted started-by">
              Started by{' '}
              <button className="link" onClick={() => (location.hash = `#/s/${session.parentId}`)}>
                {ledung.sessions.find((s) => s.id === session.parentId)?.title ?? 'a manager'}
              </button>
            </div>
          )}
          <div className="muted">
            <span className={`dot ${statusLook(session)}`} /> {STATUS_LABEL[session.status]}
            {session.status === 'queued' && ledung.machine && ledung.machine.line.includes(session.id) ? `: number ${ledung.machine.line.indexOf(session.id) + 1} in line` : ''}
            {session.paused ? ' · Paused' : ''}
            {session.priority !== 'normal' ? <> · <span className={`chip prio-${session.priority}`} title={session.priorityNote ?? undefined}>{PRIORITY_LABEL[session.priority]}</span></> : null}
            {ledung.machine?.sessions[session.id] && !ended ? ` · ${formatCores(ledung.machine.sessions[session.id]!.cores)} · ${formatBytes(ledung.machine.sessions[session.id]!.memBytes)}` : ''}
            {session.status === 'ended' && session.endReason ? ` · ${session.endReason}` : ''}
            {' · '}{session.project === CHATS ? 'Chat' : session.project}
            {lock ? <> · <span className={`chip lock ${lock.toLowerCase()}`} title={LOCK_HINT[lock]}>Lockdown {lock}</span></> : null}
            {session.workDir
              ? <> · <span className="mono" title={session.project === CHATS ? `Works in ${session.workDir}` : `Works in ${session.workDir}, not the project folder`}>in {session.workDir.split(/[\\/]/).filter(Boolean).pop()}</span></>
              : null}
            {session.account ? <> · <span className="chip" title="The Claude account this session runs under">{session.account}</span></> : null}
            {session.model ? ` · ${session.model}` : ''}
            {session.profile && session.profile !== 'full'
              ? <> · <span className="chip" title="Its session profile: what it gets of your own plugins, MCP servers and tools">{session.profile}</span></>
              : null}
            {session.backgroundTasks > 0 ? ` · ${session.backgroundTasks} background task(s)` : ''}
            {session.branch ? <> · <span className="mono">{session.branch}</span></> : null}
            {session.pr ? <> · <a href={session.pr.url} target="_blank" rel="noreferrer noopener" title={`${session.pr.title} — checks ${session.pr.checks}`}>{prLabel(session.pr)}</a></> : null}
            {session.tickets.map((t) => <span key={t.id}> · <a href={t.url} target="_blank" rel="noreferrer noopener">{t.id}</a></span>)}
            {session.remoteControl ? <> · <RemoteControlLink rc={session.remoteControl} /></> : null}
          </div>
        </div>
        <SessionMenu
          before={<button className={`small files-toggle${pane ? ' on' : ''}`} aria-pressed={pane} title="This session's files and what it changed (a test feature)" onClick={togglePane}>Files</button>}
          session={session}
          project={ledung.projects.find((p) => p.name === session.project) ?? null}
          away={ledung.away}
          run={run}
          showTechnical={showTechnical}
          onToggleTechnical={toggleTechnical}
          usage={ledung.overview?.sessions[session.id]?.total ?? null}
          showUsage={showUsage}
          onToggleUsage={() => { setFiles([]); setPane(false); setPaneFile(null); setShowUsage((v) => !v); }}
        />
        {controls.header.length > 0 && (
          <div className="session-actions">
            {controls.header.includes('startNow') && (
              <button className="primary" title="Start this turn now, above the limit on working sessions" onClick={() => run(() => api.startNow(session.id))}>Start now</button>
            )}
            {controls.header.includes('clear') && <ClearCountdown due={session.clearDue!} onCancel={() => run(() => api.cancelClear(session.id))} />}
            {controls.header.includes('compacting') && (
              <Compacting
                compacting={session.compacting!}
                by={session.compacting!.requester === session.id ? 'the session itself' : `manager "${ledung.sessions.find((s) => s.id === session.compacting!.requester)?.title ?? 'a manager'}"`}
              />
            )}
            {controls.header.includes('resume') && <button className="primary" onClick={() => run(() => api.resume(session.id))}>Resume</button>}
            {controls.header.includes('archive') && (session.archivedAt
              ? <button title="Back into the sidebar, still ended" onClick={() => run(() => api.unarchive(session.id))}>Unarchive</button>
              : <button title="Out of the sidebar, listed under the project's Archived; nothing is deleted" onClick={() => run(() => api.archive(session.id))}>Archive</button>)}
          </div>
        )}
      </header>
      {props.cameFrom && (
        <div className="came-from">
          <button className="small" onClick={() => history.back()}>← Back to {props.cameFrom === 'question' ? 'the question' : props.cameFrom === 'shots' ? 'the screenshots' : 'the queue'}</button>
          <span className="muted">You came from Waiting for you; the browser's Back goes there too.</span>
        </div>
      )}
      <div className="session-body">
        <div className="chat-column">
          <MessageList
            messages={ledung.messages}
            permissions={ledung.permissions}
            showTechnical={showTechnical}
            hasEarlier={ledung.hasEarlier}
            onLoadEarlier={loadEarlier}
            onOpenFile={openFile}
            questions={ledung.questions}
            userName={ledung.userName}
            onQuote={quote}
            titleOf={titleOf}
            sessionId={session.id}
            focusQuestion={props.focusQuestion}
            focusMessage={props.focusMessage ?? null}
            onOpenQuestion={openQuestion}
            onOpenBoardThread={boardRepo ? openBoardThread : undefined}
            tint={tint}
          />
          <WorkingIndicator key={session.id} session={session} sessions={ledung.sessions} messages={ledung.messages}
            extra={<MacroChips key={session.id} macros={macros} onUse={fireMacro} onEdit={() => (location.hash = '#/settings/macros')} />} />
          <Composer session={session} tint={tint} run={run} quoteInto={quoteInto} bangShell={ledung.bangShell} />
        </div>
        {showUsage && <SessionUsagePanel sessionId={session.id} onClose={() => setShowUsage(false)} />}
        {files.length > 0 && (
          <FileViewer
            sessionId={session.id}
            stack={files}
            onOpen={openFile}
            onBack={() => setFiles((stack) => stack.slice(0, -1))}
            onClose={() => setFiles([])}
          />
        )}
        {pane && (
          <FilesPane
            session={session}
            sessions={ledung.sessions}
            questions={paneQuestions}
            userName={ledung.userName}
            hidden={paneFile !== null}
            onOpenFile={(path, folder) => setPaneFile({ stack: [path], folder })}
            onOpenQuestion={props.onOpenQuestion}
            onClose={() => setPane(false)}
          />
        )}
        {pane && paneFile && (
          <FileViewer
            sessionId={session.id}
            stack={paneFile.stack}
            folder={paneFile.folder}
            backToPane
            onOpen={(path) => setPaneFile((f) => f && { ...f, stack: [...f.stack, path] })}
            onBack={() => setPaneFile((f) => (f && f.stack.length > 1 ? { ...f, stack: f.stack.slice(0, -1) } : null))}
            onClose={() => { setPaneFile(null); setPane(false); }}
          />
        )}
      </div>
    </LockdownFrame>
  );
}

/**
 * A session's ⚙ at the top right of its header (issue #81): its settings in a panel anchored to the cog,
 * where a manager's Away control was. Away stays visible beside the cog while it is on.
 */
function SessionMenu(props: {
  session: SessionInfo;
  /** Its project, for a manager's name colour pickers (issue #83); null once the project is removed. */
  project: ProjectInfo | null;
  away: AwayInfo | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
  showTechnical: boolean;
  onToggleTechnical: () => void;
  /** The session's tokens so far, or null before the usage is known. */
  usage: number | null;
  showUsage: boolean;
  onToggleUsage: () => void;
  /** Shown left of the cog: the Files pane's button (issue #225). */
  before?: ReactNode;
}) {
  const { session, run } = props;
  const [open, setOpen] = useState(false);
  const corner = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const cog = useRef<HTMLButtonElement>(null);
  const menu = sessionControls(session).menu;
  const ended = session.status === 'ended';
  /** After a button that acts (Usage, Pause, Stop): the menu has done its job. */
  const thenClose = (action: () => void) => () => { setOpen(false); action(); };

  useEffect(() => {
    if (!open) return;
    // The first control takes the focus, so the menu works from the keyboard at once.
    panel.current?.querySelector<HTMLElement>('select:not(:disabled), input, button')?.focus();
    // The cog and the away marker are inside the corner, so their own press toggles instead of closing here.
    const onDown = (e: PointerEvent) => { if (!corner.current?.contains(e.target as Node)) setOpen(false); };
    // Capture, so the menu sees Escape before any page-wide handler (Settings', issue #78) and marks it used.
    const onKey = (e: KeyboardEvent) => {
      if (!escapeClosesMenu(e)) return;
      e.preventDefault();
      setOpen(false);
      cog.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="session-corner" ref={corner}>
      {props.before}
      {session.role === 'manager' && props.away && <AwayMarker away={props.away} onClick={() => setOpen(true)} />}
      <button
        ref={cog}
        className={`icon settings-cog${open ? ' on' : ''}`}
        title={`Session settings: ${session.role === 'manager' ? 'away, ' : ''}permissions, tool calls, usage, pause and stop`}
        aria-label="Session settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'session-menu' : undefined}
        onClick={() => setOpen(!open)}
      >⚙</button>
      {open && (
        <div className="session-menu" id="session-menu" role="dialog" aria-label="Session settings" ref={panel}>
          {menu.includes('away') && (
            <div className="menu-row away-row">
              <span className="menu-label">Away</span>
              <AwayPanel away={props.away} run={run} />
            </div>
          )}
          {menu.includes('permissions') && (
            <label className="mode menu-row" title={MODE_HINT[session.permissionMode]}>
              <span className="menu-label">Permissions</span>
              <select
                value={session.permissionMode}
                disabled={ended || session.status === 'stopping'}
                onChange={(e) => run(() => api.setPermissionMode(session.id, e.target.value as PermissionMode))}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m} title={MODE_HINT[m]}>{MODE_LABEL[m]}</option>
                ))}
              </select>
            </label>
          )}
          {menu.includes('priority') && (
            <label className="mode menu-row" title={session.priorityNote ?? 'Who goes first when sessions wait for a free place'}>
              <span className="menu-label">Priority</span>
              <select value={session.priority} disabled={ended} onChange={(e) => run(() => api.setPriority(session.id, e.target.value as Priority))}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </label>
          )}
          {menu.includes('toolCalls') && (
            <label className="toggle menu-row">
              <input type="checkbox" checked={props.showTechnical} onChange={props.onToggleTechnical} /> Show tool calls
              <kbd title="Works anywhere on this page, the message box included">{TOOL_CALLS_KEY}</kbd>
            </label>
          )}
          {menu.includes('usage') && (
            <button className={`menu-row${props.showUsage ? ' on' : ''}`} onClick={thenClose(props.onToggleUsage)}>
              Usage{props.usage != null ? ` · ${formatTokens(props.usage)}` : ''}
            </button>
          )}
          {(menu.includes('pause') || menu.includes('stop')) && (
            <div className="menu-row menu-buttons">
              {menu.includes('pause') && (
                <button
                  title={session.paused ? 'Let it go on' : 'The command running now finishes; the next tool call waits, and no new turn starts'}
                  onClick={thenClose(() => void run(() => api.setPaused(session.id, !session.paused)))}
                >
                  {session.paused ? 'Resume' : 'Pause'}
                </button>
              )}
              {menu.includes('stop') && <button onClick={thenClose(() => void run(() => api.stop(session.id)))}>Stop</button>}
            </div>
          )}
          {showsMcp(session) && <McpServers sessionId={session.id} />}
          {menu.includes('version') && (
            <div className="menu-row menu-info">
              <span className="menu-label">Claude Code</span>
              <span className="mono">{session.claudeVersion}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A running session's MCP servers in its ⚙ menu, each with Reconnect (issue #118): asked of Claude Code
 * each time the menu opens. Reconnect restarts that server in the session, which keeps its conversation.
 */
function McpServers({ sessionId }: { sessionId: string }) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    api.mcpServers(sessionId).then((s) => current && setServers(s), (e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [sessionId]);
  const reconnect = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      setServers(await api.reconnectMcp(sessionId, name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="menu-row mcp-row">
      <span className="menu-label">MCP servers</span>
      {servers === null && !error && <span className="muted">Asking Claude Code…</span>}
      {servers?.length === 0 && <span className="muted">None.</span>}
      {!!servers?.length && (
        <ul className="mcp-servers">
          {servers.map((s) => (
            <li key={s.name} title={[s.version, s.tools ? `${s.tools} tool${s.tools === 1 ? '' : 's'}` : '', s.error].filter(Boolean).join(' · ') || undefined}>
              <span className={`dot mcp-${s.status}`} />
              <span className="mono">{s.name}</span>
              <span className="muted">{MCP_STATUS_LABEL[s.status] ?? s.status}</span>
              {s.canReconnect
                ? <button className="small" disabled={busy !== null} onClick={() => void reconnect(s.name)}>{busy === s.name ? 'Reconnecting…' : 'Reconnect'}</button>
                : <span className="muted" title="Ledung's own tool server, inside Ledung">Ledung's</span>}
            </li>
          ))}
        </ul>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function Composer({ session, tint, run, quoteInto, bangShell }: {
  session: SessionInfo;
  /** The shell a "!" command runs in on this computer (issue #212). */
  bangShell: string;
  /** The name colour of whom you are writing to (issue #133); undefined: the accent, no tint. */
  tint: CSSProperties | undefined;
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** Set here to what Quote calls with its text (issue #323). */
  quoteInto: RefObject<((quoted: string) => void) | null>;
}) {
  const typing = usePlainTyping();
  // The box's own text, kept per session in this browser (issues #73, #323).
  const [text, setText] = useDraft(session.id);
  // An ended session that can be resumed takes messages: sending resumes it (idle stop and archive).
  const resumable = session.status === 'ended' && !!session.claudeSessionId;
  const ended = (session.status === 'ended' && !resumable) || session.status === 'stopping';
  const stoppable = canInterrupt(session);
  const { box, area, style, grip } = useComposerHeight();
  useEffect(() => {
    quoteInto.current = (quoted) => {
      setText((d) => (d.trim() ? `${d.trimEnd()}\n\n${quoted}` : quoted));
      area.current?.focus();
    };
    return () => {
      quoteInto.current = null;
    };
  }, []);
  // A chat just started opens with the message box focused (issue #211).
  useEffect(() => { if (session.project === CHATS && session.title === 'New chat' && !session.claudeSessionId) area.current?.focus(); }, [session.id]);
  // A "!" line that matches the sensitive list, waiting for the person's yes (decision 3 of #212).
  const [ask, setAsk] = useState<{ command: string; rule: string } | null>(null);
  const command = bangCommand(text);
  const runShell = async (c: string, confirmed: boolean) => {
    const t = text;
    setText('');
    setAsk(null);
    await run(async () => {
      try {
        await api.shell(session.id, c, confirmed);
      } catch (e) {
        setText(t);
        throw e;
      }
    });
  };
  const send = async () => {
    const t = text;
    if (!t.trim()) return;
    // "!cmd" runs in the session's folder; its output goes to Claude as context (issue #212).
    if (command) {
      await run(async () => {
        const check = await api.shellCheck(session.id, command);
        if (check.refused) throw new Error(check.refused);
        if (check.rule) setAsk({ command, rule: check.rule });
        else await runShell(command, false);
      });
      return;
    }
    setText('');
    await run(async () => {
      try {
        await api.send(session.id, t);
      } catch (e) {
        setText(t);
        throw e;
      }
    });
  };
  return (
    <div className={`composer${tint ? ' tinted' : ''}`} style={tint} ref={box}>
      {grip}
      {(session.shell || ask || command) && (
      <div className="bang-strips">
      {session.shell && (
        <div className="bang-running" role="status">
          <span>Running <code>!{session.shell.command}</code>…</span>
          <button className="small" onClick={() => void run(() => api.shellStop(session.id))}>Stop</button>
        </div>
      )}
      {ask && (
        <div className="bang-ask" role="alert">
          <span>{bangAsk(ask.rule)}</span>
          <button className="small primary" onClick={() => void runShell(ask.command, true)}>Run</button>
          <button className="small" onClick={() => setAsk(null)}>Cancel</button>
        </div>
      )}
      {command && !ask && <div className="bang-hint muted">{bangHint(bangShell, session.runner)}</div>}
      </div>
      )}
      <textarea {...typing}
        ref={area}
        style={style}
        value={text}
        disabled={ended}
        placeholder={ended ? 'This session has ended.' : resumable ? 'This session has ended; sending a message resumes it.' : coarsePointer() ? 'Message Claude' : 'Message Claude (Enter to send, Shift+Enter for a new line)'}
        onChange={(e) => {
          setText(e.target.value);
          setAsk(null);
        }}
        onKeyDown={(e) => {
          if (enterSends({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, coarsePointer())) {
            e.preventDefault();
            void send();
          }
        }}
        rows={3}
      />
      {/* The stop sign sits on top of Send, no wider than it, and greys out when there is nothing to interrupt (issue #89). */}
      <div className="composer-buttons">
        <button
          className="stop-sign"
          aria-label="Interrupt"
          title={stoppable ? 'Interrupt' : 'Interrupt: nothing to interrupt now'}
          disabled={!stoppable}
          onClick={() => void run(() => api.interrupt(session.id))}
        >
          STOP
        </button>
        <button className="primary" disabled={ended || !text.trim() || (!!command && !!session.shell)} onClick={() => void send()}>{command ? 'Run' : 'Send'}</button>
      </div>
    </div>
  );
}

/** A clear (clear_session) counting down: the seconds left and Cancel, which keeps the conversation. */
function ClearCountdown({ due, onCancel }: { due: number; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((due - now) / 1000));
  return (
    <span className="clear-countdown" role="status">
      {left > 0 ? `Clearing the conversation in ${left} s` : 'Clearing the conversation…'}{' '}
      <button className="primary" title="Keep the conversation; whoever asked for the clear is told" onClick={onCancel}>Cancel clear</button>
    </span>
  );
}

/**
 * A compact under way (compact_session, compact_self) and for how long. No Cancel: nothing is lost
 * (decided 2026-10-13); Interrupt ends it. The note is shown as the requester's, never as the user's words.
 */
function Compacting({ compacting, by }: { compacting: CompactingInfo; by: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const secs = Math.max(0, Math.floor((now - compacting.startedAt) / 1000));
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const title = `Compact requested by ${by}${compacting.note ? `. Note for the summary: ${compacting.note}` : ''}`;
  return (
    <span className="compacting" role="status" title={title}>
      Compacting… {time}
      {compacting.note && <span className="compacting-note">Note from {by}: {compacting.note}</span>}
    </span>
  );
}

/** A manager's Remote Control (#19): its link on claude.ai, or why there is none. */
function RemoteControlLink({ rc }: { rc: RemoteControlInfo }) {
  if (rc.state === 'unavailable') return <span title={rc.error ?? undefined}>Remote Control unavailable</span>;
  if (!rc.url) return <span>Remote Control starting…</span>;
  const bridge = rc.bridge ? ` (bridge ${rc.bridge})` : '';
  return <a href={rc.url} target="_blank" rel="noreferrer noopener" title={`Remote Control on${bridge}: this manager in the Claude app or on claude.ai`}>Remote Control</a>;
}
