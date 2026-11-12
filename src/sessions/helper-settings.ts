// Every setting the Ledung Helper can change (docs/steps/ledung-helper.md, "Every setting"; Simon, 2026-11-12: "it
// should be able to help me with all settings if I ask it"). Each setting is planned first: what it changes, whether
// that opens or loosens anything (then Ledung's approval card shows the before → after, a risk and a narrower choice),
// whether it needs Restart Ledung, and how it is applied: through the same paths the page uses. Secrets are never
// handled here, and lockdown is never loosened.
import path from 'node:path';
import { SETTING_RELOAD, type LedungConfig, type ProjectConfig, type SettingName } from '../config.ts';
import { configWith, writeConfig } from '../config-write.ts';
import { defaultProjectsFolder, defaultRoots, isInside } from '../projects/browse.ts';
import { lockdownOf } from '../projects/lockdown.ts';
import { loosensGate } from '../projects/gate.ts';
import { PERMISSION_MODES, type PermissionMode } from '../shared/protocol.ts';

/** What the settings need from Ledung: the running config and its file, and the page's own setters. */
export interface SettingsCtx {
  config(): LedungConfig;
  configFile: string | null;
  /** The watcher reads the file now (or the manager applies it), so a live setting counts at once. */
  reloadConfig(): void;
  setLimit(n: number): void;
  limit(): number;
  usageStops(): { account: string; kind: string; percent: number | null }[];
  setUsageStop(account: string, kind: string, percent: number | null): void;
  macros(): unknown[];
  setMacros(body: unknown): void;
  skillDefaults(): unknown;
  setSkillDefaults(body: unknown): void;
  accountChoices(): { chats: string | null; newProjects: string | null };
  setAccountChoices(body: unknown): void;
  chats(): { sensitive: unknown; colour: unknown; permissionMode: PermissionMode };
  updateChats(body: Record<string, unknown>): void;
  chatsLoosen(body: Record<string, unknown>): boolean;
  setChatsColour(colour: unknown): void;
  helperModel(): string;
  setHelperModel(model: unknown): void;
  /** This computer's update channel and check-in, from the server's own parts; null where they aren't. */
  server: { channel(): string; setChannel(c: 'public' | 'dev'): void; checkIn(): boolean; setCheckIn(on: boolean): void } | null;
  relayAddress(): string | null;
  setRelayAddress(relay: string): void;
  project(name: string): ProjectConfig | null;
  updateProject(name: string, config: ProjectConfig): void;
  renameProject(name: string, to: string): void;
}

/** A setting as the helper may change it. */
export interface SettingDef {
  id: string;
  label: string;
  /** a: at once, loosens nothing · b: may loosen (asked) · c: restart · d: a secret · browser: this browser's own. */
  kind: 'config' | 'page' | 'project' | 'secret' | 'browser';
  where: string;
  /** How to give the value. */
  value: string;
}

const CONFIG_SETTINGS: SettingDef[] = [
  { id: 'browseRoots', label: 'Folders Ledung may use', kind: 'config', where: 'config file', value: 'the whole list of folders, full paths; [] for the home folder' },
  { id: 'projectsFolder', label: 'Where new projects go', kind: 'config', where: 'config file', value: 'a full path' },
  { id: 'port', label: 'Port', kind: 'config', where: 'config file (restart)', value: 'a number' },
  { id: 'userName', label: 'Your name in the config file', kind: 'config', where: 'config file (restart)', value: 'a name' },
  { id: 'lan', label: 'Home network access', kind: 'config', where: 'config file (restart)', value: 'this computer\'s address on the network, true for every network, or false' },
  { id: 'lanSignIn', label: 'Sign-in on the home network', kind: 'config', where: 'config file (restart)', value: 'true or false' },
  { id: 'sensitive', label: 'What always goes to you, for every project', kind: 'config', where: 'config file', value: '{ commandPatterns, pathPatterns, mcpTools }, each the whole list' },
  { id: 'keepToolResultsDays', label: 'Days old tool output is kept whole', kind: 'config', where: 'config file', value: 'a number of days' },
  { id: 'idleStopMinutes', label: 'Minutes before an idle session stops', kind: 'config', where: 'config file', value: 'a number of minutes, 0 for never' },
  { id: 'windowsShell', label: 'Shell for "!" lines on Windows', kind: 'config', where: 'config file', value: '"bash" or "powershell"' },
  { id: 'claudeAccounts', label: 'Claude accounts in the config file', kind: 'config', where: 'config file', value: 'the whole block, by name' },
  { id: 'pluginsOff', label: 'Plugins kept off', kind: 'config', where: 'config file', value: 'the whole list of plugin ids' },
  { id: 'profiles', label: 'Session profiles', kind: 'config', where: 'config file', value: 'the whole block' },
  { id: 'defaultProfiles', label: 'Default session profiles', kind: 'config', where: 'config file', value: '{ manager, session }' },
  { id: 'workflow', label: 'Workflow (written process)', kind: 'config', where: 'config file', value: 'the whole block' },
  { id: 'workflows', label: 'Workflows (written processes)', kind: 'config', where: 'config file', value: 'the whole list' },
  { id: 'remoteControl', label: 'Remote Control for managers', kind: 'config', where: 'config file', value: 'true or false' },
  { id: 'claudeExecutable', label: 'The Claude Code sessions run', kind: 'config', where: 'config file', value: '"installed", "bundled" or a full path' },
  { id: 'chats', label: 'Chats (folder, mode, patterns)', kind: 'config', where: 'config file', value: '{ folder, permissionMode, sensitive }' },
  { id: 'board', label: 'Message board', kind: 'config', where: 'config file (restart)', value: 'the whole block' },
  { id: 'computers', label: 'Computer tabs', kind: 'config', where: 'config file (restart)', value: 'the whole list' },
];

