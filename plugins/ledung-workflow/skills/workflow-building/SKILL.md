---
name: workflow-building
description: How to build or change a project's Ledung workflow (.ledung/workflow): the flow format, block kinds, outcomes and counts, sub-steps, Run flow, good briefs, examples; and proposing it with flow_propose. Use when asked to set up, port or change a workflow or process.
---

# Building a Ledung workflow

A project's workflow is a folder in its repository, `.ledung/workflow/`. You never write it yourself: you **propose** the files with `flow_propose(changes, why)`. Ledung checks them and puts the change to the person as a review with before and after diagrams; **Accepted** saves it, **Changes needed** comes back to you with the note. Never change the process you follow without the person's say, even when asked in words: propose, the person accepts.

Read the current files first with your own file tools (`.ledung/workflow/flow.json`, `flows/*.json`, `rules.md`, `manager.md`, `briefs/`), then propose only what changes.

## The folder

```
.ledung/workflow/
  flow.json        the default flow ("main")
  flows/<name>.json  other flows (name: lower case, digits, "-")
  rules.md         standing rules every session reads
  manager.md       the manager's standing procedures between steps (named by flow.json's "manager")
  briefs/<name>.md how one step is done; blocks and sub-steps may share one
  overlays/<name>.md optional switchable additions
```

`flow_propose` writes only these files. Each text is at most 256 KB, all together 4 MB. Nothing may be tied to one computer: no absolute paths, drives or `/home/...` (a path from the home folder, `~/...`, is fine); models and profiles by name.

## flow.json

```json
{
  "version": 1,
  "title": "Code change",
  "start": "issue",
  "manager": "manager.md",
  "blocks": [ ... ],
  "overlays": [],
  "frames": []
}
```

`start` is where work enters (default: the first block). `overlays` and `frames` may be left out.

Keep what is drawn: leave each block's `at` (its place on the canvas) and the `frames` as they are, and give a new block an `at` near its neighbours. Frames are rectangles where they say; when the blocks have no `at`, the page lays them out itself, and adding or removing a block moves the others, perhaps out of their frames (the review says so; the person can Auto-arrange in the builder after saving).

## A block

| Field | What |
|---|---|
| `id` | lower case, digits, "-"; outcomes use it |
| `kind` | `work`, `check`, `person`, `fork`, `join`, `timer`, `flow` (Run flow), `wait` |
| `title` | its name in the diagram (at most 80 characters) |
| `runs` | who does it: `manager`, `new-session`, `continue` (with `continues`: the earlier block whose session takes this step), `person` |
| `model`, `profile` | for a session: `opus`, `sonnet`, `haiku`; a session profile by name |
| `brief` | `briefs/<name>.md`: how the one doing it acts and what counts as done |
| `substeps` | subagents the block's one starts (below) |
| `parallel` | `true`: its sub-steps run at once, results merged into one report |
| `outcomes` | where the work goes next (below) |
| `ask` | person blocks: `"question"` or `"review"` |
| `person` | person blocks: whose call it is, e.g. `"the owner"` |
| `flow` | Run flow blocks: the flow it runs (`"main"` for flow.json) |
| `session` | Run flow blocks: `"caller"` hands the latest work step's session to the flow it runs |
| `timer` | timer blocks: `{ "every": 30, "of": "merges" }` or `{ "clock": "daily" }` |

What each kind is for:

