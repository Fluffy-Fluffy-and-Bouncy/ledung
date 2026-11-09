# A workflow copy's origin and version — proposal

Nov 9, 2026 · **Proposal, not approved.** Docs only; nothing is built until Simon says so.

**Done when:** a project that splits off its own copy of a shared workflow records where it came from (which workflow, which version, whose), without a path on one computer. The copy shows "based on Team process v3 by Ana" on the workflow page, in the builder and in the Workflow pane. When the original on this computer has changed since, the page says so. A copy of that copy still names Ana.

## Why

Simon decided on 2026-11-05 that per-project workflows are **copies, not overrides**: "I want an origin and version of the original workflow, so you can check for updates." On 2026-11-06 (question #1680, "a") he decided that a copy shows **"based on <workflow> v<N> by <author>"** next to its own author, and that the credit carries through further copies. It is text only, and nothing is enforced. On 2026-11-09 he said: "Origin and version first, then we look into sharing."

Today a split-off (#110) copies the files and forgets where they came from. The copy keeps the original's `author` line (#117) as if it were its own. Back to shared and the "differs from shared" notice work only while the project still follows that workflow in the config.

## 1. What a version is

| Option | For | Against |
|---|---|---|
| A number the author raises, a new `"release": 3` (`version` is already the format's version) | People can read it and say it ("v3"). It is the author's statement that "this is a release". | It is forgotten. Two different contents can both be "v3". |
| A hash of the workflow's files | Ledung computes it and it never lies. It needs no git and works in a container, a zip or a copied folder. | People can't read it. It changes with any edit, even an unreleased one. |
| The git commit of the shared folder | It is exact and points at history. | A folder may not be a git repository. Uncommitted edits aren't in the commit. The commit changes when unrelated files change. Other computers may not have it. |
| **Both: `release` for people, a hash for Ledung** | Each does what it is good at. | Two things to explain. |

**Recommendation: both.**

- **`release`** is optional, a whole number of 1 or more, in the default flow's `flow.json` (one per workflow folder). The author raises it by hand when they publish a change. The builder shows it, and edits it where it can save.
- **The hash** is computed by Ledung and is never written in the original. It covers every file the workflow is made of:
  - every flow,
  - the rules,
  - the manager's file,
  - the briefs and overlays,
  - any `folder:` briefs (#111).

  Before hashing, Ledung normalises the files the way the "differs" check already does: JSON with its keys sorted, CRLF read as LF. The `origin` block is left out, so recording an origin doesn't change the hash. It is shown as 12 hex characters, e.g. `sha256:1a2b3c4d5e6f`.
- **Without a `release`**, the line reads "based on Team process, copied 2026-11-09, by Ana", with the hash in the tooltip.
- **Git is not used for the version.** Sharing may later use it to fetch a base (section 7).

## 2. What a copy records

At split-off (the first Save of a shared flow, #110), Ledung writes an `origin` block into the copy's default `flow.json`. Ledung writes it, and nobody else does:

```json
"origin": {
  "workflow": "team-process",
  "title": "Team process",
  "repo": "https://github.com/example/team-process",
  "release": 3,
  "hash": "sha256:1a2b3c4d5e6f",
  "author": "Ana (ana-gh)",
  "copiedAt": "2026-11-09",
  "earlier": [
    { "title": "Review loop", "release": 7, "hash": "sha256:9f8e7d6c5b4a", "author": "Bo (bo-gh)" }
  ]
}
```

| Field | What | Required |
|---|---|---|
| `workflow` | The shared workflow's name in Ledung's config when it was copied. | yes |
| `title` | The original default flow's title. | yes |
| `repo` | The shared folder's git remote, if there is one: https or `git@host:` form, with any user, password, token or query taken out. | no |
| `release` | The original's `release`, if it had one. | no |
| `hash` | The original's hash at the moment of copying. | yes (except when adopted, section 4) |
| `author` | The original's `author` line, if it had one. | no |
| `copiedAt` | The date, with no time. | yes |
| `earlier` | The credit chain, oldest first: `{ title, release?, hash?, author? }` for each copy further back. At most 10; past that, the first entry and the latest nine are kept. | no |

The copy also changes in two ways at split-off:

- **The original's `author` and `release` leave the copy's top level and move into `origin`.** The copy is not Ana's work, and it is not her v3. Its own `author` starts empty, and the builder offers it. Its `release` starts unset.
- **Credit chains.** When the original has an `origin` of its own (it is itself a copy that someone shares), the new `earlier` is the original's `earlier` followed by its `origin` without `earlier`. The first author is therefore always `earlier[0]`, or `origin` itself when there is no `earlier`.

The "differs from shared" check (#110) leaves out `origin`, `author` and `release`. Without that, every copy would differ the moment it was made.

## 3. What is shown

- **The workflow page**, under the title and the copy's own author: "Based on **Team process** v3 by Ana (ana-gh)". When the first author is someone else, it adds "· first by Bo (bo-gh)". The tooltip gives the hash, the copied-at date and the repo.
- **The builder:** the same line in the header, read-only. Beside the author field there is a **Release** field.
- **The Workflow pane:** one short line, "based on Team process v3", with the rest in the tooltip, because the pane is narrow and on phones.
- **"The original has changed since": recommended now.** Ledung looks for the original among this computer's configured workflows, first by `repo` and then by the `workflow` name. If it finds it and can read it, it compares the current hash with `origin.hash`. When they differ, the page shows a quiet notice: "Team process has changed since this copy (now v4)". The notice links to the original's workflow page.
  - The notice is not a warning and does not count as a problem.
  - Managers and sessions are not told.
  - Nothing is offered to update, because updates come with sharing.
  - This is cheap: the reading and comparing already exist for #110.
  - When the original isn't on this computer, nothing is shown, and it is not an error.

## 4. Copies with no origin

A copy made before this change keeps working and shows no "based on" line. **A one-time "Record where this came from" is recommended**, offered on the workflow page only when the project still follows a shared workflow in the config:

- **If the copy is still the same as the original** (the #110 check finds no difference), the full origin is recorded, hash included.
- **If it differs,** the version that was copied can't be known. Ledung records `workflow`, `title`, `repo` and `author`, with no `release` or `hash`, plus `"adopted": "2026-11-09"` instead of `copiedAt`. The line then reads "based on Team process by Ana", and no "has changed since" notice is shown for that copy.
- Recording it is a save through the builder's save path. It is version-checked and shows as a git diff, and it moves `author` and `release` as section 2 says. The offer can be dismissed (stored per project in Ledung's database) and is not shown again.

## 5. flow_propose and the skill

**A proposal can't change `origin`.** When a proposed `flow.json` leaves `origin` out or changes it, Ledung puts the recorded one back. The review page then says "origin kept as recorded" whenever this happened. A proposal can change `release` and `author`, because those are the copy's own.

The "workflow building" skill gets one line: "Never write or change `origin`; Ledung keeps it."

`flow_propose` keeps refusing on a project with no copy of its own (the person splits off in the builder). If that refusal is lifted later, Ledung, not the manager, writes the origin at Accept.

## 6. Security and hygiene

- **No paths:** the origin names a workflow by its config name and, optionally, a git remote. The folder is never recorded. The existing scan for paths on one computer (#117) also covers every `origin` field, so a hand edit that adds one is a problem.
- **Portability:** on another computer, the original is found by `repo` (stable across computers) or else by the config name. Finding nothing is fine.
- **The remote may be private:** writing a private repository's URL into a project that is public reveals its name. The #110 confirm before the first Save therefore shows exactly what will be recorded ("This copy will record: based on Team process v3 by Ana, from github.com/example/team-process"). It has a **Leave the repository out** tick box.
- **Ledung never contacts the network** for any of this. The remote is read from the folder's own git config.
- **Credentials:** a remote with a user, password or token in it is stripped, and Ledung tests that it is.

## 7. What it leaves for sharing

- Fetching a workflow from a repository or a list of workflows, without a local folder.
- Offering an update to a copy as a proposal (Simon, 2026-11-05). This needs the base it was copied from: from git at the recorded hash, or from a snapshot kept at split-off.
- Showing what changed in the original since the copy (a diff), and a changelog per `release`.
- Taking part of an update and leaving the rest.
- An identity for a workflow that holds across computers and renames, beyond `repo`, and any proof of who published it (today's credit is text only).
- Telling a manager that its copy's original has moved on.
- Licences and terms for shared workflows.

## 8. Parts

| Part | What | Done when |
|---|---|---|
| a | Format: `release` and `origin` in `flow.json`, checked (shape, paths, the size of `earlier`); the workflow hash in `src/shared`; the "differs" check leaving out `origin`, `author` and `release`. | Tests: the hash is the same for re-indented or CRLF files and changes for a changed brief; an origin with a path is a problem; a copy with only an origin is not "different". |
| b | Split-off records the origin, chain included; the #110 confirm shows it, with "Leave the repository out"; credentials stripped. | On a throwaway project following a throwaway shared workflow (a git repository with a remote), a split-off writes the origin and no path. That copy, set up as a shared workflow and copied again, names the first author. |
| c | Shown on the workflow page, in the builder (with the Release field) and in the Workflow pane, plus the "has changed since" notice. | Dark screenshots at 1280 and 390 px: a copy with a release, one without, a copy of a copy, and the notice after the original's brief changes. |
| d | "Record where this came from" for older copies; `flow_propose` keeps the origin; the skill line. | An older copy is offered it once, both the same and the differing case. A proposal that drops `origin` gets it put back, and the review says so. |

## Decisions for Simon

1. **Version:** an optional `release` number for people, plus a hash Ledung computes. *Recommended.* The alternatives are a number only, a hash only, or git commits.
2. **The origin block** as in section 2, with the original's `author` and `release` moving out of the copy's top level. *Recommended.*
3. **"The original has changed since"** shown already, as a quiet notice on the page only. *Recommended.* The alternative is to wait for sharing.
4. **"Record where this came from"** offered once to older copies. *Recommended.* The alternative is to leave them without an origin.
5. **A proposal can't change the origin**, and Ledung puts it back. *Recommended.*
6. **The git remote recorded by default**, with a tick box to leave it out. *Recommended.* The alternative is never recording it, and finding the original by its config name only.
