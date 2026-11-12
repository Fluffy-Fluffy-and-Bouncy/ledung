# Ledung Helper and an AI first start — design

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
