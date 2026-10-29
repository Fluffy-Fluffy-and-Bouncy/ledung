// Open a folder in the computer's file manager: Finder, Explorer, or whatever xdg-open picks (issue #414).
import { spawn } from 'node:child_process';

/** The program and arguments that show a folder on this platform; for the tests. */
export function openFolderCommand(folder: string, platform = process.platform): [string, string[]] {
  return platform === 'win32' ? ['explorer.exe', [folder]]
    : platform === 'darwin' ? ['open', [folder]]
    : ['xdg-open', [folder]];
}

export function openFolder(folder: string): void {
  const [command, args] = openFolderCommand(folder);
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
