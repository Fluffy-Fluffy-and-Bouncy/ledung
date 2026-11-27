# A project signature — proposal

Nov 26, 2026, revised Nov 27 twice (Ledung's signature replaces Claude Code's lines; then presets, off is off, no PR summary) · Proposal for issue #513 (run-179). Not approved yet; nothing is built.

**Done when:** the "Done looks like" points of #513 hold, without the living PR summary, which Simon dropped (point 5, see below): a signature per project, chosen as a preset and editable per place; it replaces Claude Code's own PR and commit lines; `gh` issue/PR create, comment and review get it from every body source on Windows and Mac; every other `gh` call is unchanged; another server's write tool gets it after one question per tool and project; an Outbox lists what went out; and never a second signature, one on a read-only call, a private detail in one, or a broken `gh`.

## Why

Sessions write issues, comments, PRs and commits on GitHub and other trackers in the person's name. People reading them can't tell that the work came through Ledung, or which run it belongs to. Simon talked it through on 2026-11-26 and 2026-11-27: one short, factual line per project that the project can change or turn off, and that replaces Claude Code's own line rather than sitting under it ("we're replacing it with a per project signature that the user can change").

The signature is a **courtesy line, not proof**. A session can always reach the real `gh` or the site; nothing here is a security boundary, so it never blocks work.

**Dropped: the living PR summary.** Simon, 2026-11-27: "I don't think it's up to Ledung, but each project's workflow. If I want to comment every time we start a new phase of an issue, then I can have that in the workflow." So Ledung keeps no section in PR descriptions, edits no PR, and point 5 of #513 is out of this design.

## The two checks (done 2026-11-26)

