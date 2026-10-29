# Ledung — project brief

Oct 9, 2026 · @Simon

A self-contained brief for a fresh Claude session starting this project on Windows. You do not need the conversation it came from.

## 1. The goal

Simon runs several Claude Code sessions at once on a project: builds, reviews, investigations. A "ledung manager" session coordinates them. Today all of it lives inside VS Code chats, held together by a process wrapper, a request queue and a sidebar extension. Questions to Simon get buried in chats, permission prompts need him to open each chat, and there is no single view of what everything is doing.

Ledung is a local program that runs those sessions itself and shows everything in one place: the sessions and who started them, every question waiting for Simon (answered from one list), permissions, token usage and machine load. It replaces the VS Code setup; it is not an editor.

## 2. Decisions so far (Simon)

- A new core, not a patch of the old VS Code-based ledung. Lessons from the old one carry over (section 6). (2026-10-07)
- Runs on Windows first, also on macOS, and Linux-friendly so it could later run in a shared container for work. (2026-10-09)
- Projects can live anywhere: plain Windows or Mac folders, dev containers, or WSL. (2026-10-09)
- TypeScript on Node for the core and the page (recommended; confirm with Simon before scaffolding).
- A web page first, served by the core on localhost, installed as an app window from Edge or Chrome. A desktop shell (Electron or Tauri) can come later without a rewrite.
- Local only for now. Phone access and manager-to-manager across computers come later.
- Its own private GitHub repository. Keep it generic: anything specific to a work project (people, ticket systems, compliance rules) lives in a local config file that is not committed.
- Permissions: sessions trust their manager for ordinary permission prompts. Production, personal data and similar sensitive actions always go to Simon. See section 5.
- Design before building. Discuss and propose, then wait. Build nothing without Simon's explicit go-ahead, and a go-ahead covers only the step it names.

## 3. What Simon wants (all 21 points)

### Sessions and managers

1. A hierarchy of sessions (sessions, agents, whatever they turn out to be). The ledung records who started whom.
2. A ledung manager that controls the sessions under it.
3. More than one ledung manager, able to talk to each other, for example one per project.
4. Sessions started by a manager report to that manager.
5. Simon can see and interact with every session, even though the manager normally handles them.

### Questions

6. Every question to Simon is stored and shown in one list, marked answered or not, so nothing gets lost.
7. He answers from that list, and the answer goes straight to the session that asked, with no fetching.

### The chat view

8. Hide technical messages per session (tool calls such as Bash, inter-session messages).
9. Timestamps on every message, in and out, and sessions know the time.
10. History stays visible after a session forgets it: if a chat is cleared or compacted, its messages stay on screen.
11. Reply to an old message: a "quote" button that sends that message again with his reply, so a session can be pointed back at something it no longer has.
12. Copy-safe blocks: text meant to be copied (email drafts, commands) copies as plain text.

### Permissions

13. Sessions trust their manager for permissions. What a manager is allowed, its children are allowed. A manager's yes stands.
14. The boundary stays: production, personal data and similar come to Simon. Cases that today need him to type a go-ahead inside a chat should work from the question list.

### Usage and models

15. Token usage recorded for every session and agent, rolled up across the hierarchy.
16. Several models and accounts: distribute work across more than one Claude account, other providers' models, local models.

### Performance

17. Manage memory and CPU across the ledung, and the managers know about it. Sessions can be paused so the machine isn't overloaded.
18. Sessions and managers can ask for, take and give back capacity.
19. Priority: a critical bug's session goes ahead of others.

### Later

20. Phone access to the manager and the questions.
21. Managers on different computers talking to each other.

## 4. The design

The core is one local program. It:

