// The Ledung Helper's tools (docs/steps/ledung-helper.md): Ledung's settings only. The project tools keep the
// managers' names, so the approvals that already guard them apply unchanged: add_project and create_project are
// always the person's to approve (USER_APPROVED_TOOLS), set_project_settings and set_project_basics go through the
// settings hook, which asks the person for a change that loosens what reaches them. No session, manager or board tool.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EFFORT_LEVELS, PERMISSION_MODES, type PermissionMode } from '../shared/protocol.ts';
import { SETTINGS_PATCH, type SettingsPatch } from '../projects/settings-tools.ts';
import { CardSchema, type HelperCard } from '../shared/helper-cards.ts';
import { SETUP_STEP_IDS, type SetupStepId } from '../shared/setup.ts';
import { BASICS_PATCH, helperInstructions, type BasicsPatch } from './helper.ts';
import { LEDUNG_SERVER, type NewProjectArgs, type ProjectArgs } from './tools.ts';

/** The helper's tools, bound to it. Each throws with a reason the helper is told. */
export interface HelperHandlers {
  setupStatus(): string;
  setupStep(step: SetupStepId, mark: 'done' | 'skipped'): string;
  setUserName(name: string): string;
  listProjects(): string;
  addProject(args: ProjectArgs): Promise<string>;
  createProject(args: NewProjectArgs): Promise<string>;
  projectSettings(project?: string): string;
  setProjectSettings(patch: SettingsPatch): string;
  setProjectBasics(patch: BasicsPatch): string;
  workflowFiles(project: string): Promise<string>;
  proposeWorkflow(project: string, changes: { file: string; text?: string; remove?: boolean }[], why: string): Promise<string>;
  showCard(card: HelperCard): string;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

async function safely(fn: () => string | Promise<string>) {
  try {
    return text(await fn());
  } catch (e) {
    return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true };
  }
}

/** A project's settings as add_project and create_project take them: the managers' fields, without lockdown off-switches. */
const projectFields = {
  name: z.string().min(1).describe('The project name: letters, digits, spaces, ".", "_" or "-", starting with a letter or digit.'),
  model: z.string().min(1).optional().describe('Default model for its sessions: opus, sonnet, haiku or a full name.'),
  effort: z.string().min(1).optional().describe(`Default effort for its sessions: ${EFFORT_LEVELS.join(', ')}. Left out: Claude Code's own default.`),
  permission_mode: z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]).optional().describe('Permission mode for its new sessions: plan, default (Ask), acceptEdits or auto.'),
  manager_grant: z.string().min(1).optional().describe('What its manager may decide on its own.'),
  account: z.string().min(1).optional().describe("The Claude account for its manager and sessions, as added in Ledung; default: the computer's own login."),
  lockdown: z.enum(['off', 'A', 'B']).optional().describe('Lockdown: A walls it off from other projects\' managers and from you; B also closes its way out (not on Windows). Default off.'),
};

type ProjectInput = {
  name: string; model?: string; effort?: string; permission_mode?: PermissionMode; manager_grant?: string; account?: string; lockdown?: 'off' | 'A' | 'B';
};

/** Its sensitive list is always Ledung's suggestions at the start; the person changes it afterwards, in a step of its own. */
function projectArgs(a: ProjectInput): Omit<ProjectArgs, 'folder'> {
  return { name: a.name, model: a.model, effort: a.effort, permissionMode: a.permission_mode, managerGrant: a.manager_grant, account: a.account, lockdown: a.lockdown };
}

