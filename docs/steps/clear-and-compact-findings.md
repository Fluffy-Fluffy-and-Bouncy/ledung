# Clear and compact: findings

Oct 13, 2026 · Investigation only, requested by Simon. Nothing in Ledung was changed. Everything below was run on Windows, Claude Code 2.1.295 with Agent SDK 0.3.295, in temp folders and a throwaway Ledung (port 4390, own config and data, Haiku; a few runs on Sonnet). The real Ledung, its data and the Docker containers were not touched. The temp folders, the throwaway Ledung and the transcripts the tests left under `~/.claude/projects` were removed afterwards.

Every claim from the other project's report was tested here. "Verified" means observed in this setup; what could not be tested is listed in the last section.

## Summary

| # | Claim | Result |
|---|---|---|
| 1 | `/compact` and `/compact <instructions>` as a user message through the SDK's streaming input | **Verified**, also mid-turn (it waits for the turn to end) |
| 2 | `compact_boundary`, then `result`; no premature "done" | **Verified**; the full order is below; a message queued during the compact runs after it |
| 3 | Duration, failure, too little to compact | **Verified** for 6k to 70k tokens (3 to 19 s); minutes not seen; failure shows only as text |
| 4 | Ids | **Verified**; Ledung follows the one that changes. **No problem found** |
| 5 | "Compact Instructions" in CLAUDE.md | **Verified** for the project file (3 of 3 runs, with a caveat); user-level only through a mock API; a slim profile with `userSettings: false` drops the user-level file |
| 6 | Hook `{continue:false, stopReason}` ends the turn cleanly | **Verified** |
| 7 | Pushed text looks like the user's own typing | **Verified**; the SDK's `origin` field is accepted and has no visible effect |
| 8 | A session does what its instructions say about calling a tool | **Verified** in 32 of 32 short runs (Haiku and Sonnet); not shown for long, busy sessions |

Two findings the report did not mention, both of which matter for the design:

- **The context number goes stale** after `/clear` and `/compact`. Ledung only updates it from the next reply, so "Your context: 155k tokens" is still shown on the first prompt after a compact (this very conversation is an example). A rule like "compact above 120k" would fire again.
- **A failed compact looks like a success** (`result` with `is_error: false`). It can only be told apart by its text or by the `status` message before it.

## 1. `/compact` through the streaming input

