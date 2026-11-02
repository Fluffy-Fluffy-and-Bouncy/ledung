// Shortcuts that start Ledung (issue #415): a Ledung icon on the Desktop and in the Start menu on Windows, Ledung.app
// in Applications on macOS. Made only when the person asks, in the page's first-run question or in Settings, never
// by a release or a start (Martin, 2026-10-29 13:58, Ledung question #939: "I hate files appearing on their own").
// Each opens a running Ledung's page, or starts Ledung (src/platform/running.ts) in the background, with no window
// (issue #456, Martin 2026-11-01 21:41, Ledung question #1149); Stop Ledung in Settings stops it. On Windows the icon
// runs a small script through Windows Script Host, the one way to start Node with no console window at all.
// The same settings offer Start Ledung when I sign in (#456, off until switched on): a shortcut in the Startup folder
// on Windows, a LaunchAgent on macOS, an autostart entry on Linux; all per user, no admin rights.
//
// Only fixed names in fixed folders are written or removed: Ledung.lnk in the Desktop and Start menu folders, "Ledung at
// sign-in.lnk" in Startup, Ledung.app in Applications, org.ledung.signin.plist in LaunchAgents, org.ledung.signin.desktop
// in autostart, and the icon and the start script in the data folder. A Ledung with its own data folder (LEDUNG_DATA_DIR: tests and throwaway
// copies) puts them in that folder instead, never on the real Desktop or in the real Startup folder.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShortcutAction, ShortcutPlace, ShortcutPlaceId, ShortcutsView, SignInStartView } from '../shared/protocol.ts';
import { LOG_FILE } from './background.ts';
import { icnsFromPngs, icoFromPng } from './icons.ts';
import { appDir, envSetting, PACKAGED, userDataDir } from './paths.ts';

/** Remembers that the first-run question was answered, either way: it is asked once (#939). */
export const ASKED_KEY = 'shortcuts-asked';
/** The macOS app's bundle id: Remove takes away only a Ledung.app that carries it. */
export const BUNDLE_ID = 'org.ledung.launcher';
/** The macOS LaunchAgent's label; its file is this with .plist (#456). */
export const AGENT_LABEL = 'org.ledung.signin';
/** The script Windows Script Host runs to start Ledung with no window (#456); in the data folder. */
export const STARTER_FILE = 'Ledung-start.js';

const LABELS: Record<ShortcutPlaceId, string> = { desktop: 'Desktop', 'start-menu': 'Start menu', applications: 'Applications' };

/** Every folder a fixed file is written into: the shortcuts' places, and the sign-in start's ("startup"). */
type Folder = ShortcutPlaceId | 'startup';

/** What a shortcut runs: Node and a launcher script that does the open-or-start check. */
export interface LaunchTarget {
  node: string;
  /** The release launcher (launcher.mjs), which runs Ledung where it is started, or the `ledung` command. */
  script: string;
  /**
   * LEDUNG_DATA_DIR and LEDUNG_CONFIG when this Ledung was started with them, so its shortcut opens or starts this
   * Ledung and not the default one (Mac check of PR #432, note 1). Empty for a Ledung on the usual folders.
   */
  env?: Record<string, string>;
}

/** The env file a shortcut passes to Node with --env-file, when the launch carries settings; in the data folder. */
export const ENV_FILE = 'shortcut.env';
/** Set for a Ledung whose output goes to the log, so Settings → Log says so (#456). */
const LOG_FILE_SETTING = 'LEDUNG_LOG_FILE';

export interface ShortcutsOptions {
  /** What the shortcuts run; launchTarget() for this Ledung. */
  launch: LaunchTarget;
  /** Where the icon files go; the data folder, which outlives releases. */
  iconDir: string;
  /** The background log (#456); default ledung.log in iconDir, the data folder. */
  logFile?: string;
  /** Ledung's icon at 256 and 512 pixels; iconFiles() for this Ledung. */
  icons: { png256: string; png512: string };
  meta: { get(key: string): string | null; set(key: string, value: string): void };
  /** Default: this computer's. */
  platform?: NodeJS.Platform;
  /**
   * The folder for each place. Default: the system's own (Windows asks for the Desktop, Start menu and Startup folders,
   * which may be moved, e.g. into OneDrive), or folders in the data folder when it is set by LEDUNG_DATA_DIR.
   */
  folders?: () => Promise<Partial<Record<Folder, string>>>;
}

