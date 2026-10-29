// Shortcuts that start Ledung (issue #415): a Ledung icon on the Desktop and in the Start menu on Windows, Ledung.app
// in Applications on macOS. Made only when the person asks, in the page's first-run question or in Settings, never
// by a release or a start (Martin, 2026-10-29 13:58, Ledung question #939: "I hate files appearing on their own").
// Each opens a running Ledung's page, or starts Ledung (src/platform/running.ts). On Windows its console window
// starts minimised, and closing it stops Ledung as before; on macOS Ledung starts in a Terminal window.
//
// Only fixed names in fixed folders are written or removed: Ledung.lnk in the Desktop and Start menu folders,
// Ledung.app in Applications, and the icon in the data folder. A Ledung with its own data folder (LEDUNG_DATA_DIR:
// tests and throwaway copies) puts them in that folder instead, never on the real Desktop.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShortcutAction, ShortcutPlace, ShortcutPlaceId, ShortcutsView } from '../shared/protocol.ts';
import { icnsFromPngs, icoFromPng } from './icons.ts';
import { appDir, envSetting, PACKAGED, userDataDir } from './paths.ts';

/** Remembers that the first-run question was answered, either way: it is asked once (#939). */
export const ASKED_KEY = 'shortcuts-asked';
/** The macOS app's bundle id: Remove takes away only a Ledung.app that carries it. */
export const BUNDLE_ID = 'org.ledung.launcher';

const LABELS: Record<ShortcutPlaceId, string> = { desktop: 'Desktop', 'start-menu': 'Start menu', applications: 'Applications' };

/** What a shortcut runs: Node and a launcher script that does the open-or-start check. */
export interface LaunchTarget {
  node: string;
  script: string;
  /**
   * LEDUNG_DATA_DIR and LEDUNG_CONFIG when this Ledung was started with them, so its shortcut opens or starts this
   * Ledung and not the default one (Mac check of PR #432, note 1). Empty for a Ledung on the usual folders.
   */
  env?: Record<string, string>;
}

/** The env file a shortcut passes to Node with --env-file, when the launch carries settings; in the data folder. */
export const ENV_FILE = 'shortcut.env';

