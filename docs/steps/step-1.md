# Step 1: One session without VS Code — proposal

Oct 9, 2026 · Approved by Simon on 2026-10-09 ("change what you think should be changed, and then start building").

**Done when** (brief section 9): a full multi-step build command runs end to end in a dev-container project from the page, with VS Code closed.

## What step 1 delivers

- The core starts a Claude Code session through a runner: local first, then Docker.
- The page shows the session live: every message with a timestamp, tool calls hideable.
- Simon types into the session from the page.
- The session's permission prompts appear in the page with **Allow** and **Deny**. In step 1 every prompt goes to Simon; managers come in step 3 and 4.
- The core keeps its own copy of every message, so history survives a clear or a compaction.
- Copy-safe blocks: code blocks and drafts copy as plain text.

Not in step 1: questions (`ask_simon`), managers, the MCP server, token roll-ups, machine resources.

## The self-hosting point

Ledung's own repository is a plain Windows folder, so it needs only the local runner. After 1d, development of Ledung continues inside a Ledung session, and 1e and 1f are built from there.

**Self-hosting done when:** Ledung's own development continues in a Ledung session, with permission cards showing the command or diff being approved.

Two rules from then on:

- **Ledung runs from a separate built copy, never from the source a session is editing.** The copy is updated deliberately, when a change is ready, with a script that builds into a new folder and swaps it in. This is the brief's "never edit a running script in place" lesson applied to Ledung itself. Restarting the copy ends its sessions; they resume from their session ids.
- **VS Code with Claude Code stays the fallback** until step 7. If Ledung breaks, it is fixed from there.

## Starting point (checked 2026-10-09)

- Claude Code **2.1.295** is installed.
- The Agent SDK is `@anthropic-ai/claude-agent-sdk` **0.3.295**, released alongside it.
- The SDK's options include what Ledung needs:
  - `spawnClaudeCodeProcess`, documented as being "to run Claude Code in VMs, containers, or remote environments". The Docker runner can plug in here: the SDK hands over the command, arguments and environment, and Ledung starts it through `docker exec -i`.
  - `canUseTool`, a callback for each permission prompt. This is where the page's Allow and Deny plug in.
  - `resume`, `settings`, `model`, `cwd`, `env` and `abortController`.
  - `createSdkMcpServer`, for in-process MCP tools. Not needed until step 2.

So the SDK looks able to do everything step 1 needs. The brief still asks to try both ways before deciding, and 1a does that.

## The parts, in order

### 1a. Spike: Agent SDK or the raw process (issue #1)

Two small throwaway scripts in `spikes/`, one per approach, each driving one real session through the same checklist:

| Check | Why it matters |
|---|---|
| Start in a Windows folder whose path has a space | Path quoting, `claude.cmd` versus `claude` |
| Start inside a running Docker Desktop container through `docker exec -i` | The Docker runner |
| Send a message, receive the stream, see the end of a turn | The chat view |
| A permission prompt arrives, is allowed, and another is denied | Allow and Deny in the page |
| Interrupt a running turn | A Stop button |
| Stop the session; check that nothing stays running, locally and inside the container | Issue #7 |
| Resume with the session id after the process ends | Issue #2 |
| `/compact` and the compact boundary | History survives compaction |
| Give the session the current time without changing Simon's words | Want 9 (see below) |

Result: a short write-up with a recommendation, the decision recorded in [decisions.md](../decisions.md), and issue #1 closed. The spike scripts are deleted afterwards.

My expectation: the SDK, with Ledung's own spawn function for Docker. It handles the protocol, the permission callback and the start-up handshake, and it keeps up with Claude Code releases. If it gets in the way anywhere, the runner design means it can be swapped for the raw process.

### 1b. Core skeleton