/** The launcher for this Ledung: the release launcher in the data folder, else the npm command or the source's own. */
export function launchTarget(dataDir = userDataDir(), app = appDir(), packaged = PACKAGED): LaunchTarget {
  const releaseLauncher = path.join(dataDir, 'launcher.mjs');
  const fromRelease = !path.relative(path.join(dataDir, 'app'), app).startsWith('..') && fs.existsSync(releaseLauncher);
  const script = fromRelease ? releaseLauncher : path.join(app, packaged ? path.join('dist', 'cli.js') : path.join('src', 'cli.ts'));
  const env: Record<string, string> = {};
  for (const name of ['DATA_DIR', 'CONFIG']) {
    const value = envSetting(name);
    if (value) env[`LEDUNG_${name}`] = path.resolve(value);
  }
  return Object.keys(env).length ? { node: process.execPath, script, env } : { node: process.execPath, script };
}

/**
 * Whether a launch goes to the background by itself: the `ledung` command does (#456). The release launcher runs
 * Ledung where it is started, so a start with no window sends its output to the log for it.
 */
export function startsInBackground(launch: LaunchTarget): boolean {
  return path.basename(launch.script) !== 'launcher.mjs';
}

/**
 * The env file's text. Single quotes keep a value as it is (backslashes too); a value with one in it goes in
 * backticks, which Node's env files take the same way. A value with both, or a line break, is refused.
 */
export function envFileText(env: Record<string, string>): string {
  return Object.entries(env).map(([name, value]) => {
    if (/[\r\n]/.test(value) || (value.includes("'") && value.includes('`'))) throw new Error(`${name} can't be passed to a shortcut: ${value}`);
    return value.includes("'") ? `${name}=\`${value}\`\n` : `${name}='${value}'\n`;
  }).join('');
}

/**
 * The script Windows Script Host runs (#456): it starts `head`, its own arguments and `tail` as one command line with
 * window style 0, hidden, and returns at once. Its arguments are --no-open from the Startup folder. The strings are
 * JScript literals with everything outside ASCII escaped: the host reads the file in the system's code page, and a
 * path under C:\Users\Åsa would come out garbled.
 */
export function starterText(head: string, tail: string): string {
  const literal = (s: string) => JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return [
    "// Starts Ledung with no window. Made by Ledung's Settings (issue #456).",
    "var shell = new ActiveXObject('WScript.Shell');",
    "var extra = '';",
    `for (var i = 0; i < WScript.Arguments.length; i++) extra += ' "' + WScript.Arguments(i) + '"';`,
    `shell.Run(${literal(head)} + extra + ${literal(tail)}, 0, false);`,
    '',
  ].join('\r\n');
}

/** The page's icons: the built page's, or the source's when the page isn't built. */
export function iconFiles(app = appDir()): { png256: string; png512: string } {
  const built = path.join(app, 'web', 'dist');
  const dir = fs.existsSync(path.join(built, 'icon-256.png')) ? built : path.join(app, 'web', 'public');
  return { png256: path.join(dir, 'icon-256.png'), png512: path.join(dir, 'icon-512.png') };
}

/**
 * Runs PowerShell with values passed in the environment, not in the script, so no path needs quoting. It answers in
 * UTF-8: Windows PowerShell writes in the console's code page otherwise, and a Desktop under C:\Users\Åsa came back
 * garbled (review of PR #432, Important 2; the same rule as process-tree.ts).
 */
