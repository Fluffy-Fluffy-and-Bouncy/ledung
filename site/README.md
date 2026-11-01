# projectledung.com

The one-page site for Project Ledung. It is a static page: `index.html` and `assets/`, with no build step, no CDNs, web fonts or trackers. It is published at projectledung.com; copying it to the server is a separate, manual step.

## Working on it

Open `site/index.html` in a browser, straight from disk, or serve the folder:

```sh
npx serve site
```

- **Pictures.** The screens of Ledung are drawn in HTML/CSS in `assets/ledung-ui.js` and `assets/ledung-ui.css`, using the app's own colours. Everything on them is invented: no real project, person or ticket. They follow the page's mode (`data-theme="auto"`); `"dark"` or `"light"` pins one. The `phone` and `push` scenes are drawn in a phone-shaped stage, 390 px wide; the push notifications use the app's own words (`web/public/sw.js`), which name the computer and never the item's text.
- **Relay and Remote Control are two things.** The relay is Ledung's own: a phone reaches the page through a relay the user runs or joins with a code (there is no relay run by Project Ledung, so the copy must not suggest one). Remote Control is Claude Code's, in Anthropic's Claude app; it is mentioned, not drawn.
- **The ship** comes from the app. `assets/shipFrames.js` is `web/src/components/shipFrames.ts` with its types stripped, and `assets/ship.js` plays it in every `<pre data-ship="story" data-width="N">`. The stories are `voyage`, `solo`, `busy`, `watch`, `sink`, `fog`, `radiate` and `bar`. After the ship changes in the app, run `node site/regen-ship.cjs` from the repository root. Don't edit `shipFrames.js` by hand. It animates always, also with reduced motion; that is on purpose for now (2026-10-15).
- **Light and dark mode.** `assets/theme.js` follows the visitor's system setting, and the sun/moon button in the top bar switches it and remembers the choice. `?mode=light` or `?mode=dark` forces a mode without remembering it, for screenshots. The page's colours are CSS variables at the top of `index.html`: dark in `:root`, light in `html[data-mode="light"]`.
- **Install section.** The two commands stand as plain text to copy, with the version on npm (1.0.0) and links to npm and GitHub; `assets/terminal.js` plays the same commands in a loop beside them. Update the version there when a new one is published.
- **Footer.** Links to GitHub and npm, and the licence line: AGPL-3.0-only, with Claude Code and the Agent SDK under Anthropic's own terms (the same notice Ledung prints at startup, `src/server/source.ts`).
- **Contact us** goes to `hello@projectledung.com` (Martin, 2026-10-16).

Changes here don't run CI (`site/**` is ignored in `.github/workflows/ci.yml`) and need no CHANGELOG bullet, since they don't change what Ledung does.

Picked by Martin on 2026-10-16 from five mockups ("Night harbour").