1. **Can a hook change another MCP server's tool call? Yes.** A throwaway stdio MCP server (`tracker`, tool `create_comment`) ran under the Agent SDK 0.3.295 / Claude Code 2.1.319 with Haiku. A `PreToolUse` hook returning only `hookSpecificOutput.updatedInput` (no `permissionDecision`) changed the body. The server received `"hello\n\n— via Ledung"`. Importantly, **the permission check still ran**: `canUseTool` was called with the signed input, so the person approves the text that will actually go out. With the tool in `allowedTools`, it went through signed without a prompt, as before. The hook input also names the server (`mcp_server: {name, source}`).
2. **Does a stand-in `gh` work on Windows? Yes, as a shell script and a `.ps1`, not as a `.cmd`.** A folder with the stand-in put ahead of the real `gh` on `PATH`:
   - **Git Bash** (Claude Code's Bash tool on Windows; also macOS, Linux): an extensionless `gh` shell script (`exec node gh.mjs "$@"`) is found first. Arguments arrive exactly (`50% & <done> "q" !x ^y $HOME`), stdin passes through (`--body-file -`), and the real `gh`'s output and exit codes (0, 1) come back unchanged.
   - **PowerShell 5.1**: a `gh.ps1` is picked before the real `gh.exe`. It passes stdin only when written to forward `$input`; the first version hung on a pipe. Embedded `"` are lost, but that is PowerShell 5.1's own native-argument behaviour and happens with the real `gh.exe` too. **Risk:** Windows' default execution policy (`Restricted`) refuses a `.ps1`, which would turn `gh` into an error. See open choice 3.
   - **cmd**: a `gh.cmd` can't pass arguments safely. cmd re-reads `%`, `&`, `^` and `!` in `%*`, and in the test the body arrived split into pieces. So there is no `.cmd`. cmd skips the extensionless script and finds the real `gh.exe`: unsigned, but intact.
   - **Signing and falling back** (a prototype `gh.mjs`, Git Bash): a body from `--body-file <file>`, from `-F -` (stdin) and from `--body` came out signed as `<body>\n\n— via Ledung for Simon\n<!-- ledung run-0 -->`. A body that already had the marker was passed on unchanged. With the session file missing, or a simulated bug in the stand-in, the real `gh` ran with the original arguments. `gh --version` gave the same output and exit 0, and a failing `gh issue comment … --repo <nonexistent>` gave the same error and exit 1 as the real `gh` called directly. Two things the prototype showed that the real one must do: when falling back, say nothing on stderr (the reason goes to the journal instead), and keep stdin it has already read so it can be handed to the real `gh`.
   - **Mac, reasoned only:** the shell-script stand-in is the Git Bash case. zsh and bash look up `PATH` in order, `exec` keeps the exit code, and Node is there because Ledung runs on it. The only difference is the real `gh`'s path (`/opt/homebrew/bin/gh` or `/usr/local/bin/gh`), which Ledung finds when the session starts. This still needs one run on a Mac in part 1.

## May Claude's lines be removed? (checked 2026-11-27)

Yes. Simon asked whether replacing the `Co-Authored-By` and "Generated with" lines steps on any of Anthropic's terms. What I found:

- **Claude Code's own documentation supports it.** The settings reference (code.claude.com/docs/en/settings-reference, "Git and attribution") documents `attribution.commit` ("Set it to an empty string to hide commit attribution"), `attribution.pr` ("Set it to an empty string to hide pull request attribution") and `attribution: false` "to hide all attribution", with examples that replace the default trailer with custom text. The defaults are `Co-Authored-By: <model name> <noreply@anthropic.com>` on commits and `🤖 Generated with [Claude Code](https://claude.com/claude-code)` on PRs.
- **The Usage Policy** (anthropic.com/legal/aup) doesn't require these lines. Its relevant rule is about honesty, not a fixed line: it forbids "Plagiarize or submit AI-assisted work without proper permission or attribution", and passing AI off as human (a bot that claims to be human). So where a place requires AI work to be disclosed (a school, an employer's policy, a repo's contribution rules), the person stays responsible for that. Ledung standard keeps the `Co-Authored-By` trailer partly for this reason, and the settings page says so in one line next to the preset choice.
- **The Consumer Terms and Commercial Terms** (anthropic.com/legal/consumer-terms, /commercial-terms): a search for attribution or disclosure found no requirement to keep a line on outputs.

This is my reading of public pages, not legal advice.

## What it does

### Presets, per project

In the project's settings, a **Signature** section. The project picks a preset:

- **Claude Code standard:** exactly what Claude Code does on its own. PR descriptions: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commits: `Co-Authored-By: {model} <noreply@anthropic.com>`. Nothing on issues, comments, reviews or other trackers.
- **Ledung standard:** Ledung's own text (open choice 4 for what it says).
- **None:** nothing anywhere, Claude's lines included. Simon: "If switched off, it should be off."
- **Custom:** editing any text of a preset turns it into Custom. "Reset to a preset" goes back.

Each preset is **a text per place**: PR description · commit · new issue · issue comment · PR comment and review · other trackers. **An empty text means nothing in that place**, not even the hidden marker. There are no separate switches: the text is the switch.

**Fill-ins:** `{user}` (Ledung's user name), `{project}` (the project's name), `{run}` (`run-179`), `{workflow}` (the flow's name), and `{model}` (the session's model as Claude Code names it, such as `Claude Opus 5.5`). Outside a run, `{run}` and `{workflow}` are empty, and a line left empty by them is dropped. That is how `Ledung-Run: {run}` appears only in a run. Only these fill-ins exist: session titles, folder paths, account names and anything else private can't be put in a signature, because there is no fill-in for them. The text is checked against the project's sensitive patterns on save, as board posts are.

**Defaults** (Simon: "existing projects should remain as is, new projects use a Ledung standard"):

- A project with no Signature setting counts as **Claude Code standard**, so every project that exists when this ships behaves as today, without a migration.
- A project added after this ships is saved with **Ledung standard**.

**Where the settings live:** the project's settings, not the workflow. How a project signs is about the repo and who reads it, and it applies outside a run too. A workflow adds only what it knows, through `{run}` and `{workflow}`. Saved like the other project settings, in the project's part of the config, so a work project's text can stay in `ledung.config.local.json`. A change applies to sessions started after it (Claude Code's attribution is set when the session starts); the stand-in and the tracker hook read it per call.

### Claude Code's lines: set from the preset

Claude Code writes its PR line and commit trailer itself, as text it is told to add, so they can't be taken out reliably afterwards. Ledung sets them instead, per session, through the SDK's `settings` option. That is the command-line level of Claude Code's settings, which ranks above the person's user and project files and below managed settings (code.claude.com/docs/en/settings, "Settings precedence"). The person's own settings files are never written, and sessions outside Ledung are untouched.

