# Ledung desktop app

Ledung's page in a window of its own instead of a browser tab (epic #357). **Unsigned, and shipped in the npm package**
(#407; Martin, 2026-11-19, Ledung questions #572, #575, #577 and #585; [docs/decisions.md](../docs/decisions.md)):
`npm run pack` bundles this folder into the package's `dist/desktop/`, with Electron as an optional dependency, and the
`ledung` command makes a "Ledung" app from Electron's binary the first time it opens it (see **The made app** below).
From a clone it still runs as below, for development.

## Run it

Start Ledung the way you always do (`ledung`, or the release launcher). Then, in this folder:

```sh
npm install   # once, and after a pull that changes package.json: downloads Electron into desktop/node_modules
npm start
```

One window opens with your running Ledung's page, signed in. Nothing opens in the browser.

- **It attaches to the Ledung that runs.** With none running the window says "Ledung is not running" and offers
  **Start Ledung** and **Retry** (Retry: you started Ledung yourself meanwhile).
- **Start Ledung** runs the installed `ledung` command, `ledung --no-open`, exactly as a terminal would: it starts Ledung
  in the background (its output in `ledung.log` in the data folder) and returns, and the window then shows its page,
  signed in. It never starts a Ledung from this clone, so there is still one real Ledung per computer, the npm one
  (#362). The start leaves out what Electron and `npm start` add to the app's environment (every `ELECTRON_*` and
  `npm_*` variable, npm's `INIT_CWD`, `NODE` and `COLOR`, and the `node_modules/.bin` folders npm put in front of
  `PATH`), so the background Ledung looks as if started from a terminal. Quitting the app leaves that Ledung running,
  as closing the browser does; stop it with Settings → Stop Ledung, the tray's Exit or `ledung stop`. If the start
  fails (no `ledung` command, or it exits with an error), the window says what failed in one line and offers Start
  Ledung and Retry again.
- **Which Ledung.** The same one the `ledung` command finds: the port from the config, the sign-in token from the data
  folder, and the `/running` check that proves the program on the port holds that token (another program there counts
  as not running). Without `LEDUNG_CONFIG` it tries the npm package's config in the data folder first, then the one the
  release launcher points at.
- **Sign-in.** The app sets Ledung's sign-in cookie from its own main process, so the token is never in an address or
  a command line; the window's address is `http://127.0.0.1:<port>/`. On the first start Ledung turns that into a
  paired browser of its own, listed in Settings → Devices as "Chrome on <system>" for now (#363). Later starts keep it;
  if you remove it there, the next start signs in again.
- **Links.** The window shows Ledung's page only. A web link elsewhere (a pull request in a chat) opens in your default
  browser; a link that would open a new window of Ledung itself (a board image), or one that isn't a web address
  (`mailto:`), is not opened yet.
- **When Ledung stops.** If the page can't load any more (Ledung stopped, then a reload), the window goes back to
  "Ledung is not running" with Retry.
- **Closing hides it.** The window's close button and ⌘W (Ctrl+W on Windows) hide the window; the app keeps running,
  so notifications keep coming. Show it again by starting the app again (`npm start` shows the window that's there
  and starts no second app) or, on the Mac, by clicking it in the Dock.
- **Quitting.** ⌘Q on the Mac and Alt+F4 on Windows end the app. Ledung itself is another program and
  keeps running. With unsaved changes on the page (a workflow being edited) the app asks first, as a browser does.
- **Ledung's icon** shows in the window, the Windows taskbar and the Mac Dock instead of Electron's (#384). It is the
  page's own `web/public/icon-512.png`, read from the clone. The Dock draws an icon as it is given, so the app shrinks
  it to Apple's icon grid first (the body 824 of 1024 px, a clear margin round it), the size of the other apps' icons
  (#404); the window and the taskbar take the file as it is.
- **No menu bar on Windows and Linux.** The window never shows one, and Alt does nothing, so it stays free for a key of
  Ledung's own later (Martin, 2026-11-19, #389). The keys still work: Ctrl+W, Alt+F4 (Windows), copy and paste, Ctrl+O (Show tool
  calls), reload, and zoom with Ctrl and "+" (any keyboard layout; Ctrl and "=" too), Ctrl+-, Ctrl+0 and Ctrl and the
  mouse wheel. The Mac's menu is the system menu bar, as before.
- **⌘O on the Mac** does what Ctrl+O does in the page: Show tool calls. (In a browser the page keeps to Ctrl+O on
  every system, so that ⌘O stays the browser's; in the app ⌘O is the app's own.)
- **Clicking a notification shows the window.** When a session asks for permission or a question comes, Ledung's
  page raises a system notification while the window is hidden or not in front (turn them on in the page's Settings,
  as in a browser). Clicking it brings the window back and shows the session that asked (#360). On the Mac the
  notifications show only after you have allowed them once for the app (it is listed as "Electron" while it runs from
  a clone) in System Settings → Notifications.
- **A hidden window keeps its pace.** Its timers run at full speed, so notifications come on time. The page also counts
  as shown then, so it keeps polling (the usage panels refresh while hidden).
- **Permissions.** Ledung's page may show notifications and copy to the clipboard, the two things it uses. Everything
  else a page can ask for (camera, microphone, screen, location, reading the clipboard) is refused: Electron would
  otherwise grant it without asking, where a browser asks you.

## The made app

What `npm install -g ledung` and `ledung` give (`src/platform/desktop-app.ts`, #407):

- **Made at first open.** Electron's npm package downloads nothing at install. The first `ledung` downloads Electron's
  zip for this system with Electron's own downloader and checksums, unzips it and makes the app in
  `<data folder>/desktop/`: `Ledung.app` on the Mac, `Ledung\Ledung.exe` on Windows, `ledung/ledung` on Linux, with this
  folder's bundled code in its `resources/app` (`Contents/Resources/app` on the Mac). The download's cache is removed
  after. The app is made in `desktop/.making` and takes the old one's place only when it is whole.
- **One fixed place**, so a Dock or taskbar pin and the Mac's notification permission keep pointing at it. `stamp.json`
  next to it says what it was made from: a new Electron makes it again; a new Ledung, or another Node, rewrites only its
  code.
- **Named "Ledung".** On the Mac its `Info.plist` names it "Ledung" with the id `org.ledung.app`, its icon is Ledung's
  with the Mac's margin (#404), Electron's default app is removed and it is signed ad hoc again, as Electron's own is.
  The helper apps keep Electron's names. On Windows the exe is `Ledung.exe`, its file details and icon rewritten
  with `resedit` (plain JavaScript, an optional dependency like Electron) so Task Manager says "Ledung"; the app sets the
  AppUserModelID `org.ledung.app`, and making the app runs it once with `--ledung-write-shortcut=<file>` to write its
  Start-menu shortcut, `Ledung app\Ledung.lnk`, carrying that id, so its notifications say "Ledung". Settings →
  Shortcuts → Remove takes that shortcut away (Settings lists it whenever it is there); a later make writes it again
  only for a new Electron. Without `resedit` (its optional install failed) the Windows app can't be made: `ledung` says
  so in one line and opens the browser. On Linux the program
  is `ledung` and the app's name is "Ledung".
- **Its settings.** `ledung-app.json` next to its `main.js` names the Node and the `ledung` script that made it, and
  `LEDUNG_CONFIG` and `LEDUNG_DATA_DIR` when that command had them. So **Start Ledung** runs them and needs no `ledung`
  on `PATH` (an app opened from Finder or the Start menu has no terminal's `PATH`), and the app shows the same Ledung
  however it is opened. When that Node is gone, Start falls back to `ledung` on `PATH`.
- **Its profile** (cookies, caches) is `<data folder>/desktop/profile`: Electron would otherwise use a folder named after
  the app, "Ledung", which is Ledung's own data folder on the Mac and Windows.
- **Opening it.** `ledung` opens it with `open` on the Mac and starts the program on Windows and Linux, without
  Electron's or npm's variables. A failure gives one line and the browser; `ledung --browser`, `"desktopApp": false` in
  the config and `--no-open` keep to the browser or to nothing; `ledung app` insists.
- **Updating it** (#408). Settings → About's **Update Ledung** stays the one button: `npm install -g` replaces the package
  (never the made app, which is in the data folder) and restarts the core. The core compares the Ledung version in the
  app's `stamp.json` with its own at each page connection and tells the page in `hello` (not through the public name).
  Electron's version does not count: an app kept on its old Electron (below) has the new Ledung, and a new Electron
  comes with a new Ledung version anyway. In the made app the page then calls the preload's `restartForUpdate()`: with
  no window in sight the app restarts at once, otherwise when its last window is hidden or minimised, or when the person
  presses the banner's **Restart window** (Martin, Ledung question #593). The app quits, unless the Node or `ledung` that
  made it is gone (then it stays on the old code with its banner), and once nothing kept the quit (a "Leave this page?"
  Stay keeps it, until the page's next connection asks again) it runs that command with `--after-app=<its pid>`, output
  in `desktop/restart.log`. That command waits up to 15 s for the app to end, rewrites its code (or makes it again for a
  new Electron) and opens it. An app with no visible window comes back hidden (`desktop/.start-hidden`, honoured for ten
  minutes and removed when the restart ends in the browser); a minimised one comes back shown. Only the window restarts:
  the core and the sessions are untouched. A new Electron that can't
  be downloaded keeps the app on its old Electron with the new code when the major is the same, and the next start tries
  again; another major opens the browser, and the line saying why is left in `desktop/notice.txt` for the page, removed
  when the app next opens. A restart without an update finds the stamp current and leaves the app alone.

To try it from a worktree, pack and install into a throwaway prefix, with a throwaway Ledung's settings (everything,
the downloaded Electron included, stays under `.test/`):

```sh
npm run pack
npm install -g --prefix $PWD/.test/prefix ./dist/ledung-<version>.tgz
LEDUNG_CONFIG=$PWD/.test/a/config.json LEDUNG_DATA_DIR=$PWD/.test/a/data ./.test/prefix/bin/ledung
```

Stop it after with the same settings and `./.test/prefix/bin/ledung stop`, and quit the app.

## Trying it against a throwaway Ledung

The app reads `LEDUNG_CONFIG` and `LEDUNG_DATA_DIR` exactly as the core does, so a session tests it without touching
the real Ledung. Start a throwaway Ledung on one of your test ports, then the app with the same two settings:

```sh
# from the clone's root
LEDUNG_CONFIG=$PWD/.test/a/config.json LEDUNG_DATA_DIR=$PWD/.test/a/data node src/main.ts --no-open
# from desktop/, in another terminal
LEDUNG_CONFIG=$PWD/../.test/a/config.json LEDUNG_DATA_DIR=$PWD/../.test/a/data npm start
```

`.test/a/config.json` names the port, e.g. `{ "port": 4396, "projects": [] }`.

**Start Ledung against a worktree.** Never let a test press Start Ledung without this: it would run the real `ledung`
command. `LEDUNG_DESKTOP_START` names a Node script that Start runs instead, as `node <script> --no-open`; point it at
the clone's own command, `src/cli.ts`, which starts Ledung in the background exactly as `ledung` does:

```sh
# from desktop/, with no Ledung running on the config's port
LEDUNG_CONFIG=$PWD/../.test/a/config.json LEDUNG_DATA_DIR=$PWD/../.test/a/data LEDUNG_DESKTOP_START=$PWD/../src/cli.ts npm start
```

Stop the Ledung it started with the same settings: `node ../src/cli.ts stop`. The app keeps its cookies in its own
folder (Electron's user data for "ledung-desktop"), apart from any browser. Cookies on `127.0.0.1` are shared by every
port (#52), so pointing the app at another Ledung and back signs it in again, as a new device in that Ledung.

Stop the throwaway Ledung by the process listening on its port, never by name: the real Ledung is a `node` process too.

**The loopback check.** `probe/` loads the real `main.ts` and checks the window from inside, against the throwaway
Ledung the two settings name, printing `PROBE {…}` lines; opening the default browser is intercepted, so nothing opens.
From this folder, with the settings as above: `PROBE_PHASE=attach npx electron probe` (a Ledung runs: sign-in, address,
settings, permissions, refused navigation, links, the icon, the page's bridge to the app and that it shows the
hidden window, the View menu's zoom step and, on Linux, that no menu bar
shows, not on Alt either, and that the zoom keys, Ctrl and the wheel, Ctrl+O, copy and Ctrl+W work), then `again` (a
second start keeps the devices `attach` saw), `notrunning` and `stopped` (these start and stop the config's Ledung
themselves: the "not running" page, which may not show a hidden window, Retry, and a Ledung that stops under the
window), `notify` (a Ledung runs whose config has a project: the probe turns the page's notifications on, hides the
window on Overview and waits up to `PROBE_NOTIFY_SECONDS`, 180 by default, while you start a session there that asks
for permission, e.g. a Haiku session told to run `mkdir x` with Bash in a project with `"permissionMode": "default"`;
it then clicks the page's notification and checks the window shows that session; it records the notifications in the
page, so the system need not display them),
`start` (none runs; with `LEDUNG_DESKTOP_START` set as above and an `ELECTRON_*`
variable of your own, e.g. `ELECTRON_PROBE=1`: presses Start Ledung, the page signed in within 15 s, no `ELECTRON_*`
or `npm_*` variable in the started Ledung or its launcher; it leaves that Ledung running, so check it still answers
after the app quit, then stop it), `startfail` (none runs, `LEDUNG_DESKTOP_START` naming a script that isn't there:
the one line saying what failed, Start Ledung and Retry again, no error dialog, and Quit still ends the app; both
refuse to run without `LEDUNG_DESKTOP_START`) and `window` (a Ledung runs: closing hides, the Dock and a second start
show the window again, ⌘O reaches the page as its Ctrl+O, Quit on a page with unsaved changes asks and Stay keeps the
app, closing from full screen, a 100 ms timer in the hidden window, then Quit ends the app and the Ledung still
answers; `PROBE_HIDDEN_SECONDS` sets the hidden time, 60 by default) and `windows` (a Ledung runs, #414: File → New
Window on ⌘N/Ctrl+N and the footer's New window button each open another signed-in window at the start page while the
first keeps its route, no new device, the "not running" page cannot ask for one, closing one of several closes it, the
last only hides, the Dock and a second start show the most recently used, Quit closes them all and the Ledung still
answers). A fresh data folder shows Ledung's Welcome,
which has no sidebar, so finish or leave the welcome in the page before the first run. Each check it makes prints
`"event":"fail"` when it doesn't hold; the exit code is 0 only when all held, 1 otherwise, 2 when it refused to run.
It refuses without both settings, on the default port, and on Windows (it reads command lines with `ps`; macOS and
Linux only for now).

## How it is built

- `main.ts`: the windows. Sandboxed, context isolation on, no Node in the page; navigation away from Ledung's address
  and every window the page opens itself are refused. More windows come from File → New Window (⌘N/Ctrl+N) or the
  page's New window button (#414); they share one sign-in, and all show the Ledung or all the "not running" page.
  TypeScript, run as is: Electron 45's Node strips types like the core's Node 24 (checked 2026-11-17 on macOS,
  Electron 45.3.3 with Node 24.22.3).
- `preload.cjs`: the page's bridge to the app: `ledungDesktop.showWindow()` (#360), which a click on one of the page's
  notifications calls, since `window.focus()` cannot show a hidden window, and `ledungDesktop.newWindow()` (#414), the
  footer's New window button. It gives the page those two functions and nothing else (no Node, no `ipcRenderer`), and
  the app acts only when Ledung's own page asks, never the "not running" page. Plain JavaScript: a sandboxed preload
  runs in the page's process, which strips no types. In a browser the page finds no `ledungDesktop`: the click does
  what it always did, and the New window button opens a new browser tab or window.
- `windows.ts`: the list of the app's windows, the most recently used last, and which close only hides (the last one).
  `menu.ts`: the app's menu and its keys per system. No Electron in either, so `test/desktop.test.ts` runs them.
- `attach.ts`: finding the running Ledung. No Electron in it, so the root `npm run check` tests it
  (`test/desktop.test.ts`), including that its proof matches the core's.
- `keys.ts`: the zoom keys off the Mac (#389): Ctrl and "+" or "=", in one zoom step. No Electron in it, so
  `test/desktop.test.ts` runs it.
- `start.ts`: Start Ledung: the command, its clean environment and the one line a failed start gives. No Electron in
  it either, so `test/desktop.test.ts` runs it, with scripts of its own in place of `ledung`.
- `made.ts`: the made app's settings, `ledung-app.json` (#407). No Electron in it; `test/desktop-app.test.ts` runs it.
- `not-running.html`: the page shown when no Ledung answers, with Start Ledung and Retry.
- `npm run typecheck` checks this folder; the root `npm run check` does not cover `main.ts` (it would need Electron's
  types at the root).

Electron is this folder's own dependency and the root's optional one, at the same version (`test/package.test.ts`
checks it). Its npm package has no install script, so neither `npm ci` (CI, every worktree) downloads an Electron
binary; `npm start` here downloads it the first time. CI skips changes that touch only this folder; the app is tried by
hand.
