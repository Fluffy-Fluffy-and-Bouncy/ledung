// Where the Ledung Helper's links and the step bar's "Do it myself instead" lead (docs/steps/ledung-helper.md):
// pages of Ledung's own, by the page's view ids (App.tsx). Pure, so it can be tested.
import type { ProjectInfo } from '../../../src/shared/protocol.ts';
import type { CardLink } from '../../../src/shared/helper-cards.ts';
import type { SetupStepId } from '../../../src/shared/setup.ts';

const projectGroup = (project: string, group: string) => `ps:${project}/${group}`;

/** What the helper is doing, in plain words, for the line above the message box (acceptance round 1, check 16). */
export function helperToolWords(tool: string): string {
  const words: Record<string, string> = {
    add_project: 'Adding the project', create_project: 'Creating the project', list_projects: 'Looking at your projects',
    project_settings: 'Reading the settings', set_project_settings: 'Changing the settings', set_project_basics: 'Changing the settings',
    setup_step: 'Moving the setup on', setup_status: 'Looking at the setup', set_user_name: 'Saving your name',
    workflow_files: 'Reading the workflow', ledung_settings: 'Reading the settings', change_ledung_setting: 'Changing the settings', propose_workflow: 'Preparing the workflow for your review', reply: 'Writing', show_card: 'Preparing a card',
  };
  if (tool === 'Skill') return "Reading Ledung's guide";
  return words[tool.replace(/^mcp__ledung__/, '')] ?? 'Working';
}

/** "Do it myself instead" leaves the setup for a page; the page offers the way back (acceptance round 1, check 18). */
export const BACK_TO_SETUP_KEY = 'ledung.backToSetup';
export function markBackToSetup(): void {
  try { sessionStorage.setItem(BACK_TO_SETUP_KEY, '1'); } catch { /* private mode: no way back offered */ }
}
export function clearBackToSetup(): void {
  try { sessionStorage.removeItem(BACK_TO_SETUP_KEY); } catch { /* as above */ }
}
export function backToSetupMarked(): boolean {
  try { return sessionStorage.getItem(BACK_TO_SETUP_KEY) === '1'; } catch { return false; }
}

/**
 * Settings' sections a link card opens at, by the setting's label as the group draws it, so the page scrolls to it and
 * highlights it as a search hit does (acceptance round 6, 26).
 */
export const LINK_SECTIONS: Partial<Record<CardLink, { view: string; label: string }>> = {
  'remote-access': { view: 'settings:remote', label: 'Remote access' },
  'join-code': { view: 'settings:remote', label: 'Remote access' },
  relay: { view: 'settings:remote', label: 'Relay' },
  phones: { view: 'settings:remote', label: 'Phones' },
  'linked-computers': { view: 'settings:remote', label: 'Linked computers' },
  board: { view: 'settings:remote', label: 'Message board' },
  accounts: { view: 'settings:claude', label: 'Accounts' },
  'usage-stops': { view: 'settings:claude', label: 'Usage stops' },
  'publish-usage': { view: 'settings:claude', label: 'Publish usage' },
  'claude-code': { view: 'settings:claude', label: 'Claude Code' },
  update: { view: 'settings:update', label: 'Update Ledung' },
  shortcuts: { view: 'settings:update', label: 'Shortcuts' },
  'start-at-sign-in': { view: 'settings:update', label: 'Start at sign-in' },
  macros: { view: 'settings:macros', label: 'Macros' },
  skills: { view: 'settings:sessions', label: 'Skills' },
  profiles: { view: 'settings:sessions', label: 'Session profiles' },
  look: { view: 'settings:look', label: 'Appearance' },
  notifications: { view: 'settings:notifications', label: 'Notifications' },
  'install-app': { view: 'settings:look', label: 'App' },
  'config-file': { view: 'settings:config', label: 'Config file' },
  about: { view: 'settings:about', label: 'About' },
  checkin: { view: 'settings:about', label: 'Usage count' },
  devices: { view: 'settings:remote', label: 'Phones' },
};

