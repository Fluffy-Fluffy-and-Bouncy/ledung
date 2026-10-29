// Elevated (admin) commands from a session on Windows (#213; Martin, 2026-10-18, question #295, option a).
// gsudo, Windows' own sudo, `Start-Process … -Verb RunAs` and `runas` raise a UAC prompt on the PC's
// desktop: they work at the PC, never from the phone, where the command just waits for a click. Used by
// the sensitive suggestions (so such a call is asked in every mode), the permission card and the status line.

/** gsudo or sudo, as a program or a path to one (`gsudo.exe`), not inside a longer name (`sudoers`, `sudo-notes`). */
export const SUDO_PATTERN = String.raw`(?<![\w.-])g?sudo(?:\.exe)?(?![\w.-])`;
/** `-Verb RunAs` (also `-Verb:RunAs`, `'RunAs'`) of Start-Process and its aliases, and `runas.exe`. */
export const RUNAS_PATTERN = String.raw`(?<![\w.-])runas(?:\.exe)?(?![\w.-])`;

/** The tools whose `command` runs in a shell. */
const SHELL_TOOLS = ['Bash', 'PowerShell'];

/** Whether a tool call runs a command that elevates. Matched on the whole text: a false note is harmless. */
export function elevates(toolName: string, input: Record<string, unknown>): boolean {
  if (!SHELL_TOOLS.includes(toolName) || typeof input.command !== 'string') return false;
  const command = input.command;
  return [SUDO_PATTERN, RUNAS_PATTERN].some((p) => new RegExp(p, 'i').test(command));
}

/**
 * Whether an elevation from this session raises UAC on this PC's desktop: a session on the PC itself, with
 * Ledung on Windows. In a container sudo is the container's own, and elsewhere sudo asks in a terminal.
 */
export function raisesUac(runner: string | null | undefined, platform: string): boolean {
  return runner === 'local' && platform === 'win32';
}

/** The permission card's note on such a call. */
export const UAC_NOTE = "This raises a UAC prompt on the PC's desktop; allow it only when you are at the PC.";
/**
 * Stop and an elevated process (checked by reading the code, #213): the host records the session's process
 * tree and ends it, but a process that is not elevated is not allowed to end one that is (Windows' integrity
 * levels), so what runs as administrator can outlive Stop.
 */
export const STOP_NOTE = 'Stop may not end what runs as administrator: Windows does not let Ledung end it. Close it on the PC.';
/** The answer behind "Deny: not at the PC", as the session reads it. */
export const NOT_AT_PC = 'Denied: the person is not at the PC, so nobody can answer the UAC prompt there. Do not retry the elevated command now; carry on without it, or ask for it later.';
/** Shown on the status line while such a command runs. */
export const UAC_HINT = 'may be waiting for UAC on the PC';