Pushing the plain text `/compact` as a user message (exactly what Ledung's `pushInput` does for `/clear`) compacts the conversation. Pushed while a turn is running, it is held and runs after that turn's result (400-word answer, `/compact` 1.5 s in: answer finished first, compact after, then the secret from before was still known). Pushed to a brand-new session it returns at once (see 3).

`/compact <instructions>` works and the instructions are honoured: after `/compact Keep ONLY the secret number … mention the word ZEBRA`, the summary was "The secret number is 4711. Summary: Secret number: 4711. ZEBRA." The summary sent to the model ends with a line giving the path of the full transcript file, so the session can read the old conversation from disk afterwards. A Haiku session did that (Grep on its own transcript) to answer a question about content the summary had dropped. That is worth knowing: a compacted session is not as forgetful as the summary suggests, and it was not what the test was meant to measure.

Facts for the page: while it runs there is no assistant message and no tool use; the summary arrives as a synthetic `user` message (`isSynthetic: true`, text "This session is being continued from a previous conversation…").

## 2. Message order during a compact

Observed in the SDK (`session_id` stays the same throughout):

```
status            status: "compacting"
status            status: null, compact_result: "success"        (or "failed" + compact_error)
system/init       (the same session id)
system/compact_boundary   compact_metadata: trigger "manual", pre_tokens, post_tokens, duration_ms, preserved_segment…
user              isSynthetic: true   the summary
user              isReplay: true      "<local-command-stdout>Compacted </local-command-stdout>"
result            subtype success, num_turns 0, result ""
```

Through the throwaway Ledung the same lines arrive and are stored (`status`, `compact_boundary`, two `user`, `result`). The page already draws a divider for `compact_boundary` (`MessageList.tsx`).

- **No premature result.** The `result` comes after the boundary, after the whole compact. Test: `/compact`, then 400 ms later "Reply with exactly the word PONG." The compact finished (15.7 s), its result (turns 0) arrived, and only then PONG ran and got its own result. Nothing was lost or merged.
- `/clear` is the same shape but much shorter: `conversation_reset`, `init` (new id), `result` (turns 0), all within about 0.2 s.
- Interrupt during a compact (`q.interrupt()` 4 s in): `status` with `compact_result: "failed"`, `compact_error: "API Error: Request was aborted."`, `result` (success, turns 0). The conversation was intact afterwards (the secret was still known).

## 3. Duration, failure, too little to compact

Duration (`compact_metadata.duration_ms`, conversation of real text):

| Model | Tokens before → after | Time |
|---|---|---|
| Haiku | 2.6k → 1.5k | 5.4 s |
| Haiku | 5.5k → 1.5k | 4.6 s |
| Haiku | 6.3k → 2.1k | 8.1 s |
| Haiku | 6.4k → 2.5k | 13.9 s (same size as the line above: it varies) |
| Haiku | 28.7k → 2.4k | 5.6 s |
| Haiku | 70.7k → 2.4k | 15.7 s |
| Sonnet | 70.3k → 2.4k | 18.6 s |

So up to 70k tokens it is seconds, not minutes. The time is mostly the summary being written, not read. Minutes for a 150k+ conversation, or on Opus, are plausible but **not tested**. Ledung's side must not assume either: the turn stays open (status `running`) the whole time, which also keeps the idle stop away and counts against the working limit.

Failure: resumed a session against a local fake API that answers 500 to everything, then `/compact`:
`status` (compacting) → `status` (`compact_result: "failed"`, `compact_error: "Error during compaction: API Error: 500 …"`) → `result` with **`subtype: "success"`, `is_error: false`, `num_turns: 0`, `result: "Error during compaction: …"`**. The conversation stays as it was. Only the `status` message or the text of `result` tells.

Too little to compact: `/compact` as the first message of a session: `result` (turns 0, `result: ""`) after 49 ms, no `status`, no boundary, no error. Indistinguishable from a successful clear by the result alone; only the missing `compact_boundary` shows nothing happened. `/compact` twice in a row, on 2.5k tokens: both ran (2.5k → 1.5k the second time).

Compaction's own model call is not visible as usage: the `result` of a compact has `usage` all zero and no assistant message, so Ledung's usage recorder (which counts assistant messages) does not count its cost. `total_cost_usd` was not looked at.

## 4. Ids

Every id involved, and what Ledung does with it:

| Id | Where | `/clear` | `/compact` | Ledung |
|---|---|---|---|---|
| Ledung session id | Ledung's database; names the host pipe (`pipePath`) | same | same | its own key for everything |
| Claude Code `session_id` | `init`, `result` and every message; the transcript file is `<session_id>.jsonl` | **new** (new file, no link to the old one) | **same** (the file grows: boundary + summary appended) | `claudeSessionId`, taken from **every** `init` (`onMessage`); used for Resume (`startResumed`) |
| `conversation_reset.new_conversation_id` | only in the `/clear` message | new, but **not** the new `session_id`: it is the uuid of that message itself | none | not used |
| message `uuid`, transcript `parentUuid` | each message / transcript line | the new file starts again with no parent | `compact_boundary` has `logicalParentUuid` pointing at the old last message; `preserved_segment` lists the kept messages | not used |
| `promptId`, `tool_use` ids | transcript / tool calls | – | – | not used |

Observed in the throwaway Ledung:

- After `/clear`: `claudeSessionId` changed (3a7ba650 → b74341a5, and for Magto's own clear d880fbde after 239185e0). The `init` with the new id arrives before the `result`, so Ledung has the new id by the time the clear is done.
- After `/compact`: `claudeSessionId` unchanged (fdd09c23), no new id to follow, as expected.
- Stop, then Resume: the **compacted** session came back compacted and knew the secret number and the word; the **cleared** session came back cleared (answered NONE). Resuming the old, pre-clear id with the SDK directly does bring the old conversation back (answered 4711), so keeping the old id would have been a bug; Ledung doesn't. A session that was cleared and had no turn since resumes fine, because `/clear` already writes the new transcript file.

**Conclusion: no problem.** Ledung uses the id that changes, at the right time. The only gap is the context number (next).

Stale context number: `contextTokens` is only set from assistant messages' usage (`recorder.ts`). After a compact in the throwaway Ledung it still read 30434, the number from before; after a clear 30484. The `UserPromptSubmit` hook shows that number on the next prompt, before any new reply. `compact_boundary` carries `post_tokens` (2.4k to 2.5k in the runs above; that counts the conversation, not the fixed system prompt of about 25k, so it is not directly comparable with `contextTokens`) and `conversation_reset` says the context is empty.

## 5. "Compact Instructions"

How it works: nothing special extracts the section. Claude Code puts the CLAUDE.md files into the first message of the conversation, and the compact prompt ends with: "There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions…", with `## Compact Instructions` as an example (read from the request sent to a mock API). So any CLAUDE.md that is loaded can steer it, and the model decides.

- **Project CLAUDE.md, real model:** a section asking for the code word `TEAL-42` in the summary and to keep all numbers: Haiku 2 of 2, Sonnet 1 of 1 (and the locker number 318 kept every time). A different instruction, "the very first line of the summary must be exactly …", was **not** followed (Haiku, 1 run): the summary has a fixed structure, so ask for content, not for a position.
- **User-level `~/.claude/CLAUDE.md`:** a temp `CLAUDE_CONFIG_DIR` has no login, so a real-model run was not possible (and the login files were not touched). Instead a local mock API recorded what Claude Code sends: with the default setting sources, text from the user-level file is in the conversation and in the compact request, like the project file. The real `~/.claude` has no `CLAUDE.md`, and nothing there was edited. So user-level text reaches the summarizer; whether the model follows it was not tested (expected to be the same as the project file).
- **Slim profiles:** `userSettings: false` sets `settingSources: ['project','local']`. With that, the mock showed the **user-level CLAUDE.md is not loaded at all** (nor, therefore, its Compact Instructions or any other rule in it); the project file is. Without it (the default, and `slim` in the example config, which does not set it) the user-level file is loaded. The README says `userSettings: false` skips "your user settings file"; it also skips the user-level CLAUDE.md. Worth a sentence there.
- The text given to `/compact` itself is the most reliable way to steer one compact (the ZEBRA test), since it does not depend on which files are loaded.

## 6. Hook `{continue: false, stopReason}`

A `PostToolUse` hook returning `{continue: false, stopReason: "…"}` after an in-process MCP tool ended the turn at once: the tool result was recorded, no further model call was made, `result` came with `subtype: "success"`, `is_error: false`, `result: ""`, `num_turns: 2`. The `Stop` hook still ran. The next message started a normal turn. The `stopReason` text did not appear in any message of the stream. So it can end a turn right after a "compact now" tool call without the session adding closing text; Ledung would not learn why from the stream.

## 7. Pushed text and who it is from

Claude Code has no way to tell. A message pushed into the streaming input is stored as an ordinary user message (`promptSource: "sdk"`, `userType: "external"`), with the same text the model gets. The SDK's user message type has an `origin` field (`human`, `peer`, `channel`); I sent each variant to a mock API: the text the model received was identical for all of them and the transcript lines were identical too. In this version the field has no visible effect (a trust gate that reads it was not tested).

What Ledung does today is enough for what exists now, and is the right pattern for compact: the user-role text is a closed list of fixed strings (`/clear`, `/compact`, the sentence "Ledung has delivered messages for you … not from Simon"), and everything with content (manager messages, notes, the context line) goes in the `UserPromptSubmit` hook's `additionalContext`, headed "Delivered by Ledung (not from Simon)". The model sees the difference (it is how this conversation's messages are labelled). A compact with free-text instructions (`/compact <text>`) would break "closed list": the instructions would travel as user text. Keep them out of the user text, or fix them to a short allowed set (open question 3).

## 8. A session calls the tool its instructions name

Setup: a tool `request_compact`; the rule "when the line `Your context: Nk of 200k tokens.` shows 120 or more, call it once after answering; below 120 never"; the line injected by a `UserPromptSubmit` hook as Ledung does. Four different simple questions at 150k and four at 40k, per model and per place the rule stood (project CLAUDE.md, or the tool server's `instructions`):

| Model | Rule in CLAUDE.md | Rule in MCP instructions |
|---|---|---|
| Haiku | 8/8 right (4 called, 4 not) | 8/8 right |
| Sonnet | 8/8 right | 8/8 right |

These are single-turn sessions with a trivial task and the number in plain view. That a long session in the middle of real work (tool calls, a big task, the line several turns old) is as reliable was **not tested**. The sensible way to rely on it: the rule fires on a number Ledung supplies each turn (it already does), and Ledung never trusts the session to have done it; a manager's or Simon's decision stays possible.

## Magto's clear flow, against these findings

Tested with a manager in the throwaway Ledung: `clear_session` on itself with `then` and a 10 s countdown.

- Sequence in the history: the tool call, the turn's result, "Clear requested … Clearing in 10 s", "Conversation cleared.", `conversation_reset`, `init` (new id), `result` (turns 0), then the delivery with the `then` note (from `ledung`), the model's reply "RESUMED-OK / NONE" (it did not remember the secret number from before the clear), and its result. The note waited correctly: it went in only after the clear's result, so it is the first thing in the fresh conversation.
- The mechanics behind that (`deliver`): the `/clear` item and everything after it stay in the inbox until the turn is over; `pushInput('/clear')` resets `awaitingResumeResult`, so the zero-turn result ends the clear instead of waiting for another; that result calls `deliver()`, which hands over the note. All of that held.
- **Same approach for compact?** Yes, with four differences:
  1. It takes 5 to 20 s (probably more for large ones) instead of 0.2 s. The sequence is the same, so the note still waits correctly. Status stays `running` and the turn stays open; nothing else needs to change for that.
  2. A cancel countdown is not needed for the same reason as for clear: nothing is lost (the old conversation stays in the transcript file, and the summary even names it). Whether Simon wants one anyway is a question.
  3. The result can be a **failure** that looks like success. Without a check, the note ("your context was compacted, continue with…") would be delivered after a failed compact and the requester would be told it worked.
  4. The context number must be set from the `compact_boundary`/`conversation_reset` message, or the rule refires.
- `countingDown`'s timer, the cancel, `clearDue` are only about the countdown and need no change for compact.

## Proposed design (not built)

Mirror `clear_session` with one more kind of inbox item, so that the delivery code stays the one place that decides when a turn may start:

1. **Tool `compact_session`** (managers: own sessions or themselves; sessions: themselves only, through the same Ledung tool server). Arguments: optional `instructions` (for the summary), optional `then` (delivered after the compact, like `clear_session`'s). Stored as an inbox item `compact:<requester>` plus the optional note, behind what was already waiting, exactly like the clear.
2. **`Session.deliver`:** when the compact item is first, push `/compact` (with the instructions appended, if the rules in question 3 allow), mark `running`, begin a turn, no countdown (or a short one if Simon wants it).
3. **`onMessage`:** on `status` with `compact_result: "failed"` (or a `result` whose text starts with "Error during compaction") record an event "Compact failed: …", tell the requester, and do **not** deliver the `then` note as if it had worked (it could be delivered with a "compact failed" line instead). On `compact_boundary`, set `contextTokens` (and on `conversation_reset` set it to unknown/empty) so the prompt line is right straight away; record "Compacted: 70k → 2.4k in 16 s" from `compact_metadata`. The page can show "Compacting…" while the status is `compacting`.
4. **Rule for sessions** stays Simon's/the workflow's, as for clear: the per-turn "Your context: …" line is already there; a CLAUDE.md or the tool's instructions say when to call it. Evidence in 8 is good enough to try, not to rely on.
5. **Optional:** a `PostToolUse` hook on the compact tool returning `continue: false`, so the session doesn't write a closing reply before the compact (6). Not needed, only tidier.
6. Usage of the summarizing call is not counted today (3); decide whether that matters before long-run cost figures are trusted.

## Open questions for Simon

1. Should a compact have the cancel countdown that a clear has (nothing is lost, so I would say no), or a shorter one?
2. May a **session** compact itself on its own rule (as a manager may clear itself), or only a manager, or only you? Sessions without a manager would then only compact when you ask.
3. Instructions for the summary: pass them as an argument of the tool (travels as user text, so the "closed list of fixed texts" rule bends), or only through `## Compact Instructions` in the project's CLAUDE.md (no change to that rule, but not specific to one compact, and a user-level file does not apply under `userSettings: false`)? I would allow the argument but keep it to plain text and show it in the page.
4. After a failed compact: tell only the requester, or also you? Retry automatically, or never?
5. Should `userSettings: false` (README) say that it also skips `~/.claude/CLAUDE.md`? Do you rely on that file for sessions on a slim profile?
6. Do you want the compaction's own cost counted in usage? It needs the figure from somewhere other than an assistant message.

## Not tested, or only partly

- Compacts above 70k tokens, and Opus; 150k to 200k are the sizes that matter. Claude Code's own automatic compact near a full context (`trigger: "auto"`) was not provoked; the code that handles `compact_boundary` should treat both the same.
- Compact Instructions from a user-level file with a real model (only that the text reaches the summarizer, by mock API); Sonnet only once for the project file; the "first line exactly" form only once.
- Failure was provoked by a fake API (500) and by interrupting; overload, rate limit and a context too large to summarize were not.
- Whether `origin` is read by any trust gate (auto mode classifier, permission paths) in this Claude Code version.
- Docker runner, macOS, and other Claude Code versions. The message shapes are from 2.1.295.
- Reliability in 8 beyond short, single-turn sessions with a plain rule.