/** A link card's page; null when it names a project that isn't there. */
export function helperLinkView(to: CardLink, project: string | null, projects: Pick<ProjectInfo, 'name' | 'managerId'>[]): string | null {
  const p = project ? projects.find((x) => x.name === project) : undefined;
  const section = LINK_SECTIONS[to];
  if (section) return section.view;
  switch (to) {
    case 'add-project': return 'add';
    case 'accounts': return 'settings:claude';
    case 'settings': return 'settings';
    case 'devices': return 'settings:remote';
    case 'helper-settings': return 'settings:helper';
    case 'shortcuts': return 'settings:update';
    case 'checkin': return 'settings:about';
    case 'project-settings': return p ? `ps:${p.name}` : null;
    case 'workflow': return p ? `wf:${p.name}` : null;
    case 'manager': return p ? p.managerId ?? `p:${p.name}` : null;
  }
  return null;
}

/** Settings by the words the cards use, for a declined line (acceptance round 7, 16). */
const SETTING_WORDS: Record<string, string> = {
  browseRoots: 'the folders Ledung may use', projectsFolder: 'where new projects go', port: 'the port', lan: 'home network access',
  lanSignIn: 'sign-in on the home network', sensitive: 'what always goes to you', keepToolResultsDays: 'how long tool output is kept whole',
  idleStopMinutes: 'when idle sessions stop', windowsShell: 'the shell for "!" lines', claudeAccounts: 'the Claude accounts', pluginsOff: 'the plugins kept off',
  profiles: 'the session profiles', defaultProfiles: 'the default session profiles', workflow: 'the workflow', workflows: 'the workflows',
  remoteControl: 'Remote Control', claudeExecutable: 'the Claude Code sessions run', chats: "the chats' settings", board: 'the message board',
  computers: 'the computer tabs', workingLimit: 'how many sessions may work at once', usageStop: 'a usage stop', macros: 'the macros',
  skillDefaults: 'the skills sessions get', accountChoices: 'the account for chats and new projects', chatsSensitive: "the chats' sensitive list",
  chatsColour: "the chats' colour", helperModel: "the helper's model", updateChannel: 'the update channel', checkIn: 'the usage count',
  relayAddress: 'the relay address', 'project.extraFolders': 'its extra folders', 'project.projectToolsUnasked': "its manager's project tools",
  'project.projectSettingsTools': "its manager's settings tools", 'project.lockdown': 'its lockdown', 'project.worktreeSetup': 'its worktree command',
  'project.followFlow': 'whether Ledung follows its workflow', 'project.name': 'its name',
};

/** The pending setting to scroll to and highlight once its Settings group is on screen (SettingsFrame takes it). */
let pendingFocus: { view: string; label: string } | null = null;
export function focusSettingNext(to: CardLink): void {
  pendingFocus = LINK_SECTIONS[to] ?? null;
}
export function takeSettingFocus(view: string): string | null {
  if (!pendingFocus || pendingFocus.view !== view) return null;
  const label = pendingFocus.label;
  pendingFocus = null;
  return label;
}

/**
 * A request the person declined in the helper's chat, in plain words, never a tool's name (acceptance round 6, 16).
 */
export function helperDeclinedText(toolName: string, input: Record<string, unknown>): string {
  const tool = toolName.replace(/^mcp__ledung__/, '');
  const name = str(input.name) ?? str(input.project);
  switch (tool) {
    case 'add_project': return `You declined adding the project${name ? ` "${name}"` : ''}.`;
    case 'create_project': return `You declined creating the project${name ? ` "${name}"` : ''}.`;
    case 'set_project_basics': {
      const what = [str(input.model) && `model ${str(input.model)}`, str(input.effort) && `effort ${str(input.effort)}`,
        str(input.permissionMode) && `permission mode ${MODE[str(input.permissionMode)!] ?? str(input.permissionMode)}`, input.account !== undefined && 'its Claude account'].filter(Boolean).join(', ');
      return `You declined changing${name ? ` "${name}"` : ''}${what ? `: ${what}` : ''}.`;
    }
    case 'set_project_settings': return `You declined changing${name ? ` "${name}"'s` : ' the'} settings.`;
    case 'change_ledung_setting': {
      const id = str(input.setting) ?? '';
      return `You declined changing ${SETTING_WORDS[id] ?? `the setting ${id}`}${name ? ` of "${name}"` : ''}.`;
    }
    case 'usage_publish': return 'You declined publishing usage.';
  }
  return 'You declined that request.';
}

