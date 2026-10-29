# A terminal in Ledung's page — proposal

Oct 15, 2026 · **Proposal, waiting for Simon's decisions.** Nothing is built. The experiments below were throwaway scripts in a temp folder and two throwaway Alpine containers (removed afterwards); no Ledung was touched and no Ledung code changed.

**Done when:** from a project (or a session) in Ledung's page you open a terminal and type commands by hand: for a project on this PC, PowerShell (Windows) or your own shell (macOS, Linux) in the project folder; for a container project, a shell inside the container, in the project folder, as the same user its sessions run as. Something you do there, such as `aws sso login`, lasts where it would last for a session (the PC's or the container user's home folder). Closing the terminal leaves nothing running. It opens only where the security decision below allows it, and never for a manager or a session.

## What Simon asked for

"I think I want a terminal built into Ledung" (2026-10-15). In VS Code Simon used its terminal for things like `aws sso login` and other commands by hand. Ledung replaces VS Code for him, so it needs that terminal too.

## What it does

- **A Terminal button** on a project's page and in a session's header. The project's opens in the project folder; a session's opens in that session's own working folder (the `cwd` a manager gave it, for example a git worktree), or the project folder.
- **Where the shell runs**, the same place the project's sessions run:
  - *A project on this PC:* PowerShell 7 (`pwsh`) when installed, otherwise Windows PowerShell, on Windows; your login shell (`$SHELL -l`) on macOS and Linux. Started in the folder above.
  - *A container project:* `docker exec -it` into the project's container, as the project's container user (`user` in its config, as for sessions), in the folder, running `bash -l` if the container has bash, else `sh -l`. The container must be running; if it isn't, the button says so ("The container "x" is not running. Start it, then try again."), the same check sessions make before starting (`src/runners/docker-runner.ts:34-47`).
- **A real terminal** (colours, arrow keys, history, Tab completion, programs that take over the screen like `less`, `vim`, `top`), sized to the panel and resized with it.
- **What you do there stays**, because it is the same machine or container and the same user: an AWS login in `~/.aws`, a `gh auth login`, files you create. Sessions in that project see the same things.
- **A banner over each terminal**: "Terminal · <project> · this PC, C:\…\folder" or "Terminal · <project> · container <name> as <user>, /work/…", so it is always clear where you are typing.
- **Several terminals per project**, as tabs in the panel. Closing a tab ends that shell and everything it started.

## What the experiments showed

Run 2026-10-15 on this PC (Windows 11, Node 24.20.0), with `node-pty` 1.1.0 (the pseudo-terminal library VS Code itself uses) in a temp folder.

1. **It installs without building anything.** node-pty 1.1.0 ships ready-built files for Windows (x64, arm64) and macOS (x64, arm64). `npm install node-pty --ignore-scripts` (the way `npm run release` installs, `scripts/release.ts:82`) took 2 seconds and the module loaded and worked: no compiler, no Python, no node-gyp. **There are no ready-built files for Linux**; there it compiles on install (and so would fail under `--ignore-scripts`). See decision 2.
2. **PowerShell in a pty works:** started in a folder with a space in its name, the prompt and `Get-Location` showed that folder; the window was 80×24, and after a resize to 132×40 PowerShell reported 132×40; `exit` ended it with code 0.
3. **A container shell works:** `docker exec -it -u dev -w "/work/my proj" <container> sh` through the pty gave a real terminal (`tty` said `/dev/pts/0`), the user `dev`, the folder with a space, and the resize reached the container (`stty size` 24 80, then 40 132). The user's home was `/home/dev`, which is where an AWS login would be kept.
4. **Windows' own ConPTY leaks a helper per terminal.** With node-pty's default, each terminal closed with `exit` left a `conhost.exe --headless` process behind (about 9 MB each); three terminals, three leftovers, and calling `kill()` afterwards didn't remove them. **With node-pty's own bundled ConPTY (`useConptyDll: true`) nothing was left behind**, and PowerShell, the container shell and resizing all worked the same. The design uses the bundled one.
5. **Killing the terminal does not end the shell inside a container.** After `kill()` on a `docker exec -it` terminal, the container still had the `sh` and a `sleep 300` started from it, 3 seconds later. This is the same problem sessions had (spike finding 3, `docs/steps/step-1a-spike.md`), so container terminals need the same remedy: the shell writes its process id to a file in the container, and closing the terminal ends that shell's whole process session inside the container.
6. **Small things:** node-pty on Windows keeps Node's event loop alive after a terminal ends (harmless for a server, which runs anyway); calling `kill()` on a terminal that already ended starts a helper that prints "AttachConsole failed" (harmless, but the code should not do it). Plain pipes without a pty (`docker exec -i`) give "not a tty": no prompt editing, no `less`/`vim`, no window size.