- `attribution.commit` = the preset's commit text, filled in. Empty means no trailer.
- `attribution.pr` = the preset's PR text, filled in, followed by the marker `<!-- ledung run-179 -->` (or `<!-- ledung -->`) when the text isn't empty. Empty means no line.
- **Unedited Claude Code standard:** Ledung sets nothing, so Claude Code does exactly what it does today, including the person's own `attribution` settings and naming a subagent's model on a subagent's commit (open choice 6).
- **None:** `attribution` is set to `false`, Claude Code's documented "hide all attribution".
- If the organisation's managed settings fix `attribution`, they win, and Ledung's settings page says so rather than promising a line it can't set.

`{model}` is filled when the session starts. If the model changes in the session, Ledung sends the settings again (the SDK's `applyFlagSettings`), so the trailer names the model that made the commit.

### The marker: where it is still needed

The hidden marker `<!-- ledung run-179 -->` (or `<!-- ledung -->`) exists only to stop a second signature. It goes where two paths could sign the same body:

- **PR descriptions:** Claude adds the PR text itself through `attribution.pr`, and the stand-in `gh` also sees `gh pr create`. The stand-in adds the signature only when the marker isn't in the body (Claude forgot, or the body came from a file Claude didn't write). So a PR gets one line either way.
- **Issues, comments, reviews:** only the stand-in signs these, but a body copied from an earlier post, a repeated call, or a session signing by hand would get a second line. The marker check covers that.

Commits carry no marker: only Claude Code writes the trailer, so there is nothing to double. Before signing, the stand-in searches for `<!-- ledung`; if it is there, nothing is added. Edits (`gh issue edit`, `gh pr edit`, `gh api … PATCH`) are never signed.

**When a tracker strips the marker (Linear, Jira and others),** Ledung doesn't rely on it coming back. Two other checks stop a second signature:

- **The text check:** a body that already ends with the project's filled-in text for that place is left alone.
- **Ledung's own record:** each signed call is journalled (tool, the target's id, such as the issue key, and a hash of the body). The same tool, target and body within a day is a repeat and is not signed again.

For trackers whose Markdown keeps HTML comments, the marker is added as on GitHub. Whether one does is found out in part 2, per tracker, not assumed.

### GitHub: the stand-in `gh`

Claude Code adds no line to issues, comments or reviews, so the stand-in is what signs them. Ledung writes a small stand-in into its data folder (`<data>/gh-stand-in/`, via `src/platform/paths.ts`). It is a `gh` shell script and, if chosen, a `gh.ps1`, both calling one `gh.mjs` run by Ledung's own Node. Ledung puts that folder first on the session's `PATH` in `sessionEnv`. A per-session file next to it holds the real `gh`'s full path (found when the session starts), the project's texts per place already filled in, and the run. No `LEDUNG_*` variable is used, so the rule "sessions don't inherit LEDUNG_* settings" stays as it is.

`gh.mjs` reads its arguments, not a command line:

