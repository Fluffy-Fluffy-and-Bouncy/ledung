// A session's own working folder (decision of 2026-10-14): a manager may start a session in a subfolder
// of the project, or in a folder under one of the project's extra roots (such as its git worktrees). The
// session still belongs to the project; only where Claude Code runs, and what the file viewer shows,
// change. Anything outside those folders is refused, also by way of `..`, symlinks or junctions.
import fs from 'node:fs';
import path from 'node:path';

export class WorkFolderError extends Error {}

/** Is `real` the folder `root` or inside it? Both real paths; path.relative ignores case on Windows. */
function within(root: string, real: string): boolean {
  const inside = path.relative(root, real);
  return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside));
}

function realFolder(folder: string): string | null {
  try {
    const real = fs.realpathSync(folder);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The real path of the folder `wanted` (absolute, or relative to the project folder) when a session may
 * run there; null when it is the project folder itself. Throws a WorkFolderError saying why not.
 */
export function resolveWorkFolder(projectPath: string, extraRoots: readonly string[], wanted: string): string | null {
  if (!wanted.trim()) throw new WorkFolderError('No folder given.');
  const project = realFolder(projectPath);
  if (!project) throw new WorkFolderError(`The project folder ${projectPath} does not exist.`);
  const given = path.resolve(project, wanted.trim());
  if (!fs.existsSync(given)) throw new WorkFolderError(`The folder ${given} does not exist.`);
  // realpath resolves symlinks and junctions, so a link inside an allowed folder can't lead outside it.
  const real = realFolder(given);
  if (!real) throw new WorkFolderError(`${given} is not a folder.`);
  if (within(project, real)) return path.relative(project, real) === '' ? null : real;
  for (const root of extraRoots) {
    const realRoot = realFolder(root);
    if (realRoot && within(realRoot, real)) return real;
  }
  const roots = extraRoots.length ? ` or under the project's extra folders (${extraRoots.join(', ')})` : '';
  throw new WorkFolderError(
    `${given} is outside the project. A session can work in the project folder (${projectPath}) or a folder inside it${roots}.` +
    `${extraRoots.length ? '' : " The project's settings can name extra folders, such as where its git worktrees go."}`,
  );
}
