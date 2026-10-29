// Open a URL in the default browser.
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  // rundll32 avoids cmd.exe's quoting rules, which mangle URLs with & in them.
  const [command, args]: [string, string[]] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
