// Settings in one place (issue #365, mockup F, Martin 2026-10-28 in Ledung question #325): tabs along the top
// (Ledung, Chats, one per project, Add project), a side menu of groups in each tab (the project and Chats tabs since
// #366), one group on screen at a time, and features that are off as one line each. Pure helpers, kept apart from the
// components so they can be tested. The tabs and groups are lists, so search (#367) reads every setting's label here.
import type { ProjectInfo, RemoteStatus, UpdateView } from '../../src/shared/protocol.ts';

/** Where a setting is kept: tagged "this browser" or "config" on the page; the server's own carry no tag. */
export type StoredIn = 'browser' | 'config';

export interface SettingsGroup {
  id: string;
  label: string;
  /** The side menu's caption above it; groups of one part follow each other. */
  part: 'ledung' | 'browser' | 'info';
  /** The settings in it, by their label as drawn (a heading, a switch, a one-line feature), for search (#367); test/loopback/settings-frame.ts checks the page against it. */
  settings: SettingEntry[];
}

/** A setting as search (#367) finds it: its label as drawn, a one-line explanation, and words people may search for instead. */
export interface SettingEntry {
  label: string;
  storedIn?: StoredIn;
  about?: string;
  keywords?: string[];
}

/** The Ledung tab's side menu, in its order (issue #365, from f-mix.png). */
export const LEDUNG_GROUPS: SettingsGroup[] = [
  {
    id: 'update', label: 'Update & restart', part: 'ledung',
    settings: [
      { label: 'Update Ledung', about: 'Gets what is new and restarts into it', keywords: ['upgrade', 'version', 'release', 'new'] },
      { label: 'Restart Ledung', about: 'Starts Ledung again on its newest version; sessions keep running', keywords: ['reload', 'reboot'] },
      // A Ledung icon that starts Ledung (issue #415).
      { label: 'Shortcuts', about: 'A Ledung icon on the Desktop and in the Start menu, or in Applications', keywords: ['desktop', 'icon', 'start menu', 'applications', 'launcher', 'dock', 'shortcut'] },
    ],
  },
  {
    id: 'claude', label: 'Claude & usage', part: 'ledung',
    settings: [
      { label: 'Accounts', about: 'The Claude accounts sessions run on', keywords: ['claude', 'login', 'sign in', 'plan', 'subscription'] },
      { label: 'Usage stops', about: 'Hold new turns when a plan window is this full', keywords: ['usage', 'limit', 'quota', 'pause', 'window', 'percent'] },
      { label: 'Claude Code', about: 'The Claude Code program sessions run', keywords: ['cli', 'program', 'version', 'install'] },
      // Per account, with All accounts, and a default repository (#380).
      { label: 'Publish usage', about: 'Send usage figures to a dashboard, per Claude account', keywords: ['usage', 'dashboard', 'share', 'statistics', 'account', 'all accounts', 'repository', 'github'] },
    ],
  },
  {
    id: 'sessions', label: 'Sessions', part: 'ledung',
    settings: [
      { label: 'Skills', about: 'Which of your own skills managers and sessions get', keywords: ['skill', 'plugins', 'commands'] },
      { label: 'Session profiles', storedIn: 'config', about: 'Sets of tools and settings sessions start with', keywords: ['profile', 'tools', 'mcp'] },
    ],
  },
  {
    // Issue #410: chips in a session's info bar and keybinds, global or one project's.
    id: 'macros', label: 'Macros', part: 'ledung',
    settings: [{ label: 'Macros', about: 'Text you send often, as a chip in the info bar, a keybind, or both', keywords: ['macro', 'shortcut', 'keybind', 'key', 'hotkey', 'chip', 'snippet', 'quick', 'text'] }],
  },
  {
    id: 'remote', label: 'Remote & devices', part: 'ledung',
    settings: [
      { label: 'Computers', about: "This computer's name and colour, and the others Ledung knows", keywords: ['machine', 'colour', 'color', 'name'] },
      { label: 'Remote access', about: 'Reach this Ledung from your phone, anywhere, through a relay', keywords: ['phone', 'mobile', 'tunnel', 'internet', 'away'] },
      { label: 'Phones', about: 'Phones that may open this Ledung', keywords: ['phone', 'mobile', 'device', 'pair'] },
      { label: 'Linked computers', about: 'Link this Ledung with another of yours', keywords: ['link', 'machine', 'pair', 'device'] },
      { label: 'Relay', about: 'Run a relay for other people', keywords: ['server', 'host', 'tunnel'] },
      { label: 'Message board', about: 'Managers post to each other on a shared board', keywords: ['board', 'posts', 'messages'] },
    ],
  },
  {
    id: 'look', label: 'Look & feel', part: 'browser',
    settings: [
      { label: 'Appearance', storedIn: 'browser', about: 'Light, dark or the computer\'s own', keywords: ['theme', 'dark', 'light', 'mode', 'colour', 'color', 'system'] },
      { label: 'Autocorrect', storedIn: 'browser', about: 'Whether the browser corrects words as you type', keywords: ['spelling', 'typing', 'spell'] },
      { label: 'Status dot', storedIn: 'browser', about: 'The coloured dot by each session in the sidebar', keywords: ['sidebar', 'dot', 'colour', 'color'] },
      { label: 'Show "Archived" in the sidebar', storedIn: 'browser', about: 'The Archived entry under each project', keywords: ['archive', 'sidebar'] },
      { label: 'Compact sidebar', storedIn: 'browser', about: 'Smaller session cards in the sidebar', keywords: ['sidebar', 'dense', 'small', 'cards'] },
      { label: 'App', storedIn: 'browser', about: 'Install Ledung as an app', keywords: ['install', 'pwa', 'desktop', 'icon'] },
    ],
  },
  {
    id: 'notifications', label: 'Notifications', part: 'browser',
    settings: [{ label: 'Notifications', storedIn: 'browser', about: 'A browser notification when something needs your answer', keywords: ['alert', 'notify', 'sound', 'popup'] }],
  },
  { id: 'config', label: 'Config file', part: 'info', settings: [{ label: 'Config file', storedIn: 'config', about: "Ledung's config file and its problems", keywords: ['json', 'port', 'file', 'settings'] }] },
  { id: 'about', label: 'About', part: 'info', settings: [{ label: 'About', about: 'Version and where Ledung runs from', keywords: ['version', 'licence', 'license'] }] },
];

