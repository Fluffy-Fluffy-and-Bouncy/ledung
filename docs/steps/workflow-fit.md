# Workflows that fit: what Ledung does, and what stays prose

Nov 3, 2026 · **Approved (Simon, 2026-11-03, #1593)**: "a — All five, plus #115 and #110". Simon asked: "make the workflow format and builder compatible with different workflows". This document says where each part of a real process belongs, and part 3f below is what was built from it.

## The principle

Agreed in chat with Simon on 2026-11-03.

**Ledung keeps the facts and does the lifecycle and bookkeeping. Judgement stays in prose, in the briefs.**

Something belongs in the format, done by Ledung, when it is all of these:

- **mechanical:** no judgement, the same every time;
- **easily lost by a model:** across a compaction, a long run or a restart;
- **costly or quietly wrong when missed:** a leftover worktree, a fifth build on a machine that takes four, a run started twice;
- **common:** more than one real process needs it.

Everything else stays prose: how to review, what counts as done, one project's habits.

- **No locks.** The person's word overrides the workflow.
- **Hard safety stays in the sensitive lists** and away mode, as now.

**Simon's example, a worktree per piece of work.** Ledung creates it when the run starts. Ledung removes it when the run ends, but only after a plain safety check: no uncommitted changes, and the branch merged or pushed. If the check fails, Ledung keeps the worktree and tells the coordinator. Removal can be chosen per ending ("when it ends Merged", or "never").

## Three real processes, feature by feature

Three processes were ported or described in October and November 2026. They are named here only by kind:

- **process A:** a web app's build pipeline, from issue to merge;
- **process B:** a game project with code, asset and review flows;
- **process C:** an agent-workflow process, about 30 steps with optional modules.

The table marks each feature with one of four places:

- **in the format (done):** part 1 to 3e already covers it;
- **Ledung should do it (missing):** mechanical and common, so it belongs to Ledung but isn't there yet;
- **prose (by the rule):** judgement, or one project's habit;
- **later:** belongs to Ledung, but not before part 3 goes public.

| Feature | A | B | C | Where |
|---|---|---|---|---|
| One piece of work = one issue, ending in one PR and a merge | ✓ | ✓ | ✓ | in the format (done): a run with its ref |
| Refuse to start what is already under way (a session or an open run for the same issue) | ✓ | | ✓ | **Ledung should do it**: a duplicate check on `flow_start` (3f) |
| Readiness bar before starting (acceptance criteria, dependencies met) | ✓ | ✓ | ✓ | prose (the manager's judgement); dependencies "later" with intake (part 5) |
| Claim it in the tracker (assign, move the card) | ✓ | ✓ | ✓ | later (part 5, intake from a tracker) |
| A worktree per piece of work, set up for the project | ✓ | ✓ | ✓ | **Ledung should do it**: a worktree per run (3f) |
| At most N pieces of work at once (merge queue throughput, one shared test lock) | ✓ | ✓ | | **Ledung should do it**: a run limit (3f) |
| One piece of work at a time in one area ("one scene change in progress") | | ✓ | | **Ledung should do it**: a block limit (3f, small) |
| A brief per step, a role made by the brief | ✓ | ✓ | ✓ | in the format (done) |
| New session per step, or the same session continued | ✓ | ✓ | ✓ | in the format (done): `new-session`, `continue`, `session: "caller"` |
| A fresh context between phases of one session (compact or clear at a phase boundary) | ✓ | | ✓ | **Ledung should do it**: context reset on a continued step (3f, optional) |
| Subagent reviewers, several lenses at once, one merged verdict | ✓ | | ✓ | in the format (done): sub-steps, `parallel: true` |
| Round caps ("3 plan rounds, then the manager decides") | ✓ | ✓ | ✓ | in the format (done): counted outcomes, counted by Ledung |
| Escalation once, then back to the loop | | | ✓ | in the format (done): the count starts again after the counted outcome |
| One round cap shared by two parallel reviewers | | | ✓ | later |
| A spec question that returns where it came from and doesn't count as a round | | | ✓ | later |
| Conditions ("a docs-only change skips the test review") | ✓ | | ✓ | in the format (done) as an outcome word ("Docs only" → …); compound conditions later |
| The person decides on production, money and owned paths | ✓ | ✓ | ✓ | in the format (done): person blocks; hard safety in the sensitive lists |
| "Whose call": a code owner or the other person must approve | ✓ | ✓ | ✓ | in the format (done): `person`; their approval in GitHub is a `wait` |
| Waits: CI, the merge queue, someone else's approval, a person's manual test | ✓ | ✓ | ✓ | in the format (done): `wait` blocks |
| Being told when CI or the merge queue changes, instead of polling | ✓ | ✓ | | later: a wait may name the PR check it watches; Ledung tells the coordinator, and never picks the outcome |
| Verify before merging (checks at the head commit, level with base) | ✓ | ✓ | ✓ | prose (the merge brief); Ledung's PR poll already shows the state |
| At the end: stop and archive the work's sessions | ✓ | ✓ | ✓ | **Ledung should do it**: tidy at the end (3f) |
| Post the result to the tracker | ✓ | ✓ | | later (part 5) |
| Re-roll loops the person decides each round, with no fixed limit | | ✓ | | in the format (done): a person block in the loop |
| Run only when the person is away or asleep (night runs, GPU work) | | ✓ | | later: a start condition on runs; away mode exists |
| Batches: one step for many pieces of work (a family of assets, a triage sweep) | | ✓ | ✓ | later |
| Recurring passes (a cadence check, a miner every N merges or days) | ✓ | ✓ | ✓ | later (timers that Ledung runs; #114) |
| Optional modules per project, some adding steps | | | ✓ | later (#113) |
| Per-project values in a shared process (models, counts) | | | ✓ | later (#112) |
| Standing rules (no production without the person, evidence, no tool names in public text) | ✓ | ✓ | ✓ | prose: `rules.md`; the hard ones in the sensitive lists |
| A fixed report shape (DONE / BLOCKED / FAILED with evidence) | ✓ | ✓ | ✓ | in the format (done): the outcome words a block's session ends with; the rest of the shape is prose |
| Coordination with another person's manager (claims, lane splits) | | ✓ | | prose, over the message board (exists) |
| One shared machine resource at a time (a full test suite, a GPU queue) | ✓ | ✓ | | later: a block limit across projects; prose for now |

## Martin's open gaps

Each gap below is placed by the same rule.

- **#110 Save silently forks a project off its shared flow.**
  - Mechanical, and quietly costly: the project stops getting the shared flow's updates.
  - The same question arises when a manager proposes a change to a shared flow (part 3e refuses, and tells the manager the person must make a copy first).
  - **Recommendation: before part 3 goes public.** It is small: a confirm before the first Save, and a "differs from shared" notice.
- **#111 A brief relative to the shared workflow's folder.** It only matters for shared workflows that keep their briefs elsewhere; copying works today. **After.**
- **#112 Per-project values (`<KEY>`) in model, profile and timer.** It is mechanical, but mostly needed by shared processes. **After.** Until then, these values stay in prose.
- **#113 Overlays switched per project, and able to add blocks.** **After.** It is a larger format change.
- **#114 Timer guards.** Ledung doesn't run timers yet, so a guard would only be words. **After**, with timers Ledung runs. Until then, the guard is prose in the manager's file.
- **#115 Which wins: the written workflow or the drawn flow.** Following is on by default, so a manager on a project with both is now told both.
  - **Recommendation: before part 3 goes public.** One line: the flow says what happens next and who does it, and the written files say how.
  - Make it a setting only if a project needs the other way round.
- **#117 An author line on a flow.** Trivial, and nothing depends on it. **After**, or with #110 if convenient.

## Part 3f

Approved with all five, plus #115 and #110. Each is a setting on the flow or block, editable in the builder and checked by the flow checks. **Defaults: only tidying (archive) and one run per ref are on; the rest is off unless set.**

### 1. A worktree per run

Ledung creates a git worktree when a run starts, from the base branch, on a branch named after the run. It runs the project's own setup command there, if the project's settings name one. Every session of the run then starts in that worktree, through the existing `cwd`.

When the run ends, Ledung checks two things:
- no uncommitted changes;
- the branch is merged into the base, or pushed.

If both hold, Ledung removes the worktree. If either fails, Ledung keeps it and tells the coordinator why. Container projects do the same through their runner.

```json
"worktree": {
  "base": "main",
  "branch": "run/{ref}",
  "remove": { "on": ["Merged", "Rejected"] }
}
```

- `"remove": "never"` keeps every worktree.
- With `on` left out, removal applies on every ending.
- **The setup command is a project setting, not part of the flow,** so the flow stays shareable: copying worktree caches or tool files is one project's habit.

### 2. At most N runs at once

```json
"limit": 4
```

- **On the flow:** a run past the limit waits at the start block, shown as queued with its place in line. It starts when another run ends or stops. `flow_start` says "queued, number 2".
- **On a block** (`"limit": 1`): one run at a time in that block, for "one scene change in progress" or one exclusive tool. The others wait before the block, shown as waiting.
- The person can start a queued run anyway, from the Runs list.

### 3. Tidy at the end

When a run ends, Ledung stops the run's sessions that are idle and archives them. The coordinator is told what was kept and why: a session that is still working, or a worktree the safety check kept.

```json
"end": { "sessions": "archive" }
```

- **Choices:** `"archive"` (the default once 3f is in), `"stop"` or `"keep"`.
- **Per ending:** it can be set per ending, as worktree removal can (`"on": [...]`).

### 4. No run started twice

`flow_start` with a ref that an open run already has is refused, naming that run. `again: true` starts it anyway. This replaces the "is it already under way?" check processes A and C ask the manager to do.

### 5. A fresh context on a continued step (optional)

```json
{ "id": "ship", "runs": "continue", "continues": "build", "context": "compact" }
```

Before Ledung hands the step to the continued session, it compacts it (`"compact"`) or clears it with a handoff (`"clear"`). That is what processes A and C do by hand at phase boundaries, and a model forgets it.

### Before part 3 goes public, besides 3f

- **#115:** one line saying which wins.
- **#110:** a confirm before the first Save on a shared flow.

### Not in 3f

These are all later:
- watching CI and the merge queue for the coordinator;
- start conditions (night runs);
- batches;
- shared round caps;
- side branches that return;
- timers that Ledung runs;
- per-project values;
- optional modules;
- tracker intake.
