// Every setting the Ledung Helper can change (docs/steps/ledung-helper.md, "Every setting"; Simon, 2026-11-12: "it
// should be able to help me with all settings if I ask it"). Each setting is planned first: what it changes, whether
// that opens or loosens anything (then Ledung's approval card shows the before → after, a risk and a narrower choice),
// whether it needs Restart Ledung, and how it is applied: through the same paths the page uses. Secrets are never
// handled here, and lockdown is never loosened.
import path from 'node:path';
import { SETTING_RELOAD, type LedungConfig, type ProjectConfig, type SettingName } from '../config.ts';
import { configWith, savedConfig, writeConfig } from '../config-write.ts';
import { defaultProjectsFolder, defaultRoots, isInside } from '../projects/browse.ts';
import { lockdownOf } from '../projects/lockdown.ts';
import { loosensGate } from '../projects/gate.ts';
import { PERMISSION_MODES, type PermissionMode } from '../shared/protocol.ts';
import { framingPages } from '../shared/computers.ts';

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
/** open: the link card's target (helper-cards.ts CARD_LINKS), which opens Settings at that very section. */
export const SECRET_SETTINGS: { id: string; label: string; open: string; where: string }[] = [
  { id: 'relayAdminKey', label: 'Relay admin key', open: 'relay', where: 'Settings → Remote & devices → Relay' },
  { id: 'cloudflareToken', label: 'Cloudflare token', open: 'relay', where: 'Settings → Remote & devices → Relay' },
  { id: 'joinCode', label: 'Join code for a relay', open: 'join-code', where: 'Settings → Remote & devices → Remote access → Join with a code' },
  { id: 'linkCode', label: 'Link codes for linked computers', open: 'linked-computers', where: 'Settings → Remote & devices → Linked computers' },
  { id: 'invite', label: 'Relay invites', open: 'relay', where: 'Settings → Remote & devices → Relay' },
  { id: 'phones', label: 'Phones and passkeys', open: 'phones', where: 'Settings → Remote & devices → Phones' },
  { id: 'accountSignIn', label: 'Claude account sign-in', open: 'accounts', where: 'Settings → Claude & usage → Accounts' },
  { id: 'remote', label: 'The remote block (relay secrets)', open: 'remote-access', where: 'Settings → Remote & devices → Remote access' },
  { id: 'relayJoin', label: 'Relay join settings', open: 'join-code', where: 'Settings → Remote & devices → Remote access → Join with a code' },
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

/**
 * A value as the helper and the approval card see it: an MCP server's env and headers (a profile's) masked, so an API
 * key never reaches the helper, the permission record or a phone (code review round 3, finding 5).
 */
export function masked(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(masked);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k,
    (k === 'env' || k === 'headers') && x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x as Record<string, unknown>).map((name) => [name, '•••']))
      : k === 'args' && Array.isArray(x) ? maskedArgs(x)
      : k === 'url' && typeof x === 'string' ? maskedUrl(x)
      : masked(x)]));
}

/** A flag that names a secret: the value after it (or after its "=") is masked (code review round 4, R4-4). */
const SECRET_FLAG = /^-{1,2}[\w-]*(key|token|secret|password|passwd|auth)[\w-]*$/i;
function maskedArgs(args: unknown[]): unknown[] {
  return args.map((a, i) => {
    if (typeof a !== 'string') return a;
    const eq = a.indexOf('=');
    if (eq > 0 && SECRET_FLAG.test(a.slice(0, eq))) return `${a.slice(0, eq)}=•••`;
    const prev = args[i - 1];
    return typeof prev === 'string' && SECRET_FLAG.test(prev) ? '•••' : a;
  });
}
/** A URL's query values masked: a token in it never shows. */
function maskedUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  return `${url.slice(0, q)}?${url.slice(q + 1).split('&').map((p) => (p.includes('=') ? `${p.slice(0, p.indexOf('='))}=•••` : p)).join('&')}`;
}
const show = (v: unknown) => (v === undefined || v === null ? 'none' : typeof v === 'string' ? v : JSON.stringify(masked(v)));

export const MASK = '•••';

/**
 * The helper's value with every masked place it left as it saw it put back to the saved value (acceptance round 7,
 * 26: a profile's secrets were written over with "•••"). A place the saved value masks the same way gets the saved
 * one; any mask left after that is refused, so the literal mask is never written.
 */