- **work**: someone does something (build, write, fix). Usually `runs: "new-session"` with a brief.
- **check**: someone judges work (code review, tests). A check must not `continue` the session of the work it checks: the author would review their own work. Give it its own `new-session`; for the author's own look over their work, use a check **sub-step** inside the work block.
- **person**: the person decides. `ask: "review"` shows a review page answered "Accepted." or "Changes needed: …"; `ask: "question"` asks with the outcome words as buttons. Its outcomes are the answers; the answer moves the work by itself.
- **wait**: the work waits on something outside the flow (CI, a merge queue, someone else's approval) until the manager reports how it came out. Nobody runs it; a brief may say what it waits for.
- **flow** (Run flow): runs another flow as a piece of work of its own and waits; the word that flow ends with is this block's outcome. No runs, brief or model of its own.
- **fork**/**join**: split work and bring it together; nobody runs them.
- **timer**: starts work on a count or a clock.

## Outcomes and counts

Each block's `outcomes` are `[{ "word", "to" }]`: the word names a result ("Approved", "Changes requested"), `to` the block it leads to. The manager reads each result and reports the word with `flow_step`; Ledung never matches words in text.

- `{ "word": "Ready", "end": true }` ends the flow with that word (no `to`). A block with no outcomes ends the flow with its title.
- **A count limits a loop.** `{ "word": "Failed", "times": 3, "to": "person" }` beside `{ "word": "Failed", "to": "fix" }`: the 1st and 2nd Failed go to Fix, the 3rd to the person, and then the count starts again. A count that leads where the plain word does limits nothing.
- **Every loop must be limited**: by a count leading out of it, or a person block in it (a person decides each round). The checks refuse a loop that can go round for ever.
- No two outcomes of one block with the same word and count.

## Sub-steps

Subagents the block's one starts, inside the block: `{ "id", "kind": "work" | "check", "title", "brief", "model", "when": "start" | "done" | "brief", "outcomes" }`. Their outcomes stay inside the block: `{ "word", "to": "done" | "owner" | "report" | "ask-manager", "times"? }`. "owner" sends it back to the block's one to fix and it runs again, so it needs a counted outcome of the same word that leads out ("Findings (3rd time) → report"). Sub-steps have no runs, continues, profile or sub-steps of their own.

## Run flow

`{ "id": "asset", "kind": "flow", "title": "Make the asset", "flow": "asset", "outcomes": [{ "word": "Ready", "to": "build" }, { "word": "Rejected", "end": true }] }`. Its outcome words must be ways the called flow ends; a flow may not run itself, directly or through others. With `"session": "caller"`, the called flow's work blocks continue the caller's latest work session (phases of one long session as flows of their own); its checks still start their own.

## Good briefs

A brief makes a session what its block needs: "you are the reviewer". Write it for someone who has not followed the work:

- what the step is for, what it gets (the PR, the issue, the previous step's report) and what it hands on;
- what counts as done, and each outcome word with when to use it ("Approved: nothing blocking; Changes requested: list each finding with file and line");
- the project's own commands and rules where they matter; nothing tied to one computer;
- short: a page, not a manual. Rules every session follows go in `rules.md`, not in each brief.

## Examples

A three-block flow, work then a check then the person:

```json
{
  "version": 1, "title": "Small change",
  "blocks": [
    { "id": "build", "kind": "work", "title": "Build", "runs": "new-session", "model": "sonnet", "brief": "briefs/builder.md",
      "outcomes": [{ "word": "Done", "to": "review" }] },
    { "id": "review", "kind": "check", "title": "Review", "runs": "new-session", "model": "opus", "brief": "briefs/reviewer.md",
      "outcomes": [{ "word": "Approved", "to": "sign-off" }, { "word": "Changes requested", "to": "build" }, { "word": "Changes requested", "times": 3, "to": "sign-off" }] },
    { "id": "sign-off", "kind": "person", "title": "Sign off", "ask": "review",
      "outcomes": [{ "word": "Accepted", "end": true }, { "word": "Changes needed", "to": "build" }] }
  ]
}
```

A fix that continues the builder's session, and a review in parallel:

```json
{ "id": "fix", "kind": "work", "title": "Fix", "runs": "continue", "continues": "build", "brief": "briefs/builder.md",
  "outcomes": [{ "word": "Fixed", "to": "review" }] },
{ "id": "review", "kind": "check", "title": "Review", "runs": "new-session", "parallel": true,
  "substeps": [
    { "id": "security", "kind": "check", "title": "Security", "brief": "briefs/security.md", "when": "start" },
    { "id": "speed", "kind": "check", "title": "Speed", "brief": "briefs/speed.md", "when": "start" }
  ],
  "outcomes": [{ "word": "Approved", "to": "merge" }, { "word": "Changes requested", "to": "fix" }, { "word": "Changes requested", "times": 3, "to": "owner" }] }
```

## Proposing

```
flow_propose({
  why: "Simon asked for a review by a second reviewer before sign-off.",
  changes: [
    { file: "flow.json", text: "<the whole new flow.json>" },
    { file: "briefs/reviewer.md", text: "# Reviewer\n..." },
    { file: "flows/old.json", remove: true }
  ]
})
```

Give whole files, not patches. Unchanged files are left out. Ledung answers with the problems its checks found (fix the real ones and propose again; hints may stand) and the review's number; end your turn then. The person's answer arrives as a message: on Accepted the files are saved and the workflow page shows the new flow; on Changes needed, change what the note says and propose again.
