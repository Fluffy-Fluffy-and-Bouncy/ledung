# Ledung Helper and an AI first start — design

Nov 12, 2026, 17:05 · **Accepted by Simon** after the try-outs, the acceptance tests and the security reviews: "I think that's good enough." It goes public.

Nov 12, 2026 · **Building locally for Simon's try-out (Simon, 2026-11-12).** Nothing is pushed, no PR, until Simon has tried it. Simon's words: "I'd like to have the AI help setting up the project, etc, instead of doing it from a normal pop-up", "Only for new user, but accessible from settings. I think this should be used to create new projects", "Stay as a Ledung Helper, might be awesome if we could use that for quick help for things related to Ledung."

**Done when:** a brand-new Ledung opens on a Welcome screen and a Claude check, then hands over to the Ledung Helper, a chat that walks through the setup step by step (Ledung, not the AI, keeps the steps) to a first project with a workflow; afterwards the helper stays in the sidebar and in Settings, creates projects and changes projects' settings on request, always through the approvals that exist today; all of it works at 390 px.

## The shape

1. **Ordinary screens first** (no AI without Claude), only for a brand-new install: no projects, no sessions, setup never run.
   - **Welcome**: one screen, what Ledung is, one button.
   - **Claude check**: is Claude Code there, and signed in on this computer? If not, exactly what to do (the texts the banners already use) and **Check again**. This is the gate: the helper can't start before it passes.
