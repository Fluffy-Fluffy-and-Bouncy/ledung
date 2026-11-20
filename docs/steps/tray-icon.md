# A tray icon: see that Ledung runs, open it, exit it — design

Nov 17, 2026 · **Approved (Simon, 2026-11-17, #2027)**, with all recommended choices ([decisions](../decisions.md)), and built in one PR, parts 2–5. Issue [#347](https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/issues/347).

Revised the same night: **Windows and macOS are both first-class** and built together (Simon, through the manager, 2026-11-17). Linux stays later.

## Why

Simon (2026-11-17): "Right now, it's difficult to know if Ledung is actually running. Same if we want to close it. What if we have a small icon in the taskbar/activity field … Clicking on it could open the Ledung page/web app. Right-clicking on it could have an 'exit' maybe."

Since #456 Ledung runs in the background with no window. That is quieter, but now nothing on screen says it runs, and stopping it means opening the page and finding Settings → Update & restart → Stop Ledung, or `ledung stop` in a terminal. Hunting for the right `node` process is exactly what must never be done.

## What it does

The same icon, menu and rules on both systems; only where it sits and how it is clicked follow each system's habits.

### The menu (both)

```
3 working · 2 waiting for you      (grey, not clickable)
─────────────────────────────
Open Ledung
Restart Ledung                     (only when a launcher can start it again)
─────────────────────────────
Exit Ledung
```

With nothing going on the first line reads `Nothing working`.

- **Something waits for you:** while a question or permission prompt is addressed to the person, the icon shows it (an amber dot on Windows, a number on the Mac; below). It uses the same rule as the page's notifications and phone push (`waitingCount`, `src/shared/waiting.ts`), so all three agree.
- **Exit Ledung** stops Ledung the way **Stop Ledung** in Settings does (choice C). When sessions are working, it asks first, in a small system dialog:

  > 3 sessions are working. Exiting Ledung stops them; you can resume them after the next start.
  > [Exit Ledung]  [Cancel]

  With nothing working it exits straight away.
- **The icon goes away** when Ledung stops, however it stops: Exit, Stop Ledung in Settings, `ledung stop`, Ctrl+C, a crash, or the process being killed. **It comes back** a few seconds after Restart Ledung (it is gone during the restart itself; choice B).
- No notifications pop out of the icon: the page and phone push already do that, and two would be noise.

### On Windows

The icon sits in the **notification area**, bottom right next to the clock, in Ledung's own colours.

- **Hover:** the tooltip says `Ledung · 127.0.0.1:41579`, and `· 2 waiting for you` when something waits.
- **Left-click** opens Ledung's page in the default browser, signed in, as the start does today.
- **Right-click** opens the menu above; **Open Ledung** is in bold, as the left-click's action.
- **Waiting:** a small amber dot on the icon's corner.
- **Windows 11 hides new tray icons** in the `^` overflow at first. Ledung cannot pin itself (Windows offers programs no way to); Settings says how: drag it onto the taskbar, or switch it on under Windows Settings → Personalization → Taskbar → Other system tray icons. That list names it **Windows PowerShell**, not Ledung (choice A); its tooltip and menu say Ledung.

### On the Mac (for someone who hasn't used one)

A Mac has no taskbar at the bottom. Instead there is the **menu bar**: a thin strip along the **top** of the screen, always visible. Its left part belongs to whichever program is in front (File, Edit, …); its **right part holds small icons** from programs running in the background (Wi-Fi, battery, clock, Dropbox and the like). Ledung's icon goes there, as one of those small icons.

- **Look:** Mac menu bar icons are by habit **one colour, without colours of their own**: black on a light menu bar, white on a dark one, drawn by macOS itself from a "template" image. So the Mac icon is a plain silhouette of Ledung's mark, not the coloured icon (choice G). It needs a new small black-and-transparent picture of the mark, about 18 by 18 points.
- **A normal click opens the menu** (there is no separate left-click action as on Windows; that is how every menu bar icon behaves). So **Open Ledung** is the first item; opening the page takes two clicks, icon then Open Ledung. A right-click (or Control-click) opens the same menu.
- **No tooltip** on hover: Mac menu bar icons usually don't have one. The address is shown in the menu instead, as a grey line under the status: `127.0.0.1:41579`.
- **Waiting:** a small number next to the icon, `2`, in the menu bar's own text colour, the way Mac mail and chat programs show unread items. It goes when nothing waits.
- **No Dock icon:** the helper tells macOS it is a background program, so nothing appears in the Dock (the row of program icons at the bottom) and it never shows in the Cmd+Tab program switcher.
- **The Exit question** is a normal Mac alert box in the middle of the screen, brought to the front.
- **Crowded menu bars:** on MacBooks with a camera notch, icons that don't fit are silently hidden behind the notch; macOS has no overflow like Windows' `^`. Nothing Ledung can do; Settings mentions it. Recent macOS versions also list menu bar programs in System Settings → Menu Bar, where they can be switched off; the spike checks what name the helper has there (most likely **osascript**, choice A).

## How it is built

### One part in Ledung, one small helper per system

**Ledung's side is shared:** `src/platform/tray.ts` starts the helper, tells it what to show and acts on what it sends back. Only the helper script differs per system. Both are plain text inside Ledung's own source and both run on a program **the system already has and its maker already signed**:

- **Windows:** **Windows PowerShell 5.1**, on every Windows 10 and 11, with .NET's `NotifyIcon` and a right-click menu from Windows Forms, also part of Windows. Started the way Ledung already starts its process-list PowerShell (`src/platform/powershell-worker.ts`): the full path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, `-NoProfile -NonInteractive -WindowStyle Hidden -Command <script>`, no window. (Built: started through `cmd.exe`, with the script in the environment, so it outlives a stopped or killed Ledung long enough to remove its icon; see Built below.)
- **macOS:** **`/usr/bin/osascript -l JavaScript`**, on every Mac, Apple's own scripting program, which can use macOS's own menu bar parts (`NSStatusItem`, `NSMenu`, `NSAlert` from AppKit) through its bridge to them. It sets itself to "accessory" (no Dock icon) and runs until its input closes. The script is passed in the command (`-e`), not as a file another program could swap.

No download, no npm package, no exe or Mac program of ours or anyone else's.

**Gatekeeper, plainly.** Gatekeeper is the Mac's check on programs downloaded from the internet; it blocks those not signed and notarised by a registered Apple developer. `osascript` is part of macOS, signed by Apple, so Gatekeeper never stops it, and the script is text, not a program. The same goes for files Ledung makes on the computer itself (the Ledung.app shortcut already relies on this, `src/platform/shortcuts.ts`): they carry no "downloaded" mark, so Gatekeeper doesn't check them.

**What the alternative would cost.** A small native Mac program (Swift) would look the most native and be listed as "Ledung". Shipped ready-made in the npm package it would need signing with a **Developer ID** and **notarising** by Apple to be trusted: an **Apple Developer Program membership (99 USD a year)** in Martin's or the company's name, a Mac to build and sign every release (or a macOS CI runner with the certificate as a secret), and Apple's notary service on each release. Built on the Mac at first start instead, it needs Apple's developer tools, which most Macs don't have. Neither is worth it for a menu, so it is the fallback only if the spike shows osascript can't do the job (choice A).

### Talking to the helper

Ledung and the helper talk **only over the helper's own stdin and stdout**, one line of JSON at a time, the same on both systems:

- Ledung → helper: `{"tip":"Ledung · 127.0.0.1:41579","status":"3 working · 2 waiting for you","waiting":2,"restart":true,"confirm":"3 sessions are working…","parent":12345}` when any of it changes (at most once a second).
- Helper → Ledung: one of a fixed set of words: `open`, `restart`, `exit`, `exit-confirmed`. Anything else is ignored.

The Windows icon is Ledung's own 256-pixel PNG (the one the shortcuts use, `src/platform/icons.ts`), scaled down by the helper, with the amber dot drawn on it at run time. The Mac icon is the new silhouette PNG (one file, at 1× and 2×), shipped with the page's other icons.

### Which process owns it (choice B)

**The Ledung server (`src/main.ts`) starts the helper and is its only owner.** When the server ends, in any way, the system closes the pipe, the helper reads end-of-input, removes the icon and exits. As a second net the helper checks every few seconds that the server's process (`parent`) still exists. On Restart Ledung the old server's helper goes and the new server starts a new one.

The launchers stay as they are. There are three of them (the release `launcher.mjs`, the npm `ledung` command in `src/cli.ts`, and none at all for `npm start`), and on the Mac Ledung may also be started by Ledung.app or the sign-in LaunchAgent; putting the icon in the server covers all of them alike.

### Opening the page signed in (choice D)

The helper never sees the sign-in token. **Open Ledung** (and a left-click on Windows) sends `open`; **the server** opens `http://127.0.0.1:<port>/login?token=…` with the same `openBrowser` it uses at every start (`rundll32` on Windows, `open` on the Mac). So the token goes exactly where it goes today and nowhere new.

### Exit and Restart

`exit` runs the same `shutdown(false)` as Stop Ledung, `ledung stop` and Ctrl+C: sessions stop, they can be resumed after the next start. Before that, if sessions are working, the server sends the helper the confirm text; the helper shows the system dialog, and only **Exit Ledung** in it sends `exit-confirmed`. `restart` runs the same restart as the page's Restart Ledung, offered only when a launcher can start Ledung again (`LEDUNG_LAUNCHER=1`).

### Settings

Settings → Update & restart gets one switch: **Show Ledung's icon in the notification area** (on the Mac: **in the menu bar**), on by default. It is kept per computer, in the data folder's meta table, like the update channel, and applies at once: off stops the helper, on starts it. A Ledung started with its own data folder (`LEDUNG_DATA_DIR`: throwaway copies, tests) has it **off by default**, so a session testing Ledung doesn't fill the real tray; the config's `"trayIcon": true` turns it on for such a copy, which is how it is tried out (choice F).

If the helper can't start (no desktop, e.g. a Ledung run over SSH or as a service; PowerShell or osascript missing), Ledung writes one line to its log and goes on without the icon. A helper that dies on its own is started again once after a minute, then left alone until the next start.

### Linux (choice E)

There is no tray that works the same everywhere: GNOME shows none without an extension, others use the StatusNotifierItem standard over D-Bus. Proposal: later, as its own issue, only where `python3` with the AppIndicator library is already installed; elsewhere the switch isn't shown.

## Security

- **No new network exposure.** The helper opens no port and makes no HTTP request; nothing reaches it over the local network or the relay, and nothing about it is added to the API.
- **Other programs can't steer it.** Its only input is the pipe the server created for it; another program can't write to that pipe. A program running as the same user could already read the token file, so that stays the trust line, as for the rest of Ledung.
- **It holds nothing secret.** No token, no sign-in link, no session names, no question text: only counts, the address and fixed menu words. The words it sends back are a fixed list; anything else is dropped.
- **Exit and Restart from the icon are local by nature:** someone at this computer's screen. They don't change who may stop Ledung through the API (`/api/stop` stays as it is).
- **No profile or path tricks:** the helper's program by its full path (`powershell.exe` under System32 with `-NoProfile`; `/usr/bin/osascript`), so neither a changed PATH nor a user's profile changes what runs.
- **Nothing for Gatekeeper or antivirus to judge:** both helpers are scripts run by the system's own signed programs.
- Rejected: npm tray packages. `systray2` ships ready-made programs for Windows (3.6 MB, **not signed**), macOS and Linux; a downloaded, unsigned Mac program is just what Gatekeeper and Apple Silicon's signing rules trip over. `trayicon` is Windows-only and ships a small exe signed by a company we don't know; `ctray` needs a C++ compiler at install. All three last changed in 2022 (checked 2026-11-17).

## Testing on the Mac

Simon has no Mac, so the Mac side is checked by Martin (or another Mac user), as earlier Mac checks were (e.g. the Mac check of PR #432):

- **Automatic, everywhere:** `src/platform/tray.ts` is tested with a fake helper, as `powershell-worker` is: what is sent when counts change, that only the fixed words are acted on, that Exit asks only with sessions working, that the helper is started again only once. These run in `npm run check` on any system, and in CI's weekly macOS run.
- **The helper scripts themselves** need a screen, so no CI runs them. On the Mac, a **checklist** (about 10 minutes), in a clone on the PR's branch, with a throwaway copy:
  `LEDUNG_CONFIG=<temp>/config.json LEDUNG_DATA_DIR=<temp>/data node src/main.ts` with `"port": 4396, "trayIcon": true` in that config. Then: the icon appears in the menu bar, black on a light menu bar and white on a dark one (switch in System Settings → Appearance); a click opens the menu; Open Ledung opens the page signed in; asking a test session a question shows `1` next to the icon, answering removes it; Restart brings the icon back; Exit with a working session asks first; Ctrl+C in the terminal, and `kill -9` of the server, each remove the icon; nothing in the Dock or Cmd+Tab. Screenshots in dark mode of the menu bar and the open menu.
- The same checklist, with the Windows items, is run on this PC.

## Parts

Each part is its own go-ahead. Windows and macOS are built together from part 2 on; only the spike is split, because the Mac half needs a Mac.

1. **Spike: the two helpers on their own.**
   - 1a, **Windows** (≈ 30 min session time, on this PC): a throwaway script that shows the icon, the menu and the dialog, and goes away when its parent is closed normally and when it is killed. Measure its idle cost (memory, CPU) and the restart gap.
   - 1b, **macOS** (≈ 30 min to write, plus ≈ 15 min of Martin's on a Mac): the same with osascript. This is the riskier half: the open point is whether osascript can keep the menu bar icon alive while reading its input, and what name macOS shows for it. If it can't, we come back with the Swift choice and its cost before building.
   *Done when:* both work, their numbers and dark-mode screenshots (icon, open menu, Exit dialog) are in `docs/steps/tray-icon-spike/`, and Simon has seen them.
2. **The icon on both systems** (≈ 90–120 min). `src/platform/tray.ts` and the two helper scripts, started from `src/main.ts`: icon, Windows tooltip and left-click, the menu with Open, Restart and Exit, gone on any stop, back after a restart; the Mac silhouette icon. Tests with a fake helper.
   *Done when:* the checklist above passes on this PC and on a Mac; `npm run check` passes.
3. **Status and waiting** (≈ 30–45 min). The status line, the Windows tooltip count and dot, the Mac number, from the session manager's working count and `waitingCount`.
   *Done when:* asking a test session a question shows the dot (Windows) or `1` (Mac) and `1 waiting for you` in the menu, and answering takes them away, on both.
4. **Exit asks first** (≈ 20–30 min). The confirm when sessions are working.
   *Done when:* on both, Exit with a working session shows the dialog, Cancel leaves everything running, Exit Ledung stops it; with nothing working Exit stops at once.
5. **The switch in Settings** (≈ 30 min). On by default, off for a Ledung with its own data folder unless the config says `"trayIcon": true`, applies at once, the wording per system (notification area / menu bar) and the hints on pinning (Windows 11) and the notch (Mac); works at 390 px; CHANGELOG bullet; README line.
   *Done when:* switching it off removes the icon at once and it stays off after a restart; the Settings section reads well on a phone-width screen.
6. **Linux**: a separate issue, later (choice E).

Parts 2–5 can be one PR with the Mac checklist run before it merges, or each its own PR; one PR means one Mac check instead of four (recommended).

## Choices for Simon

- **A. How the icon is shown.** Recommended: **scripts run by the system's own signed programs**: PowerShell on Windows, osascript on the Mac. Nothing to download, sign or notarise; antivirus and Gatekeeper have nothing to object to. The catch: the systems' own lists of tray and menu bar programs call it "Windows PowerShell" and (most likely) "osascript", not Ledung. Alternatives: npm tray packages (ship unsigned or unknown programs; ruled out by the issue); or a small native program per system, named "Ledung": on Windows compiled on the PC by the C# compiler Windows has (an unsigned exe made on the spot, which antivirus is wary of); on the Mac shipped signed and notarised, which costs an Apple Developer membership (99 USD a year), a Mac or macOS CI to sign each release, and notarising each release.
- **B. Who owns it.** Recommended: **the Ledung server**, so it is the same for npm, release, clone, Ledung.app and the sign-in start, and goes away even on a crash. The cost: the icon disappears for the few seconds of a restart. The alternative, the launchers, would keep it through a restart but means several launchers to change and none for `npm start`.
- **C. What Exit does.** Recommended: **stop everything, as Stop Ledung does**, asking first when sessions are working. The alternative, stopping only the server and leaving sessions running in their hosts, would leave Claude working (and spending usage) with no icon and no page, which is the "is it running?" problem again.
- **D. Opening signed in.** Recommended: **the server opens the same sign-in link as at start**; the helper never gets the token. A one-use, short-lived link for both the start and the icon would be a little tidier; if wanted, that is its own issue.
- **E. Platforms.** Recommended: **Windows and macOS together**, after a spike on each; Linux later, as its own issue, only where AppIndicator is already there.
- **F. Default.** Recommended: **on by default** with a switch in Settings, **off by default for throwaway copies** (own data folder), which `"trayIcon": true` in their config turns on.
- **G. The Mac icon.** Recommended: **a one-colour silhouette of Ledung's mark**, as Mac menu bar icons are by habit, with the waiting count as a number beside it. The alternative, the coloured icon as on Windows, would stand out among the other menu bar icons and doesn't adapt to a dark menu bar. Someone has to draw the silhouette: from the existing icon, in part 2.
- **H. Who checks on a Mac.** Recommended: **Martin**, with the checklist above, once for the spike (1b) and once before the PR merges.

## Built (2026-11-17)

Parts 2–5 in one PR. The Windows spike (1a) was done while building; the Mac spike (1b) waits for a Mac, with the checklist above.

- `src/platform/tray.ts` (shared: starting, state lines, the fixed words, Exit's question, one restart after a minute, the Settings switch), `src/platform/tray-windows.ts` and `src/platform/tray-mac.ts` (the two helper scripts), started from `src/main.ts`; `GET`/`POST /api/tray` for the switch, only from this computer's own page. The Mac silhouette is `web/public/tray-mac.png`, drawn by `scripts/tray-mac-icon.ts` from icon.svg's middle boat and wave.
- **Windows findings.** (1) Started hidden, Windows hides the *first window* the helper shows, whatever it asks for: the Exit dialog opened invisible and waited for an answer no one could give. The helper now shows an invisible window once at start to take that turn. (2) `Console.In.ReadLineAsync` blocks in .NET Framework; the helper reads with its own `StreamReader` and polls from a Forms timer, so the menu stays live, also while the Exit dialog is open (Ledung stopping then closes the dialog with the icon). (3) The page's `icon-256.png` is square with white corners; the helper cuts out the rounded square. (4) A helper that is *killed* leaves a stale icon until the mouse passes over it (Windows' own behaviour). The acceptance test (round 1, point 5) found that this happened on *every* stop: Node puts the children it starts in a job that kills them when Node exits, so the helper was killed before it could remove its icon, and after Restart there were two icons. Fix: the helper is started through `cmd.exe` (`cmd /d /s /c powershell.exe ... -Command iex $env:LEDUNG_TRAY_SCRIPT`). That job lets its members' own children break away, so PowerShell is outside it (checked with `IsProcessInJob`: cmd.exe in the job, PowerShell not); only cmd.exe is killed with Ledung. PowerShell then sees its input end and removes the icon. Starting it `detached` instead doesn't work: Windows PowerShell without a console exits before running anything. Ledung also sends `{stop}` before closing the helper's input, the helper checks its parent every second instead of every 5, and a `finally` around its message loop hides and disposes the icon on any other way out. Checked on this PC (2026-11-17, throwaway Ledung on port 4394): after Restart one icon (was two), and after Exit from the tray menu, `ledung stop` and `taskkill /F` of the server alone the icon is gone and the helper has ended within 1.5 s, with no mouse over the notification area (`tray-icon-spike/fix-*.png`).
- **Windows numbers** (this PC, 3440×1440 at 100%): the helper idles at about 98 MB working set, 129 MB private, and no measurable CPU over 30 s; the icon appears about a second after Ledung starts (PowerShell loading). Restart: the old server exited at 01:24:01.89, the new one started at 01:24:01.91 and its helper at 01:24:02.62, so the icon is gone for about 2 s.
- **Not like the rest of Windows:** the menu and dialog are Windows Forms' light ones, also in dark mode; Windows' own tray menus follow the dark theme.
- **Screenshots** (this folder's `tray-icon-spike/`, dark mode, cropped to the icon's own windows): the icon plain and with the waiting dot, the menu with nothing working and Restart (a launcher), the menu with `1 working · 1 waiting for you`, the Exit question, the Settings section at desktop width and at 390 px, and the Mac template icon drawn black on a light bar and white on a dark one (a preview made here, not on a Mac).
- **Not tried here:** the Windows tooltip (needs the mouse resting on the icon), and the whole Mac half, which waits for Martin's checklist.