const PAGE_SETTINGS: SettingDef[] = [
  { id: 'workingLimit', label: 'Sessions that may work at once', kind: 'page', where: 'Machine panel', value: 'a number' },
  { id: 'usageStop', label: 'A usage stop', kind: 'page', where: 'Settings → Claude & usage → Usage stops', value: '{ account ("default" or a name), kind ("five_hour" or "seven_day"), percent (null removes it) }' },
  { id: 'macros', label: 'Macros', kind: 'page', where: 'Settings → Macros', value: 'the whole list, as Settings keeps it' },
  { id: 'skillDefaults', label: 'Skills managers and sessions get', kind: 'page', where: 'Settings → Sessions', value: 'the whole choice, as Settings keeps it' },
  { id: 'accountChoices', label: 'Account for chats and new projects', kind: 'page', where: 'Settings → Claude & usage → Accounts', value: '{ chats, newProjects }: an account name, or "" for this computer\'s login' },
  { id: 'chatsSensitive', label: "Chats' own sensitive list", kind: 'page', where: 'Settings → Chats', value: '{ commandPatterns, pathPatterns, mcpTools }, each the whole list' },
  { id: 'chatsColour', label: "Chats' name colour", kind: 'page', where: 'Settings → Chats', value: 'a palette colour or null' },
  { id: 'helperModel', label: "The Ledung Helper's model", kind: 'page', where: 'Settings → Ledung Helper', value: '"sonnet", "haiku" or "opus"' },
  { id: 'updateChannel', label: 'Update channel', kind: 'page', where: 'Settings → About', value: '"public" or "dev"' },
  { id: 'checkIn', label: 'Anonymous usage count', kind: 'page', where: 'Settings → About', value: 'true or false' },
  { id: 'relayAddress', label: 'Relay address', kind: 'page', where: 'Settings → Remote & devices → Relay', value: 'wss://… (no path)' },
];

const PROJECT_SETTINGS: SettingDef[] = [
  { id: 'project.extraFolders', label: 'Extra folders its sessions may work in', kind: 'project', where: 'project → General', value: 'the whole list of full paths' },
  { id: 'project.projectToolsUnasked', label: 'Its manager adds projects and starts or stops managers without asking', kind: 'project', where: "project → Manager's powers", value: 'true or false' },
  { id: 'project.projectSettingsTools', label: "Its manager reads and changes projects' workflow settings", kind: 'project', where: "project → Manager's powers", value: 'true or false' },
  { id: 'project.lockdown', label: 'Lockdown', kind: 'project', where: "project → Manager's powers", value: '"A" or "B" (only tightening; off is the person\'s own, in the page)' },
  { id: 'project.worktreeSetup', label: "Command run in a run's new worktree", kind: 'project', where: 'project → Workflow', value: 'a command, or null' },
  { id: 'project.followFlow', label: 'Ledung follows its drawn workflow', kind: 'project', where: 'project → Workflow', value: 'true or false' },
  { id: 'project.name', label: 'Its name', kind: 'project', where: 'project → General', value: 'the new name' },
];

