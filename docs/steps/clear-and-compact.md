# Compact for managers and sessions, self-clear for sessions — plan

Oct 13, 2026 · **Approved on 2026-10-13**, as reported by the manager "Manager: Project Ledung" (Simon, in chat with it: "Ok, 200 is fine then, I assume. Go ahead with the plan."): the 200-character note limit stays, and the open question below goes as recommended. It builds on the verified findings in [clear-and-compact-findings.md](clear-and-compact-findings.md) ("finding N" below means section N there) and on Simon's decisions of 2026-10-13, listed in the next section and in [decisions.md](../decisions.md). Nothing here is released until Simon says go.

**Done when:** a manager can compact one of its sessions or itself, and a session can compact itself, with an optional one-line note for the summary; the page shows "Compacting…" and then "Compacted: 70k → 2.4k in 16 s"; a failed compact is never reported as a success; a session can clear itself after writing a handoff note, with the same cancellable countdown as Magto's clear; the context figure is right straight after a compact or clear, so a "compact above X" rule doesn't fire twice; the compaction's cost shows in usage; all of it survives a Ledung restart and works from the phone.

## Simon's decisions (2026-10-13)

1. **No countdown for a compact.** Nothing is lost: the old conversation stays in the transcript file, and the summary even names that file (finding 1).
2. **Who may compact:** a session may compact itself; a manager may compact itself or the sessions it started. Ledung never compacts unasked.
3. **The compaction's cost is counted** in usage (where the figure comes from is below).
4. **Instructions per compact, both kinds:** the project's CLAUDE.md section `## Compact Instructions` sets the format (it also steers Claude Code's own automatic compaction), plus an optional note per request: one line, at most 200 characters, shown in the page as from Ledung and the requester, never looking like Simon's words.
5. **A failed compact:** no automatic retry. The requester (the session itself, or its manager) is told with the reason; the chat gets the event "Compact failed: <reason>"; the follow-up note (`then`) is still delivered, saying the compact failed and the context is unchanged; if neither success nor failure arrives within 10 minutes, the requester is alerted. Nothing goes to Simon. Failure is detected from the `status` message with `compact_result: "failed"`, since the `result` looks like success (finding 3).
6. **Self-clear for sessions: yes,** with the same cancellable countdown Magto's clear has today (Simon: "leave it there for now"; he will discuss the countdown with Magto), and only after a handoff note: the request names the note file, and the message after the clear points the session at it.
7. **Loop guard:** one pending compact or clear per session; the context figure is set straight away from `compact_boundary` (after a compact) and `conversation_reset` (after a clear), so a "compact above X" rule doesn't fire again. This also fixes the stale figure after Magto's existing clear. Main session only, never subagents.
8. **User settings off:** the README says that `userSettings: false` also skips the personal `~/.claude/CLAUDE.md`, and a test finds out what else still loads under it (personal commands, skills, agents: unverified so far). **No** visible "user settings off" mark in the page (Simon: not needed).
9. No issue for Magto about this (Simon skips that).

## What it delivers

- **Managers:** a new tool `compact_session`. Without an id it compacts the manager itself after its current turn; with an id, one of its sessions (an ended one is resumed first, as for `clear_session`).
- **Sessions:** two new tools that only ever act on the session calling them: `compact_self` and `clear_self`. A session can't reach any other session through them.
- **In the chat:** "Compact requested by manager "Manager: X"." (or "by the session itself"), with the note for the summary if there is one; "Compacting…" in the session header while it runs, with the time so far; then the divider "Compacted: 70k → 2.4k in 16 s", or the event "Compact failed: <reason>".
- **The context figure** (header, `list_sessions`, the "Your context: …" line on each prompt) is right at once after a compact or clear.
- **Usage** shows each compaction as its own entry, with its tokens and cost.
- **The manager is told quietly** when one of its sessions compacts or clears itself: a note that waits for the manager's next turn and doesn't wake it.

## How it works

### The tools

