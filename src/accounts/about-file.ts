// A short text file in each account's sign-in folder (issue #425), so whoever opens the folder knows what it is,
// whose it is and how to sign in to it. Only the account's name, its folders and the commands are in it: Ledung
// never reads or keeps a sign-in (#342), so it has nothing secret to put there.
import fs from 'node:fs';
import path from 'node:path';
import { keychainEntry, CREDENTIALS } from './signin-store.ts';
import { containerSignInCommand, signInCommand } from './signin.ts';

export const ABOUT_FILE = 'ABOUT THIS FOLDER.txt';

export interface AboutAccount {
  name: string;
  /** Its sign-in folder on this computer, as Ledung keeps it. */
  configDir: string;
  /** Its sign-in folder in containers. */
  containerDir: string;
  /** The config file's whatItIsFor, if any. */
  whatItIsFor?: string | null;
}

/** The file's text, for this computer's platform; lines end as that platform's editors expect. */
export function aboutText(a: AboutAccount, platform = process.platform): string {
  const where = platform === 'darwin'
    ? `in the macOS Keychain, under "${keychainEntry(a.configDir).service}" (named from this folder's path)`
    : `in the file ${CREDENTIALS} in this folder`;
  const lines = [
    `This is the sign-in folder of the Claude account "${a.name}" in Ledung.`,
    ...(a.whatItIsFor ? [`What it is for: ${a.whatItIsFor}`] : []),
    '',
    `Claude Code keeps this account's sign-in ${where}. Ledung never reads it, and nothing in this text file is secret.`,
    'Conversations, memory, skills and settings are not here: every account shares them.',
    '',
    `To sign in, or to sign in as someone else, run this in ${platform === 'win32' ? 'PowerShell' : 'a terminal'}:`,
    `  ${signInCommand(a.configDir, platform)}`,
    'then type /login. Then press Check again in Ledung (Settings → Claude & usage → Accounts).',
    '',
    `For a project in a container, the sign-in is kept inside the container, in ${a.containerDir}. Run this on this computer, with the container's name:`,
    `  ${containerSignInCommand({ container: '<container>' }, a.containerDir)}`,
    'and add -u <user> after -it if the project runs as another user.',
    '',
    `Don't edit ${platform === 'darwin' ? 'the Keychain entry' : CREDENTIALS} by hand: it is Claude Code's, and a broken one signs the account out.`,
    'To stop using the account, remove it in Ledung (Settings → Claude & usage → Accounts), which also signs it out;',
    'if it is listed under "claudeAccounts" in Ledung\'s config file, take it out there too, or it comes back at the next start.',
    '',
    'Ledung writes this file, and writes it again when it is missing or out of date.',
  ];
  return lines.join(platform === 'win32' ? '\r\n' : '\n') + (platform === 'win32' ? '\r\n' : '\n');
}

/**
 * Writes the file into the sign-in folder when it is missing or says something else; true if it wrote. Never makes
 * the folder (an account's folder that is gone stays gone until someone signs in) and never throws: the file is a
 * note for people, and a folder Ledung may not write to must not stop an account.
 */
export function writeAboutFile(a: AboutAccount, platform = process.platform): boolean {
  const file = path.join(a.configDir, ABOUT_FILE);
  const text = aboutText(a, platform);
  try {
    if (!fs.statSync(a.configDir).isDirectory()) return false;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
    fs.writeFileSync(file, text);
    return true;
  } catch {
    return false;
  }
}
