// Which old release folders a release may remove (#117). A folder that a running Ledung, a session
// host or the Claude Code a host started runs from must stay: macOS and Linux delete files in use
// without complaint, and the running Ledung then can't start a session (its Agent SDK is gone).
// Every such process names its release folder on its command line (`node <release>/src/main.ts`,
// `node <release>/src/host/host.ts`, the SDK's binary under `<release>/node_modules`).
import path from 'node:path';

/**
 * The release folders (names under the releases folder) to remove: all but the newest `keep`, less
 * every folder some command line runs from. Names are timestamps, so they sort oldest first.
 * `releasesDirs` is every spelling of the releases folder: a session host names it by its real path
 * (Node resolves the script it runs from) while Ledung names it as the launcher wrote it, and
 * the two differ behind a symlink, such as macOS's /tmp.
 */
export function releasesToRemove(names: string[], releasesDirs: string[], commandLines: string[], keep: number, platform = process.platform): string[] {
  // Windows paths may use either slash and ignore case.
  const norm = (s: string) => (platform === 'win32' ? s.replace(/\\/g, '/').toLowerCase() : s);
  const lines = commandLines.map(norm);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const inUse = (name: string) => releasesDirs.some((releasesDir) => {
    const dir = norm(join(releasesDir, name));
    // The folder itself, not one whose name merely starts with it.
    return lines.some((line) => {
      for (let at = line.indexOf(dir); at !== -1; at = line.indexOf(dir, at + 1)) {
        const next = line[at + dir.length];
        if (next === undefined || /[\\/"'\s]/.test(next)) return true;
      }
      return false;
    });
  });
  return [...names].sort().reverse().slice(keep).filter((name) => !inUse(name));
}
