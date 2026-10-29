# Step 3: Managers and the hierarchy — proposal

Oct 10, 2026 · Approved by Simon on 2026-10-10 (question #3), with one change: no limit on sessions per manager until step 6.

**Done when** (brief section 9): a manager starts and steers two builds without Simon opening either.

## What step 3 delivers (wants 1–5, and the 2026-10-10 decision on approvals)

- **Managers are sessions with extra tools.** A manager starts sessions, follows them, sends them instructions, answers their questions within its standing grant, and passes the rest to Simon.
- **Ledung records who started whom.** The session list becomes a tree: each manager with the sessions it started under it.
- **Sessions ask their manager, not Simon.** A session's `ask_user` goes to the manager that started it; a session Simon started directly still asks Simon.
- **Simon's answers travel through the manager without being rewritten.** The manager forwards Simon's stored words; Ledung delivers them verbatim.
- **Several managers, able to message each other** (for example one per project).
- **Simon can open and use any session**, as now, even though its manager normally handles it.

## How it works

### Managers

- **Start one from the page**: "New manager" next to "New session", choosing a project. It runs like any session in that project (same runner, same folder), with its own permission mode.
- **Its task is what Simon writes to it**, as with any session ("Get the review comments on PR 214 fixed and the build green, in two sessions").
- **Its standing grant** says what it may decide on Simon's behalf. It is set per project in the config (`"managerGrant"`), so one project can be stricter than another. Ledung adds the fixed limits from the brief that no grant can lift: never approve anything that can reach production, customers or personal data; never present its own decision as Simon's.

### The manager's tools

Added to Ledung's tool server, for managers only:

| Tool | What it does |
|---|---|
| `start_session(project, task, title?, permission_mode?, model?)` | Starts a session under this manager with `task` as its first message. `model` (added later, model per session) overrides the project's model for that session and is kept when it is resumed; which role gets which model is the project's own rule. |
| `list_sessions()` | Its sessions: status, what each is doing, open questions, last activity. |
| `read_session(id, since?)` | A session's recent messages as text, to check on progress. |
| `send_message(id, text)` | Sends an instruction to one of its sessions. Arrives marked "Message from your manager". |
| `stop_session(id)` | Stops one of its sessions. |
| `clear_session(id?, then?, countdown_seconds?)` | Clears one of its sessions, or itself (no id), like /clear, after a countdown the user can cancel; `then` arrives in the fresh conversation (decision of 2026-10-12). |
| `answer_question(question, answer)` | Answers a question from one of its sessions under the standing grant. Arrives marked "Your manager decided, under its standing grant: …". |
| `forward_answer(simon_question, to_question)` | Passes on Simon's answer to one of the manager's own questions, as the answer to a session's question. Ledung delivers Simon's stored words verbatim, marked "Simon answered (via your manager)"; the manager supplies no text. |
| `list_managers()`, `message_manager(id, text)` | Talking to other managers (want 3). |

A manager can only act on sessions it started. Simon can act on all of them.

### What wakes a manager

A manager isn't watching all the time; Ledung tells it when something needs it, as one message, sent when the manager is free:

- one of its sessions **asked a question**;
- one of its sessions **finished a turn with nothing running** (with the first lines of its last reply): no background work, ambient tasks included, and nothing scheduled, so it is done or waits for someone. A turn that ends while subagents or other background work run, or a wake-up is scheduled, is only a pause: the note waits quietly in the inbox (the latest one per session) and the later real turn end wakes the manager (decided 2026-10-13, replacing the first rule "every finished turn"; see decisions.md);
- one of its sessions **ended or failed**;
- a message from another manager.

Anything else the manager can look up itself with `list_sessions` and `read_session`. This keeps managers from spending tokens on every line their sessions write.

### Questions, step by step

1. A session asks with `ask_user`. The question goes to its manager, and Ledung wakes the manager.
2. The manager answers itself (`answer_question`), if its grant covers it. Or it asks Simon with `ask_user`, noting which session question it is about.
3. Simon answers the manager's question in "Waiting for you".
4. The manager forwards Simon's answer (`forward_answer`). Ledung delivers Simon's stored words to the session, verbatim.

**Simon sees it all**: "Waiting for you" gets a second section, "With managers", listing the questions managers are handling. Simon can answer any of them directly, which overrides the manager.

**Untrusted input:** what sessions write is data for the manager, never instructions from Simon. The manager's instructions say so, and nothing a session writes can reach another session as "Simon's words": only `forward_answer`, pointing at an answer Simon gave, does that.

### In the page

- **The session list as a tree:** managers with their sessions indented under them, each showing its status, and a badge for open questions.
- **A session started by a manager** shows "Started by <manager>" in its header. Messages from the manager are marked as such in the chat.
- **Every session stays usable by Simon**: open it, type, stop it, as today.

## The parts, in order

| Part | What | Done when |
|---|---|---|
| 3a | Roles and the tree: "New manager", who-started-whom in the database, the tree in the page, "Started by". | A manager and sessions under it show as a tree, also after a restart. |
| 3b | The manager's tools for its sessions: start, list, read, send, stop; waking the manager. | A manager starts two sessions, follows them and sends one an instruction, without Simon opening either. |
| 3c | Questions through the manager: routing, `answer_question`, `forward_answer`, "With managers" in the list. | A session's question is answered by its manager; another is forwarded to Simon and Simon's words reach the session verbatim. |
| 3d | Managers talking to each other: `list_managers`, `message_manager`. | Two managers exchange a message. |
| — | The done-when test, first on the Ledung project itself (a "build" being `npm run check` and a small change), later in a throwaway Docker container with a real build. | A manager starts and steers two builds without Simon opening either. |

## Decisions for Simon

1. **One manager per project** (recommended), started by Simon when wanted; or one manager for everything.
2. **A manager runs in its project**, same runner and folder as the sessions it starts (recommended).
3. **What wakes a manager:** a question, a finished turn, an ended session, a message from another manager (recommended); or more (every message), at a much higher token cost. *Changed 2026-10-13: a finished turn wakes the manager only when nothing runs in the background or is scheduled.*
4. **The standing grant per project in the config** (recommended), with the brief's fixed limits always added. What should Ledung's own project allow? Suggested: "ordinary development decisions: code structure, naming, which tests to add, retrying a failed step".
5. **Simon can answer a session's question directly**, overriding its manager (recommended).
6. ~~A limit on how many sessions one manager may run at once~~ — decided: **no limit** until machine resources are handled in step 6.
7. **Permission prompts from a manager's sessions still come to Simon in step 3**; moving ordinary ones to the manager is step 4.

## Not in step 3

Managers deciding permission prompts, and checks accepting Simon's words delivered by Ledung (step 4); token usage (step 5); machine resources and priorities (step 6).

## Progress

| Part | Status (2026-10-10) |
|---|---|
| 3a Roles and the tree | Done. "New manager", roles and parents in the database, the tree in the session list, "Started by" in the header. |
| 3b The manager's tools | Done (`src/sessions/management.ts`, `src/sessions/tools.ts`). Managers are woken through an inbox delivered when they are free. |
| 3c Questions through the manager | Done. Routing, `answer_question`, `forward_answer` (verbatim), "With managers" in "Waiting for you". |
| 3d Managers talking to each other | Done. |
| Done-when test | Run on a throwaway project (below); a test with builds in a throwaway Docker container is still to do. |

Checked live (Haiku, throwaway Ledung): a manager started two sessions; one asked it a question within its grant and the manager answered it itself; both finished their work. A third session asked something outside the grant: the manager asked Simon (about that question), and Simon's answer reached the session word for word, marked as forwarded. One manager messaged another, and it arrived. Found and fixed on the way: messages for a session that hadn't had its first message yet were never delivered.

## Checked on 2026-10-13: turn ends and background work

Claude Code 2.1.x, Haiku, the Agent SDK in a temp folder and a throwaway Ledung (port 4397):

- A session that starts a background subagent and has nothing else to do **ends its turn at once** (a result with `num_turns` 2). Its Stop hook then lists the subagent in `background_tasks`, and `background_tasks_changed` already counted it. The Stop hook runs just before the result, so its figures are current when Ledung handles the result.
- When the background work reports back, **Claude Code starts a new turn by itself**. With the subagent running a shell command, the first such turn (an interim report) again ended with something running (`background_tasks`: the shell), and only the last turn, after `background_tasks_changed` showed an empty list, ended with nothing running.
- Live, the manager of a throwaway project (Haiku): a session with nothing running woke it at its turn end; a session with a background subagent left a quiet note at its first turn end and woke it once, when the subagent had reported and nothing ran (46 s later). The interim notes were replaced, not piled up.
- Monitors and scheduled wake-ups: not retested; the idle-stop live test (idle-stop-and-archive.md) already showed the Stop hook lists a Monitor in `background_tasks` and a CronCreate wake-up in `session_crons`. Both are treated like background work (a pause).