export function powershell(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`], { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

/** Windows' own Desktop, Start menu and Startup folders. */
async function windowsFolders(): Promise<Partial<Record<Folder, string>>> {
  const out = await powershell("@{ desktop = [Environment]::GetFolderPath('Desktop'); programs = [Environment]::GetFolderPath('Programs'); startup = [Environment]::GetFolderPath('Startup') } | ConvertTo-Json -Compress", {});
  const { desktop, programs, startup } = JSON.parse(out) as { desktop: string; programs: string; startup: string };
  return { desktop, 'start-menu': programs, startup };
}

/** /Applications when this user may write there (an admin), else their own ~/Applications; their own LaunchAgents. */
function macFolders(): Partial<Record<Folder, string>> {
  const startup = path.join(os.homedir(), 'Library', 'LaunchAgents');
  try {
    fs.accessSync('/Applications', fs.constants.W_OK);
    return { applications: '/Applications', startup };
  } catch {
    return { applications: path.join(os.homedir(), 'Applications'), startup };
  }
}

/** The desktop's autostart folder (XDG), which GNOME, KDE, Xfce and the others read at login. */
function linuxFolders(): Partial<Record<Folder, string>> {
  return { startup: path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'autostart') };
}

/** A Ledung with a data folder of its own keeps its shortcuts in it, so a test never writes on the real Desktop. */
function ownDataFolders(platform: NodeJS.Platform): Partial<Record<Folder, string>> {
  const root = path.join(userDataDir(), 'shortcuts');
  return platform === 'win32'
    ? { desktop: path.join(root, 'Desktop'), 'start-menu': path.join(root, 'Start menu'), startup: path.join(root, 'Startup') }
    : platform === 'darwin'
      ? { applications: path.join(root, 'Applications'), startup: path.join(root, 'LaunchAgents') }
      : { startup: path.join(root, 'autostart') };
}

/** A string in single quotes for sh. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A command line argument for Windows; Ledung's paths never hold a quote. */
const winQuote = (s: string) => `"${s}"`;

/**
 * One argument of a .desktop file's Exec line: in double quotes with ", `, $ and \ escaped, then the file's own
 * escape for backslashes on top, and % doubled (the Desktop Entry specification, "The Exec key").
 */
export const desktopArg = (s: string) => `"${s.replace(/(["`$\\])/g, '\\$1')}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%');

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PLIST = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Ledung</string>
  <key>CFBundleIconFile</key><string>Ledung</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Ledung</string>
  <key>CFBundleDisplayName</key><string>Ledung</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xmlEscape(version)}</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
</dict>
</plist>
`;

/**
 * The LaunchAgent that starts Ledung at login (#456): in the foreground under launchd, which keeps it running and
 * sends its output to the log. Not KeepAlive: Stop Ledung stops it until the next login. AbandonProcessGroup, so
 * the session hosts Ledung leaves running across a restart are not taken down with it. LEDUNG_LOG_FILE tells Settings
 * its output is in the log (review of PR #11, Minor 1).
 */
const AGENT_PLIST = (args: string[], log: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${LOG_FILE_SETTING}</key><string>${xmlEscape(log)}</string>
  </dict>
</dict>
</plist>
`;

/**
 * The sign-in start's file in each place. Names of Ledung's own, never a plain Ledung.lnk: a Startup folder may hold
 * a Ledung.lnk the person made to start Ledung their own way, which must neither count as on nor be removed by Off.
 */
export const SIGN_IN_FILES = {
  windows: 'Ledung at sign-in.lnk',
  mac: `${AGENT_LABEL}.plist`,
  other: `${AGENT_LABEL}.desktop`,
} as const;

const SIGN_IN_LABELS = {
  windows: 'Start Ledung when I sign in to Windows',
  mac: 'Start Ledung when I log in to this Mac',
  other: 'Start Ledung when I log in',
} as const;

export class Shortcuts {
  private readonly opts: ShortcutsOptions;
  private readonly platform: NodeJS.Platform;
  private folderCache: Promise<Partial<Record<Folder, string>>> | null = null;

  constructor(opts: ShortcutsOptions) {
    this.opts = opts;
    this.platform = opts.platform ?? process.platform;
  }

  private kind(): 'windows' | 'mac' | 'other' {
    return this.platform === 'win32' ? 'windows' : this.platform === 'darwin' ? 'mac' : 'other';
  }

