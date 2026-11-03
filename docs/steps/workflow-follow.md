# Workflow part 3: Ledung follows the flow — proposal

Nov 3, 2026 · Proposed by Simon's manager; Simon's answers of 2026-11-03 folded in (who starts a run, on by default, built privately first).

**Done when:** a real piece of work on a throwaway project moves through a drawn flow from its first block to an ending, with its position shown live on the workflow page, each block's session started (or continued) the way the block says, person blocks put to the person as questions and reviews, and "the 3rd time" counted by Ledung; and a "Run flow" block runs another flow and takes its ending.

## Why

Parts 1–2e made a workflow something you can draw, edit and read: `.ledung/workflow/` holds the flows, briefs, rules and the manager's procedures, and the manager is told to follow them. But following is still the manager reading prose and keeping track in its head: which piece of work is where, how often a review has failed, which session did the build. A long run, a resume or a compaction loses that, and nobody can see it.

## What stays as decided

- **The manager routes; Ledung doesn't match words** (2026-10-26, #1184): the manager reads a step's result against the block's outcomes and says which outcome it was. Ledung never picks the arrow from text.
- **No locks** (2026-10-26, #1183): the workflow guides; the person's word overrides it. Hard rules stay outside the workflow (sensitive patterns, away mode).
- **What Ledung keeps for certain:** where each piece of work is, how many times each outcome has happened, which session ran each block — the facts an LLM forgets.

## A piece of work

A **run**: one piece of work going through one flow.

| Field | What |
|---|---|
| id | Ledung's own, e.g. `run-12` |
| title, ref | what it is: "Fix the cart total", optionally an issue or PR reference (`#142`, `PR #143`) |
| flow | which flow it runs in (the project's main flow unless one is named) |
| at | the block it is in now |
| counts | how many times each outcome word has happened at each block (for `times`) |
| sessions | which session ran each block (so a later `continue` knows where to go) |
| parent | for a run started by a Run-flow block: the run and block that wait for it |
| history | each step: block, outcome word, who reported it, when |
| state | running · waiting for a person · ended (with its ending word) · stopped |

Runs live in Ledung's database (a new migration), per project, and are shown on the page; nothing about a run is written into the project's files.

## How a run moves

The manager gets three tools (only when its project has a flow and following is on). **Any session** of the project gets `flow_start` too, for when the person asks it ("run this workflow on …"); a run is coordinated by whoever started it: usually the manager, else that session (Simon, 2026-11-03).

- **`flow_start(title, ref?, flow?)`** starts a run at the flow's start block and returns what to do there.
- **`flow_step(run, outcome)`** reports how the current block ended, by the outcome's word (the manager chooses it, reading the result). Ledung records it, counts it, picks the outcome (the counted one when this is its Nth time, else the plain one), moves the run and returns **what to do at the next block**.
- **`flow_status(run?)`** shows where runs are, their counts and history.

"What to do at the next block" is concrete, from the block itself:

| The block runs as | What Ledung does / tells the manager |
|---|---|
| **new session** | Ledung starts the session itself with the block's model, profile, brief and sub-steps, and the run's title/ref and the previous step's report as the handoff; the run records the session. |
| **continue** | Ledung sends the block's brief and the handoff to the session that ran the named block, resuming it if it ended. |
| **manager** | Tells the manager the block's brief: it does the step itself, then reports with `flow_step`. |
| **person** | Ledung puts it to the person: `ask: review` becomes a review page, `ask: question` a question whose options are the block's outcome words; the answer moves the run by itself (no manager step), and the manager is told. |
| **Run flow** | Ledung starts a child run in the named flow; the parent waits; when the child ends, its ending word is the parent block's outcome and the parent moves on. |

A session started for a block is told which run and block it serves and the outcome words to end its report with, so the manager can read the result easily; the manager still decides.

## What you see

- **Workflow page:** a marker on each block with the runs in it (title or ref), a count badge on counted pins ("Failed 2 of 3"), and a **Runs** list beside the rules: each run's flow, block, state and history; clicking one highlights its path.
- **Sessions:** a session started for a block shows its run and block in its header.
- **Waiting for you:** person blocks' questions and reviews show their run and block.

## Turned on per project

**Follow the workflow** is a project setting, **on by default** (Simon, 2026-11-03: "Everyone needs a workflow"). It only acts in a project that has a flow; a project without `.ledung/workflow/` is unchanged. Switched off, part 1–2 behaviour stays (the manager reads the flow as instructions).

## Small format additions (from the three ports)

Each port (an agent-workflow process, a game project, a work project's build pipeline) hit the same few gaps. These fit part 3 and are small:

1. **Which person:** a person block may name who (`person: "the owner"`, `"a code owner"`); shown on the block and in the question. Ledung still asks this computer's person; the name tells them whose call it is.
2. **Waits:** a `wait` block (a merge queue, CI, someone else's approval): the run sits there until the manager reports its outcome; shown as waiting, with how long.
3. **Parallel sub-steps:** a block's sub-steps may be marked to run at once (four reviewers), their results merged into one report.
4. **A sub-flow continuing its caller's session:** a Run-flow block may hand its session to the called flow (`session: "caller"`), so phases of one long session can be flows of their own.

Later, not in part 3: conditions on outcomes, compound or free-interval timers, batches (one step for many pieces of work), intake from a tracker (part 5).

## Not in this

- Ledung judging results or matching words; locks.
- Ledung doing the work itself.
- Starting runs from GitHub issues (part 5).

## Decisions for Simon

1. **Who starts a run?** *Decided 2026-11-03:* the manager usually, and any session when the person asks it to; no Start button.
2. **Person blocks answered by you move the run by themselves?** *Recommended:* yes, the answer's word is the outcome, and the manager is told. Alternative: the manager reports it.
3. **Sessions for "new session" blocks started by Ledung itself?** *Recommended:* yes, with the block's settings, so the manager can't get them wrong; the manager can still steer them. Alternative: Ledung tells the manager what to start.
4. **On by default** (decided 2026-11-03), acting only where a flow exists; switchable per project.
5. **The four format additions in part 3?** *Recommended:* yes. Alternative: part 3 without them, additions later.

## Parts

| Part | What | Done when |
|---|---|---|
| 3a | Runs: database, `flow_start` / `flow_step` / `flow_status`, counts, history; the project switch; the manager's instruction line. | A run started by a manager moves through Ledung's example flow, the 3rd "Failed" taking the counted outcome. |
| 3b | Blocks act: new-session and continue sessions started from the block, person blocks as questions/reviews moving the run, Run-flow child runs. | The same run gets its sessions started by Ledung and a review answered by the person moves it on. |
| 3c | The page: markers, counts on pins, the Runs list, run/block in session headers and questions. | Screenshots at 1280 and 390 px with two runs in different blocks. |
| 3d | The four format additions. | Each drawn, checked and followed in a test flow. |

## How it is built

On branches kept local and backed up to the private repository only; nothing goes to the public repository or npm until Simon has tried it and says so (Simon, 2026-11-03). He tries it in a preview Ledung, or on his own Ledung from a locally packed build (`npm run pack`, installed over the dev build; back with `npm install -g ledung@dev`). Then it becomes a PR on the public repository and a dev build.
