# Ledung changelog: dev builds

Every dev build (a version X.Y), newest first: what Settings → About → Update channel → Dev updates to. Each
build has one heading with its version and when it was published, then terse `- ` bullets, one per change, each
ending with its issue `(#12)` or `(no issue)`. Public releases, which fold the dev builds since the last one
together, are in [CHANGELOG.md](CHANGELOG.md). Online: https://projectledung.com/dev-changelog

**Don't edit this file.** A pull request writes its bullets in `docs/changes/<issue>.md`
([docs/changes/README.md](docs/changes/README.md)); `npm run publish:dev` and `npm run publish:public` fold them in
here under the version they publish, and push the result to main.

## v3.11 — 2026-11-19 15:36 CET
- A second Ledung window: the new button beside ⚙ at the bottom of the sidebar opens one, and in the desktop app File → New Window, ⌘N on the Mac and Ctrl+N on Windows, does too. Each window has its own view; closing one leaves the others, and closing the last only hides it, as before. In a browser the button opens Ledung in a new tab or window. (#414)

## v3.10 — 2026-11-19 15:26 CET
- A "New computer" card in Waiting for you now goes by itself once that computer is in use, connected to the relay with its own certificate, on every page and in every count; a card for a computer already in use goes at the first start after the update. Through the relay (a phone, or another computer's tab) the card now offers **I added it**, which asks for the passkey or a trusted computer's own screen; Approve stays on the computer itself. (#420)

## Earlier
Before dev builds had a changelog of their own, every change was listed by date: see "Earlier, by date" in [CHANGELOG.md](CHANGELOG.md).