- It signs only `issue create`, `issue comment`, `pr create`, `pr comment` and `pr review` (with `--comment`, `--approve` or `--request-changes` and a body), and only when that place's text isn't empty. With None, or an empty text, the call passes through unchanged.
- It takes the body from `--body`/`-b`, `--body-file`/`-F` (a file, or `-` for stdin), and writes the signed body to a temporary file passed as `--body-file`. Stdin is read only when the call itself reads it.
- A call with no body of its own (`--fill`, `--web`, `--editor`, interactive) is passed through unchanged.
- Every other call `exec`s the real `gh` with the same arguments, stdin, stdout and exit code.
- **Any failure in the stand-in** (missing or unreadable session file, a bug, an argument it can't parse) runs the real `gh` with the original arguments, untouched. Only the real `gh`'s own failures are reported as failures.
- After a signed call, it appends one line to the session's journal: kind, repo, the URL that `gh` printed, the time. A PR whose line Claude wrote (marker found) is journalled too, so the Outbox lists it. A fallback writes its reason there, never to stderr.

Container sessions run `gh` inside the container, which Ledung doesn't write to today. See open choice 2. Their PRs and commits still get the preset's lines, because those come from Claude Code's settings, not from the stand-in.

### Other trackers: one question per tool, then a hook

Claude Code adds no line to other servers' tools either, so this is unchanged by the presets except that the text comes from the "other trackers" place, and an empty text turns it off. Ledung's existing `PreToolUse` hook gets one more step for `mcp__*` tools of servers that aren't Ledung's own:

- **Which tools count as writes:** those not marked `readOnly` in the server's own tool list (`mcpServerStatus()`, which gives name, description and annotations, but no input schema), whose name or description says create, add, post, comment, reply or update, and whose call has at least one string field.
- **The first call** of such a tool in a project goes through **unsigned**. The project's settings get a waiting item, with a small badge on the project: "Linear: create_comment. Which field gets the signature?", offering the call's string fields (`body`, `title`, …) and "None". The answer is kept per project and tool. Every later call has the signature added to that field as the call passes (the check-1 mechanism), and the server's own sign-in is untouched. See open choice 1 for asking during the call instead. No question is asked while the other-trackers text is empty.
- **Fitting into the hook chain:** the signed input is worked out first. Every `allow` the chain returns afterwards (grants, rules, away mode) carries it as `updatedInput`, and an "ask" carries it too, so the person approves the signed text. A refusal stays a refusal. Never adding a signature to a call that Ledung or the person would refuse.
- A `PostToolUse` step writes the same journal line, with any URL found in the result.

### The Outbox

A list of everything sessions posted outside, newest first: when, the kind (issue, comment, PR, review, a tracker's comment), a link to the post, the project, the run (a link to it), and the session (a link to it; session titles are shown only here, inside Ledung, never in a signature). It can be filtered by project and run, or "Not in a run". It is built from the journals and the hook's record, kept in the database (a new `MIGRATIONS` entry) for the evidence period, then trimmed. Commits aren't listed: they go out with a push, which Ledung doesn't journal. At 1280 px it is a table. At 390 px each entry is a card of two lines: the kind and the link, cut off with "…", then project · run · time · session. Where it lives is open choice 5. The board's held posts are also called an outbox in the code (PR #131), but the page never shows that word, so the name is free.

Mock-up (static, dark mode, made-up projects; `project-signature/outbox-mock.html`):

![Outbox at 1280 px](project-signature/outbox-1280.png)

![Outbox at 390 px](project-signature/outbox-390.png)

## What is shown

- **Project settings → Signature:** the preset (Claude Code standard · Ledung standard · None · Custom), the six texts with a live preview filled in for a sample run, the fill-ins listed under them, one line "Some places require AI work to be disclosed; you stay responsible for that.", and the list of tracker tools with their chosen field (changeable, or "None"). At 390 px the texts stack one under the other.
- **A waiting badge** on the project when a tracker tool's field is still unchosen.
- **Outbox:** as above.

## Security

- No new opening in the page or API. The stand-in talks to nothing but the real `gh` and a file in the data folder. It never calls Ledung.
- The per-session file holds no token, only the real `gh`'s path, the filled-in texts and the run. A session can read or change it (same user). That only changes its own courtesy line, and the session could post through the real `gh` anyway.
- The real `gh` is found once by Ledung (full path), so the stand-in can't call itself in a loop. It also refuses to `exec` a path inside its own folder.
- The texts can only contain the five fill-ins and the person's own words, checked against the sensitive patterns. No private details can leak through them.
- The hook change never turns an ask into an allow or skips a refusal (check 1). The person sees the signed text.
- Claude Code's lines are set only for Ledung's own sessions, through the SDK's per-session settings. The person's Claude Code settings files are never written, and managed settings still win.
- Ledung no longer edits PR descriptions at all (the summary is dropped).

## Parts

Each part is its own PR, reviewed and approved on its own. Part 1 comes first, because it adds the settings and the journal the others use. Parts 2, 3 and 4 depend only on part 1 and can go in any order.

| # | Part | Done when | Session time | Plan use |
|---|---|---|---|---|
| 1 | **Presets and the stand-in `gh`** (local sessions): the Signature settings (presets, texts per place, fill-ins, Custom, defaults for existing and new projects), the stand-in on `PATH`, signing the five commands from all three body sources, the marker and its check, a silent fallback, the journal. | Tests cover each preset, each command and body source, pass-through (same output and exit code), None and empty texts (nothing added), and the fallback. An existing project's config is unchanged and reads as Claude Code standard; a new one is saved as Ledung standard. A throwaway Ledung on Windows signs a real issue and comment in a throwaway repo from Git Bash. One run on a Mac. | ≈ 90 min | medium: one build session plus review |
| 2 | **Other trackers:** picking out write tools, the one-time field question, the hook step and how it fits the chain, the repeat check without a marker, the journal line. | The check-1 tracker server, under a throwaway Ledung, asks once and signs every later call. A read-only tool is never touched. A refused call stays refused. A repeated call isn't signed twice. An empty other-trackers text asks nothing and signs nothing. | 60–90 min | medium |
| 3 | **Claude Code's lines:** `attribution.pr` and `attribution.commit` from the preset, `attribution: false` for None, nothing set for unedited Claude Code standard, `{model}` and re-sending on a model change. | First a check that the SDK's `settings` option wins over a user's own `attribution`, and that an empty string and `false` give no line. Then, in throwaway sessions (Haiku): Ledung standard gives Ledung's PR line with marker and no Claude line, and the chosen commit trailer with `Ledung-Run` in a run only; None gives no line on either; Claude Code standard is byte-for-byte today's; the stand-in adds no second PR line. The person's own settings file is unchanged. | ≈ 40 min | small |
| 4 | **Outbox:** database entry, list, filters, the page at both widths. | It lists parts 1–3's posts with links, per project and run, and works at 1280 and 390 px (dark-mode screenshots beside this mock-up). | ≈ 60 min | medium (page and screenshots) |

About 4 to 4½ hours of session time in all, in four PRs (the PR summary's hour is gone, part 3 grew by 20 minutes). Each part also waits for code review, CI and Simon's sign-off. No measured figures from Ledung exist for this kind of work yet, so plan use is only relative.

## Open choices

1. **A tracker tool's first use: ask during the call, or after?**
   - **(a) After (recommended):** the first call goes unsigned and a waiting item asks which field. Nobody's work stops for a courtesy line.
   - (b) During: the call waits until the person picks a field. This matches #513's "asks once" literally, but holds a session on something cosmetic, possibly for hours.
2. **Container sessions.**
   - **(a) Later (recommended):** part 1 covers local sessions. In a container, issues and comments go out unsigned through the real `gh`; PRs and commits still get the preset's lines from Claude Code's settings. Copying a stand-in into someone's container (`docker cp`, with or without Node there) is its own small design.
   - (b) In part 1, with a POSIX `sh`-only stand-in.
3. **PowerShell.**
   - **(a) No `gh.ps1` for now (recommended):** PowerShell finds the real `gh.exe`, so issues and comments from PowerShell go unsigned but never break. Git Bash is Claude Code's shell on Windows.
   - (b) Write `gh.ps1` only when Ledung finds the execution policy allows scripts.
4. **What Ledung standard says, per place.**
   - **(a) The manager's suggestion (recommended):** PR description and new issue `— via Ledung for {user}`; commit `Co-Authored-By: {model} <noreply@anthropic.com>` and, on the next line, `Ledung-Run: {run}` (dropped outside a run); issue comments, PR comments and reviews, and other trackers empty. The trailer keeps an honest, machine-readable record that Claude wrote the code; comments stay quiet, because a line under every comment is noise.
   - (b) As (a), but comments and reviews signed too: every post says it came through Ledung, at the cost of a line under each.
   - (c) As (a), but without the `Co-Authored-By` trailer: only `Ledung-Run` in a run. The person then owns any disclosure a place requires.
5. **Where the Outbox lives.**
   - **(a) A sidebar entry next to runs, as in the mock-up (recommended):** one place across projects, with filters.
   - (b) A tab in each project's settings.
6. **Unedited Claude Code standard: leave Claude Code alone, or set its text?**
   - **(a) Leave it alone (recommended):** Ledung sets no `attribution`, so existing projects stay exactly as they are, including the person's own Claude Code settings and a subagent's model on a subagent's commit. The settings page shows Claude's default text, with a note if the person's own settings change it.
   - (b) Set the preset's text like any other: the page always shows exactly what goes out, but a subagent's commit names the main session's model, and a person's own `attribution` setting is overridden in Ledung sessions.
