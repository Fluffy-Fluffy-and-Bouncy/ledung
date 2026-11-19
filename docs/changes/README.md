# Waiting changelog entries

Every pull request that changes what Ledung does writes what changed here, in a file of its own, and **never edits
`CHANGELOG.md` or `CHANGELOG-dev.md`**. This holds for everyone who works on Ledung, people and Claude sessions, on
every computer (issue #417; Martin, 2026-11-19).

- **The file:** `docs/changes/<issue>.md`, named after the issue the PR works on, for example `docs/changes/417.md`.
  A PR with no issue picks a short name of its own, `docs/changes/fix-typo-in-help.md`. A second PR for the same
  issue adds its lines to the file if it is still here, or makes it again if a publish has taken it.
- **The lines:** terse `- ` bullets, one short line per change, in plain words saying what changed for the person
  using Ledung: no prose paragraphs and no mechanism (that belongs in the commit message). Each ends with the issue
  number(s), `(#12)` or `(#12, #15)`, or `(no issue)` when there is none, so the omission is deliberate. Anything in
  the file that is not a `- ` line (or an indented line under one) is left out.
- **Nothing user-facing** (tests, refactors, internals): no file; put `Changelog: none` as a trailer in a commit
  message instead. A reviewer checks that it is honest.

The pre-push hook (`.githooks/pre-push`) refuses a push that changes `src/`, `web/` (not `web/dist/`) or `scripts/`
without a new `- ` line in a file here, or the trailer.

**What happens to the files.** `npm run publish:dev` takes every file here (but this one), puts their lines in
`CHANGELOG-dev.md` under a heading with the new dev version, its date and time (`## v3.13 — 2026-11-20 09:02 CET`),
deletes the files, commits and pushes that to main. `npm run publish:public` writes the new public release in
`CHANGELOG.md` with everything since the last one: the lines of every dev build since, and those still waiting here.
Within a release, files named after a higher issue number come first. The pages
https://projectledung.com/changelog and https://projectledung.com/dev-changelog show the two files.
