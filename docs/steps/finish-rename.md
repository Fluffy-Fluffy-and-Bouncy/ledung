# Finish the rename to Project Ledung

Oct 12, 2026 · **Approved by Simon on 2026-10-12** (question #23): "Approve all as recommended". Decision 7 left open; the rename's row in `docs/decisions.md` states the facts (renamed by Martin in commit `550f259`, taken in by Simon). The rename of Oct 11 (commit `550f259`) changed the code, the page and the docs, and left the old names working: the `Fleet` data folder, `fleet.db`, `fleet.config.local.json`, `FLEET_*` settings and the `fleet` tool server for sessions started before it. This step finishes the job everywhere except Simon's source folder, `Documents\Fleet Manager`, which keeps its name (it is local only, and Claude Code's memory and transcripts for this project are filed under that path). Decided by Simon on 2026-10-12: the GitHub repository `FFBuddha/fleet` becomes **`FFBuddha/Project-Ledung`**.

**Done when:** the repository, the remotes and the links use the new name; Ledung on this PC runs from `%APPDATA%\Ledung` with `ledung.db` and `ledung.config.local.json`, and starts from `Ledung.cmd`; the project shows as "Manager: Project Ledung"; Magto knows what to do on their side; and the only "fleet" left in the repository is either the old-name fallback (until a later decision removes it) or the ship's fleet of boats.

## What it delivers

- **GitHub under the new name**: `FFBuddha/Project-Ledung`, with old links, clones and pushes still working through GitHub's redirect.
- **Docs that are right**: the folder-name slip in `docs/decisions.md` fixed, the issue link updated, the rename itself recorded as a decision, and README's "Coming from Fleet" telling the steps that actually work.
- **One safe way to move the data folder**: a small script, run once with Ledung closed, that moves `Fleet` to `Ledung` and fixes every stored path. The same script for this PC, Magto's install, macOS and Linux.
- **The project record renamed** from `fleet` to "Project Ledung", so its manager shows as "Manager: Project Ledung" (decided by Simon, 2026-10-12).
- **A date for dropping the old names**, as a separate decision once every install has moved.

## How it works

### 1. GitHub

- **Renaming the repository.** GitHub keeps redirecting the old address (web pages, issue and PR links, `git clone`, `git fetch` and `git push`) to the new one. The redirect lasts until someone creates a new repository called `FFBuddha/fleet`, so that name should never be reused. Issues, milestones, labels, the project board, Actions and their history all move with the repository. Only the owner can rename it: Simon, either under the repository's **Settings → General → Repository name**, or by letting a session run `gh repo rename project-ledung -R FFBuddha/fleet` (this changes something outside the PC, so it needs Simon's explicit OK).
- **Our clone.** Pushes keep working through the redirect, but the remote should say the real name: `git remote set-url origin https://github.com/FFBuddha/Project-Ledung.git` in `Documents\Fleet Manager`.
- **Magto** (a collaborator who pushes to `main`) runs the same `git remote set-url` in their clone. Nothing breaks if they forget, as long as the redirect holds. If they run Ledung themselves, they also do the data folder move (section 3) once they are on a release that has the script.
- **The board** (https://github.com/orgs/Fluffy-Fluffy-and-Bouncy/projects/1) moved to the organisation on 2026-10-13 (the old user board is kept for now). Its title should become "Project Ledung" if it says Fleet (not checked: reading it was blocked in this session). Simon changes it in the board's settings, or a session with `gh project edit 2 --owner FFBuddha --title "Project Ledung"` and Simon's OK. The repository's description on GitHub, if it says Fleet, is changed in the same place as the name.
- **Links in the repository.** Only one full link has the old name: `docs/decisions.md:43` (`https://github.com/FFBuddha/fleet/issues`). The board link in `CLAUDE.md:3` and `docs/decisions.md:11` doesn't change. Mentions like "issue #16" are relative and stay. README has no link to the repository.
- **CI.** `.github/workflows/ci.yml` doesn't name the repository and there is no badge, so nothing changes.
- **`package.json`.** Its `name` is already `ledung`. It has no `repository` field, and none is needed: the package is private and never published. Add one only if wanted (decision 2).
- **PR links stored in sessions** (`sessions.pr`) keep the old address and work through the redirect; new ones get the new address. Nothing to change.

### 2. The slip in `docs/decisions.md`

Line 10 says the repository is in `Documents\Ledung Manager`. That is the rename's search and replace: the folder is `Documents\Fleet Manager` and stays so. The row is rewritten to say: the repository is `FFBuddha/fleet`, renamed `FFBuddha/Project-Ledung` on 2026-10-12; where it is cloned, and under what folder name, is up to each person; on Simon's PC it is `Documents\Fleet Manager`, chosen with a space to test path quoting, and the name is local and free. Two new rows are added:

- **2026-10-11**: Fleet is renamed Project Ledung (display name "Project Ledung", "Ledung" in prose and `ledung`/`LEDUNG_` in identifiers), with the old names still honoured. This is not in the table yet. Who decided it should be stated by Simon (the commit is Martin's).
- **2026-10-12**: the repository becomes `FFBuddha/Project-Ledung`; the source folder keeps its name; and whatever Simon decides from this proposal.

The same search and replace left one more slip: `docs/steps/projects-and-accounts.md:23` lists the projects in the config by name, as "ledung" and two others, but the project was called `fleet` then (and is still). It also names two of Simon's other projects, which the "keep the repository generic" rule asks us not to do. Rewrite it as "the three projects in the config file today".

### 3. Moving the data folder

#### What is in `%APPDATA%\Fleet` and where absolute paths are stored

Read on this PC (read only), and in the code:

| What | Holds a path? | After the move |
|---|---|---|
| `fleet.db` (+ `-wal`, `-shm`) | Rows with paths: `sessions.cwd` (project folders, unaffected) and `accounts.config_dir`, the login folder of a "folder" account, by default `<data>\accounts\<name>` (`src/accounts/store.ts:56`). On this PC `accounts\` holds only a token file, so probably no folder account; the database itself could not be read in this session. | Renamed `ledung.db`. `accounts.config_dir` values that start with the old folder are rewritten. |
| `current.json` | `dir`: the release to run, `...\Fleet\app\20261012-123233`. `config`: `...\Fleet Manager\fleet.config.local.json`. `source`. | `dir` and `config` rewritten. Without this the launcher can't start Ledung at all. |
| `launcher.mjs` | Reads `current.json` next to itself (`here`); no stored path. | Moves with the folder. |
| `Fleet.cmd`, `Ledung.cmd` | `%~dp0launcher.mjs`, relative. | `Fleet.cmd` removed; `Ledung.cmd` stays. |
| `app\<timestamp>` (6 releases; the release script keeps 3, the others are still in use) | No stored paths inside, but running session hosts run `claude.exe` and `host.ts` from them. | Move with the folder. |
| `hosts\<id>.json` and `.log` | `command` (`...\Fleet\app\<release>\...\claude.exe`), `logFile`, `pipe`. Four records: two with `ledung-host-` pipes, two with `fleet-host-` pipes started Oct 10, i.e. **two sessions from before the rename may still be running** (process state not checked). | With every host ended (below), the records are stale and are removed. |
| `accounts\*.token` | No path. | Moves with the folder. |
| `auth-token` | No path. | Moves with the folder; the page's sign-in still works. |
| `resume-after-restart.json` | A session id, dated Oct 10. Nothing in the current code reads or writes it. | Removed. |
| `fleet.config.local.json` | Not in the data folder: it is in the source folder (`appDir()` of the source, `src/config.ts:102`) and `current.json` points to it. | Renamed `ledung.config.local.json` in `Documents\Fleet Manager`; `current.json` rewritten. |

Not found anywhere: pipe names don't contain the folder (`src/host/protocol.ts:52`); the `ledung` tool server is in-process, not an MCP config file; the hooks are passed in code, not in a Claude Code settings file. Claude Code's own transcripts are filed by project folder, not by Ledung's data folder, so resuming sessions works after the move. **Not checked** (reading them was blocked in this session): desktop and Start menu shortcuts, the Startup folder and the Run key, and Task Scheduler. Simon checks for anything pointing at `Fleet\Fleet.cmd` and points it at `Ledung\Ledung.cmd`.

#### Why the folder can't simply be renamed while Ledung runs

- On Windows a folder can't be renamed while any file inside it is open. Every running session's `claude.exe` runs from `Fleet\app\<release>`, Ledung keeps `fleet.db` open, and the launcher's console may have the folder as its current folder.
- The running **launcher** reads `current.json` next to itself. After a move, `npm run release` writes the new release into `Ledung\app` and `Ledung\current.json`, but a launcher started from `Fleet` keeps reading `Fleet\current.json`, so **Restart Ledung** would quietly start an old release.
- Hosts wait only 3 minutes for a Ledung to come back (`GRACE_MS`), so any move done between a Ledung exit and its return has to be short.
- README's current advice ("stop Ledung and rename the data folder, `fleet.db` and the config file") **breaks the start**: `current.json` still points into `Fleet\app` and at `fleet.config.local.json`, and the launcher fails. Running `npm run release` afterwards would repair it, but README doesn't say so.

#### Three ways, and the recommendation

- **A. Automatic, at a Restart.** Ledung, on start, copies what it needs into a new `Ledung` folder while the hosts keep running from `Fleet\app`. Sessions survive, but: the launcher still lives in `Fleet` (needs a forwarding pointer kept up to date by every release), the two folders live side by side until the last old host ends, the database must be copied in the 3-minute window, and the code runs once per install and is hard to test for real. Most code, most ways to go wrong, for a one-off.
- **B. A one-time script, run with Ledung closed** (recommended). Simon closes Ledung at a quiet moment (closing stops every session; restarting would keep them), runs `npm run move-data` from the source folder, then `npm run release`, and starts Ledung from `Ledung\Ledung.cmd`. Running sessions end, as with any close; managers resume when written to, and sessions resume from the page or on a message (idle stop and archive). A turn under way is lost, hence the quiet moment.
- **C. Keep old hosts attached to the old folder.** Like A, but without the copy step: Ledung would read hosts from both folders. Same launcher problem, plus permanent two-folder code.

**B in detail** (`scripts/move-data.ts`, generic, using `src/platform/paths.ts` for both folder names on each platform):

1. **Refuses to start** if a `Ledung` folder already exists, or if Ledung is still running (anything answering on the config's port) or any host still answers on its pipe (`hostReachable`, `src/host/client.ts:62`). It names what is still running and changes nothing.
2. Opens `fleet.db` and checkpoints it (`PRAGMA wal_checkpoint(TRUNCATE)`), so the `-wal` file is empty and the database is one file.
3. **Renames the folder** `Fleet` to `Ledung` in one step. If Windows refuses (a file is open somewhere, e.g. a console standing in the folder), it stops here with the reason; nothing has changed.
4. Inside: renames `fleet.db` to `ledung.db` (and any `-wal`/`-shm`), rewrites `accounts.config_dir` values that start with the old folder, rewrites `current.json` (`dir` into the new folder, `config` to the renamed file), removes the stale host records and logs, `resume-after-restart.json` and `Fleet.cmd`.
5. Renames `fleet.config.local.json` to `ledung.config.local.json` in the source folder, if there is no ledung one. Only when `current.json` points there; a config set by `LEDUNG_CONFIG` is left alone.
6. Prints what it did and how to start Ledung.

A script that stops half way can simply be run again; it picks up where it left off, helped by the fallbacks that already exist (a `Ledung` folder with `fleet.db` inside still works, `src/store/database.ts:225`). *As built:* between the folder move (step 3) and the rewrite of `current.json` (step 4) the launcher can't start Ledung, so a run that stops there must be run again before starting Ledung. The logs of ended hosts are kept, as Ledung does for any ended host; only their records are removed. The script takes `--from` and `--to` folders for tests.

**Other platforms and Magto.** The same script and the same steps work on macOS (`~/Library/Application Support/Fleet` → `Ledung`) and Linux (`~/.local/share/fleet` → `ledung`); nothing in it is specific to this PC. Magto runs it on their install once they have a release with it. Their clone and config may be elsewhere; the script only moves what `current.json` points to.

**When the fallbacks go** (decision 6, later): once Simon's and Magto's installs have both moved, nothing needs the old names. Removing them is a separate small change: `LEGACY_APP_NAME` and `FLEET_*` in `src/platform/paths.ts`, `fleet.db` in `src/store/database.ts`, `fleet.config.local.json` in `src/config.ts` and `.gitignore`, `FLEET_CONFIG` in the launcher (`scripts/release.ts:42`), the `fleet` tool server (next section), `test/rename.test.ts`, README's "Coming from Fleet", the two mentions in `CLAUDE.md`, and the move script itself. Keep the `FLEET_` filter in `sessionEnv` (`src/runners/runner.ts:26`) until then too.

### 4. The project named "fleet"

There is no rename in the page: a project's name is its key (`projects.name`), and `update()` keeps the name and place as they are (`src/projects/store.ts:54`). The name is also stored in `sessions.project`, `usage.project`, `turn_resources.project`, inside the project's own `data`, and in the manager's title "Manager: fleet" (`src/sessions/manager.ts:531`, set once when the manager is created). Importing from the config can't bring "fleet" back: imported names are remembered (`src/projects/store.ts:78-94`).

**Minimal:** the move script takes `--rename-project "fleet=Project Ledung"` and, while Ledung is closed, changes the name in those places in one transaction, plus the manager's title if it is still the default. With Ledung closed there are no running sessions holding the old name, which is what makes a page rename harder (decision 4). Other managers find projects by listing them, so they see the new name. Grants are kept by session, so they are unaffected.

### 5. The `fleet` tool server

`LEGACY_LEDUNG_SERVER` (`src/sessions/tools.ts:12`) exists only for hosts started before the rename: Ledung looks at the host's pipe name (`fleet-host-`, `src/sessions/session.ts:247-248`) and gives such a session its old tool names. A resumed session gets a new host and the `ledung` name. With plan B every host ends at the move, so after both installs have moved no `fleet-host-` host can exist, and the legacy name goes with the other fallbacks (decision 6). Two such hosts are recorded on this PC (section 3).

### 6. Simon's private notes (the manager updates them)

- `CLAUDE.local.md` (4 lines say Fleet: how Simon uses it, its port, its home-network setting, and testing it with throwaway projects).
- Memory notes in the `memory` folder of Claude Code's project folder for the source folder: `MEMORY.md`, `fleet-project-environments.md`, `fleet-status.md`, `working-with-simon.md`. The folder name is derived from the source folder and stays.

### 7. Every "fleet" in the repository

Searched case-insensitively, without `node_modules` and `web/dist`: 66 hits in 17 files.

| Where | What it is | Action |
|---|---|---|
| `docs/decisions.md:10` | Repository name, plus the folder slip | Change (section 2) |
| `docs/decisions.md:43` | Old issue URL | Change to `FFBuddha/Project-Ledung` |
| `docs/decisions.md:36`, `:38` | The ship's fleet (status line, limits) | Keep (ordinary word) |
| `README.md:39-41` | "Coming from Fleet" | Rewrite now (move script); remove with the fallbacks |
| `CLAUDE.md:15`, `:43` | Old `Fleet` folder, `FLEET_*` settings | Fallback; keep until decision 6 |
| `.gitignore:8` | `fleet.config.local.json` | Fallback; keep until decision 6 |
| `scripts/release.ts:42` | `FLEET_CONFIG` in the launcher | Fallback; keep until decision 6 |
| `src/platform/paths.ts:9, 11, 13, 26` | `LEGACY_APP_NAME`, `FLEET_*` | Fallback; keep until decision 6 |
| `src/config.ts:97, 103` | `fleet.config.local.json` | Fallback; keep until decision 6 |
| `src/store/database.ts:224, 227` | `fleet.db` | Fallback; keep until decision 6 |
| `src/runners/runner.ts:22, 26` | Sessions don't inherit `FLEET_*` | Fallback; keep until decision 6 |
| `src/sessions/tools.ts:12`, `src/sessions/session.ts:247-248` | `fleet` tool server, `fleet-host-` pipes | Fallback; keep until decision 6 |
| `test/rename.test.ts` (10 hits) | Tests of the fallbacks | Keep until decision 6 |
| `web/src/components/shipFrames.ts` (12), `SailingShip.tsx` (11), `LimitShip.tsx:42`, `web/src/usage/charts.tsx:169`, `test/ship-frames.test.ts` (8) | The ship's fleet of boats (`'fleet'`, `fleetLeaves`) | Keep (ordinary word) |

Outside the hits: `docs/steps/projects-and-accounts.md:23` (says "ledung" where it meant the project then called fleet; section 2). The other step docs were already changed by the rename and read as history with the new name; leave them.

## What gets tested

**Automated** (`npm run check`), for the move script, on throwaway folders built like an old install (a `fleet.db` with a WAL, `current.json`, host records, a folder account under `accounts\`):

- It refuses when a `Ledung` folder exists, when something answers on the port, and when a host answers on its pipe, and changes nothing.
- After a run: `ledung.db` opens with every row, `current.json` points into the new folder and at the renamed config, folder accounts point into the new folder, stale records are gone.
- Stopped after each step (simulated), a second run finishes the job, and Ledung starts in every half-way state.
- `--rename-project` renames the project in every table and the manager's default title, and leaves a changed title alone.

**Live** (Haiku, a throwaway Ledung on port 4392 with its own `Fleet`-style data folder given through `--from`/`--to`, started through its own launcher): a manager and a session, close Ledung, run the script, release, start from the new `Ledung.cmd`; the project shows its new name, the sessions resume and answer, Restart Ledung picks up a newer release, and the page signs in without a new token.

**Not tested before Simon runs it for real:** this PC's shortcuts and Startup entries, and Magto's install.

## Build order

| Part | What | Who |
|---|---|---|
| A | Rename the repository to `Project-Ledung` (Settings, or `gh repo rename` with Simon's OK); board title and repository description if they say Fleet. | Simon |
| B | `git remote set-url` in our clone; a note to Magto to do the same. | A session (after A) / Magto |
| C | Docs: `decisions.md` line 10, line 43 and the new rows; `projects-and-accounts.md:23`. | A session |
| D | `scripts/move-data.ts` and `npm run move-data`, with `--rename-project`; its tests; README's "Coming from Fleet" rewritten to point at it; the live test above; then a release. | A session |
| E | At a quiet moment: close Ledung, `npm run move-data -- --rename-project "fleet=Project Ledung"`, `npm run release`, start from `%APPDATA%\Ledung\Ledung.cmd`, point shortcuts there, resume the sessions wanted. | Simon (a session can't do it: it would be closed itself) |
| F | `CLAUDE.local.md` and the memory notes. | The manager, after E |
| G | Magto moves their install, if they run one. | Magto |
| — | Later, separate decision: remove the fallbacks (decision 6). | |

## Decisions for Simon

1. **Simon renames the repository in GitHub's settings** (recommended); or a session runs `gh repo rename` with Simon's OK in the same message.
2. **No `repository` field in `package.json`** (recommended): the package is private and never published. Or add one pointing at `FFBuddha/Project-Ledung`.
3. **Move the data folder with a one-time script, run with Ledung closed** (plan B, recommended). Running sessions end and are resumed afterwards. Or the automatic move at a Restart (A), which keeps sessions running but costs much more code for a one-off.
4. **Rename the project in the move script, while Ledung is closed** (recommended). *Decided by Simon on 2026-10-12 (in chat): the new name is "Project Ledung".* Or a Rename in the project's settings page (more work: running sessions and managers hold the name), or leave it as `fleet`. Any name of letters, digits, spaces, `.`, `_` or `-` works, e.g. "Project Ledung".
5. **The same script for macOS, Linux and Magto** (recommended), nothing PC-specific.
6. **Remove every old-name fallback, including the `fleet` tool server and the move script, once Simon's and Magto's installs have both moved**, as its own small change and decision (recommended). Or keep them for a set time.
7. **Who decided the rename to Project Ledung** for its row in `docs/decisions.md` (Simon to say; the commit is Martin's from 2026-10-11).

## Found while reading

- **README's "Coming from Fleet" advice breaks the start** if followed as written (stale `current.json`); fixed by part D.
- **A launcher started from the old folder never sees a release made into the new one**, so any move while Ledung runs must deal with it; plan B avoids it by starting from the new folder.
- **Two sessions from before the rename (Oct 10) still have host records** with `fleet-host-` pipes; whether they are still running was not checked. They end at the move.
- **`resume-after-restart.json`** (Oct 10) is left from older code and not used.
- Could not read in this session (blocked): the database rows, the board title and repository description, shortcuts, Startup entries and Task Scheduler, and which processes are running. Part D's script and Simon check these.

## Progress

| Part | Status (2026-10-12) |
|---|---|
| A Repository rename | Done by Simon: the repository is `FFBuddha/Project-Ledung` (with capitals; GitHub addresses ignore case), and the board is titled "Project Ledung". |
| B Remote, note to Magto | Done: `origin` is https://github.com/FFBuddha/Project-Ledung.git (the manager); the note to Magto went to the manager. |
| C Docs | Done: `decisions.md` line 10 and the issues link, rows for the rename, the repository and this approval; `projects-and-accounts.md:23`. |
| D Move script | Done: `scripts/move-data.ts` (`npm run move-data`, `--rename-project`, `--from`/`--to`), `test/move-data.test.ts`, README's "Coming from Fleet" rewritten. Not released. |
| E–G | Simon, the manager, Magto. |

Checked live (Haiku, a throwaway install on port 4392 built like an old one: a `Fleet` data folder with `fleet.db`, `Fleet.cmd`, `resume-after-restart.json`, `fleet.config.local.json`, a project called `fleet` with its manager and a session, and a folder account): with Ledung running, the script refused ("still running on port 4392"); with Ledung stopped but its two hosts running, it refused and named them; with everything stopped, it moved the folder, renamed the database and config, pointed `current.json` at both, moved the account's login folder, renamed the project and the manager's title, removed the host records, `resume-after-restart.json` and `Fleet.cmd`, and added `Ledung.cmd`. Started from the new `Ledung.cmd` (before any new release): the same sign-in token worked; the project showed as `ledung` and `fleet` was not imported again from the config; a message to the ended session and one to the manager resumed both, and both answered. A release into the new folder followed by Restart Ledung started the new release and reconnected both sessions.

A second live run used the decided name: `npm run move-data -- --rename-project "fleet=Project Ledung"` from Git Bash renamed the project to "Project Ledung" and its manager to "Manager: Project Ledung"; the manager, written to under its new name, resumed and answered. From PowerShell the quoted name with its space also reached the script intact (checked with a refusal that changes nothing).

Not checked: closing Ledung with Ctrl+C before the move (the test stopped Ledung by its process and its hosts by their command line, which ends them the same way but not through Ledung's own stop); a real install's shortcuts; a `Fleet` folder with old `fleet-host-` hosts in it (covered by the refusal test, which uses any pipe); macOS and Linux (the code uses the same platform folders as Ledung; CI runs the tests on macOS); Magto's install.

## The fallbacks removed (2026-10-28, #395)

Decision 6 carried out once every Ledung had moved (Martin, 2026-10-28 22:17: "everyone has updated their Ledungs now, so we can remove the code that eases the transition before we go public in a new squashed repo"): the `Fleet` data folder, `fleet.db` and `fleet.config.local.json` fallbacks, `FLEET_*` settings, the `fleet` tool server and `fleet-host-` pipes, and `scripts/move-data.ts` with `npm run move-data` and its test are gone, and README's "Coming from Fleet" with them. The section above is the record of how the move was done.
