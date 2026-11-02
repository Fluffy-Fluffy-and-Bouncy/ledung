// How long the tests wait before calling something hung (issue #463). These limits catch a hang; they are never a
// speed check. A full run starts many test files at once, some starting git, npm and node processes, beside whatever
// else the computer is doing: a linked-computers test that takes 0.6 s alone took 7 s in a normal full run and 21 s
// in Martin's release, which its 20 s limit then failed. A test that must finish in time says so in an assert on the
// time it measured, not with these. test/limits.test.ts refuses a number in their place.

/** A test's own `timeout`, and a child process the test waits for. */
export const HANG_MS = 120_000;

/** One wait inside a test for something to happen: a polling helper's budget, or a deadline on an event. */
export const WAIT_MS = 30_000;