/** Never through the helper: the person types these in the page (class d). */
export const SECRET_SETTINGS: { id: string; label: string; open: string }[] = [
  { id: 'relayAdminKey', label: 'Relay admin key', open: 'settings:remote' },
  { id: 'cloudflareToken', label: 'Cloudflare token', open: 'settings:remote' },
  { id: 'joinCode', label: 'Join code for a relay', open: 'settings:remote' },
  { id: 'linkCode', label: 'Link codes for linked computers', open: 'settings:remote' },
  { id: 'invite', label: 'Relay invites', open: 'settings:remote' },
  { id: 'phones', label: 'Phones and passkeys', open: 'settings:remote' },
  { id: 'accountSignIn', label: 'Claude account sign-in', open: 'settings:claude' },
  { id: 'remote', label: 'The remote block (relay secrets)', open: 'settings:remote' },
  { id: 'relayJoin', label: 'Relay join settings', open: 'settings:remote' },
];

/** This browser's own: a card's button sets them in the person's browser (an apply card). */
export const BROWSER_SETTINGS = ['theme', 'autocorrect', 'statusDot', 'archivedLink', 'compactSidebar', 'shortcuts', 'signInStart'] as const;

export const ALL_SETTINGS: SettingDef[] = [...CONFIG_SETTINGS, ...PAGE_SETTINGS, ...PROJECT_SETTINGS];

export class SettingRefused extends Error {}

/** A planned change: what it changes, what it opens (empty: nothing), and how to apply it. */
export interface SettingPlan {
  label: string;
  changes: string[];
  opens: string[];
  risk?: string;
  narrower?: string;
  restart: boolean;
  apply(): string;
}

const show = (v: unknown) => (v === undefined || v === null ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));
const MODE_ORDER: Record<PermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2, auto: 3 };

/** Folders a list of roots allows that `before` didn't. */
function newlyAllowed(roots: string[], before: string[]): string[] {
  return roots.filter((r) => !isInside(r, before) && !before.some((b) => path.relative(b, r) === ''));
}

/** A narrower choice for a folder that opens a lot: a folder of its own under it. */
function narrowerFor(folder: string): string {
  const root = path.parse(folder).root;
  // A whole drive (or /): a folder of its own under it; anything narrower is offered as it is.
  if (path.resolve(folder) === path.resolve(root)) return `a folder of its own instead, e.g. ${path.join(root, 'Dev')}`;
  return '';
}

