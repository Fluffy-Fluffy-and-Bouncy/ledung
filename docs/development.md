# Developing Ledung

This is for working on Ledung itself, from a clone of the repository. To install and use Ledung, see the [README](../README.md). Before you send a change, read [CONTRIBUTING.md](../CONTRIBUTING.md): outside contributions need a signed contributor license agreement.

The plan and its steps are in [brief.md](brief.md); decisions made since are in [decisions.md](decisions.md); the work of each step is in [steps/](steps/); what changed and when is in [CHANGELOG.md](../CHANGELOG.md), where every PR that changes what Ledung does adds a bullet (the pre-push hook refuses a push of program changes without one). [CLAUDE.md](../CLAUDE.md) has the rules for Claude Code sessions that work on the repository.

## Setup

You need what the README's [Requirements](../README.md#requirements) list, then:

```sh
npm install
npm run check      # type check and tests
```

**Every push runs `npm run check` first.** `npm install` (or `npm ci`) switches on the git hook in `.githooks/pre-push` for the clone and all its worktrees, by setting git's `core.hooksPath`; a failing check stops the push. A push that only deletes a branch, or carries no commits the remote doesn't already have, skips the check. The hook is not switched on outside a git repository, nor when `core.hooksPath` already points somewhere else. `git push --no-verify` skips the check for an emergency; that is the owner's call, never a session's.

Run from a clone, Ledung reads its settings from `ledung.config.local.json` in the repository root (an npm-installed Ledung uses `ledung.config.json` in the user data folder instead). That file is ignored by Git, because it holds project paths, container names and project-specific rules. Copy `ledung.config.example.json` to `ledung.config.local.json` and fill it in. The settings themselves are described in the README's [Config](../README.md#config) and in the example file. Which settings apply at once and which need **Restart Ledung** is kept in one place, `SETTING_RELOAD` in `src/config.ts`.

| Command | What it does |
|---|---|
| `npm run check` | Type check (core and page) and all tests. Run before every commit. |
| `npm run build` | Builds the page into `web/dist`. |
| `npm run release` | Check, build, copy to a new release folder and point the launcher at it. |
| `npm run pack` | Builds the npm package into `dist/ledung-<version>.tgz` (plain JavaScript). |
| `npm start` | Runs Ledung from this folder (development only; use a throwaway config and data folder). |

## Running Ledung from a clone

Ledung runs from a separate copy, never from this folder, so a session can edit Ledung's source without breaking the Ledung it runs in.

```sh
npm run release    # check, build, and copy to <user data>/app/<timestamp>
```

Then start it with `%APPDATA%\Ledung\Ledung.cmd` on Windows, or `ledung.sh` in the user data folder on macOS and Linux. It opens the page in your browser and signs it in.

A running Ledung keeps its release until it is restarted. **Restart Ledung** (Settings → Update & restart) loads the newest release; sessions keep running through it, even mid-turn.

**Update Ledung**, also in Settings → Update & restart, does the same from the page: **Check for updates** fetches `origin/main` in the folder the running release was built from and lists the changelog lines since; **Update Ledung** then runs `git pull --ff-only`, `npm install` and `npm run release` there and restarts. It refuses, and leaves the running Ledung alone, when that folder has uncommitted changes, is not on `main`, can't fast-forward, or a step fails.