export function restoreMasked(value: unknown, saved: unknown): unknown {
  const savedMasked = masked(saved);
  const restored: (string | number)[][] = [];
  const walk = (v: unknown, s: unknown, sm: unknown, at: (string | number)[]): unknown => {
    if (typeof v === 'string') {
      if (v.includes(MASK) && typeof s === 'string' && sm === v) {
        restored.push(at);
        return s;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, Array.isArray(s) ? s[i] : undefined, Array.isArray(sm) ? sm[i] : undefined, [...at, i]));
    if (v && typeof v === 'object') {
      const so = s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {};
      const smo = sm && typeof sm === 'object' && !Array.isArray(sm) ? sm as Record<string, unknown> : {};
      const own = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, so[k], smo[k], [...at, k])] as const);
      // The file's own notes inside the block stay ($comment and the like, round 6, R6-2).
      const notes = Object.entries(so).filter(([k]) => k.startsWith('$') && !(k in (v as object)));
      return Object.fromEntries([...own, ...notes]);
    }
    return v;
  };
  const out = walk(value, saved, savedMasked, []);
  if (JSON.stringify(out ?? null).includes(MASK)) {
    throw new SettingRefused(`Not saved: the value still holds "${MASK}" where no secret was saved. Leave a hidden value exactly as you saw it to keep it; Ledung never writes the mask.`);
  }
  // A secret is put back only where it was, for the same server (round 6, R6-1): it must still be hidden where it
  // lands, and the server it belongs to (its command, other args, url) must be unchanged. The refusal never quotes it.
  const outMasked = masked(out);
  const get = (o: unknown, path: (string | number)[]) => path.reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string | number, unknown>)[k] : undefined), o);
  for (const path of restored) {
    const where = path.filter((k) => typeof k === 'string').join('.');
    const refuse = (why: string) => {
      throw new SettingRefused(`Not saved: a hidden value at ${where} would ${why}. Ledung keeps a secret only where it was, for the same server; to use it elsewhere, type it in Settings → Session profiles yourself, or leave that server as it was.`);
    };
    if (get(outMasked, path) !== get(value, path)) refuse('show in clear where it lands');
    // The nearest object above it that is a server: one with a command, url or args.
    for (let n = path.length - 1; n >= 0; n--) {
      const here = path.slice(0, n);
      const server = get(out, here);
      const was = get(saved, here);
      if (!server || typeof server !== 'object' || Array.isArray(server) || !['command', 'url', 'args'].some((k) => k in (server as object))) continue;
      const pick = (o: unknown, k: string) => JSON.stringify(masked((o as Record<string, unknown> | undefined)?.[k]) ?? null);
      for (const k of ['command', 'url', 'args', 'type']) if (pick(server, k) !== pick(was, k)) refuse(`move to a server whose ${k} changed`);
      break;
    }
  }
  return out;
}

