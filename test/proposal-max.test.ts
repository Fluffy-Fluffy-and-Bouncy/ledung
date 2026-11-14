// A proposal review's maximised diagram (#334): the changed blocks it outlines, what a side without a diagram says
// instead of an error, the selection kept only where the side has the block, and the history entry Back closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Flow } from '../src/shared/flow.ts';
import type { ProposalFlow } from '../src/shared/flow-proposal.ts';
import { changedBlocks, isMaxEntry, MAX_ENTRY, selectedIn, sideNote } from '../web/src/proposalSides.ts';

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
