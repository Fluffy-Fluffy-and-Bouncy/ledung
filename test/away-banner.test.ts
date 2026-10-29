// Away mode on every view (issue #274): set through the remote, it reached the computer's page but showed only beside
// a manager's ⚙, so with anything else open the page looked unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awayBannerShown } from '../web/src/awayBanner.ts';
import type { AwayInfo } from '../src/shared/protocol.ts';

const away: AwayInfo = { since: 0, until: 8 * 3600_000, allow: ['merge', 'devShip'] };

test('while away the banner shows with no session open, and on a worker or a chat: no manager needed (#274)', () => {
  assert.equal(awayBannerShown(away, null), true, 'the list, Overview, the board, Settings, Waiting for you');
  assert.equal(awayBannerShown(away, { role: 'session' }), true, 'a worker session or a chat');
});

test('a manager keeps its header marker instead, and nothing shows when not away (#274, question #227)', () => {
  assert.equal(awayBannerShown(away, { role: 'manager' }), false);
  for (const open of [null, { role: 'session' as const }, { role: 'manager' as const }]) assert.equal(awayBannerShown(null, open), false);
});