function configPlan(ctx: SettingsCtx, key: SettingName, value: unknown): SettingPlan {
  if (!ctx.configFile) throw new SettingRefused('This Ledung has no config file it can write.');
  const before = ctx.config();
  const { raw, config: after } = configWith(ctx.configFile, key, value === null ? undefined : value);
  const def = CONFIG_SETTINGS.find((d) => d.id === key)!;
  const opens: string[] = [];
  let risk: string | undefined;
  let narrower: string | undefined;
  const allowedBefore = [...defaultRoots(before.browseRoots), defaultProjectsFolder(before.projectsFolder)];
  switch (key) {
    case 'browseRoots': {
      const added = newlyAllowed(defaultRoots(after.browseRoots), allowedBefore);
      if (added.length) {
        opens.push(`folders Ledung may use ${defaultRoots(before.browseRoots).join(', ')} → ${defaultRoots(after.browseRoots).join(', ')}`);
        risk = `The folder browser, chats and new projects may then reach everything under ${added.join(', ')}, other programs' and users' files too.`;
        narrower = narrowerFor(added[0]!) || undefined;
      }
      break;
    }
    case 'projectsFolder': {
      const now = defaultProjectsFolder(after.projectsFolder);
      if (newlyAllowed([now], allowedBefore).length) {
        opens.push(`where new projects go ${defaultProjectsFolder(before.projectsFolder)} → ${now}, a folder Ledung didn't use before`);
        risk = `Ledung may then use everything under ${now}.`;
        narrower = narrowerFor(now) || undefined;
      }
      break;
    }
    case 'lan':
      if (after.lan && !before.lan) {
        opens.push(`home network access ${show(before.lan ?? false)} → ${show(after.lan)}`);
        risk = after.lanSignIn ? 'Devices on that network can reach Ledung; they sign in once with a link.' : 'Anyone on that network can use Ledung, and through it run commands on this computer: sign-in is off.';
        if (after.lan === true) narrower = "this computer's own address on the network instead of every network (true also opens VPNs)";
      } else if (after.lan === true && before.lan !== true) {
        opens.push(`home network access ${show(before.lan)} → every network the computer is on`);
        narrower = 'the single address you use';
      }
      break;
    case 'lanSignIn':
      if (!after.lanSignIn && before.lanSignIn) {
        opens.push('sign-in on the home network on → off');
        risk = 'Anyone on that network can then use Ledung without signing in, and through it run commands on this computer.';
        narrower = 'keep sign-in on: each device signs in once with a link';
      }
      break;
    case 'sensitive':
    case 'chats': {
      const lists = (c: LedungConfig) => (key === 'sensitive' ? c.sensitive : c.chats.sensitive);
      for (const l of ['commandPatterns', 'pathPatterns', 'mcpTools'] as const) {
        const gone = lists(before)[l].filter((p) => !lists(after)[l].includes(p));
        if (gone.length) opens.push(`${key === 'chats' ? "chats' " : ''}sensitive ${l} removed: ${gone.map(show).join(', ')}`);
      }
      if (key === 'chats' && MODE_ORDER[after.chats.permissionMode] > MODE_ORDER[before.chats.permissionMode]) opens.push(`chats' permission mode ${before.chats.permissionMode} → ${after.chats.permissionMode}`);
      if (opens.length) risk = 'Those calls no longer always reach you.';
      break;
    }
    case 'pluginsOff': {
      const back = before.pluginsOff.filter((p) => !after.pluginsOff.includes(p));
      if (back.length) opens.push(`plugins back on: ${back.join(', ')}`);
      break;
    }
    case 'remoteControl':
      if (after.remoteControl && !before.remoteControl) opens.push('Remote Control for managers off → on');
      if (opens.length) risk = 'Managers then show in the Claude app on a phone, signed in to your Claude account.';
      break;
    case 'profiles':
    case 'defaultProfiles':
    case 'workflow':
    case 'workflows':
    case 'claudeExecutable':
    case 'board':
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        opens.push(`${def.label} ${show(before[key])} → ${show(after[key])}`);
        risk = key === 'board' ? 'Managers then post to the board, outside this computer.' : key === 'claudeExecutable' ? 'Sessions then run another program.' : 'This changes what sessions may use or what managers follow.';
      }
      break;
  }
  const restart = SETTING_RELOAD[key] === 'restart';
  const file = ctx.configFile;
  return {
    label: def.label, changes: [`${def.label}: ${show(before[key])} → ${show(after[key])}`], opens, risk, narrower, restart,
    apply: () => {
      writeConfig(file, raw);
      ctx.reloadConfig();
      return `Saved ${def.label} in the config file${restart ? '; it applies after Restart Ledung' : ', and it applies now'}.`;
    },
  };
}

