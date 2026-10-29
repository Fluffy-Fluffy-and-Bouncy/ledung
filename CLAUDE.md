# Project Ledung — notes for Claude sessions

Ledung runs several Claude Code sessions and shows them in one web page. You may well be running inside it: Ledung can be developed from a Ledung session. Read [docs/brief.md](docs/brief.md) for the goal and the plan, [docs/decisions.md](docs/decisions.md) for decisions made since, and [docs/steps/](docs/steps/) for the current step. Open work is on the GitHub board (https://github.com/orgs/Fluffy-Fluffy-and-Bouncy/projects/1), as issues with one milestone per step.

Personal preferences and machine details, if any, are in `CLAUDE.local.md` next to this file (not committed).

## Working on the project

- **Decisions are recorded** in `docs/decisions.md` with their date. Issues waiting on a decision carry the `decision-needed` label.
- **Every PR that changes what Ledung does adds its bullet to [CHANGELOG.md](CHANGELOG.md)**, under today's date, in the format the file's header gives. The pre-push hook refuses a push that changes `src/`, `web/` (not `web/dist/`) or `scripts/` without one; a commit trailer `Changelog: none` is for changes with nothing user-facing (tests, refactors), and a reviewer checks it is honest.
- **Keep the repository generic.** Nothing about a particular work project (people, tickets, compliance rules, container names) goes in the repository; it belongs in `ledung.config.local.json`, which is not committed.
- **Screenshots are taken in dark mode**, not light mode; add a light one only when the change is about light mode itself (Martin, 2026-10-20: "When we take screenshots, take them in dark mode, not lightmode.").
- **Ledung is independent of the projects it runs.** Don't use, inspect or design around the user's other projects when working on Ledung; develop and test with throwaway projects and containers, so Ledung works in any environment.

## Running Ledung without breaking the one you are in

- Ledung runs from a release copy in the user data folder (`%APPDATA%\Ledung\app\<timestamp>` on Windows; see the README), never from this folder. **Never edit files in the user data folder**; change the source here and run `npm run release`.
- A release is picked up when the person using Ledung presses **Restart Ledung**. Sessions survive the restart (each runs in a session host, `src/host/`), so a release never cuts you off. Don't restart or stop Ledung yourself.
- **Never stop processes broadly.** Ledung, its launcher and every session host are `node` processes; `claude` processes include your own. When cleaning up after a test, stop the test Ledung by the process listening on its port, and its hosts by their command line, which contains the test's data folder. A test Ledung's own command line does not contain that folder (it is in the environment), so a filter on the folder name misses it.
- To try Ledung for real, start a throwaway copy with its own config, data and port, so it doesn't touch the real one:
  `LEDUNG_CONFIG=<temp>/config.json LEDUNG_DATA_DIR=<temp>/data node src/main.ts --no-open` (port set in that config, e.g. 4396). Read the sign-in token from `<temp>/data/auth-token`; API calls need the `ledung_auth` cookie and, for changes, an `Origin` of `http://127.0.0.1:<port>`. Use Haiku for test sessions.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Type check (core and page) and all tests. Run before every commit. |
| `npm run build` | Builds the page into `web/dist`. |
| `npm run release` | Check, build, copy to a new release folder and point the launcher at it. |
| `npm run pack` | Builds the npm package into `dist/ledung-<version>.tgz` (plain JavaScript). Never `npm publish`: that is the owner's. |
| `npm start` | Runs Ledung from this folder (development only; use a throwaway config and data folder). |

CI runs on the public repository `Fluffy-Fluffy-and-Bouncy/ledung` (Martin, 2026-10-29, question #487; it had run by hand only on the private one, question #433): Windows on every PR update and push to `main`, macOS weekly and by hand, nothing for docs-only or site-only changes. CI is the last net, not the first: `npm run check` before every push stays the local gate. The pre-push hook (`.githooks/pre-push`, switched on by `npm install`) runs it and stops a failing push; `git push --no-verify` is the owner's call, never a session's.

## Code

- **TypeScript run directly by Node 24** (type stripping), no build step for the core: only erasable syntax (no enums, no parameter properties), and relative imports end in `.ts`.
- Follow the cross-platform rules in the [README](README.md): paths through `path`, user data through `src/platform/paths.ts`, everything about processes inside the runners and the host.
- Tests use `node:test` (`test/*.test.ts`). Security rules (`test/server-security.test.ts`), file access (`test/files.test.ts`) and the host (`test/host.test.ts`) are covered; keep them that way when changing those parts.
- Comments explain why, briefly, and point to the finding or decision behind a rule (for example "spike finding 2").
- Database changes are new entries in `MIGRATIONS` (`src/store/database.ts`); never edit an existing one.

## Rules that exist for a reason

- **Never offer "bypass permissions".** Production, personal-data and similar sensitive actions must always be able to reach the person using Ledung (brief section 5).
- **Sessions must not inherit `LEDUNG_*` settings** (`sessionEnv` in `src/runners/runner.ts`); otherwise a Ledung started inside a session uses the real config and data.
- **The page and API stay locked down:** Host check, sign-in cookie, Origin check on changes and the live connection, no embedding. The local network is opened only through the config (`"lan"`, `"lanSignIn"`).
- **Files are shown read-only and only from inside the session's project folder** (`src/sessions/files.ts`).
- **The session host stays small and changes rarely:** a running session keeps the host it started with.
