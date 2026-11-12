# Resource limits: CPU, memory and GPU

Nov 12, 2026 · **Approved (Simon, 2026-11-12, #1894)**: "b — Approve, and build it as a normal PR", with all ten recommendations under Open choices. Agreed in chat with Simon 2026-11-12 before that. Builds on step 6 ([step-6.md](step-6.md)): the Machine panel's bars, per-session CPU and memory over each session's whole process tree (#169), the "N of 10 working" limit and its line, priorities, Pause/Resume, and the per-turn record with typical costs.

## In short

- Simon sets **limits on CPU %, memory (GB), GPU load % and GPU memory (VRAM)** by clicking the bars in the sidebar. The limits are for the **whole PC**, games and all.
- **Before heavy work a session reserves it** with a `reserve` tool. Ledung answers **go**, or **wait** with a place in line; the session does other work meanwhile and is told when it may go. Light work reserves nothing.
- **Starting** is judged against the whole PC; **running** is judged only against the job's own reservation. A game Simon starts never makes running jobs stop; it only makes new ones wait.
- **A job that stays over its own share** is slowed (lower OS priority), its session held and told to cut back. **Nothing is killed or suspended automatically.**
- Ledung **learns** what each kind of job really uses, uses that instead of the guess next time, and can require a reservation for commands it knows are heavy.

The "N of 10 working" limit from step 6 stays as it is; both apply.

## Why this is Ledung's job

By [workflow-fit.md](workflow-fit.md)'s principle, *Ledung does the mechanical things; judgement stays with the AI*. Adding up what the PC uses, keeping a line, watching averages and lowering a priority are mechanical, easily lost by a model, costly when missed ("a fifth build on a machine that takes four") and common to every project. Deciding *what* is heavy, *how much* to ask for and *how* to cut a job back are judgement: the session's. So Ledung keeps the numbers and the line; the session declares, and reduces or stops its own job when told.

## The model

### Limits

- Four limits, each optional: **CPU %** of the whole PC, **memory in GB**, **GPU load %**, **GPU memory in GB**. No limit set: that resource is not checked.
- They apply to **the whole PC**: everything running counts, not only Ledung's sessions.
- Set only from the page (see Security), kept in Ledung's database like the working limit, and shown as a line on each bar.
- **When a limit changes, Ledung re-checks the line at once**: raising it can let waiting jobs go straight away.

### Two checks: starting and running

**Starting a job (admission).** A reserved job may start when, for every resource it asks for:

> PC's averaged total now + reserved-but-not-yet-used by jobs already going + this request ≤ the limit

"Reserved but not yet used" is, per running job, its reservation minus what it uses now (never below 0), so a job that has reserved 8 GB and so far uses 2 GB still holds 6 GB. If it doesn't fit, **the job waits in line. It never fails outright**: a job asking for 100% GPU under a 50% limit waits until Simon raises the limit, and says so.

**A running job** is judged only against **its own reservation**, never the total. If Simon starts a game and the PC goes over a limit, jobs within their own share carry on; only new starts wait.

### Averaging, so spikes don't count

- Every decision uses a **moving average**, default **30 s** (six of the 5-second samples step 6 already takes).
- A running job counts as **over its share** only when its average stays above its reservation **plus a margin** (default **+10 points**) **for a while** (default **1 minute**).
- All three are settable in Settings → Machine.

### A job over its own share

Without asking Simon, in this order:

1. **Lower the priority** of the job's process tree (OS priority: below normal on Windows, `nice` on macOS and Linux), including processes it starts later;
2. **hold its session**: no new steps (see open choice 1 for exactly what that blocks);
3. **tell the session** to reduce or cleanly stop its job, with the numbers ("your job 'train model' reserved 40% GPU and has averaged 72% for 2 minutes");
4. **put everything back** (priority and hold) when its average is within its share again.

**Never kill or suspend automatically.** Simon can pause or stop a job himself from its card. A priority only shares out CPU time: it does nothing for memory and very little for the GPU, so for those the session's own action (step 3) is what actually helps; the card says so.

### Undeclared heavy work

Work run without a reservation counts as reserving almost nothing: the session's usual footprint (its learned figure, see "New sessions") plus a small allowance (default 5 points of CPU and GPU, 0.5 GB of memory and of VRAM). Sustained use above that is handled exactly as above, and the session is also told: "this looked like heavy work: reserve it next time". Ledung records the command's kind, so next time the PreToolUse check can ask for a reservation (below).

### New sessions under a memory limit

When a memory limit is set, **starting a new Claude session must fit too**, by the same sum. Each new session counts as **~1 GB** at first, then as Ledung's measured figure for its kind (project and role). If it doesn't fit, the session waits in the line with "Waiting for memory: a new session needs ~1.2 GB, 0.4 GB left under the 48 GB limit".

### The line

- One line for reservations and new sessions, in step 6's order: **priority first (critical, high, normal), then who waited longest.**
- A waiting entry holds back only later entries that need the **same resource** it waits for (open choice 5): a CPU job need not wait behind a GPU job that is waiting for the GPU.
- **Start now** on an entry, as in step 6: Simon can let one go above the limits.
- **A go not used lapses**: if no new process appears in the session within 10 minutes of the go, the reservation is released and the session told.

## The tools

Two tools for local sessions (container sessions are out of scope). The text is kept short since every session carries it.

**`reserve`**

> Before heavy work (a long build, a big test suite, training, rendering: many cores for minutes, several GB of memory, or the GPU), reserve it. Light work needs none. `what`: a short name for this kind of job; use the same name next time. Give what you expect at its busiest: `cpu` (% of this PC, which has {threads} threads), `ram_gb`, `gpu` (% load), `vram_gb`, `minutes`. The answer is **go**, or **wait** with your place in line: then don't start it; do other work, and Ledung tells you when you may go. Released when you call `release`, when the job's processes end, or at the end of your turn if none are running.

Parameters: `what` (required, ≤ 60 characters), `cpu`, `ram_gb`, `gpu`, `vram_gb`, `minutes` (all optional numbers). One reservation per session at a time; reserving again replaces the waiting one, or adds to a going one (it is judged again as a start for the extra).

Answers, one line each:

- `Go: reservation r12 "train model", 40% GPU, 6 GB VRAM (learned from 5 runs; you asked 20%).`
- `Wait: 2nd in line for the GPU. Needs ~100% GPU, limit 50%: Simon must raise it. Do other work; Ledung will tell you.`

**`release`**: ends the session's reservation now. No parameters.

**The go**, when it comes later, arrives as a Ledung message to the session: "You may go: reservation r12 'train model' (40% GPU, 6 GB VRAM)". It joins the session's message queue like a manager's message, so it starts a turn under the step 6 working limit.

**Which processes are the job:** those that appear in the session's process tree after the go (from the tree #169 already tracks, including processes that leave it), not Claude Code itself or the MCP servers it already had. A job "ends" when all of them have exited.

**Managers:** `machine_status` adds the limits, the reservations of the manager's own sessions (reserved, using, state) and the line with reasons. Managers get no tool to change limits or reservations.

## What's shown

**The bars** (Machine panel, sidebar):

- CPU and Memory as now, plus **GPU** and **GPU memory** for the PC's main GPU (open choice 6 for several).
- Each bar shows **used** (solid), **reserved but not yet used** (hatched, after it) and the **limit as a line**.
- **Click a bar** to set its limit: a small popover with a number, a slider and "No limit". On a narrow screen (phone) it opens full width under the bar. The bar's tooltip says "Limit 50% · 38% used · 12% reserved".
- **No GPU readings:** no GPU bars; one muted line instead, "GPU limits off: <why>" (for example "this PC's GPU readings aren't available: Windows' GPU performance counters returned nothing").

**The line** (under the bars), each entry with its reason and place:

- "train model · Waiting for GPU room: needs ~100%, limit 50%" (asks more than the limit: only raising it helps);
- "render tiles · Waiting for memory: needs 12 GB, 9 GB left under the 48 GB limit · 2nd in line";
- "New session (Project X) · Waiting for memory: needs ~1.2 GB".
- Start now, as for the working line.

**Job cards**, one per going reservation, under the line: session name (a link), `what`, and a small pair of bars per reserved resource (**reserved vs using**, 30 s average); its state: *going*, *over its share for 2 min: priority lowered, session held, told*, or *back within its share*. Buttons: **Pause** (suspends the job's processes; its memory and VRAM stay taken), **Resume**, **Stop** (ends the job's processes, after a confirm; the session is told). These act only on Simon's click. The `what` text comes from a session and is shown as plain text.

**Undeclared heavy use** shows as a card too, titled "Unreserved: <session>".

## Measuring the GPU per OS

Same pattern as step 6: one measuring process for the PC, every 5 s, cumulative counters turned into rates by differences.

### Windows (NVIDIA, AMD, Intel alike)

Windows' WDDM GPU performance counters, per process, from any driver:

- **Load:** `Win32_PerfRawData_GPUPerformanceCounters_GPUEngine`, field `RunningTime` (cumulative, 100 ns), one row per process × GPU × engine (`pid_<pid>_luid_<luid>_phys_0_eng_<n>_engtype_<3D|Copy|VideoDecode|Compute…>`). Per sample: the difference ÷ elapsed time gives each engine's busy share. **A GPU's load** = for each engine, the sum over processes; then the busiest engine (as Task Manager does). **A job's load** = the same over its processes only.
- **Memory per process:** `Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory`, field **`LocalUsage`** (dedicated memory on that GPU).
- **The GPU's total use:** `…_GPUAdapterMemory`, field `DedicatedUsage`.
- **Which GPU is which, and its size:** DXGI's adapter list (name, LUID, dedicated memory), read once when measuring starts; software adapters skipped.
- Read inside the existing long-running PowerShell loop (`src/platform/processes.ts`), so no new process.

**Checked on this PC** (2026-11-12, Windows 11, NVIDIA RTX 4090 24 GB + AMD Radeon integrated, read-only probes from PowerShell scripts, no GPU load started):

| What | Result |
|---|---|
| Counter sets present | GPU Engine, GPU Process Memory, GPU Adapter Memory, GPU Local/Non Local Adapter Memory |
| `Get-Counter '\GPU Engine(*)\Utilization Percentage'` | Works, but took **20 s** for 1031 instances: **too slow** for a 5 s loop |
| CIM raw class `…_GPUEngine` (`RunningTime`) | **80–190 ms** for ~1020 rows; differences over 5 s gave the 4090's 3D engine 10.7%, Copy 4.1%, VideoDecode 1.9% (a video player and the desktop) |
| CIM *formatted* class `…_GPUEngine` | Whole numbers per row: many small figures round to 0 (3D showed 3% where the raw differences gave ~11%). **Use the raw class.** |
| Per-process `DedicatedUsage` | **Wrong on this driver**: 4.7 TB for a video player, 114 GB for NVIDIA Overlay on a 24 GB card. **Don't use.** |
| Per-process `LocalUsage` | Plausible (video player 0.87 GB, desktop 0.52 GB); sum over processes 4.5 GB |
| Adapter `DedicatedUsage` | 7.34 GB, against nvidia-smi's 6976 MiB (7.31 GB): **matches**. The ~2.3 GB more than the processes' sum is the driver's and system's own, so the PC total comes from the adapter, jobs from their processes. |
| `Win32_VideoController.AdapterRAM` | Says 4 GB for the 4090: capped (a 32-bit field). **Don't use.** |
| DXGI adapter list (C# via `Add-Type`, 230 ms once) | RTX 4090, 25.3 GB, and the AMD at 0.5 GB, with the LUIDs the counters use; Microsoft Basic Render Driver flagged as software |
| nvidia-smi | Present; total load and memory work, but **per-process memory is `[N/A]` for every process** under Windows' driver model, so it can't serve per-job figures here |
| nvidia-smi load vs WDDM | Not comparable at light load: nvidia-smi read 13% then 51% at either end of a 5 s window in which WDDM's 3D engine averaged 10.7%. nvidia-smi samples a short moment and counts "any kernel running". **Not checked under real GPU load** (not started, as asked); part L1's done-when does it. |

PC size for reference: 16 threads, 63 GB memory.

### Linux

- **NVIDIA:** `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total` for the GPU; per process `nvidia-smi --query-compute-apps=pid,used_memory` and `nvidia-smi pmon -c 1` for load.
- **AMD and Intel:** the kernel's per-process DRM figures in `/proc/<pid>/fdinfo/*` (`drm-engine-*` busy time, `drm-memory-vram`), readable for one's own processes without root; for AMD's totals `/sys/class/drm/card*/device/gpu_busy_percent`, `mem_info_vram_used`, `mem_info_vram_total`. Intel integrated GPUs have no VRAM of their own: no VRAM bar.
- Not checked here (no Linux PC); CI runs the parsers on sample output.

### macOS

- Apple Silicon shares memory between CPU and GPU: **no VRAM bar**; GPU memory counts in Memory.
- GPU load for the whole PC from `ioreg` (the accelerator's "Device Utilization %"), without root. **Per process, GPU use isn't readable without root**, so a job's GPU share can't be checked there: the GPU limit still holds back new starts, and the job card says "GPU per job not measured on macOS".
- Not checked here.

### No readings

If none of the above gives figures, the GPU limits are off, the bars hidden, and a note says why. Ledung never guesses GPU figures.

## Learning

A new table (a new entry in `MIGRATIONS`), one row per finished reservation: project, `what` (the kind), the command kinds it ran (`src/resources/commands.ts`), what was asked, what was measured (peak of the 30 s average and mean, per resource, over the job's processes only), duration, and whether it went over its share.

- **Next time** a session reserves the same kind in the same project, Ledung uses the learned figure once it has **3 runs**: the 90th percentile of the measured peaks, plus the margin. The answer says so ("learned from 5 runs; you asked 20%").
- **Under-declared jobs** are noted on the usage page beside step 6c's typical costs: "train model: asked 20% GPU, used 72%".
- **New sessions' footprint** comes from the same kind of record, per project and role.
- Kept like the per-turn record; the usage page shows it, and Simon can forget a kind (one button) if a guess was learned from a bad run.

## Recognising heavy commands

The `PreToolUse` hook (`src/sessions/session.ts`) already sees every Bash call. With this:

- Ledung splits the command into kinds as step 6c does (`npm run build`, `python train.py`).
- If a kind is **known heavy** (it was reserved before, or ran undeclared over its allowance, at least twice) and the session has **no reservation going**, the call is **refused with a reason**: "This usually uses ~70% GPU and 6 GB VRAM ('train model'). Call `reserve` first." The session reserves and runs it once it may. No question to Simon.
- A session with a reservation going runs its commands untouched.
- Simon can mark a kind "never needs a reservation" on the usage page.

## Security

- **A session can't change limits** and has no tool for it; nor can a manager.
- **A session can only reserve and release its own**; it can't see or touch other sessions' reservations. A manager sees its own sessions' reservations in `machine_status`, nothing more.
- **Limits, Start now, and a job's Pause, Resume and Stop are set only from the open page**, through the API's usual guards (Host check, sign-in cookie, Origin check on changes), like the working limit today. A linked computer's limits are set in that computer's own page.
- A session asking for too much can't block others: an entry blocks only later entries for the same resource, a go not used lapses, and every reservation is on a card for Simon to see.
- The reservation's `what` is session-written text: shown as plain text, length-capped, and never used as a command.

## The parts

| Part | What | Done when |
|---|---|---|
| L1 | **GPU measuring**: Windows (WDDM counters in the PowerShell loop, DXGI for names and size), Linux (nvidia-smi, DRM fdinfo, amdgpu sysfs), macOS (ioreg, PC only); per-session GPU figures; GPU and GPU memory bars; the "no readings" note. | On this PC, the bars show the 4090's load and VRAM within a few points of Task Manager, at idle and under a throwaway GPU load run in a test session (with Simon's OK to start one), and the test session's own figures rise with it; the measuring loop's time per sample stays under 0.5 s. Parsers tested on sample output for all three OSes. |
| L2 | **Limits on the bars**: click to set, the line, used vs reserved, persisted, re-check on change; the averaging settings. | A limit set on each bar shows as its line, survives a restart, works on a phone-width screen, and can't be set by any session or manager tool or without the page's guards (`test/server-security.test.ts`). |
| L3 | **`reserve` and `release`, admission, the line**: reasons, Start now, the go message, release rules, lapse, job cards with Pause/Resume/Stop. | On a throwaway Ledung (Haiku): with a CPU limit of 50%, a job reserving 40% goes and a second reserving 30% waits with its reason and starts when the first ends; a request above the limit waits until the limit is raised, then goes at once; the waiting session does other work and is told when it may go. |
| L4 | **Running share**: over detection with the average, margin and duration; priority lowered and restored; hold; telling the session; undeclared work. | A fake job reserving 10% CPU that uses 40% is, after a minute, lowered, held and told; when it drops back, all is restored; no process is ever killed or suspended. A short spike above its share changes nothing. |
| L5 | **New sessions under a memory limit**. | With a memory limit just above current use, a new session waits with "Waiting for memory" and starts when room appears. |
| L6 | **Learning and recognition**: the record, learned figures in answers, under-declared notes, the PreToolUse refusal. | After 3 runs of a fake job declared too low, the next reserve answer uses the learned figure, and running its command without a reservation is refused with the reason. |

L1 can be built and released on its own (it only shows figures). L2 and L3 belong together; L4 to L6 follow.

## Open choices

1. **What "hold its session" blocks.** Holding every tool call (as Pause does) would also block the command the session needs to reduce or stop its job. **Recommended:** while held, no new turn starts, no new reservation is granted, and known-heavy commands are refused; other tool calls go on, so the session can act on what it is told.
2. **A background job at the end of a turn.** Releasing at turn end would leave a job run in the background unreserved, so it would soon count as undeclared. **Recommended:** the turn's end releases only when none of the job's processes still run; otherwise the job keeps its reservation until they end or `release` is called.
3. **The margin for memory.** "+10 points" reads naturally for CPU and GPU %; for memory it would be 6 GB on this PC. **Recommended:** for memory and VRAM, 10% of the reservation, at least 0.5 GB.
4. **CPU in the tool as % of the PC or as cores.** **Recommended:** % of the PC, like the bar and the limit, with the thread count in the tool text so a session can convert ("8 busy threads of 16 = 50%").
5. **Order in the line.** Strict order is simple but lets one big GPU job hold up every small CPU job behind it. **Recommended:** an entry holds back only later entries that need the same resource it is waiting for.
6. **Several GPUs** (this PC has the 4090 and an AMD integrated GPU). **Recommended:** bars and limits for the GPU with the most dedicated memory; others behind a "more" fold, with their own limits; `reserve` names a GPU only on PCs with more than one usable GPU.
7. **Lowering priority on macOS and Linux.** An ordinary user can lower a process's priority but not raise it again, so "put it back" isn't possible there. **Recommended:** lower it anyway (`nice` 10) and say on the card "stays lowered until the job ends; this OS doesn't let Ledung raise it". The alternative is not lowering on those OSes (hold and tell only).
8. **Learned figure or the session's guess.** **Recommended:** the learned figure after 3 runs, whichever way it differs, and say so in the answer (as agreed); before that, the session's guess.
9. **When a go lapses.** **Recommended:** 10 minutes without a new process in the session.
10. **Pause on a job card.** **Recommended:** suspends the job's processes on Simon's click (Windows by the processes' threads, macOS and Linux by `SIGSTOP`/`SIGCONT`), with "memory and VRAM stay taken" next to the button; the session is told it was paused by Simon.

## Not in scope

- **Disk.**
- **Docker and container projects**: neither measured for GPU nor limited; `reserve` is offered to local sessions only. Docker's virtual machine still shows in the PC's totals as it does now.
- **The quick "I'm using the PC" switch**: v2.

## Progress

| Part | Status (2026-11-12) |
|---|---|
| L1 GPU measuring | Done (`src/platform/gpu.ts`, in the measuring loop of `src/platform/processes.ts`). Windows: the raw CIM classes and DXGI, as checked above, with a 10 s timeout per read, a retry after a failed read, the adapter list read again every 60th round, and a watchdog that restarts a loop that stops sending. Linux and macOS: parsers tested on sample output only. |
| L2 Limits on the bars | Done (`web/src/usage/MachinePanel.tsx`). A GPU's limit is kept by the GPU's name, since Windows gives a GPU a new id at each reboot. |
| L3 Reserve, the line, cards | Done (`src/resources/book.ts`, `src/resources/limits.ts`, the `reserve` and `release` tools). |
| L4 Running share | Done. |
| L5 New sessions under a memory limit | Done (sessions and chats; managers and container sessions don't wait). |
| L6 Learning and recognition | Done (`src/resources/jobs.ts`, tables `job_runs` and `command_marks`; usage page "Reserved jobs"). |

**Changed while building, from the two security reviews and the try-out:**

- **Unreserved work** is the session's whole tree that isn't a reserved job, Claude Code included, against its footprint (learned per project and role, ~1 GB at first) plus the allowance. Measuring only what the session started, against the allowance alone, held sessions for their own MCP servers, and let a heavy process started just before a tiny reservation go unjudged.
- **Managers** are never asked to reserve and never held: they have no `reserve` tool.
- **A request above the limit itself** holds back no one in the line; requests above the PC's own memory or the GPU's are refused.
- **Sessions and managers never see another session's job name or title** in a reason ("Waiting behind another job"); the page does.
- **A job's name can't start with `session:` or `(`**, which the learning store keeps for itself.
- **Only shell calls that ran 10 s or more, or in the background, are learned as a job's commands**, so `git status` between two builds never becomes "heavy". The heavy-command check also looks inside `bash -c`, `nohup`, `env`, `cmd /c` and the like, and covers the Monitor tool. It stays advisory: a script file can hide a command; what really runs is judged by the check of each job's share.
- **While held,** the person's answers to the session's questions also go in, besides the person's messages and Ledung's notices.
- **Pause, Resume and Stop** act only on processes still under the session's host in a fresh process list, and on Windows only on a handle whose start time matches Ledung's record. A second Pause is refused (Windows counts suspends). A paused job that ends is resumed.
- **A lowered priority is put back** only on the same process (start time), and only if it is still at Ledung's level; priorities lowered before a restart of Ledung are put back at the next start. On Linux each thread is lowered.
- **Windows' console host** (`conhost.exe`, which Claude Code gets at its first shell call and keeps) is never part of a job: it kept a reservation "running" forever in the try-out.

**Checked live** (throwaway Ledung on port 4396, Haiku sessions, `node burn.mjs` as the fake job, on this PC while other programs kept its CPU near 100%):

- A reserved CPU job: it waited under a 60% CPU limit ("needs ~25%, 13% left under the 60% limit"), went when the limit was taken off, and its card showed its own share (about 10% CPU and 0.4 GB; the busy PC gave its 4 workers about 1.6 cores).
- A job over its share: reserving 0.5 GB and holding 2 GB, it was lowered and held after the set time, the session was told, and when it let the memory go it was put back and told so; it was released when its process ended.
- A queued job starting when a limit is raised: a job asking 80% GPU under a 50% limit waited with "only a higher limit lets it start", and was told "You may go" as soon as the limit went to 100%.
- A new session under a memory limit: it waited ("needs ~0.3 GB", the footprint already learned from the earlier sessions), started by itself when memory freed up, and in a second run started within seconds of the limit being raised; its first message came after the start.
- Pause, a second Pause (refused), Resume and Stop from a job's card, through the page's API. Suspend, resume, priority and end were also checked on a throwaway process directly, including that a wrong start time is refused.
- GPU readings: both GPUs of this PC read in the loop (the 4090's load 7–20% and 5–7 GB, the integrated AMD), the software renderer left out.

**Not checked:** a GPU job's own figures under real GPU load (no GPU load was started, as asked; only the PC's readings at its normal load); CPU over-share live (this PC's other load kept a CPU job to about 1.6 cores, so the over-share case was run with memory; CPU over-share is covered by the tests); Linux and macOS measuring and priorities (parsers and logic tested only); the learned figure and the heavy-command refusal live (unit tests only); the usage page's "Reserved jobs" in a browser.
