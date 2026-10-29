# Idle stop and archive

Oct 12, 2026 · **Approved by Simon on 2026-10-12** (questions #20 and #21): no automatic archive (decision 6) and no "Archive all ended"; all other decisions as recommended. From the offer Simon was given: stop sessions that sit idle, so their Claude Code processes give back memory; resume them when a message arrives; and archive ended sessions so the sidebar shows what matters. Nothing is deleted.

**Done when:** a session left idle is stopped on its own after the set time, and a message from Simon or its manager brings it back and is answered; a session with work running in the background is left alone; ended sessions can be archived by their manager or by Simon (one at a time or all of a project's), and come back when resumed; all of it works from the phone.

## What it delivers

- **Idle sessions stop on their own.** A session that has finished its turn and has nothing waiting is stopped after a set time (default 1 hour), which frees its Claude Code process and everything it holds. The chat shows "Stopped after 1 h idle", and so does the session's end reason.
- **A message brings a stopped session back.** Writing to an ended session (from the page, from its manager, or answering its question) resumes it and then delivers the message. No Resume click first.
- **Archive.** Ended sessions can be archived: they leave the sidebar but nothing is lost. Each project gets an "Archived (N)" link that lists them, with Resume and Unarchive. Resuming an archived session unarchives it. Nothing is archived automatically (decided by Simon, 2026-10-12).
- **Managers archive their own sessions** with `archive_session`, whenever they judge fit, typically once a session's work is done and reported.
- **Simon can archive any ended session from the page**: an Archive button in the session header. That includes sessions Simon started directly, outside the manager, which only Simon can archive.
- **No deletion for now.** History, usage records and grants stay; Claude Code keeps its own transcript anyway. Deleting can come later (see "Later").

## How it works

### When a session counts as idle

The check runs once a minute. A session is stopped only when **all** of these hold:

- It is a **session, not a manager.** Managers are never stopped automatically.
- It is **between turns**: status idle, or starting (resumed or started, but not spoken to yet). Never while running, waiting on a permission prompt, waiting for a free place (queued), stopping, or **paused**.
- **Nothing is waiting for it or from it:** no permission prompt pending, no open question it asked, no held message from Simon, no undelivered answer or manager message (the same lists `deliver()` reads, `src/sessions/session.ts:573-575`).
- **No background work and nothing scheduled** (next section).
- **Nothing has happened for the whole idle time.** The clock counts from the last activity of any kind: any line from Claude Code (including background-task events and turns Claude Code starts by itself), any message delivered, any decision. A Ledung restart resets the clock, which only makes it more careful.

The time is a config setting, `idleStopMinutes` (default 60; 0 turns it off). Ledung reads it at start, like the other settings in the config file (`src/config.ts:65-87`).

### Not losing work

Stopping a session ends Claude Code **and everything it started**: the host records the process tree and ends what is left (`src/host/stop.ts:20-30`). So a stop must never hit a session that is still doing something. What the code shows, and what the design does about it:

- **Background tasks.** Ledung already counts a session's background tasks from Claude Code's `background_tasks_changed` (`src/sessions/session.ts:398-401`), but **leaves out the ones Claude Code marks "ambient"**, which include live-update watchers such as Monitor (SDK type at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3712-3740`). That is right for the "N in background" label, wrong for an idle check: a session waiting on a Monitor would look idle. The idle check counts **every** task, ambient or not. Background subagents are background tasks too, so they are covered.
- **Scheduled wake-ups** (`/loop`, ScheduleWakeup, CronCreate) live inside the Claude Code process and would be lost on a stop. Claude Code tells Ledung about them: its **Stop hook**, called at the end of every turn, carries `background_tasks` and `session_crons` (`sdk.d.ts:9627-9642`). Ledung adds a Stop hook (next to its PreToolUse and UserPromptSubmit hooks, `src/sessions/session.ts:268-288`) that only notes the two lists and returns nothing, so it can't change a turn. A session with anything scheduled is not stopped. The last list is kept in the database, so it survives a Ledung restart.
  - If Claude Code doesn't send `session_crons` (an older Claude Code, e.g. in a container; finding 5 of the step 1 spike), Ledung can't tell, and **doesn't stop** that session.
- **Subagents in the foreground** run inside a turn, so the session isn't between turns and isn't stopped.
- **Programs started outside Claude Code's own tracking** (a server started detached by a script) are invisible to both lists and would be ended by the stop, as with a Stop by hand today. The stop event lists what the host had to end (the host already returns it, `src/host/stop.ts:20`), so it shows when this happens.

### What a stop does

The same as Stop today (`src/sessions/session.ts:663-685`), with its own reason: "Stopped after 1 h idle." It is an event in the chat and the session's end reason, so the sidebar and the session header show it (`web/src/App.tsx:390`). The session host doesn't change. Nothing new is stored about how a session ended: the end reason says it, and the idle stop itself knows to send the manager a quiet note instead of waking it (below).

### Resuming on a message

Today a message to an ended session is refused: from the page with "Resume it first" (`src/sessions/manager.ts:559-568`), from a manager with "has ended" (`src/sessions/management.ts:214`). An answer to an ended session's question is stored and waits until someone presses Resume (`src/sessions/manager.ts:260` delivers only to a live session).

**About "Resume and deliver" from step 2:** step 2 planned that button in the "Waiting for you" list (docs/steps/step-2.md:46), but it was never built. The page has a plain Resume in the session header only (`web/src/App.tsx:441`), and an answered question for an ended session says "waiting for the session to finish its turn" (`web/src/components/QuestionCard.tsx:64`), which is misleading. Delivery after a resume works anyway, without any special code: a resumed session's first output is an empty result (spike finding 7), which runs `deliver()` (`src/sessions/session.ts:416-425`) and hands over everything waiting. Writing to a stopped manager already uses exactly this (`src/sessions/manager.ts:442-457`: resume, then send).

*As built:* the live test showed that Claude Code 2.1.295 no longer sends that empty result; it waits for the first message. A resume now hands over what waited for the session itself, right after the session starts (see Progress).

So the design reuses that one path for everything: **resume if ended, then deliver as usual.**

- **Simon's message** in the page: the message box stays enabled for an ended session ("Sending resumes the session"); `send` resumes, then sends.
- **A manager's `send_message`** to its own ended session: resumes it, then puts the message in its inbox. The manager is told "Resumed and sent".
- **An answer** to an ended session's question (from Simon, or a manager's `answer_question` / `forward_answer`): resumes it, and the answer is delivered.
- **A manager writing to another manager** that has ended (`message_manager`): resumes it too, as Simon's message to a project already does.
- **Resuming an archived session unarchives it.**
- **Two messages at once** must not start two resumes. Today the second would get "still running" (`src/sessions/manager.ts:533`); a small helper keeps the resume under way and lets the second message wait for it.
- **If resuming fails** (the project was removed, its account has no login), Simon sees the error, a manager gets it as the tool's answer, and the message stays undelivered.
- A resumed session gets the project's **current** settings (account, model), as a Resume does today (`src/sessions/manager.ts:414` and `535-539`). Its permission mode is its own and is kept.

### Grants after a stop and resume

**They survive.** "This session" grants are stored in Ledung's database under the Ledung session id (`src/sessions/session.ts:489`, `grants` table), and a resume keeps that id (`src/sessions/manager.ts:529-544`). Every permission request goes through Ledung's check first (`src/sessions/session.ts:440-447`), which finds the grant and allows it, with "Allowed under a grant from …" in the chat. Grants carried down from the manager are found the same way (`src/sessions/management.ts:110-122`).

What is lost is Claude Code's own copy of the rule (sent as a session rule, `src/sessions/grants.ts:58-60`), which lives in the process. After a resume, a repeat of a granted request reaches Ledung instead of being allowed inside Claude Code. Ledung allows it without asking anyone; the only difference is one "Allowed under a grant" line in the chat. The design leaves it like that rather than handing the rules back to Claude Code (see decision 8 and the finding about sensitive requests below).

### Does a resume cost tokens?

**Not by itself** (confirmed in the live test: no model call until the first message). The empty result on resume has zero turns and no model call (spike finding 7; Ledung skips it as a turn at `src/sessions/session.ts:418-420`), and usage is recorded only from real model replies (`src/usage/recorder.ts:105`). Starting Claude Code takes a few seconds and runs the project's start hooks and MCP servers again.

The real cost comes with the **first message after a resume**: Claude reads the whole conversation again without a warm prompt cache. But a session idle for an hour would have lost its cache anyway (the cache lasts minutes, an hour at most), so stopping after an hour adds little. A much shorter idle time would. Measured in the live test (Haiku, within minutes, so with the cache still warm): the first turn after a resume wrote 8,349 tokens to the cache and read 21,715; a later resume wrote 555. A turn on a session left running for 5 minutes wrote 150 and read 31,859. So a resume costs up to a few thousand extra cache-write tokens once, against a full re-read of the conversation for any session whose cache has expired. An hour-long gap was not measured.

### Archive

- **Only ended sessions** can be archived. **Managers can't be archived:** each project has exactly one, always shown, and writing to the project resumes it (decided 2026-10-11).
- **Archived sessions leave the sidebar.** Under each project, an **"Archived (N)"** link opens the list in the main area, as "Waiting for you" does: title, when and why it ended, tokens; **Resume** and **Unarchive** per session. Archived children of a manager are hidden from its tree too. Sessions of removed projects get the same link in their group.
- **Who archives (decided by Simon, 2026-10-12):** nothing is archived automatically. A **manager** archives its own sessions with `archive_session`, whenever it judges fit (next section). **Simon** can archive **any** ended session from the page, whoever started it: an **Archive** button in the header of an ended session, next to Resume (never on a manager). Sessions Simon started directly in a project, outside its manager, have no manager to archive them, so only Simon can.
- **Nothing is deleted.** Messages, questions, permission records, grants, usage and per-turn records stay; the usage page counts archived sessions as before (it reads the usage records, not the sidebar).
- **"Waiting for you" is not affected:** an open question from an archived session still shows there.

### For managers

- **`archive_session(session_id)`**: only sessions the manager started, and only once ended; otherwise refused with the reason. The same ownership check as its other tools (`src/sessions/management.ts:165-169`). When to archive is the manager's call. The tool's description and the manager's instructions encourage it to **archive a session once its work is done and reported**, and to stop it first if it is still running; a session whose result the manager still needs to read or act on stays visible.
- **`list_sessions`** leaves archived sessions out and ends with "3 archived sessions not listed", so a manager's list stays short.
- **`send_message`** to an ended or archived session of its own resumes it (above).
- **An idle stop doesn't wake the manager** (decision 3). Today every ending wakes it (`src/sessions/management.ts:84-88`), which would cost a manager turn for nothing: the manager already heard "finished a turn" an hour before, and a message brings the session back anyway. Instead the note "stopped after 1 h idle" goes into the manager's inbox **without waking it** and arrives with its next message; `list_sessions` shows the end reason too. Every other ending wakes it as now.

### The limit on working sessions (step 6)

- **Idle sessions don't count towards the limit** today (`src/sessions/manager.ts:121-132`), so stopping them frees memory, not places. Nothing in the limit changes.
- **Sessions waiting for a place (queued) and paused sessions are never stopped.**
- **A resume doesn't take a place:** the resumed session sits between turns; the message it gets waits in line like any other (`src/sessions/session.ts:581-584`), with Start now for Simon as today.

### Database

New entries in `MIGRATIONS` (`src/store/database.ts`); as built, entry 13 adds `idle_facts` (part A) and entry 14 `archived_at` (part C):

```sql
ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
ALTER TABLE sessions ADD COLUMN idle_facts TEXT;  -- the last Stop hook's background tasks and scheduled wake-ups
```

### API and security

New routes, all `POST`, so they get the sign-in check and the Origin check like every other change (`src/server/server.ts:152-154`):

| Route | What |
|---|---|
| `POST sessions/:id/archive` | Archive an ended session; refused for a running session or a manager. |
| `POST sessions/:id/unarchive` | Back into the sidebar, still ended. |

`POST sessions/:id/messages` and `POST questions/:id/answer` change behaviour (resume first) but not their checks. `test/server-security.test.ts` gets the new routes in its checks for a missing sign-in and a wrong Origin.

### On the phone

- The **Archived (N)** link is a small line under the project's sessions, not a button in the project header, so the header stays one line on a narrow screen.
- The **archived list** uses the full width; each row has the title and end reason on top, and Resume / Unarchive below them on a narrow screen.
- **Archive** joins the session header's buttons, which already wrap.
- Checked in the browser at phone width before it's called done.

## What gets tested

**Automated** (`npm run check`):

- The idle decision as a small function of its own: every rule above, including ambient tasks, scheduled wake-ups, an unknown `session_crons`, paused, queued, open questions, held messages, and managers.
- Resume on message: from the page, from a manager, by an answer; two at once; a failed resume leaves the message waiting.
- Archive: only ended sessions, never a manager; resume unarchives; Simon can archive a session with no manager; nothing is ever archived without someone asking.
- `archive_session` refuses another manager's session and a running one; `list_sessions` hides archived ones.
- The new routes in `test/server-security.test.ts`.
- The migration on a copy of an existing database.

**Live** (Haiku, a throwaway Ledung with `idleStopMinutes: 1`):

- A session is stopped after a minute, with the event and end reason; its manager is not woken and hears about it with its next message.
- A session running `sleep 300` in the background, one with a Monitor, and one with a `/loop` are not stopped.
- Simon's message, a manager's `send_message` and an answer each resume a stopped session, which answers; a "this session" grant still applies after the resume.
- Token use of the first turn after a resume, against one after an idle hour without a stop.
- A manager archives a finished session of its own and is refused for another's; Simon archives a session started outside the manager, uses Unarchive and Resume from the archived list.
- The page at phone width in a browser.

## Build order

| Part | What | Done when |
|---|---|---|
| A | Idle facts and idle stop: the Stop hook, every background task counted, the last-activity clock, the once-a-minute check, the quiet note to the manager. | A session stops after the set time; sessions with background work or a `/loop` don't. |
| B | Resume on message: Simon's messages, `send_message`, answers, `message_manager`; the page's message box for ended sessions; the "waiting" text on answered questions fixed. | Each kind of message resumes a stopped session and is answered. |
| C | Archive: the migration's `archived_at`, the routes, the sidebar link and list, the Archive button, `archive_session` with its guidance on when to archive, `list_sessions`. | Archived sessions leave the sidebar and come back on resume, also from the phone. |
| — | The live test above. | |

## Decisions for Simon

1. **Idle time 1 hour, set in the config** (`idleStopMinutes`, 0 = off) (recommended); or a setting in the page, like the session limit.
2. **Sessions with an open question are never stopped** (recommended, as offered): they are in the middle of a task. Since an answer now resumes a session, they could be stopped too and woken by the answer; that can come later if memory gets tight.
3. **An idle stop doesn't wake the manager** (recommended): it gets a quiet note with its next message. Or wake it as for any other ending.
4. **Every kind of message resumes an ended session**: Simon's, a manager's, an answer, and messages between managers (recommended). Or Simon's and answers only, with managers still told "has ended".
5. **Managers can't be archived** (recommended), since each project has exactly one and it is always shown.
6. ~~Automatic archive after 24 hours~~ — decided by Simon on 2026-10-12 (question #20): **no automatic archive. Managers archive their own ended sessions with `archive_session` as they see fit; Simon archives any ended session from the page**, including sessions started outside a manager. Simon: "I'd like to skip the automatic archive. The manager should be the one to archive as it wants. We can currently start sessions outside of the manager. We need a way for the user to archive these."
7. **The manager's instructions and the tool's description encourage archiving a session once its work is done and reported; `list_sessions` hides archived sessions and gives their count** (recommended).
8. **Grants after a resume are applied by Ledung's own check, not handed back to Claude Code** (recommended). It is the safer of the two (see the finding below), and the only visible difference is a line in the chat.
9. **No deletion for now** (recommended, as offered).

## Found while reading the code

- **"Resume and deliver" from step 2 was never built.** Delivery after a resume works, but only through the session header's Resume, and an answered question for an ended session says "waiting for the session to finish its turn". Part B fixes both.
- **A "this session" grant may let a sensitive command through.** The grant goes to Claude Code as a session rule (`src/sessions/session.ts:490`), and Claude Code allows what a rule covers without asking Ledung, so the sensitive check (`src/sessions/session.ts:440`) never sees it. A broad rule such as `npm run:*` would then also cover a command the config marks sensitive. Found by reading the code only, not tested; it is outside this proposal and worth an issue of its own. After a stop and resume the problem is gone for that session, because Ledung checks every request again.
- **Monitors and other "ambient" tasks are left out of the background count** (`src/sessions/session.ts:399`), so the sidebar's "N in background" misses them. Fine for the label, but the idle check must count them.

## Later

- **Deleting sessions for good**: their messages from Ledung's database, optionally their Claude Code transcript. Usage records and grant records would stay, so totals and the record of who allowed what don't change.
- Stopping sessions with an open question (decision 2), or stopping earlier when memory is short, using the step 6 measurements.

## Progress

| Part | Status (2026-10-12) |
|---|---|
| A Idle stop | Done (`src/sessions/idle.ts`, migration 13). The idle rules as one function; a Stop hook records background tasks and scheduled wake-ups (kept in the database across restarts); every background task counts, ambient ones too; the last-activity clock; a check once a minute; `idleStopMinutes` in the config (default 60, 0 = off); the manager gets a quiet note instead of being woken. |
| B Resume on message | Done. Simon's message, `send_message`, `answer_question`, `forward_answer`, `message_manager` and Simon's answers resume an ended session; one resume at a time per session; the message box stays open for an ended session that can be resumed; the answered-question text no longer says "finish its turn". Two fixes from the live test: a resume delivers what waited right after it starts (Claude Code no longer sends the empty result on resume), and it waits until the stopped session's old host has let go of its pipe (a message one second after a stop otherwise reconnected to the old host, which reported Claude Code's exit). |
| C Archive | Done (migration 14, `web/src/components/ArchivedView.tsx`). Archive / Unarchive in an ended session's header (never on a manager); "Archived (N)" under each project's sessions with Resume and Unarchive; `archive_session` for a manager's own ended sessions, with the instructions suggesting it once the work is done and reported; `list_sessions` leaves archived sessions out and counts them; resuming unarchives. |

Checked live (Haiku, throwaway Ledung on port 4391, `idleStopMinutes: 1`): a plain session was stopped after a minute ("Stopped after 1 min idle."), while sessions with a background `sleep 300`, a Monitor and a CronCreate wake-up were not; the first two were stopped only after their background work had ended (the sleep at 14:03:37, stopped 14:07; the Monitor at 14:09:01, stopped 14:11), and the one with the wake-up stayed up. The Stop hook's figures were right for all four, and survived three Ledung restarts. The manager wasn't woken by its session's idle stop; the note waited in its inbox. Simon's message, a manager's `send_message` and an answer each resumed a stopped session, which answered (about 2 s after the message, once fixed). A grant a manager gave "for this session" still applied after a stop and resume ("Allowed under a grant from manager …", no prompt). `archive_session` was refused while the session ran, then archived it, and `list_sessions` said "1 archived session not listed"; archiving a manager was refused; a message to an archived session resumed and unarchived it. The page at phone width (390 px, through Chrome's device emulation): the archived list and the header's Archive button wrap cleanly; at desktop width the "Archived (N)" link shows under the project.

Not checked: an hour-long idle (the token comparison is from gaps of minutes); container sessions; sessions on a Claude Code that doesn't report scheduled wake-ups (covered by the unit test only); two messages arriving at the same moment (covered by reading the code); the page on a real phone.

Found while testing, not changed (outside this step):

- **The page's "Allow for this session" is recorded as "once".** The page sends the scope, but the permission route doesn't pass it on (`src/server/server.ts:319-327`), so Simon's session grants are never stored; a manager's are. The grant test above therefore used a manager's grant.
- **On a phone the sidebar's session list is about 13 px tall**: the sidebar is capped at 40% of the screen (`web/src/styles.css:265`), and the limit ships now fill most of it. The project tree, and with it the "Archived (N)" link, can only be scrolled in that sliver.
- A manager that stops one of its own sessions is woken by that session's ending, which costs it a turn to say there is nothing to do.

