// The flow a workflow page shows is in the address (#447, Simon: Back after opening a sub-flow went too far): each flow
// viewed is a history entry, a link to one opens it, and the builder's unsaved changes hold a move off the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardFor, heldRecently, noteHeld, setLeaveGuard, workflowFromHash, workflowHash } from '../web/src/flowNav.ts';

test('#447 a workflow page and the flow it shows: the default flow is the page itself, another its name after it', () => {
  assert.equal(workflowHash('Agent workflow port'), '#/wf/Agent%20workflow%20port');
  assert.equal(workflowHash('demo', 'main'), '#/wf/demo', 'the default flow has no part of its own');
  assert.equal(workflowHash('demo', 'merge-ask'), '#/wf/demo/merge-ask');
  assert.equal(workflowHash('a/b', 'review'), '#/wf/a%2Fb/review', "a project's name with a slash stays one part");
  assert.deepEqual(workflowFromHash('#/wf/Agent%20workflow%20port'), { project: 'Agent workflow port', flow: null });
  assert.deepEqual(workflowFromHash('#/wf/demo/merge-ask'), { project: 'demo', flow: 'merge-ask' });
  assert.deepEqual(workflowFromHash('#/wf/a%2Fb/review'), { project: 'a/b', flow: 'review' });
  assert.deepEqual(workflowFromHash('#/wf/demo/main'), { project: 'demo', flow: null });
  // A name no flow can have is the page's to say ("no flow …; showing the default one").
  assert.deepEqual(workflowFromHash('#/wf/demo/Not%20a%20flow'), { project: 'demo', flow: 'Not%20a%20flow' });
  for (const other of ['#/ps/demo', '#/wf/', '#/wf/demo/x/y', '#/wf/%E0%A4%A', '']) assert.equal(workflowFromHash(other), null, other);
});

test("#447 the builder's unsaved changes hold a move off its project's workflow page, not a move between its flows", () => {
  assert.equal(guardFor('#/overview'), null, 'nothing unsaved: nothing held');
  const asked: string[] = [];
  setLeaveGuard({ project: 'demo', ask: () => asked.push('asked') });
  try {
    assert.equal(guardFor('#/wf/demo'), null);
    assert.equal(guardFor('#/wf/demo/merge-ask'), null, 'another flow of the same project is a step inside the page');
    assert.ok(guardFor('#/overview'));
    assert.ok(guardFor('#/wf/other'), "another project's workflow page leaves this one");
    assert.ok(guardFor(''), 'the start page');
    guardFor('#/overview')!.ask(() => {});
    assert.deepEqual(asked, ['asked']);
  } finally {
    setLeaveGuard(null);
  }
  assert.equal(guardFor('#/overview'), null);
  // The mouse's back button, taken by Ledung where the browser doesn't, isn't taken again just after a hold.
  assert.equal(heldRecently(), false);
  noteHeld();
  assert.equal(heldRecently(), true);
});
