# Ledung changelog: dev builds

Every dev build (a version X.Y), newest first: what Settings → About → Update channel → Dev updates to. Each
build has one heading with its version and when it was published, then terse `- ` bullets, one per change, each
ending with its issue `(#12)` or `(no issue)`. Public releases, which fold the dev builds since the last one
together, are in [CHANGELOG.md](CHANGELOG.md). Online: https://projectledung.com/dev-changelog

**Don't edit this file.** A pull request writes its bullets in `docs/changes/<issue>.md`
([docs/changes/README.md](docs/changes/README.md)); `npm run publish:dev` and `npm run publish:public` fold them in
here under the version they publish, and push the result to main.

## v4.4 — 2026-11-20 15:23 CET
- After a linked computer is unlinked (or its link lost) and linked again, its tab here paired through the old link counts for the new link's trust, instead of still asking for a passkey (#462)

## v4.3 — 2026-11-20 15:07 CET
- Linked computers survive a crash right after a save: links.json is flushed to the disk and kept with a backup, which Ledung loads (and logs) when links.json can't be read (#460)
- The config file, sign-ins, locked secrets, the relay link and its admin file, certificates, the usage key and session secret files are flushed to the disk before they replace the old file, so a crash can't leave them empty (#460)

## v4.2 — 2026-11-20 14:31 CET
- The desktop app runs the installed Ledung's code however it is opened (Start menu, taskbar, Dock, Launchpad, Finder, "Open in the Ledung app"): after an update it brings itself up to date at start, before its window opens (#455)
- An app whose own `ledung` has the same version as the app no longer restarts over and over when another install of Ledung runs (#455)
- In the desktop app, Reload (⌘R or Ctrl+R, View → Reload, Force Reload) after an update restarts the app into the installed version instead of reloading only the page (#455)

## v4.1 — 2026-11-20 14:23 CET
- Desktop app: New window in a linked computer's tab opens a new app window at your own start page, as in your own tab; needs this version on both computers (#454)
- The desktop app on a Mac no longer waits forever for a Touch ID prompt that never comes: a passkey check there says in one line to make the change in your browser, and offers to open that page in it (#427)

## v4 — 2026-11-20 01:20 CET
The public release. Everything since v3: v3.10, v3.11, v3.12, v3.13, v3.14, v3.15, v3.16, v3.17. v3.1 to v3.9 came before the changelog per release: their changes are listed by date, under "Earlier, by date" in CHANGELOG.md.

## v3.17 — 2026-11-20 00:11 CET
- Desktop app: right-clicking gives a menu, as in a browser: Copy Image and Save Image As… on a picture (screenshots too), Copy Link Address on a link, Copy on selected text, and Cut, Copy, Paste and Select All in a text box (#447)
- Desktop app: Ctrl+F (⌘F on the Mac) opens a find bar, as in a browser: it highlights the matches on the page and shows "n of m"; Enter and Shift+Enter go to the next and previous match, Esc closes it. Also Edit → Find… (#445)

## v3.16 — 2026-11-19 23:07 CET
- Update Ledung from npm no longer restarts into the old version without saying so: when npm finishes but Ledung's folder still holds the old version, the update stops and shows npm's output and where npm installs to (#435)
- After an update's restart, Settings → Update & restart says when Ledung still runs the old version (#435)
- An npm update's outcome, and why it stopped, now goes to ledung.log too (#435)
- Settings → About names the version that runs, not one installed after Ledung started (#435)
- Desktop app: when the tray icon's **Open Ledung** opens the browser instead of the app, it now says why, once in Ledung's log and once in a banner on the page that opens, for example that Electron's package is missing or the app could not be made. With `"desktopApp": false` it says so in the log only. (#434)

## v3.15 — 2026-11-19 22:25 CET
- What changed is now listed per release instead of per day: a changelog of the dev builds and one of the public releases, each heading with the version and when it was published. Settings → About links to both, online at projectledung.com/changelog and projectledung.com/dev-changelog, your own update channel's first. On an install from a clone, Check for updates still lists what is new on main. (#417)

## v3.14 — 2026-11-19 22:05 CET
- Managers can start with only the plugins and MCP servers managers on this computer actually used in the last week, when the workflow's profiles file turns it on with `"learnManagerTools": true`; the rest are left out, which saves tokens on every turn. context-mode is never kept. Ledung learns this from managers' calls, starting from the past week it has stored, and drops nothing before managers have run here for a week. Off when the workflow doesn't say. (#431)

## v3.13 — 2026-11-19 21:49 CET
- Desktop app as the way in on your computer: the tray icon's **Open Ledung** now opens the app, making it the first time as `ledung` does, and the Mac's Ledung icon in Applications opens it when Ledung is already running, as `ledung` and the Windows icons already did. A browser on the same computer now shows **Open in the Ledung app** at the top of the page and in Settings → Look & feel → App instead of offering to install the page. It is only a hint: the page keeps working in the browser, and **Not now** hides it there for good. Phones and other computers are unchanged, and with `"desktopApp": false` everything opens the browser as before. (#409)

## v3.12 — 2026-11-19 20:48 CET
- Desktop app: Update Ledung now updates the app too. When the app's windows are hidden it restarts by itself into the new version; with a window in front, the page says "Ledung was updated — restart the window to finish the update" with **Restart window**. Only the window restarts: Ledung and its sessions keep running, and a hidden window comes back hidden. An update that brings a new Electron downloads it at that restart; offline, the app keeps its Electron with the new Ledung when that is safe, otherwise the browser opens and the page says why. Restart Ledung alone never restarts the app. (#408)
- Workflow runs: when a new session takes a step again (a second review or test round), the session it replaces is archived at once instead of staying in the sidebar until the run ends; nothing is deleted. One still working, or waiting on you with a question or prompt, is never archived. The coordinator's "ended" note says it was archived, a message to it resumes it as before, and one resumed that way is not archived again when the run ends. A run chosen on the workflow page now links all its sessions, archived ones marked, and `flow_status` names the earlier rounds' sessions. (#402)

## v3.11 — 2026-11-19 15:36 CET
- A second Ledung window: the new button beside ⚙ at the bottom of the sidebar opens one, and in the desktop app File → New Window, ⌘N on the Mac and Ctrl+N on Windows, does too. Each window has its own view; closing one leaves the others, and closing the last only hides it, as before. In a browser the button opens Ledung in a new tab or window. (#414)

## v3.10 — 2026-11-19 15:26 CET
- A "New computer" card in Waiting for you now goes by itself once that computer is in use, connected to the relay with its own certificate, on every page and in every count; a card for a computer already in use goes at the first start after the update. Through the relay (a phone, or another computer's tab) the card now offers **I added it**, which asks for the passkey or a trusted computer's own screen; Approve stays on the computer itself. (#420)

## Earlier
Before dev builds had a changelog of their own, every change was listed by date: see "Earlier, by date" in [CHANGELOG.md](CHANGELOG.md).
