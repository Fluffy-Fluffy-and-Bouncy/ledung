# Ledung desktop app

Ledung's page in a window of its own instead of a browser tab (epic #357). This first phase is for the owners' own
computers: **unsigned, run from a clone, not shipped**. Nothing in this folder goes into the npm package, and nothing is
published for it (Martin, 2026-11-17, Ledung questions #336 and #338; [docs/decisions.md](../docs/decisions.md)).

## Run it

Start Ledung the way you always do (`ledung`, or the release launcher). Then, in this folder:

```sh
npm install   # once, and after a pull that changes package.json: downloads Electron into desktop/node_modules
npm start
```

One window opens with your running Ledung's page, signed in. Nothing opens in the browser.

- **It attaches, it never starts a Ledung.** With none running the window says "Ledung is not running" and offers
  **Retry**; start Ledung, then press it. (Starting one from the app is #362.)
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
- **Quitting.** ⌘Q on the Mac, File → Quit or Alt+F4 on Windows end the app. Ledung itself is another program and
  keeps running.
- **⌘O on the Mac** does what Ctrl+O does in the page: Show tool calls. (In a browser the page keeps to Ctrl+O on
  every system, so that ⌘O stays the browser's; in the app ⌘O is the app's own.)
- **A hidden window keeps its pace.** Its timers run at full speed, so notifications come on time. The page also counts
  as shown then, so it keeps polling (the usage panels refresh while hidden).
- **Permissions.** Ledung's page may show notifications and copy to the clipboard, the two things it uses. Everything
  else a page can ask for (camera, microphone, screen, location, reading the clipboard) is refused: Electron would
  otherwise grant it without asking, where a browser asks you.

## Trying it against a throwaway Ledung

The app reads `LEDUNG_CONFIG` and `LEDUNG_DATA_DIR` exactly as the core does, so a session tests it without touching
the real Ledung. Start a throwaway Ledung on one of your test ports, then the app with the same two settings:

```sh
# from the clone's root
LEDUNG_CONFIG=$PWD/.test/a/config.json LEDUNG_DATA_DIR=$PWD/.test/a/data node src/main.ts --no-open
# from desktop/, in another terminal
LEDUNG_CONFIG=$PWD/../.test/a/config.json LEDUNG_DATA_DIR=$PWD/../.test/a/data npm start
```

`.test/a/config.json` names the port, e.g. `{ "port": 4396, "projects": [] }`. The app keeps its cookies in its own
folder (Electron's user data for "ledung-desktop"), apart from any browser. Cookies on `127.0.0.1` are shared by every
port (#52), so pointing the app at another Ledung and back signs it in again, as a new device in that Ledung.

Stop the throwaway Ledung by the process listening on its port, never by name: the real Ledung is a `node` process too.

**The loopback check.** `probe/` loads the real `main.ts` and checks the window from inside, against the throwaway
Ledung the two settings name, printing `PROBE {…}` lines; opening the default browser is intercepted, so nothing opens.
From this folder, with the settings as above: `PROBE_PHASE=attach npx electron probe` (a Ledung runs: sign-in, address,
settings, permissions, refused navigation, links), then `again` (a second start keeps the devices `attach` saw),
`notrunning` and `stopped` (these start and stop the config's Ledung themselves: the "not running" page, Retry, and a
Ledung that stops under the window), and `window` (a Ledung runs: closing hides, the Dock and a second start show the
window again, ⌘O reaches the page as its Ctrl+O, a 100 ms timer in the hidden window, then Quit ends the app and the
Ledung still answers; `PROBE_HIDDEN_SECONDS` sets the hidden time, 60 by default). A fresh data folder shows
Ledung's Welcome, which has no sidebar, so finish or leave the welcome in the page before the first run. Each check it makes prints `"event":"fail"` when it doesn't hold; the exit code is
0 only when all held, 1 otherwise, 2 when it refused to run. It refuses without both settings, on the default port,
and on Windows (it reads command lines with `ps`; macOS and Linux only for now).

## How it is built

- `main.ts`: the window. Sandboxed, context isolation on, no Node in the page; navigation away from Ledung's address
  and every new window are refused. TypeScript, run as is: Electron 45's Node strips types like the core's Node 24
  (checked 2026-11-17 on macOS, Electron 45.3.3 with Node 24.22.3).
- `attach.ts`: finding the running Ledung. No Electron in it, so the root `npm run check` tests it
  (`test/desktop.test.ts`), including that its proof matches the core's.
- `not-running.html`: the page shown when no Ledung answers.
- `npm run typecheck` checks this folder; the root `npm run check` does not cover `main.ts` (it would need Electron's
  types at the root).

Electron is this folder's own dependency, so the root `npm ci` (CI, every worktree) downloads none. CI skips changes
that touch only this folder; the app is tried by hand.
