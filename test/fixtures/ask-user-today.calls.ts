// ask_user calls accepted before issue #502, one of each kind (docs/steps/request-blocks.md, part A: "every call
// accepted today stores the same question, options and details as before"). ask-user-today.json holds what main's
// askedQuestion made of each, generated from main at 73d3c00a; test/requests.test.ts checks today's code makes the same.
export const TODAY_CALLS: Record<string, unknown>[] = [
  { question: 'Merge now?', options: ['Yes (recommended)', 'No'], tier: 'Process' },
  { question: 'Plain, no options', tier: 'Process' },
  { issue: 'Which layout?', tier: 'Blocks a card from Ready' },
  {
    title: 'Layout', issue: 'Two ways to lay it out.', evidence: 'Checked at 390 px.', tier: 'Process', rank: 2, refs: ['#502'],
    options: [{ key: 'a', text: '**Stacked**: one column', cost: '1 h' }, { key: 'b', text: '**Side by side**' }],
    opinions: [{ who: 'Manager', pick: 'a', why: 'Reads on a phone.' }, { who: 'Reviewer', pick: 'b' }],
  },
  {
    question: 'My own words about it', title: 'T', issue: 'I', tier: 'Process',
    options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], recommended: 'a', why: 'because', reviewer: { who: 'R', pick: 'b', why: 'other' },
  },
  {
    title: 'Shots', issue: 'Do these look right?', tier: 'Blocks a finished PR',
    options: [{ key: 'a', text: '**Ship**' }, { key: 'b', text: '**Fix**' }],
    screenshots: [{ file: 'a.png', look_for: 'x' }],
  },
  { title: 'Only shots', issue: 'Look', tier: 'Process', screenshots: [{ file: 'a.png', look_for: 'x', group: 'G' }] },
  {
    title: 'Review: shop', tier: 'Blocks a finished PR', refs: ['PR #12'],
    review: { solving: 'The cart was wrong.', done: 'Fixed the VAT.', notes: 'Reviewer: fine.', evidence: [{ file: 'shots/cart.png', caption: 'The cart' }] },
  },
  { title: 'Review, bare', tier: 'Process', review: { solving: 'S', done: 'D', notes: '  ' } },
  { question: 'Allow this push?', tier: 'Process', options: [{ key: 'a', text: 'No' }], order_command: { command: 'git push origin main' } },
  { question: 'Allow this?', tier: 'Process', options: ['Not now'], order_command: { command: 'npm run *', match: 'pattern' } },
];
