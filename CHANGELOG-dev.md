# Ledung changelog: dev builds

Every dev build (v3.10, v3.11 …), newest first: what Settings → About → Update channel → Dev updates to. Each
build has one heading with its version and when it was published, then terse `- ` bullets, one per change, each
ending with its issue `(#12)` or `(no issue)`. Public releases, which fold the dev builds since the last one
together, are in [CHANGELOG.md](CHANGELOG.md). Online: https://projectledung.com/dev-changelog

**Don't edit this file.** A pull request writes its bullets in `docs/changes/<issue>.md`
([docs/changes/README.md](docs/changes/README.md)); `npm run publish:dev` and `npm run publish:public` fold them in
here under the version they publish, and push the result to main.

## Earlier
Before dev builds had a changelog of their own, every change was listed by date: see "Earlier, by date" in [CHANGELOG.md](CHANGELOG.md).
