# Workflow format: findings from porting a real process

Oct 25, 2026. A real, mature process (a lead/worker workflow of about 30 steps with optional modules) was written in the part 1 format (#310) as a test, outside this repository. What follows is what the format could not say, in general terms; the ported process itself is not part of Ledung.

## Fixed in part 2b (#318)

1. **Role briefs.** A process has standing procedures per role (what the manager does between steps: status briefs, sweeps, cadence checks, the question format) that govern no single block, and long per-role instructions for workers. Today they can only be a brief no block links, which Ledung neither checks nor shows. Add a `roles` map to `flow.json`: role name → brief file, shown on the workflow page and checked like any brief.
2. **Escalation counts as a limit.** "Two rounds, then escalate, then the reviewers again" is flagged as an endless loop: the loop check counts only `fail` arrows with `rounds`. An escalate step that happens once, or a person block on the cycle, should satisfy it.
3. **Home-relative paths are not machine paths.** `~/.config/...` is the same on every computer and should not be flagged as tied to one.

As built: `roles` in flow.json (role name → brief, kept in `roles/` by the builder), shown on the workflow page and checked like any brief; replaced in #322 (2026-10-26) by one manager file, `manager` (`manager.md`), as a block's own brief now says how its one acts; the escalation after a round limit (`fail.then`) limits a loop through it; `~/…`, `$HOME/…` and `%USERPROFILE%\…` are not flagged. See docs/steps/workflow-builder.md.

## Later parts

4. **Conditions on arrows**: "a docs-only change skips the test review", "in away mode the merge needs no ask" (a lock that holds only sometimes).
5. **Waits and third outcomes**: "evidence pending", "not exercised yet" are neither pass nor fail.
6. **Side branches that return where they came from**, and rounds that do not count against the limit (a spec question).
7. **Reusable gates or sub-flows**: the same merge ask for the main change and for a follow-up cleanup.
8. **Compound timers**: "every 30 merges or every 10 days or when asked"; intervals other than hourly, daily, weekly (every 14 days).
9. **Optional blocks**: an overlay that adds blocks (sprint planning only when sprints are on), not only amends them.
10. **Profiles that depend on the project** (a web project's worker uses another profile) and **settings variables** (`<KEY>` placeholders resolved from the project's own settings).
11. **Shared round caps** across parallel reviewers.
12. **Batch steps**: one pass covering many work items (a triage sweep), where the flow assumes one item.
13. **One person block for two decisions** (a bar check by the manager and a person's word): the format should make two blocks easy, not merge them.
