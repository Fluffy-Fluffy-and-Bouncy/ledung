# Project Ledung

Ledung is a local program that runs several Claude Code sessions and shows them in one place: the sessions and who started them, every question waiting for an answer, permission requests, token usage and machine load. It serves a web page on localhost, which you can install as an app window from Edge or Chrome.

It is in step 1: one session at a time per project, without VS Code. The plan and its steps are in [docs/brief.md](docs/brief.md); decisions made since are in [docs/decisions.md](docs/decisions.md); the current step is in [docs/steps/](docs/steps/); what changed and when is in [CHANGELOG.md](CHANGELOG.md), where every PR that changes what Ledung does adds a bullet (the pre-push hook refuses a push of program changes without one).

## Requirements

- Node.js 24 LTS or later
- Git
- Claude Code installed ([how](https://code.claude.com/docs/en/setup)) and signed in: Ledung runs your own Claude Code
- Docker Desktop, only for projects that live in dev containers

**Anthropic's software.** Ledung runs Anthropic's Claude Agent SDK and Claude Code. They are installed from npm under [Anthropic's own terms](https://code.claude.com/docs/en/legal-and-compliance) and are not covered by Ledung's license (see [License](#license)). The SDK comes with Ledung's `npm install`. **Sessions run your own installed Claude Code** (`claude` on the PATH, or where its installers put it: `~/.local/bin`, npm's global folder, Homebrew), with your own sign-in. It must be at least the version the SDK was built for (Settings → Claude Code shows both; `claude update` updates it). If it is missing, older, or its version can't be read, a banner says how to install or update it, and sessions don't start until **Check again** finds it. **A project in a container needs Claude Code installed in that container**: Ledung starts the container's own `claude` there and doesn't install it for you.

## Install from npm

**Not published yet**: the `ledung` package is built (`npm run pack`, below) but not on the npm registry. Once it is:

```sh
npm install -g ledung
ledung              # starts Ledung and opens the page, signed in; ledung --no-open doesn't open it
```

The first start creates the user data folder (`%APPDATA%\Ledung` on Windows, `~/Library/Application Support/Ledung` on macOS, `~/.local/share/ledung` on Linux) and a default config in it, `ledung.config.json` (`LEDUNG_CONFIG` points elsewhere). Projects and accounts are added in the page; the other settings are described in `ledung.config.example.json` next to the package's `package.json`. **Restart Ledung** works as with a release, and sessions keep running through it. To update, run `npm install -g ledung` again and press **Restart Ledung**; the page's Update panel says so instead of pulling from git. Sessions run your installed Claude Code, not a program inside the package, so they don't stand in the update's way.

**The package installs exactly the dependency versions Ledung was tested with.** Its `package.json` names the lockfile's versions, and an `npm-shrinkwrap.json` made from this folder's `package-lock.json` pins everything below them, so the Agent SDK, and the Claude Code version it needs, are the ones `npm run check` ran. The shrinkwrap leaves out the Agent SDK's per-platform copies of Claude Code: npm would install all eight of them on every computer. So an npm-installed Ledung has no Claude Code of its own, and `"claudeExecutable": "bundled"` says so; it runs your installed one.

To build the package from this folder: `npm run pack` builds the page, bundles the core, the session host and the `ledung` command to plain JavaScript with esbuild (Node doesn't strip types under `node_modules`), and packs `dist/package/` into `dist/ledung-<version>.tgz`, which `npm install -g ./dist/ledung-<version>.tgz` installs (the `./` matters: without it npm reads `dist/…` as a GitHub repository). The package's own `package.json` leaves out this folder's scripts and devDependencies, and pins the dependencies (above); a `package-lock.json` out of step with `package.json` stops the build. The package is ready to publish (it is no longer marked private); publishing it, `npm publish ./dist/ledung-<version>.tgz`, is the owner's. The publishing npm account's e-mail is public (`npm view ledung maintainers`), so publish from the account on npm@projectledung.com, the address the package names as its author.

## Setup

```sh
npm install
npm run check      # type check and tests
```

**Every push runs `npm run check` first.** `npm install` (or `npm ci`) switches on the git hook in `.githooks/pre-push` for the clone and all its worktrees, by setting git's `core.hooksPath`; a failing check stops the push. A push that only deletes a branch, or carries no commits the remote doesn't already have, skips the check. The hook is not switched on outside a git repository, nor when `core.hooksPath` already points somewhere else. `git push --no-verify` skips the check for an emergency; that is the owner's call, never a session's.

Ledung reads its settings from `ledung.config.local.json` in the repository root. That file is ignored by Git, because it holds project paths, container names and project-specific rules. Copy `ledung.config.example.json` to `ledung.config.local.json` and fill it in.

**Changes to the config apply without a restart**, with a few exceptions. Ledung watches the file and reads it again a moment after it is saved (also by an editor that writes a temporary file and renames it), checked as at start. The settings apply at once, to every session started or resumed after that; running sessions keep what they started with. A shorter `keepToolResultsDays` shrinks old tool output straight away. Needing **Restart Ledung**: `port`, `lan`, `lanSignIn`, `remote`, `relayJoin`, `computers`, `board` and `userName`, which the server, the relay link, the boards and the rest take at start; Settings → Config file and Restart Ledung then say "Restart Ledung to apply: …". A file that isn't valid JSON or has a wrong setting is refused whole: the settings in use stay, and a banner and Settings → Config file say what is wrong (without the file's text). Settings → Config file also shows when the file was last read. Which setting is which is kept in one place, `SETTING_RELOAD` in `src/config.ts`.

**Projects and Claude accounts are added in the page** (**Add project** and **Accounts**, both in Settings: the ⚙ at the bottom left), not in the config: an existing folder on this computer or in a running container, picked with Ledung's folder browser, or a brand-new project (a folder with git, and optionally a private GitHub repository). Each project has one manager and one Claude account. The folder browser shows only folders under `browseRoots` (default: your home folder); new projects go in `projectsFolder` (default: `Projects` in your home folder). Projects still listed under `"projects"` in the config are copied into Ledung once.

**Accounts can also be written in the config file**, under `"claudeAccounts"`, by name, with plain fields: `whatItIsFor` (shown in the page), `signInFolderOnThisComputer` and `signInFolderInContainers`, all optional; `ledung.config.example.json` explains each and has a worked example. Nothing secret goes there. Ledung adds the accounts it doesn't have, at its start and whenever the file changes, and gives an account it has the folders the block names; a problem (a folder another account uses, say) shows in Settings → Accounts, and a wrongly written block is refused like any other config error. Removing an account stays in the page, since it also signs the account out; one still in the block comes back at the next start. Every account's sign-in folder on this computer holds an `ABOUT THIS FOLDER.txt`: whose folder it is and the exact command to sign in to it.

**Signing in.** Ledung never takes, keeps or passes a Claude sign-in token: signing in is done by Claude Code itself (Anthropic's terms allow that, not a product collecting tokens). An account is only a sign-in: each has a sign-in folder, and its sessions get it in `CLAUDE_SECURESTORAGE_CONFIG_DIR`, a Claude Code setting (not in its documentation; the SDK sets it itself) that moves only the sign-in there. Conversations, memory, skills and settings stay in the Claude Code folder every session uses, so moving a project to another account changes only whose plan and limits it uses. You sign in to an account once with Claude Code's own `/login`, using the command the page shows. For a container project, the account's sign-in folder is inside the container (`~/.ledung-accounts/<name>` by default, or a folder you name, which may be a mounted one so the sign-in survives a rebuild) and you sign in there. Ledung asks Claude Code's `claude auth status` whether each is signed in (no tokens spent). Removing an account removes its own sign-in from Claude Code's store (its sign-in file, or its Keychain entry on macOS) here and in every container its projects ran in, skipping a folder another login shares, and leaves the folders. Ledung doesn't use `claude auth logout` for this: in the shared layout it would also clear the account details of the computer's own login. An account can't use Claude Code's default folder, Ledung's own, or another account's. Token accounts from before are moved once, with no new sign-in: the token is put into Claude Code's sign-in store for the account (a file in its sign-in folder, or the Keychain on macOS), checked, and Ledung's copy is deleted; a place added later is signed in with `/login`. That move is removed before Ledung goes public. A login-folder account made before this change keeps its sign-in, but not the conversations, skills and settings it kept in that folder.

**A workflow by default** (optional): if you run your projects under a written process, a `"workflow"` block in the config names its folder, the file a manager reads first (`managerFile`), the file every other session reads first (`sessionFile`), and where each project keeps its own settings for it (`projectConfig`, inside the project folder). Every session started or resumed after that is told to read its file and where the project's config is; **Add project** warns when that config is missing. A project can switch the workflow off or name its own config path in its settings; projects in a container are off unless switched on, since they can't see this computer's folders. Without the block, sessions get no such instructions.

**Several workflows** (optional): a `"workflows"` list in the config holds more, each with a `name` and the same four settings. The single `"workflow"` block, if there is one, comes first and is named `default` (give it a `"name"` to change that). **Add project** and a project's settings then have a **Workflow** list: None, or one of them by name; a new project starts on the first on this computer and on None in a container, and the project-config field and the missing-config warning follow the choice. A manager's `add_project` and `create_project` take `workflow` too (a name, or `"none"`). A project from before keeps the workflow it had; one whose workflow has been taken out of the config follows none until another is chosen. A project added from the page or by a manager stores its workflow's name, so one added on the single block stores `default`: giving that block a `"name"` later drops such projects to none until they choose again.

## Running Ledung

Ledung runs from a separate copy, never from this folder, so a session can edit Ledung's source without breaking the Ledung it runs in.

```sh
npm run release    # check, build, and copy to <user data>/app/<timestamp>
```

Then start it with `%APPDATA%\Ledung\Ledung.cmd` on Windows, or `ledung.sh` in the user data folder on macOS and Linux. It opens the page in your browser and signs it in. The page can run as an app, in a window of its own: in Edge or Chrome, a notice at the top offers **Install as app**, which opens the browser's own install dialog (**Not now** hides the notice in that browser for good); in Safari on macOS it says to use **File → Add to Dock**. **Settings → App** always has the same, or says why this browser can't install the page (plain http on the local network, or a browser that can't install pages). Neither shows once the page runs as an app.

A running Ledung keeps its release until it is restarted. **Restart Ledung** (in Settings, the ⚙ at the bottom left of the page) loads the newest release; sessions keep running through it, even mid-turn. Closing Ledung (Ctrl+C, or closing its console window) stops its sessions; open one and press **Resume** to continue it.

**Update Ledung**, also in Settings, does the same from the page: **Check for updates** fetches `origin/main` in the folder the running release was built from and lists the changelog lines since; **Update Ledung** then runs `git pull --ff-only`, `npm install` and `npm run release` there and restarts. It refuses, and leaves the running Ledung alone, when that folder has uncommitted changes, is not on `main`, can't fast-forward, or a step fails.

Each session runs in a small **session host** (`src/host/`), a separate process that owns Claude Code and keeps it running while Ledung restarts. If Ledung crashes and doesn't come back within 3 minutes, the hosts stop their sessions themselves. Host logs are in `<user data>/hosts/`.

### From another computer on the local network

Set `"lan"` in the config to this computer's address on the local network (for example `"192.168.1.20"`), and Ledung also listens there, and answers to the computer's name. `"lan": true` listens on every network the computer is on, including VPNs; prefer the single address. By default other computers sign in once with a link Ledung prints; `"lanSignIn": false` drops that, so **anyone on that network can use Ledung**, and through it run commands on this computer. Only for a network you alone use. The connection is plain HTTP. Windows Firewall must allow incoming connections on the port.

### From anywhere, through a relay

A relay ([relay/README.md](relay/README.md)) lets your phone reach Ledung from anywhere, end to end encrypted. If whoever runs the relay sends you a **join code**, paste it in Settings → Remote → **Join with a code**: Ledung makes its own secret and certificate account, joins and connects at once, with no config edit and no restart (its settings are kept in the data folder's `remote` folder). Once the relay's admin has approved it, Ledung gets its certificate within a minute; then pair your phone in Settings → Devices. **Leave this relay** undoes it. A `"remote"` block in the config file does the same by hand, and while it is there it wins: Join and Leave are off. If you run a relay yourself, Settings → Relay invites other people's computers to it (relay/README.md, Invite a computer).

`"maxWorkingSessions"` (default 10) is how many sessions may work at the same time; above it, work waits in line before its turn starts. Managers don't count. It can be changed live in the Machine panel, and a waiting session can be started at once with **Start now**.

`"remoteControl"` (default true): each manager turns on Claude Code's Remote Control after its first reply, so it shows in the Claude app on a phone as "<project> lead", and its page shows the link. It comes back when the manager is resumed or Ledung restarts, and goes off when the manager stops. Other sessions never get it. `false` turns it off for every manager.

`"claudeExecutable"` (default `"installed"`): the Claude Code sessions on this computer run. `"installed"` is your own `claude`, found on the PATH or in the usual install folders (the native installer's `~/.local/bin`, npm's global folder, Homebrew's); a full path names another one. Either must be at least the version the Agent SDK was built for; one that is missing, older, or whose `claude --version` can't be read is never run: a banner says how to install or update it, and a session start is refused with the same words. `"bundled"` runs the copy of Claude Code the Agent SDK installs with Ledung instead, only when set here, for testing or a computer where Claude Code can't be installed; not in a Ledung installed from npm, whose package leaves that copy out. **Settings → Claude Code** shows what new sessions run (path and version) and what each running session was started with; a running session keeps its program until it stops, and a resume looks again. Container projects always run the container's own `claude`.

`"windowsShell"` (default `"bash"`): the shell a `!` line in the message box runs in on Windows. `"bash"` is Git Bash, as Claude's Bash tool uses (found next to `git`, or at `CLAUDE_CODE_GIT_BASH_PATH`); `"powershell"` is Windows PowerShell. On macOS and Linux it is always bash, and in a container project the container's own shell.

For development, `npm start` runs Ledung straight from this folder (use another `port` in a separate config via `LEDUNG_CONFIG`, and `LEDUNG_DATA_DIR` for separate data, if a released Ledung is running too). `npm run build` rebuilds the page.

### Elevated commands on Windows

A session that needs administrator rights runs the command through an elevation tool: [gsudo](https://github.com/gerardog/gsudo) (`gsudo <command>`, the output comes back to the session), Windows 11's own `sudo`, or `Start-Process <program> -Verb RunAs`. Each raises Windows' UAC prompt on the PC's desktop, so it works only when you are at the PC; from a phone the command waits for a click until its time limit. Such a call passes two checks: Ledung's permission prompt first (gsudo, sudo, `-Verb RunAs` and `runas` are among the suggested sensitive patterns, so they are asked in every permission mode, also through the PowerShell tool), then UAC. The prompt says it raises UAC and offers **Deny: not at the PC**, and while the command runs the status line says it may be waiting for UAC on the PC. **Stop** may not end what runs as administrator: a process that is not elevated is not allowed to end one that is, so close it on the PC.

- **Never run Ledung or a session host as administrator.** Every session, MCP server and hook would then be administrator without any UAC prompt; Ledung's permission checks are Claude Code rules, not Windows security.
- **Never turn gsudo's credential cache on** (`gsudo cache on`, or a `CacheMode` of `Auto`). Later elevations would skip UAC, so any session could elevate without anyone at the PC. Keep `CacheMode` at `Explicit` (the default) or `Disabled`.

### Session profiles

By default a session gets everything your own Claude Code setup has: all plugins (with their skills and the text their hooks add at start), all MCP servers and the claude.ai connectors. That costs tokens on every turn. A **profile** in the config says what a session gets instead; `ledung.config.example.json` has `slim`, which keeps only Ledung's tools and Claude Code's built-ins (on one machine, 24.6k instead of 31.0k tokens at a fresh session's first prompt).

- `"mcpServers"`: `"all"` (default), `"none"` (only Ledung's), or servers of its own (`{ "name": { "command": …, "args": […] } }`, or `{ "type": "http", "url": … }`), which also leaves out all others.
- `"plugins"`: `"all"` (default), `"none"`, or the plugin ids to keep (`"name@marketplace"`, as in your `enabledPlugins`). They are turned off for the session only; your settings files are not changed.
- `"disallowedTools"`: tools the session doesn't get, such as `"Workflow"`.
- `"userSettings": false`: your user settings file is not read at all. That also drops its allow rules, so expect more permission prompts. It also skips everything else personal in `~/.claude`: your `CLAUDE.md` (including any `## Compact Instructions`; put those in the project's CLAUDE.md instead), your own slash commands, skills and agents (tested on Claude Code 2.1.295).
- `"settings"`: Claude Code settings written in the profile itself, such as `{ "syncClaudeAiSkills": false }` or `{ "permissions": { "allow": ["Bash(deploy)"] } }`, in the same settings layer as `"settingsFile"`, whose contents win where both set the same key. That merge is by top-level key only: a settings file with any `"permissions"` replaces the profile's whole `"permissions"`, its allow rules included. Neither `"disallowedTools"` nor deny and ask rules can reach Ledung's own tools, by name or by a wildcard such as `mcp__*`.
- `"settingsFile"`: a Claude Code settings file inside the project folder, such as `".claude/lean-settings.json"`, that the session gets as its own settings layer (the highest one you control, like `--settings`), for example a `model`, `claudeMdExcludes` to leave out some CLAUDE.md or rule files, or `skillOverrides` to turn skills off. The path is relative to the project folder (inside the container for a container project) and can't leave it. Ledung reads it at every start and resume, so edits count from the next one; if it is missing or isn't JSON, the session doesn't start and says which file. With `"plugins"` set too, its plugin choice is added on top of the file's `enabledPlugins`. The model: one chosen for a single session (picked when starting, or a manager's `start_session`) wins; then the file's `model`; then the project's default model (for a manager: the project's model for its manager first); then none, so Claude Code uses the model in the project's own Claude settings, or its default. Ledung leaves the project's default out when the file names a model, on a resume too.

`"pluginsOff"` in the config lists plugin ids turned off in every Ledung session whatever its profile, wherever that plugin is installed; an id the computer doesn't have is skipped, so the same list works on every computer.

**Profiles from the workflow.** A workflow (see `"workflow"` in `ledung.config.example.json`) can ship the profiles its sessions use: `"profilesFile"` in its block names a JSON file inside the workflow's folder, with `"version": 1`, `"profiles"` (the fields above), optional `"defaultProfiles"` (`{ "manager": …, "session": … }`) and optional `"pluginsOff"`; keys starting with `$` are comments. Since the file comes from the workflow rather than from you, a profile's `"settings"` there may only hold `syncClaudeAiSkills`, `enableArtifact`, `skillOverrides`, `claudeMdExcludes`, `model`, and `permissions` with `allow` and `deny`; any other key (such as `hooks`, `env` or `permissions.defaultMode`) makes the file invalid. Settings → Session profiles lists each profile's allow rules and the MCP servers it runs. Ledung reads it whenever a session of a project following that workflow starts or resumes, so a change to the workflow counts from the next session. This computer's config is laid over it, later wins: built-in `"full"`, the workflow's file, the config, the project's settings, then `start_session`'s `profile`. A profile in the config with the same name as one of the workflow's changes it field by field (a list replaces the workflow's list); a new name is this computer's own. The config's `"defaultProfiles"` wins per role, and both `"pluginsOff"` lists apply. If the file is missing or isn't valid, those projects get only the computer's own profiles, Settings → Session profiles shows a warning naming the file, those projects' sessions are told in their instructions at every start and resume (so a manager says so), a manager's `start_session` reply adds it, and a start that needs one of the workflow's profiles is refused saying why. Settings → Session profiles lists every profile with where it comes from: the workflow, this computer, or the workflow's changed on this computer. Chats and projects that follow no workflow get the computer's profiles only.

Each project's settings in the page choose a profile for its manager and one for its sessions; `"defaultProfiles"` in the config covers projects that choose none; without either, a session gets `"full"`, which is everything. A manager can name another profile in `start_session`, and **+ Session** in the page asks which profile when the config has more than `"full"`. A session keeps its profile when it is resumed, and the page shows it next to the model. Ledung's own tools are there under every profile.

### Workflow nudges

A workflow can remind its sessions of a rule at the moment it applies, such as clearing at a context size. `"nudgesFile"` in its block names a JSON file inside the workflow's folder, with `"version": 1` and `"nudges"`, a list of `{ "role": "manager" | "session", "titlePrefix"?: "...", "contextAtLeast": 200000, "text": "..." }`; keys starting with `$` are comments. On every prompt to a session of a project following that workflow, each nudge for the session's role (and, when it names one, whose title prefix starts the session's title) whose `contextAtLeast` the session's context has reached adds its `text` on its own line under "Your context: … tokens."; once the context is under it again, after a clear, the line is gone. The file is read again whenever it changes, so an edit counts from the next prompt. If it is missing or isn't valid, the session is told so on its next prompt, and again if the problem changes (a manager is asked to report it); no nudges are shown until it is fixed. The thresholds and words are the workflow's: Ledung has none of its own, and without the key prompts are unchanged. Usage → Sessions shows each session's context in the same "142k of 1000k" form.

### Message board

Managers can post to managers in other people's Ledungs on a shared board, a GitHub repository (see [docs/steps/message-board.md](docs/steps/message-board.md)). It is set **per project**, in the project's settings in the page: on or off (off by default), the board repository (`owner/name`), who may post to that project's manager (picked from the people with access to the repository, or typed), the channels it follows, and whether it is the **front desk** that gets posts addressed to just `@<your login>`. Several projects may share a repository, or each have its own; each repository is polled once. Everyone with access to a repository can read every post on it, so give a sensitive project a repository of its own. All boards post as this computer's `gh` login (`gh auth login`). The config's `"board"` block only holds the limits (`pollSeconds`, `postsPerHour`, `wakesPerThreadPerHour`, `burstSeconds`); a block from before with `repo`, `allow` and `frontDesk` is moved into the projects that have the board on (and the front-desk project) once, on the next start.

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
| `scripts/` | The release script, the npm package build, the one-time data move, the public export's dry run, and the setup that switches on the git hooks |
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
- **CI.** Off for now (2026-10-29): GitHub Actions won't start jobs while the org's payments or spending limit are the problem, so the workflow runs only when started by hand. The pre-push hook running `npm run check` is the gate; run it before you push.
- **No machine details in code.** Hard-coded machine paths and project details belong in config, not in code.

## Keeping it generic

This repository holds nothing specific to a work project: no people, ticket systems or compliance rules. Those go in `ledung.config.local.json`.

`npm run export-public -- --author "Name <email>"` is a dry run of a public copy: it puts the files of one commit (`--ref`, default the current one) into a new folder as a single commit by that author, without local folders such as `.claude/` and `.test/` or local configs, and scans the result for keys, tokens, e-mail and IP addresses and home folders. `--terms <file>` adds words that must not appear, such as names, from a local file that is not committed. It creates no repository online and pushes nothing. A real public export is made with `--author "Fluffy Fluffy and Bouncy <hello@ffbcoop.com>"`.

## License

Ledung is dual-licensed. It is free software under the [GNU Affero General Public License, version 3 only](LICENSE) (`AGPL-3.0-only`), with an additional permission (in the same file) to use and ship it together with Anthropic's Claude Agent SDK and Claude Code, which have their own terms. It is also available under a commercial license, for use without the AGPL's conditions: see [COMMERCIAL.md](COMMERCIAL.md). Copyright Martin Strålenhielm and Simon Rasmussen.

The AGPL asks that people who use Ledung over a network can get its source: **Settings → About** shows the running version and a **Source** link to it.

Contributions need a contributor license agreement: see [CONTRIBUTING.md](CONTRIBUTING.md).
