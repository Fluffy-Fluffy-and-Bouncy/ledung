---
name: ledung-help
description: How Ledung works and where things are in its page (projects, managers, sessions, chats, accounts, approvals, the sensitive list, grants, workflows, phone access, shortcuts, updates, the check-in). Use before answering any "how do I", "where is" or "what is" question about Ledung, and before explaining a setup step.
---

# Ledung, for the Ledung Helper

Built from Ledung's README and docs. Answer in plain words, short, and say where in the page a thing is (**Settings → group → setting**). If this guide doesn't cover something, say you are not sure rather than guessing.

## What Ledung is

Ledung runs several Claude Code sessions on the person's own computer and shows them in one web page: the sessions and who started them, every question waiting for an answer, permission requests, usage and machine load. It runs the person's own installed Claude Code, signed in with their own Claude account. The page can be installed as an app window, and reached from a phone (below).

## The page

- **Sidebar** (left): **Chats** first, then one group per project: its **manager** and the sessions under it. **✦ Ledung Helper** sits under Chats. A project heading's menu (right-click, or press and hold on a phone) has New session, Account, Model, Open workflow, Settings and more. **Waiting for you** at the top lists every open question and permission request.
- **Settings** is the ⚙ at the bottom left. Tabs along the top: **Ledung**, **Chats**, one per project, **Add project**. Each tab has groups in a side menu; search finds any setting by name.
  - Ledung tab: **Update & restart** (Update Ledung, Restart Ledung, Stop Ledung, Shortcuts, Start at sign-in, Log) · **Claude & usage** (Accounts, Usage stops, Claude Code, Publish usage) · **Sessions** (Skills, Session profiles) · **Macros** · **Remote & devices** (Computers, Remote access, Phones, Linked computers, Relay, Message board) · **Look & feel** (Appearance, App) · **Notifications** · **Ledung Helper** · **Config file** · **About** (version, Update channel, Usage count).
  - A project's tab: **General** (name, Claude account, model, model for its manager, permissions for new sessions, extra folders) · **What always goes to you** (its sensitive list) · **Manager's powers** (grant, project tools, dev ship command, lockdown) · **Skills & profiles** · **Look** · **Workflow** (drawn workflow) · **Tickets & questions**.
- A session's page: its conversation, a message box, the session menu (model, effort, permission mode, stop, archive). **Archive** takes a finished session out of the sidebar; nothing is deleted. Idle sessions stop on their own and come back when written to.

## Projects and managers