function pagePlan(ctx: SettingsCtx, id: string, value: unknown): SettingPlan {
  const def = PAGE_SETTINGS.find((d) => d.id === id)!;
  const plan = (before: unknown, opens: string[], apply: () => void, risk?: string, narrower?: string): SettingPlan => ({
    label: def.label, changes: [`${def.label}: ${show(before)} → ${show(value)}`], opens, risk, narrower, restart: false,
    apply: () => {
      apply();
      return `Saved ${def.label}; it applies now.`;
    },
  });
  switch (id) {
    case 'workingLimit': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new SettingRefused('Give a whole number from 1 to 100.');
      return plan(ctx.limit(), [], () => ctx.setLimit(n));
    }
    case 'usageStop': {
      const v = (value ?? {}) as { account?: unknown; kind?: unknown; percent?: unknown };
      const account = String(v.account ?? 'default');
      const kind = String(v.kind ?? '');
      const percent = v.percent === null || v.percent === undefined ? null : Number(v.percent);
      const had = ctx.usageStops().find((s) => s.account === account && s.kind === kind)?.percent ?? null;
      const opens = (percent === null && had !== null) || (percent !== null && had !== null && percent > had) ? [`usage stop for ${account} (${kind}) ${had}% → ${percent === null ? 'none' : `${percent}%`}`] : [];
      return plan(had, opens, () => ctx.setUsageStop(account, kind, percent), opens.length ? 'Work then runs past that point of the plan window.' : undefined);
    }
    case 'macros':
      return plan(ctx.macros(), ['macros changed: their text goes out as your own words when you use one'], () => ctx.setMacros({ macros: value }), 'A macro sends its text as if you typed it.');
    case 'skillDefaults':
      return plan(ctx.skillDefaults(), [], () => ctx.setSkillDefaults(value));
    case 'accountChoices':
      return plan(ctx.accountChoices(), [], () => ctx.setAccountChoices(value));
    case 'chatsSensitive': {
      const body = { sensitive: value } as Record<string, unknown>;
      const opens = ctx.chatsLoosen(body) ? ["chats' sensitive list: a pattern removed"] : [];
      return plan(ctx.chats().sensitive, opens, () => ctx.updateChats(body), opens.length ? 'Those calls in chats no longer always reach you.' : undefined);
    }
    case 'chatsColour':
      return plan(ctx.chats().colour, [], () => ctx.setChatsColour(value));
    case 'helperModel':
      return plan(ctx.helperModel(), [], () => ctx.setHelperModel(value));
    case 'updateChannel': {
      if (!ctx.server) throw new SettingRefused('The update channel is not available in this Ledung.');
      if (value !== 'public' && value !== 'dev') throw new SettingRefused('Give "public" or "dev".');
      const before = ctx.server.channel();
      return plan(before, value === 'dev' && before !== 'dev' ? ['update channel public → dev'] : [], () => ctx.server!.setChannel(value), value === 'dev' ? 'Dev builds come between public releases and are less tested.' : undefined);
    }
    case 'checkIn': {
      if (!ctx.server) throw new SettingRefused('The usage count is not available in this Ledung.');
      const on = value === true;
      if (typeof value !== 'boolean') throw new SettingRefused('Give true or false.');
      const before = ctx.server.checkIn();
      return plan(before, on && !before ? ['anonymous usage count off → on'] : [], () => ctx.server!.setCheckIn(on), on ? 'Once a day it sends a random install ID, the version, the update channel and the operating system.' : undefined);
    }
    case 'relayAddress': {
      if (typeof value !== 'string' || !value.trim()) throw new SettingRefused('Give the relay as wss://relay.example.org.');
      const before = ctx.relayAddress();
      return plan(before, [`relay address ${show(before)} → ${value.trim()}`], () => ctx.setRelayAddress(value.trim()), 'This computer then connects to that relay.');
    }
  }
  throw new SettingRefused(`There is no setting "${id}".`);
}

function projectPlan(ctx: SettingsCtx, id: string, value: unknown, projectName: string | undefined): SettingPlan {
  const def = PROJECT_SETTINGS.find((d) => d.id === id)!;
  if (!projectName) throw new SettingRefused(`${def.label} is a project's setting: give the project.`);
  const before = ctx.project(projectName);
  if (!before) throw new SettingRefused(`There is no project named "${projectName}". Use list_projects.`);
  if (lockdownOf(before).level !== 'off') throw new SettingRefused(`The project "${projectName}" is locked: only you change it, in the page.`);
  const field = id.slice('project.'.length);
  if (field === 'name') {
    if (typeof value !== 'string' || !value.trim()) throw new SettingRefused('Give the new name.');
    const to = value.trim();
    return {
      label: def.label, changes: [`${projectName}'s name → ${to}`], opens: [], restart: false,
      apply: () => {
        ctx.renameProject(projectName, to);
        return `Renamed "${projectName}" to "${to}".`;
      },
    };
  }
  const next: Record<string, unknown> = { ...before };
  if (field === 'lockdown') {
    if (value !== 'A' && value !== 'B') throw new SettingRefused('Lockdown can only be tightened here, to "A" or "B"; switching it off or down is your own, in the page.');
    next.lockdown = { ...(before.lockdown ?? {}), level: value };
  } else if (value === null) delete next[field];
  else next[field] = value;
  const opens: string[] = [];
  let risk: string | undefined;
  if (field === 'extraFolders') {
    const added = ((value as string[] | null) ?? []).filter((f) => !(before.runner === 'local' ? before.extraFolders ?? [] : []).includes(f));
    if (added.length) {
      opens.push(`${projectName}'s extra folders: added ${added.join(', ')}`);
      risk = 'Its sessions may then work in those folders too.';
    }
  } else if (loosensGate(before, next)) {
    opens.push(`${projectName}'s ${def.label.toLowerCase()} ${show((before as Record<string, unknown>)[field])} → ${show(value)}`);
    risk = field === 'worktreeSetup' ? 'Ledung runs that command itself at each run\'s start, past every prompt.' : 'Its manager then does that without asking you.';
  }
  return {
    label: def.label, changes: [`${projectName}: ${def.label} ${show((before as Record<string, unknown>)[field])} → ${show(value)}`], opens, risk, restart: false,
    apply: () => {
      ctx.updateProject(projectName, next as unknown as ProjectConfig);
      return `Saved ${def.label} for "${projectName}"; its manager and sessions get it when they next start or resume.`;
    },
  };
}

