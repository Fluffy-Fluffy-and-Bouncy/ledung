# Review pages: a person signs off a finished change — proposal

Oct 16, 2026 · Approved by Simon on 2026-10-16 (question #421), all four parts.

**Done when:** a manager sends Simon a review of a finished PR; "Waiting for you" opens it on one page with what was solved, what was done, the notes and the evidence (screenshots or logs); Simon answers Accept or Changes needed; and the same review, sent over the board, opens as the same page in another person's Ledung.

## Why

Code review is Claude's job. What a person adds is the **functional sign-off**: does the change solve the problem, and does it look right. The first try (PR #143, question #413) used an ordinary question with screenshots, and showed two problems:

- A question with screenshots opens straight into the screenshot view, which folds the issue away and doesn't show the evidence, the opinions or the options at all. Simon saw pictures without context.
- The context depends on each manager filling optional fields, and they often don't (the reason for the rule of 2026-10-16, question #384).

Simon's decisions (2026-10-16): **one overall verdict**, "the screenshots are only there to demonstrate things"; a **dedicated review type** rather than a generic question page. On the first draft (question #419): the notes section is just "Notes", not "Notes from Claude"; and the evidence is any evidence, "Screenshots make sense for UI. But what if they are logs instead?"

## What a review is

A new form of `ask_user`, `review`, with fixed sections; all text is Markdown:

| Field | Required | What it holds |
|---|---|---|
| `title` | yes | One line, e.g. "Empty chat area offers Add a project". |
| `review.solving` | yes | What we were trying to solve, in plain terms: two or three sentences, no file names. |
| `review.done` | yes | What the change does, in the same plain terms. |
| `review.notes` | no | Notes: the code review's verdict, what was not tested, anything worth a look, from whoever has something to say. Left out when there is nothing. |
| `review.evidence` | no | Up to 10 files that demonstrate the change, each with a caption: PNG or JPEG screenshots, or `.txt`, `.log` or `.md` text such as a log or test output. From the project folder, or a `board:` file received with a board post. Same kinds and limits as board attachments (images up to 5 MB, text up to 512 KB), checked by their first bytes as there. No verdict per file. |
| `refs` | no | The issue and PR, linked as today. |
| `tier` | yes | As every question; a review is normally "Blocks a finished PR". |

Ledung refuses a review whose `solving` or `done` is missing or empty, so a review can't arrive without its context. `options`, `opinions`, the generic `evidence` text, `screenshots` and per-shot verdicts are not part of a review: opinions and what was checked belong in the notes, files in `review.evidence`.

The answer is always one of:

- `Accepted.` plus Simon's note, if any
- `Changes needed:` plus Simon's text, which is required

A manager, or a project's workflow, can act on that without interpreting it. What Accept leads to (merge, release, a ticket moving on) is the manager's and the workflow's business, not Ledung's.

## The page

In "Waiting for you", a review opens on its own page, top to bottom, narrow screens included:

1. Title, project, who asks, the refs.
2. **What we were solving**
3. **What was done**
4. **Notes** (only if given)
5. **Evidence**, each file with its caption: screenshots as thumbnails in a row (wrapping on a phone), clicking one opens it large with arrows to the next; text files as a folded block showing the first lines in a fixed-width font, unfolding to the whole file in a scrolling box. Files are shown read-only, only from the project folder or the board cache, as today.
6. **Accept** and **Changes needed** buttons, plus a text box. The text is optional for Accept and required for Changes needed. Withdraw as for any question.

In the queue, a review shows as a question with a "Review" label and the first line of "What we were solving" as its excerpt. In the manager's conversation it shows as a card with the title and a button to open it, as a screenshot question does today.

## Over the board

Nothing new in the board. A manager sends a review to another person's Ledung as a post with the evidence attached. The receiving manager puts it to its person as a `review`, with the attachments as `board:` files (images and text alike), and posts the answer back. The tool instructions say so: "A review request received over the board goes to your person as a review." The other Ledung needs the same release.

## Also: the generic fix

Separately, a small bug fix: an ordinary question with screenshots (such as the board's "may these files leave?") keeps its per-shot judging, but its issue, evidence and options are shown above the screenshots instead of being folded away or hidden.

## Not in this step

- Ledung acting on Accept (merging, releasing): that stays the manager's, within its grant and Simon's rules.
- A review page outside Ledung, or a link to send someone without Ledung.
- Several reviewers on one review in the same Ledung, or a "both must accept" rule.
- Comments on single lines or single screenshots. (Line comments are being tried as a test feature in the Files pane, issue #225; see the decision of 2026-10-18.)

## Parts

| Part | What | Done when |
|---|---|---|
| 1 | `ask_user` takes `review`; it is checked, stored in the question's structured fields (no database change) and returned by the API. The tool instructions say when to use it. | A test asks a review, a review without `solving` is refused, and the answer comes back in the fixed form. |
| 2 | The review page and its place in the queue and the conversation; works at phone width. | Screenshots of the page at 1280 px and 390 px, with an image and a log as evidence, before and after answering. |
| 3 | The generic fix for screenshot questions. | A screenshot question shows its issue, evidence and options. |
| 4 | Redo #143 as the first real review: to Simon, and to Magto over the board. | Simon and Magto each answer it on the review page. |

Tests as usual: the tool's checks and the answer form in `test/`, the page by screenshots at both widths.
