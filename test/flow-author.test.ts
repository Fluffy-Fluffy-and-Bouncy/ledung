// A flow's author line (#117, Martin 2026-11-03: "When I share my workflow I want the credit for it."): flow.json may
// carry one, checked by the flow's schema; a flow without it reads and saves as before; the builder keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFlow, parseFlow } from '../src/shared/flow-check.ts';
import { textVersion } from '../src/sessions/flow-files.ts';
import type { FlowView } from '../src/shared/flow.ts';
import { draftFromView, flowOf, flowText, flowWrites, setBlock } from '../web/src/flowEdit.ts';

const BLOCKS = [{ id: 'build', kind: 'work', title: 'Build', runs: 'manager' }];
const text = (more: Record<string, unknown> = {}) => `${JSON.stringify({ version: 1, title: 'Code change', ...more, blocks: BLOCKS }, null, 2)}\n`;
const problems = (raw: string) => {
  const read = parseFlow(raw);
  return [...read.problems, ...(read.flow ? checkFlow(read.flow, () => true) : [])].filter((p) => !p.hint).map((p) => `${p.at}: ${p.message}`);
};

/** A view as the server gives it: the project's own flow, or a shared workflow's. */
function viewOf(raw: string, kind: 'project' | 'workflow' = 'project'): FlowView {
  return {
    project: 'p', source: { kind, folder: '/x/.ledung/workflow', ...(kind === 'workflow' ? { workflow: 'team' } : {}) }, expected: '.ledung/workflow/flow.json',
    flow: parseFlow(raw).flow, rules: null, texts: {}, problems: [], raw, versions: { 'flow.json': textVersion(raw) }, saveTo: '/p/.ledung/workflow', flows: [],
  };
}

test('#117 an author line is a field of the flow: read with no problem, and checked like the title', () => {
  const read = parseFlow(text({ author: 'Martin (Magto)' }));
  assert.deepEqual(read.problems, []);
  assert.equal(read.flow?.author, 'Martin (Magto)');
  assert.deepEqual(problems(text({ author: 'Martin (Magto)' })), []);
  // The schema's limits: a string, not empty, at most 120 characters, and nothing tied to one computer.
  assert.match(problems(text({ author: '  ' })).join('\n'), /^author: is empty/m);
  assert.match(problems(text({ author: 'x'.repeat(121) })).join('\n'), /^author: /m);
  assert.deepEqual(problems(text({ author: 'x'.repeat(120) })), []);
  assert.match(problems(text({ author: 42 })).join('\n'), /^author: /m);
  assert.match(problems(text({ author: 'see /Users/martin/notes' })).join('\n'), /^author: .*path on one computer/m);
});

test('#117 a flow without an author reads as before: no author, no problem', () => {
  const read = parseFlow(text());
  assert.deepEqual(read.problems, []);
  assert.equal('author' in read.flow!, false);
});

test('#117 the builder keeps the author: read and saved unchanged writes nothing; an edit writes it back where it was', () => {
  const raw = text({ author: 'Martin (Magto)' });
  const { base, draft } = draftFromView(viewOf(raw))!;
  assert.equal(draft.author, 'Martin (Magto)');
  assert.equal(flowOf(draft).author, 'Martin (Magto)');
  assert.deepEqual(flowWrites(base, draft), []);
  const edited = setBlock(draft, draft.blocks[0]!.key, { title: 'Build it' });
  const written = JSON.parse(flowText(base, edited));
  assert.equal(written.author, 'Martin (Magto)');
  assert.deepEqual(Object.keys(written), ['version', 'title', 'author', 'blocks']);
  assert.equal(written.blocks[0].title, 'Build it');
});

test("#117 a shared workflow's author goes with its flow into the project's own copy", () => {
  const { base, draft } = draftFromView(viewOf(text({ author: 'Simon (FFBuddha)' }), 'workflow'))!;
  const flow = flowWrites(base, draft).find((w) => w.path === 'flow.json')!;
  assert.equal(flow.base, null);
  assert.equal(JSON.parse(flow.text!).author, 'Simon (FFBuddha)');
});

test('#117 a flow without an author is saved without one, read or new', () => {
  const { base, draft } = draftFromView(viewOf(text()))!;
  assert.equal('author' in draft, false);
  const edited = setBlock(draft, draft.blocks[0]!.key, { title: 'Build it' });
  assert.equal('author' in JSON.parse(flowText(base, edited)), false);
});
