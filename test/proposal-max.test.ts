// A proposal review's maximised diagram (#334): the changed blocks it outlines, what a side without a diagram says
// instead of an error, the selection kept only where the side has the block, and the history entry Back closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Flow } from '../src/shared/flow.ts';
import type { ProposalFlow } from '../src/shared/flow-proposal.ts';
import { changedBlocks, isMaxEntry, MAX_ENTRY, maxEntryAction, selectedIn, sideNote, staleMaxEntry, tabTarget, withMaxEntry } from '../web/src/proposalSides.ts';

const flow = (blocks: { id: string; title: string }[]): Flow => ({ blocks: blocks.map((b) => ({ kind: 'work', ...b })) } as unknown as Flow);
const side = (f: Flow | null): ProposalFlow => ({ name: 'main', file: '.ledung/flows/main.json', title: 'Main', flow: f });

test('the changed blocks are those the other side lacks as they are', () => {
  const before = flow([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]);
  const after = flow([{ id: 'a', title: 'A' }, { id: 'b', title: 'B, changed' }, { id: 'd', title: 'D' }]);
  assert.deepEqual([...changedBlocks(after, before)].sort(), ['b', 'd']);
  assert.deepEqual([...changedBlocks(before, after)].sort(), ['b', 'c']);
  // A new flow: all of it is new.
  assert.deepEqual([...changedBlocks(after, null)].sort(), ['a', 'b', 'd']);
});

test('a side without a diagram says why, not as an error unless its file does not read', () => {
  assert.equal(sideNote('before', side(flow([]))), null);
  assert.deepEqual(sideNote('before', null), { text: 'A new flow: there is no before.', problem: false });
  assert.deepEqual(sideNote('after', null), { text: 'Removed: there is no after.', problem: false });
  assert.deepEqual(sideNote('after', side(null)), { text: ".ledung/flows/main.json doesn't read as a flow.", problem: true });
});

test('the selected block is kept only on a side that has it', () => {
  const f = flow([{ id: 'a', title: 'A' }]);
  assert.equal(selectedIn(f, 'a'), 'a');
  assert.equal(selectedIn(f, 'gone'), null);
  assert.equal(selectedIn(null, 'a'), null);
  assert.equal(selectedIn(f, null), null);
});

test('the big view\'s history entry is told apart from the review\'s own', () => {
  assert.equal(isMaxEntry({ ledungDesk: 1, [MAX_ENTRY]: 1 }), true);
  assert.equal(isMaxEntry({ ledungDesk: 1 }), false);
  assert.equal(isMaxEntry(null), false);
  assert.equal(isMaxEntry(undefined), false);
});

// The review's history as a list, with the steps the page takes: enough to replay the reviewer's cases (PR #335).
function browser(first: unknown) {
  const h = { stack: [first], at: 0, open: false };
  const state = () => h.stack[h.at];
  const back = () => { h.at -= 1; onPop(); };
  // What the review does on a step through history: the big view closes on an unmarked entry, a stale one is left.
  const onPop = () => {
    if (h.open && !isMaxEntry(state())) h.open = false;
    if (staleMaxEntry(state(), h.open)) back();
  };
  return {
    h, state,
    maximise() {
      const next = withMaxEntry(state());
      if (maxEntryAction(state()) === 'replace') h.stack[h.at] = next;
      else { h.stack = [...h.stack.slice(0, h.at + 1), next]; h.at += 1; }
      h.open = true;
    },
    close() { if (isMaxEntry(state())) back(); else h.open = false; },
    back,
    forward() { h.at += 1; onPop(); },
    reload() { h.open = false; if (staleMaxEntry(state(), h.open)) back(); },
  };
}

test("opening the big view marks a new entry, or reuses one already marked, and keeps the review's own state", () => {
  assert.equal(maxEntryAction({ ledungDesk: 1 }), 'push');
  assert.equal(maxEntryAction(null), 'push');
  assert.equal(maxEntryAction({ ledungDesk: 1, [MAX_ENTRY]: 1 }), 'replace');
  assert.deepEqual(withMaxEntry({ ledungDesk: 2, ledungDeskRoot: false }), { ledungDesk: 2, ledungDeskRoot: false, [MAX_ENTRY]: 1 });
  assert.deepEqual(withMaxEntry(null), { [MAX_ENTRY]: 1 });
  assert.equal(staleMaxEntry({ [MAX_ENTRY]: 1 }, false), true);
  assert.equal(staleMaxEntry({ [MAX_ENTRY]: 1 }, true), false);
  assert.equal(staleMaxEntry({ ledungDesk: 1 }, false), false);
});

test("after a reload on the big view's entry, the review is back on its own entry and one close closes", () => {
  const b = browser({ ledungDesk: 1 });
  b.maximise();
  b.reload();
  assert.deepEqual(b.state(), { ledungDesk: 1 }, "the stale entry is left, so the review's Close counts right");
  b.maximise();
  assert.equal(b.h.open, true);
  b.close();
  assert.equal(b.h.open, false, 'one close closes it');
  assert.deepEqual(b.state(), { ledungDesk: 1 });
});

test("Forward onto the big view's entry leaves it again, and the next big view closes with one press", () => {
  const b = browser({ ledungDesk: 1 });
  b.maximise();
  b.back();
  assert.equal(b.h.open, false);
  b.forward();
  assert.equal(b.h.open, false);
  assert.deepEqual(b.state(), { ledungDesk: 1 });
  b.maximise();
  b.close();
  assert.equal(b.h.open, false);
  assert.deepEqual(b.state(), { ledungDesk: 1 });
});

test('even on a marked entry not yet left, opening reuses it, so one close is enough', () => {
  const b = browser({ ledungDesk: 1 });
  b.maximise();
  b.h.open = false; // the review redrawn while the big view was open, before it tidied up
  b.maximise();
  assert.equal(b.h.stack.length, 2, 'no second marked entry');
  b.close();
  assert.equal(b.h.open, false);
  assert.deepEqual(b.state(), { ledungDesk: 1 });
});

test('Tab in the big view skips the diagram under a note and wraps round inside the view', () => {
  // The bar's buttons, then the covered diagram's controls (inert), as in the page's order.
  const el = (name: string, inert = false) => ({ name, closest: (s: string) => (s === '[inert]' && inert ? {} : null) });
  const before = el('Before'), after = el('After'), close = el('Close');
  const zoom = el('Zoom in', true), fit = el('Fit', true);
  const all = [before, after, close, zoom, fit];
  // Tab on Close: the last reachable button, so back to Before, not out of the view past the inert controls.
  assert.equal(tabTarget(all, close, false), before);
  // Shift+Tab on Before: to Close, which can take focus, not to an inert control.
  assert.equal(tabTarget(all, before, true), close);
  // In between, the browser moves focus itself.
  assert.equal(tabTarget(all, before, false), null);
  assert.equal(tabTarget(all, close, true), null);
  // Focus outside the reachable ones (on the page, or on an inert one): back into the view.
  assert.equal(tabTarget(all, null, false), before);
  assert.equal(tabTarget(all, zoom, true), close);
  // With no note nothing is inert, and the diagram's controls are part of the round.
  const open = [before, after, close, el('Zoom in'), el('Fit')];
  assert.equal(tabTarget(open, close, false), null);
  assert.equal(tabTarget(open, open[4], false), before);
});