  private folders(): Promise<Partial<Record<Folder, string>>> {
    this.folderCache ??= this.opts.folders?.()
      ?? (envSetting('DATA_DIR') ? Promise.resolve(ownDataFolders(this.platform))
        : this.platform === 'win32' ? windowsFolders()
          : Promise.resolve(this.platform === 'darwin' ? macFolders() : linuxFolders()));
    // A failed lookup is tried again next time.
    this.folderCache.catch(() => (this.folderCache = null));
    return this.folderCache;
  }

  private async places(): Promise<ShortcutPlace[]> {
    const kind = this.kind();
    if (kind === 'other') return [];
    const folders = await this.folders();
    const ids: ShortcutPlaceId[] = kind === 'windows' ? ['desktop', 'start-menu'] : ['applications'];
    return ids.flatMap((id) => {
      const folder = folders[id];
      if (!folder) return [];
      const file = path.join(folder, kind === 'windows' ? 'Ledung.lnk' : 'Ledung.app');
      // Another Ledung.app (a Safari web app of the page, say) is not ours: not "added" (Mac check of PR #432, note 3).
      return [{ id, label: LABELS[id], file, present: kind === 'windows' ? fs.existsSync(file) : isOurApp(file) }];
    });
  }

  /** The sign-in start's file in Startup, LaunchAgents or autostart (SIGN_IN_FILES). */
  private async signInFile(): Promise<string | null> {
    const folder = (await this.folders()).startup;
    if (!folder) return null;
    const kind = this.kind();
    return path.join(folder, SIGN_IN_FILES[kind]);
  }

  private async signInView(): Promise<SignInStartView> {
    const label = SIGN_IN_LABELS[this.kind()];
    const file = await this.signInFile();
    if (!file) return { available: false, reason: 'Ledung cannot start itself at login on this system.', label, on: false, file: null };
    return { available: true, reason: null, label, on: fs.existsSync(file), file };
  }

  async view(): Promise<ShortcutsView> {
    const kind = this.kind();
    const asked = this.opts.meta.get(ASKED_KEY) !== null;
    const log = { file: this.logFile(), active: envSetting('LOG_FILE') !== undefined && path.resolve(envSetting('LOG_FILE')!) === path.resolve(this.logFile()) };
    const signIn = await this.signInView();
    if (kind === 'other') {
      return { kind, available: false, reason: 'Shortcuts are made on Windows and macOS. Here, start Ledung with ledung.sh or the ledung command.', asked, places: [], signIn, log };
    }
    return { kind, available: true, reason: null, asked, places: await this.places(), signIn, log };
  }

  /**
   * Add or Remove, or No to the first-run question. Add and No answer it for good; Remove leaves it answered.
   * sign-in-on and sign-in-off switch the start at sign-in (#456).
   */
  async act(action: ShortcutAction): Promise<ShortcutsView> {
    if (action === 'decline') {
      this.opts.meta.set(ASKED_KEY, 'declined');
      return this.view();
    }
    if (action === 'sign-in-on' || action === 'sign-in-off') {
      await this.signIn(action === 'sign-in-on');
      return this.view();
    }
    if (this.kind() === 'other') throw new Error('Shortcuts are made on Windows and macOS.');
    const places = await this.places();
    if (action === 'add') {
      this.writeEnvFile();
      if (this.kind() === 'windows') await this.addWindows(places.filter((p) => !p.present));
      else {
        for (const p of places.filter((p) => !p.present)) {
          // Never written into: our files would spoil it.
          if (fs.existsSync(p.file)) throw new Error(`There is already a Ledung.app in ${path.dirname(p.file)} that Ledung didn't make. Rename or remove it, then add the shortcut again.`);
          this.addMac(p.file);
        }
      }
      this.opts.meta.set(ASKED_KEY, 'added');
    } else {
      for (const p of places.filter((p) => p.present)) this.remove(p.file);
      if (this.kind() === 'windows') fs.rmSync(this.icoFile(), { force: true });
      // The start at sign-in uses them too.
      if (!(await this.signInView()).on) this.removeShared();
    }
    return this.view();
  }

