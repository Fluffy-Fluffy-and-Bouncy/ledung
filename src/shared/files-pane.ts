// What the Files pane (issue #225, a test feature) gets from the server: the folders it can show, one folder of
// the tree at a time, and the session's changes as files, hunks and numbered lines. Shared by the page and the core.

/** "session": where the session works now (its worktree); "project": the project folder. */
export type PaneFolderKey = 'session' | 'project';

export interface PaneFolders {
  /** One, or two when the session works somewhere other than the project folder. */
  folders: { key: PaneFolderKey; path: string; label: string }[];
}

export interface TreeEntry {
  name: string;
  /** Relative to the listed root, with forward slashes. */
  path: string;
  dir: boolean;
  /** Bytes, for a file. */
  size: number | null;
  /** Shown greyed: a heavy folder (node_modules) or a name .gitignore leaves out. Such a folder is not opened. */
  skipped: 'heavy' | 'ignored' | null;
}

export interface TreeListing {
  /** The folder listed, relative to the root ("" for the root itself). */
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  /** Its number on the old side (deleted and unchanged lines). */
  old: number | null;
  /** Its number on the new side (added and unchanged lines). */
  new: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** For a rename: where it came from. */
  oldPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

export interface SessionChanges {
  /** What it is compared with, such as "origin/main"; null when there is nothing to compare with. */
  base: string | null;
  /** The commit where the session's branch left the base. */
  baseCommit: string | null;
  /** The commit compared, the folder's HEAD: a line comment is made on it. */
  head: string | null;
  branch: string | null;
  files: DiffFile[];
  /** The diff reached the size cap and is shown only up to there. */
  truncated: boolean;
  /** Why there is no diff (not a repository, no main branch), or null. */
  problem: string | null;
}
