# Container tests (Docker runner)

Oct 12, 2026 · Approved by Simon (question #31). The first live test of container sessions: the Docker runner, the folder browser inside a container, measuring, stop, idle stop, accounts and permission prompts.

## Set-up

- A throwaway container `ledung-test-1`: `node:24-slim` plus Claude Code (2.1.296, later 2.1.283 for the older-version checks), a user `tester` with `/home/tester/work/demo` (a git repository) and `/home/tester/work/other`. Own network, `--memory 2g --cpus 2`, nothing shared with other containers. Image, container and network were removed afterwards.
- A throwaway Ledung on port 4395 with its own config and data, `idleStopMinutes: 1`, Haiku. The project `ctest` was added as "a folder in a container" through the API (the calls the page makes).
- Login: a token account "Private-test", entered in the page by Simon himself. The test never read or copied a credential from the real Ledung or `~/.claude`.

## Results

| # | Item | Result |
|---|---|---|
| 1 | Add the project: container listing, user, browsing | ✅ `GET containers` listed the running containers with their user; browsing started in the user's home folder, showed folders only, git branch ("main") and "already a project" after adding; a second project under the same name was refused. |
| 2 | Session, message and answer, stop, resume, resume-on-message | ✅ A session started in the container, answered, and stopped with no process of it left. A message to the stopped session resumed it (same Claude session) and was answered. `ask_user` from the container reached the page and the answer came back ("you chose blue"): the tool server needs no network. **After fix 1**; before it a stop left everything running (finding 1). |
| 3 | Ledung restart while a session is idle, and while it is working | ✅ Both: the session reconnected through its host ("Ledung restarted; reconnected"), and a 40 s command that was running finished and was reported. The per-turn record of that turn was lost (finding 4). |
| 4 | CPU and memory measuring | ✅ after fix 2. Docker's VM figures (memory, CPUs, cores in use) appeared. A session running a one-core command showed 0.6 to 1.1 cores and 513 MB; before the fix it showed 0.007 cores and 250 MB (Claude Code alone). |
| 5 | Token account handed to a container session | ✅ The session logged in with the token (answered; `apiKeySource` was "none" without it). The `docker exec` command line has only `-e CLAUDE_CODE_OAUTH_TOKEN` by name; no process on the PC and none in the container had a token on its command line; the token text was not in the database or the logs. |
| 6 | Idle stop with `idleStopMinutes: 1` | ✅ A container session was stopped after a minute ("Stopped after 1 min idle.") and nothing was left. The Stop hook of Claude Code 2.1.296 and 2.1.283 both report scheduled wake-ups: a session with a `CronCreate` wake-up was not stopped over 2.5 minutes. **A Claude Code that does not report them could not be reproduced** (both available versions do); that case stays covered by the unit test only. |
| 7 | Permission prompts and sensitive patterns | ✅ A Bash request reached the page and, once allowed, ran; a denial reached the session. With `rm -rf` and `secret` as sensitive patterns, both requests were marked sensitive and addressed to the user. ❌ In "Accept edits" mode a write to `secret/notes.txt` was done without any prompt (finding 3). |
| 8 | Open container items in the docs | Containers reaching Ledung's tool server (issue #6): ✅ works, see item 2. Killing the `docker exec` client abruptly (step 1a): ✅ the session ended ("Claude Code exited with code 4294967295") and neither Claude Code nor a background `sleep 800` was left. Container sessions in the Machine panel (step 6, idle stop): ✅ items 4 and 6. Accounts and the browser in a container (projects and accounts): ✅ items 1 and 5. |

## Fixes

1. **Stop left everything running in a container** (`src/host/stop.ts`). The stop script ran `kill -TERM -- -<group>`, which dash (the `/bin/sh` of Debian images) rejects ("Illegal number: -"), and its errors were hidden. Even with a working `kill`, a group kill would not reach commands Claude Code starts: it puts each in a group of its own. The script now finds the session's processes by the `LEDUNG_TAG` in their environment and ends those (`containerStopScript`, with a test). Verified live: a session with a background `sleep 700` was stopped and nothing was left but defunct entries (the test container's PID 1 was `sleep` and does not reap them; a real dev container has an init).
2. **Container CPU and memory missed everything a session started** (`src/platform/containers.ts`, `src/resources/monitor.ts`). Measuring used the process group written to the pid file, which holds only Claude Code; every command it runs is in its own group. Now the process tree under that pid is summed (`parseProcTrees`, with a test). Verified live as in item 4.

## Findings, not changed

3. **"Accept edits" bypasses the sensitive patterns.** Claude Code allows the edit itself, so Ledung's check never sees a write to a path the config marks sensitive. The same mechanism was found by reading the code for "for this session" grants (idle-stop proposal). Needs a decision: for example, keep sessions in projects with sensitive path patterns out of Accept edits, or add a `PreToolUse` hook that applies the sensitive check.
4. **A turn that runs across a Ledung restart loses its record.** The turn's CPU and memory samples before the restart are gone; the rest is stored as a 40 ms turn with trigger "unknown". Cosmetic for the usage page, but it understates costs of long turns.
5. **The commands recorded for a turn are wrong for `node -e "..."`:** they were `node const`, `let` and `")`. The command-kind parser (`src/resources/commands.ts`) splits the quoted script. Local sessions would show the same.
6. **The folder browser in a container can look inside any running container,** including ones the user has no project in, and with `lanSignIn: false` anyone on the network can ask for it. It lists folder names only. This follows the design (the page lists all running containers), but is worth a decision. Not tested against any container other than `ledung-test-1`.
7. **Error messages from the container browser show the raw command** when the container is unknown or stopped (`Can't look inside "x": Command failed: docker exec x sh -c`).
8. **An abruptly killed `docker exec` client ends the session with "exited with code 4294967295"** (the Windows form of -1). Harmless, but not a readable end reason.
9. **The stop event does not say what the stop ended** inside a container (`Stopped by …`); on Windows the host reports the processes it ended.

## Not tested

- **Claude Code that does not report scheduled wake-ups** (item 6): not reproducible with 2.1.283 or 2.1.296.
- A container whose `/bin/sh` is not dash, or without `grep`/`sed` for the stop script; a user other than `tester`, or a container run as root (the listing showed an empty user for it, so the page offers none).
- The page itself in a browser (everything went through the API); folders with unusual characters in their names; a stopped container or Docker Desktop not running while a session exists.
- Several container sessions at once, and the working-session limit with container sessions.
- Git and `gh` inside the container (`currentBranch` and `pullRequestJson`); the container had no `gh`.
- A second real account; managers in a container project.
