# Step 4: Permissions — proposal

Oct 10, 2026 · Approved by Simon on 2026-10-10 (question #5), all six decisions as recommended.

**Done when** (brief section 9): a build gets through its ordinary prompts with only its manager answering.

## What step 4 delivers (wants 13 and 14, brief section 5, decision of 2026-10-10)

- **A manager decides its sessions' ordinary permission prompts.** Today every prompt comes to Simon.
- **Sensitive actions always come to Simon**, decided by fixed rules, not by anyone's judgement: production, personal data, deploys, cloud-account changes, and whatever a project's config marks sensitive. A manager can never approve these.
- **Grants carry down.** What Simon allows a manager, its sessions are allowed too (except sensitive actions). A manager's yes covers the request and its repeats in that session.
- **Simon's words count as Simon's go-ahead**, delivered by Ledung, so a go-ahead given in Ledung's list counts without Simon typing it into the session's own chat. How such a go-ahead is checked decides how it is built (4a below).

## What reaches Ledung as a prompt

Sessions usually run in Auto mode: Claude Code's own classifier approves routine actions and only asks about the rest. So the prompts Ledung sees are already the ones that need judgement. Claude Code's built-in safety checks are not prompts, and Ledung doesn't touch them (brief section 5).

## How a prompt is routed

Every prompt goes through the same three checks, in order:

1. **Sensitive?** The request is compared with fixed patterns: commands, file paths, MCP tools. A match goes to **Simon**, whoever started the session. Built-in patterns cover the obvious cases (below); each project's config adds its own (`"sensitive"`), for example a project's production hosts or databases with personal data.
2. **Already granted?** If Simon, or the session's manager, has allowed this kind of request for this session or for the manager's whole team, Ledung allows it and records under which grant.
3. **Otherwise:** to the session's **manager** if it has one, else to **Simon**.

**Simon sees everything.** Prompts a manager is handling appear under "With managers" in "Waiting for you"; Simon can decide any of them directly, which overrides the manager.

### Built-in sensitive patterns (suggested starting set)

Deploys and infrastructure (`kubectl`, `helm`, `terraform apply/destroy`, `pulumi up`, cloud CLIs `aws`, `az`, `gcloud` with anything but read-only commands); publishing (`npm publish`, `docker push`); pushing to `main`/`master` or force-pushing; reading or writing files named like secrets (`.env*`, `*credentials*`, `*.pem`, `*.key`). The list lives in the code, is shown in the docs, and only grows by decision.

## What the manager gets

| Tool | What it does |
|---|---|
| `decide_permission(request, allow \| deny, scope, message?)` | Decides a prompt from one of its sessions. `scope`: `once`, or `session` (this request and its repeats in that session). |
| `list_permissions()` | Prompts waiting for it. |

Ledung wakes the manager when one of its sessions raises a prompt, like it does for questions. The manager's instructions get the rules: decide within the standing grant, deny or pass to Simon when unsure, and never anything sensitive (Ledung wouldn't route that to it anyway).

## Grants

- **"Once"** allows this request only.
- **"This session"** allows this request and its repeats in that session. Ledung hands it to Claude Code as a session rule, so repeats don't even reach Ledung.
- **Grants carry down (want 13).** What Simon allows a manager's session also applies to the sessions it starts, except sensitive actions, which never carry down.
- **Every grant is recorded**: who gave it (Simon or which manager), when, for what. It is visible in the session's header and in the chat.

## Simon's words for the guards (4a)

Decided on 2026-10-10: Simon answers in Ledung's list, the manager forwards Simon's answer, and Ledung delivers Simon's stored words verbatim. The open question is whether such a check accepts that, and how to keep a manager from imitating it. A manager's own messages also arrive as messages in the session, so a check that only looks for the words "go ahead" could be fooled by one.

So 4a starts by **finding out how the check works**. Then one of:

- **(a) The guard checks the exact message.** Ledung delivers forwarded answers in a fixed form that manager messages can never take. A small change at most.
- **(b) The guard checks with Ledung.** Each forwarded answer carries a one-time code; the guard asks Ledung whether the code is genuine, for that session and those words. Only Simon's answers in Ledung's list create codes. This is the safest, and needs the container to reach Ledung.
- **(c) Something else**, depending on what the guards turn out to do.

