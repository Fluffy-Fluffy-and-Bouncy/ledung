// The status line's ship: every frame fits the line, and each timeline ends in the pose the next one starts from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROWS, burstAndReplace, calmSea, depart, fleetLeaves, fogLifts, fogRollsIn, founderAndReplace, gather, radiating, render, rocking, sailing, sinking, standing,
  startAgain, turnAndStop, BAR_WIDTHS, WRECK, barArriving, barLeaving, barScene, barStepFor, barValue, barX, damageStage, watchArrives, watchChanges, watchStandsDown, type Behind, type Timeline,
} from '../web/src/components/shipFrames.ts';

const BEHIND: Behind[] = ['none', 'busy', 'fleet'];

function frames(t: Timeline): string[] {
  return t.scenes.map((s, i) => render(s, i));
}

function assertFits(t: Timeline, width: number): void {
  assert.ok(t.loopFrom >= 0 && t.loopFrom < t.scenes.length);
  for (const f of frames(t)) {
    const rows = f.split('\n');
    assert.equal(rows.length, ROWS);
    assert.ok(rows.every((r) => r.length === width), `frame not ${width} wide:\n${f}`);
  }
}

test('every timeline renders frames of four equal rows, on the status line strip and a narrow one', () => {
  for (const width of [20, 10]) {
    for (const x of [-6, 0, 6, 12, 19]) {
      for (const followers of [0, 1, 2, 5]) assertFits(sailing(x, followers, width), width);
      for (const behind of BEHIND) assertFits(turnAndStop(x, behind, width), width);
      assertFits(sinking(x, width), width);
    }
    for (const behind of BEHIND) assertFits(standing(behind, width), width);
    assertFits(gather(width), width);
    assertFits(fleetLeaves(width), width);
    assertFits(depart(0, width), width);
    assertFits(depart(2, width), width);
    assertFits(startAgain(0, width), width);
    assertFits(startAgain(2, width), width);
    assertFits(calmSea(width), width);
    for (const t of [watchArrives, watchChanges, watchStandsDown, radiating, burstAndReplace, rocking, founderAndReplace, fogRollsIn, fogLifts]) assertFits(t(width), width);
  }
});

test('turning and stopping ends in the pose a session opened while waiting shows', () => {
  for (const behind of BEHIND) {
    const turn = turnAndStop(3, behind);
    assert.deepEqual(frames({ scenes: turn.scenes.slice(turn.loopFrom), loopFrom: 0 }), frames(standing(behind)));
  }
});

test('starting again sets off from the stopped pose and then just sails', () => {
  const start = startAgain(1);
  const stoppedAt = render(standing('none').scenes[0]!, 0);
  assert.notEqual(render(start.scenes[0]!, 0), stoppedAt);
  assert.equal(start.scenes.length - start.loopFrom, sailing(0, 1).scenes.length);
});

test('a sunk ship leaves calm sea', () => {
  const sink = sinking(0);
  assert.equal(render(sink.scenes.at(-1)!, 0), render(calmSea().scenes[0]!, 0));
  assert.ok(!render(sink.scenes.at(-1)!, 0).includes('|'));
});

test('sailing picks up at the given position', () => {
  assert.equal(render(sailing(4).scenes[0]!, 0), render(sailing(-6).scenes[10]!, 0));
});

test('the fleet gathers into the gathered pose and departs from it', () => {
  const g = gather();
  const gathered = render(standing('fleet').scenes[0]!, 0);
  assert.equal(render(g.scenes.at(-1)!, 0), gathered);
  assert.equal(render(g.scenes[0]!, 0).split('\n')[3]!.includes('\\___/'), true);
  // Three bows facing the viewer, the middle one closest.
  assert.equal(gathered.split('\n')[1]!.replace(/[^|]/g, '').length, 3);
  const d = depart(2);
  assert.notEqual(render(d.scenes[0]!, 0), gathered);
  assert.equal(d.scenes.length - d.loopFrom, sailing(-6, 2).scenes.length);
});

test('when the fleet leaves, the single ship comes back and ends in its own stopped pose', () => {
  const leave = fleetLeaves();
  assert.equal(render(leave.scenes[0]!, 0) === render(standing('fleet').scenes[0]!, 0), false);
  assert.deepEqual(frames({ scenes: leave.scenes.slice(leave.loopFrom), loopFrom: 0 }), frames(standing('none')));
  // Somewhere in between the sea is empty: everyone has sailed off before the ship returns.
  assert.ok(leave.scenes.some((s) => !render(s, 0).split('\n').slice(0, 3).join('').trim()));
});

