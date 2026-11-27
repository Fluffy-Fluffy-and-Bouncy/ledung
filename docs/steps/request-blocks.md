# One request page built from blocks

Nov 23, 2026 · Approved (Simon, 2026-11-23, #2262: "a — Approve, with all the recommended choices"); D7 means "Ask about this" (part E) is not in this round. Built in PR for issue #502: parts A–D; the old pages stay until Simon approves the preset screenshots (D2). D2 settled 2026-11-24: every question opens on the request page, and each decision is drawn as the question desk's options (docs/decisions.md).

**Done when:** a manager can send Simon one request that holds context, screenshots to judge, evidence files, two or more decisions and a sign-off; Waiting for you shows it as one entry ("3 to answer") that opens on one page; Simon answers it on the PC or the phone, a part at a time, and sends it once; the asker gets one readable message; and every question, review and screenshot question asked today, old or new, still opens and answers as it does now.

## Why

Simon, 2026-11-23: "We have a screenshot view screen, a question screen, and a review screen. But they all work slightly different, and that's limiting. What if I want to view screenshots and multiple questions? That's not currently possible."

Today `ask_user` makes one of three things, each with its own fields, page and answer:

| Today | Fields | Page | Answer the asker gets |
|---|---|---|---|
| Question | `question`, `issue`, `evidence`, `options`, `opinions` | the question desk | `a — Merge as one PR`, or typed text |
| Review | `title`, `review` (solving, done, notes, evidence files) | the review page | `Accepted.` (+ note) or `Changes needed: …` |
| Screenshot question | the question's fields + `screenshots` | the screenshot view | `Screenshot verdicts: Pass 3 · Fail 1` + one line per shot |

`ask_user` refuses to mix them (a review takes no options, opinions or screenshots; a run's step takes no screenshots). So "a review with screenshots plus two follow-up questions" today is three separate entries, answered on three pages, arriving as three messages.

**An earlier decision this touches.** On 2026-10-16 Simon chose "a dedicated review type rather than a generic question page" and "one overall verdict" for reviews (docs/steps/pr-review.md). The reason then was that the screenshot view hid the context. This design keeps both points: a review still has its fixed sections and one Accepted / Changes needed, and the context is always on top. What changes is that the review becomes one *preset* of the general page, and can carry more parts when the asker needs them.

## What it does

One **request** page, built from **blocks** in a fixed order. A request is still a question in Ledung's records (same number, same tiers, same Waiting for you, same withdraw); only its contents grow.

| Block | What it holds | Answered? | Today's source |
|---|---|---|---|
| **Context** (always) | Title, who asks, refs, the run it belongs to; the issue text, or a review's *What we were solving* / *What was done* / *Notes*; attached sources (folded) | no | `title`, `question`, `issue`, `review.solving/done/notes`, `sources`, `refs` |
| **Evidence** | What was checked (text, folded); files without a verdict (screenshots, logs); screenshots to judge, each Pass / Fail / Unsure + note | per judged shot | `evidence`, `review.evidence`, `screenshots` |
| **Decisions** | One or more questions, each with its own title, short issue, options with cost, and opinions (the manager's and reviewers' views) | yes, each | `options` + `opinions` (one), new `decisions` (several) |
| **Sign-off** | Accepted / Changes needed + note | yes | `review` |
| **Ask about this** (optional, see D7) | A read-only side chat forked from the asking session | no | new |

Opinions are not a block of their own: an opinion is about a choice, so it sits inside the decision it picks for (as today on the desk, with the split border). Opinions on the whole request (for a sign-off) go in the Sign-off block, above its buttons.

**Today's three become presets** — the same blocks, so they look and answer exactly as they do now:

| Preset | Blocks |
|---|---|
| Question | Context + one Decision (+ Evidence text) |
| Review | Context (solving/done/notes) + Evidence files + Sign-off |
| Screenshot question | Context + Evidence with judged shots (+ one Decision if it had options) |

### 1. The `ask_user` shape (backward compatible)

Every field `ask_user` takes today keeps its meaning. Two fields are added and the "can't mix" rules are loosened:

- **`decisions`**: a list of 2–6 decisions, each `{ key, title, issue?, options, opinions? }`; `options` as today's objects (key, text, cost; `outcome` at a run step). Keys are short (`d1`, `layout`). With `decisions`, the top-level `options`, `opinions`, `recommended`, `why` and `reviewer` are refused (they belong inside a decision); `title`, `issue`, `evidence` stay as the request's context and evidence.
- **`sign_off`**: `true` asks for Accepted / Changes needed without the review's sections. `review` implies it, as today.
- **Mixing allowed:** `review` may now come with `screenshots` and `decisions`; `screenshots` may come with `decisions`; a run step may carry `screenshots` and extra decisions (see 3).
- **Still alone:** Ledung's own questions (a refused call, an order, `about_request`, `order_command`, a workflow proposal) stay single-purpose. They carry permissions, and mixing them into a larger page would make it too easy to allow something while answering something else.
- **Limits:** at most 6 decisions, 8 options each (as today), 40 files in all (shots plus evidence files; 10 evidence files as today).

Ledung stores what was given in the question's details, as now (new keys `decisions`, `signOff`). One shared function turns *any* stored question — today's or older — into its list of blocks, and the page, the chat card, the #350 line, `waiting_for_you` and the answer all read from that. No database change is needed to ask; one is needed to answer (below).

The tool's description gets one sentence about combining parts; the detail goes into the field descriptions, so the description stays within Claude Code's limit (issue #32).

### 2. The answer, and how it reaches the asker

The page sends the **whole request at once**: each decision's pick (or typed answer), each shot's verdict and note, the sign-off and its note, and one closing note to the asker. Ledung keeps it twice:

- **`answer`** (text, as today): what the asker reads, one message.
- **`answerParts`** (new column, a new entry in `MIGRATIONS`): the same as data, so a run, the #350 line and `waiting_for_you` read it without parsing text.

**A preset's answer text is exactly today's** (`a — Merge as one PR`; `Accepted.` + note; `Screenshot verdicts: …`), so every asker, manager and workflow that reads answers today keeps working. Only a request with more than one answered part gets the new form:

```
Answer to request #2104 "Request page: layout and next steps" (4 parts)

Sign-off: Changes needed: the phone view hides Send under the keyboard.
Decision layout — Which layout?: a — Stacked blocks with a summary rail
Decision side-chat — Ask about this: b — Later, as its own part
Screenshot verdicts: Pass 2 · Fail 1
- Request page · shots/1280.png: Pass
- Request page · shots/390.png: Fail — Send hidden under the keyboard
- Request page · shots/390-folded.png: Pass

Simon's note: good direction; fix the phone view first.
```

Order: sign-off first (it is the overall verdict), then decisions in the asked order, then shots, then the note. Every line comes from fields on one line each, so a title or a file name can't add lines Simon never gave (as `shotAnswer` does today). The line starts `Answer to request #N` only for multi-part answers; a preset starts as today.

### 3. Run person steps

A run's person step needs one word to move the run. Rule: **exactly one block moves the run**, and the step says which:

- A step with `ask: review` → the **Sign-off** moves it (Accepted / Changes needed, mapped to the block's outcomes as today).
- A step with `ask: question` → the **one decision whose options carry outcomes** moves it. The write-up check (`writeUp`) refuses a request with none, or with two decisions carrying outcomes.

Everything else on the page — other decisions, shot verdicts — is information for the coordinator: it reaches it in the run's note with the answer, as the whole answer text. A Fail on a shot never moves a run by itself; the coordinator reads it.

The run's move reads the moving block's pick from `answerParts`, not from the text, so a long answer can't be misread. Old answers (no `answerParts`) are read from the text as now.

**The fallback card** (Ledung's own card, at once or after the write-up time) stays as it is: a one-block preset (a question with the outcome words as options, or a review). It has no write-up, so it has nothing to combine.

### 4. Waiting for you

- **One entry per request**, in the same queue, same tiers, same rank and age order. A request has one tier and one rank, as a question does today; the number of parts doesn't change its place.
- **Chips:** today's "Review" and "N screenshots" stay; a request with more than one answerable part adds **"3 to answer"** (decisions + sign-off still unanswered in Simon's draft; judged shots are counted on the screenshot chip, "2 of 5 judged").
- **The sidebar count, notifications and phone push count requests**, one per page, as they count questions today (`waitingCount`). Three decisions on one page are one thing waiting, not three (D5).
- **The excerpt** is the issue's first line, or *What we were solving* for a review, as now.

### 5. The page, at 1280 and 390 px

One column of blocks, top to bottom. Answered parts **fold** to one line with what was picked and a Change link, so what is left to do stays in view. A summary shows what is still open and holds Send.

**1280 px** — blocks on the left (up to about 820 px wide, as the desk is today), a narrow summary rail on the right that stays in view while scrolling:

```
┌ Waiting for you ─────────────────────────────────────────────────────────────────────────────┐
│ ‹ 2 of 5 ›   Request #2104 · Project Ledung · Manager: Project Ledung · #502 · run-109          │
│ Request page: layout and next steps                    [Review] [3 to answer] [3 screenshots] │
├──────────────────────────────────────────────────────────────────┬───────────────────────────┤
│ CONTEXT                                                          │ YOUR ANSWER               │
│ What we were solving                                             │ ✓ Screenshots 3 of 3      │
│   Three pages that can't be combined …                           │ ✓ Layout: a               │
│ What was done                                                    │ ○ Ask about this          │
│   One page built from blocks …                                   │ ○ Sign-off                │
│ ▸ Sources (2)   ▸ Notes                                          │                           │
├──────────────────────────────────────────────────────────────────┤ Note to the asker         │
│ EVIDENCE                                                         │ ┌───────────────────────┐ │
│ ▸ What was checked                                               │ │                       │ │
│ [img][img][img]   2 Pass · 1 Fail          (click: large view)   │ └───────────────────────┘ │
│ ▸ test-output.log (first lines)                                  │ Draft saved 12:58         │
├──────────────────────────────────────────────────────────────────┤ [ Send ]  needs 2 more   │
│ ✓ DECISION 1 · Layout — a — Stacked blocks      Change           │                           │
├──────────────────────────────────────────────────────────────────┤ Withdraw                  │
│ DECISION 2 · Ask about this                                      │                           │
│ ┃ a  Build it now, part F        Cost: 2–4 h, plan use           │                           │
│ ┃ b  Later, its own design       Cost: none now   ◂ Manager       │                           │
│ ┃ Other…                                                         │                           │
├──────────────────────────────────────────────────────────────────┤                           │
│ SIGN-OFF                                                         │                           │
│ Manager: looks right; phone view checked at 390 px.              │                           │
│ ( Accepted )  ( Changes needed )   note: [                    ]  │                           │
└──────────────────────────────────────────────────────────────────┴───────────────────────────┘
```

**390 px** — the same blocks stacked full width; the rail becomes a bar fixed to the bottom with the count and Send; the note opens from it:

```
┌ ‹ 2/5 › Request #2104 ──────┐
│ Request page: layout and    │
│ next steps                  │
│ [Review] [3 to answer]      │
├─────────────────────────────┤
│ CONTEXT                     │
│ What we were solving …      │
│ ▸ What was done             │
├─────────────────────────────┤
│ EVIDENCE                    │
│ [img][img][img] →  2✓ 1✗    │
├─────────────────────────────┤
│ ✓ Layout — a       Change   │
├─────────────────────────────┤
│ DECISION 2 · Ask about this │
│ ┃ a  Build it now, part F   │
│ ┃ b  Later ◂ Manager        │
├─────────────────────────────┤
│ SIGN-OFF                    │
│ (Accepted) (Changes needed) │
╞═════════════════════════════╡
│ 2 to answer · Note · [Send] │
└─────────────────────────────┘
```

On the phone, the bottom bar sits above the on-screen keyboard (the page already handles that for the composer, `phoneKeyboard.ts`), so Send is never hidden.

**Screenshots** open today's large view (‹ ›, strip, Pass / Fail / Unsure, note, its keys) over the page, and closing it returns to the same place. The screenshot view stays; it becomes the large view of the Evidence block instead of a page of its own.

**Keyboard:** Tab moves through everything in order. **Alt+↓ / Alt+↑** jump to the next / previous block that still needs an answer. Inside a decision, its option keys pick (as today); in the sign-off, **A** and **C**. **Ctrl+Enter** sends (refused with "2 to answer" said aloud when parts are open). **Esc** goes back to the list; **← / →** move between requests only when nothing on the page has focus, as today.

**Draft:** every pick, verdict and note is saved as Simon goes (D4 decides where). Coming back — on the same device or another — shows the page as left, with "Draft saved 12:58".

**Answered request:** opens folded, each part showing what was sent, read-only.

### 6. Old questions and reviews

Since issue #509 (Simon, 2026-11-24, question #2340) the mapping below is done once, not on every open: a question is stored in blocks when it is asked, and one database update converted every question stored before (`src/shared/blocks.ts`, migration 64). An ordinary question's options and opinions are its own decision, with the key "" (a plain label keeps its exact answer, "(recommended)" and all); answers, question texts and the chat's labels were not touched, and Ledung's own permission-carrying questions keep their shape. As designed, the shared function maps each kind onto blocks:

| Stored | Blocks |
|---|---|
| Plain question (text, label options) | Context (the text) + one Decision (labels; "(recommended)" as the asker's pick) |
| Structured question (#59, #96) | Context (title, issue, sources) + Evidence (text) + one Decision (options, opinions, older recommended/reviewer pair) |
| Question with screenshots (#60) | as above + Evidence with judged shots |
| Review | Context (solving, done, notes) + Evidence files + Sign-off |
| Refused call, order, order command, permission question, workflow proposal | unchanged: their own cards, as today |

An old item opens on the request page looking as its old page did; an answered one shows its answer text as now (it has no `answerParts`). The three old page components go once the request page shows all presets as before (D2).

### 7. The #350 chat line, `waiting_for_you`, notifications

- **#350 line in the manager's chat:** label "Review" / "Question" as now, "Request" for a multi-part one; title as now. Answered, it says what it says today for a preset ("Accepted by Simon · 12:58"); for a request, the sign-off if there is one, else "Answered 3 parts", e.g. "Changes needed by Simon · 3 parts · 12:58". Still plain text from stored fields, updated in place, stored so it survives a restart.
- **`waiting_for_you`:** the kind says what is in it: `request (review, 2 decisions, 3 screenshots)`; the answered list gives the answer text cut at 1,500 characters as now (the full one is in the asker's conversation).
- **Notifications and push:** one per request, as for a question; the text names the parts ("Review · 2 decisions"). No new notifications.
- **The chat card in the asker's own chat** shows the title, the parts and Open, as a review card does today; its inline buttons only for a one-decision question (as now).

### 8. Security

- **Everything a session wrote is shown as text, never HTML:** Markdown through the page's Markdown component (no raw HTML), and titles, option labels, captions, file names and opinion names as plain text. The answer lines put session text on one line each (see 2).
- **Secrets blanked:** what is stored goes through the store's blanker (`setBlanker`, which has a deep form for structured data); the new `decisions`, `signOff`, `answerParts` and the draft must pass through it too, and a test proves it for each new field.
- **Files:** screenshots and evidence files are checked when asked by today's rules: inside the asker's project folder or a `board:` file, kinds checked by their first bytes, the same size limits; container projects keep their copy as now (issue #122). The page reads them only through today's routes and file rules (images as the screenshot view loads them, text files by their index in the request); no new way to read a file is added.
- **Who may answer:** the answer endpoint keeps today's rules (page key; signed for a sensitive item). The draft endpoint, if on the server, takes the same rules as answering. Ledung's own permission-carrying questions stay alone (see 1), so answering a large request can never allow a command.
- **Ask about this** has its own rules (D7): read-only tools only, no Ledung tools, no `ask_user`, no network beyond what the session has, no `LEDUNG_*` settings, stopped when the request is answered or withdrawn. Its replies are never part of the answer.

### 9. Parts, Done-when and estimates

Session time, build plus its own tests; a code review round per PR comes on top (about 15–30 min each), and Simon's look at the screenshots.

| Part | What | Done when | Estimate |
|---|---|---|---|
| **A. Model and `ask_user`** | The block function for every stored kind; `decisions`, `sign_off`, mixing rules, limits; the answer text builder; `answerParts` migration. | Tests: every call accepted today stores the same question, options and details as before (a fixed set of today's calls); new mixes accepted; bad mixes refused with a message saying what to do; preset answers are byte-for-byte today's; secrets blanked in the new fields. | 60–90 min |
| **B. Answer, delivery and runs** | Answer endpoint takes the parts and builds the text; run steps move by the named block; write-up check for one moving block; screenshots allowed at run steps; draft endpoint (if D4 is the server). | Tests: a review step with two extra decisions and shots moves by its sign-off and hands the rest on in the note; two decisions with outcomes refused; old answers still move runs; a throwaway Ledung run shows it end to end. | 60–90 min |
| **C. The request page** | One page for every preset and mix; folding; summary rail and phone bar; keyboard; drafts; old pages removed. | Dark screenshots at 1280 and 390 of: each preset (side by side with today's page), a full mix, a folded answered one; keyboard walk-through; tested on a throwaway Ledung. | 2–3 h |
| **D. List, line, tool, push** | "3 to answer" chip; #350 line wording; `waiting_for_you` kind; notification text. | Tests for each; counts unchanged for presets. | 45–60 min |
| **E. Ask about this** (only if D7 says now) | Its own short design first, then the build. | Its own. | design 30 min; build 2–4 h |

Order: A, then B and D, then C. A–D come to about **4½–6½ h** of session time, plus reviews.

## Decisions for Simon

| # | Question | Recommendation |
|---|---|---|
| **D1** | Do blocks come in a **fixed order** (Context, Evidence, Decisions, Sign-off), or does the asker choose the order? | **Fixed.** Every request reads the same way, the asker can't bury the context, and the tool stays simpler. |
| **D2** | **Old pages:** show every question, review and screenshot question (old and new) on the request page and remove the three old pages, once the preset screenshots match today's? | **Yes**, after you approve the side-by-side screenshots in part C. One page to maintain; nothing looks different for a preset. |
| **D3** | **Partial answers:** must every decision and the sign-off be answered before Send (shots may stay unjudged, as today)? | **Yes, all of them.** "Other…" with typed text is always there for "not sure yet". A half-answered request would leave the asker and a run guessing. |
| **D4** | **Where the draft lives:** in Ledung (follows you from the PC to the phone and back) or in each browser (as screenshot drafts are today)? | **In Ledung.** You use three devices; starting on the phone and finishing at the PC should just work. Costs about 30 min more. |
| **D5** | **What the sidebar count, notifications and push count:** requests (one per page) or parts? | **Requests.** One page waiting is one thing to open; "3 to answer" on the entry says how much is in it. |
| **D6** | **Run steps:** exactly one block moves the run (the sign-off for a review step, the one decision with outcomes for a question step); everything else goes to the coordinator as information? | **Yes.** A run needs one word; a Fail on a screenshot is for the coordinator to judge, not an automatic move. |
| **D7** | **Ask about this** (a read-only side chat forked from the asking session, beside the request): build it in this round, later as its own part, or not at all? | **Later, as its own part (E), after A–D are in use.** It is the most expensive part (plan use for each chat), it needs its own security design (a fork carries the whole conversation and the project folder), and the page works without it. The page leaves room for it: a button in the Context block. |
| **D8** | **Limits:** at most 6 decisions and 40 files per request? | **Yes.** Enough for a real review; more should be two requests. |

## Not in this design

- Requests sent over the board to another person's Ledung: a review goes as today; a multi-part request goes as a review plus separate questions until both Ledungs have this release.
- Templates a manager saves and reuses: the presets cover today's needs; a manager writes any mix directly.
- Answering one part early so the asker can start on it (D3 says no; can be revisited).