- runs the sessions. It starts each Claude Code session itself and holds its input and output (section 7 has the protocol). No VS Code in the loop.
- keeps records in one local database (Node's built-in SQLite, or a file-based alternative): sessions and their parents, every message (so history survives clears, want 10), questions and answers, permission requests and who decided them, token usage, resource requests.
- serves the console page: the session tree, the question list with answer boxes, each session's live chat, usage, machine load.
- gives sessions tools through a local MCP server: ask_simon for every session; for managers also start_session, send_message, list_sessions, decide_permission; and resource tools (request_capacity and similar) for heavy work.

Runners decide how a session is started for a project. Everything else in the core is the same whichever runner a session uses.

- Local: start claude in the project folder (Windows, macOS, Linux).
- Docker / dev container: start claude inside the project's running container with docker exec -i (Docker Desktop on Windows and macOS).
- WSL: start it through wsl.exe (Windows only).

Each project is configured locally: its folder, its runner, its container name, its own rules.

Questions are records, created by a session calling ask_simon (text, options, whether it "needs Simon's own words"). The session then ends its turn. Simon's answer is delivered to that session as a normal user message. Questions are never parsed from chat text.

Machine resources extend the idea of a suite lock (section 6) to the whole ledung. Heavy commands ask the core for capacity first. Sessions wait at their next stopping point when the machine is busy; never freeze a process mid-command, because that leaves database connections and locks held. Critical work goes to the front of the queue. Managers see the load and can hand capacity on. On Windows and macOS, containers run inside a virtual machine (WSL or Docker Desktop's), so read that machine's limits too.

## 5. Permissions

With the core running the sessions, permission prompts come to the core instead of a VS Code window (section 7). The core routes them:

- Ordinary prompts go to the session's manager, which decides with decide_permission. A yes covers that request and repeats of it in that session; a manager may also grant a named action for the whole session. Every grant is recorded and visible to Simon. (Scope recommended, to be confirmed with Simon.)
- Production, personal data, deploys, cloud-account changes, and anything a project's config marks sensitive go to Simon's question list. A manager can never approve these, and a manager's grants never pass them to its children.
- "Needs Simon's own words": some guards accept a go-ahead only if Simon typed it in that session. The core delivers Simon's typed answer into that session verbatim, as his message. Only text Simon typed may take this path, never text from a manager or any session. Whether this satisfies those guards must be tested early with a real case (step 2).
- Claude Code's own automatic safety checks are not permission prompts, and the core cannot and must not override them.

## 6. Lessons to carry over

From the old ledung. Each exists because something broke.

- Serialize heavy runs. One full test suite at a time across all sessions, a small counted pool for short targeted runs, and a worker cap. Several suites at once overloaded the machine and produced failures that sessions confidently misdiagnosed. The lock must show who holds it and for how long, time out instead of blocking forever, and turn a timeout into an explicit "nothing was run, not a pass". It must live where every process on the machine sees the same lock.
- Never edit a running script in place. Write a new file and move it over, or a running instance can execute garbage.
- Waiting versus finished can only be read from the transcript, not from a process status.
- Injected input is a closed list. Anything that types into a session on its own (compaction, continue messages) can send only fixed texts, never arbitrary text, so it can never forge the user's approval.
- A broken helper degrades to a plain pass-through, never to a dead session.
- Manager rules: it may decide on Simon's behalf within a standing grant, and must label each decision either "Simon's words: …" (with the question he answered) or "decided by the manager under the standing grant". It never approves anything that can reach production or customers. A relay carries what Simon actually said and the question he was answering.
- Compaction at phase boundaries must be triggered mechanically (a hook or the core), not by instructing the session. Sessions told to compact themselves didn't do it reliably; the mechanical trigger fired every time.
- Save a hand-off note before compacting a long session, so the summary keeps open questions, running jobs and the next step.

## 7. Known facts about driving Claude Code

Verified on the old ledung (Claude Code 2.1.x, October 2026). Re-check against the installed version.

- VS Code's extension starts: `claude --input-format stream-json --output-format stream-json --permission-prompt-tool stdio` (plus `--resume <session-id>` to reopen a chat). Messages are one JSON object per line on stdin and stdout.
- The client first sends a `control_request` with `request.subtype: "initialize"`; Claude answers with a `control_response` carrying the same `request_id`.
- A user message is `{"type":"user","message":{"role":"user","content":"..."}}` (content can also be a list of text blocks).
- Output includes `system` / `init` (with `session_id`), `assistant` messages, `result` at the end of each turn, `system` / `compact_boundary` after a compaction, and `control_response` replies. With `--permission-prompt-tool stdio`, permission requests arrive as control requests the client must answer.
- `/compact <note>` typed as a user message compacts the session; wait for `compact_boundary` plus a `result` before sending more.
- `--settings` accepts a JSON string as well as a file path; a model set there applies to that session.
- Transcripts live at `~/.claude/projects/<encoded-folder>/<session-id>.jsonl` (on Windows under `%USERPROFILE%\.claude`). Token usage is in each assistant message's `usage`.
- Anthropic's Agent SDK (TypeScript) wraps the same process and may be simpler. Compare the two in step 1.
- Slash commands, skills, hooks and CLAUDE.md files come from the project and the user's settings, not from VS Code, so /build-style commands work in sessions the core starts.

## 8. Cross-platform rules

- Build paths with path utilities, never `\`, `/` or drive letters by hand. Keep user data in the platform's usual place (`%APPDATA%`, `~/Library/Application Support`, XDG on Linux) behind one helper.
- Keep everything about starting and stopping processes (binary names such as `claude.cmd` versus `claude`, argument quoting, stopping a process tree) inside the runners.
- Put CPU and memory measurement behind one module with a version per platform.
- Add .gitattributes with LF line endings. Never rely on file names that differ only by case.
- Run the tests on Windows and macOS in GitHub Actions on every push.
- No hard-coded machine paths or project details in code: they belong in config.

## 9. Steps

Each step ends with something usable. The old VS Code ledung keeps running until step 7. Get Simon's go-ahead before each step.

| Step | What | Done when |
|---|---|---|
| 0 | Repository. A Windows folder, the private GitHub repository, a README with the cross-platform rules, .gitattributes, an ignored local config file, and this brief in docs/. | Simon approves the setup. |
| 1 | One session without VS Code. The core starts a session through a runner (local first, then Docker); the page shows it live with timestamps and hideable tool calls; Simon types into it; its permission prompts appear in the page with Allow and Deny; the core keeps its own copy of every message; copy-safe blocks render. | A full multi-step build command runs end to end in a dev-container project from the page, with VS Code closed. |
| 2 | Questions. ask_simon, the store, the list with answered and unanswered, answers delivered straight to the asking session, the quote button, and the "needs Simon's own words" path tested with a real case. | A question asked mid-build is answered from the list and the build carries on. |
| 3 | Managers and the hierarchy. Managers are sessions with the manager tools; the core records parents; several managers can run and message each other; Simon can open any session. | A manager starts and steers two builds without Simon opening either. |
| 4 | Permissions as in section 5. | A build gets through its ordinary prompts with only its manager answering. |
| 5 | Usage and views. Tokens for every session and agent, rolled up the tree; the tree shows each session's task, PR and ticket status. | Simon can see where every session and its tokens stand without opening any chat. |
| 6 | Machine resources as in section 4. | Four builds run without overloading the machine, and a critical one goes first. |
| 7 | Switch over. A week of normal work on Ledung, then retire the old VS Code setup. | A week passes with VS Code closed for ledung work. |
| 8 | Other models. Other providers or local models take bounded jobs (reviews, summaries, searches) that a Claude session hands them. They don't run full Claude Code commands. Check each provider's and account's terms first, especially before spreading work across several Claude accounts. | One bounded job type runs on a second model. |

Later: phone access (20), managers on different computers (21).

## 10. Open questions to raise with Simon (do not decide alone)

- TypeScript on Node: confirm.
- The Agent SDK or the raw stream-json process: decide in step 1 after trying both.
- Do running sessions survive a core restart, or end and resume from their transcripts?
- How ticket and PR status are read (project config: which tools, which credentials).
- Permission scope (section 5): confirm "this request" plus optional named session grants.
- Desktop shell later: Electron (Node, larger) or Tauri (smaller, Rust).

## 11. How to start

1. Read this brief. Ask Simon anything unclear.
2. Propose step 0 (the folder location and the repository setup) and wait for his go-ahead.
3. Then propose step 1 in detail, including the SDK-versus-process comparison, and wait again.
