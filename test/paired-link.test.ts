// Which link a computer device (a linked computer's tab here) was paired through (issue #313, #462): the rule both the
// trusted-computer vouch and the log-off when trust ends go by. The end-to-end relink is in trusted-computer.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairedLink } from '../src/server/devices.ts';

test('which link a tab belongs to: its kept link id; when that link is gone or none was kept, the one link of its name', () => {
  const links = [{ id: 'new-mac', name: 'Mac' }, { id: 'pc2', name: 'PC' }];
  const tab = (pairedViaLink: string | null, pairedVia: string | null, kind: 'computer' | 'phone' = 'computer') => ({ kind, pairedVia, pairedViaLink });
  assert.equal(pairedLink(tab('pc2', 'Mac'), links)?.id, 'pc2', 'a kept link id wins over the name');
  assert.equal(pairedLink(tab('old-mac', 'Mac'), links)?.id, 'new-mac', 'a gone link: by the name (#462)');
  assert.equal(pairedLink(tab(null, 'Mac'), links)?.id, 'new-mac', 'no link id kept: by the name');
  assert.equal(pairedLink(tab('old-mac', 'Laptop'), links), null, 'no link of its name');
  assert.equal(pairedLink(tab('old-mac', 'Mac'), [...links, { id: 'twin', name: 'Mac' }]), null, 'two links of its name: neither');
  assert.equal(pairedLink(tab('old-mac', null), links), null, 'paired here');
  assert.equal(pairedLink(tab('new-mac', 'Mac', 'phone'), links), null, 'never a phone');
});
