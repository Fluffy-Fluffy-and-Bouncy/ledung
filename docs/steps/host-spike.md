# Session host spike: can a restarted Ledung take over a running session?

Oct 10, 2026. **Result: yes.** Built the same day (`src/host/`); see [decisions.md](../decisions.md).

## Set-up

- A **host** (`host.mjs`, about 70 lines): started detached, owns the Claude Code process, numbers every line Claude writes, keeps them, and remembers which control requests (permission prompts) are still unanswered. It listens on a named pipe. A client says which line it has seen last; the host replays everything after it, re-sends unanswered requests, then streams.
- A **core** (`core.mjs`) playing Ledung: drives the session through the Agent SDK as Ledung does, but its "process" is a connection to the host (`spawnClaudeCodeProcess` returns an object whose stdin and stdout are the pipe). It records the last line number it has seen.
- The turn: five Bash commands, one at a time, each needing permission. Haiku, Windows 11, Claude Code 2.1.295, SDK 0.3.295.

## Results

| Test | Result |
|---|---|
| Core quits abruptly while permission prompt 3 is waiting; a new core attaches | ✅ The new core received prompt 3 again (re-sent by the host), answered it, and the turn ran on through 4 and 5 to "done". |
| Core quits right after answering prompt 2; Claude keeps working for 8 s with no core attached | ✅ The 4 lines Claude wrote meanwhile were replayed to the new core exactly once, in order, and the turn finished normally. |
| A new message after the takeover | ✅ Normal reply; Claude remembered all five numbers. |
| Hooks after the takeover | ✅ The new core's `UserPromptSubmit` hook ran: the SDK's repeated start-up handshake re-registers hooks and the permission callback with the running process. |
| Stopping the host | ✅ Claude exited with it; nothing left running. |

## What the build must take care of

1. **Re-send unanswered requests.** The host tracks control requests from Claude by `request_id` and drops them when the answer passes through; on reconnect it re-sends the open ones. This is what carries a waiting permission prompt across a restart.
2. **Record the last line only once its message is stored.** In the spike the core recorded the line number as soon as it passed the line on. In Ledung, the line number must be saved in the same database write as the message, or a crash in between could lose a message. Ledung will therefore store messages from the lines as they arrive from the host (they are the same JSON the SDK delivers), not from the SDK's output.
3. **Hook callbacks in flight.** A hook callback the old core registered and Claude is waiting on during a restart would reach the new core under an id it doesn't know. Hooks run briefly at the start of a turn, so this window is tiny; the new core should answer an unknown callback with "continue" instead of failing.
4. **Lifetime rules** (decided 2026-10-10): restart keeps hosts running; closing Ledung stops them; a host with no Ledung connected for a few minutes stops its session by itself.
5. **The host stays small and rarely changes.** A running session keeps the host it started with; a new release's host is used for new sessions.
