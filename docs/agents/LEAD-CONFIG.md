# LEAD-CONFIG — the project facts the process needs

The process is `Magto/agent-workflow`, run inside Ledung: the lead follows `process/lead.md`, the
sessions `process/worker.md` and their brief in `process/briefs/`. All of them read their `<KEYS>`
from this file. It is
committed so that a clone on any computer comes up set right in Ledung (Martin, 2026-10-13, issue
#22).

**This file is the source.** It is the one place the project's facts are kept, and the one the
process tools read. A computer's local, uncommitted file only adds the per-machine values a row
here points to (a path, a port); it repeats no row, and where it and this file differ, this file is
right. A fact that changes is changed here, in a PR (Martin, 2026-11-10, Ledung question #1816:
"a — Project Ledung makes one source", issue #207).

**A value that is not here is a stop, not a guess.** A cell reading `unknown — needs Martin` is
such a stop until Martin fills it.

**Per-machine rows.** A value that differs between computers is written per machine, as
`<machine> <value>`, separated by ` · `, in a generic form (`%USERPROFILE%\…`, `~/…`). A machine
with no entry in such a row is a stop: add its value in a PR before a lead runs there. A row that
says its value is kept in the computer's local file names no path here: that computer's lead writes
it in the local file, and a row that points there with nothing written there is the same stop.

**How sessions find this file.** Ledung points them at it: the `"workflow"` block in a computer's
Ledung config names the process folder, the file a manager reads first, the file every other
session reads first, and the project's config for it (`projectConfig`), which for this project is
this file, `docs/agents/LEAD-CONFIG.md`. Every session started or resumed is told to read its file
and where this one is, and the workflow's start-reading list repeats it after every start, clear,
compact and resume (`README.md`, "A workflow by default"). A computer's local, uncommitted
`CLAUDE.local.md` next to the repo's `CLAUDE.md` holds that machine's own notes and says where its
local file with the per-machine values is.

## Repo

| Key | Value |
|---|---|
| `REPO` | `Fluffy-Fluffy-and-Bouncy/ledung` (public): issues, PRs and code. Code and PRs have been there since 2026-10-29 (question #487); new issues are filed there since 2026-11-02 (Ledung questions #491–#493 and #508: "new issues go on the public repo"). **The open issues were moved to `ledung` on 2026-11-02**, 61 in two batches, each with a "Moved from Project-Ledung#N" line; the old issue is closed with a "Moved to" link, so anyone citing an old number follows that link. Project-Ledung keeps history, its Testing cards and #464, #465, #451, #455, #456, #459, #461, #463, which finish there; refer to those as `Fluffy-Fluffy-and-Bouncy/Project-Ledung#N`. Open and merge PRs with `gh pr … -R Fluffy-Fluffy-and-Bouncy/ledung` |
| `DEFAULT_BRANCH` | `main` |
| `WIN_CLONE` | per machine: the project's clone, the folder Ledung starts the project's sessions in; sessions work in worktrees only — Martin's Windows PC `%USERPROFILE%\claude-project\ledung` · Martin's Mac `~/claude-project/project-ledung` |

## Board

| Key | Value |
|---|---|
| `BOARD_NUMBER` | `1` — the organisation's board (it holds issues of both repositories), https://github.com/orgs/Fluffy-Fluffy-and-Bouncy/projects/1 (`docs/decisions.md`, 2026-10-13). Replaces FFBuddha's user board 2 |
| `BOARD_OWNER` | `Fluffy-Fluffy-and-Bouncy` |
| `BOARD_PROJECT_ID` | `PVT_kwDOFFxMmc4BmwKS` |
| `STATUS_FIELD_ID` | `PVTSSF_lADOFFxMmc4BmwKSzhlX4Cw` |
| `COLUMNS` | `Triage` `f75ad846` · `Ready` `eaf80505` · `In Progress` `47fc9ee4` · `Testing` `462ec55d` · `Done` `98236657` (Martin, 2026-10-14 11:26: "please set the five columns to: Triage, Ready, In Progress, Testing and Done"). A new issue goes to `Triage`; a move to `Ready` is only Martin's word, recorded on the issue |
| `STALE_HOURS` | `24` |
| `PROGRESS_LABEL` | none |

The project also groups issues by milestone, one per step (`Step 1` … `Step 8`); a new issue gets the step it belongs to.

## Tracker

| Key | Value |
|---|---|
| `TRACKER` | `github` |

## Intake

| Key | Value |
|---|---|
| `ISSUE_FORMS_DIR` | none — no `.github/ISSUE_TEMPLATE/`; issues are free-form |
| `ISSUE_FORM_HEADINGS` | Summary · Evidence · Done looks like · Out of scope |
| `TYPE_LABELS` | `bug`, `enhancement`, `documentation`, `question` |
| `AREA_LABELS` | none (`security`, `cross-platform` are used as topic labels, not areas) |
| `STATUS_LABELS` | `decision-needed` — an issue waiting on a decision (repo `CLAUDE.md`) |

## Tracking issues

None yet: filing pinned log issues in the shared repo waits for Martin and FFBuddha. Until then the
steward, miner and metrics runs are off, and that is not a stop.

| Key | Value |
|---|---|
| `STEWARD_LOG_TITLE` | none |
| `MINER_LOG_TITLE` | none |
| `MAIN_BUILDS_TITLE` | none |
| `METRICS_LOG_TITLE` | none |
| `MINER_EVERY_MERGED_PRS` | n/a |
| `MINER_INTERVAL_DAYS` | n/a |
| `METRICS_MIN_HOURS` | n/a |
| `METRICS_INTERVAL_DAYS` | n/a |

## Sprint

| Key | Value |
|---|---|
| `SPRINTS` | `off` — the project works in steps (milestones), not sprints |
| `SPRINT_LENGTH_DAYS` | n/a |
| `SPRINT_ISSUE_TITLE` | n/a |
| `SPRINT_LABEL` | n/a |

## Docs

| Key | Value |
|---|---|
| `RULES_FILE` | `CLAUDE.md` ("Rules that exist for a reason") |
| `START_FILE` | `CLAUDE.md`, then `docs/brief.md` and the current `docs/steps/` file |
| `BY_DESIGN_FILE` | `docs/decisions.md` — every decision with its date; a change against one is a new decision, not a fix |
| `READ_ALWAYS` | `CLAUDE.local.md` (local, not committed; absent on a clone that has none) |
| `TESTING_FILE` | `CLAUDE.md` ("Running Ledung without breaking the one you are in", "Commands") |
| `CHANGELOG_FILE` | `CHANGELOG.md` — every PR that changes what Ledung does adds a terse `- ` bullet under today's date heading, ending `(#issue)` or `(no issue)`; the pre-push hook refuses a push of `src/`, `web/` (not `web/dist/`) or `scripts/` changes without one, unless a commit carries a `Changelog: none` trailer, which a reviewer checks is honest. The lead moves a bullet to the merge day's heading when a PR merges on a later day (Martin, 2026-10-14, Ledung question #42) |
| `BEHAVIOUR_LOG_FILE` | none |
| `CLASS_RULE` | none |

## Gates and commands

| Key | Value |
|---|---|
| `DOC_RULES_CMD` | none |
| `SCAN_RULES_CMD` | none |
| `METRICS_CMD` | none |
| `LOGCHECK_TAGS_CMD` | none |
| `DOC_RULES_CHECK` | the CI workflow on `Fluffy-Fluffy-and-Bouncy/ledung` (`npm run check` and the package build): Windows on every PR update and push to `main`, macOS weekly and by hand, nothing for docs-only or site-only changes; read it with `gh pr checks <n> -R Fluffy-Fluffy-and-Bouncy/ledung` |
| `SHIP_CMD` | `npm run publish:public -- --confirm <version>` — publishes the next public release to npm's `latest`: the owners' word only (Martin or FFBuddha, both publishers on npm), version included; no session runs it otherwise (repo `CLAUDE.md`, "Commands"). Never `npm publish` or `npm dist-tag` by hand. The restart that loads an update into a running Ledung is the person's, never a session's |
| `DEV_SHIP_CMD` | `npm run publish:dev` — publishes the next dev build to npm's `dev` tag, never `latest`, from a clean `main` that is `origin/main`; the manager may run it after merges (`Fluffy-Fluffy-and-Bouncy/Project-Ledung#461`), and `-- --dry-run` checks, builds and packs without publishing. Per machine: where a computer runs it from a publishing clone of its own, that clone's path is kept in the computer's local file, not here; the command is the same |
| `PROMOTE_CMD` | none — a public release is published from `main` by `SHIP_CMD`, not promoted from a dev build |
| `BUILD_CMD` | `npm run build` |
| `TEST_CMD` | `npm run check` (type check, core and page, and every test) |
| `TEST_LIST_CMD` | `node --test --test-reporter=spec test/` count, or the `ℹ tests` line of `npm run check` |
| `LOOPBACK_CMD` | a throwaway Ledung: `LEDUNG_CONFIG=<tmp>/config.json LEDUNG_DATA_DIR=<tmp>/data node src/main.ts --no-open` on the session's port from `TEST_PORTS` (repo `CLAUDE.md`) |
| `LOOPBACK_MANUAL_STEPS` | anything only Martin's real Ledung, his phone or his browser can show |
| `TEST_TIERS` | `code`, `loopback` (a throwaway Ledung with Haiku sessions), `manual` (Martin) |
| `SOURCE_PATHS` | `src/`, `web/src/`, `scripts/` |
| `TEST_PATHS` | `test/` |

## Sessions

| Key | Value |
|---|---|
| `SESSION_CEILING` | `10` |
| `WORKER_REUSE_MAX_TOKENS` | `80000` |
| `WORKER_WARM_MAX_TOKENS` | `150000` |
| `WORKER_MODEL` | Opus |
| `REVIEWER_MODEL_SRC` | Opus |
| `REVIEWER_MODEL_DOCS` | Sonnet |
| `TEST_REVIEWER_MODEL` | Opus |
| `STEWARD_MODEL` | Sonnet |
| `MINER_MODEL` | Sonnet |
| `METRICS_MODEL` | Sonnet |
| `LOG_TRIAGE_MODEL` | Sonnet |
| `ESCALATION_MODEL` | Opus |
| `TEST_PORTS` | per machine: ports for throwaway Ledungs, one per session, handed out by the lead; never the real Ledung's port (`4317` unless that machine's config says otherwise) — Martin's Windows PC `4396`–`4399` · Martin's Mac `4396`–`4399` |

## Modules

| Key | Value |
|---|---|
| `MODULE_WINDOWS_RUNNER` | off |
| `MODULE_LOG_TRIAGE` | off |
| `MODULE_SYMBOL_INDEX` | off |
| `MODULE_FEATURE_MAP` | off |
| `MODULE_SHOT_JUDGE` | off |

## Humans and approvals

| Key | Value |
|---|---|
| `HUMANS` | `single` — Martin runs it from the Ledung page; FFBuddha co-owns the repo and is told through the PRs and issues |
| `OWNER` | `Martin` |
| `OWNER_LOGIN` | `Magto` — `OWNER`'s GitHub login; the lead assigns an issue to it before its first worker spawn, and never touches an issue assigned to another login |

Every row is `OWNER` · `relay`: Martin's word in the Ledung page, typed or as an `ask_user` answer.

| Row (key) | Action |
|---|---|
| `DESIGN_DECIDER` | a design or scope decision; a decision that changes or adds to `docs/decisions.md` |
| `READY_MOVER` | Triage → Ready |
| `MERGER` | merge a PR |
| `PUSHER` | push anywhere but the session's own `agent/<name>` branch (`am/<name>` for a branch made before agent-workflow v111) |
| `SHIPPER` | `npm run publish:public -- --confirm <version>` (`SHIP_CMD`; Martin's or FFBuddha's word, version included), and restarting or stopping the real Ledung, the Restart that loads an update with it. Also `npm run release` on a computer whose real Ledung runs from the clone's releases, where it sets what the next Restart loads; where Ledung runs from the npm package it changes nothing that runs. `npm run publish:dev` (`DEV_SHIP_CMD`) is not a row: it needs no decider |
| `DELETER` | delete a branch not the session's own, an issue, data |
| `VERDICT_OWNER` | rule and practice verdicts |
| `REVIEW_POSTER` | posting an approving or change-requesting review |

## Process

| Key | Value |
|---|---|
| `PROCESS_REPO` | `Magto/agent-workflow` |
| `PROCESS_VERSION_FILE` | `docs/VERSION` in `Magto/agent-workflow` |