- A **project** is a folder (on this computer, or in a running Docker container) with **one manager**: a Claude Code session the person talks to. The manager starts **sessions** under it to do the work, follows them, and asks the person when something needs a decision.
- **Add a project**: Settings → **Add project**: an existing folder (picked with Ledung's folder browser, inside the folders Ledung may use, by default the home folder) or a **new project**: a new folder with git in the projects folder (default `Projects` in the home folder), optionally with a **private GitHub repository** (needs the GitHub CLI `gh` signed in). The Ledung Helper can do the same; either way the person approves it in Ledung first.
- Each project has: a **Claude account**, a default **model** (and one for its manager), an **effort**, a **permission mode** for new sessions, a **sensitive list**, its manager's **grant**, and optionally a **workflow**.
- **Chats**: sessions of the person's own with no project, manager or workflow (sidebar → Chats → New chat).

## Models, effort and permission modes, in plain words

- **Models**: **Opus** thinks deepest and costs most of the plan's usage; **Sonnet** is a strong everyday choice; **Haiku** is quick and light, good for simple work. A project's sessions use its model unless the manager picks another per session.
- **Effort**: how much reasoning a session puts into each reply (low, medium, high, xhigh, max); left out, Claude Code's own default. Higher is slower and uses more.
- **Permission modes** for new sessions: **Ask** (every action that needs permission asks), **Accept edits** (file edits go through, commands still ask), **Auto** (routine actions are approved automatically, the rest asks), **Plan** (read-only: plans, changes nothing). Whatever the mode, the **sensitive list** always reaches the person.

## What reaches the person: approvals, the sensitive list and grants

- **Permission requests** from a session go to its manager, which decides within its **grant**, or to the person. A **sensitive** request always reaches the person, in every mode and under any grant.
- **The sensitive list** (project tab → What always goes to you): command patterns, file path patterns and MCP tools that always ask the person first. A new project starts with **Ledung's suggestions** (things like pushing to git, publishing, deleting, production and secret files). Taking a pattern out loosens what reaches the person, so only the person can do it (the helper's change of it waits for the person's approval card).
- **The manager's grant** (project tab → Manager's powers → What the manager may decide for you): plain words saying what the manager may answer or allow in the person's place, e.g. "merge PRs that passed review and checks", "approve test runs". Empty: the manager asks about everything. Some limits no grant lifts: nothing that can reach production, customers or personal data.
- **Questions** come through **Waiting for you**, grouped by tier, with a page per question; answers go back to the session.
- **Away mode** (the manager's header): while the person is away, a few kinds of action (a merge of a passing PR, the dev ship command) may go through; everything else waits.
- **Lockdown** (project tab → Manager's powers): **A** walls a project off from other projects' managers and the Ledung Helper; **B** also closes its way out (no network, not on Windows). Only the person turns it down again, in the page. The Ledung Helper can't read or change a locked project.

## Workflows

- A project's **workflow** is its process drawn as blocks and arrows (Build, Code review, Fix, the person's review, Merge), saved in the project as `.ledung/workflow/` and shown on its **workflow page** (sidebar → the project's Workflow row, or the project tab → Workflow → Drawn workflow). The manager follows it: Ledung tells it the flow and tracks each piece of work through it.
- A workflow is changed only by the person: in the builder on the workflow page, or by **accepting a review** of a proposed change (before and after diagrams); **Changes needed** sends it back.
- A good first workflow is small: the manager takes the task in, a session builds it, another reviews, the person checks the result.

## Claude accounts

- An **account** is a Claude sign-in (Settings → Claude & usage → **Accounts**). The computer's own Claude Code login is the default and is enough to start. Add accounts to run some projects on another subscription; each is signed in once with the command the page shows (Claude Code's own `/login`, or a long-lived token). Ledung never sees a sign-in token. A project runs on one account (project tab → General → Claude account).
- **Usage stops** hold new work when a plan window gets this full.

## Phone and other computers

- **On the home network**: `"lan"` in the config file set to the computer's address; by default other devices sign in once with a link. **From anywhere**: a **relay** (Settings → Remote & devices → Remote access → Join with a code, then **Phones** to pair the phone and switch on push notifications). Opening Ledung to a network is the person's own setting; the helper explains it but never changes it.
- The page works on a phone; **Install as app** (Look & feel → App) where the browser allows it.

## Shortcuts, starting with the computer, updating

- **Shortcuts** (Update & restart → Shortcuts): a Ledung icon on the Desktop and in the Start menu (Applications on macOS); it opens the page and starts Ledung if needed. **Start at sign-in** starts Ledung in the background when the person signs in. Both are made only from a page on the computer Ledung runs on.
- **Update Ledung** (Update & restart) gets a newer version and restarts; **Restart Ledung** starts it again. Sessions keep running through a restart.

## The anonymous check-in

Once a day an npm-installed Ledung sends only a random install ID, its version, its update channel and the operating system, to count users. Nothing about the person, projects or sessions. It is announced by a notice and nothing is sent until the notice is answered; **Turn off** there, or Settings → About → **Usage count**, stops it (or `DO_NOT_TRACK=1`).

## The config file

`ledung.config.json` in Ledung's data folder (Settings → **Config file** shows where and any problem). Most people need nothing in it at first: projects and accounts are added in the page. It holds the port, network access (`lan`), the folders Ledung may browse (`browseRoots`), where new projects go (`projectsFolder`), profiles and similar. Most changes apply at once; a few need Restart Ledung.

## What the Ledung Helper can and can't do

It can add and create projects and change their settings (model, effort, permission mode, account, sensitive list, grant, workflow settings), propose a first workflow for the person's review, set the person's name, and show cards for choices, folders, shortcuts, the check-in and phones. Everything that creates a project or loosens what reaches the person waits for the person's approval card. It can't read project files, secrets, or other sessions and chats, can't start sessions, and never touches a locked project.
