// Plays Ledung's ASCII ship (shipFrames.js) in any <pre data-ship="story" data-width="N">.
// Stories chain the app's own timelines, so the ship is never a frozen frame.
(function () {
  const S = window.ShipFrames;
  const STEP_MS = 180;

  // Each story is a list of [timeline, frames to play]; frames past the timeline's end repeat from loopFrom.
  const full = (tl, extra = 0) => [tl, tl.scenes.length + extra];
  const stories = {
    // A manager's fleet: sails with two sessions, stops with the fleet gathered, departs together.
    voyage: (w) => {
      const sail = S.sailing(-6, 2, w);
      return [full(sail), full(S.turnAndStop(-6, 'fleet', w), 22), full(S.depart(2, w), 0)];
    },
    // One session: works, stops to wait for you, starts again.
    solo: (w) => [full(S.sailing(-6, 0, w)), full(S.turnAndStop(-6, 'none', w), 20), full(S.startAgain(0, w), w)],
    // Working with a small boat behind (background work), stopped.
    busy: (w) => [full(S.turnAndStop(-6, 'busy', w), w + 8), full(S.startAgain(1, w), w)],
    // The change of watch: a context clear with a handoff.
    watch: (w) => [full(S.turnAndStop(-6, 'none', w), 6), full(S.watchArrives(w), 18), full(S.watchChanges(w), 10)],
    // A crash: the ship goes down, calm sea, a fresh ship sails in.
    sink: (w) => [full(S.sailing(-6, 0, w)), full(S.sinking(-6, w), 8), full(S.turnAndStop(-6, 'none', w), 12)],
    fog: (w) => [full(S.fogRollsIn(w, 50), 4), full(S.fogLifts(w), 8)],
    radiate: (w) => [full(S.turnAndStop(-6, 'none', w)), full(S.radiating(w), 24), full(S.burstAndReplace(w), 10)],
  };

  // The usage bar: the ship's place is the value, it breaks down from 90%, then a reset sails it off.
  function barFrames(w) {
    const frames = [];
    for (let v = 8; v <= 100; v += v < 86 ? 3 : 1) {
      const shown = S.barValue(v, w);
      const stage = S.damageStage(shown);
      const x = S.barX(shown, w);
      const sc = S.barScene(w, stage, x, shown + '%').scene;
      frames.push(sc, sc);
    }
    for (let i = 0; i < 10; i++) frames.push(frames[frames.length - 1]);
    const endX = S.barX(100, w);
    for (let x = endX; x > -8; x--) frames.push(S.barLeaving(w, S.WRECK, x));
    for (let x = -6; x <= 0; x++) frames.push(S.barArriving(w, x));
    return frames;
  }

  function framesFor(name, w) {
    if (name === 'bar') return barFrames(w);
    const parts = (stories[name] || stories.voyage)(w);
    const out = [];
    for (const [tl, n] of parts) {
      for (let i = 0; i < n; i++) {
        const k = i < tl.scenes.length ? i : tl.loopFrom + ((i - tl.loopFrom) % (tl.scenes.length - tl.loopFrom || 1));
        out.push(tl.scenes[k]);
      }
    }
    return out;
  }

  const players = [];
  function mount(el) {
    const w = Number(el.dataset.width || S.WIDTH);
    const frames = framesFor(el.dataset.ship, w);
    const offset = Number(el.dataset.offset || 0);
    players.push({ el, frames, offset, speed: Number(el.dataset.speed || 1) });
  }

  let step = 0;
  function tick() {
    step++;
    for (let i = players.length - 1; i >= 0; i--) if (!players[i].el.isConnected) players.splice(i, 1);
    for (const p of players) {
      const k = Math.floor(step * p.speed) + p.offset;
      const scene = p.frames[k % p.frames.length];
      p.el.textContent = S.render(scene, k);
    }
  }

  function init(root = document) {
    root.querySelectorAll('pre[data-ship]:not([data-ship-on])').forEach((el) => {
      el.setAttribute('data-ship-on', '');
      mount(el);
    });
    tick();
  }
  window.LedungShip = { init };
  document.addEventListener('DOMContentLoaded', () => {
    init();
    setInterval(tick, STEP_MS);
  });
})();
