// Draws Ledung's page as HTML scenes inside <div class="lui" data-scene="..." data-theme="dark|light">.
// Every name, project and message is invented. The ships inside are live (ship.js).
(function () {
  const ship = (story, width, extra = '') => `<pre data-ship="${story}" data-width="${width}" ${extra}></pre>`;
  const chrome = (title) => `<div class="chrome"><i></i><i></i><i></i><b>${title}</b></div>`;

  const sidebar = (sel = 'mgr') => `
  <div class="side">
    <div class="row"><span class="btn">Overview</span><span class="btn">Usage · 412k today</span><span class="btn">Board</span></div>
    <div><div class="row small" style="justify-content:space-between"><span>5-hour</span><span class="muted">≈ 61% by reset</span></div>${ship('bar', 30, 'data-offset="20"')}<div class="small muted">resets in 2 h 10 min</div></div>
    <div class="grid2" style="gap:8px">
      <div><div class="row small" style="justify-content:space-between"><span>CPU</span><b class="ok">38%</b></div><div class="meter"><span style="--a:30%;--b:52%"></span></div><div class="small muted">3.0 cores of 8</div></div>
      <div><div class="row small" style="justify-content:space-between"><span>Memory</span><b style="color:var(--wait)">71%</b></div><div class="meter warn"><span style="--a:64%;--b:76%"></span></div><div class="small muted">11 GB of 16 GB</div></div>
    </div>
    <div class="small"><b>3</b> of <span class="tag">10</span> working</div>
    <div class="waiting"><span>Waiting for you</span><b style="color:var(--wait)">2</b></div>
    <div class="row" style="justify-content:space-between;margin-top:4px"><span class="proj" style="color:var(--s1)">garden-api</span><span class="btn small">+ Session</span></div>
    <div class="sess ${sel === 'mgr' ? 'sel' : ''}"><span class="dot run"></span><div class="t"><div><span class="tag">Manager</span> Manager: garden-api</div><div class="small muted">working · 2 sessions · 188k today</div></div>${ship('voyage', 14, 'style="font-size:6px"')}</div>
    <div class="sess child"><span class="dot run"></span><div class="t"><div>fix-retry-timeout</div><div class="small muted">running tests · 1.4 cores</div></div>${ship('solo', 12, 'style="font-size:6px" data-offset="9"')}</div>
    <div class="sess child ${sel === 'q' ? 'sel' : ''}"><span class="dot wait"></span><div class="t"><div>review PR #41</div><div class="small" style="color:var(--wait)">waiting for you</div></div>${ship('busy', 12, 'style="font-size:6px" data-offset="4"')}</div>
    <div class="row" style="justify-content:space-between;margin-top:4px"><span class="proj" style="color:var(--s3)">recipe-site</span><span class="btn small">+ Session</span></div>
    <div class="sess"><span class="dot idle"></span><div class="t"><div><span class="tag">Manager</span> Manager: recipe-site</div><div class="small muted">idle · 24k today</div></div>${ship('watch', 14, 'style="font-size:6px"')}</div>
    <div style="flex:1"></div>
    <div class="row small muted" style="justify-content:space-between"><span class="btn">⚙</span><span>Connected</span></div>
  </div>`;

  const scenes = {
    main: () => `${chrome('Ledung — localhost')}
    <div class="body">${sidebar('mgr')}
      <div class="main">
        <div class="head"><div><div class="row"><span class="tag">Manager</span><h3>Manager: garden-api</h3></div>
          <div class="small muted row" style="margin-top:4px"><span class="dot run"></span> Working · 2 sessions · 0.6 cores · claude-sonnet · Remote Control on</div></div>
          <div class="row"><span class="btn">Away…</span><span class="btn">Usage · 188k</span><span class="btn">⚙</span></div></div>
        <div class="chat">
          <div class="msg you"><div class="who">You<span>14:02</span></div><div class="b">The retry fix and the review of #41 — run both, tell me when there is something to decide.</div></div>
          <div class="msg"><div class="who">Claude<span>14:02</span></div><div class="b">Started two sessions: <b>fix-retry-timeout</b> (worktree, writes the fix and its test) and <b>review PR #41</b> (reads only). I'll answer their ordinary permission prompts; anything touching production goes to you.</div></div>
          <div class="delivered">Delivered by Ledung · fix-retry-timeout finished a turn: <code>npm test</code> 212 passed · 14:19</div>
          <div class="delivered">Delivered by Ledung · review PR #41 asked you a question (Blocks a finished PR) · 14:21</div>
          <div class="msg"><div class="who">Claude<span>14:21</span></div><div class="b">The fix is green. The reviewer wants your call on merge order — it's in <b>Waiting for you</b>.</div></div>
        </div>
        <div class="status"><div class="shipbig">${ship('voyage', 26)}</div><span class="small"><b>Working</b> · 2 sessions under way · 14:22</span></div>
        <div class="compose"><div class="box typing">Message Claude</div><span class="btn primary">Send</span></div>
      </div>
    </div>`,

    desk: () => `${chrome('Ledung — Waiting for you')}
    <div class="body">
      <div class="side" style="width:300px">
        <h3 style="margin:2px 0 4px">Waiting for you</h3>
        <div class="tier">Blocks a finished PR · 1</div>
        <div class="qrow sel"><span class="dot wait"></span><div class="t"><div>Merge #41 before the retry fix?</div><div class="small muted">garden-api · 4 min ago</div></div></div>
        <div class="tier">Blocks a card from Ready · 1</div>
        <div class="qrow"><span class="dot wait"></span><div><div>Which image format for thumbnails?</div><div class="small muted">recipe-site · 22 min ago</div></div></div>
        <div class="tier">Housekeeping · 0</div>
        <div class="tier">Record only · 3</div>
        <div class="qrow"><span class="dot ended"></span><div class="muted">Renamed the test fixtures</div></div>
        <div style="flex:1"></div>
        <div class="shipbig">${ship('busy', 30)}</div>
      </div>
      <div class="main" style="padding:18px 22px;gap:12px">
        <div class="small muted">garden-api · asked by review PR #41 · Blocks a finished PR</div>
        <h2 style="margin:0;font-size:21px">Merge #41 before the retry fix?</h2>
        <div class="card"><b>The issue.</b> Both change the HTTP client. Merging #41 first means the retry fix needs a small rebase; the other way round, #41's tests need one new case.</div>
        <div class="card small muted">▸ Evidence: both branches green; conflict is 6 lines in <code>client.ts</code></div>
        <div class="opt rec"><b>Merge #41 first (recommended)</b> <span class="muted">— rebase costs ~5 min, the fix waits</span></div>
        <div class="opt"><b>Retry fix first</b> <span class="muted">— #41 gets one more test</span></div>
        <div class="opt"><b>Hold both</b> <span class="muted">— until the load test tonight</span></div>
        <div class="row small"><span class="tag">Reviewer → first</span><span class="tag">Manager → first</span></div>
        <div class="compose" style="padding:0"><div class="box typing">Your answer goes straight to the session that asked</div><span class="btn primary">Answer</span></div>
      </div>
    </div>`,

    permission: () => `${chrome('Ledung — permission')}
    <div class="body">${sidebar('q')}
      <div class="main" style="padding:18px 22px;gap:14px">
        <div class="delivered">fix-retry-timeout · <b>Allowed by Manager: garden-api</b> · <code>npm test -- client</code> · 14:12</div>
        <div class="delivered">fix-retry-timeout · <b>Allowed by Manager: garden-api</b> · <code>git push origin am/fix-retry-timeout</code> · 14:18</div>
        <div class="card sensitive">
          <div class="row" style="justify-content:space-between"><b style="color:var(--danger)">⚑ Sensitive — this always reaches you</b><span class="small muted">a manager can never approve it</span></div>
          <div style="margin:10px 0 6px">review PR #41 wants to run</div>
          <div><code style="font-size:13px;padding:6px 10px;display:block">kubectl rollout restart deploy/api --context production</code></div>
          <div class="small muted" style="margin:8px 0 12px">Marked sensitive by this project's rules: production.</div>
          <div class="row"><span class="btn primary">Allow once</span><span class="btn danger">Deny</span><span class="btn">Deny and say why…</span></div>
        </div>
        <div class="card warn small">Away until 20:00 · the manager answers ordinary prompts within your grant and labels each decision. Sensitive calls wait here for you.</div>
        <div style="flex:1"></div>
        <div class="status" style="padding:6px 0"><div class="shipbig">${ship('solo', 26, 'data-offset="40"')}</div><span class="small"><b>Waiting</b> · for your decision · 14:24</span></div>
      </div>
    </div>`,

    usage: () => `${chrome('Ledung — Overview')}
    <div class="body">
      <div class="main" style="padding:18px 22px;gap:14px">
        <div class="row" style="justify-content:space-between"><h2 style="margin:0">Overview</h2><span class="small muted">3 of 10 working · 2 waiting in line</span></div>
        <div class="grid2">
          <div class="card"><div class="row" style="justify-content:space-between"><b>5-hour window</b><span class="small muted">resets 16:30</span></div><div class="shipbig">${ship('bar', 40)}</div></div>
          <div class="card"><div class="row" style="justify-content:space-between"><b>7-day window</b><span class="small muted">resets Mon 10:00</span></div><div class="shipbig">${ship('bar', 40, 'data-offset="60"')}</div></div>
        </div>
        <div class="card">
          <div class="row" style="justify-content:space-between;margin-bottom:8px"><b>Tokens today, rolled up</b><span class="small muted">412k</span></div>
          ${[['Manager: garden-api', 188, 'run', ''], ['fix-retry-timeout', 96, 'run', 'child'], ['review PR #41', 61, 'wait', 'child'], ['Manager: recipe-site', 24, 'idle', ''], ['thumbnails-spike', 43, 'ended', 'child']]
            .map(([n, k, d, c]) => `<div class="row" style="padding:4px 0;${c ? 'padding-left:20px' : ''}"><span class="dot ${d}"></span><span style="width:200px">${n}</span><div class="meter" style="flex:1"><span style="--a:${k / 2.2}%;--b:${k / 2}%"></span></div><span class="small muted" style="width:50px;text-align:right">${k}k</span></div>`).join('')}
        </div>
        <div class="grid2">
          <div class="card"><b>Machine</b><div class="row small" style="margin-top:8px"><span style="width:60px">CPU</span><div class="meter" style="flex:1"><span style="--a:28%;--b:55%"></span></div></div><div class="row small" style="margin-top:6px"><span style="width:60px">Memory</span><div class="meter warn" style="flex:1"><span style="--a:62%;--b:74%"></span></div></div></div>
          <div class="card"><b>The fleet</b><div class="shipbig" style="margin-top:6px">${ship('voyage', 40, 'data-offset="12"')}</div></div>
        </div>
      </div>
    </div>`,

    update: () => `${chrome('Ledung — Settings')}
    <div class="body">
      <div class="side" style="width:220px"><b>Settings</b><div class="muted">Accounts</div><div class="muted">Add project</div><div class="muted">Notifications</div><div class="muted">Board</div><div><b>Update Ledung</b></div><div class="muted">Restart Ledung</div></div>
      <div class="main" style="padding:18px 22px;gap:12px">
        <h2 style="margin:0">Update Ledung</h2>
        <div class="card"><b>4 changes new on main</b>
          <ul class="small" style="margin:8px 0 0;padding-left:18px;line-height:1.7"><li>Waiting for you groups questions by tier</li><li>A session just started shows as Ready</li><li>Drag projects into the order you want</li><li>PNG and JPEG images open in the file panel</li></ul></div>
        <div class="card steps small"><div><span class="ok">✓</span> git pull --ff-only</div><div><span class="ok">✓</span> npm install</div><div><span class="spin">◐</span> npm run release</div><div class="muted">○ restart — sessions keep running through it</div></div>
        <div class="row"><span class="btn">Check for updates</span><span class="btn primary">Update Ledung</span></div>
        <div style="flex:1"></div>
        <div class="shipbig">${ship('watch', 40)}</div>
        <div class="small muted">Refuses, and leaves the running Ledung alone, on uncommitted changes or anything that isn't a fast-forward.</div>
      </div>
    </div>`,
  };

  function fit(el) {
    const stage = el.firstElementChild;
    const k = el.clientWidth / 1200;
    stage.style.transform = `scale(${k})`;
    if (!el.dataset.keepHeight) el.style.height = 760 * k + 'px';
  }

  function build() {
    document.querySelectorAll('.lui[data-scene]').forEach((el) => {
      el.innerHTML = `<div class="lui-stage">${scenes[el.dataset.scene]()}</div>`;
      fit(el);
      new ResizeObserver(() => fit(el)).observe(el);
    });
    // Free-standing ships elsewhere on the page are mounted by ship.js on DOMContentLoaded; these are new.
    if (window.LedungShip) window.LedungShip.init();
  }
  document.addEventListener('DOMContentLoaded', build);
})();
