# Step 1a: Agent SDK or the raw process — spike result

Oct 9, 2026. Closes issue #1.

**Decision: the Agent SDK** (`@anthropic-ai/claude-agent-sdk`), with Ledung's own spawn function for the Docker runner. The raw stream-json process also works, but needs Ledung to reimplement what the SDK already does: the initialize handshake, permission control requests, hook callbacks, interrupt and resume. The runner interface stays "a process with stdin and stdout", so switching later stays possible.

## Set-up

- Windows 11, Node 24.20.0, Claude Code 2.1.295 locally; SDK 0.3.295, which runs its own bundled `claude.exe` of the same version.
- Container: Docker Desktop 29.8.2, a dev container with user `vscode` and Claude Code 2.1.283 (installed through nvm). Tests ran in `/tmp/ledung-spike`.
- Model: Haiku, to keep the spike cheap.

## Results

| Check | Local (SDK) | Container (SDK) | Container (raw) |
|---|---|---|---|
| Start in a folder whose path has a space | ✅ | n/a | n/a |
| Start through `docker exec -i` | n/a | ✅ via `spawnClaudeCodeProcess` | ✅ |
| Messages, replies, end of turn | ✅ | ✅ | ✅ |
| Permission prompt allowed (Write) | ✅ full file content in the request | ✅ | ✅ |
| Permission prompt denied (Bash) | ✅ denial message reaches the session | ✅ | ✅ |
| Multiple-choice question (`AskUserQuestion`) | ✅ arrives through `canUseTool`; answer returned in `updatedInput.answers` | ❌ tool not offered by Claude Code 2.1.283 | not tested |
| Current time without changing the user's message | ✅ `UserPromptSubmit` hook with `additionalContext` | ✅ | not tested |
| Interrupt a running turn | ✅ turn ends with `error_during_execution` | ✅ | not tested |
| `/compact` and `compact_boundary` | ✅ | ✅ | not tested |
| Resume from the session id | ✅ | ✅ | not tested |
| Stop with nothing left running | ❌ see below | ✅ | not tested |

## Findings that change the build

1. **Set `permissionMode: 'default'` explicitly.** Without it, a session may start in auto mode, where a classifier approves calls instead of the page.
2. **Stopping a local session on Windows (issue #7).** After `close()`, `claude.exe` exits after a few seconds, but commands it started in the background keep running as orphans until they finish. Once `claude.exe` has exited, `taskkill /T` can no longer find them. Ledung's stop routine must record the session's whole process tree first, close gracefully, then end whatever is left of the recorded tree, checking each process's start time so a reused process id is never killed.
3. **Stopping a container session works** when Claude runs in its own process group: `setsid -w sh -c 'echo $$ > <pid file>; exec claude "$@"'`. After `close()`, no processes tagged with the session were left. Plain `setsid` without `-w` fails: it forks, the original exits, and `docker exec` ends the session at once.
4. **The container's working folder must exist before `docker exec -w`**, or the start fails with exit code 127 and no useful message.
5. **Claude Code inside a container may be older than the host's.** The container's 2.1.283 had no `AskUserQuestion`, and its `haiku` alias pointed to an older model. Ledung should show each session's Claude Code version (it is in the `init` message) and warn when it is older than the host's.
6. **The SDK passes only one extra environment variable** to a custom spawn (`CLAUDE_CODE_SDK_READS_SESSION_STATE`). The Docker runner forwards the variables the SDK adds or changes; nothing Windows-specific leaks into the container's command line.
7. **On resume, an empty `result` arrives before the first prompt** (zero turns). Ledung must not treat it as the end of a real turn.
8. **Each turn starts with a repeated `system/init`.** Ledung records the session's details from the first one and ignores repeats unless something changed.
9. **Background commands are a normal pattern.** Claude ran `sleep 40` in the background unprompted and reported `task_started` and `background_tasks_changed`. The page should show running background tasks per session.

## Not tested yet

- Containers reaching Ledung's MCP server (issue #6): checked in 1e, when there is a server to reach.
- Abruptly killing the `docker exec` client without a graceful close: checked in 1e.