2. **The Ledung Helper takes over**: a chat with Ledung's own helper session, with a **step bar** on top during setup: "Setting up · step N of M: <step>", and **Do it myself instead**, which opens the plain form for that step.
3. **Steps** (Ledung keeps them; a step is done when the thing really exists): your name · Claude accounts (optional) · first project (existing folder or a new one, with git, optionally a private GitHub repo) · its model, effort and permission mode · its sensitive list · its manager's grant · a workflow for it · shortcuts and start at sign-in · phone (optional) · the anonymous check-in notice · done. The last card says "Say hello to <project>'s manager" and opens that chat. Leaving and coming back continues at the first step not done.
4. **Afterwards** the helper stays: **✦ Ledung Helper** in the sidebar under Chats, Settings → Ledung → **Ledung Helper** (Ask the Ledung Helper, Run setup again, its model), and **New project** (a project heading's menu, the empty start page, Add project) opens the helper with "I want to create a new project", the plain form one link away.

## How it is built

### The helper session (core)

- A session of its own kind, like a chat: pseudo-project `~helper` (as `~chats`), role `session`, one conversation at a time (the newest not archived). It runs in its **own folder**, `<data folder>/helper`, not inside any project.
- **What it can reach.** Claude Code's built-in tools are cut to `Skill` and `ToolSearch` (the SDK's `tools` option): no Read, Bash, Edit, Grep, Web, Agent. No user MCP servers, plugins or user settings (a profile like `none`). So it can't read project files, secrets or other sessions; it has only Ledung's helper tools and two skills.
- **Its tools** (Ledung settings only; the helper gets none of a manager's session tools):
  - `setup_status`, `setup_step` (mark a step done or skipped; Ledung refuses "done" for a step whose thing doesn't exist), `set_user_name`.
  - `list_projects`, `add_project`, `create_project`: the managers' own tools, **always the person's approval** (unchanged), shown as the existing approval card **in the helper chat**.
  - `project_settings`, `set_project_settings`: the managers' own tools and hook: a change that loosens what reaches the person (grant, dev ship command, a sensitive pattern removed, usage) asks them with before and after; others run.
  - `set_project_basics`: model, manager's model, effort, permission mode, account, which a manager may not change. A looser permission mode (Plan < Ask < Accept edits < Auto) or another account asks the person; model and effort run.
  - `workflow_files` and `propose_workflow`: read a project's `.ledung/workflow` files (only those), and propose the project's workflow through **the same proposal and review path** as a manager's `flow_propose` (the person's review with before and after diagrams; Accepted saves it). A card in the helper chat opens the review.
  - `show_card`: inline cards in the helper chat (below).
  - **Locked projects are refused** by every tool that reads or changes a project (lockdown A or B): only the person changes those, in the page. Creating a project with lockdown on is allowed (tightening).
- **Knowledge**: a `ledung-help` skill (plugin `plugins/ledung-help`), built from the README and docs, so only its one-line description is in context; the helper also gets the existing `workflow-building` skill.
- **Model**: Sonnet by default, settable in Settings (kept in Ledung's data). Setup doesn't spend Opus.

### Cards in the helper chat

`show_card` records a card in the conversation; the page draws it; the person's choice goes back as an ordinary message from them (so it is their word, like typing it). Kinds: **choice** (buttons, e.g. model or mode with plain-word hints), **folder** (the existing folder browser), **text** (one field, e.g. the name), **step** (the existing page controls for shortcuts, the check-in notice, phone, accounts, which the person presses themselves), **link** (opens a page: a form, a Settings group). Confirmations for anything that creates or loosens something are **Ledung's existing approval cards**, which already show in the chat: nothing that needs the person's approval today skips it.

### Setup state

Kept in Ledung's data (`meta`), not the config: phase (welcome, claude, helper, done), the steps marked done or skipped, the setup's project and the helper session. A Ledung that already has projects or sessions never starts in setup. The current step is the first step not done; the page and the helper's prompt each turn both show it.

## Choices made, with reasons

1. **Workflow through the review path**, not written before the manager starts: the person sees and accepts the diagram as for any workflow change, and no new write path is added. The proposal and its review belong to the helper's conversation.
2. **The name is kept in Ledung's data**, not written into the config file: no API writes the config (config-watch.ts). A `userName` in the config still wins.
3. **Shortcuts, check-in, phone and accounts are the person's presses on cards**, not helper tools: shortcuts and check-in are page-only actions on this computer by design, opening Ledung to the network is a security setting no AI should change, and adding an account needs a sign-in in a browser. The helper explains and shows the control; the step is done when Ledung sees it done (shortcuts added or declined, notice seen) or the person skips it.
4. **One helper conversation**, which "Run setup again" continues; archiving it starts a fresh one next time.
5. **The helper is a chat, not a manager**: it starts no sessions, can't message managers or read other sessions, and has no board or Remote Control.

## Parts

1. **Core**: the helper session, its tools and hooks, setup state, name, model setting, help skill, tests. Security review.
2. **Page**: Welcome and Claude check, the helper view with step bar and cards, sidebar entry, Settings group, New project entries; 390 px. Security review.
3. **Try-out** on a throwaway Ledung (port 4394), screenshots, a preview for Simon on port 4393 with empty data, and a report.

## Every setting the helper can change (Simon's demo, 2026-11-12)

Simon: "The plan is that it should be able to help me with all settings if I ask it." The helper reads them all with `ledung_settings` and changes one with `change_ledung_setting`, through the same paths the page uses. Classes: **a** applies at once and loosens nothing (runs, and shows as a line in the chat); **b** loosens or opens something (Ledung's approval card with before → after, a risk note and a narrower choice where one makes sense; only the person's Allow applies it); **c** needs Restart Ledung (after saving, a card with **Restart Ledung**); **d** holds a secret (the helper never handles it: a link card to the right Settings field); **browser**: kept in the person's browser (a card whose button applies it in that browser). Project settings keep their own tools (`set_project_settings`, `set_project_basics`) and add `project.*` here.

| Setting | Where | Class |
|---|---|---|
| browseRoots | config (live) | b when it allows a folder not allowed before (risk: everything under it; narrower: a folder of its own); a when narrowing |
| projectsFolder | config (live) | b when outside the folders already allowed; else a |
| port | config | a, c |
| userName | config | not through the config tools: set_user_name keeps the letters-only rule |
| lan | config | b for any new place to listen, an address to another too (narrower: one address, not `true`), c |
| lanSignIn | config | b when switched off (anyone on that network uses Ledung), c |
| sensitive (global) | config (live) | b when a pattern is removed; a when added |
| keepToolResultsDays | config (live) | b when lowered (older output is shrunk at once); a when raised |
| idleStopMinutes, windowsShell | config (live) | a |
| claudeAccounts | config (live) | b for an added account or a changed sign-in folder, with the folder shown |
| pluginsOff | config (live) | b when a plugin comes back on; a when one goes off |
| profiles, defaultProfiles | config (live) | b (what sessions may use) |
| workflow, workflows | config (live) | b (what managers are told to follow) |
| remoteControl | config (live) | b when switched on |
| claudeExecutable | config (live) | b (another program runs the sessions) |
| chats | config (live) | b when it loosens (mode, a sensitive pattern removed, a folder outside the folders Ledung may use); else a |
| board | config | b (posts leave this computer), c |
| computers | config | b when any page that may frame Ledung is added (a public name, or a computer's local port), c |
| remote, relayJoin | config | d (relay secrets; Settings → Remote & devices) |
| projects | config | handled by the project tools |
| Working sessions limit | Machine panel (meta) | a |
| Usage stops | Settings → Claude & usage | a to set one; b to remove one |
| Macros | Settings → Macros | b on any change, each new or changed macro's name and text on the card |
| Skill defaults | Settings → Sessions | b on any change |
| Account choices (chats, the helper, new projects) | Settings → Accounts | b when an account changes |
| Chats' colour, the helper's model | Settings | a |
| Chats' sensitive list | Settings → Chats | b on removal; a on adding |
| Update channel | Settings → About | b to Dev; a to Public |
| Usage count (check-in) | Settings → About | b to switch on; a to switch off |
| Publish usage | Settings → Claude & usage | b (the managers' usage_publish rule) |
| Relay address | Settings → Remote & devices | b |
| Relay admin key, Cloudflare token, join code, link codes, invites, phones and passkeys, account sign-in | Settings | d |
| Shortcuts, start at sign-in | Settings → Update & restart (this computer's page) | browser card (the person's press, on this computer) |
| Appearance, autocorrect, status dot, Archived link, compact sidebar | Settings → Look & feel (this browser) | browser card |
| Notifications, Install as app | Settings (this browser) | link card (the browser asks the person itself) |
| project.extraFolders | project → General | b when a folder is added |
| project.projectToolsUnasked, project.projectSettingsTools | project → Manager's powers | b when switched on |
| project.lockdown | project → Manager's powers | a to tighten; loosening is refused (only the person, in the page) |
| project.worktreeSetup | project → Workflow | b when new or changed |
| project.followFlow | project → Workflow | b when switched off; a when on |
| project.name (rename) | project | a |

Nothing bypasses the page's own checks: the config file is written by Ledung's config writer (`src/config-write.ts`: the file's own keys, `$comment`s and unknown keys kept, validated with the same schema before an atomic write, then read back by the watcher); everything else calls the manager methods the page's routes call. When in doubt, a setting is class b (code review round 3). Values shown to the helper or on a card have an MCP server's `env` and `headers`, the values after key, token or secret flags in its `args`, and its `url`'s query masked; a change of a masked value alone is said as such. The helper can't loosen lockdown, can't handle secrets, and can't change who may answer its cards (devices, passkeys, sign-in links are class d).