/** The group the Ledung tab opens on a wide screen when the address names none. */
export const FIRST_GROUP = LEDUNG_GROUPS[0]!.id;

/** The view id of a Ledung group: "settings:remote", shown at #/settings/remote. */
export const groupView = (group: string): string => `settings:${group}`;

/** The setting each banner is about; its Settings button opens that setting's group, not the first one (issue #412). */
export const BANNER_SETTINGS = { usageStop: 'Usage stops', claudeProblem: 'Claude Code', configProblem: 'Config file' } as const;

/** The view a banner's Settings button opens: the group holding its setting, or plain Settings if none does. */
export function bannerView(banner: keyof typeof BANNER_SETTINGS): string {
  const group = LEDUNG_GROUPS.find((g) => g.settings.some((s) => s.label === BANNER_SETTINGS[banner]));
  return group ? groupView(group.id) : 'settings';
}

/**
 * The group a Settings view shows: the one its address names, Claude & usage for the old Accounts page, and the first
 * group for plain Settings or a group that no longer exists. On a phone (`narrow`), plain Settings is the list of
 * groups instead: null.
 */
export function groupOf(view: string | null, narrow: boolean): string | null {
  if (view === 'accounts') return 'claude';
  const named = view?.startsWith('settings:') ? view.slice('settings:'.length) : null;
  if (named && LEDUNG_GROUPS.some((g) => g.id === named)) return named;
  return narrow ? null : FIRST_GROUP;
}

export interface SettingsTab {
  /** "ledung", "chats", "ps:<project>" or "add". */
  id: string;
  label: string;
  /** The view the tab opens. */
  view: string;
}

/**
 * A project's tab (issue #366, mockup E's side menu): today's project page regrouped, with "What always goes to you"
 * as a group of its own instead of under More, and the name colours moved here from the manager's ⚙ (Martin,
 * 2026-10-28, Ledung question #325). The settings are the fields' names as drawn, for search (#367).
 */
