# Projects and accounts: proposal

Oct 11, 2026 · From Simon's request for several Claude accounts (question #16) and the discussion that followed (questions #17 and #18, then in the chat). Replaces the earlier accounts proposal. Comes before the container tests and step 7, since the switch-over needs the work account. **Approved by Simon on 2026-10-11 (question #19), all decisions as recommended.**

**Done when:** from the phone, Simon adds an existing folder and creates a new project by browsing, each under a different Claude account; both projects' managers run sessions at the same time; each account's usage and plan limits show separately; no restart and no editing of files was needed.

## Decided so far

1. **Each project has exactly one manager.** It is created with the project and belongs to it; if it ends, it is resumed, never replaced (question #17).
2. **One Claude account per project**, used by its manager and all its sessions (question #17).
3. **Projects are added from the page:** an existing one (a Windows folder, or a folder in a Docker container) or a brand-new one.
4. **Folders are picked by browsing**, in Ledung's own folder browser: the same from the PC, the second computer and the phone, and inside containers too.
5. **Nothing machine-specific in the code.** Defaults come from whoever runs Ledung (their home folder, `<home>/Projects`), and each person can change them in their own config.

## What it delivers

### Projects in the page

- **A project** is a named place where Claude Code runs (a folder, or a folder in a container), its settings, and its one manager.
- **Settings per project:** name, account, model, permission mode, manager grant (what the manager may decide for you), sensitive patterns, ticket pattern. All editable later in the page.
- **The sidebar becomes a tree:** project → its manager → the sessions it runs. Opening a project opens its manager's chat. "New manager" goes away; each project already has one.
- **Removing a project** takes it off the list and stops its sessions; its history stays, and its files are never touched.
- **Projects move into Ledung's database.** The three in the config file today are copied over once, the first time the new release starts; after that the config file keeps only Ledung-wide settings (port, network, session limit, browsing).

### Adding an existing project

1. **Where:** "A folder on this computer" or "A folder in a Docker container". For a container, Ledung lists the running containers and the user to run as.
2. **Browse** to the folder (below), then **Use this folder**.
3. **Name and settings**, prefilled: the name from the folder, the default account, permission mode "Ask".
4. **Add.** The project and its manager appear in the sidebar; no restart.

### Creating a new project

1. **Name**, and the parent folder (default `<home>/Projects`, browsable).
2. Ledung creates the folder and runs `git init`. With **Create a GitHub repository** ticked (unticked by default), it also creates a private repository with the GitHub CLI and connects it.
3. **Settings** as above, and optionally **what the project is for**: given to its manager as its first task, so it can set up the starting files.
4. New projects in a container are left out for now: creating a container is too project-specific. Create the container, then add it as an existing project.

### The folder browser

- A list of folders with **Up**, and on Windows a drive list. Each folder shows a hint where useful: "git repository · main", or "already a project".
- **Folder names only,** never file names or contents.
- **Only under allowed folders** (`browseRoots` in the config; default: the home folder of whoever runs Ledung). Ledung resolves links and junctions before checking, so nothing outside the allowed folders can be reached through them. This matters because Ledung is open to the home network without sign-in.
- **In a container:** the same list, read inside the container (starting at the container user's home folder), through `docker exec`.

### Accounts

> **Changed 2026-10-27 (issue #342):** login tokens are gone; an account is only a sign-in folder, also in containers, and conversations and skills are shared whatever the account. See docs/decisions.md.

- **Accounts are added in the page:** a name (e.g. `personal`, `work`) and a login. Each project picks one; a project without one uses whatever Claude Code is logged in as (on this computer, or inside the container), as today.
- **The login**, two ways; a spike confirms both through the Agent SDK before anything is built:
  - **A login token** (made once with `claude setup-token`, valid about a year), pasted into the page once and never shown again. Works for Windows-folder and container projects alike. Recommended.
  - **A login folder** (`CLAUDE_CONFIG_DIR`): you log in once in that folder; settings and history are kept separate too. Windows-folder projects only.
- **Keeping logins safe:** tokens are never in the repository or the config, but in Ledung's data folder, readable only by your user. A token goes only to the sessions of its account; for containers it stays off the `docker exec` command line. Ledung never moves work between accounts, for example to get around a limit.
- **Usage and limits per account:** every usage record notes its account; plan limits are kept per account, with a set of limit meters per account in the sidebar; the usage page gets an account filter. Earlier records count as "default".
- **The account is shown** on the project, in the session header and in the Overview.
- **Terms:** each project is tied to one account you chose, so work is not spread across accounts. Whether your employer allows the work account to be used through Ledung is for you to check.

### Managers

- **A manager starts sessions only in its own project**, so its sessions always use its account. (Today `start_session` can name another project; that goes away.)
- **The manager is created with the project but starts only when needed:** when you open the project and write to it, or give it a task. An idle project costs nothing.
- **You can still start a session in a project yourself**, outside the manager, for a quick chat; it uses the project's account and appears under the project.

## Parts

| Part | What | Done when |
|---|---|---|
| P1 Projects | Projects in the database, copied once from the config; the tree project → manager → sessions; one manager per project, created with it; edit and remove; a manager's sessions only in its project. | The three current projects appear as before, each with one manager; settings change without a restart. |
| P2 Browsing and adding | The folder browser (local and in containers, allowed folders only); adding an existing project; creating a new one (folder, git, optional GitHub repository, first task). | From the phone: an existing folder added and a new project created, no restart. |
| P3 Accounts | The spike; accounts added in the page; a project's account handed to its sessions; usage and limits per account. | Two projects run at once under two accounts, each with its own limits. |

## Decisions for Simon

1. **You can still start sessions in a project yourself, outside its manager** (recommended), or everything goes through the manager.
2. **The manager is created with the project and starts when first needed** (recommended), or starts at once and stays running.
3. **New projects go in `<home>/Projects` by default, with "Create a GitHub repository" unticked** (recommended), or ticked.
4. **The folder browser sees only allowed folders, by default your home folder** (recommended), or the whole computer.
5. **Projects move into the database and are managed in the page** (recommended), or stay in the config file.
6. **Login tokens, added once in the page, with login folders as an option** (recommended), or login folders only.
7. **A manager starts sessions only in its own project** (recommended), or anywhere.
8. **This before the container tests and step 7** (recommended).

## Progress

| Part | Status (2026-10-11) |
|---|---|
| P1 Projects | Done (`src/projects/store.ts`, migration 10). Projects in the database, copied once from the config (by name, so a removed one doesn't return; an existing manager is linked); the sidebar as a tree per project with **+ Session** and ⚙ settings; settings and removal in the page; one manager per project, started by writing to it (resumed if it ended); `start_session` only in the manager's own project. |
| P2 Browsing and adding | Done (`src/projects/browse.ts`). The folder browser (folder names only; only under `browseRoots`, links and junctions resolved; inside containers through `docker exec`); **Add project** for a folder on this computer, a folder in a container, or a new project (folder, `git init -b main`, optional private GitHub repository, optional first task for the manager). |
| P3 Accounts | Done (`src/accounts/store.ts`, migration 11). Spike: through the Agent SDK, `CLAUDE_CODE_OAUTH_TOKEN` takes precedence over the computer's own login, and `CLAUDE_CONFIG_DIR` is honoured; `accountInfo()` says who a session is logged in as. Accounts page (token pasted once, or a login folder with the command to log in); an account per project, checked before a session starts; usage, limits and sessions note their account; limit meters per account; an account filter on the usage page. |

Checked live (Haiku, throwaway Ledung, allowed folder set to a temp folder): a config project copied in; browsing listed folders with their branch and refused `C:\Windows`; adding an existing folder worked, adding one outside the allowed folders or under a taken name was refused; a new project got its folder and git repository and its manager started with the task; a second manager was refused; writing to a stopped manager resumed it; removing a project left its folder. Three projects under three accounts at once: a dummy token was rejected as invalid (so the token, not the computer's login, was used), an empty login folder said "Not logged in", the default worked and Ledung noted who it was logged in as. The dummy token was found only in its own file: not in the database, the log, host records, the API or any Ledung, host or Claude command line. An account in use by a project couldn't be removed.

Not checked: a second real account (that needs your token from `claude setup-token`), accounts and the folder browser in a container (no throwaway container yet), creating a GitHub repository, and the page in a browser.
