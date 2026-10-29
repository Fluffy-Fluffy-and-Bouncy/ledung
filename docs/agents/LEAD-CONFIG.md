# LEAD-CONFIG — the project facts the process needs

The process is `Magto/agent-workflow`, run inside Ledung: the lead follows `process/lead.md`, the
sessions `process/worker.md` and their brief in `process/briefs/`. All of them read their `<KEYS>`
from this file. It is
committed so that a clone on any computer comes up set right in Ledung (Martin, 2026-10-13, issue
#22).

**A value that is not here is a stop, not a guess.** A cell reading `unknown — needs Martin` is
such a stop until Martin fills it.

**Per-machine rows.** A value that differs between computers is written per machine, as
`<machine> <value>`, separated by ` · `. A machine with no entry in such a row is a stop: add its
value in a PR before a lead runs there.

**How sessions find this file.** Until issue #21 is built, Ledung does not point sessions at the
process by itself: a local, uncommitted `CLAUDE.local.md` next to the repo's `CLAUDE.md` tells
Ledung sessions where the process is and that this file is the project's LEAD-CONFIG.

## Repo

| Key | Value |
|---|---|
| `REPO` | `Fluffy-Fluffy-and-Bouncy/Project-Ledung` (moved from `FFBuddha/fleet` 2026-10-12, `docs/decisions.md`) |
| `DEFAULT_BRANCH` | `main` |
| `WIN_CLONE` | per machine: the clone releases are built from; sessions work in worktrees only — Martin's Windows PC `%USERPROFILE%\claude-project\ledung` · Martin's Mac `~/claude-project/fleet` |

## Board

| Key | Value |
|---|---|
| `BOARD_NUMBER` | `1` — the organisation's board, https://github.com/orgs/Fluffy-Fluffy-and-Bouncy/projects/1 (`docs/decisions.md`, 2026-10-13). Replaces FFBuddha's user board 2 |
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
| `DOC_RULES_CHECK` | the CI workflow (`check` and `build` on Windows and macOS) |
| `SHIP_CMD` | none — nothing is published; `npm run release` builds a release on the machine it runs on and is Martin's call, as is the restart that loads it |
| `DEV_SHIP_CMD` | none |
| `PROMOTE_CMD` | none |
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
| `SHIPPER` | `npm run release`, and restarting or stopping the real Ledung |
| `DELETER` | delete a branch not the session's own, an issue, data |
| `VERDICT_OWNER` | rule and practice verdicts |
| `REVIEW_POSTER` | posting an approving or change-requesting review |

## Process

| Key | Value |
|---|---|
| `PROCESS_REPO` | `Magto/agent-workflow` |
| `PROCESS_VERSION_FILE` | `docs/VERSION` in `Magto/agent-workflow` (v94) |