The set of things a session can ask Ledung to do stays closed: three new tool names, added to the fixed lists in `src/sessions/tools.ts` (so they never need a permission prompt), each with fixed behaviour.

| Tool | Who | Arguments | What happens |
|---|---|---|---|
| `compact_session` | managers | `id?` (leave out: itself), `instructions?`, `then?` | Compacts that session, or the manager after this turn. |
| `compact_self` | sessions | `instructions?`, `then?` | Compacts the calling session after this turn. |
| `clear_self` | sessions | `handoff_file` (required), `then?`, `countdown_seconds?` (10–600, default 30) | Clears the calling session after this turn, after the countdown. |

- `instructions`: the note for the summary. One line (line breaks become spaces), at most 200 characters; a longer one is refused with that reason rather than cut, so the session knows. It adds to the project's `## Compact Instructions`; it doesn't replace them.
- `then`: delivered after the compact or clear, like `clear_session`'s today. It can be as long as needed (it travels as context, not as user text).
- `handoff_file`: a file the session has just written, relative to its project folder. Ledung checks it with the same rules the file viewer uses (`readProjectFile` in `src/sessions/files.ts`: inside the project folder, no tricks with `..` or links), and that it exists, isn't empty and was changed in the last 60 minutes, so an old file can't stand in for a handoff. Otherwise the clear is refused with the reason, and nothing is queued.
- Managers keep `clear_session` as it is. They don't get `compact_self` or `clear_self`: `compact_session` and `clear_session` without an id already cover themselves.
- The tool descriptions and Ledung's instructions say what the tools are for; **when** to use them stays the project's rule (CLAUDE.md, or what the manager says), as decided for clear on 2026-10-12. The "Your context: Nk of 200k tokens." line each turn is the number such a rule uses (finding 8).

Replies to the caller, for example: "Your conversation is compacted after this turn ends, then your note arrives. Finish what you are doing and end your turn." / "A compact of "X" is already waiting." / "The handoff file docs/handoff.md was last changed 3 hours ago; write the handoff first."

**Subagents can't use them.** The `PreToolUse` hook already sees every call, and Claude Code marks a call made inside a subagent with `agent_id` (SDK `BaseHookInput`). For the four compact and clear tools (including the manager's `clear_session`) the hook denies such a call: "Only the main session can compact or clear." Today the hook lets every Ledung tool through; this is the one exception.

### One pending compact or clear per session

A compact is queued exactly like a clear: an inbox item `compact:<requester>` behind whatever was already waiting, followed by the `then` note as a `compact-note` item. A new compact or clear (from any tool, including `clear_session`) is refused while the session has a compact or clear waiting in its inbox, counting down, or running. That one check covers decision 7's "one pending" for every combination (compact after compact, clear during a compact, a manager and the session both asking).

### Carrying it out (`Session.deliver`)

`deliver()` stays the one place that decides when a turn may start. When the compact item is first in the inbox and the session is free:

1. It waits for a free place under the working limit like any other work (`gate.mayStart`), and for an unpaused session; Simon's **Start now** works as usual.
2. The compact item is marked delivered; the event "Compact requested by …" is recorded with the note, if any; the session's new `compacting` field is set (requester, start time, note); status `running`, a turn begins (trigger "manager" if a manager asked, "ledung" if the session asked itself).
3. Ledung pushes `/compact`, or `/compact` followed by the note (next section). Like `/clear`, it resets the resume guard (`pushInput`).

No countdown (decision 1). The `then` note stays in the inbox until the compact ends.

### The note for the summary, and Simon's words

The note has to travel as user text: `/compact <text>` is the only way to give a compact its instructions (finding 1), and a `UserPromptSubmit` hook's context doesn't reach a slash command. That bends the rule that pushed user text is a closed list of fixed strings (finding 7), so Ledung keeps it as narrow as it can:

