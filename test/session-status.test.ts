// How the page shows a session's status (#97): one waiting for its first message reads and looks like an idle one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_LABEL, statusLook } from '../web/src/sessionStatus.ts';

test('a session waiting for its first message is labelled Ready, as an idle one', () => {
  assert.equal(STATUS_LABEL.idle, 'Ready');
  assert.equal(STATUS_LABEL.starting, 'Ready');
});

test('a session waiting for its first message has the grey idle look, not the working one', () => {
  assert.equal(statusLook({ status: 'starting', paused: false }), 'idle');
  assert.equal(statusLook({ status: 'idle', paused: false }), 'idle');
});

test('working, stopping and paused sessions look as before', () => {
  assert.equal(statusLook({ status: 'running', paused: false }), 'running');
  assert.equal(statusLook({ status: 'stopping', paused: false }), 'stopping');
  assert.equal(statusLook({ status: 'running', paused: true }), 'idle');
  assert.equal(STATUS_LABEL.running, 'Working');
  assert.equal(STATUS_LABEL.stopping, 'Stopping');
});