  private icoFile(): string {
    return path.join(this.opts.iconDir, 'Ledung.ico');
  }

  private envFile(): string {
    return path.join(this.opts.iconDir, ENV_FILE);
  }

  private starterFile(): string {
    return path.join(this.opts.iconDir, STARTER_FILE);
  }

  private logFile(): string {
    return this.opts.logFile ?? path.join(this.opts.iconDir, LOG_FILE);
  }

  /** The env file and the start script, which the icons and the start at sign-in share. */
  private removeShared(): void {
    fs.rmSync(this.envFile(), { force: true });
    fs.rmSync(this.starterFile(), { force: true });
  }

  /** The env file for a launch that carries settings, else none; the shortcuts then pass it with --env-file. */
  private writeEnvFile(): void {
    const env = this.opts.launch.env ?? {};
    if (!Object.keys(env).length) return void fs.rmSync(this.envFile(), { force: true });
    fs.mkdirSync(this.opts.iconDir, { recursive: true });
    fs.writeFileSync(this.envFile(), envFileText(env));
  }

  /** Node's own options for a shortcut: --env-file when the launch carries settings. */
  private nodeOptions(): string[] {
    return Object.keys(this.opts.launch.env ?? {}).length ? [`--env-file=${this.envFile()}`] : [];
  }

  /**
   * The start script for Windows Script Host (#456). The `ledung` command goes to the background by itself; the
   * release launcher runs through cmd.exe, hidden too, so its output goes to the log, and LEDUNG_LOG_FILE says so to
   * Settings.
   */
  private writeStarter(): void {
    const { node, script } = this.opts.launch;
    const run = [node, ...this.nodeOptions(), script].map(winQuote).join(' ');
    const text = startsInBackground(this.opts.launch)
      ? starterText(run, '')
      : starterText(`cmd.exe /d /s /c "set ${winQuote(`${LOG_FILE_SETTING}=${this.logFile()}`)}&& ${run}`, ` >> ${winQuote(this.logFile())} 2>&1"`);
    fs.mkdirSync(this.opts.iconDir, { recursive: true });
    fs.writeFileSync(this.starterFile(), text);
  }

  /** The Windows Script Host that runs the start script with no window, and its arguments. */
  private windowsStart(extra: string[]): { target: string; arguments: string } {
    const wscript = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
    return { target: wscript, arguments: ['//Nologo', this.starterFile(), ...extra].map(winQuote).join(' ') };
  }

  private async writeLinks(files: string[], extra: string[], icon: string | null, description: string): Promise<void> {
    for (const file of files) fs.mkdirSync(path.dirname(file), { recursive: true });
    const spec = { files, ...this.windowsStart(extra), workdir: os.homedir(), icon: icon ? `${icon},0` : '', description };
    await powershell([
      '$spec = $env:SHORTCUT_SPEC | ConvertFrom-Json',
      '$shell = New-Object -ComObject WScript.Shell',
      'foreach ($file in $spec.files) {',
      '  $s = $shell.CreateShortcut($file)',
      '  $s.TargetPath = $spec.target; $s.Arguments = $spec.arguments; $s.WorkingDirectory = $spec.workdir',
      '  if ($spec.icon) { $s.IconLocation = $spec.icon }',
      '  $s.Description = $spec.description',
      '  $s.Save()',
      '}',
    ].join('\n'), { SHORTCUT_SPEC: JSON.stringify(spec) });
  }

  private async addWindows(places: ShortcutPlace[]): Promise<void> {
    if (!places.length) return;
    fs.mkdirSync(this.opts.iconDir, { recursive: true });
    fs.writeFileSync(this.icoFile(), icoFromPng(fs.readFileSync(this.opts.icons.png256)));
    this.writeStarter();
    await this.writeLinks(places.map((p) => p.file), [], this.icoFile(), 'Open Ledung, and start it if it is not running');
  }