- Ledung writes the wrapper, the requester only the inside: `/compact Additional instructions from Ledung, requested by manager "Manager: X" (not from Simon): <note>`. One line, at most 200 characters inside, so a note can't fake structure or a second message.
- It goes only to the summarizer. It is not a turn of the conversation, so it can't approve anything; at most the summary may repeat it, under that label.
- The page never shows it as a user bubble: it appears in the event "Compact requested by manager "Manager: X". Note for the summary: …". Ledung records no user message for the pushed command, and the page already skips Claude Code's own echo lines.

A test checks that a session asked afterwards doesn't take the note for Simon's words.

### When it ends (`onMessage`)

Only messages of the main session count (no `parent_tool_use_id`). The order is fixed (finding 2): `status` "compacting", `status` with `compact_result`, `init`, `compact_boundary`, the summary, `result` with zero turns.

- `status: "compacting"`: confirms the compact has begun; the page's "Compacting…" comes from the `compacting` field, set when Ledung pushed the command.
- `status` with `compact_result: "failed"`: the outcome "failed" and `compact_error` are written to `compacting` in the database.
- `compact_boundary` (manual, and also Claude Code's automatic one): the context figure is set at once (next section); the divider reads "Compacted: 70k → 2.4k in 16 s" from `compact_metadata` (`pre_tokens`, `post_tokens`, `duration_ms`; the page builds it from the stored message, so old ones get the new text too). The outcome becomes "success".
- `result` (zero turns): the compact is over. What follows depends on the outcome:
  - **success**: the `then` note gets its heading ("Your conversation was compacted at your own request (compact_self). Your note to yourself: …", or "… by your manager "X". Message from your manager: …") and is delivered as the first thing after the summary. A manager that asked is told nothing more: the note's turn ends with a "finished a turn" update as usual.
  - **failed** (from the `status`, or as a fallback a `result` text starting with "Error during compaction"): the event "Compact failed: API Error: Request was aborted." in the chat; the `then` note is delivered as "The compact failed (API Error: …); your context is unchanged. Your note: …"; a manager that asked is told (woken) "The compact of "X" failed: … Its context is unchanged." When the session asked itself, the note is how it's told; with no `then`, Ledung sends it a one-line note instead. No retry, nothing to Simon.
  - **nothing to compact** (a `result` with no `status` and no boundary, finding 3): the event "Nothing to compact yet; the context is unchanged.", told as for a failure but without the word "failed".
- `compacting` is cleared, then `deliver()` runs as after every result.

The heading is decided when the outcome is known, so `deliver()` doesn't need to know about compacts: the note item's text is set at that moment (a small store method, `setInboxText`).

**Ended mid-compact** (stopped, or Claude Code crashed): the conversation is as it was (the boundary is only written at the end). The outcome is "the session ended during the compact"; the requester learns it with the end note it gets anyway, and the `then` note waits, with that heading, for the next resume.

### The context figure

- After a **compact**: `post_tokens` counts only the conversation, not the fixed part (system prompt and tools, about 25k; finding 4). *As built:* the plan's "old figure − `pre_tokens` + `post_tokens`" failed in the live test, because `pre_tokens` includes the fixed part only sometimes (78.0k for a context of 77.8k once, 1.9k for one of about 24k another time). Ledung now adds `post_tokens` to the session's smallest recorded call (the fixed part plus its first message). In the live test that gave 28.4k, 26.7k and 26.6k where the next reply measured 23.6k, 24.5k and about 24k: a few k high until the next reply, never low enough to re-trigger a rule. With no call recorded yet, `post_tokens` alone.
- After a **clear** (`conversation_reset`, also from Magto's `clear_session`): the figure is emptied, so the prompt line and `list_sessions` show no number until the next reply. Showing "0k" would be wrong, and a rule that sees no number doesn't fire.
- Both only for the main session.

### What the manager hears

| Case | The manager (requester) | The manager of a session that asked itself |
|---|---|---|
| Compact succeeded | nothing extra (the note's turn reports as usual) | quiet: "Session "X" compacted itself: 70k → 2.4k." |
| Compact failed / nothing to compact | woken: "The compact of "X" failed: …" | quiet note with the reason |
| No outcome after 10 min | woken: "The compact of "X" has run 10 minutes with no result. It may still finish; Interrupt in the page or stop_session ends it." | woken, with the same text (decided with the approval) |
| Clear done | nothing (as today) | quiet: "Session "X" cleared itself; its handoff is in docs/handoff.md." |
| Clear cancelled by Simon | woken (as today) | quiet note |

Quiet notes wait in the inbox for the manager's next turn, like the idle-stop note.

### The 10-minute alert

Checked in the check that already runs once a minute (the idle timer in `src/sessions/manager.ts`): a session whose `compacting` started more than 10 minutes ago and hasn't been alerted gets one alert to its requester; `compacting` remembers that it was sent. Since it reads the database, a restart doesn't lose it or send it twice.

### A Ledung restart in the middle

The compact runs in the session's host, so it carries on; the next Ledung attaches and gets the lines it missed (finding 2's order is kept). Everything the compact needs after the restart is in the database, none of it only in memory:

- the waiting item and the `then` note (inbox), the `compacting` field (requester, start, note, outcome so far, alert sent) and the clear's `clearDue` (already there);
- the outcome is written when the `status` line arrives, so a restart between it and the `result` doesn't lose it;
- the baseline for the cost (next section) is read from stored messages.

Losing the in-memory state is harmless: there is none beyond timers, which are set again from the database.

### Working limit and idle stop

- A compact is a turn: it waits for a free place and takes one while it runs (5 to 20 s in the findings, maybe minutes for big ones). A self-compact or self-clear happens after the session's own turn, which already holds a place; it may then wait in line again, which is correct.
- The idle stop leaves it alone: running, or a compact or clear waiting in the inbox, both already block it (`idleStopBlocker`).
- Simon writing to a session **during** a compact: the message goes straight in (as for any running turn) and runs after the compact (finding 2, the PONG test). Writing during a **clear's countdown** cancels the clear, as today; a compact has no countdown, so nothing to cancel.

### The compaction's cost

The compact's `result` has `usage` all zero and there is no assistant message (finding 3), which is why it isn't counted today. But the `result` also carries `modelUsage`, which the SDK documents as "every model call made through the query pipeline … including internal calls such as compaction", **cumulative** for the Claude Code process (`sdk.d.ts`, `SDKResultMessage.modelUsage`). So:

- **Cost of a compact = the compact's `modelUsage` minus that of the previous `result` from the same Claude Code process**, per model (input, output, cache read, cache write; priced with Ledung's own `callCost`, as every other call). With no assistant message in a compact turn, everything in that difference is the compaction.
- The previous result is taken from the stored messages, not memory (restart-safe). *As built:* a second probe showed that a resumed process carries on from the totals its transcript saved (before the stop 7,042 / 560 / 42,325 / 17,719; the compact right after the resume 11,161 / 1,445 / 67,860 / 21,148). So the previous stored result counts even when it came from an earlier process, and "the compact right after a resume" is priced too. A clear in between resets the totals, so the baseline is then zero. If any figure went down, or there is no earlier result at all, nothing is recorded and the event says "The cost of this compact is not known."
- Recorded as one usage entry (`messageId` `compact:<boundary uuid>`, so it is counted once) with a new field `kind: 'compaction'` (a new migration), so the usage page can show it as "Compaction" and doesn't count it as a subagent call.
- **Probe (build step 1, 2026-10-13, Claude Code 2.1.295, Haiku, SDK script in a temp folder): confirmed.** A 41.2k-token conversation compacted to 2.6k in 9.5 s. The `result` before the compact had `modelUsage` input 15,852 / output 654 / cache read 50,289 / cache write 27,343 ($0.00788); the compact's `result` (zero turns, `usage` all zero) had 20,457 / 2,663 / 84,258 / 30,889 ($0.01013). So the compaction was 4,605 input, 2,009 output, 33,969 cache read, 3,546 cache write tokens, $0.00225 by Claude Code's own estimate; it is in `modelUsage` and nowhere else. The estimate fallback is not needed.
- Claude Code's **automatic** compaction (mid-turn, near a full context) isn't covered: its cost is mixed into a normal turn. Counting it means comparing each turn's `modelUsage` with the calls Ledung recorded; that's a later offer.

### The self-clear

`clear_self` puts the same items in the inbox that `clear_session` does for a manager clearing itself: `clear:<seconds>:<session id>`, then the note: "Your conversation was cleared at your own request (clear_self). Your handoff note is docs/handoff.md: read it first and continue from there." followed by `then` if given. The countdown, the change-of-watch ship, Cancel, Simon writing to cancel, and the note going in after the clear are all the existing code (`countingDown`, `cancelClear`, `onClearCancelled` already handle a requester that is the session itself). A cancel tells the session (its inbox) and, quietly, its manager.

### Page

- Session header: "Compacting… 0:12" with the requester and the note while `compacting` is set, in the place the clear countdown uses; no Cancel (decision 1; Interrupt is there as always). The ship shows the session working, as in any turn; no new animation.
- Chat: the request event, the new divider text, "Compact failed: …", "Nothing to compact yet; …", and the existing clear events.
- Checked at phone width: the header line wraps, the note doesn't push the buttons off screen.

### README

In "Session profiles", the `userSettings: false` line gets: "It also skips your personal `~/.claude/CLAUDE.md`, including any Compact Instructions in it." plus what the test in build step 6 finds about personal commands, skills and agents. *As built:* the test found that all of them are skipped (see Progress).

### Database

One new migration (`MIGRATIONS`, never editing an old one): `sessions.compacting` (JSON or null) and `usage.kind` (default `'call'`). The inbox needs no change (new sources only).

## What gets tested

Unit tests:

- Tools: `compact_self` and `clear_self` exist only for sessions, `compact_session` only for managers; the note is refused over 200 characters and made one line; a manager can't compact a session it didn't start; the new names are in Ledung's no-prompt list.
- The pending guard: a second compact, a clear during a compact, a compact during a clear's countdown, both refused with the reason; allowed again after the result.
- `clear_self`: refuses a missing, empty, stale (over 60 minutes) or outside-the-project file, and `..` or a link out of the folder; queues the clear and the pointing note otherwise.
- The hook denies the four tools from a subagent (`agent_id` set) and allows them from the main session.
- `onMessage` on recorded message sequences from the findings: success, failure from `status`, failure from the `result` text only, nothing to compact, ended mid-compact: the right events, the right `then` heading, the right note to the requester, `compacting` cleared.
- Context figure: the formula after a compact, the fallback, emptied after a clear, subagent boundaries ignored.
- Cost: the `modelUsage` difference; baseline from another host, after a clear, a figure going down, none at all; recorded once.
- The 10-minute alert fires once, also when `compacting` comes from the database after a restart.

Live tests (throwaway Ledung on a 439x port, own config and data, Haiku, a throwaway project with a `## Compact Instructions` section):

| What | Expected |
|---|---|
| A manager compacts a session (~30k tokens) with a note and a `then` | Request event with the note; "Compacting…"; divider with the figures; `then` delivered after; the code word from Compact Instructions and the note's request both in the summary. |
| A session compacts itself (`compact_self`) | Same; its manager gets the quiet note and is not woken. |
| A manager compacts itself | Compacts after its turn; its own `then` arrives. |
| **Failed compact by Interrupt** a few seconds in | "Compact failed: … aborted"; the `then` says it failed; the requester told; the conversation intact (a secret from before still known); nothing to Simon. |
| **A message queued during the compact** (Simon writes, and a manager `send_message`) | Simon's runs after the compact; the manager's arrives with or after the `then`; nothing lost or doubled. |
| **Resume after a compact** (stop, then a message) | Comes back compacted, knows what the summary kept. |
| **Self-clear with countdown, then Cancel** | Refused without a handoff file; with one: countdown and ship; Cancel keeps the conversation, the session and its manager are told; again without cancel: cleared, the note points at the handoff file, the session reads it. |
| **Loop guard**: a rule "compact above 25k" in CLAUDE.md | Compacts once; the next prompt's line shows the new figure; it doesn't compact again. A second request while one waits is refused. |
| **Context figure** after a compact and after a `clear_session` | Right at once (header, `list_sessions`, prompt line); after the next reply within a few k of the computed one. |
| Cost | A "Compaction" entry in the session's usage, equal to the `modelUsage` difference. |
| Nothing to compact (a new session) | "Nothing to compact yet". |
| A Ledung restart (test copy) during a compact | The outcome, the `then` and the cost all still right. |
| The note as Simon's words | Asked afterwards who wrote the compact note, the session doesn't say Simon. |
| Under the working limit of 1 | A compact waits in line, then runs; Start now starts it. |
| `userSettings: false` | With a mock API and a temp `CLAUDE_CONFIG_DIR` holding a personal command, skill and agent: which ones the session's `init` lists, and that the personal CLAUDE.md is absent. |
| The page at phone width | "Compacting…", the note, the divider and the events readable. |

**Not tested, and why:** compacts of 150k to 200k tokens and on Opus (time and cost; the 10-minute alert is the safety net); Claude Code's automatic compaction (it can't be provoked cheaply; the boundary handling treats it the same, its cost isn't counted); failures other than an interrupt (overload, rate limit, too large to summarize); containers and macOS; how reliably a long, busy session follows a "compact above X" rule (finding 8 only covers short sessions).

## Build order

1. **Probe** (throwaway script, Haiku): does the compact's `modelUsage` include the compaction? If not, report and use the estimate.
2. Migration; store fields and `setInboxText`; the three tools, the pending guard, the subagent check in the hook; unit tests.
3. `deliver()` and `onMessage`: compact start, outcomes, `then` heading, notes to the requester and the quiet notes, the context figure (also for clears); unit tests.
4. Cost entry and the usage page's "Compaction"; the 10-minute alert.
5. `clear_self` with the handoff check, on the existing countdown.
6. Page (header, divider, events), README sentence, the `userSettings: false` test.
7. Live tests in the order of the table; results added here; `npm run check`; a release only after Simon's go-ahead.

## Decided with the approval

1. **The 10-minute alert for a session's own compact.** The requester is then the session itself, which is busy compacting, so the alert only reaches it once the compact has ended. So its manager is woken too (sessions without a manager: nobody, as decided). This was the plan's recommendation; the approval covered it.

## Progress

| Part | Status (2026-10-13) |
|---|---|
| 1 Cost probe | Done; confirmed (see "The compaction's cost"), and a second probe for a compact right after a resume. |
| 2–5 Core | Done (`f07f802`, `3b94145`): migration 17; `compact_session`, `compact_self`, `clear_self`; one compact or clear at a time; outcome from the status message; the note headed with how it went; the requester and the manager told; context figure at once; cost; the 10-minute alert (checked in the once-a-minute check that already watches the line); subagents refused in the `PreToolUse` hook. 16 unit tests in `test/compact.test.ts`. |
| 6 Page, README | Done (`8436f0a`, and the README line in this commit): "Compacting… m:ss" with the requester's note in the session header, the request event, the divider "Compacted: 70k → 2.4k in 16 s.", "Compaction" on a session's usage calls. |
| 7 Live tests | Done, below. |
| Release | Not done (waits for Simon). |

**Changes from the plan, found while building:**

- The context figure after a compact uses the session's smallest call, not "old − pre + post" (see "The context figure").
- A session's Ledung instructions get no extra line about compacting. It would take them past Claude Code's 2,048-character limit, which would raise that limit for all of the session's tool servers (issue #32). The tool descriptions say it instead: when to use them is the project's rule.
- For a container project, `clear_self` checks only that the handoff path is relative and stays inside the folder, since Ledung can't read a container's files yet (the file viewer has the same gap).
- The manager is told quietly about every outcome of a session's own compact (success with the figures, failure with the reason), and about a self-clear.

**Live tests** (throwaway Ledung on port 4391, own config and data, Haiku, `slim` profile; a throwaway project whose CLAUDE.md asks the summary to keep the code word TEAL-42 and every number; the worker read a 1,200-line file to reach about 78k):

| What | Result |
|---|---|
| A manager compacts a session (78k) with a note ("mention ZEBRA") and a `then` | Pass. Event with the note, then "Compacting…", 78.0k → 2.5k in 11 s, the `then` delivered after; the reply "4711 TEAL-42 ZEBRA": both the Compact Instructions and the note were followed. |
| A session compacts itself by a rule ("40k or more: compact_self once") | Pass. It called `compact_self` at 76k; compacted after its turn; its note arrived; its manager got the quiet note "asked to compact itself and was compacted: 76k → 2.6k in 10 s." |
| **Loop guard**: the next prompt | Pass. No second compact; the prompt line already showed the new figure. |
| A manager compacts itself | Pass. 52.2k → 3.8k; its own note arrived. |
| **Failed compact by Interrupt** 3 s in | Pass. "Compact failed: API Error: Request was aborted."; the note said it failed and the context is unchanged (still 79k); the session didn't retry; the manager got the quiet failure note; nothing to Simon. |
| **Messages queued during a compact** (Simon's, and a manager's `send_message`) | Pass. Both ran after the compact, Simon's first, then the manager's; nothing lost or doubled. |
| **Resume after a compact** (stop, then a message) | Pass. Came back compacted (29k, not 79k) and still knew 4711 and TEAL-42. |
| **Self-clear**: without a handoff file | Pass. Refused: "There is no file docs/none.md in the project." Nothing queued. |
| **Self-clear with countdown, then Cancel** | Pass. 20 s countdown; Cancel kept the conversation; the session and (quietly) its manager were told. |
| **Self-clear through** (10 s) | Pass. The context figure went to "unknown" at the clear; the note pointed at `docs/handoff.md`; the session read it and answered "CLEAR-OK … 4711"; its manager got the quiet note. |
| **Context figure** right after a compact, no reply following | Pass. 75.4k → 26.6k at the boundary. |
| **A Ledung restart during a compact** | Pass. The test Ledung was stopped while the compact ran and started again; it caught up on the boundary and result, delivered the note headed "compacted", and recorded the cost. |
| The note as Simon's words | Pass, three times: asked who wrote the summary's note, the worker named its manager ("not from Simon"), the manager named itself. |
| **Working limit of 1** (another session holding the place on a permission prompt) | Pass. The compact waited ("queued"); **Start now** ran it; its `then` then waited for a place again and ran once the other session was done. |
| Cost | Pass. Every compact has one "Compaction" usage entry (for example 82.1k tokens, $0.0059, started by the manager); an interrupted compact records none. |
| `userSettings: false` (mock API, a temporary config folder with a personal `CLAUDE.md`, command, skill and agent) | Default sources: all four loaded. `userSettings: false`: none of them (the README says so now). |
| The page at 390 px and 1280 px (headless Edge) | Pass. "Compacting… 0:07" with "Note from manager …" in the header (on the phone it wraps under the session's details); the request event and the new divider in the chat. |

**Not tested:** "nothing to compact" live (a session's own compact always comes after a turn, and a manager's needs a session with a task, so it is covered by unit tests only); the 10-minute alert live (unit tests); compacts of 150k to 200k tokens and on Opus; Claude Code's automatic compaction (handled like a manual one for the divider and the context figure, its cost not counted); failures other than an interrupt; container projects and macOS. The status line under the chat says "Writing" while a compact runs (it reads the session as working); a word of its own there would be a small later change.
