# A tray icon: see that Ledung runs, open it, exit it — design

Nov 17, 2026 · **Proposal**, not decided. Issue [#347](https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/issues/347). Nothing is built until Simon says go, part by part.

## Why

Simon (2026-11-17): "Right now, it's difficult to know if Ledung is actually running. Same if we want to close it. What if we have a small icon in the taskbar/activity field … Clicking on it could open the Ledung page/web app. Right-clicking on it could have an 'exit' maybe."

Since #456 Ledung runs in the background with no window. That is quieter, but now nothing on screen says it runs, and stopping it means opening the page and finding Settings → Update & restart → Stop Ledung, or `ledung stop` in a terminal. Hunting for the right `node` process is exactly what must never be done.

## What it does

While Ledung runs, a small Ledung icon sits in the Windows notification area (bottom right, next to the clock).

- **Hover:** the tooltip says `Ledung · 127.0.0.1:41579`, and `· 2 waiting for you` when something waits.
- **Left-click:** opens Ledung's page in the default browser, signed in, as the start does today.
- **Right-click:** a menu:

  ```
  3 working · 2 waiting for you      (grey, not clickable)
  ─────────────────────────────
  Open Ledung                        (bold: what left-click does)
  Restart Ledung                     (only when a launcher can start it again)
  ─────────────────────────────
  Exit Ledung
  ```

  With nothing going on the first line reads `Nothing working`.
- **Something waits for you:** while a question or permission prompt is addressed to the person, the icon gets a small amber dot. It uses the same rule as the page's notifications and phone push (`waitingCount`, `src/shared/waiting.ts`), so all three agree.
- **Exit Ledung** stops Ledung the way **Stop Ledung** in Settings does (choice C). When sessions are working, it asks first, in a small Windows dialog:

  > 3 sessions are working. Exiting Ledung stops them; you can resume them after the next start.
  > [Exit Ledung]  [Cancel]

  With nothing working it exits straight away.
- **The icon goes away** when Ledung stops, however it stops: Exit, Stop Ledung in Settings, `ledung stop`, Ctrl+C, a crash, or the process being killed. **It comes back** a few seconds after Restart Ledung (it is gone during the restart itself; choice B).
- **Windows 11 hides new tray icons** in the `^` overflow at first. Ledung cannot pin itself (Windows has no way to do that from a program); Settings says how: drag it onto the taskbar, or switch it on under Windows Settings → Personalization → Taskbar → Other system tray icons. That list names it **Windows PowerShell**, not Ledung (see choice A); its tooltip and menu say Ledung.

No notifications pop out of the icon: the page and phone push already do that, and two would be noise.

## How it is built

### The helper (Windows)

A short PowerShell script that Ledung ships inside its own source, run by the **Windows PowerShell 5.1 that comes with every Windows 10 and 11** (signed by Microsoft). It uses .NET's `NotifyIcon` and a right-click menu from Windows Forms, also part of Windows. No download, no npm package, no exe of ours or anyone else's.

It is started the way Ledung already starts its process-list PowerShell (`src/platform/powershell-worker.ts`): the full path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, `-NoProfile -NonInteractive -WindowStyle Hidden -Command <script>`, no window. The script travels in the command, not in a file another program could swap.

Ledung and the helper talk **only over the helper's own stdin and stdout**, one line of JSON at a time:

- Ledung → helper: `{"tip":"Ledung · 127.0.0.1:41579","status":"3 working · 2 waiting for you","dot":true,"restart":true,"confirm":"3 sessions are working…"}` when any of it changes (at most once a second).
- Helper → Ledung: one of a fixed set of words: `open`, `restart`, `exit`, `exit-confirmed`. Anything else is ignored.

The icon image is Ledung's own 256-pixel PNG (the one the shortcuts use, `src/platform/icons.ts`), scaled down by the helper; the amber dot is drawn on it by the helper at run time, so no second image is shipped.

### Which process owns it (choice B)

**The Ledung server (`src/main.ts`) starts the helper and is its only owner.** When the server ends, in any way, Windows closes the pipe, the helper reads end-of-input, removes the icon and exits. As a second net the helper checks every few seconds that the server's process still exists (its id is in the first message), in case the pipe stays open for some reason. On Restart Ledung the old server's helper goes and the new server starts a new one.

The launchers stay as they are. There are three of them (the release `launcher.mjs`, the npm `ledung` command in `src/cli.ts`, and none at all for `npm start`), so putting the icon in the server is the one place that covers the npm install, a release and a clone alike.

### Opening the page signed in (choice D)

The helper never sees the sign-in token. A left-click sends `open`; **the server** opens `http://127.0.0.1:<port>/login?token=…` with the same `openBrowser` it uses at every start. So the token goes exactly where it goes today and nowhere new.

### Exit and Restart

`exit` runs the same `shutdown(false)` as Stop Ledung, `ledung stop` and Ctrl+C: sessions stop, they can be resumed after the next start. Before that, if sessions are working, the server sends the helper the confirm text; the helper shows a Windows dialog, and only **Exit Ledung** in it sends `exit-confirmed`. `restart` runs the same restart as the page's Restart Ledung, offered only when a launcher can start Ledung again (`LEDUNG_LAUNCHER=1`).

### Settings

Settings → Update & restart gets one switch: **Show Ledung's icon in the notification area** (on by default). It is kept per computer, in the data folder's meta table, like the update channel, and applies at once: off stops the helper, on starts it. A Ledung started with its own data folder (`LEDUNG_DATA_DIR`: throwaway copies, tests) has it **off by default**, so a session testing Ledung doesn't fill Simon's notification area (choice F).

If the helper can't start (no desktop, e.g. a Ledung run over SSH or as a service; PowerShell missing), Ledung writes one line to its log and goes on without the icon. A helper that dies on its own is started again once after a minute, then left alone until the next start.

### macOS and Linux (choice E)

- **macOS, menu bar:** the same design with `osascript -l JavaScript`, which every Mac has (signed by Apple), using its bridge to AppKit's `NSStatusItem`. Same pipe, same messages, same menu. Built after Windows, once a Mac is at hand for a check, as its own issue.
- **Linux:** there is no tray that works the same everywhere: GNOME shows none without an extension, others use the StatusNotifierItem standard over D-Bus. Proposal: later, and only where `python3` with the AppIndicator library is already installed; elsewhere Settings says the icon isn't available on this desktop. Its own issue, low priority.

On both, until they are built, the switch in Settings is not shown.

## Security

- **No new network exposure.** The helper opens no port and makes no HTTP request; nothing reaches it over the local network or the relay, and nothing about it is added to the API.
- **Other programs can't steer it.** Its only input is the pipe the server created for it; another program can't write to that pipe. A program running as the same Windows user could already read the token file, so that stays the trust line, as for the rest of Ledung.
- **It holds nothing secret.** No token, no sign-in link, no session names, no question text: only counts, the address and fixed menu words. The words it sends back are a fixed list; anything else is dropped.
- **Exit and Restart from the tray are local by nature:** someone at this computer's screen. They don't change who may stop Ledung through the API (`/api/stop` stays as it is).
- **No profile or path tricks:** PowerShell by its full path with `-NoProfile`, so neither a changed PATH nor the user's PowerShell profile changes what runs.
- Rejected: npm tray packages. `systray2` ships a 3.6 MB Go program for Windows that is **not signed**; `trayicon` ships a small exe signed by a company we don't know (checked 2026-11-17); `ctray` needs a C++ compiler at install. All three last changed in 2022.

## Parts

Each part is its own go-ahead.

1. **Spike: the helper on its own** (≈ 30 min session time). A throwaway script that shows the icon, the menu and the dialog, and goes away when its parent is closed normally and when it is killed. Measure what it costs while idle (memory, CPU) and the restart gap.
   *Done when:* the spike's numbers and two dark-mode screenshots (icon with tooltip, menu open) are in `docs/steps/tray-icon-spike/`, and Simon has seen them.
2. **The Windows icon** (≈ 60–90 min). `src/platform/tray.ts` (the script and the pipe), started from `src/main.ts`: icon, tooltip, left-click opens the page, menu with Open, Restart and Exit, gone on any stop, back after a restart. Tests with a fake helper, as `powershell-worker` has.
   *Done when:* on this PC, a throwaway Ledung shows the icon; left-click opens its page signed in; Restart brings the icon back; Exit, `ledung stop` and killing the server each remove it; `npm run check` passes.
3. **Status and the waiting dot** (≈ 30–45 min). The status line, the tooltip count and the dot, from the session manager's working count and `waitingCount`.
   *Done when:* asking a test session a question puts the dot and `1 waiting for you` on the icon, and answering it takes them away.
4. **Exit asks first** (≈ 20–30 min). The confirm when sessions are working.
   *Done when:* Exit with a working session shows the dialog, Cancel leaves everything running, Exit Ledung stops it; with nothing working Exit stops at once.
5. **The switch in Settings** (≈ 30 min). On by default, off by default for a Ledung with its own data folder, applies at once, text on pinning the icon in Windows 11; works at 390 px; CHANGELOG bullet; README line.
   *Done when:* switching it off removes the icon at once and it stays off after a restart; the Settings section reads well on a phone-width screen.
6. **macOS menu bar** and 7. **Linux**: separate issues, after Windows (choice E).

## Choices for Simon

- **A. How the Windows icon is shown.** Recommended: **the PowerShell helper above** (nothing to download or sign; the catch is that Windows' own icon list calls it "Windows PowerShell"). Alternatives: an npm tray package (ships unsigned or unknown exes; ruled out by the issue), or a tiny C# program compiled on the PC at first start by the C# compiler that comes with Windows (named "Ledung" in that list, but an unsigned exe made on the spot is what antivirus is wary of).
- **B. Who owns it.** Recommended: **the Ledung server**, so it is the same for npm, release and clone, and goes away even on a crash. The cost: the icon disappears for the few seconds of a restart. The alternative, the launcher, would keep it through a restart but means three launchers to change and none for `npm start`.
- **C. What Exit does.** Recommended: **stop everything, as Stop Ledung does**, asking first when sessions are working. The alternative, stopping only the server and leaving sessions running in their hosts, would leave Claude working (and spending usage) with no icon and no page, which is the "is it running?" problem again.
- **D. Opening signed in.** Recommended: **the server opens the same sign-in link as at start**; the helper never gets the token. A one-use, short-lived link for both the start and the icon would be a little tidier; if wanted, that is its own issue.
- **E. Platforms.** Recommended: **Windows first**; macOS menu bar next as its own issue; Linux later, only where AppIndicator is already there.
- **F. Default.** Recommended: **on by default** with a switch in Settings, **off by default for throwaway copies** (own data folder).