test('a context clear: the next crew waits beside the ship, then takes its place or sails on', () => {
  for (const width of [20, 10]) {
    const stoppedPose = frames(standing('none', width));
    const ending = (t: Timeline) => frames({ scenes: t.scenes.slice(t.loopFrom), loopFrom: 0 });
    // Both ways out end on a single ship in its stopped pose.
    assert.deepEqual(ending(watchChanges(width)), stoppedPose);
    assert.deepEqual(ending(watchStandsDown(width)), stoppedPose);
    // While it waits, the small boat is in view next to (or half behind) the ship.
    const waiting = render(watchArrives(width).scenes.at(-1)!, 0).split('\n');
    assert.ok(waiting[1]!.includes('|\\'), waiting.join('\n'));
    // Somewhere in the change the old ship is gone and only the small boat is left.
    assert.ok(watchChanges(width).scenes.some((s) => s.sprites?.length === 1 && s.sprites[0]!.rows[2] === '\\__/'));
  }
});

test('the spare clear animations end on a fresh ship in its stopped pose', () => {
  const stoppedPose = render(standing('none').scenes[0]!, 0);
  for (const t of [burstAndReplace(), founderAndReplace(), fogLifts()]) assert.equal(render(t.scenes.at(-1)!, 0), stoppedPose);
  assert.equal(fogRollsIn().scenes.length, 166);
});

test('the limit bar: steps by strip width, damage from 90%, and every frame fits', () => {
  assert.deepEqual(BAR_WIDTHS.map((w) => barStepFor(w)), [2, 2, 5, 5, 20]);
  assert.deepEqual([0, 47, 89, 90, 91, 97, 99, 100].map((v) => barValue(v, 50)), [0, 46, 88, 90, 90, 96, 98, 100]);
  assert.deepEqual([0, 88, 90, 92, 94, 96, 98, 100].map(damageStage), [0, 0, 1, 2, 3, 4, 5, WRECK]);
  for (const hull of ['ship', 'boat'] as const) {
    for (const width of BAR_WIDTHS) {
      assert.equal(barX(100, width, hull) + (hull === 'ship' ? 6 : 4), width);
      for (let stage = 0; stage <= WRECK; stage++) {
        for (const x of [0, 5, barX(100, width, hull)]) {
          const { scene } = barScene(width, stage, x, '100%', hull);
          for (const s of [scene, barLeaving(width, stage, x - 7, hull), barArriving(width, x - 6, hull)]) {
            const rows = render(s, 3).split('\n');
            assert.ok(rows.length === ROWS && rows.every((r) => r.length === width), render(s, 3));
          }
        }
      }
    }
  }
});

test('the limit bar shows its number big once there is room, small before, none at first', () => {
  assert.equal(barScene(50, 0, 0, '0%').number.length, 0);
  const small = barScene(50, 0, 4, '4%').number;
  assert.ok(small.every((m) => m.y === 0));
  const big = barScene(50, 0, 30, '64%').number;
  assert.ok(big.some((m) => m.y === 2));
  // The number never runs into the hull.
  for (let x = 0; x <= 44; x++) assert.ok(barScene(50, 0, x, '100%').number.every((m) => m.x < x));
});

test('once the big number shows, it keeps showing as the value rises', () => {
  for (const hull of ['ship', 'boat'] as const) {
    for (const width of BAR_WIDTHS) {
      let big = false;
      let small = false;
      for (let v = 0; v <= 100; v++) {
        const shown = barValue(v, width, hull);
        const n = barScene(width, damageStage(shown), barX(shown, width, hull), `${v}%`, hull).number;
        const isBig = n.some((m) => m.y > 0);
        assert.ok(!big || isBig, `${hull} ${width} cols: big number lost at ${v}%`);
        assert.ok(!small || n.length > 0, `${hull} ${width} cols: number lost at ${v}%`);
        big ||= isBig;
        small ||= n.length > 0;
      }
    }
  }
  // Martin's example: on 33 columns the ship shows the big number from 44%.
  const firstBig = (width: number) => [...Array(101).keys()].find((v) => barScene(width, 0, barX(barValue(v, width), width), `${v}%`).number.some((m) => m.y > 0));
  assert.equal(firstBig(33), 44);
});