export function helperToolServer(who: string, h: HelperHandlers): McpSdkServerConfigWithInstance {
  const project = z.string().min(1).describe('The project name, as list_projects shows it.');
  const tools = [
    tool('setup_status', `The setup's steps as Ledung keeps them: which are done or skipped, the current one, and the setup's project.`, {}, async () => safely(() => h.setupStatus())) as never,
    tool('setup_step', `Mark a setup step done (Ledung refuses it while the thing isn't really there: no name, no project, the notice not answered) or skipped (when ${who} wants to skip it).`, {
      step: z.enum(SETUP_STEP_IDS as [SetupStepId, ...SetupStepId[]]),
      mark: z.enum(['done', 'skipped']),
    }, async (a) => safely(() => h.setupStep(a.step, a.mark))) as never,
    tool('set_user_name', `Set the name Ledung and its sessions call ${who} by.`, {
      name: z.string().trim().min(1).max(60).describe('Their name, as they gave it.'),
    }, async (a) => safely(() => h.setUserName(a.name))) as never,
    tool('show_card', `Show a card in this chat for precise input, then end your turn: ${who}'s pick comes back as their message. choice: buttons; folder: Ledung's folder browser; text: one field; step: ${who}'s own controls for shortcuts, the check-in notice, phones or accounts; link: a button that opens a page of Ledung's (add-project, project-settings, workflow, manager, accounts, settings, devices, helper-settings, shortcuts, checkin; project for the project ones).`, {
      card: CardSchema,
    }, async (a) => safely(() => h.showCard(a.card as HelperCard))) as never,
    tool('list_projects', "List Ledung's projects: folder, settings and whether each one's manager runs; a locked project shows its name only.", {}, async () => safely(() => h.listProjects())) as never,
    tool('add_project', `Add an existing folder on this computer as a project. ${who} approves it on a card in this chat first. Its sensitive list starts with Ledung's suggestions.`, {
      ...projectFields,
      folder: z.string().min(1).describe('The project folder, a full path, as the folder card gave it. It must exist and be inside the folders Ledung may use.'),
    }, async (a) => safely(() => h.addProject({ ...projectArgs(a), folder: a.folder }))) as never,
    tool('create_project', `Create a new project: a new folder with git, optionally a private GitHub repository. ${who} approves it on a card in this chat first. Its sensitive list starts with Ledung's suggestions.`, {
      ...projectFields,
      parent: z.string().min(1).optional().describe('The folder to create it in, a full path; default: the projects folder.'),
      github: z.boolean().optional().describe('Also create a private GitHub repository (default: no; needs the GitHub CLI signed in).'),
    }, async (a) => safely(() => h.createProject({ ...projectArgs(a), parent: a.parent, github: a.github }))) as never,
    tool('project_settings', 'Read the settings of a project that isn\'t locked (grant, workflow, question tiers, sensitive list, dev ship command, tickets, effort), or of every project, as JSON.', {
      project: project.optional(),
    }, async (a) => safely(() => h.projectSettings(a.project))) as never,
    tool('set_project_settings', `Change those settings of a project that isn't locked: give only the fields to change, as project_settings shows them. A change that loosens what reaches ${who} (a new grant, a new dev ship command, a sensitive pattern removed) waits for ${who}'s approval card; any other runs at once.`,
      SETTINGS_PATCH, async (a) => safely(() => h.setProjectSettings(a as SettingsPatch))) as never,
    tool('set_project_basics', `Change a project's model, its manager's model, effort, permission mode for new sessions, or Claude account. A looser mode (Plan < Ask < Accept edits < Auto) or another account waits for ${who}'s approval card; the rest runs at once. Running sessions keep theirs until they next start.`,
      BASICS_PATCH, async (a) => safely(() => h.setProjectBasics(a as BasicsPatch))) as never,
    tool('workflow_files', "Read a project's workflow files (.ledung/workflow only, nothing else of the project); none yet for a new project.", {
      project,
    }, async (a) => safely(() => h.workflowFiles(a.project))) as never,
    tool('propose_workflow', `Propose a project's workflow files (.ledung/workflow), in the workflow-building skill's format: Ledung checks them and puts them to ${who} as a review with diagrams (a card here opens it); Accepted saves them. Never change a workflow another way.`, {
      project,
      changes: z.array(z.object({
        file: z.string().min(1).max(200).describe('Its path in .ledung/workflow, e.g. "flow.json", "briefs/builder.md".'),
        text: z.string().max(262144).optional().describe('The whole new text.'),
        remove: z.boolean().optional().describe('Remove it (a flow in flows/ only).'),
      })).min(1).max(300),
      why: z.string().min(1).max(4000).describe(`Why, in plain words, for ${who}'s review.`),
    }, async (a) => safely(() => h.proposeWorkflow(a.project, a.changes, a.why))) as never,
  ];
  return createSdkMcpServer({ name: LEDUNG_SERVER, version: '1.0.0', alwaysLoad: true, instructions: helperInstructions(who), tools });
}
