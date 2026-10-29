// A workflow by default (issue #21, design decided by the user 2026-10-13, question #16): with a
// "workflow" block in the config, every manager is told to read the process's manager file and every
// other session its session file, and where the project's own config for it is, after Ledung's own
// instructions (placement kept by the user, question #29). Names and paths all come from the config;
// without the block, sessions get exactly the instructions they got before. Several named workflows
// (issue #132): a project names the one it follows; a project that names none follows the first.
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, WorkflowConfig, WorkflowFiles } from '../config.ts';
import type { SessionRole } from '../shared/protocol.ts';

export interface ProjectWorkflow {
  /** The file this kind of session reads first, as the session sees it. */
  rulesFile: (role: SessionRole) => string;
  /** The project's config for the process, as the session sees it. */
  projectConfig: string;
  /** Whether that file exists; null when Ledung can't look (inside a container). */
  configExists: boolean | null;
  /** Why the workflow's profiles file can't be used, so the session runs on this computer's profiles (#298); told at every start and resume. */
  profilesWarning?: string;
  /** The workflow's nudges file as a full path, read on every prompt (#405); absent when the workflow names none. */
  nudgesFile?: string;
}

/** The workflow with its profiles file's problem, if any, so the session hears of it: never a silent fallback (#298 decision 6). */
export function withProfilesWarning(w: ProjectWorkflow | null, warning: string | null): ProjectWorkflow | null {
  return w && warning ? { ...w, profilesWarning: warning } : w;
}

/**
 * Which configured workflow a project names (issue #132): its own by name, else the first (every project
 * from before #132 names none, and there was only one). Undefined: none configured, or the name is not
 * in the config any more, so the project follows none rather than another one.
 */
export function chosenWorkflow(workflows: readonly WorkflowConfig[], project: ProjectConfig): WorkflowConfig | undefined {
  const name = project.workflow?.name;
  return name === undefined ? workflows[0] : workflows.find((w) => w.name === name);
}

/** The workflow a project follows, or null: none configured, or the project is out of it. */
export function projectWorkflow(workflow: WorkflowFiles | undefined, project: ProjectConfig): ProjectWorkflow | null {
  if (!workflow) return null;
  // A container can't see this computer's process folder, so it is in only when the project says so.
  const use = project.workflow?.use ?? project.runner === 'local';
  if (!use) return null;
  const relative = project.workflow?.projectConfig ?? workflow.projectConfig;
  const projectConfig = project.runner === 'local' ? path.resolve(project.path, relative) : path.posix.resolve(project.pathInContainer, relative);
  return {
    rulesFile: (role) => path.join(workflow.folder, role === 'manager' ? workflow.managerFile : workflow.sessionFile),
    projectConfig,
    configExists: project.runner === 'local' ? fs.existsSync(projectConfig) : null,
    // The file is in the process folder on this computer, which Ledung reads itself, also for a container's sessions.
    ...(workflow.nudgesFile ? { nudgesFile: path.resolve(workflow.folder, workflow.nudgesFile) } : {}),
  };
}

/** What the workflow tells a session, after Ledung's own instructions; looked at when the session starts or resumes. */
export function workflowInstructions(w: ProjectWorkflow, role: SessionRole): string {
  const config = w.configExists === false
    ? `The project's process config ${w.projectConfig} does not exist yet: say so to whoever you ask (ask_user) before doing anything that needs it.`
    : `The project's process config is ${w.projectConfig}; wherever the process names its config file, it means that one.`;
  // Only a manager reports it: every worker opening a question about it would be noise (review of #298).
  const profiles = w.profilesWarning ? ` ${w.profilesWarning}${role === 'manager' ? ' Tell whoever you ask (ask_user) once.' : ''}` : '';
  return `This project follows a written process. Before anything else, read ${w.rulesFile(role)} in full and follow it. ${config}${profiles}`;
}

/** What the Add project form shows for a folder: whether the workflow applies and the config is there. */
export interface WorkflowCheck {
  /** False: no workflow configured, so the form shows nothing about it. */
  on: boolean;
  /** The project config's path inside the project folder, as configured. */
  projectConfig: string | null;
  /** Whether the folder has it; null when no folder was given (a project not created yet) or Ledung may not look there. */
  exists: boolean | null;
}

/**
 * `mayLook` says whether a file is somewhere Ledung may look: the config path is typed in the form and
 * may be absolute or climb out with "..", which would let the page test whether any file exists
 * (review of #21). Outside, the answer is null and the form shows no notice.
 */
export function checkFolder(
  workflow: WorkflowFiles | undefined, folder: string | undefined, projectConfig: string | undefined, mayLook: (file: string) => boolean,
): WorkflowCheck {
  if (!workflow) return { on: false, projectConfig: null, exists: null };
  const relative = projectConfig || workflow.projectConfig;
  const file = folder ? path.resolve(folder, relative) : null;
  return { on: true, projectConfig: relative, exists: file && mayLook(file) ? fs.existsSync(file) : null };
}