**Not tested:** macOS and Linux; whether a local shell ends when Ledung itself is killed (not closed); a real `aws sso login`; xterm.js in the page with Ledung's strict content rules (CSP); a phone. All are in the test list below.

## How it works

### Server side

- **`src/terminals/`** (new): a `TerminalManager` that opens, lists and closes terminals, holds each one's recent output in memory, and applies the limits. One `node-pty` process per terminal, inside Ledung's own process (decision 3).
- **Where and how to start**, decided by the project's runner, so the same rules as sessions apply: a new `terminalSpec(folder)` on `LocalRunner` and `DockerRunner` (`src/runners/`) that returns the command, arguments and folder, and how to stop it. The Docker one is `docker exec -it [-u user] -w <folder> -e TERM=xterm-256color <container> sh -c 'echo $$ > /tmp/ledung-term-<id>.pid; exec bash -l || exec sh -l'`; closing it ends that process session in the container (`pkill -KILL -s <pid>`, using the pid file), like `src/host/stop.ts` does for sessions.
- **The environment** is Ledung's own, **without `LEDUNG_*`** (the same filter as `sessionEnv`, `src/runners/runner.ts`), so a Ledung started from a terminal can't use the real config and data. A container shell gets only `TERM`, nothing of the PC's environment.
- **The folder** is checked the same way as a session's: the project folder, or a session's own working folder, which was already checked when it started (`resolveWorkFolder`).
- **When Ledung closes or restarts**, it ends every terminal (decision 3). For containers it also looks, at start, for pid files left by a Ledung that crashed (`/tmp/ledung-term-*.pid` in each running container project's container) and ends those shells.

### The live connection

- **A separate WebSocket per terminal**, `/terminal/<id>`, not the page's `/ws`. `/ws` only ever sends from Ledung to the page and closes on anything the page sends (`src/server/server.ts:124`); that rule stays. A terminal needs both directions and its own back-pressure.
- **The same locks as everything else** (`src/server/security.ts`): the Host check, the Origin check (from Ledung's own page only) and the sign-in rule, plus the terminal rule of decision 1, checked when the connection opens. Terminal ids are random and unguessable; opening one (`POST /api/terminals`) is an API change, so it needs the Origin check too.
- **What travels:** your typing to the server and the shell's output back, as raw bytes; resize and "ended (exit code)" as small JSON messages. If a page reads slowly, Ledung pauses the shell's output rather than buffer without end.
- **Reconnecting:** a page reload, or the same terminal opened on another of your devices, reattaches to the running shell and first gets its recent output (decision 6), like `tmux attach`. All pages attached to one terminal see the same thing and may type.
- **The CSP** already allows `ws://` to Ledung's own addresses; xterm.js draws with inline styles, which `style-src 'unsafe-inline'` allows. To be confirmed in step 1.

### The page

- **xterm.js** (`@xterm/xterm` and its fit add-on): plain JavaScript, built into `web/dist` by Vite, so nothing new at run time. This is what VS Code's terminal uses.
- **A side panel** like the file viewer's (`web/src/components/FileViewer.tsx`): tabs for the project's terminals, the banner, and a close button per tab. A "pop out" opens the terminal on its own in a new browser tab, for long work.
- **Narrow screens:** the panel takes the whole width; a row of keys a phone keyboard lacks (Esc, Tab, Ctrl, arrows) sits above the keyboard. Only reachable from a phone if decision 1 allows it.
- **Copy and paste:** select to copy (and Ctrl+Shift+C), Ctrl+V or right-click to paste. Note: on the home-network address (plain HTTP) browsers don't let a page *read* the clipboard on its own, so paste works through the keyboard shortcut and the browser's own paste, not a "Paste" button.

### What is recorded

- **Never the output or your typing.** A terminal is where you would type secrets (an AWS code, a password), and Ledung's database is read by its own tools and kept forever. The recent output lives only in Ledung's memory, for reattaching, and is gone when the terminal closes or Ledung restarts.
- **An audit line per terminal** (a new `terminals` table, a new `MIGRATIONS` entry): when it opened and closed, the project, where (PC folder, or container, user and folder), from which address (this computer or a home-network address), how it ended (closed by you, idle, Ledung restart, exit code). Shown on the project's page under "Terminals" (last 50).

### What the sensitive check does here

Nothing, on purpose. The sensitive check (`docs/steps/sensitive-always.md`) exists so that a **model** can't run production or patient-data commands without you saying yes. In a terminal **you** type every command; asking you whether you meant what you just typed adds nothing. So terminals are not routed through it, and that is said in the README. The banner (where you are) is the safeguard instead, and the audit line records that a terminal was open.

### Humans only

- No manager or session tool opens, reads or types into a terminal, and none will be added: a session that could type into a terminal would bypass every permission check Ledung has.
- **An honest limit:** a session that can run commands on this PC could in principle read Ledung's sign-in token from the user data folder and call the API itself, as it could for any other API call today. The Origin check stops browsers, not programs. That is not new with terminals, but terminals make it worth more. Two things help: such a command would itself go through Ledung's permission check, and a suggested sensitive pattern for reading Ledung's user data folder (`auth-token`) can be added to "Add suggested". Decision 1 includes that.

## Decisions for Simon

1. **Who may open a terminal.** Your home-network address needs no sign-in (`lanSignIn: false`), so today anyone on your network who opens the page can do everything the page does. A terminal is a live shell on this PC and in your containers, which is more than the page can do today.
   - a. **Only from this computer by default** (`127.0.0.1`, signed in). A config setting `"terminals": "signedIn"` also allows signed-in devices on the home network (they need the one-time sign-in link once, even with `lanSignIn: false`). **(recommended)**
   - b. Signed-in devices from the start (your second computer and phone after a one-time sign-in).
   - c. Same as the rest of the page (anyone on the home network).
   - In every case: Host and Origin checks on the terminal connection, humans only (no tool for managers or sessions), the audit line, and a new suggested sensitive pattern for reading Ledung's `auth-token` file. *Recommended: a., with all of these.*
2. **The technology.** node-pty with its bundled ConPTY on the server, xterm.js in the page, a separate WebSocket per terminal. **(recommended)** It worked on Windows in the experiment and installs without building. For Linux (no ready-built files) the release would need a compiler, or the terminal is simply off on Linux with a clear message until someone needs it there. *Recommended: off on Linux for now*; macOS uses the ready-built files and gets tested when someone has a Mac at hand.
   - Not recommended: plain pipes without a pty (no prompt editing, no `less`/`vim`, no window size, "not a tty"); a different ConPTY package (node-pty is what VS Code uses and is maintained by Microsoft).
3. **What happens on Restart Ledung.**
   - a. **Terminals close**; the panel says "Ledung restarted; this terminal was closed" with Reopen (same place). Logins and files stay, since they live on disk. **(recommended)** Terminals are short pieces of work, and the session host (which must stay small and change rarely) is left alone.
   - b. Terminals survive, like sessions: a small "terminal host" process holds the shells (and node-pty) across restarts. More code and a second kind of host; can be added later if closing turns out to be annoying.
4. **Where it starts.** The project's Terminal button: the project folder. A session's Terminal button: that session's working folder (its worktree, `cwd`), which for container projects is the project folder. **(recommended)** No free choice of folder: you can `cd` anywhere once it is open.
5. **Several terminals and where they show.** Up to 4 per project, as tabs in a side panel next to the chat (like the file viewer), with a pop-out to a browser tab of its own; full width on a phone, with an extra key row. **(recommended)**
6. **Limits.** **(recommended, all in the config)**
   - At most 4 terminals per project and 12 in all.
   - A terminal with no typing and no output for 60 minutes is closed (`terminalIdleMinutes`, 0 = never), with a line in the panel saying so. Output counts so a long command isn't cut off.
   - Recent output kept in memory for reattaching: the last 5,000 lines per terminal (about 1 MB at most).
   - Output and typing are **never stored** in Ledung's database or logs; only the audit line.
7. **The sensitive check doesn't apply to terminals**, since you type every command yourself; the banner shows where you are typing. **(recommended)**
8. **Which shell.** PowerShell 7 if installed, else Windows PowerShell, on Windows; your login shell on macOS and Linux; `bash -l`, else `sh -l`, in containers. A config setting `terminalShell` overrides the PC's choice (for example Git Bash). **(recommended)**

## What gets tested

Unit tests (`test/terminals.test.ts`, and additions to `test/server-security.test.ts`):

- The terminal connection is refused without the right Host, without Ledung's own Origin, without sign-in, and from a home-network address unless decision 1 allows it (each case, both with `lanSignIn` on and off); opening a terminal through the API needs the Origin check.
- The terminal's environment has no `LEDUNG_*` variables; a container shell gets no PC environment.
- The `docker exec` command line: user, folder (with a space and a quote), container, pid file.
- Folder rules: project folder, a session's working folder, nothing else.
- Limits: the fifth terminal in a project is refused with the reason; idle close after the set time, not while output flows.
- Nothing of a terminal's output reaches the database; the audit line is written on open and close with how it ended.

On this PC (Windows), in a test that also runs in CI:

- Open PowerShell in a temp folder with a space in its name, type, resize, close: the folder, the size and the exit are right, and **no `conhost.exe` or shell is left** (experiment finding 4).

Live, with a throwaway Ledung (port 4396, its own config and data) and throwaway containers, as for the container tests:

- A local project: open, run a command, resize the panel, close; reload the page and reattach; two tabs at once; the idle close (with `terminalIdleMinutes: 1`); Restart of the test Ledung closes the terminals and Reopen works.
- A container project (Alpine and Debian images, a user other than root, a folder with a space): user, folder, `bash` vs `sh`, resize; a file written to the user's home is still there in a new terminal and seen by a session of that project; closing ends the shell and anything it started in the background (experiment finding 5); a stopped container gives the clear message; killing the test Ledung and starting it again cleans up a container shell left behind.
- Security: from the home-network address the terminal is refused by default; with `"terminals": "signedIn"` it works after the sign-in link and not before.
- The page: on a narrow window and on Simon's phone (if decision 1 allows it), the extra key row, copy and paste.
- **Not testable by me:** a real `aws sso login` (needs Simon's AWS account). Simon tries it in his container project after release.

## Build order

1. **Server core, local only:** `src/terminals/`, node-pty with the bundled ConPTY, the local runner's `terminalSpec`, the terminal WebSocket with its checks, limits, the audit table. Release script: node-pty installs from its ready-built files; Linux says "not available". Tests above.
2. **The page:** xterm.js in a side panel with tabs, the banner, reattach, pop-out, the narrow layout and key row, copy and paste. Confirms the CSP.
3. **Containers:** the Docker runner's `terminalSpec`, the pid file and stop, the clean-up at start, the "not running" message. Live container tests.
4. **The live test** with a throwaway Ledung as above, then a CHANGELOG bullet, and the README (where terminals open, what is recorded, why the sensitive check doesn't apply, the `terminals` setting).

Each step is a PR; step 1 and 2 could be one if small.

## Later

- Terminals that survive Restart Ledung (decision 3b).
- Terminals on Linux (a compiled node-pty in the release, or a package with Linux builds).
- Opening a terminal in a session's exact state (its environment, its account's login folder for `claude`): not needed for typing commands by hand.