  /** Turns the start at sign-in on or off (#456). On starts Ledung without opening its page. */
  private async signIn(on: boolean): Promise<void> {
    const file = await this.signInFile();
    if (!file) throw new Error('Ledung cannot start itself at login on this system.');
    if (!on) {
      fs.rmSync(file, { force: true });
      if (!(await this.places()).some((p) => p.present)) this.removeShared();
      return;
    }
    this.writeEnvFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { node, script } = this.opts.launch;
    const kind = this.kind();
    if (kind === 'windows') {
      this.writeStarter();
      await this.writeLinks([file], ['--no-open'], null, 'Start Ledung in the background');
    } else if (kind === 'mac') {
      // Under launchd in the foreground: the `ledung` command with --foreground, the release launcher as it is. Through
      // sh with the same Node lookup as Ledung.app, so a Node upgrade doesn't stop it silently (Mac check of PR #11).
      // With the login shell's PATH, which launchd doesn't give it (#464).
      const run = [...this.nodeOptions(), script, ...(startsInBackground(this.opts.launch) ? ['--foreground'] : []), '--no-open'].map(shQuote).join(' ');
      fs.writeFileSync(file, AGENT_PLIST(['/bin/sh', '-c', signInScript(node, run, '/bin/zsh').join('\n')], this.logFile()));
    } else {
      // Through sh too, for the login shell's PATH (#464): the desktop session's PATH comes from the profile at most,
      // not from .bashrc, where nvm and others put Node and npm.
      const run = [...this.nodeOptions(), script, '--no-open'].map(shQuote).join(' ');
      fs.writeFileSync(file, [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Ledung',
        'Comment=Start Ledung in the background. Made by Ledung\'s Settings (issue #456).',
        `Exec=${['/bin/sh', '-c', signInScript(node, run, '/bin/sh').join('; ')].map(desktopArg).join(' ')}`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n'));
    }
  }

  /**
   * Ledung.app: a script that opens a running Ledung's page (--open-only), or else starts Ledung in the background
   * (#456): the `ledung` command goes there by itself; the release launcher is started with nohup, its output in the
   * log. Made by Ledung on this computer, so it carries no quarantine and Gatekeeper lets it open.
   */
  private addMac(app: string): void {
    const { node, script } = this.opts.launch;
    const contents = path.join(app, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    let version = '1';
    try {
      version = String(JSON.parse(fs.readFileSync(path.join(appDir(), 'package.json'), 'utf8')).version ?? '1');
    } catch {
      // The version is only shown in Finder's Get Info.
    }
    fs.writeFileSync(path.join(contents, 'Info.plist'), PLIST(version));
    fs.writeFileSync(path.join(contents, 'Resources', 'Ledung.icns'), icnsFromPngs([fs.readFileSync(this.opts.icons.png256), fs.readFileSync(this.opts.icons.png512)]));
    const run = [...this.nodeOptions(), script].map(shQuote).join(' ');
    fs.writeFileSync(path.join(contents, 'MacOS', 'Ledung'), [
      '#!/bin/sh',
      "# Opens a running Ledung's page, or starts Ledung in the background. Made by Ledung's Settings (issues #415, #456).",
      ...findNode(node),
      `[ -x "$NODE" ] || { osascript -e 'display alert "Ledung cannot find Node.js" message "Install Node.js 24, or add the shortcut again in Settings in Ledung."'; exit 1; }`,
      `"$NODE" ${run} --open-only && exit 0`,
      // Only for a start: opening a running Ledung's page doesn't wait for the login shell.
      ...loginPath('/bin/zsh'),
      ...nodeOnPath(),
      startsInBackground(this.opts.launch) ? `exec "$NODE" ${run}` : `${LOG_FILE_SETTING}=${shQuote(this.logFile())} nohup "$NODE" ${run} >> ${shQuote(this.logFile())} 2>&1 &`,
      '',
    ].join('\n'), { mode: 0o755 });
  }

  /** Takes away Ledung.lnk, or a Ledung.app that is Ledung's own (its bundle id), never anything else. */
  private remove(file: string): void {
    if (file.endsWith('.lnk')) {
      fs.rmSync(file, { force: true });
      return;
    }
    if (!isOurApp(file)) throw new Error(`${file} is not the Ledung.app that Ledung made; remove it yourself if you want it gone.`);
    fs.rmSync(file, { recursive: true, force: true });
  }
}

/**
 * Shell lines that set NODE: Node where it was when the file was made, else the one the person's login shell finds.
 * Its path moves when a version manager or Homebrew upgrades it (Mac check of PR #432, note 2), and an app opened
 * from Finder or a LaunchAgent does not have that PATH.
 */
function findNode(node: string): string[] {
  return [`NODE=${shQuote(node)}`, `[ -x "$NODE" ] || NODE=$("\${SHELL:-/bin/zsh}" -lic 'command -v node' 2>/dev/null | tail -n 1)`];
}

/**
 * How long the login shell may take to say its PATH, in rounds of a fifth of a second (about ten seconds with the
 * rounds' own time): a slow or broken profile must not stop Ledung from starting.
 */
const LOGIN_PATH_TICKS = 40;
/** The marker before the login shell's PATH in its answer. */
const PATH_MARKER = 'LEDUNG_PATH=';

/**
 * Shell lines that put the person's login-shell PATH in place (#464): launchd, Finder and a desktop session's autostart
 * give Ledung a bare PATH, and Ledung and its sessions then miss npm (Update Ledung), gh and the tools sessions use.
 * The shell runs in the background with its answer in a file, and is stopped after LOGIN_PATH_TICKS with KILL, as an
 * interactive shell ignores TERM (review of PR #68, Important 1), and quietly: sh's notice would land in the log. On a
 * timeout, an error or no answer the PATH stays as it was. The marker picks the PATH out of whatever the profile prints.
 * LEDUNG_START_PATH says which it was, for the EXERCISED line; sessions never get LEDUNG_* settings (sessionEnv).
 * Each line is a whole command, so the lines can be joined with "; " for a .desktop file's Exec.
 */
export function loginPath(fallbackShell: string): string[] {
  const ask = `"\${SHELL:-${fallbackShell}}" -lic 'printf "\\n${PATH_MARKER}%s\\n" "$PATH"' </dev/null >"$T" 2>/dev/null & P=$!`;
  return [
    'L=; T=$(mktemp "${TMPDIR:-/tmp}/ledung-path.XXXXXX" 2>/dev/null) || T=',
    `[ -z "$T" ] || { ${ask}; I=0; while kill -0 "$P" 2>/dev/null && [ "$I" -lt ${LOGIN_PATH_TICKS} ]; do sleep 0.2; I=$((I + 1)); done; kill -KILL "$P" 2>/dev/null; L=$(sed -n 's/^${PATH_MARKER}//p' "$T" | tail -n 1); rm -f "$T"; } 2>/dev/null`,
    'if [ -n "$L" ]; then PATH=$L; LEDUNG_START_PATH=login; else LEDUNG_START_PATH=fallback; fi',
  ];
}

/** Shell lines that add Node's own folder to the PATH, for npm's `#!/usr/bin/env node`, and pass the PATH on. */
function nodeOnPath(): string[] {
  return ['case ":$PATH:" in *":${NODE%/*}:"*) ;; *) PATH="$PATH:${NODE%/*}" ;; esac', 'export PATH LEDUNG_START_PATH'];
}

/** The start at sign-in's sh script on macOS and Linux: the login PATH, Node, then Ledung in its place (#464). */
function signInScript(node: string, run: string, fallbackShell: string): string[] {
  const missing = 'echo "Ledung cannot find Node.js. Install Node.js 24, or switch Start at sign-in off and on in Settings in Ledung." >&2; exit 1';
  return [...loginPath(fallbackShell), ...findNode(node), `[ -x "$NODE" ] || { ${missing}; }`, ...nodeOnPath(), `exec "$NODE" ${run}`];
}

/** Whether a Ledung.app is the one Ledung made: its Info.plist carries Ledung's bundle id. */
function isOurApp(app: string): boolean {
  try {
    return fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(`<string>${BUNDLE_ID}</string>`);
  } catch {
    return false; // Not there, or not an app bundle.
  }
}
