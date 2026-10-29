# Step 2: Questions — proposal

Oct 10, 2026 · Approved by Simon on 2026-10-10 ("Yes, go ahead"), for 2a to 2c.
Revised the same day: questions are routed through the session's manager (decision of 2026-10-10 in [decisions.md](../decisions.md)); "Simon's own words" moved to steps 3 and 4.

**Done when** (brief section 9): a question asked mid-build is answered from the list and the build carries on.

## What step 2 delivers (wants 6, 7, 11)

- **Sessions ask through a tool, never in passing.** A session that needs a decision or information calls `ask_user`. The question becomes a record: stored, numbered, marked open or answered. Questions are never picked out of chat text.
- **Questions go to the session's manager, or to Simon if it has none.** Managers arrive in step 3; until then every question comes to Simon. The routing is built in now, so step 3 switches it on without rebuilding the list.
- **One list of everything waiting for Simon**, across all sessions: questions, and also the permission prompts and multiple-choice questions that today appear only inside each chat. Answer from the list, and the answer goes straight to the session (or manager) that asked.
- **Every answer is stored with who gave it** (Simon, or later a manager under its standing grant), the question it answers, and when; ready to be forwarded verbatim by Ledung in step 3.
- **A quote button** on any message: it puts that message into the message box with a reply, so a session can be pointed back at something it no longer has (after a compaction, say).

## The direction this is built for (decided 2026-10-10)

A session never needs Simon's approval in its own chat. It asks its manager; the manager decides within its standing grant, or asks Simon; Simon answers the manager in Ledung's list. The manager **routes** Simon's answer but never **writes** it: it asks Ledung to forward answer #N, and Ledung delivers Simon's stored words verbatim, marked as Simon's. Decisions the manager makes itself are marked "decided by the manager under the standing grant". Sensitive actions (production, personal data and similar) still need Simon; only the place where Simon answers changes.

Checks that today accept a go-ahead only if Simon typed it in that session will need to accept "Simon's words, delivered by Ledung" instead. That is designed in steps 3 and 4 (wants 13, 14).

## How it works

### The tool: `ask_user`

Ledung gives each session a small set of tools of its own, through the Agent SDK's in-process MCP server: the tools run inside Ledung and reach the session over the same connection Ledung already uses. Checked in the SDK on 2026-10-10. That settles two open issues:

- **#5 (session identity):** each session gets its own server, created for that session, so a tool call always knows which session it comes from. No tokens needed.
- **#6 (containers reaching Ledung):** nothing to reach; the tools travel over the session's existing connection, also for sessions in a container.

`ask_user` takes:

| Field | Meaning |
|---|---|
| `question` | The question, in Markdown. Should stand on its own: Simon may read it on a phone, hours later, without the chat. |
| `options` | Optional: 2–5 suggested answers, shown as buttons. Simon can always type something else. |

The tool records the question and **returns at once**: "Question #12 is recorded. End your turn now; the answer will arrive as a message." The session ends its turn instead of waiting inside a tool call, so nothing times out and nothing is held open for hours. The server's instructions tell every session to use `ask_user` whenever it needs Simon, and to end its turn after asking.

The tool is allowed automatically; it never needs a permission prompt of its own.

### Delivering the answer

- **The answer arrives as a normal message**, with the question attached so the session can't confuse it: *"Answer to your question #12 ('Update the lockfile now or after the review?'): After the review."*
- **If the session is busy** with another turn, the answer waits and is sent when that turn ends. Ledung already knows when a turn ends.
- **If the session has ended**, the answer is kept, and the list offers **Resume and deliver**.
- **If a question is no longer needed**, Simon can withdraw it, or the session can (a second tool, `withdraw_question`).

### The list: "Waiting for you"

- **At the top of the session list:** a "Waiting for you" entry with a count, also shown in the browser tab title, e.g. "(2) Ledung", so it's visible from another tab or the phone's tab switcher.
- **Each item shows** which session asked, its project, when, and the question in full, with the answer box and option buttons right there. Permission prompts and multiple-choice questions appear with their Allow/Deny or choices, exactly as in the chat.
- **Answered items** move to an "Answered" section: question, answer, who answered (Simon, or later a manager) and when.
- **In the chat**, an open question also shows as a card, answerable there too; both places stay in sync.
- Works on the phone, which is where a list like this is most useful.

### The quote button

On each message from Claude (and Simon's own), a **Quote** button puts the message into the message box as a quote, with its time, and Simon types a reply under it. Sent as one message. No change to the session needed.

## The parts, in order

| Part | What | Done when |
|---|---|---|
| 2a | Ledung's tool server per session, `ask_user` and `withdraw_question`, the questions table, delivery (also after a restart, for busy and ended sessions). | A session asks, the question is stored, an answer sent through the API arrives and the session carries on. Checked across a Ledung restart. |
| 2b | "Waiting for you": the list, cards in the chat, the count in the tab title; permission prompts and multiple-choice questions included. | Questions and prompts from two sessions are answered from the list, on the computer and on the phone. |
| 2c | Quote button. | A quoted message and reply arrive as one message. |
| 2d | Docker check from step 1 (1e), then the done-when test. | A question asked mid-build is answered from the list and the build carries on. |

2a to 2c work for local projects on their own; 2d needs a Docker container.

## Decisions for Simon

All five decided by Simon on 2026-10-10 as recommended (number 3 "for now").

1. **Tool name: `ask_user`** (recommended), with the name shown in the page ("Simon") taken from the config, which keeps the repository generic. The brief calls it `ask_simon`.
2. **Permission prompts and multiple-choice questions in the same list** (recommended), or questions only.
3. **Answers wait until a busy session finishes its turn** (recommended), rather than interrupting it.
4. **Questions from subagents (issue #8):** a subagent that calls `ask_user` is told to stop and report to its parent that question #N is open; the parent ends its turn; the answer goes to the main session. Recommended, since only the main session can receive messages.
5. **Notifications:** for now the count in the tab title only. Pop-up notifications need HTTPS on the other computer and the phone, so they come with access from outside the house.

## Not in step 2

Managers answering questions or permissions, and forwarding Simon's verified words, with the guards adapted to accept them (steps 3 and 4); token usage (step 5); anything over the internet.

## Progress

| Part | Status (2026-10-10) |
|---|---|
| 2a Tools and delivery | Done. One in-process tool server per session (`src/sessions/tools.ts`) with `ask_user` and `withdraw_question`; questions table; answers delivered when the session is free, also after a restart. |
| 2b "Waiting for you" | Done. List across sessions with questions and permission prompts, question cards in the chat, count in the tab title. |
| 2c Quote button | Done. |
| 2d Docker check and done-when test | To do, in a throwaway Docker container. |

Checked live (Haiku, throwaway Ledung): a session asked with options, no permission prompt for the tool, the answer arrived and the session used it; a question stayed open through a Ledung restart and its answer was delivered afterwards; the tool kept working after the restart; withdrawing works.
