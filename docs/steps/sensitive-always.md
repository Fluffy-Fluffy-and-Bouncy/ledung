# Sensitive actions always reach you — proposal

Oct 12, 2026 · **Approved by Simon on 2026-10-12**, all decisions as recommended, decision 4 as he decided it (see decisions.md). Built and tested; not released. The experiments below were throwaway scripts against the Agent SDK in a temp folder (Haiku, one Sonnet run for Auto); no Ledung was touched, no code changed.

**Later change (2026-10-13, issue #51):** a sensitive request from a session that has a manager now goes to that manager, who asks you with a question Ledung writes; your answer to it decides the request, once. The check below is unchanged; only where the prompt goes changed (see decisions.md).

**Done when:** an action that matches a sensitive pattern comes to you in every permission mode (Ask, Accept edits, Auto, Plan), whatever "for this session" grants or `allow` rules exist, including for sub-agents, in local and container sessions, and the prompt says which pattern matched.

## The problem, with an example

Ledung's list of sensitive things (pushing to `main`, `kubectl`, `.env` files, and whatever a project adds) is checked **only when Claude Code asks Ledung for permission**. But Claude Code often doesn't ask. It decides some things itself, and then Ledung never sees the request.

Example: a session in **Accept edits** mode is told to "fix the deployment settings" and writes to `secret/notes.txt`, which the project marks sensitive. Claude Code's Accept edits mode says "file edits need no prompt", so it writes the file. Ledung's check never runs. The container test showed exactly this. The same happens in three other ways:

1. **Accept edits mode**: file edits are allowed by Claude Code itself (seen in the container tests, finding 3; repeated below).
2. **"Allow for this session"**: Ledung hands the grant to Claude Code as a rule. A broad rule like `npm run *` or `Write` then covers a sensitive request too, and Claude Code allows it silently (found by reading in the idle-stop proposal; now tested).
3. **Auto mode**: Claude Code's own classifier decides. In the test it allowed a write to a sensitive path and a command containing a sensitive marker without asking. This is how sessions have pushed to `main` although "push to main" is a built-in sensitive pattern.
4. **The project's own `.claude/settings.json`** can carry `allow` rules, which shadow Ledung's check in the same way (the SDK even warns about it when it starts).

So today the promise in the brief ("sensitive actions always come to Simon, whoever started the session", section 5) holds only when Claude Code happens to ask.

## What it does

Ledung adds its own check **in front of every tool call**, in a hook that Claude Code runs before the tool, in every mode. If the call matches a sensitive pattern, the hook says "ask the user". Claude Code then calls Ledung's normal permission path, which already sends sensitive requests to you, never to a manager, never covered by a grant. Nothing else changes: everything that doesn't match goes the way it goes today.

## What the experiments showed

Set-up: `query()` from the Agent SDK (Claude Code 2.1.295, SDK 0.3.295) in a temp folder; the Ledung-like `canUseTool` records every call and refuses it; a "sensitive" marker command (`echo SENSMARK hello`) and a write to `secret/notes.txt`. "Asked" means Ledung's `canUseTool` was called. "Ran" means the tool ran without Ledung seeing it. A session rule is `allowedTools: ['Bash(echo:*)', 'Write']`. One run per cell; Haiku, except the Auto row marked Sonnet. Models vary a little between runs, but the pattern was the same in every row.

| Mode | Today (no fix) | A: hook returns "ask" | B: "ask" rules in settings |
|---|---|---|---|
| Ask (default) | Write to a sensitive path: asked. With a session rule or project allow rule: **ran**. | Asked, with and without rules. | Bash: asked. Write: asked only because Ask mode asks anyway; with a `Write` session rule it **ran**. |
| Accept edits | Write: **ran** (confirms finding 3). | Asked, with and without rules. | Bash: asked. Write: **ran** (a `Write(…)` ask rule did not match). |
| Auto | Sonnet: Bash and Write both **ran**. Haiku: Write asked, Bash ran. | Asked in every case (Haiku and Sonnet). | Bash: asked. Write: with Sonnet and with a session rule **ran**. |
| Plan | Claude Code blocks writes itself; Bash `echo` ran (read-only, allowed). | Asked wherever the model made the call. | Bash: asked. |

More results:

- **Compound commands:** `cd . && echo SENSMARK hello` was asked in all three modes tried, under both A and B. A gets the whole command string, so Ledung's patterns see every part of it. B works because Claude Code splits compound commands itself.
- **Sub-agents:** a sub-agent's Bash call fires the hook too (with an `agent_id`) and the "ask" reaches Ledung's `canUseTool` with the sub-agent's id. Covered.
- **What Ledung receives after a hook's "ask":** `canUseTool` is called with `decisionReason` set to the text the hook gave, so the prompt can say why (the matched pattern). After you allow it, the tool runs.
- **A's weakness: none found.** It asked in every combination of mode, rule and tool where the model made the call (one Plan-mode run made none), plus the project-rule and compound runs.
- **B's weaknesses:** (1) Claude Code's ask rules are prefix/glob rules (`Bash(git push:*)`), not regular expressions, so Ledung's patterns (`aws` unless read-only, `\bmain\b` after `git push`) can't be expressed; every pattern would need to be rewritten as rules. (2) For files, `Write(…)` ask rules never matched in four spellings; only `Edit(**/secret/**)` fired. (3) Rules from Ledung's config and rules from the project's settings have to be kept in step. B is rejected.
- **The SDK says the same:** it warns "Bare allowedTools entries auto-approve the whole tool before the callback is consulted. To gate every tool call, use a PreToolUse hook."

**Not tested:** `plan` mode on a Write (Claude Code blocks it before any rule applies, so it is no gap), Claude Code 2.1.283 in a container (the `ask` answer of a hook; the hook channel itself is the same one the Stop and pause hooks already use there, container tests item 6), `bypassPermissions` and `dontAsk` (Ledung never offers them), hook "ask" when a `deny` rule also exists.

## How it works

### The hook

`PreToolUse` already exists in the session (`src/sessions/session.ts:285`) and only waits while the session is paused. It becomes one function that first waits for a pause to end, then calls a new pure function:

```
sensitiveHookOutput(toolName, input, rules) → {} | { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '<which pattern, in words>' } }
```

It uses `matchSensitive` unchanged, so the hook and the permission prompt can never disagree. If the check itself fails (it shouldn't: patterns are validated when the config loads), the hook **asks** rather than lets the call through.

Ledung's own tools (`ask_user`, the manager tools) are excluded as they are in `canUseTool` today (`LEDUNG_TOOLS`).

### Why "ask" and not "deny"

"Ask" makes Claude Code show the request to the user the usual way, and Ledung's `onPermission` does the rest: sensitive → you, grants not consulted, "this session" not offered, a manager never decides it. "Deny" would stop the session with no chance for you to say yes.

### Who asks first in Auto mode

The hook runs first, so the project's sensitive list comes before the classifier. For a match, the classifier is not asked; you are. For everything else the classifier works as before. It stays as the second net: it still catches things no pattern lists. The two don't collide: a request is either a Ledung match (you decide) or not (Claude Code decides, or asks, as before). The reverse also holds, and is outside Ledung: if a project's list does not contain a pattern (for example Ledung's own project has dropped "push to main"), the Auto classifier may still stop such an action by its own judgement. Ledung neither causes nor can switch that off.

### What you see

The prompt already carries a "sensitive" mark with the rule. Two small changes: the text names the rule in plain words ("pushes to main or master, or force-pushes") instead of only the regular expression, and it appears the same whether Claude Code or the hook raised the request. Each suggested pattern keeps a short plain-words name (see the next section), and the prompt shows the name of whichever list entry matched; an entry the user typed has no name and is shown as its pattern.

### Container sessions

Hooks use the same channel as `canUseTool`: Claude Code in the container sends the request over its standard input and output to Ledung on the PC. The Stop and pause hooks already run this way in containers (container tests, items 2 and 6; 2.1.283 and 2.1.296 both worked). What isn't known is the "ask" answer on 2.1.283. It is the first live test of the build, and if it fails the page shows a warning on such sessions (the Claude Code version is already shown), not a silent gap.

### Matching: compound commands, paths, MCP tools

- **Commands:** the pattern runs over the whole command string, so `cd x && git push origin main`, `bash -c "git push origin main"` and `VAR=1 git push origin master` all match (checked). Gaps that exist today and are not made worse: `git -C repo push origin main` (no match), a plain `git push` on a branch that tracks `main`, and `cat .env` in Bash (path patterns only apply to file tools). Decision 7.
- **Paths:** `Write`, `Edit`, `Read`, `NotebookEdit`, `Grep` are matched by their path argument. `Glob` is not (only its `pattern`).
- **MCP tools:** by name or server prefix, unchanged.

## No built-in list: starting suggestions instead (Simon's decision, 2026-10-12)

**Today** (`src/sessions/sensitive.ts`) the built-in patterns (`BUILT_IN`) are in the code and are added to every project's patterns on every check (`matchSensitive`). A project can add entries (`sensitive` in its settings; the config can add global ones) but can never remove a built-in one, and the page doesn't show them. With the fix, that would mean every session pushing to `main` asks you, also in projects where you want that, with no way to say so.

**Simon's decision**, after discussing this plan with the manager: "Should we really have a built in one? What if I create a project and I want it to allow those things?" and, choosing option 2 (starting suggestions): "Yeah, I think option 2 is better."

**So:** there is no hidden list. What a project's sensitive list shows in the page is exactly what it enforces.

- **One list of suggestions in the code**, used for one thing only: to prefill a project's list. It holds the usual patterns (deploys and infrastructure, cloud CLIs, publishing, push to `main`/`master` or force-push, secret files). `matchSensitive` no longer reads it; it checks only the global (config-level) patterns plus the project's own list. Global patterns work as today.
- **New projects** (created or added, in the page or through a manager's `create_project`) start with the suggestions as ordinary entries in their list. They can be edited and deleted like entries the user adds. A suggested entry is recognised by its pattern (an exact match with the suggestion), which gives it its plain-words name; an entry the user edits becomes an ordinary one and is shown as its pattern. So a prompt can still say "pushes to main or master, or force-pushes" and not only show a regular expression.
- **Existing projects** get the suggestions **once**: a one-time step at start, recorded with a key in the same place as `projects-imported` (`src/projects/store.ts`), so it runs once and a pattern a user deletes afterwards never comes back. Projects are kept in Ledung's database (a JSON `data` column), so this is a code step over the stored projects, not a plain SQL migration. Entries the project already has are kept and not duplicated.
- **Ledung's own project drops "push to main".** Not coded by project name (the repository stays generic). Either you delete that one entry in the project's settings after the import (a click in the page, recorded as your choice), or the import is run with a stated one-time choice. Recommended: delete it yourself in the page, once, after release. Until then Ledung's project is asked about pushes to `main`, which is the safe side.
- **The page** (`web/src/projects/ProjectViews.tsx`): today the lists are two plain text areas under "More: sensitive patterns and tickets", one pattern per line, with MCP tools kept out of view. They become a list of entries, each with its plain-words name, the pattern, and a delete button; an add field for your own pattern; and an **"Add suggested"** button that brings back any suggested entry the project no longer has (without touching the rest). A new project's form shows the prefilled list before it is created. On a narrow screen the entries stack, one per row.
- **An empty list is allowed** (that is the point of the decision), but the page says so in one line: "Nothing is sensitive here; every action is decided by the permission mode and the manager."

Alternatives Simon did not choose: a fixed built-in list that a project can switch off by name (`skipBuiltIn`), sessions that work on branches with one approved push, and accepting the prompts. The branch habit remains possible on top.

## What gets tested

Unit tests (`test/sensitive.test.ts`):

- `sensitiveHookOutput` returns "ask" with the entry's name for each suggested pattern (once in a project's list) and for the user's own; `{}` for ordinary calls and for a project with an empty list; "ask" if the check throws.
- Compound commands (`cd x && git push origin main`, `bash -c "…"`, a leading `VAR=1`), force flags, `HEAD:main`; paths with both slash forms; MCP prefix; a pattern deleted from the project's list no longer matches, and the suggestions in the code are never consulted by the check.
- The suggestions: each has a unique plain-words name and a valid pattern; a new project gets them all; adding them to an existing project is done once and does not duplicate or revive a deleted entry; "Add suggested" restores only the missing ones.
- A test that the session's hook list contains the sensitive check and the pause (they run in that order; neither replaces the other).

Live tests (throwaway Ledung on port 4397, Haiku; Sonnet for Auto), repeating the matrix above through Ledung's real flow, to be reported in the same table:

| What | Expected |
|---|---|
| Each of Ask, Accept edits, Auto, Plan × a sensitive command and a sensitive path | Prompt to you, marked sensitive, with the rule's name; denying it stops the call; allowing it runs it once; the next identical call asks again. |
| The same with a "for this session" rule that covers the request (Bash and Write) | Still asks. |
| The same with an `allow` rule in the project's `.claude/settings.json` | Still asks. |
| A manager's session; a manager's grant that covers the request | Comes to you, not the manager; the grant is not used. |
| A sub-agent doing the call | Asks. |
| An ordinary call in each mode | Unchanged, no extra prompt. |
| Pause during a sensitive call | Waits for resume, then asks. |
| A container session on Claude Code 2.1.283 and 2.1.296 (throwaway container) | As above; or a visible warning if 2.1.283 can't. |
| A project whose list has "push to main" deleted (in the page, then a session) | A push to `main` is not asked about by Ledung; `kubectl` still is. In Auto mode Claude Code's own classifier may still stop the push. |
| The page at phone width: delete an entry, add one, "Add suggested" | Works; entries readable and tappable. |
| An existing project before and after the one-time import (copy of a database) | Gains the suggestions once; a second start changes nothing. |

## Decisions for Simon

1. **How:** Ledung's own check in a `PreToolUse` hook, answering "ask" (A), as tested. Not "ask" rules in Claude Code's settings (B): they can't express Ledung's patterns, and file rules didn't fire (recommended).
2. **Auto mode:** the hook comes first and the classifier stays as a second net for everything the patterns don't list (recommended).
3. **A failing check asks** rather than lets the call through (recommended). The alternative, "pass through", matches the brief's lesson for helpers but would hide a gap here.
4. **No built-in list; starting suggestions instead: decided by Simon, 2026-10-12** (quotes above). Open within it: Ledung's own project drops "push to main" by you deleting the entry in the page after release (recommended), not by a name in the code.
5. **Plain-words names** kept with the suggested entries, shown in the prompt and in the page (recommended).
6. **Containers:** if the test shows 2.1.283 ignores the hook's "ask", show a warning on such sessions and keep them out of Accept edits and Auto, rather than ignore it (recommended). If it works, nothing more is needed.
7. **Widen the patterns now?** Only the small fix for `git -C … push …` and `git -c … push …`. The other gaps (a plain `git push` on a tracking branch, `cat .env`, `Glob`) need a decision of their own, because they raise false alarms (`git add .env.example`). Recommended: fix `git -C/-c` now, in the suggestions, and list the rest as a later offer. Existing projects get the corrected pattern only if they still have the old suggested entry unchanged; edited entries are left alone.

## Build order

1. `sensitiveHookOutput` and the list of suggestions with plain-words names (the built-in set becomes the suggestions; `matchSensitive` stops reading it), with the unit tests above. Names are looked up from the pattern, so nothing is stored beyond the pattern strings.
2. The hook in `session.ts`, merged with the pause wait, failing to "ask"; the prompt shows the rule's name.
3. Prefill for new projects, the one-time import for existing ones, and the page: entry list with delete, add, "Add suggested", the empty-list line, narrow-screen layout. Steps 1 and 3 are released together: after step 1 alone, existing projects would lose their patterns.
4. The `git -C/-c` fix (decision 7).
5. Live tests in the order of the table on a throwaway Ledung; then the container test (needs the older Claude Code in a throwaway container).
6. After the release: you delete "push to main" in Ledung's own project in the page. Update `docs/decisions.md` (including the decision of 2026-10-12 above), mark finding 3 of the container tests and the grant note in the idle-stop proposal as closed, and release only after your go-ahead.

## Notes

- This also closes the "session grant may let a sensitive command through" finding (idle-stop proposal): the grant is still given to Claude Code, but the hook now sits in front of it.
- Not part of this: a manager's own grants, Claude Code's built-in safety checks (brief section 5: not touched), and the unrelated finding that the page's "Allow for this session" is recorded as "once".

## Progress

| Part | Status (2026-10-12) |
|---|---|
| 1 The check and the suggestions | Done (`src/sessions/sensitive.ts`, `src/shared/sensitive-suggestions.ts`, `sensitiveHookOutput`; the git -C/-c fix is in the suggestion). Unit tests in `test/sensitive.test.ts`. |
| 2 The hook | Done (`src/sessions/session.ts`, merged with the pause wait; Ledung's own tools excluded; a failing check asks). |
| 3 Prefill, import, page | Done. New projects start with the suggestions; existing ones get them once at the first start (`addSuggestionsOnce`, tested); the page shows the list with Delete, add (checked) and "Add suggested". |
| Live and container tests | Below. |
| Decisions file, approval marker | Not yet written (see the manager). |
| Release | Not done. |

Live tests (throwaway Ledung on port 4397, sessions through its API, Haiku; Sonnet for Auto). Every prompt was denied unless noted; "asked" = reached the page as a sensitive request addressed to the user:

| What | Result |
|---|---|
| Sensitive command (`echo kubectl hello`) in Ask, Accept edits, Auto (Sonnet), Plan | Asked, named "Kubernetes or Helm commands". |
| Sensitive file write (`.env`) in Ask, Accept edits, Auto (Sonnet) | Asked, named ".env files"; no file written. |
| The same in Plan mode | Command asked. The `.env` write was never attempted: Claude Code wrote only its plan file. |
| Project `.claude/settings.json` allowing `Bash(echo:*)` and `Write`, in Ask and Accept edits | Still asked (command and file). |
| A sub-agent running the command | Asked. |
| Two sensitive commands in one session, each allowed once | Asked twice. |
| Ordinary `echo hello` in Accept edits and Auto | No prompt, ran. |
| Project with the kubectl entry deleted, Accept edits | No prompt, ran. |
| New project's list | 10 suggested entries. |

Container test (throwaway container `ledung-test-sens`, node:24-slim, Claude Code 2.1.283, user `tester`, 2 GB / 2 CPUs, own network; a token account added by Simon in the throwaway page): in Accept edits a sensitive command and a `.env` write each asked with the right name, an ordinary command did not, and nothing was written. **2.1.283 honours the hook's "ask"**, so decision 6 needs no warning. The container, network, image, throwaway Ledung and its data (with the token) were removed.

Not tested: the page at phone width; a manager's session with a manager grant (the check and routing are the same code, covered by reading and unit tests); pause during a sensitive call; the one-time import on a copy of a real database (unit-tested only); "Allow for this session" given in the page (it is recorded as "once", an existing finding), so session rules were represented by project allow rules; Auto mode with Haiku; `bypassPermissions` and `dontAsk` (never offered).
