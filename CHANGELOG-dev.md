# Ledung changelog: dev builds

Every dev build (a version X.Y), newest first: what Settings → About → Update channel → Dev updates to. Each
build has one heading with its version and when it was published, then terse `- ` bullets, one per change, each
ending with its issue `(#12)` or `(no issue)`. Public releases, which fold the dev builds since the last one
together, are in [CHANGELOG.md](CHANGELOG.md). Online: https://projectledung.com/dev-changelog

**Don't edit this file.** A pull request writes its bullets in `docs/changes/<issue>.md`
([docs/changes/README.md](docs/changes/README.md)); `npm run publish:dev` and `npm run publish:public` fold them in
here under the version they publish, and push the result to main.

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
