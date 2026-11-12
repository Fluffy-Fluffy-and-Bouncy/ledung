// A stream whose far side keeps sending after it was asked to pause (Project-Ledung#479, audit L12): the bytes waiting
// for its socket are capped, and past the cap the stream is reset and the reset reported, on the relay and in Ledung
// alike (both run src/remote/mux.ts). A peer that honours pause never gets there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplexPair } from 'node:stream';
import { decodeFrame, FRAME, MAX_CHUNK, MAX_STREAM_BACKLOG, Streams, type ResetReason } from '../src/remote/mux.ts';

/** One stream over a fake agent socket; the stream's own socket is never read until `read()`, so writes pile up. */
function oneStream() {
  const frames: { kind: number; id: number }[] = [];
  const resets: [number, ResetReason][] = [];
  const streams = new Streams({ send: (data: Buffer) => void frames.push(decodeFrame(data)!), bufferedAmount: 0 }, { onReset: (id, reason) => resets.push([id, reason]) });
  const [here, there] = duplexPair();
  streams.attach(7, here);
  return { streams, here, read: () => there.resume(), kinds: () => frames.filter((f) => f.id === 7).map((f) => f.kind), resets };
}

test('Project-Ledung#479: a peer that ignores pause has its stream reset at the backlog cap; one that honours it never does', async () => {
  // The cap is a bound on memory: 32 MiB, eight times the agent socket's 4 MiB high water.
  assert.equal(MAX_STREAM_BACKLOG, 32 * 1024 * 1024);

  // A peer that ignores pause: frames keep coming, and the socket is never read.
  const bad = oneStream();
  let most = 0;
  let sent = 0;
  while (bad.streams.has(7) && sent < 4 * MAX_STREAM_BACKLOG) {
    bad.streams.receive(FRAME.data, 7, Buffer.alloc(MAX_CHUNK));
    sent += MAX_CHUNK;
    if (!bad.here.destroyed) most = Math.max(most, bad.here.writableLength);
  }
  assert.equal(bad.streams.has(7), false, 'the stream is gone');
  assert.deepEqual(bad.kinds(), [FRAME.pause, FRAME.reset], 'asked to pause once, then reset');
  assert.deepEqual(bad.resets, [[7, 'ignored pause']], 'the reset is reported once, with its reason');
  assert.ok(most <= MAX_STREAM_BACKLOG + MAX_CHUNK, `held at most the cap and one frame (${most})`);
  assert.ok(sent <= MAX_STREAM_BACKLOG + 2 * MAX_CHUNK, `reset as soon as the cap was passed (after ${sent} bytes)`);
  assert.equal(bad.here.destroyed, true, 'its socket is dropped, and what it held with it');
  // Frames after the reset are ignored, never written.
  bad.streams.receive(FRAME.data, 7, Buffer.alloc(MAX_CHUNK));
  assert.deepEqual(bad.kinds(), [FRAME.pause, FRAME.reset]);

  // A peer that honours pause: once our pause reaches it, it stops; what it had in flight still arrives. Its own agent
  // socket stops reading at 4 MiB waiting, so with the network between, half the cap is more than it can have in flight.
  const good = oneStream();
  while (!good.kinds().includes(FRAME.pause)) good.streams.receive(FRAME.data, 7, Buffer.alloc(MAX_CHUNK));
  for (let inFlight = 0; inFlight < MAX_STREAM_BACKLOG / 2; inFlight += MAX_CHUNK) good.streams.receive(FRAME.data, 7, Buffer.alloc(MAX_CHUNK));
  assert.equal(good.streams.has(7), true, 'not reset');
  assert.deepEqual(good.resets, []);
  // Its socket catches up: the stream goes on.
  good.read();
  await new Promise<void>((done) => good.here.once('drain', () => done()));
  assert.deepEqual(good.kinds(), [FRAME.pause, FRAME.resume], 'paused and resumed, never reset');
  good.streams.closeAll();
});
