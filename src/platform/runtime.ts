// What the Ledung core must run on (issue #361, open point 7 of the desktop app epic #357). The core starts its
// session hosts with process.execPath, and a host hands Claude Code exactly the environment it was started with
// (src/host/host.ts). On Electron's binary the hosts only work while ELECTRON_RUN_AS_NODE is set, and that is the
// setting sessions must not inherit (sessionEnv, src/runners/runner.ts). So the core runs on Node only, and says so
// before it opens the database or starts any host.

/** Why this core can't run on the runtime `versions` describes, in one line; null when it can. */
export function runtimeRefusal(versions: Readonly<Record<string, string | undefined>>): string | null {
  if (!versions.electron) return null;
  return `Ledung runs on Node.js, not on Electron's binary (Electron ${versions.electron}): start it with the node command.`;
}