- **Node 24 LTS** (issue #3): local install, `engines`, `@types/node` and the CI version.
- **User data folder helper**: `%APPDATA%\Ledung` on Windows, `~/Library/Application Support/Ledung` on macOS, XDG on Linux.
- **Config loader** for `ledung.config.local.json`, checked on load, with clear errors.
- **Database**: `node:sqlite` in the user data folder. Tables for sessions and messages to start with, and a simple migration scheme so later steps add tables safely.
- **Web server**: HTTP and WebSocket on 127.0.0.1, with the security from issue #4 from the first line: `Host` and `Origin` checks and a per-install token.
- **Tests** with Node's built-in test runner, so no extra test framework. CI runs them on Windows and macOS.

### 1c. Local runner and sessions

- Start a session in a configured project folder; send messages; stream the output to the page.
- Store every message, in and out, with a timestamp, before it's shown. The page reads history from Ledung's database, not from Claude's transcript, so compaction and `/clear` don't remove anything from view (want 10).
- **Permission prompts**: `canUseTool` waits while the page shows the request; Simon's Allow or Deny goes back to the session. Every request and decision is stored with who decided it.
- **Claude's multiple-choice questions** (the `AskUserQuestion` tool) arrive through the same callback. The page shows them as choices to click, and the answer goes back to the session. Without this, sessions stall.
- **Stopping**: closing stdin first, then stopping the whole process tree on Windows (issue #7).
- **Restart behaviour** (issue #2, decided): sessions end when the core stops, and the page offers to resume each one from its session id.
- **Sessions know the time** (want 9): give the current time as added context on each turn, for example through a `UserPromptSubmit` hook, instead of adding it to Simon's message. His words stay exactly as typed, which matters for the "Simon's own words" path in step 2. The spike checks this works.

### 1d. The page

- Session list, and a live chat for the selected session.
- A timestamp on every message.
- A toggle per session to hide tool calls and other technical messages (want 8).
- An input box, and a Stop button for the running turn.
- Permission cards with the tool and what it will do: the full command for Bash, **the diff** for file edits and writes, the path for reads. **Allow** and **Deny**.
- Claude's multiple-choice questions as clickable choices, with a box for a typed answer.
- Copy-safe blocks: every code block gets a copy button that copies its plain text (want 12).
- Installable as an app window from Edge or Chrome.
- Marked up as Markdown, so Claude's replies show headings, lists, tables and code properly.

Technology (decided): React, built with Vite into static files that the core serves. It's the most common choice, Claude writes it well, and it carries over to an Electron or Tauri window later. The page gets the token from the core when the core opens it, so nothing else on the machine can use the API.

### 1e. Docker runner

- Start Claude inside a project's running container through `docker exec -i`, through the SDK's spawn option (or directly if 1a chooses the raw process).
- Stop it inside the container, not just the `docker exec` client (issue #7).
- Check container reachability now (issue #6), even though the MCP server comes in step 2, because the answer affects how the core listens.

### 1f. The done-when test

Run a full multi-step build in one of your dev-container projects from the page, with VS Code closed, then check in the database that the whole session is stored.

## Issue changes

- **#5 (session identity at the MCP server)** moves to step 2, because the MCP server arrives there.
- Everything else on the step 1 milestone stays.

## What Simon needs to provide

- **For 1e and 1f only**: a Docker Desktop dev-container project and the build command for the done-when test, in the local config. Not needed before the self-hosting point.

## Go-aheads

Given on 2026-10-09 for step 1. If the spike (1a) turns up something that changes this plan, work stops and the change goes to Simon first.

## Progress

| Part | Status (2026-10-09) |
|---|---|
| 1a Spike | Done. Agent SDK chosen; see [step-1a-spike.md](step-1a-spike.md). |
| 1b Core skeleton | Done. Node 24, config, SQLite store, server with localhost security, tests. |
| 1c Local runner and sessions | Done. Start, send, permission prompts, multiple-choice questions, interrupt, stop with process-tree cleanup, resume, time context. |
| 1d The page | Done. Session list, live chat with timestamps, tool-call toggle, permission cards with diffs, question cards, copy buttons, Markdown, installable. |
| Separate built copy | Done. `npm run release`, then `%APPDATA%\Ledung\Ledung.cmd`. |
| Added on 2026-10-10 | Permission mode per session (Ask, Accept edits, Auto, Plan); working indicator; Restart button; session hosts, so sessions survive a restart even mid-turn ([host-spike.md](host-spike.md)). |
| **Self-hosting point** | Reached on 2026-10-10: Ledung's development continues in a Ledung session. |
| 1e Docker runner | Code written (same approach as the spike); end-to-end check in Ledung still to do. |
| 1f Done-when test | To do. |

Checked end to end through the API (a script acting as the page) on a local test project: Write allowed, a multiple-choice question answered, Bash denied with a message, stop, resume with memory intact, every message stored.