For development, `npm start` runs Ledung straight from this folder (use another `port` in a separate config via `LEDUNG_CONFIG`, and `LEDUNG_DATA_DIR` for separate data, if a released Ledung is running too). `npm run build` rebuilds the page. `npm start` runs Ledung in the foreground; `node src/cli.ts` is the `ledung` command, which starts it in the background (log in the data folder's `ledung.log`, stopped with `node src/cli.ts stop`), and `node src/cli.ts --foreground` keeps it in the terminal with Restart Ledung working.

## The npm package

**The package installs exactly the dependency versions Ledung was tested with.** Its `package.json` names the lockfile's versions, and an `npm-shrinkwrap.json` made from this folder's `package-lock.json` pins everything below them, so the Agent SDK, and the Claude Code version it needs, are the ones `npm run check` ran. The shrinkwrap leaves out the Agent SDK's per-platform copies of Claude Code: npm would install all eight of them on every computer. So an npm-installed Ledung has no Claude Code of its own, and `"claudeExecutable": "bundled"` says so; it runs your installed one.

To build the package from this folder: `npm run pack` builds the page, bundles the core, the session host and the `ledung` command to plain JavaScript with esbuild (Node doesn't strip types under `node_modules`), and packs `dist/package/` into `dist/ledung-<version>.tgz`, which `npm install -g ./dist/ledung-<version>.tgz` installs (the `./` matters: without it npm reads `dist/…` as a GitHub repository). The package's own `package.json` leaves out this folder's scripts and devDependencies, and pins the dependencies (above); a `package-lock.json` out of step with `package.json` stops the build. Publishing it, `npm publish ./dist/ledung-<version>.tgz`, is the owner's. The publishing npm account's e-mail is public (`npm view ledung maintainers`), so publish from the account on martin@projectledung.com, the address the package names as its author.

## Layout

| Folder | What it holds |
|---|---|
| `src/host/` | The session host, which keeps a session running while Ledung restarts, and Ledung's connection to it |
| `src/runners/` | How a session's process is started and stopped: locally, or in a container through `docker exec` |
| `src/sessions/` | Driving sessions through the Agent SDK; permission prompts |
| `src/store/` | The SQLite database: sessions, every message, permission decisions |
| `src/server/` | The page's API and live connection, and who may use them |
| `src/platform/` | Everything that differs per operating system |
| `src/shared/` | Types shared by the core and the page |
| `web/` | The page (React, built with Vite) |
| `scripts/` | The release script, the npm package build, the public export's dry run, the setup that switches on the git hooks, the test runner and two benchmarks |
| `relay/` | The relay that lets a phone reach Ledung from anywhere (see its README) |
| `site/` | The one-page site for projectledung.com: static, no build step (see its README) |
| `.githooks/` | The pre-push hook: a push runs `npm run check` first |

## Cross-platform rules

Ledung runs on Windows first, and also on macOS and Linux. Every change follows these rules.

- **Paths.** Build paths with Node's `path` utilities. Never write `\`, `/` or drive letters by hand.
- **User data.** Keep user data in the platform's usual place (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, the XDG folders on Linux), behind one helper.
- **Processes.** Everything about starting and stopping processes stays inside the runners: binary names such as `claude.cmd` versus `claude`, argument quoting, and stopping a whole process tree.
- **Machine measurement.** CPU and memory measurement sits behind one module, with a version per platform.
- **Line endings.** All files use LF; `.gitattributes` enforces this.
- **File names.** Never rely on file names that differ only by case.
- **CI.** GitHub Actions runs `npm run check` and builds and installs the npm package: on Windows for every pull request update and every push to `main`, on macOS once a week and when started by hand. Changes to docs only (`*.md`, `docs/`) or to the site (`site/`) don't start it. CI is the last net, not the first: the pre-push hook running `npm run check` is the gate.
- **No machine details in code.** Hard-coded machine paths and project details belong in config, not in code.

## Keeping it generic

This repository holds nothing specific to a work project: no people, ticket systems or compliance rules. Those go in `ledung.config.local.json`.

`npm run export-public -- --author "Name <email>"` is a dry run of a public copy: it puts the files of one commit (`--ref`, default the current one) into a new folder as a single commit by that author, without local folders such as `.claude/` and `.test/` or local configs, and scans the result for keys, tokens, e-mail and IP addresses and home folders. `--terms <file>` adds words that must not appear, such as names, from a local file that is not committed. It creates no repository online and pushes nothing. A real public export is made with `--author "Fluffy Fluffy and Bouncy <hello@ffbcoop.com>"`.
