# Step 5: Usage and views — proposal

Oct 10, 2026 · Approved by Simon on 2026-10-10 (question #10), with the recording and views refined after looking at Simon's own usage dashboard:

- **Recorded per model call:** time, session, model; input, cache write, cache read, output and thinking tokens; API-equivalent cost; project, role and the manager's team; whether it came from a subagent and which type; branch; what started the turn (Simon, Simon's answer, a manager, a Ledung update); machine. Every change to the plan limits too (which also gives the period "since weekly reset"). Kept forever; filled in for past sessions.
- **Views:** a usage page (filters for period, project, model, branch, role, started by; a project × model matrix with roles to expand; daily stacked bars; recent sessions), usage per session (summary, tokens per turn, per-turn table), the Overview, and limits at the top of the session list.

**Done when** (brief section 9): Simon can see where every session and its tokens stand without opening any chat.

## What step 5 delivers (want 15, brief step 5)

- **Tokens for every session and its subagents**, rolled up the tree: a manager's figure includes the sessions it started.
- **Where each session stands**, at a glance: what it's doing now, its last words, how full its context is, its branch and pull request, and the tickets it's working on.
- **Your plan's usage limits**: how much of the 5-hour and 7-day windows is used, and when they reset, so you can see a limit coming before sessions hit it.

## What Claude Code reports (checked in the SDK, 2026-10-10)

| Data | Where it comes from |
|---|---|
| Tokens per model (input, output, cache read and write) and an estimated cost | Every finished turn (`result`, `modelUsage`). Ledung already stores these messages. |
| Subagents' totals | The result of each subagent call (the Agent tool), per run. |
| How full the context window is | The latest turn's input size against the model's context window; also on request from the session. |
| Plan usage limits: 5-hour and 7-day windows, how much is used, when they reset, warnings | `rate_limit_event` messages, sent when the status changes. Ledung currently discards them. |

**Cost is shown as "API-equivalent"**: on a subscription plan you don't pay per token, so tokens and limit usage are the figures that matter; the cost estimate is for comparing sessions.

## How it works

### Usage

- Each finished turn's usage is stored per session and model, so totals and roll-ups are quick and survive restarts. Turns already in the database are counted too.
- **Per session:** today and in total, split into sessions' own turns and their subagents.
- **Rolled up:** a manager shows its own usage and its team's (itself plus the sessions it started).
- **Ledung-wide:** today's total, and the plan's limit windows, at the top of the session list.

### Where sessions stand

- **Activity:** "Working: Running `npm test` for 2 min", "Ready since 10:42", "Waiting for your answer", from what Ledung already tracks.
- **Last words:** the first line of the session's last reply.
- **Context:** how full the context window is (e.g. 64%), which also tells you when a session is about to compact.
- **Branch:** the git branch the session's folder is on (read with `git`, where the project is a git repository).
- **Pull request:** for a branch with a pull request, its number, state (draft, open, merged, closed) and checks (passing, failing, running), read with the GitHub CLI (`gh`) where it is installed and signed in, in the session's environment. Other code hosts can come later.
- **Tickets:** ticket ids a session mentions (in its task, branch name or pull request), found with a pattern set per project in the config, shown as links (`"tickets": { "pattern": "[A-Z]+-\\d+", "url": "https://tracker.example/{id}" }`). Ticket *status* needs each tracker's own tool and credentials, so it's left out for now (brief open question, issue #11).
- Refreshed when a turn ends, and every few minutes for pull requests.

### In the page

- **Session list:** each row gets a compact line: tokens today, context %, and pull request state, e.g. `12k · 64% · PR #214 ✓`. A manager's row shows its team's total.
- **A new "Overview"** next to "Waiting for you": every session in one table, grouped by manager. Status and activity, last words, branch, PR, tickets, tokens (today and total) and context. On the phone, a card per session.
- **Top of the session list:** today's tokens across Ledung, and the plan's 5-hour and 7-day usage as small bars with their reset times; amber at a warning, red when a limit is reached.
- **In a session's header:** its usage today and in total, context, branch and PR.

## The parts, in order

| Part | What | Done when |
|---|---|---|
| 5a | Usage: stored per turn and model (including subagents), totals and roll-ups, context fill, plan limits. | A manager's team total equals the sum of its sessions; limit windows show after a turn. |
| 5b | Overview page and the compact line in the session list; usage in the session header. | Every session's state and tokens are visible without opening a chat, on the computer and the phone. |
| 5c | Branch, pull request (GitHub CLI) and ticket links. | A session working on a branch with a pull request shows its number, state and checks. |

## Decisions for Simon

1. **Tokens first, cost shown as "API-equivalent"** (recommended), or cost first.
2. **Pull request status through the GitHub CLI** where it is available in the session's environment (recommended); other code hosts later.
3. **Tickets as links only** for now, found by a pattern in each project's config (recommended); ticket status later, per tracker.
4. **Totals "today" and "all time"**, no charts yet (recommended); charts over time can follow.
5. **Show the plan's usage limits** at the top of the session list (recommended).

## Not in step 5

Ticket status from trackers; machine load (step 6); spreading work over other accounts or models (step 8).

## Progress

| Part | Status (2026-10-10) |
|---|---|
| 5a Recording | Done (`src/usage/`). One record per model call; plan-limit changes; branch and context per session; earlier sessions filled in once. A turn keeps what started it until something new does (Claude Code starts turns itself, e.g. after a background subagent), and subagent calls keep the trigger they were launched under. |
| 5b Views | Done. Usage page (filters, tiles, daily bars by model / project / started by, project × model matrix with roles, recent sessions), per-session usage panel (tiles, tokens per call, per-call table), Overview, plan-limit meters, and a compact line per session in the list. Charts use the validated categorical palette, with legends, tooltips and tables. |
| 5c Pull requests and tickets | Done. Pull request state and checks via the GitHub CLI where available; ticket links from a pattern per project (`"tickets": { "pattern": …, "url": … }`). |

Checked live (Haiku, throwaway Ledung, a git project on branch `feature/ABC-12-usage`): seven model calls recorded with the subagent's calls marked; the branch, ticket ABC-12, context fill (31k of 1M) and the 5-hour limit shown; the filters, matrix, Overview and last reply correct. On a copy of the real database, the fill-in found 254 earlier calls. Not checked: a real pull request (the test project has no GitHub remote), and the page in a browser.

