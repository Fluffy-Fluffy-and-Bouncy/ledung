# The desktop app (epic #357)

Ledung gets a desktop app: a small Electron program in `desktop/` that shows Ledung's page in a window of its own. The
core does not change shape: the app loads `http://127.0.0.1:<port>/` like a browser, so the Host check, the sign-in
cookie, the Origin check and "no embedding" apply as they do to any browser. The decision is in
[decisions.md](../decisions.md), 2026-11-17. This file keeps what the research and the two spikes found, shortened,
so the later parts of the epic (and FFBuddha) can read it on `main`; the full reports stayed on magto-mini.

## Why an app at all

The research (2026-11-17) counted about 45 places where a browser tab limits Ledung. The ones that decided it:

- passkeys don't work on `127.0.0.1`, and computer tabs need frames the browser restricts;
- a background tab is throttled, and with the tab closed no notification can arrive;
- the browser keeps ⌘W, ⌘O and Ctrl+Tab for itself;
- cookies on `127.0.0.1` are shared across ports, so two Ledungs clash (#52), and the Safari Dock app loses its
  sign-in (#84).

Electron was picked over Tauri 2 after both were spiked side by side (Martin, 2026-11-17 12:50: "Ok, then we go with
electron!").

## Electron spike, macOS (magto-mini, Electron 45.3.3, Node 24.22.3, unchanged core at `64186963`)

| Check | Result |
|---|---|
| Core as a child process | Works unchanged on Electron's Node: `.ts` type stripping and `node:sqlite` both run; ready in 315–420 ms. |
| Sign-in without the token link | `ledung_auth=<token>` set with `session.cookies.set` (httpOnly, SameSite strict) before loading: `GET /api/state` → 200, no token in any URL. A session with no cookie gets 401. The core swaps it for a browser cookie of its own and logs `Browsers: "Chrome on macOS" signed in.` |
| Notifications with the window hidden | The page itself raised the permission notification 2.6 s after the prompt. macOS refused to show it: the unsigned app was never allowed notifications (a person must allow it once). |
| Timers when hidden | `backgroundThrottling: false` keeps hidden timers 5–7× faster than the default; macOS still coalesces ~1.5–2× with the display asleep. The page then counts as visible while hidden. |
| ⌘W, Ctrl+Tab, ⌘O | An app menu with those accelerators gets them (injected keys); real keypresses need a person at the keyboard. |
| Second view | A second `WebContentsView` with its own partition showed a second Ledung; the CSP `frame-ancestors 'none'` and `X-Frame-Options: DENY` arrived untouched. |
| Memory | ~410 MB for the shell with one view, plus ~170 MB for a core it starts; ~120 MB per further view. |
| Surprise | A Claude Code session **inherited `ELECTRON_RUN_AS_NODE`** when the core ran on Electron's binary (#361). |

## Electron spike, Windows (Martin's PC, Windows 11, Electron 45.3.3)

5/5 checks passed. `backgroundThrottling: false` keeps timers at full speed and the page `visible`. A notification
fired 13–14 ms after a permission prompt, even after 400 s hidden or minimised. Working set ~320 MB with one view,
~435 MB with two.

## Choices made for the epic (Martin, 2026-11-17, Ledung question #341, the draft's recommendations)

1. These findings live here, on `main`.
2. Electron is installed by `desktop/package.json`, not the root, so the root `npm ci` downloads no Electron.
3. The app attaches to the running Ledung (D1, #358); starting one (D5, #362) runs the installed `ledung` command,
   never a second core from the clone. The #353 tray stays the only tray.
4. A changelog bullet for each part a person sees, though the pre-push hook does not ask for one under `desktop/`.
5. CI skips `desktop/`-only changes; the app is tried by hand until it ships.
6. Throttling stays off when D2 (#359) turns it off; the page's polling while hidden is accepted for now.
7. The core always runs on plain Node; `sessionEnv` drops `ELECTRON_*` (D4, #361).
8. The app is TypeScript run as is, like the repo (Electron 45's Node strips types; checked in D1).

## Parts

D1 #358 window that attaches · D2 #359 app behaviour (close hides, one instance, shortcuts, throttling) · D3 #360
notification click brings the window forward · D4 #361 keep `ELECTRON_*` out of sessions · D5 #362 start Ledung when
none runs · D6 #363 name the app in Settings → Devices.

Out of scope for the epic: signing, notarising, auto-update, installers, the npm package, passkeys in the app,
computer tabs as top-level views, a tray of the app's own, Linux.
