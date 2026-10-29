# Step 6: Machine resources — proposal (revised)

Oct 10, 2026 · Approved by Simon on 2026-10-10 (question #13) with two changes: the default limit is **10**, and a manager may set **critical** only on Simon's directive (Simon's answer to one of its questions), otherwise normal or high. Revised after Simon's answer to question #12: no project-specific "full suite" and "short run" slots; instead a limit on how many sessions may work at once, and measuring what each session uses so Ledung can learn what work costs.

**Done when** (brief section 9): four builds run without overloading the machine, and a critical one goes first.

## What step 6 delivers (wants 17–19)

- **A limit on how many sessions may work at the same time**, set by Simon and changeable at any time in the page. Above the limit, work waits its turn instead of overloading the machine.
- **CPU and memory per session**, live, including everything a session started (builds, test runs, servers), and the machine's totals, including Docker's virtual machine.
- **A record of what each turn used** (duration, CPU, memory) and what it was doing, so Ledung can slowly learn what kinds of work cost, and later estimate a new session from it.
- **Priorities:** critical work goes first when sessions are waiting.
- **Nothing frozen mid-command:** waiting happens before a turn starts.

## How it works

### The limit

- **"Working" means running a turn.** A session waiting for its next message, or for an answer, uses next to nothing and doesn't count. Managers don't count either: their turns are short coordination.
- **Default: 10 sessions working at once**, set in the config and changeable live in the page (a number next to the Machine panel).
- **When the limit is reached**, a session that would start a turn (a new message, a delivered answer, its manager's instruction) **waits before starting**. It shows "Waiting for a free place: 2nd in line"; its manager is told. When a working session finishes its turn, the next in line starts.
- **Your own messages wait too**, so the limit holds, but the waiting session gets a **Start now** button: you can always overrule the limit for one turn.
- **Order in line:** priority first (critical, high, normal), then who has waited longest.
- A turn already running is never interrupted or frozen.

### Measuring

- **Every 5 seconds**, Ledung reads the process list once and adds up, per session, the CPU and memory of its process tree: the Claude process and everything it started. Locally on Windows, macOS and Linux; for container sessions, from the session's own process group inside the container. One measuring process for the whole machine, not one per session, so measuring itself costs little.
- **Machine totals:** CPU and memory of this computer, and Docker's virtual machine (its memory limit and use).
- **Per turn, Ledung keeps:** start, duration, average and peak CPU (in cores), peak memory, the project, the model, what started the turn, and which commands ran (their first words, e.g. `npm run build`, `pytest`). That record is what estimates are learned from.

### Learning (later in this step, once there is data)

- After a couple of weeks of records, Ledung can show **typical costs per project and kind of work**: "a turn running `npm run build` in this project: about 2.1 cores and 2.8 GB for 6 minutes".
- **Next stage, not part of this step:** use those estimates to decide whether there is room, instead of only counting sessions. The record kept now is what makes that possible.

### In the page

- **Machine panel** (next to the limit meters): CPU and memory bars for this computer and Docker's VM; "2 of 3 working"; the line of waiting sessions; the limit, editable.
- **Per session:** live CPU and memory in the Overview and the session list ("1.4 cores · 2.1 GB"), and in the per-session usage panel a graph of CPU and memory over its turns.
- **Session header:** priority menu (normal / high / critical); **Pause** / **Resume** (a paused session's next tool call waits; the command already running finishes); **Start now** when waiting for a place.

### For managers

- `machine_status`: load, how many are working, the line, and per-session CPU and memory for its own sessions.
- `set_priority` and `pause_session` / `resume_session` for its own sessions. `set_priority` sets normal or high; **critical only with Simon's directive**: the manager points at Simon's answer to one of its questions (as with `forward_answer`), and Ledung records "critical, on Simon's answer to #N".
- Ledung tells a manager when one of its sessions has waited for a place for more than 10 minutes.

## The parts, in order

| Part | What | Done when |
|---|---|---|
| 6a | Measuring: per-session CPU and memory (local and in containers), machine totals, the Machine panel, live figures in the Overview and session list. | A session running a build shows its CPU and memory rising and falling; on Windows and macOS (CI). |
| 6b | The limit and the line: waiting before a turn, Start now, priorities, Pause/Resume, the manager tools. | With the limit at 2, a third session waits and starts when one finishes; a critical one goes before a normal one already waiting. |
| 6c | The per-turn record, and typical costs per project and kind of work in the usage page. | Each turn's duration, CPU and memory are stored and shown. |
| — | The done-when test, on a throwaway project with a deliberately heavy fake build. | Four builds run without overloading the machine, and a critical one goes first. |

## Decisions for Simon

1. **The limit counts sessions working at the same time** (recommended), not sessions that exist; managers don't count.
2. ~~Default limit 3~~ — decided: **10**, changeable live.
3. **Your own messages wait too, with a Start now button** to overrule the limit for one turn (recommended); or your messages never wait.
4. **Priorities normal / high / critical**, set by Simon; managers set normal or high for their own sessions, and critical only with Simon's directive (decided).
5. **Pausing only by hand** (recommended).
6. **Estimates shown first, used for decisions later** (recommended): Ledung learns and shows typical costs in this step; letting them drive the limit is a later decision, once the numbers have proven themselves.

## Progress

| Part | Status (2026-10-10) |
|---|---|
| 6a Measuring | Done (`src/platform/processes.ts`, `src/platform/containers.ts`, `src/resources/monitor.ts`). Every 5 s one process list for the whole machine (Windows: one long-running PowerShell; macOS and Linux: `ps`); per session the process tree under its host; in containers, the session's process group from `/proc`; the machine from the OS; Docker's VM every 30 s via `docker info` and `docker stats`, only when the config has a container project. Machine panel in the sidebar; CPU and memory per session in the list, the Overview and the session header. |
| 6b Limit and line | Done (`src/resources/line.ts`, the scheduler in `SessionManager`). Limit in the config (`maxWorkingSessions`, default 10), changed live in the Machine panel (kept in the database). Status "Waiting for a free place" with its number in line; Start now; priority menu; Pause / Resume (a `PreToolUse` hook holds the next tool call). Manager tools `machine_status`, `set_priority` (critical only with `user_question`: Simon's answer to one of the manager's own questions), `pause_session`, `resume_session`; a manager is told when one of its sessions has waited 10 minutes. |
| 6c Per-turn record | Done (`turn_resources` table, `src/resources/commands.ts`, `src/resources/typical.ts`). Per turn: start, duration, CPU seconds (average cores), peak cores, peak memory, project, role, model, what started it, and the kinds of command it ran (`npm run build`, `pytest`, …; looking-around commands left out). Shown per session in its usage panel, and as typical costs per project and command on the usage page. |

Checked live (Haiku, throwaway Ledung, limit 2, a fake build that keeps workers busy and holds memory): four builds started, two worked and two waited; the one set to critical was first in line though it started waiting last, and both started as the first two finished. Memory per session rose by the build's 300 MB and fell back; each turn was recorded with its command (`node burn.mjs`) and the typical cost shown. Pause held the next command for over 10 s and it ran right after Resume; Start now started a waiting session above a limit of 1; a manager's `set_priority` critical without a directive was refused, high was accepted, and `machine_status` answered.

Not checked: CPU above one core. In this test environment the processes I start get about 0.4 of a core each, and Ledung's figures matched that (cross-checked against Windows' own counters and Node's). Also not checked: macOS and Linux measuring (CI runs the parsers only), container sessions (no throwaway container yet), Docker's VM figures (no container project in the test config), the 10-minute notice to a manager (covered only by reading the code), and the page in a browser.
