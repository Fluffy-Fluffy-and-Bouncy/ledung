# A project signature, with a living PR summary — proposal

Nov 26, 2026 · Proposal for issue #513 (run-179). Not approved yet; nothing is built.

**Done when:** the seven "Done looks like" points of #513 hold: a signature per project with a switch per place; `gh` issue/PR create, comment and review get it from every body source on Windows and Mac; every other `gh` call is unchanged; another server's write tool gets it after one question per tool and project; a run's PR carries a summary that follows the run; a "Sent" view lists what went out; and never a second signature, one on a read-only call, a private detail in one, or a broken `gh`.

## Why

Sessions write issues, comments, PRs and commits on GitHub and other trackers in the person's name. People reading them can't tell that the work came through Ledung, or which run it belongs to. Simon talked it through on 2026-11-26 and liked the direction: one short, factual line per project that the project can change or turn off, and a hidden marker that lets Ledung find its own posts again (no double signatures, a PR summary that follows the run, a list of what went out).

The signature is a **courtesy line, not proof**. A session can always reach the real `gh` or the site; nothing here is a security boundary, so it never blocks work.

## The two checks (done 2026-11-26)

1. **Can a hook change another MCP server's tool call? Yes.** A throwaway stdio MCP server (`tracker`, tool `create_comment`) ran under the Agent SDK 0.3.295 / Claude Code 2.1.319 with Haiku. A `PreToolUse` hook returning only `hookSpecificOutput.updatedInput` (no `permissionDecision`) changed the body. The server received `"hello\n\n— via Ledung"`. Importantly, **the permission check still ran**: `canUseTool` was called with the signed input, so the person approves the text that will actually go out. With the tool in `allowedTools`, it went through signed without a prompt, as before. The hook input also names the server (`mcp_server: {name, source}`).
2. **Does a stand-in `gh` work on Windows? Yes, as a shell script and a `.ps1`, not as a `.cmd`.** A folder with the stand-in put ahead of the real `gh` on `PATH`:
   - **Git Bash** (Claude Code's Bash tool on Windows; also macOS, Linux): an extensionless `gh` shell script (`exec node gh.mjs "$@"`) is found first. Arguments arrive exactly (`50% & <done> "q" !x ^y $HOME`), stdin passes through (`--body-file -`), and the real `gh`'s output and exit codes (0, 1) come back unchanged.
   - **PowerShell 5.1**: a `gh.ps1` is picked before the real `gh.exe`. It passes stdin only when written to forward `$input`; the first version hung on a pipe. Embedded `"` are lost, but that is PowerShell 5.1's own native-argument behaviour and happens with the real `gh.exe` too. **Risk:** Windows' default execution policy (`Restricted`) refuses a `.ps1`, which would turn `gh` into an error (point 7). See open choice 3.
   - **cmd**: a `gh.cmd` mangles arguments (`%*` split `"50% & <done>"` into pieces), so there is none. cmd skips the extensionless script and finds the real `gh.exe`: unsigned, but intact.

## What it does

### The signature, per project

In the project's settings, a **Signature** section:

- **Text**, prefilled with Ledung's default `— via Ledung for {user}`. Fill-ins: `{user}` (Ledung's user name), `{project}` (the project's name), `{run}` (`run-179`), `{workflow}` (the flow's name), `{steps}` (the run's steps so far, by block title, with ✓ or "skipped"). Outside a run, the run fill-ins are empty and a line left empty by them is dropped.
- **Switches** for where it goes: new issues · issue comments · PR descriptions · PR comments and reviews · commits · other trackers. All on by default except commits (open choice 4). With all off, nothing is added anywhere, not even the marker (point 1).
- Saved in the project's settings like the other project settings. Changing it affects new posts only.

Only these fill-ins exist. Session titles, folder paths, account names and anything else private can't be put in a signature, because there is no fill-in for them (point 7). The text is checked against the project's sensitive patterns on save, as board posts are.

### The marker

Every signed body ends with the signature, then a hidden marker where the site renders Markdown: `<!-- ledung run-179 -->`, or `<!-- ledung -->` outside a run. Before signing, the body is searched for `<!-- ledung`. If it is there, nothing is added. That covers a repeated post, a body copied from an earlier one, and a session that signed by hand. Edits (`gh issue edit`, `gh pr edit`, `gh api … PATCH`) are never signed (point 7). For trackers without hidden HTML (Jira's wiki text, and Linear if it shows the comment literally), there is no marker. There the signature text itself is the check: a body that already ends with it is left alone.

### GitHub: the stand-in `gh`

Ledung writes a small stand-in into its data folder (`<data>/gh-stand-in/`, via `src/platform/paths.ts`). It is a `gh` shell script and, if chosen, a `gh.ps1`, both calling one `gh.mjs` run by Ledung's own Node. Ledung puts that folder first on the session's `PATH` in `sessionEnv`. A per-session file next to it holds the real `gh`'s full path (found when the session starts), the signature already filled in, the switches, and the run. No `LEDUNG_*` variable is used, so the rule "sessions don't inherit LEDUNG_* settings" stays as it is.

`gh.mjs` reads its arguments, not a command line:

- It signs only `issue create`, `issue comment`, `pr create`, `pr comment` and `pr review` (with `--comment`, `--approve` or `--request-changes` and a body), and only when that place's switch is on.
- It takes the body from `--body`/`-b`, `--body-file`/`-F` (a file, or `-` for stdin), and writes the signed body to a temporary file passed as `--body-file`. Stdin is read only when the call itself reads it.
- A call with no body of its own (`--fill`, `--web`, `--editor`, interactive) is passed through unchanged. The PR summary fills that gap for PRs.
- Every other call `exec`s the real `gh` with the same arguments, stdin, stdout and exit code (point 3).
- **Any failure in the stand-in** (missing or unreadable session file, a bug, an argument it can't parse) runs the real `gh` with the original arguments, untouched (point 7). Only the real `gh`'s own failures are reported as failures.
- After a signed call, it appends one line to the session's journal: kind, repo, the URL that `gh` printed, the time. That journal feeds the Sent view.

Container sessions run `gh` inside the container, which Ledung doesn't write to today. See open choice 2.

### Other trackers: one question per tool, then a hook

Ledung's existing `PreToolUse` hook gets one more step for `mcp__*` tools of servers that aren't Ledung's own:

- **Which tools count as writes:** those not marked `readOnly` in the server's own tool list (`mcpServerStatus()`, which gives name, description and annotations, but no input schema), whose name or description says create, add, post, comment, reply or update, and whose call has at least one string field.
- **The first call** of such a tool in a project goes through **unsigned**. The project's settings get a waiting item, with a small badge on the project: "Linear: create_comment. Which field gets the signature?", offering the call's string fields (`body`, `title`, …) and "None". The answer is kept per project and tool. Every later call has the signature added to that field as the call passes (the check-1 mechanism), and the server's own sign-in is untouched (point 4). See open choice 1 for asking during the call instead.
- **Fitting into the hook chain:** the signed input is worked out first. Every `allow` the chain returns afterwards (grants, rules, away mode) carries it as `updatedInput`, and an "ask" carries it too, so the person approves the signed text. A refusal stays a refusal. Never adding a signature to a call that Ledung or the person would refuse keeps point 7.
- A `PostToolUse` step writes the same journal line, with any URL found in the result.

### Commits

When the commits switch is on, Ledung passes Claude Code's own `attribution.commit` setting through the SDK's `settings` option. It keeps whatever the person's settings already say (or Claude Code's default co-author line) and adds `Ledung-Run: run-179` for a session that is in a run. Outside a run, nothing is added to commits. No git hooks are installed in anyone's repository. Claude Code's `attribution.pr` line is left as it is. It is Claude's line, not Ledung's, and the marker check doesn't treat it as a signature.

### The living PR summary

For a run whose branch has a PR (Ledung already finds it through `pr-poll.ts`), Ledung keeps one section at the end of the PR description, between `<!-- ledung run-179 summary -->` and `<!-- /ledung -->`:

```
---
**Ledung run-179** · Developing Ledung
✓ Issue + Done looks like · ✓ Design · ✓ Build · – Test (skipped) · ✓ Review · ✓ Approved by Simon
— via Ledung for Simon
```

- It is built only from the run's record: the step history, block titles and outcome words, and who reported each step ("Approved by Simon" comes from a person block's answer). A step the run went past without running shows "skipped" (point 5).
- It is updated when the run moves on, through the session's runner `gh api` (GET the body, replace only what lies between the markers, PATCH). It is updated at most once a minute per PR and charged to the GitHub budget like the PR poll. Text outside the markers is never touched. A body someone edited by hand keeps their edit. If the markers were removed, Ledung stops updating that PR and says so on the run.
- The PR's own signature is folded into the summary, so a PR made in a run carries one signature, not two. The stand-in sees the run in its session file and leaves the body to the summary.
- It is governed by the PR-descriptions switch.

### The Sent view

A list of everything sessions posted outside: when, the project, the run (a link to it), the session (a link to it, shown only in Ledung), the kind (issue, comment, PR, review, other tracker), and a link to the post. It can be filtered by project and run. It is built from the journals, kept in the database (a new `MIGRATIONS` entry) for the evidence period, then trimmed. At 390 px each entry is two lines (kind and link; project · run · time). At 1280 px it is a table. It lives under the existing sidebar section for runs (open choice 5).

## What is shown

- **Project settings → Signature:** the text field with a live preview filled in for a sample run, six switches, and the list of tracker tools with their chosen field (changeable, or "None").
- **A waiting badge** on the project when a tracker tool's field is still unchosen.
- **The run page:** "PR summary: updated 2 min ago", or why it stopped.
- **Sent:** as above.

## Security

- No new opening in the page or API. The stand-in talks to nothing but the real `gh` and a file in the data folder. It never calls Ledung.
- The per-session file holds no token, only the real `gh`'s path, the signature, the switches and the run. A session can read or change it (same user). That only changes its own courtesy line, and the session could post through the real `gh` anyway.
- The real `gh` is found once by Ledung (full path), so the stand-in can't call itself in a loop. It also refuses to `exec` a path inside its own folder.
- The signature can only contain the five fill-ins and the person's own text, which is checked against the sensitive patterns. No private details can leak through it (point 7).
- The hook change never turns an ask into an allow or skips a refusal (check 1). The person sees the signed text.
- A PR description is edited only between Ledung's own markers, through the project's own `gh` sign-in.

## Parts

1. **Settings and the stand-in `gh` (local sessions).** Signature settings, the stand-in on `PATH`, signing the five commands from all three body sources, the marker and its check, falling back on any failure, the journal. *Done when:* tests cover each command and body source, pass-through (same output and exit code) and the fallback, and a throwaway Ledung on Windows signs a real issue, comment and PR in a throwaway repo from Git Bash. Points 1, 2, 3, and 7 for `gh`.
2. **Other trackers.** Picking out write tools, the one-time field question, the hook step and how it fits the chain, the journal line. *Done when:* the check-1 tracker server, under a throwaway Ledung, asks once and signs every later call. A read-only tool is never touched. A refused call stays refused. Point 4.
3. **Commits.** `attribution.commit` with `Ledung-Run`. *Done when:* a commit made in a run carries the trailer and the person's own attribution text. Outside a run, commits are unchanged.
4. **Living PR summary.** *Done when:* a throwaway run's PR shows the summary, updates after each step, shows a skipped step as skipped, and leaves a hand edit outside the markers alone. Point 5.
5. **Sent view.** Database entry, list, filters. *Done when:* it lists parts 1–2's posts with links, per project and run, and works at 1280 and 390 px (dark-mode screenshots). Point 6.

Rough session time: part 1 ≈ 90 min, part 2 ≈ 60–90 min, part 3 ≈ 20 min, part 4 ≈ 60 min, part 5 ≈ 60 min. Each part also waits for review and CI.

## Open choices

1. **A tracker tool's first use: ask during the call, or after?**
   - **(a) After (recommended):** the first call goes unsigned and a waiting item asks which field. Nobody's work stops for a courtesy line.
   - (b) During: the call waits until the person picks a field. This matches #513's "asks once" literally, but holds a session on something cosmetic, possibly for hours.
2. **Container sessions.**
   - **(a) Later (recommended):** part 1 covers local sessions. In a container, the real `gh` runs unsigned and the PR summary still works, because it goes through the runner. Copying a stand-in into someone's container (`docker cp`, Node there or not) is its own small design.
   - (b) In part 1 with a POSIX `sh`-only stand-in.
3. **PowerShell.**
   - **(a) No `gh.ps1` for now (recommended):** PowerShell finds the real `gh.exe`, so posts from PowerShell go unsigned but never break. Git Bash is Claude Code's shell on Windows.
   - (b) Write `gh.ps1` only when Ledung finds the execution policy allows scripts.
4. **Commits on by default?**
   - **(a) Off by default (recommended):** a trailer in someone's history is more lasting than a comment line.
   - (b) On, like the other switches.
5. **The view's name and place.** The board already has an "outbox" for held posts (PR #131), so "Outbox" would mean two things.
   - **(a) "Sent", under runs (recommended).**
   - (b) "Outbox", with the board's renamed.
   - (c) "Posted", in each project's settings.