/** A path's step: an array item by its name when it has one ("Laptop"), else by its place. */
const step = (item: unknown, i: number) => (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' ? `"${(item as { name: string }).name}"` : `[${i + 1}]`);

/**
 * What changes between two values, one readable line per changed place, secrets masked (round 7, 24 and 26), and
 * whether any hidden value changed; at most `max` lines.
 */
export function changeLines(label: string, before: unknown, after: unknown, max = 8): { lines: string[]; secretChanged: boolean; secretsKept: boolean } {
  const mb = masked(before), ma = masked(after);
  const lines: string[] = [];
  let secretChanged = false;
  let secretsKept = false;
  const leaf = (v: unknown) => v === undefined ? 'none' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  const walk = (path: string, b: unknown, a: unknown, xb: unknown, xa: unknown) => {
    const both = (x: unknown) => x && typeof x === 'object';
    if (Array.isArray(b) && Array.isArray(a) && b.every((x) => both(x)) && a.every((x) => both(x)) && (a.length || b.length)) {
      // Lists of objects: by name where they have one.
      const key = (x: unknown, i: number) => step(x, i);
      const bm = new Map(b.map((x, i) => [key(x, i), i]));
      a.forEach((x, i) => {
        const j = bm.get(key(x, i));
        if (j === undefined) lines.push(`${path} ${key(x, i)} added: ${leaf((xa as unknown[])[i])}`);
        else walk(`${path} ${key(x, i)}`, b[j], x, (xb as unknown[])[j], (xa as unknown[])[i]);
      });
      b.forEach((x, j) => { if (!a.some((y, i) => key(y, i) === key(x, j))) lines.push(`${path} ${key(x, j)} removed`); });
      return;
    }
    if (both(b) && both(a) && !Array.isArray(b) && !Array.isArray(a)) {
      const keys = [...new Set([...Object.keys(b as object), ...Object.keys(a as object)])];
      for (const k of keys) walk(path ? `${path}.${k}` : k, (b as Record<string, unknown>)[k], (a as Record<string, unknown>)[k], (xb as Record<string, unknown> | undefined)?.[k], (xa as Record<string, unknown> | undefined)?.[k]);
      return;
    }
    const masks = JSON.stringify(xb ?? null).includes(MASK) || JSON.stringify(xa ?? null).includes(MASK);
    if (JSON.stringify(b) === JSON.stringify(a)) {
      if (masks) secretsKept = true;
      return;
    }
    if (masks && JSON.stringify(xb) === JSON.stringify(xa)) secretChanged = true;
    else lines.push(`${path || label}: ${leaf(xb)} → ${leaf(xa)}`);
  };
  walk('', before, after, mb, ma);
  // "Laptop".port reads as Laptop's port (round 10).
  const shown = lines.slice(0, max).map((l) => l.trim().replace(/"([^"]+)"\.(\w+)/g, "$1's $2")).map((l) => (l.startsWith(label) ? l : `${label}: ${l}`));
  if (lines.length > max) shown.push(`${label}: and ${lines.length - max} more`);
  return { lines: shown, secretChanged, secretsKept };
}
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
  // "Before" is what is saved in the config (round 7, 24): a restart-only change may be saved but not running yet.
  const saved = savedConfig(ctx.configFile);
  const before = saved.config;
  const running = ctx.config();
  const pending = JSON.stringify(running[key]) !== JSON.stringify(before[key]);
  // Hidden values the helper left as it saw them go back to the saved ones; the mask is never written (round 7, 26).
  const restored = value === null ? undefined : restoreMasked(value, saved.raw[key]);
  const { raw, config: after } = configWith(ctx.configFile, key, restored);
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
      // Any other place to listen counts, an address to another included: a VPN must never be added unasked (round 3, 1).
      if (after.lan && JSON.stringify(after.lan) !== JSON.stringify(before.lan) && before.lan) {
        opens.push(`home network access ${show(before.lan)} → ${show(after.lan)}`);
        risk = `Ledung then answers on ${after.lan === true ? 'every network the computer is on, VPNs too' : after.lan}${after.lanSignIn ? '' : ', without sign-in'}.`;
        if (after.lan === true) narrower = 'the single address you use';
      } else if (after.lan && !before.lan) {
        opens.push(`home network access ${show(before.lan ?? false)} → ${show(after.lan)}`);
        risk = after.lanSignIn ? 'Devices on that network can reach Ledung; they sign in once with a link.' : 'Anyone on that network can use Ledung, and through it run commands on this computer: sign-in is off.';
        if (after.lan === true) narrower = "this computer's own address on the network instead of every network (true also opens VPNs)";
      }
      break;
    case 'computers': {
      // The pages that may frame Ledung's page (security.ts): a computer's public name and its local port each add
      // some; any new one is asked, named on the card (round 3, 2; round 4, R4-1).
      const had = new Set(framingPages(before.computers ?? []));
      const added = framingPages(after.computers ?? []).filter((o) => !had.has(o));
      if (added.length) {
        // The change itself first (Laptop's port 4317 → 4318), then what it opens (round 7, 24).
        opens.push(...changeLines(def.label, before.computers, after.computers).lines);
        opens.push(`pages that may show Ledung in a frame: ${added.join(', ')} added`);
        risk = 'Those pages may then show Ledung in a frame, and so its approval cards.';
      }
      break;
    }
    case 'keepToolResultsDays':
      // Lower: older tool output is shrunk at once, and that can't be undone in Ledung (R4-2).
      if (after.keepToolResultsDays < before.keepToolResultsDays) {
        opens.push(`days old tool output is kept whole ${before.keepToolResultsDays} → ${after.keepToolResultsDays}`);
        risk = 'Older tool output is shrunk at once; it does not come back in Ledung.';
      }
      break;
    case 'claudeAccounts': {
      // Which sign-in folder sessions run on: a new account or a changed folder is asked (round 3, 3).
      const acc = (c: LedungConfig) => (c.claudeAccounts ?? {}) as Record<string, { signInFolderOnThisComputer?: string; signInFolderInContainers?: string }>;
      const was = acc(before);
      for (const [name, a] of Object.entries(acc(after))) {
        const old = was[name];
        if (!old) opens.push(`Claude account "${name}" added${a.signInFolderOnThisComputer ? `, sign-in folder ${a.signInFolderOnThisComputer}` : ''}${a.signInFolderInContainers ? `, in containers ${a.signInFolderInContainers}` : ''}`);
        else {
          if ((old.signInFolderOnThisComputer ?? '') !== (a.signInFolderOnThisComputer ?? '')) opens.push(`Claude account "${name}": sign-in folder ${show(old.signInFolderOnThisComputer)} → ${show(a.signInFolderOnThisComputer)}`);
          if ((old.signInFolderInContainers ?? '') !== (a.signInFolderInContainers ?? '')) opens.push(`Claude account "${name}": folder in containers ${show(old.signInFolderInContainers)} → ${show(a.signInFolderInContainers)}`);
        }
      }
      if (opens.length) risk = 'Sessions on that account then run with that sign-in folder: its subscription, and its own settings and hooks.';
      break;
    }
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
      // A chats' folder outside the folders Ledung may use (round 3, 8).
      if (key === 'chats' && after.chats.folder && after.chats.folder !== before.chats.folder && newlyAllowed([path.resolve(after.chats.folder)], allowedBefore).length) {
        opens.push(`chats' folder ${show(before.chats.folder)} → ${after.chats.folder}, outside the folders Ledung may use`);
      }
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
        // Only a masked value changed: the card says so rather than showing the same before and after (R4-4).
        // What changes, place by place, secrets masked; a change of hidden values alone is said as such (round 7).
        const diff = changeLines(def.label, before[key], after[key]);
        opens.push(...diff.lines, ...(diff.secretChanged ? [`${def.label}: a value hidden as secret changed`] : []));
        if (diff.secretsKept && !diff.secretChanged) opens.push(`${def.label}: hidden values (secrets) unchanged`);
        risk = key === 'board' ? 'Managers then post to the board, outside this computer.' : key === 'claudeExecutable' ? 'Sessions then run another program.' : 'This changes what sessions may use or what managers follow.';
      }
      break;
  }
  const restart = SETTING_RELOAD[key] === 'restart';
  const file = ctx.configFile;
  // A saved value that doesn't run yet is said so (round 7, 24).
  if (pending && opens.length) opens.push(`${def.label} now saved: ${show(before[key])}, running: ${show(running[key])} until Restart Ledung`);
  const diff = changeLines(def.label, before[key], after[key]);
  return {
    label: def.label, changes: diff.lines.length ? diff.lines : [`${def.label}: ${show(before[key])} → ${show(after[key])}`], opens, risk, narrower, restart,
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
    case 'macros': {
      // Each new or changed macro, with its text: it goes out as the person's own words (round 3, 7).
      if (!Array.isArray(value)) throw new SettingRefused('Give the whole list of macros, as Settings keeps it.');
      const had = new Map((ctx.macros() as { name?: string; text?: string }[]).map((m) => [m.name, m.text]));
      const changed = (value as { name?: unknown; text?: unknown }[]).filter((m) => had.get(String(m.name)) !== m.text)
        .map((m) => `macro "${String(m.name)}": ${JSON.stringify(String(m.text ?? ''))}`);
      const names = new Set((value as { name?: unknown }[]).map((m) => String(m.name)));
      const gone = [...had.keys()].filter((n) => !names.has(String(n))).map((n) => `macro "${n}" removed`);
      // Any change at all is asked: when in doubt, a setting opens something (round 3).
      const opens = [...changed, ...gone];
      if (!opens.length && JSON.stringify(ctx.macros()) !== JSON.stringify(value)) opens.push('macros changed (their chips or keybinds)');
      return plan(ctx.macros(), opens, () => ctx.setMacros({ macros: value }), changed.length ? 'A macro sends its text as if you typed it.' : undefined);
    }
    case 'skillDefaults': {
      // More of the person's own skills for managers and sessions (round 3, 8): asked when it changes at all.
      const before = ctx.skillDefaults();
      const opens = JSON.stringify(before) !== JSON.stringify(value) ? [`skills managers and sessions get ${show(before)} → ${show(value)}`] : [];
      return plan(before, opens, () => ctx.setSkillDefaults(value), opens.length ? 'Sessions may then use other skills of yours.' : undefined);
    }
    case 'accountChoices': {
      // Which account chats and new projects run on, the helper's own included (round 3, 4).
      const before = ctx.accountChoices();
      const next = { ...before, ...(value as Record<string, unknown>) };
      const opens = (['chats', 'newProjects'] as const).filter((k) => (next[k] || null) !== (before[k] || null))
        .map((k) => `account for ${k === 'chats' ? 'chats (and the helper)' : 'new projects'} ${before[k] ?? "this computer's own login"} → ${next[k] || "this computer's own login"}`);
      return plan(before, opens, () => ctx.setAccountChoices(value), opens.length ? 'Those sessions then run on that account: its subscription and sign-in.' : undefined);
    }
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
  } else if (field === 'followFlow' && value === false && before.followFlow !== false) {
    opens.push(`${projectName}: Ledung stops following its drawn workflow`);
    risk = 'Its reviews and your own review blocks are then only what its manager chooses to do.';
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
  if (secret) throw new SettingRefused(`${secret.label} holds a secret, which never passes through you: reply with a link card { kind: "link", to: "${secret.open}" }, which opens ${secret.where}, where they type it themselves.`);
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
    'Config file (change_ledung_setting writes it; "(restart)" ones apply after Restart Ledung). Values shown as "•••" are hidden secrets: give them back exactly as shown and Ledung keeps the saved values.',
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
