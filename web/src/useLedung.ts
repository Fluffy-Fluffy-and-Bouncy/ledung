// The page's live view of Ledung: sessions, pending permissions and the open session's messages,
// kept up to date over the live connection.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountChoices, AccountInfoView, ChatsInfo, AwayInfo, ConfigStatus, BoardStatus, GitHubBudget, LimitInfo, UsageStopInfo, SignInProblem, MachineInfo, Overview, PermissionInfo, ProjectInfo, QuestionInfo, NewComputerInfo, LinkPairingInfo, RemoteStatus, ServerEvent, SessionInfo, SourceOffer, StoredMessage } from '../../src/shared/protocol.ts';
import type { Macro } from '../../src/shared/macros.ts';
import type { ComputerInfo } from '../../src/shared/computers.ts';
import { api, connectionHello, openConnection, setReconnect } from './api.ts';
import { fetchNewer, PAGE, withNewer } from './catchUp.ts';

export type Connection = 'connecting' | 'open' | 'closed';

export function useLedung(openSessionId: string | null) {
  const [connection, setConnection] = useState<Connection>('connecting');
  /** True once the first full list (hello) has arrived; before that, questions and permissions are just empty. */
  const [loaded, setLoaded] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [permissions, setPermissions] = useState<Record<string, PermissionInfo>>({});
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [canRestart, setCanRestart] = useState(false);
  /** How many times hello has arrived: a new one after a restart means Ledung is back. */
  const [hellos, setHellos] = useState(0);
  /** Ledung came back as another release than this page was loaded from; the page offers a reload. */
  const [updated, setUpdated] = useState(false);
  const [userName, setUserName] = useState('you');
  /** The running version and its source, for Settings → About (issue #332). */
  const [source, setSource] = useState<SourceOffer | null>(null);
  const [questions, setQuestions] = useState<Record<number, QuestionInfo>>({});
  const [limits, setLimits] = useState<LimitInfo[]>([]);
  const [usageStops, setUsageStops] = useState<UsageStopInfo[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [signedOut, setSignedOut] = useState<SignInProblem[]>([]);
  const [claudeProblem, setClaudeProblem] = useState<string | null>(null);
  const [accountProblems, setAccountProblems] = useState<string[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [machine, setMachine] = useState<MachineInfo | null>(null);
  const [away, setAway] = useState<AwayInfo | null>(null);
  const [accounts, setAccounts] = useState<AccountInfoView[]>([]);
  const [accountChoices, setAccountChoices] = useState<AccountChoices>({ chats: null, newProjects: null });
  const [profiles, setProfiles] = useState<string[]>(['full']);
  const [lockdownB, setLockdownB] = useState<string | null>(null);
  const [bangShell, setBangShell] = useState('Git Bash');
  const [defaultIdentity, setDefaultIdentity] = useState<{ email: string | null; organization: string | null; plan: string | null; seenAt: number | null } | null>(null);
  const [board, setBoard] = useState<BoardStatus | null>(null);
  const [github, setGithub] = useState<GitHubBudget[]>([]);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [chats, setChats] = useState<ChatsInfo | null>(null);
  /** The computer tabs and whether this page came through the public name (issue #232). */
  const [computers, setComputers] = useState<ComputerInfo[]>([]);
  const [newComputers, setNewComputers] = useState<NewComputerInfo[]>([]);
  const [linkPairings, setLinkPairings] = useState<LinkPairingInfo[]>([]);
  const [throughPublicName, setThroughPublicName] = useState(false);
  /** The config file's reloads (issue #353). */
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const buildRef = useRef<string | null>(null);
  const openRef = useRef(openSessionId);
  openRef.current = openSessionId;
  /** The shown messages and the session they belong to, for the catch-up after a reconnect. */
  const shownRef = useRef<{ sessionId: string | null; messages: StoredMessage[] }>({ sessionId: null, messages: [] });
  shownRef.current.messages = messages;

  const loadMessages = useCallback(async (sessionId: string) => {
    const list = await api.messages(sessionId);
    if (openRef.current !== sessionId) return;
    shownRef.current = { sessionId, messages: list };
    setMessages(list);
    setHasEarlier(list.length >= PAGE);
  }, []);

  // After a reconnect only what was missed is added, so earlier messages and the reader's place stay (issue #178).
  const catchUp = useCallback(async (sessionId: string) => {
    const shown = shownRef.current;
    const last = shown.messages.at(-1);
    if (shown.sessionId !== sessionId || !last) return loadMessages(sessionId);
    const newer = await fetchNewer(last.id, (after) => api.messagesAfter(sessionId, after));
    if (openRef.current !== sessionId) return;
    setMessages((m) => withNewer(m, newer));
  }, [loadMessages]);

  const loadEarlier = useCallback(async () => {
    const sessionId = openRef.current;
    const first = messages[0];
    if (!sessionId || !first) return;
    const list = await api.messages(sessionId, first.id);
    if (openRef.current !== sessionId) return;
    setMessages((m) => [...list, ...m]);
    setHasEarlier(list.length >= PAGE);
  }, [messages]);

  useEffect(() => {
    shownRef.current = { sessionId: null, messages: [] };
    setMessages([]);
    setHasEarlier(false);
    if (openSessionId) loadMessages(openSessionId).catch(() => {});
  }, [openSessionId, loadMessages]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 500;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      setConnection('connecting');
      // Its key dies when it closes (api.ts); a change then waits for the next hello's key.
      ws = openConnection(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        retry = 500;
        setConnection('open');
      };
      ws.onclose = () => {
        setConnection('closed');
        if (!stopped) timer = setTimeout(connect, (retry = Math.min(retry * 2, 10000)));
      };
      ws.onmessage = (e) => {
        const event = JSON.parse(e.data) as ServerEvent;
        switch (event.type) {
          case 'hello':
            // Reconnected to another release (after a restart): offer its page rather than reloading
            // under Simon's hands (decision of 2026-10-13).
            if (buildRef.current === null) buildRef.current = event.build;
            else if (buildRef.current !== event.build) setUpdated(true);
            connectionHello(event.pageKey ?? null);
            setHellos((n) => n + 1);
            setLoaded(true);
            setCanRestart(event.canRestart);
            setUserName(event.userName);
            setSource(event.source ?? null);
            setQuestions(Object.fromEntries(event.questions.map((q) => [q.id, q])));
            setLimits(event.limits);
            setUsageStops(event.usageStops ?? []);
            setMacros(event.macros ?? []);
            setAway(event.away ?? null);
            setSessions(event.sessions);
            setProjects(event.projects);
            setBoard(event.board ?? null);
            setGithub(event.github ?? []);
            setProfiles(event.profiles ?? ['full']);
            setLockdownB(event.lockdownB ?? null);
            setBangShell(event.bangShell ?? 'Git Bash');
            setRemote(event.remote ?? null);
            setChats(event.chats ?? null);
            setComputers(event.computers ?? []);
            setNewComputers(event.newComputers ?? []);
            setLinkPairings(event.linkPairings ?? []);
            setThroughPublicName(event.throughPublicName ?? false);
            setConfigStatus(event.config ?? null);
            setPermissions(Object.fromEntries(event.permissions.map((p) => [p.id, p])));
            // After a reconnect, catch up on anything missed.
            if (openRef.current) catchUp(openRef.current).catch(() => {});
            api.machine().then(setMachine, () => {});
            api.accounts().then((a) => {
              setAccounts(a.accounts);
              setDefaultIdentity(a.defaultIdentity as typeof defaultIdentity);
              setAccountChoices(a.choices);
              setSignedOut(a.signedOut ?? []);
              setClaudeProblem(a.claudeProblem ?? null);
              setAccountProblems(a.configFileProblems ?? []);
            }, () => {});
            break;
          case 'session':
            setSessions((list) => {
              const i = list.findIndex((s) => s.id === event.session.id);
              return i === -1 ? [event.session, ...list] : list.map((s) => (s.id === event.session.id ? event.session : s));
            });
            break;
          case 'limits':
            setLimits(event.limits);
            break;
          case 'macros':
            setMacros(event.macros);
            break;
          case 'usageStops':
            setUsageStops(event.usageStops);
            break;
          case 'config':
            setConfigStatus(event.config);
            break;
          case 'projects':
            setProjects(event.projects);
            break;
          case 'accounts':
            setAccounts(event.accounts);
            setDefaultIdentity(event.defaultIdentity as typeof defaultIdentity);
            setAccountChoices(event.choices);
            setSignedOut(event.signedOut ?? []);
            setClaudeProblem(event.claudeProblem ?? null);
            setAccountProblems(event.configFileProblems ?? []);
            break;
          case 'board':
            setBoard(event.board);
            break;
          case 'github':
            setGithub(event.github);
            break;
          case 'remote':
            setRemote(event.remote);
            break;
          case 'newComputers':
            setNewComputers(event.computers);
            break;
          case 'linkPairings':
            setLinkPairings(event.pairings);
            break;
          case 'chats':
            setChats(event.chats);
            break;
          case 'computers':
            setComputers(event.computers);
            break;
          case 'machine':
            setMachine(event.machine);
            break;
          case 'away':
            setAway(event.away);
            break;
          case 'question':
            setQuestions((q) => ({ ...q, [event.question.id]: event.question }));
            break;
          case 'permission':
            setPermissions((p) => ({ ...p, [event.permission.id]: event.permission }));
            break;
          case 'message':
            if (event.message.sessionId === openRef.current) {
              setMessages((m) => (m.some((x) => x.id === event.message.id) ? m : [...m, event.message]));
            }
            break;
        }
      };
    };
    connect();
    // A connection Ledung no longer has, though the browser never heard it close (#303): left without its
    // handlers, so its late close can't schedule a second connection, and replaced at once.
    setReconnect(() => {
      if (stopped) return;
      clearTimeout(timer);
      if (ws) {
        ws.onopen = ws.onclose = ws.onmessage = null;
        ws.close();
      }
      retry = 500;
      connect();
    });
    return () => {
      stopped = true;
      setReconnect(null);
      clearTimeout(timer);
      ws?.close();
    };
  }, [catchUp]);

  // Usage per session for the session list and the Overview; refreshed every 20 s (step 5).
  useEffect(() => {
    let current = true;
    const load = () => api.overview().then((o) => current && setOverview(o), () => {});
    void load();
    const timer = setInterval(load, 20000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);

  return { connection, loaded, canRestart, hellos, updated, userName, source, questions, limits, usageStops, macros, signedOut, claudeProblem, accountProblems, overview, machine, away, accounts, accountChoices, defaultIdentity, board, github, remote, computers, newComputers, linkPairings, throughPublicName, configStatus, chats, profiles, lockdownB, bangShell, sessions, projects, permissions, messages, hasEarlier, loadEarlier };
}