/** The plain form for a setup step; null: none (the name is typed in the step bar itself). */
export function myselfView(step: SetupStepId, project: string | null): string | null {
  switch (step) {
    case 'name': return null;
    case 'accounts': return 'settings:claude';
    case 'project': return 'add';
    case 'basics': return project ? projectGroup(project, 'general') : 'add';
    case 'sensitive': return project ? projectGroup(project, 'safety') : 'add';
    case 'grant': return project ? projectGroup(project, 'powers') : 'add';
    case 'workflow': return project ? `wf:${project}` : 'add';
    case 'shortcuts': return 'settings:update';
    case 'phone': return 'settings:remote';
    case 'checkin': return 'settings:about';
  }
}

const MODE: Record<string, string> = { default: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan' };
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Ledung's approval card in the helper's chat, in plain words (Simon's try-out, 2026-11-12): "Add the project "X"?"
 * with what it would do, instead of the tool's name. Null: a request the helper card doesn't word; the usual card shows.
 * Managers' cards elsewhere are unchanged.
 */
export function helperApprovalText(toolName: string, input: Record<string, unknown>, sensitive: string | null): { title: string; lines: string[] } | null {
  const tool = toolName.replace(/^mcp__ledung__/, '');
  const name = str(input.name) ?? str(input.project) ?? 'the project';
  const settings = [
    str(input.model) && `Model: ${str(input.model)}`,
    str(input.effort) && `Effort: ${str(input.effort)}`,
    str(input.permission_mode) && `Permission mode: ${MODE[str(input.permission_mode)!] ?? str(input.permission_mode)}`,
    str(input.manager_grant) && `Its manager may decide: ${str(input.manager_grant)}`,
    str(input.account) && `Claude account: ${str(input.account)}`,
    str(input.lockdown) && input.lockdown !== 'off' && `Lockdown: ${str(input.lockdown)}`,
  ].filter((x): x is string => !!x);
  // What a settings change loosens, as Ledung's own rule says it: the part after its colon, one line each.
  const loosened = () => (sensitive && sensitive.includes(': ') ? sensitive.slice(sensitive.indexOf(': ') + 2).split('; ') : []);
  switch (tool) {
    case 'change_ledung_setting': {
      // "a change to Ledung's settings that opens up: a; b. Risk: …  Narrower: …" (src/sessions/helper-settings.ts).
      const head = "a change to Ledung's settings that opens up: ";
      if (!sensitive?.startsWith(head)) return null;
      const body = sensitive.slice(head.length);
      const narrow = body.indexOf(' Narrower: ');
      const riskAt = body.indexOf('. Risk: ');
      const opens = body.slice(0, riskAt >= 0 ? riskAt : narrow >= 0 ? narrow : body.length).replace(/\.$/, '').split('; ').filter(Boolean);
      const risk = riskAt >= 0 ? body.slice(riskAt + 2, narrow >= 0 ? narrow : body.length).trim() : null;
      const narrower = narrow >= 0 ? body.slice(narrow + 1).trim() : null;
      if (!opens.length) return null;
      return { title: "Change Ledung's settings?", lines: [...opens, ...(risk ? [risk] : []), ...(narrower ? [`${narrower} (say so to the helper instead)`] : [])] };
    }
    case 'add_project':
      return { title: `Add the project "${name}"?`, lines: [`Folder: ${str(input.folder) ?? '?'}`, ...settings] };
    case 'create_project':
      return {
        title: `Create the project "${name}"?`,
        lines: [`A new folder with git in ${str(input.parent) ?? 'your projects folder'}${input.github === true ? ', and a private GitHub repository' : ''}`, ...settings],
      };
    case 'set_project_settings':
    case 'set_project_basics': {
      // Only a rule Ledung wrote ("a change to "X" that …: a; b") is said plainly; anything else (Ledung could not
      // check the change, a sensitive pattern) gets the usual card with the input shown (code review, finding 2).
      const lines = sensitive?.startsWith('a change to "') ? loosened().filter((l) => l.trim()) : [];
      return lines.length ? { title: `Change "${name}"?`, lines } : null;
    }
  }
  return null;
}