export const PROJECT_GROUPS: SettingsGroup[] = [
  {
    id: 'general', label: 'General', part: 'ledung',
    settings: [
      { label: 'Name', about: "The project's name in the sidebar", keywords: ['rename', 'title'] },
      { label: 'Claude account', about: 'The account its sessions run on', keywords: ['account', 'login', 'plan'] },
      { label: 'Model', about: 'The model its sessions use', keywords: ['opus', 'sonnet', 'haiku', 'claude'] },
      { label: 'Model for its manager', about: 'The model its manager uses', keywords: ['opus', 'sonnet', 'haiku', 'claude'] },
      { label: 'Permissions for new sessions', about: 'The permission mode new sessions start in', keywords: ['permission', 'mode', 'auto', 'plan', 'accept'] },
      { label: 'Extra folders', about: 'Folders outside the project its sessions may work in', keywords: ['folder', 'directory', 'path'] },
      // Publishing usage by the project's name (#363), and to a repo of its own (#380).
      { label: 'Publish its usage under its name', about: "Published usage figures carry the project's name", keywords: ['usage', 'dashboard', 'share'] },
      { label: 'Usage repository', about: "The repository its usage is published to, instead of this computer's default one", keywords: ['usage', 'dashboard', 'share', 'repo', 'github', 'board', 'publish'] },
    ],
  },
  {
    id: 'safety', label: 'What always goes to you', part: 'ledung',
    settings: [{ label: 'What always goes to you', about: 'Commands and paths that always ask you first', keywords: ['sensitive', 'safety', 'ask', 'patterns', 'commands', 'production'] }],
  },
  {
    id: 'powers', label: "Manager's powers", part: 'ledung',
    settings: [
      { label: 'What the manager may decide for you', about: 'What its manager may answer in your place', keywords: ['grant', 'decide', 'approve', 'manager'] },
      { label: 'Its manager adds projects and starts or stops other managers without asking you', keywords: ['projects', 'managers', 'manager'] },
      { label: 'Its manager reads and changes workflow settings of your projects', keywords: ['workflow', 'manager'] },
      { label: 'Dev ship command', about: 'A command away mode may let through', keywords: ['ship', 'deploy', 'publish', 'away'] },
      { label: 'Lockdown', about: 'Keep its sessions off the network and out of other tools', keywords: ['network', 'container', 'island', 'security', 'sandbox'] },
    ],
  },
  {
    id: 'skills', label: 'Skills & profiles', part: 'ledung',
    settings: [
      { label: 'Skills', about: 'Which of your own skills its manager and sessions get', keywords: ['skill', 'plugins', 'commands'] },
      { label: 'Profile for its manager', about: 'The session profile its manager starts with', keywords: ['profile', 'tools', 'mcp', 'manager'] },
      { label: 'Profile for its sessions', about: 'The session profile its sessions start with', keywords: ['profile', 'tools', 'mcp'] },
    ],
  },
  {
    id: 'look', label: 'Look', part: 'ledung',
    settings: [
      { label: 'Manager name', about: "Its manager's name colour in the sidebar", keywords: ['colour', 'color', 'manager'] },
      { label: "Its sessions' names", about: "Its sessions' name colour in the sidebar", keywords: ['colour', 'color'] },
    ],
  },
  {
    id: 'workflow', label: 'Workflow', part: 'ledung',
    settings: [
      { label: 'Workflow', about: 'Whether it follows a written process, and which', keywords: ['process', 'agent'] },
      { label: 'Project config for the workflow', about: "The process's config file for this project", keywords: ['process', 'config', 'file'] },
    ],
  },
  {
    id: 'tickets', label: 'Tickets & questions', part: 'ledung',
    settings: [
      { label: 'Ticket pattern', about: 'What a ticket number looks like', keywords: ['issue', 'ticket', 'jira'] },
      { label: 'Ticket link', about: 'Where a ticket number links to', keywords: ['issue', 'ticket', 'url'] },
      { label: 'Question tiers', about: "The order of its questions in Waiting for you", keywords: ['questions', 'waiting', 'priority', 'order'] },
    ],
  },
  { id: 'board', label: 'Message board', part: 'ledung', settings: [{ label: 'Use the board in this project', about: 'Its manager posts to and reads the message board', keywords: ['board', 'posts', 'messages'] }] },
  { id: 'remove', label: 'Remove project', part: 'info', settings: [{ label: 'Remove project', about: 'Takes it off the list and stops its sessions; the folder is not touched', keywords: ['delete', 'remove'] }] },
];

/** The Chats tab (issue #366): the chats' own fields, the same way as a project's. */
export const CHATS_GROUPS: SettingsGroup[] = [
  {
    id: 'general', label: 'General', part: 'ledung',
    settings: [
      { label: 'Folder', storedIn: 'config', about: 'Where new chats start', keywords: ['folder', 'directory', 'path'] },
      { label: 'Permission mode', storedIn: 'config', about: 'The permission mode new chats start in', keywords: ['permission', 'mode', 'auto', 'plan'] },
    ],
  },
  {
    id: 'safety', label: 'What always goes to you', part: 'ledung',
    settings: [{ label: 'What always goes to you', about: 'Commands and paths that always ask you first', keywords: ['sensitive', 'safety', 'ask', 'patterns', 'commands', 'production'] }],
  },
  { id: 'look', label: 'Look', part: 'ledung', settings: [{ label: "Chats' names", about: "The chats' name colour in the sidebar", keywords: ['colour', 'color'] }] },
];

/** A project tab's or the Chats tab's view: "ps:<name>" or "chats", with the group after a slash or colon. */
export interface TabView {
  /** null: the Chats tab. */
  project: string | null;
  group: string | null;
}

/** Which tab and group a view names: "ps:Demo/look", "ps:Demo", "chats:safety", "chats"; null for any other view. */
export function tabView(view: string | null): TabView | null {
  if (view === 'chats') return { project: null, group: null };
  if (view?.startsWith('chats:')) return { project: null, group: view.slice('chats:'.length) };
  if (!view?.startsWith('ps:')) return null;
  // A project's name has no slash (PROJECT_NAME), so the first one ends it.
  const rest = view.slice(3);
  const slash = rest.indexOf('/');
  return slash < 0 ? { project: rest, group: null } : { project: rest.slice(0, slash), group: rest.slice(slash + 1) };
}

