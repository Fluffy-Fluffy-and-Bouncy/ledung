# A project signature — proposal

Nov 26, 2026, revised Nov 27 (Ledung's line replaces Claude Code's; then Simon's changes: presets, a text per place, off is off, no PR summary) · Proposal for issue #513 (run-179). Not approved yet; nothing is built.

**Done when:** the "Done looks like" points of #513 hold, minus the living PR summary: a signature per project, set by a preset or by hand, with a text per place; `gh` issue create, issue and PR comments and reviews get it from every body source on Windows and Mac, and PR descriptions and commits through Claude Code's own settings; every other `gh` call is unchanged; another server's write tool gets it after one question per tool and project; an Outbox lists what went out; and never a second signature, one on a read-only call, a private detail in one, or a broken `gh`.

## Why

Sessions write issues, comments, PRs and commits on GitHub and other trackers in the person's name. People reading them can't tell that the work came through Ledung. Simon talked it through on 2026-11-26 and liked the direction: a short, factual line per project that the person can change or turn off, added by Ledung.

The signature is a **courtesy line, not proof**. A session can always reach the real `gh` or the site; nothing here is a security boundary, so it never blocks work.

## What Simon decided on 2026-11-27

In conversation with the manager, relayed with his words; they go into `docs/decisions.md` when the design is approved.

- **Ledung handles the signatures:** "I still want Ledung to handle the signatures though."
- **Presets, and a text per place:** Claude Code standard · Ledung standard · None; editing any text makes it Custom. An empty text means nothing in that place.
- **Ledung's texts replace Claude Code's lines completely, and nothing is hardcoded:** "we're replacing it with a per project signature that the user can change." Both Claude Code lines come from the project's texts. "The co-authored by claude should work the same way, unless that steps on any of Anthropic's licence thingies. If the user wants to have it there, they can have it in the signature; otherwise they can change it." (Earlier, question #2434: "We should override Claude Code's signature.") What Anthropic's terms say is under "Anthropic's terms" below.
- **Off is off:** "If switched off, it should be off." None means no line anywhere, Claude's included.
- **Defaults:** "existing projects should remain as is, new projects use a Ledung standard." This replaces the earlier defaults by repo visibility.
- **No living PR summary:** "I don't think it's up to Ledung, but each project's workflow. If I want to comment every time we start a new phase of an issue, then I can have that in the workflow." A PR made in a run gets the PR-description text like any other PR.

## Anthropic's terms (checked 2026-11-27)

Nothing found requires keeping Claude Code's lines, and Claude Code's own documentation offers changing and hiding them:

- **Claude Code settings reference** (code.claude.com/docs/en/settings-reference, "Git and attribution"): `attribution.commit` "Set the attribution text Claude Code adds to git commits, including any trailers. Set it to an empty string to hide commit attribution." `attribution.pr` likewise, and "To hide all attribution, set `attribution` to `false`." The docs give examples that replace the trailer with a custom one. The defaults are `Co-Authored-By: <name> <noreply@anthropic.com>` (the name is the model making the commit, such as `Claude Sonnet 5`, or a subagent's model) and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Usage Policy** (anthropic.com/legal/aup): no labelling requirement for code, commits or PRs. The rules that touch the subject are general: don't "plagiarize or submit AI-assisted work without proper permission or attribution", no "bots that claim to be human", and disclosure duties for consumer-facing chatbots and high-risk advice (legal, medical, finance, employment), none of which a commit line is. Even there: "Users do not need to identify Anthropic, Claude, or the model used."
- **Consumer Terms and Commercial Terms:** no sentence about labelling outputs or keeping attribution; the Consumer Terms forbid using the services "to deceive any person".

So removing or replacing the lines is a supported choice. The one thing left to the person is where a place requires disclosure (a repo's contribution rules that ask for AI involvement to be stated, an employer's policy): that is the project's text to set, and the settings say so in one line. This is a reading of the published pages, not legal advice.

## The two checks (done 2026-11-26)

1. **Can a hook change another MCP server's tool call? Yes.** A throwaway stdio MCP server (`tracker`, tool `create_comment`) ran under the Agent SDK 0.3.295 / Claude Code 2.1.319 with Haiku. A `PreToolUse` hook returning only `hookSpecificOutput.updatedInput` (no `permissionDecision`) changed the body. The server received `"hello\n\n— via Ledung"`. Importantly, **the permission check still ran**: `canUseTool` was called with the signed input, so the person approves the text that will actually go out. With the tool in `allowedTools`, it went through signed without a prompt, as before. The hook input also names the server (`mcp_server: {name, source}`).
2. **Does a stand-in `gh` work on Windows? Yes, as a shell script and a `.ps1`, not as a `.cmd`.** A folder with the stand-in put ahead of the real `gh` on `PATH`:
   - **Git Bash** (Claude Code's Bash tool on Windows; also macOS, Linux): an extensionless `gh` shell script (`exec node gh.mjs "$@"`) is found first. Arguments arrive exactly (`50% & <done> "q" !x ^y $HOME`), stdin passes through (`--body-file -`), and the real `gh`'s output and exit codes (0, 1) come back unchanged.
   - **PowerShell 5.1**: a `gh.ps1` is picked before the real `gh.exe`. It passes stdin only when written to forward `$input`; the first version hung on a pipe. Embedded `"` are lost, but that is PowerShell 5.1's own native-argument behaviour and happens with the real `gh.exe` too. **Risk:** Windows' default execution policy (`Restricted`) refuses a `.ps1`, which would turn `gh` into an error. See open choice 3.
   - **cmd**: a `gh.cmd` can't pass arguments safely. cmd re-reads `%`, `&`, `^` and `!` in `%*`, and in the test the body arrived split into pieces. So there is no `.cmd`. cmd skips the extensionless script and finds the real `gh.exe`: unsigned, but intact.
   - **Signing and falling back** (a prototype `gh.mjs`, Git Bash): a body from `--body-file <file>`, from `-F -` (stdin) and from `--body` came out signed as `<body>\n\n— via Ledung for Simon\n<!-- ledung run-0 -->`. A body that already had the marker was passed on unchanged. With the session file missing, or a simulated bug in the stand-in, the real `gh` ran with the original arguments. `gh --version` gave the same output and exit 0, and a failing `gh issue comment … --repo <nonexistent>` gave the same error and exit 1 as the real `gh` called directly. Two things the prototype showed that the real one must do: when falling back, say nothing on stderr (the reason goes to the journal instead), and keep stdin it has already read so it can be handed to the real `gh`.
   - **Mac, reasoned only:** the shell-script stand-in is the Git Bash case. zsh and bash look up `PATH` in order, `exec` keeps the exit code, and Node is there because Ledung runs on it. The only difference is the real `gh`'s path (`/opt/homebrew/bin/gh` or `/usr/local/bin/gh`), which Ledung finds when the session starts. One run on a Mac is still needed, in part 2.

## What it does

### The signature, per project

In the project's settings, a **Signature** section: a preset, and a text per place.

**The places:** PR descriptions · commits · new issues · issue comments · PR comments and reviews · other trackers. Each has its own text; an empty text means nothing is added there.

**The presets:**

| Place | Claude Code standard | Ledung standard (open choice 4) | None |
|---|---|---|---|
| PR descriptions | `🤖 Generated with [Claude Code](https://claude.com/claude-code)` | `— via Ledung for {user}` | — |
| Commits | `Co-Authored-By: {model} <noreply@anthropic.com>` | `Co-Authored-By: {model} <noreply@anthropic.com>` and `Ledung-Run: {run}` | — |
| New issues | — | `— via Ledung for {user}` | — |
| Issue comments | — | — | — |
| PR comments and reviews | — | — | — |
| Other trackers | — | — | — |

- **Claude Code standard** is Claude's own lines, exactly, and nothing on issues, comments or trackers. It is what every session gets today.
- **Ledung standard** puts Ledung's line on PRs and new issues, keeps the co-author trailer on commits and adds the run. Comments, reviews and trackers stay quiet: they are mostly conversation and work tools.
- **None** means nothing anywhere: no Ledung line, no Claude line, no marker.
- **Custom:** editing any text, from any preset, switches the project to Custom with the texts as they stood, so "Claude Code standard plus a signed issue" is one edit. Picking a preset again replaces the texts, after a "Replace your texts?" confirmation.

**Fill-ins:** `{user}` (Ledung's user name), `{project}` (the project's name), `{run}` (`run-179`), `{workflow}` (the flow's name) and `{model}` (the session's model as Claude Code names it, `Claude Opus 5.5`). Outside a run, the run fill-ins are empty, and a line left empty by them is dropped (so `Ledung-Run:` never appears alone). Only these five exist: session titles, folder paths, account names and anything else private can't be put in a signature, because there is no fill-in for them. Every text is checked against the project's sensitive patterns on save, as board posts are. (`{steps}` went with the PR summary.)

**Existing and new projects:** a project with no signature setting is Claude Code standard, so every existing project behaves exactly as today. A project made in Ledung after this ships (New project, or the Ledung Helper) is saved with Ledung standard. A project added to the config by hand has no setting, so it is Claude Code standard too.

**Where the settings live: the project's settings, not the workflow.** Whether and how a project signs is about the repo and who reads it, and it applies to work outside a run too. Saved like the other project settings, in the project's part of the config, so a work project's text can stay in `ledung.config.local.json`. A change reaches PR descriptions and commits for sessions started or resumed afterwards (Claude Code takes those at the start; part 1 checks whether a running session can be updated), and everything else on the next call.

### PR descriptions and commits: Claude Code's own settings

Claude Code adds its lines from two settings: `attribution.pr` and `attribution.commit`. Claude writes both itself, as text it is told to add, so a stand-in can't reliably take them out afterwards. Ledung sets them instead, per session, through the SDK's `settings` option, which ranks above the person's own Claude Code settings for that session only. The person's settings files are never changed, and sessions outside Ledung keep whatever those files say.

| The project's text for the place | What Ledung sets for the session |
|---|---|
| Claude Code standard, unedited | nothing: Claude Code's own defaults, exactly as today |
| A text (Ledung standard or Custom) | `attribution.pr` / `attribution.commit` = that text, filled in |
| Empty (None, or emptied by hand) | an empty string: no line at all (with None, `attribution: false`) |

Leaving an unedited Claude Code standard alone keeps "as is" literal: Claude's own trailer names the model making each commit, including a subagent's, and a person's own `attribution` settings still apply. Once a text is set, `{model}` is the session's model at the start, refilled if Ledung switches the model; a commit made by a subagent on another model then names the session's model. That is the one difference from Claude's own trailer, and it only arises in Custom or Ledung standard.

Because Claude Code adds the PR line itself, it is there in every shell and in container sessions too. A PR description gets its line only this way: the stand-in doesn't sign `gh pr create`, so there is never a second line on a PR. Commits get no marker; a trailer is plain to read. No git hooks are installed in anyone's repository.

Not checked yet, so done first in part 1: that the SDK's `settings` option wins over a person's own `attribution` for that session, and that an empty string gives no line rather than Claude's default.

### The marker, where it is still needed

The stand-in and the tracker hook add the text to a body that someone else (Claude) wrote, so they need a way to see they already did. Every body they sign ends with the text, then a hidden marker where the site renders Markdown: `<!-- ledung run-179 -->`, or `<!-- ledung -->` outside a run. Before signing, the body is searched for `<!-- ledung`; if it is there, nothing is added. That covers a repeated post, a body copied from an earlier one and a session that signed by hand. Edits (`gh issue edit`, `gh pr edit`, `gh api … PATCH`) are never signed. PR descriptions and commits carry no marker: Claude Code adds their line once, and nothing else adds one.

**When a tracker strips the marker (Linear, Jira and others),** Ledung never relies on it coming back. Two other checks keep "never a second signature":

- **The text check:** a body that already ends with the project's filled-in text for that place, or contains `via Ledung`, is left alone.
- **Ledung's own record:** each signed call is journalled (tool, the target's id, such as the issue key, and a hash of the body). The same tool, target and body within a day is a repeat and is not signed again.

For trackers whose Markdown keeps HTML comments, the marker is added as on GitHub. Whether one does is found out in part 3, per tracker, not assumed.

### GitHub: the stand-in `gh`

Ledung writes a small stand-in into its data folder (`<data>/gh-stand-in/`, via `src/platform/paths.ts`): a `gh` shell script, and if chosen a `gh.ps1`, both calling one `gh.mjs` run by Ledung's own Node. When one of the stand-in's places (new issues, issue comments, PR comments and reviews) has a text, Ledung puts that folder first on the session's `PATH` in `sessionEnv`; otherwise it isn't there at all, so Claude Code standard and None projects run the real `gh` directly. A per-session file next to it holds the real `gh`'s full path (found when the session starts), the three places' texts already filled in, and the run. No `LEDUNG_*` variable is used, so the rule "sessions don't inherit LEDUNG_* settings" stays as it is.

`gh.mjs` reads its arguments, not a command line:

- It signs only `issue create`, `issue comment`, `pr comment` and `pr review` (with `--comment`, `--approve` or `--request-changes` and a body), and only when that place has a text.
- It takes the body from `--body`/`-b`, `--body-file`/`-F` (a file, or `-` for stdin), and writes the signed body to a temporary file passed as `--body-file`. Stdin is read only when the call itself reads it.
- A call with no body of its own (`--fill`, `--web`, `--editor`, interactive) is passed through unchanged.
- Every other call `exec`s the real `gh` with the same arguments, stdin, stdout and exit code.
- **Any failure in the stand-in** (missing or unreadable session file, a bug, an argument it can't parse) runs the real `gh` with the original arguments, untouched. Only the real `gh`'s own failures are reported as failures.
- After a signed call, and after `pr create` (not signed, but worth listing), it appends one line to the session's journal: kind, repo, the URL `gh` printed, the time. That journal feeds the Outbox. A fallback writes its reason there too, never to stderr.

Container sessions run `gh` inside the container, which Ledung doesn't write to today. See open choice 2. Their PRs and commits are signed anyway, through Claude Code's settings.

### Other trackers: one question per tool, then a hook

Only when the project's other-trackers text isn't empty. Ledung's existing `PreToolUse` hook gets one more step for `mcp__*` tools of servers that aren't Ledung's own:

- **Which tools count as writes:** those not marked `readOnly` in the server's own tool list (`mcpServerStatus()`, which gives name, description and annotations, but no input schema), whose name or description says create, add, post, comment, reply or update, and whose call has at least one string field.
- **The first call** of such a tool in a project goes through **unsigned**. The project's settings get a waiting item, with a small badge on the project: "Linear: create_comment. Which field gets the signature?", offering the call's string fields (`body`, `title`, …) and "None". The answer is kept per project and tool. Every later call has the text added to that field as the call passes (the check-1 mechanism), and the server's own sign-in is untouched. See open choice 1 for asking during the call instead.
- **Fitting into the hook chain:** the signed input is worked out first. Every `allow` the chain returns afterwards (grants, rules, away mode) carries it as `updatedInput`, and an "ask" carries it too, so the person approves the signed text. A refusal stays a refusal. A signature is never added to a call that Ledung or the person would refuse.
- A `PostToolUse` step writes the same journal line, with any URL found in the result.

### The Outbox

A list of what sessions posted outside, as the stand-in and the hook saw it, newest first: when, the kind (issue, comment, PR, review, a tracker's comment), a link to the post, the project, the run (a link to it), and the session (a link to it; session titles are shown only here, inside Ledung, never in a signature). It can be filtered by project and run, or "Not in a run". It is built from the journals and the hook's record, kept in the database (a new `MIGRATIONS` entry) for the evidence period, then trimmed. At 1280 px it is a table. At 390 px each entry is a card of two lines: the kind and the link, cut off with "…", then project · run · time · session. Where it lives is open choice 5. The board's held posts are also called an outbox in the code (PR #131), but the page never shows that word, so the name is free.

It lists only what goes through the stand-in or the hook, so a project on Claude Code standard or None, which has neither, shows nothing there. Commits are not listed: they go out with a push, and the branch already shows them.

## What is shown

Mock-ups, static, dark mode, made-up projects (`project-signature/settings-mock.html`, `project-signature/outbox-mock.html`):

**Project settings → Signature:** the presets (Custom is reached by editing, not picked), a text per place with a note on what it replaces, the fill-ins, a preview filled in for a sample run, one line on disclosure, and the list of tracker tools with their chosen field (changeable, or "None").

![Signature settings at 1280 px](project-signature/settings-1280.png)

![Signature settings at 390 px](project-signature/settings-390.png)

**A waiting badge** on the project when a tracker tool's field is still unchosen.

**Outbox:**

![Outbox at 1280 px](project-signature/outbox-1280.png)

![Outbox at 390 px](project-signature/outbox-390.png)

## Security

- No new opening in the page or API. The stand-in talks to nothing but the real `gh` and a file in the data folder. It never calls Ledung.
- The per-session file holds no token, only the real `gh`'s path, the texts and the run. A session can read or change it (same user). That only changes its own courtesy line, and the session could post through the real `gh` anyway.
- The real `gh` is found once by Ledung (full path), so the stand-in can't call itself in a loop. It also refuses to `exec` a path inside its own folder.
- A signature can only contain the five fill-ins and the person's own text, which is checked against the sensitive patterns. No private details can leak through it.
- The hook change never turns an ask into an allow or skips a refusal (check 1). The person sees the signed text.
- Claude Code's lines are changed only for Ledung's own sessions, through the SDK's per-session settings. The person's Claude Code settings files are never written.

## Parts

Each part is its own PR, reviewed and approved on its own. Part 1 comes first: it adds the settings, the presets and the journal, and on its own already gives PRs and commits the project's lines. Parts 2 and 3 depend only on part 1 and can go in either order. Part 4 needs part 2 or 3 for something to list.

| # | Part | Done when | Session time | Plan use |
|---|---|---|---|---|
| 1 | **Settings, presets and Claude Code's lines:** the Signature section (presets, a text per place, Custom on edit, fill-ins with `{model}`, preview, sensitive check), Claude Code standard for projects without a setting and Ledung standard for new ones, `attribution` per session, the journal file. | First the two checks under "PR descriptions and commits". Then, in a throwaway Ledung with Haiku: an existing project's session makes a PR and a commit exactly as today; a new project's (Ledung standard) PR ends with `— via Ledung for …` and no Claude line, and its commit carries `Co-Authored-By: Claude Haiku …` and, in a run, `Ledung-Run`; with None, neither has any line; a Custom text shows up as typed. The person's own Claude Code settings file is unchanged. Settings work at 390 px. | 60–90 min | medium: one build session plus review |
| 2 | **The stand-in `gh`** (local sessions): on `PATH` only when one of its places has a text, signing the four commands from all three body sources, the marker and its check, a silent fallback, journal lines (`pr create` included). | Tests cover each command and body source, pass-through (same output and exit code), `pr create` left unsigned, and the fallback. A throwaway Ledung on Windows signs a real issue and comment in a throwaway repo from Git Bash; a repeated post isn't signed twice. One run on a Mac. | ≈ 90 min | medium |
| 3 | **Other trackers:** picking out write tools, the one-time field question, the hook step and how it fits the chain, the repeat check without a marker, the journal line. | The check-1 tracker server, under a throwaway Ledung, asks once and signs every later call. A read-only tool is never touched. A refused call stays refused. A repeated call isn't signed twice. With an empty trackers text, nothing is asked. | 60–90 min | medium |
| 4 | **Outbox:** database entry, list, filters, the page at both widths. | It lists parts 2–3's posts with links, per project and run, and works at 1280 and 390 px (dark-mode screenshots beside this mock-up). | ≈ 60 min | medium (page and screenshots) |

About 4½ to 5½ hours of session time in all, in four PRs (the earlier five parts were about 5 hours; the PR summary's hour is gone, the presets add some to part 1). Each part also waits for code review, CI and Simon's sign-off. No measured figures from Ledung exist for this kind of work yet, so plan use is only relative.

## Open choices

1. **A tracker tool's first use: ask during the call, or after?**
   - **(a) After (recommended):** the first call goes unsigned and a waiting item asks which field. Nobody's work stops for a courtesy line.
   - (b) During: the call waits until the person picks a field. This matches #513's "asks once" literally, but holds a session on something cosmetic, possibly for hours.
2. **The stand-in in container sessions.**
   - **(a) Later (recommended):** part 2 covers local sessions. In a container, issues and comments go out unsigned through the real `gh`; PRs and commits are still signed through Claude Code's settings. Copying a stand-in into someone's container (`docker cp`, with or without Node there) is its own small design.
   - (b) In part 2, with a POSIX `sh`-only stand-in.
3. **PowerShell.**
   - **(a) No `gh.ps1` for now (recommended):** PowerShell finds the real `gh.exe`, so issues and comments from PowerShell go unsigned but never break. Git Bash is Claude Code's shell on Windows.
   - (b) Write `gh.ps1` only when Ledung finds the execution policy allows scripts.
4. **What Ledung standard says.**
   - **(a) As in the table (recommended, the manager's suggestion):** PR descriptions and new issues `— via Ledung for {user}`; commits `Co-Authored-By: {model} <noreply@anthropic.com>` plus `Ledung-Run: {run}` in a run; comments, reviews and trackers empty. The co-author trailer stays because it says honestly, in a form GitHub reads, that Claude wrote the code; the PR line changes because "Generated with Claude Code" is the courtesy line Ledung's replaces.
   - (b) The same, but commits `Via: Ledung for {user}` plus `Ledung-Run: {run}`, without the co-author trailer: one Ledung line everywhere, but the commit no longer says Claude co-wrote it.
   - (c) The same as (a), plus issue comments and PR comments and reviews `— via Ledung`: more visible, more noise in conversations.
5. **Where the Outbox lives.**
   - **(a) A sidebar entry next to runs, as in the mock-up (recommended):** one place across projects, with filters.
   - (b) A tab in each project's settings.
