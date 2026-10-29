// Issue #400, Martin in Ledung question #397: the footer's "Connected" word goes; the page's connection is a footer
// chip's border, green only while connected and red while disconnected or reconnecting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionMark } from '../web/src/boardMarks.ts';

test('connected is the green border; reconnecting and disconnected are both red', () => {
  assert.equal(connectionMark('open').className, 'conn-up');
  assert.equal(connectionMark('connecting').className, 'conn-down');
  assert.equal(connectionMark('closed').className, 'conn-down');
});

test('the state is in words for the tooltip, as the footer word was', () => {
  assert.match(connectionMark('open').text, /^Connected/);
  assert.match(connectionMark('connecting').text, /^Connecting/);
  assert.match(connectionMark('closed').text, /^Disconnected/);
});