/** The view of a group in a project's tab, or in the Chats tab when `project` is null. */
export const tabGroupView = (project: string | null, group: string): string => (project === null ? `chats:${group}` : `ps:${project}/${group}`);

/** The group a project or Chats tab shows: as groupOf does for the Ledung tab, General when none or an unknown one is named. */
export function tabGroupOf(view: TabView, narrow: boolean): string | null {
  const groups = view.project === null ? CHATS_GROUPS : PROJECT_GROUPS;
  if (view.group && groups.some((g) => g.id === view.group)) return view.group;
  return narrow ? null : groups[0]!.id;
}

/** The tabs along the top: Ledung, Chats, one per project in the sidebar's order, then Add project. */
export function settingsTabs(projects: Pick<ProjectInfo, 'name'>[]): SettingsTab[] {
  return [
    { id: 'ledung', label: 'Ledung', view: 'settings' },
    { id: 'chats', label: 'Chats', view: 'chats' },
    ...projects.map((p) => ({ id: `ps:${p.name}`, label: p.name, view: `ps:${p.name}` })),
    { id: 'add', label: '+ Add project', view: 'add' },
  ];
}

/** The tab a view belongs to, or null for a view outside the Settings frame. */
export function tabOf(view: string | null): string | null {
  if (!view) return null;
  if (view === 'settings' || view === 'accounts' || view.startsWith('settings:')) return 'ledung';
  if (view === 'add') return view;
  const t = tabView(view);
  if (t) return t.project === null ? 'chats' : `ps:${t.project}`;
  return null;
}

/**
 * How a feature in Remote & devices shows (issue #365): its full section when it is on, one line with Set up when it
 * is off, greyed with "Needs remote access first" when it needs one that is off, or not at all where it doesn't
 * apply (Relay through the public name, where its settings are refused; Linked computers hides itself there).
 */
export type FeatureState = 'on' | 'off' | 'needs' | 'hidden';

export interface RemoteFeatures {
  remote: FeatureState;
  phones: FeatureState;
  linked: FeatureState;
  relay: FeatureState;
  board: FeatureState;
}

/**
 * `remote`: the relay tunnel, null when this Ledung is on no relay. `relaySetUp`: a relay address or admin key is set,
 * null when the relay admin's settings could not be read. `boardConfigured`: some project names a board.
 */
export function remoteFeatures(s: { remote: RemoteStatus | null; relaySetUp: boolean | null; boardConfigured: boolean }): RemoteFeatures {
  const on = !!s.remote;
  return {
    remote: on ? 'on' : 'off',
    phones: on ? 'on' : 'needs',
    linked: on ? 'on' : 'needs',
    relay: s.relaySetUp === null ? 'hidden' : s.relaySetUp ? 'on' : 'off',
    board: s.boardConfigured ? 'on' : 'off',
  };
}

/** The side menu's word for Remote & devices: "off" while this Ledung is on no relay. */
export const remoteWord = (remote: RemoteStatus | null): string => (remote ? '' : 'off');

/**
 * What Update & restart says about each button. Installed from npm, Ledung is updated with npm and has no git folder
 * or releases, so the clone's words would send a stranger looking for them (issue #412); the panel then says how.
 */
export function updateTexts(view: UpdateView | null): { update: string | null; restart: string } {
  // Not known yet, or it failed to load: no words about where updates come from, which may be npm (review of PR #426).
  if (!view) return { update: null, restart: 'Starts Ledung again on its newest version. Sessions keep running and reconnect.' };
  if (view.npm) return { update: null, restart: 'Starts Ledung again from the installed package, so an update with npm takes effect. Sessions keep running and reconnect.' };
  return {
    update: 'Gets what is new on main from GitHub into the folder this release was built from, builds a new release and restarts into it. Sessions keep running and reconnect.',
    restart: 'Loads the newest release. Sessions keep running and reconnect.',
  };
}

/**
 * The update state in Settings' header and next to Update & restart: "up to date", "3 new changes", "not checked",
 * or what is under way. Empty while it is not known yet.
 */
export function updateWord(view: UpdateView | null): string {
  if (!view) return '';
  if (view.npm) return 'from npm';
  if (!view.available) return 'no updates here';
  if (view.restarting) return 'restarting…';
  if (view.updating) return 'updating…';
  if (view.checking) return 'checking…';
  if (!view.check) return 'not checked';
  if (view.check.upToDate) return 'up to date';
  return `${view.check.behind} new change${view.check.behind === 1 ? '' : 's'}`;
}