/** The plan for a change; throws SettingRefused with the reason, or what to do instead for a secret or browser setting. */
export function planSetting(ctx: SettingsCtx, id: string, value: unknown, project?: string): SettingPlan {
  const secret = SECRET_SETTINGS.find((s) => s.id === id);
  if (secret) throw new SettingRefused(`${secret.label} holds a secret, which never passes through you: reply with a link card to ${secret.open === 'settings:claude' ? '"accounts"' : '"devices"'}, where they type it themselves.`);
  if ((BROWSER_SETTINGS as readonly string[]).includes(id)) throw new SettingRefused(`${id} is kept in their browser: reply with an apply card ({ kind: "apply", setting: "${id}", value }); its button sets it there.`);
  if (id === 'projects') throw new SettingRefused('Projects are added and changed with add_project, create_project and the project tools.');
  if (id === 'maxWorkingSessions') return pagePlan(ctx, 'workingLimit', value);
  if (id === 'usageStops') throw new SettingRefused('Usage stops go one at a time: setting "usageStop" with { account, kind, percent }.');
  if (CONFIG_SETTINGS.some((d) => d.id === id)) return configPlan(ctx, id as SettingName, value);
  if (PAGE_SETTINGS.some((d) => d.id === id)) return pagePlan(ctx, id, value);
  if (PROJECT_SETTINGS.some((d) => d.id === id)) return projectPlan(ctx, id, value, project);
  throw new SettingRefused(`There is no setting "${id}". ledung_settings lists them.`);
}

/** The approval card's rule for a plan that opens something; null: it runs at once. Built one way, to compare at run. */
export function settingRule(plan: SettingPlan): string | null {
  if (!plan.opens.length) return null;
  return `a change to Ledung's settings that opens up: ${plan.opens.join('; ')}${plan.risk ? `. Risk: ${plan.risk}` : ''}${plan.narrower ? ` Narrower: ${plan.narrower}.` : ''}`;
}

/** Every setting with its current value (never a secret), for ledung_settings. */
export function settingsList(ctx: SettingsCtx): string {
  const c = ctx.config() as unknown as Record<string, unknown>;
  const lines = [
    'Config file (change_ledung_setting writes it; "(restart)" ones apply after Restart Ledung):',
    ...CONFIG_SETTINGS.map((d) => `- ${d.id} (${d.label}${SETTING_RELOAD[d.id as SettingName] === 'restart' ? ', restart' : ''}): ${show(d.id === 'browseRoots' ? defaultRoots(ctx.config().browseRoots) : d.id === 'projectsFolder' ? defaultProjectsFolder(ctx.config().projectsFolder) : c[d.id])} · give ${d.value}`),
    'In the page:',
    `- workingLimit: ${ctx.limit()} · usageStop: ${show(ctx.usageStops())} · accountChoices: ${show(ctx.accountChoices())} · helperModel: ${ctx.helperModel()}`,
    `- updateChannel: ${ctx.server?.channel() ?? 'not here'} · checkIn: ${ctx.server ? ctx.server.checkIn() : 'not here'} · relayAddress: ${show(ctx.relayAddress())}`,
    `- macros, skillDefaults, chatsSensitive, chatsColour: as Settings shows them`,
    ...PAGE_SETTINGS.map((d) => `  ${d.id}: give ${d.value}`),
    "A project's (give project): " + PROJECT_SETTINGS.map((d) => `${d.id} (${d.value})`).join('; ') + '. Model, effort, mode, account, grant, sensitive list, workflow, tiers, tickets: set_project_basics and set_project_settings.',
    `Their browser's own (an apply card): ${BROWSER_SETTINGS.join(', ')}. Notifications and Install as app: a link card to "settings" (the browser asks them itself).`,
    `Secrets, never through you (a link card): ${SECRET_SETTINGS.map((s) => s.label).join(', ')}.`,
  ];
  return lines.join('\n');
}

export const MODES = PERMISSION_MODES;