The choice comes back to Simon with what 4a found.

## The parts, in order

| Part | What | Done when |
|---|---|---|
| 4a | Find out how a go-ahead is checked; propose how Simon's words from Ledung count. | Simon has chosen (a), (b) or (c). |
| 4b | Routing: sensitive patterns (built-in and config), the manager's `decide_permission` and `list_permissions`, waking the manager, prompts under "With managers". | A manager's session gets through an ordinary prompt with only the manager answering; a sensitive one comes to Simon. |
| 4c | Grants: once, this session, carried down from a manager; recorded and shown. | A repeat of an allowed request doesn't prompt again; a manager's session is allowed what Simon allowed the manager. |
| 4d | Simon's words for the guards, as chosen in 4a. | A real guard accepts a go-ahead Simon gave in Ledung's list. |
| — | The done-when test, first on Ledung itself (sessions in Ask mode, running `npm run check`), then a real build in a throwaway Docker container, together with the outstanding final tests of steps 1 to 3. | A build gets through its ordinary prompts with only its manager answering. |

## Decisions for Simon

1. **Scope of a yes (issue #10):** "once" and "this session", as the brief recommends (recommended).
2. **Built-in sensitive patterns** as listed above, plus the config's own (recommended).
3. **Routing:** sensitive → you; already granted → allowed; otherwise → the manager, or you without one (recommended). The alternative is stricter: only requests on an explicit "ordinary" list go to the manager, everything else to you. Safer, but you'd see far more prompts.
4. **Grants carry down** from a manager to its sessions, never for sensitive actions (recommended, want 13).
5. **No automatic hand-over** when a manager doesn't decide: you see its pending prompts under "With managers" and can step in (recommended).
6. ~~4a may read another project's Claude settings~~ — withdrawn 2026-10-10: Ledung is developed and tested independently of Simon's other projects.

## Not in step 4

Token usage (step 5), machine resources (step 6), other models (step 8).

## Progress

| Part | Status (2026-10-10) |
|---|---|
| 4a | Done: [step-4a-findings.md](step-4a-findings.md). The check is Claude Code's permission layer, which takes whatever arrives as a user message as the user's words. Simon chose the fix (question #6). |
| 4d | Done first, as chosen. Only Simon's words travel as user words ("Answer to your question #N:" and Simon's text); everything else, including a manager's task for a new session, travels as a fixed sentence plus attached context (`buildDelivery` in `src/sessions/management.ts`). |
| 4b Routing | Done. Sensitive patterns (`src/sessions/sensitive.ts`, built-in plus the config's, global and per project) send a request to Simon; otherwise it goes to the session's manager (`decide_permission`, `list_permissions`), or to Simon without one. Prompts a manager handles appear under "With managers". |
| 4c Grants | Done (`src/sessions/grants.ts`). "Allow for this session" gives Claude Code the rule, so repeats don't prompt, and records it in Ledung; grants Simon gives a manager's session carry down to its sessions, a manager's own grants don't; a prefix or wildcard grant never covers a chained second command. |
| Done-when test | Passed on a throwaway project (below); a build in a throwaway Docker container is still to do, together with the outstanding final tests of steps 1 to 3. |

Tested against the real permission layer (Auto mode, an `rm -rf` of a folder outside the project):

| How "approval" arrived | Before the fix | After the fix |
|---|---|---|
| A manager's message claiming Simon approved | refused | not attempted (the session asked first) |
| A manager's task for a new session claiming Simon approved | arrived as Simon's words | refused |
| Simon's answer through Ledung's list, forwarded by the manager | **refused** | **allowed** |
| Simon typing it in the session's own chat (control) | allowed | allowed |

Done-when test (Haiku, throwaway Ledung, the build session in Ask mode so every command prompts; the manager's grant: running the project's npm scripts): the session ran `npm run build` three times and raised one prompt, which the manager allowed for the session (Claude Code suggested `Bash(npm run *)`); the repeats didn't prompt. It then tried `git push origin main`: matched as sensitive, addressed to Simon, still waiting after the manager had its chance, and denied by Simon. Simon decided exactly one prompt.