export interface ShortcutsOptions {
  /** What the shortcuts run; launchTarget() for this Ledung. */
  launch: LaunchTarget;
  /** Where the icon files go; the data folder, which outlives releases. */
  iconDir: string;
  /** Ledung's icon at 256 and 512 pixels; iconFiles() for this Ledung. */
  icons: { png256: string; png512: string };
  meta: { get(key: string): string | null; set(key: string, value: string): void };
  /** Default: this computer's. */
  platform?: NodeJS.Platform;
  /**
   * The folder for each place. Default: the system's own (Windows asks for the Desktop and Start menu folders, which
   * may be moved, e.g. into OneDrive), or folders in the data folder when it is set by LEDUNG_DATA_DIR.
   */
  folders?: () => Promise<Partial<Record<ShortcutPlaceId, string>>>;
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
 * The env file's text. Single quotes keep a value as it is (backslashes too); a value with one in it goes in
 * backticks, which Node's env files take the same way. A value with both, or a line break, is refused.
 */
export function envFileText(env: Record<string, string>): string {
  return Object.entries(env).map(([name, value]) => {
    if (/[\r\n]/.test(value) || (value.includes("'") && value.includes('`'))) throw new Error(`${name} can't be passed to a shortcut: ${value}`);
    return value.includes("'") ? `${name}=\`${value}\`\n` : `${name}='${value}'\n`;
  }).join('');
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

/** Windows' own Desktop and Start menu folders. */
async function windowsFolders(): Promise<Partial<Record<ShortcutPlaceId, string>>> {
  const out = await powershell("@{ desktop = [Environment]::GetFolderPath('Desktop'); programs = [Environment]::GetFolderPath('Programs') } | ConvertTo-Json -Compress", {});
  const { desktop, programs } = JSON.parse(out) as { desktop: string; programs: string };
  return { desktop, 'start-menu': programs };
}

/** /Applications when this user may write there (an admin), else their own ~/Applications. */
function macFolders(): Partial<Record<ShortcutPlaceId, string>> {
  try {
    fs.accessSync('/Applications', fs.constants.W_OK);
    return { applications: '/Applications' };
  } catch {
    return { applications: path.join(os.homedir(), 'Applications') };
  }
}

/** A Ledung with a data folder of its own keeps its shortcuts in it, so a test never writes on the real Desktop. */
function ownDataFolders(platform: NodeJS.Platform): Partial<Record<ShortcutPlaceId, string>> {
  const root = path.join(userDataDir(), 'shortcuts');
  return platform === 'win32'
    ? { desktop: path.join(root, 'Desktop'), 'start-menu': path.join(root, 'Start menu') }
    : { applications: path.join(root, 'Applications') };
}

/** A string in single quotes for sh. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

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

export class Shortcuts {
  private readonly opts: ShortcutsOptions;
  private readonly platform: NodeJS.Platform;
  private folderCache: Promise<Partial<Record<ShortcutPlaceId, string>>> | null = null;

  constructor(opts: ShortcutsOptions) {
    this.opts = opts;
    this.platform = opts.platform ?? process.platform;
  }

  private kind(): 'windows' | 'mac' | 'other' {
    return this.platform === 'win32' ? 'windows' : this.platform === 'darwin' ? 'mac' : 'other';
  }

  private folders(): Promise<Partial<Record<ShortcutPlaceId, string>>> {
    this.folderCache ??= this.opts.folders?.()
      ?? (envSetting('DATA_DIR') ? Promise.resolve(ownDataFolders(this.platform))
        : this.platform === 'win32' ? windowsFolders() : Promise.resolve(macFolders()));
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

  async view(): Promise<ShortcutsView> {
    const kind = this.kind();
    const asked = this.opts.meta.get(ASKED_KEY) !== null;
    if (kind === 'other') {
      return { kind, available: false, reason: 'Shortcuts are made on Windows and macOS. Here, start Ledung with ledung.sh or the ledung command.', asked, places: [] };
    }
    return { kind, available: true, reason: null, asked, places: await this.places() };
  }

  /** Add or Remove, or No to the first-run question. Add and No answer it for good; Remove leaves it answered. */
  async act(action: ShortcutAction): Promise<ShortcutsView> {
    if (action === 'decline') {
      this.opts.meta.set(ASKED_KEY, 'declined');
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
      fs.rmSync(this.envFile(), { force: true });
    }
    return this.view();
  }

  private icoFile(): string {
    return path.join(this.opts.iconDir, 'Ledung.ico');
  }

  private envFile(): string {
    return path.join(this.opts.iconDir, ENV_FILE);
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

  private async addWindows(places: ShortcutPlace[]): Promise<void> {
    if (!places.length) return;
    fs.mkdirSync(this.opts.iconDir, { recursive: true });
    fs.writeFileSync(this.icoFile(), icoFromPng(fs.readFileSync(this.opts.icons.png256)));
    for (const p of places) fs.mkdirSync(path.dirname(p.file), { recursive: true });
    const { node, script } = this.opts.launch;
    // WindowStyle 7: the console starts minimised; Ledung's window stays in the taskbar, and closing it stops Ledung.
    const args = [...this.nodeOptions(), script].map((a) => `"${a}"`).join(' ');
    const spec = { files: places.map((p) => p.file), target: node, arguments: args, workdir: os.homedir(), icon: this.icoFile(), description: 'Open Ledung, and start it if it is not running' };
    await powershell([
      '$spec = $env:SHORTCUT_SPEC | ConvertFrom-Json',
      '$shell = New-Object -ComObject WScript.Shell',
      'foreach ($file in $spec.files) {',
      '  $s = $shell.CreateShortcut($file)',
      '  $s.TargetPath = $spec.target; $s.Arguments = $spec.arguments; $s.WorkingDirectory = $spec.workdir',
      '  $s.IconLocation = "$($spec.icon),0"; $s.WindowStyle = 7; $s.Description = $spec.description',
      '  $s.Save()',
      '}',
    ].join('\n'), { SHORTCUT_SPEC: JSON.stringify(spec) });
  }

  /**
   * Ledung.app: a script that opens a running Ledung's page (--open-only), or else opens Terminal on start.command,
   * which runs the launcher there, so Ledung has a window to stop it from. Made by Ledung on this computer, so it
   * carries no quarantine and Gatekeeper lets it open.
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
    // Node's path moves when a version manager or Homebrew upgrades it (Mac check of PR #432, note 2): then the node
    // the person's login shell finds. Terminal has that PATH already; an app opened from Finder does not.
    fs.writeFileSync(path.join(contents, 'Resources', 'start.command'), [
      '#!/bin/sh',
      "# Starts Ledung in this Terminal window; closing it stops Ledung. Made by Ledung's Settings (issue #415).",
      `NODE=${shQuote(node)}`,
      '[ -x "$NODE" ] || NODE=node',
      `exec "$NODE" ${run}`,
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(contents, 'MacOS', 'Ledung'), [
      '#!/bin/sh',
      "# Opens a running Ledung's page, or starts Ledung in a Terminal window. Made by Ledung's Settings (issue #415).",
      `NODE=${shQuote(node)}`,
      `[ -x "$NODE" ] || NODE=$("\${SHELL:-/bin/zsh}" -lic 'command -v node' 2>/dev/null | tail -n 1)`,
      `[ -x "$NODE" ] || { osascript -e 'display alert "Ledung cannot find Node.js" message "Install Node.js 24, or add the shortcut again in Settings in Ledung."'; exit 1; }`,
      `"$NODE" ${run} --open-only && exit 0`,
      'exec open -a Terminal "$(dirname "$0")/../Resources/start.command"',
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

/** Whether a Ledung.app is the one Ledung made: its Info.plist carries Ledung's bundle id. */
function isOurApp(app: string): boolean {
  try {
    return fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(`<string>${BUNDLE_ID}</string>`);
  } catch {
    return false; // Not there, or not an app bundle.
  }
}
