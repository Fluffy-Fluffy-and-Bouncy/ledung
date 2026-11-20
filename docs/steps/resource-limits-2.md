# Resource limits, round 2: subagents, waking, light commands, idle bookings, WSL

Nov 17, 2026 · **Approved (Simon, 2026-11-19, #2119)**, with all recommended choices; built in two PRs, R4 (light commands) first. Issue #356 (Simon approved starting a design, question #2046 "a"). Builds on [resource-limits.md](resource-limits.md) (approved 2026-11-12, built and released). **Built:** R4 in PR #400; R1–R3 and R5–R7 in the second PR (run-88), with the later findings below ("Added after approval"). Where the build differs from the text, the text below says what was built.

## Why

On the night of 16–17 Nov reservations cost about 2 h of worker time in another project on this PC, and on 2026-11-15 two idle builds held 28 GB of unused bookings and blocked the whole line. Reading the code behind each report:

| # | What happened | Why, in the code |
|---|---|---|
| 1 | A worker reserved, started a tester subagent, and the tester's commands were refused. | A reservation ends as soon as **its first burst of processes ends** (`book.ts`: "had a job, none running now → end"), at a turn's end if nothing runs at that moment, and 10 min after the go if no process started. Subagents run inside the same Claude Code, so their commands *are* measured under the session; but by the time the tester ran, the reservation was gone, and the heavy-command check refused it. |
| 2 | A worker waiting for its go was never woken and was stopped after 1 h idle. | **Idle stop doesn't know about reservations**: a session waiting in the resource line counts as idle. Also, the go's 10-minute lapse clock starts when Ledung grants it, not when the go reaches the session; if the "N of 10 working" line is full, the go can lapse before the session ever sees it. Whether room ever came that night isn't known: I did not read the other project's sessions. |
| 3 | `git status`, `gh issue view` and small scripts were refused, "~5.6 GB". | Ledung learns a command as heavy if it **ran 10 s or more (or in the background) during a heavy job**, and gives it **the whole job's peak**. On a PC short of memory even `git status` takes 10 s, and a background status loop always counts. After two such runs it is "known heavy" and refused without a reservation. |
| 4 | Two idle builds held 28 GB. | A going reservation holds "booked minus used" until its processes end. Build tools often leave a process behind (a compiler server, a daemon, a watcher) that uses almost nothing but keeps the job "running", so the booking never ends. |
| 5 | WSL grew to 12.6 GB, mostly Linux's file cache, and filled the memory limit. | Windows counts WSL's whole virtual machine as used memory, cache included. WSL gives cache back to Windows only slowly, even after it is dropped inside Linux. |
| 6 | The line didn't say what it was waiting for. | A waiting entry says "needs 12 GB, 0 GB left under the limit" but not **who** holds the room. |

## In short

- **A reservation becomes a pass for the session**, shared by its subagents, kept until `release` or until the session's work is over (no turn, no background subagent, nothing running).
- **A pass holds room only while it is used.** Room is held from the go until the work starts, and while the work is busy; after 2 minutes quiet the pass is **parked**: it keeps its place with the session but holds no room. When heavy work starts again it is checked against the limits like a new start. This is Simon's "booking should only start when it needs it", made to work across several commands.
- **Waiting sessions are never idle-stopped**, the go's clock starts when the session actually gets it, and **the manager is told** when a session has waited 30 minutes.
- **Light commands are never gated**: a built-in list (read-only git, gh, file reads), plus the person's own additions on the usage page. Ledung learns a command as heavy only from the calls whose own processes were busy **while** the job was; old marks learned the old way count only for a command that usually takes over 10 s.
- **WSL:** Ledung shows how much memory WSL holds and how to make WSL return its cache; it runs nothing inside WSL unless Simon switches it on.
- **The line says who holds the room**: "held by 2 parked builds (24 GB booked, 1 GB used) and WSL (12.6 GB)".

## The model, changed

### The pass and its states

A reservation is now one **pass** per session, in one of four states:

| State | Holds room? | How it gets there |
|---|---|---|
| **Waiting** | no | `reserve` and it doesn't fit (as now). |
| **Ready** | yes, all of it | The go. Lasts until the work starts, at most 10 minutes **counted from when the go reached the session** (open choice 3). |
| **Busy** | yes: booked minus used, as now | Work under the session is above the small allowance (CPU or GPU busy, or memory growing). Judged against its own share as now: lowered, held, told if over. |
| **Parked** | **no** | 2 minutes quiet while busy (open choice 1), or 10 minutes ready without the work starting. Processes still alive (a daemon) keep counting in the PC's total, as everything does; only the unused booking stops counting. |

**Parked → busy again** when work starts under the pass:

- If it fits now (the usual case), it is busy at once; nobody is told anything.
- If it doesn't fit, a **known heavy command** is refused at the hook with the wait answer ("Wait: 2nd in line for memory … Ledung will tell you"), and the pass goes back into the line **with its original time**, so it is first among equals. A command Ledung doesn't know is heavy can't be stopped before it starts; it runs, is judged against the pass's share as now, and its card says "resumed above the limits". Open choice 2 asks whether to wait in the hook a little instead of refusing.

**A pass ends** when the session calls `release`; when its work is over: no turn under way, **no background subagent or background command** (Claude Code's background-task list, non-ambient tasks), and no process of the pass running; or when the session ends. **It no longer ends when one burst of processes ends**, nor lapses after 10 minutes: those become "parked". The session is told only when it ends for a reason it didn't cause.

What the job learned is recorded per pass, as now: peak and mean over its busy stretches only, so parked time doesn't lower the mean.

### Subagents (problem 1)

- Subagents' commands are already measured under the session (they run inside the same Claude Code), so **the session's pass covers them**: no pass of their own.
- A subagent calling `reserve` acts on the session's pass, as a second call from the session does now (it adds to a busy pass, replaces a waiting one).
- A subagent refused because the pass is waiting is told: "Your session's reservation is waiting for room. Stop here and tell your parent; Ledung will tell it when it may go." The go goes to the session, which can start the subagent again.

### Waking (problem 2)

- **Idle stop skips a session with a pass waiting or ready** ("waiting for its reservation" in the idle reasons). A parked pass doesn't block idle stop; the stop ends it, as now.
- **The go's clock starts at delivery**: when the turn carrying "You may go" starts. Until then the pass stays ready, holding room. That's fair: the room is promised to it.
- **The manager is told once when its session has waited 30 minutes** (open choice 4), with the reason and who holds the room (in the words sessions may see, below): "Worker 'Fix tests' has waited 30 min for memory: needs 6 GB, held by 2 parked jobs and WSL (12.6 GB)." Again when it goes. The person sees the line already, so no question to Simon.
- Unchanged: the go joins the session's inbox and starts a turn under the working limit, as a manager's message does.

### Light commands (problem 3)

A shell call is **never refused, and never learned as heavy**, when every command in it is light:

1. **Built-in light list:** read-only git (`status`, `log`, `diff`, `show`, `branch`, `rev-parse`, `ls-files`, `blame`, `remote`, `fetch`, `worktree list`, `stash list`), all of `gh` (it waits on the network, not the PC), and the file-reading commands already left out (`cat`, `grep`, `ls` …). Fixed in the code (open choice 6); Simon's existing "never needs a reservation" mark on the usage page stays for the rest.
2. **Short by habit (as built in R4):** call durations are kept per kind (median of its last 10 calls). Marks learned **before** R4, which gave every call made during a job the job's peak, count only for a kind whose calls usually take over 10 s, so a small status script with old marks is never gated. Marks learned **since** R4 come from a call's own busy processes and stay evidence however quick its other calls are: one `python train.py &` that returns at once must not make a heavy command light (code review of PR #400, round 2). A call that detaches (`&`, `nohup`, `start`) keeps no duration.
3. **Learned only from what was running at the time:** a command is counted in a job's record only if its call was **under way during the job's busy samples**, not just somewhere during the job. A `git status` between two builds, or a background status loop that starts before the build, no longer gets the build's peak.

This holds while a pass waits and while the session is held: only heavy kinds are refused. The refusal also says where the figure comes from ("learned from 3 'nightly build' runs"), so a wrong mark is easy to spot and clear.

Old wrong marks clear themselves: the light list and the 10-second rule for old marks are applied when marks are read, so no data change is needed.

### Idle bookings (problem 4)

The three ways Simon discussed on 2026-11-15:

| Way | What it does | Verdict |
|---|---|---|
| Book at the heavy command | Room is held only while a heavy command runs. | Simon's lean. On its own it breaks the go: a session told "go" could find the room gone a minute later. And Ledung can only stop commands it already knows are heavy. |
| Count only the reserved kind's processes | A build's leftover daemon wouldn't count as the job. | Fragile: builds start `node`, `cmd`, `conhost`, compilers under other names; matching processes to a command's name would miss real work as often as it skips daemons. |
| Shrink idle bookings | A booking whose work is quiet stops holding room. | Handles daemons and forgotten passes without guessing names. |

**Recommended: parking (above)**, which is shrinking idle bookings plus a check against the limits when work starts again, so "book only when needed" holds without breaking the go. Quiet means: CPU and GPU of the pass's processes under the allowance (5 points) and memory not growing, for 2 minutes. In the 2026-11-15 case both builds would have parked 2 minutes after they finished and the 28 GB would have been free.

### WSL's memory (problem 5)

What Ledung can safely do without touching anyone's WSL:

- **Show it.** The memory bar's tooltip and the line's reasons name WSL's share when it is large: "WSL holds 12.6 GB (much of it may be Linux's file cache)". Read from the Windows process list (`vmmemWSL`), which Ledung reads already; nothing runs inside WSL.
- **Say how to fix it once.** When WSL holds more than a quarter of the memory limit, Settings → Machine shows a one-time hint: WSL can return its cache to Windows by itself with `autoMemoryReclaim=dropCache` (or `gradual`) under `[experimental]` in the `.wslconfig` file in the user's home folder, taking effect after `wsl --shutdown`. Ledung never edits that file or shuts WSL down.
- **Keep counting it as used** (recommended, open choice 5). The report showed cache dropped inside Linux comes back to Windows only slowly, so counting it as free would let jobs start into memory Windows doesn't have yet.

Option for later, only if Simon switches it on: read `/proc/meminfo` in an already-running distribution (`wsl -l --running`, never starting one) every 30 s and show "of which cache: 9 GB". It still wouldn't count as free, for the reason above.

### Who holds the room (problem 6)

Every "Waiting for … room" reason adds who holds it, largest first, at most three:

- **On the page:** named. "Held by 'nightly build' (Worker 2, parked: 0 GB booked), 'train model' (Worker 5: 8 GB booked, 3 GB used), WSL 12.6 GB, other programs 9 GB."
- **For sessions and managers:** as the approved rule says, no other session's job name or title. "Held by 2 other jobs (8 GB booked, 3 GB used), WSL 12.6 GB, other programs 9 GB." A manager sees its own sessions' jobs by name.
- "Other programs" is the PC's total minus Ledung's sessions and WSL; the largest one is named on the page only (a game, a browser).

## What is shown

- **Job cards** get the new states: *ready* ("go given 2 min ago, work not started"), *busy*, *parked* ("quiet for 6 min: holds no room"), *resumed above the limits*. Parked cards are shown dimmed and folded under the busy ones, so they don't crowd the panel on a phone.
- **The bars**: the hatched "booked but not used" part shows only ready and busy passes.
- **The line**: each reason with who holds the room (above).
- **Session header and dots**: "Waiting for its reservation" while a pass waits, as "Waiting to start" works now.
- **Settings → Machine**: the WSL hint when it applies; "park after" (2 min) and "tell the manager after" (30 min) with the other averaging settings.
- Checked at phone width as part of the try-out.

## Security

- **No new tools, nothing new a session can change.** Parking, the light list and the 10-second rule are Ledung's decisions; a session can't mark a command light (Simon's "never needs a reservation" mark stays page-only, through the API's usual guards).
- **Light doesn't mean unwatched.** Every process under the session is still measured: a "light" command that turns out heavy is judged as unreserved work exactly as now. The light list only stops refusals before a command runs, which were advisory anyway.
- **A parked pass can't be used to jump the line**: resuming is checked against the limits like a new start, and a command it can't stop is still judged against its share.
- **Subagents** can't get more than their session: one pass per session, as now.
- **Nothing runs inside WSL** and `.wslconfig` is never written; the optional reading is off unless Simon switches it on and never starts a distribution.
- **Who holds the room** follows the approved rule: sessions and managers never see another session's job name or title.

## Added after approval (issue #356 comments, built with R1–R3)

- **Commands that free resources always run.** On 2026-11-19 a session held for an emulator over its share was refused `emulator-lock.mjs release`, the one command that would end the load, and deadlocked. A shell call whose every heavy part frees resources is never refused, held or not: `kill`, `taskkill`, `Stop-Process` and the like, or a command with `release`, `unlock`, `stop`, `kill`, `shutdown`, `terminate`, `quit` or `down` as a word (`npm run stop`, `gradle --stop`, `docker compose down`) or in a script's own name (`stop-emulator.sh`). Advisory like every refusal: what runs is still measured and judged.
- **A heavy job started detached is the session's.** `python train.py &` or `nohup …` can lose its parent before Ledung's next sample, and then belonged to no session. A parentless process that started within 15 s after exactly one session's detaching call is taken into that session's work, with what it starts, while it is the same process (start time; Windows only, where start times are known). It is counted, judged and learned from like the rest of the pass; Pause and Stop still act only on what is under the session's host. Two sessions detaching at the same moment claim nothing.
- **The person can extend the light list on the usage page** ("Never needs a reservation": a project and a command, kept as the kind Ledung matches). Sessions never can.

## As built (R1–R3, R5–R7)

- **Work** under a pass is its processes with CPU or GPU above the 5-point allowance, or memory grown by more than 256 MB since the last active sample. A ready pass starts (busy) when its processes are seen in two samples in a row, active in either; a parked one needs two active samples in a row, so a leftover daemon's single blip doesn't take its room back.
- **The pass ends** when the go has reached the session and then: no turn under way, no non-ambient background task (subagent or command), no process of the pass. A ready pass whose go hasn't reached the session never ends for this.
- **"Settings → Machine"** is the bar's limit editor in the sidebar's Machine panel (there is no Settings tab for it): "park after" and "tell the manager after" are next to the other averaging settings under "Spikes (all limits)", and the WSL hint shows under the bars, with a Hide that is kept on that device.
- **WSL** is read from the process list (`vmmemWSL`, or `vmmem` on older WSL): its working set. On this PC on 2026-11-20 the list Ledung reads and PowerShell's `Get-Process` both gave 5.3 GB for `vmmemWSL`; Task Manager's own column was not compared by eye.

## The parts

Session time is the work only; review and CI waits come on top.

| Part | What | Done when | Time |
|---|---|---|---|
| R1 | **The pass:** states ready, busy, parked; parking after quiet; resuming checked against the limits; ending only at release, the end of the session's work (background subagents and commands counted) or the session's end. | Unit tests for each state change. On a throwaway Ledung (Haiku, `node burn.mjs` as the job): a session reserves, runs a job, the job ends, the pass parks after 2 min and its booking leaves the bar; a second run under the same pass starts without a new `reserve`; a background subagent's job runs under the pass after the main turn has ended. A leftover idle process doesn't keep room held. | 75–100 min |
| R2 | **Subagents' answers:** a subagent's `reserve` acts on the session's pass; the refusal text for subagents. | Tests; in the try-out, a subagent's heavy command is covered by its session's pass. | 15–20 min |
| R3 | **Waking:** idle stop skips waiting and ready passes; the go's clock starts at delivery; the manager told after 30 min and at the go. | Tests for each; live: with the working limit full, a go waits in the working line without lapsing, and a session waiting over the idle time isn't stopped. | 30–45 min |
| R4 | **Light commands:** the light list; the 10-second rule (call durations kept per kind: a new entry in `MIGRATIONS`); learning only from calls under way during busy samples; the refusal says where its figure comes from. | Tests: `git status`, `gh issue view` and a 3-second script are never refused, even with old "heavy" marks present and a pass waiting; a build run beside a background loop teaches only the build. | 45–60 min |
| R5 | **WSL:** WSL's share on the memory bar and in reasons; the one-time hint. | On this PC, with WSL running, the tooltip shows a figure close to Task Manager's for "VmmemWSL" (checked read-only; whether the process list gives its size is to be checked here first). Without WSL, nothing is shown. | 25–40 min |
| R6 | **Who holds the room:** in the page's line, the sessions' answers, the manager's notice, both wordings. | Tests that a session's reason never contains another session's job name or title (`test/server-security.test.ts` style); in the try-out the page names the holder. | 30–45 min |
| R7 | **Try-out and review:** throwaway Ledung on a test port with fake jobs, the 2026-11-15 case played through (two finished jobs with leftover idle processes, a third waiting), phone width, then the usual code and security review. | The third job goes within about 2 minutes of the first two finishing; findings fixed or reported. | 60–90 min |

About **4.5–6.5 hours** of session time in all. R1 comes first; R3, R4, R5 and R6 are independent of each other and can follow in any order; one PR for all, or R4 alone first if the refusals hurt now (it is the smallest change that stops the lost worker time).

## Open choices

1. **How long quiet before a pass parks.** Shorter frees room sooner; too short parks a job between two steps of a build. **Recommended: 2 minutes**, settable in Settings → Machine.
2. **A parked pass whose work resumes and doesn't fit.** Refuse the known heavy command with the wait answer (the session does other work and is told), or hold the command in the hook for up to 2 minutes first (a subagent would just wait). **Recommended: refuse at once**, as every other wait works; it keeps turns from hanging and the working line moving.
3. **The go's 10 minutes.** **Recommended: counted from the go's delivery**, then the pass parks rather than ends (it costs nothing parked). Alternative: keep the end-and-tell of today, from delivery.
4. **Telling the manager about a long wait.** **Recommended: once after 30 minutes and again at the go**, settable; no question to Simon, who sees the line.
5. **WSL's cache.** **Recommended: show it and give the `.wslconfig` hint, keep counting it as used.** Alternatives: count the cache as free (risky: Windows gets it back slowly), or offer the optional `/proc/meminfo` reading behind a switch now rather than later.
6. **The light list fixed or settable.** **Recommended: fixed in the code**, with the existing page-only "never needs a reservation" mark for anything else. A settable list would be one more thing to keep away from sessions.
7. **Who holds the room, in sessions' words.** **Recommended: anonymous for other sessions' jobs** (counts and figures), WSL and "other programs" by name, as the approved rule on names requires. Alternative: name the session (not the job) for managers.

## Not in scope

- Changing the limits' meaning, the averaging, or what happens to a job over its share.
- Editing `.wslconfig`, shutting WSL down, or dropping Linux caches.
- Docker's virtual machine: shown in the total as now (the same "show it" idea could follow later).
- Container sessions: still no reservations.
