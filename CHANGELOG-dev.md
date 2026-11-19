# Ledung changelog: dev builds

Every dev build (a version X.Y), newest first: what Settings → About → Update channel → Dev updates to. Each
build has one heading with its version and when it was published, then terse `- ` bullets, one per change, each
ending with its issue `(#12)` or `(no issue)`. Public releases, which fold the dev builds since the last one
together, are in [CHANGELOG.md](CHANGELOG.md). Online: https://projectledung.com/dev-changelog

**Don't edit this file.** A pull request writes its bullets in `docs/changes/<issue>.md`
([docs/changes/README.md](docs/changes/README.md)); `npm run publish:dev` and `npm run publish:public` fold them in
here under the version they publish, and push the result to main.

## v3.12 — 2026-11-19 20:48 CET
- Desktop app: Update Ledung now updates the app too. When the app's windows are hidden it restarts by itself into the new version; with a window in front, the page says "Ledung was updated — restart the window to finish the update" with **Restart window**. Only the window restarts: Ledung and its sessions keep running, and a hidden window comes back hidden. An update that brings a new Electron downloads it at that restart; offline, the app keeps its Electron with the new Ledung when that is safe, otherwise the browser opens and the page says why. Restart Ledung alone never restarts the app. (#408)
- Workflow runs: when a new session takes a step again (a second review or test round), the session it replaces is archived at once instead of staying in the sidebar until the run ends; nothing is deleted. One still working, or waiting on you with a question or prompt, is never archived. The coordinator's "ended" note says it was archived, a message to it resumes it as before, and one resumed that way is not archived again when the run ends. A run chosen on the workflow page now links all its sessions, archived ones marked, and `flow_status` names the earlier rounds' sessions. (#402)

## v3.11 — 2026-11-19 15:36 CET
- A second Ledung window: the new button beside ⚙ at the bottom of the sidebar opens one, and in the desktop app File → New Window, ⌘N on the Mac and Ctrl+N on Windows, does too. Each window has its own view; closing one leaves the others, and closing the last only hides it, as before. In a browser the button opens Ledung in a new tab or window. (#414)

## v3.10 — 2026-11-19 15:26 CET
- A "New computer" card in Waiting for you now goes by itself once that computer is in use, connected to the relay with its own certificate, on every page and in every count; a card for a computer already in use goes at the first start after the update. Through the relay (a phone, or another computer's tab) the card now offers **I added it**, which asks for the passkey or a trusted computer's own screen; Approve stays on the computer itself. (#420)

## Earlier
Before dev builds had a changelog of their own, every change was listed by date: see "Earlier, by date" in [CHANGELOG.md](CHANGELOG.md).
