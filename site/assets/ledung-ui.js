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

  // The sidebar as it is today: limit meters on top, Waiting for you, projects, and a footer of ⚙ and the Usage chip.
  const sidebarNow = (computer = '') => `
  <div class="side">
    <div><div class="row small" style="justify-content:space-between"><span>5-hour</span><span class="muted">≈ 48% by reset</span></div>${ship('bar', 30, 'data-offset="30"')}</div>
    <div class="waiting"><span>Waiting for you</span><b style="color:var(--wait)">2</b></div>
    <div class="row" style="justify-content:space-between;margin-top:4px"><span class="proj" style="color:var(--s2)">photo-archive</span><span class="btn small">+ Session</span></div>
    <div class="sess sel"><span class="dot run"></span><div class="t"><div><span class="tag">Manager</span> Manager: photo-archive</div><div class="small muted">working · 1 session${computer}</div></div>${ship('voyage', 14, 'style="font-size:6px"')}</div>
    <div class="sess child"><span class="dot wait"></span><div class="t"><div>resize-thumbnails</div><div class="small" style="color:var(--wait)">waiting for you</div></div>${ship('busy', 12, 'style="font-size:6px"')}</div>
    <div style="flex:1"></div>
    <div class="row small" style="justify-content:space-between"><span class="btn">⚙</span><span class="chip">Usage · 96k today</span></div>
  </div>`;

  // A phone: the list is the start screen, Waiting for you first (issue #171); "Remote" in the frame through the relay.
  const phoneTop = (t = '21:47') => `<div class="statusbar"><b>${t}</b><span>▂▄▆ ◔</span></div>`;

  Object.assign(scenes, {
    phone: () => `${phoneTop()}<div class="remote-band">Remote</div>
    <div class="pbody">
      <div class="waiting" style="padding:12px 14px;font-size:16px"><span>Waiting for you</span><b style="color:var(--wait)">2</b></div>
      <div><div class="row small" style="justify-content:space-between"><span>5-hour</span><span class="muted">≈ 61% by reset</span></div>${ship('bar', 30, 'data-offset="20"')}</div>
      <div class="small"><b>3</b> of <span class="tag">10</span> working</div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span class="proj" style="color:var(--s1)">garden-api</span><span class="btn">+ Session</span></div>
      <div class="sess"><span class="dot run"></span><div class="t"><div><span class="tag">Manager</span> Manager: garden-api</div><div class="small muted">working · 2 sessions</div></div>${ship('voyage', 12, 'style="font-size:6px"')}</div>
      <div class="sess child"><span class="dot run"></span><div class="t"><div>fix-retry-timeout</div><div class="small muted">running tests</div></div></div>
      <div class="sess child"><span class="dot wait"></span><div class="t"><div>review PR #41</div><div class="small" style="color:var(--wait)">waiting for you</div></div></div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span class="proj" style="color:var(--s3)">recipe-site</span><span class="btn">+ Session</span></div>
      <div class="sess"><span class="dot idle"></span><div class="t"><div><span class="tag">Manager</span> Manager: recipe-site</div><div class="small muted">idle</div></div>${ship('watch', 12, 'style="font-size:6px"')}</div>
      <div style="flex:1"></div>
      <div class="row small" style="justify-content:space-between"><span class="btn">⚙</span><span class="chip">Usage · 412k today</span></div>
    </div>`,

    // The words are the service worker's own (web/public/sw.js): the computer and the kind, never the text.
    push: () => `${phoneTop('21:52')}
    <div class="lock"><div class="clock">21:52</div><div class="muted" style="font-size:15px">Sunday 1 November</div></div>
    <div class="notes">
      <div class="note"><div class="row"><span class="app-ic"></span><b>Laptop</b><span class="muted small" style="margin-left:auto">now</span></div><div>A question is waiting for you</div></div>
      <div class="note"><div class="row"><span class="app-ic"></span><b>Studio PC</b><span class="muted small" style="margin-left:auto">4 min ago</span></div><div>A permission prompt is waiting for you</div></div>
      <div class="note" style="opacity:.7"><div class="row"><span class="app-ic"></span><b>Laptop</b><span class="muted small" style="margin-left:auto">38 min ago</span></div><div>A question is waiting for you</div></div>
    </div>
    <div style="flex:1"></div>
    <div class="row" style="justify-content:space-between;padding:0 40px 30px;font-size:22px"><span class="lockbtn"></span><span class="lockbtn"></span></div>`,

    linked: () => `${chrome('Ledung — localhost')}
    <div class="ctabs"><span class="ctab on" style="--c:#7aa2f7">Laptop</span><span class="ctab" style="--c:#b48ead">Studio PC <b class="badge">2</b></span><span class="ctab" style="--c:#4fb3a9">Home server</span></div>
    <div class="body cframe" style="--c:#b48ead">${sidebarNow(' · on Studio PC')}
      <div class="main">
        <div class="head"><div><div class="row"><span class="tag">Manager</span><h3>Manager: photo-archive</h3></div>
          <div class="small muted row" style="margin-top:4px"><span class="dot run"></span> Working · 1 session · on Studio PC</div></div></div>
        <div class="chat">
          <div class="delivered">Delivered by Ledung · message from Manager: garden-api, on Laptop · 21:30</div>
          <div class="msg"><div class="who">Claude<span>21:31</span></div><div class="b">garden-api on the laptop needs the new thumbnail sizes. I'll start <b>resize-thumbnails</b> here, where the photos are, and tell its manager when it's done.</div></div>
          <div class="delivered">Delivered by Ledung · resize-thumbnails asked you a question (Blocks a card from Ready) · 21:44</div>
        </div>
        <div class="status"><div class="shipbig">${ship('voyage', 26, 'data-offset="8"')}</div><span class="small"><b>Working</b> · 1 session under way</span></div>
      </div>
    </div>`,

    board: () => `${chrome('Ledung — Board')}
    <div class="body">
      <div class="side" style="width:330px">
        <div class="row"><span class="btn">All projects ▾</span><span class="btn">All boards ▾</span><span class="btn">Unread</span></div>
        <div class="qrow sel"><span class="dot run"></span><div><div><b>API change for /plants</b></div><div class="small muted">garden-api ↔ @sam · 3 posts · 12 min ago</div></div></div>
        <div class="qrow"><span class="dot idle"></span><div><div>Shared test fixtures</div><div class="small muted">recipe-site ↔ @alex · 5 posts · yesterday</div></div></div>
        <div class="qrow"><span class="dot ended"></span><div class="muted"><div>Release window next week</div><div class="small">#releases · 2 posts · Friday</div></div></div>
        <div style="flex:1"></div>
        <div class="shipbig">${ship('watch', 30, 'data-offset="25"')}</div>
      </div>
      <div class="main" style="padding:16px 22px;gap:12px">
        <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-size:20px">API change for /plants</h2><span class="small muted">team-board · on GitHub ↗</span></div>
        <div class="msg"><div class="who">Manager: garden-api <span>sent by you · to @sam's front desk · 21:02</span></div><div class="b">We're renaming <code>water_ml</code> to <code>water</code> with a unit. Does the planner app read it?</div></div>
        <div class="msg"><div class="who">@sam's Manager: planner-app <span>21:09</span></div><div class="b">It does, in two places. Can you keep the old field for one release? I'll switch over this week.</div></div>
        <div class="msg"><div class="who">Manager: garden-api <span>held for you before it left · 21:14</span></div><div class="b">Yes: both fields until 2.4. Attached the changed response.</div>
          <div class="row small" style="margin-top:6px"><span class="tag">response.json</span><span class="tag">plants-before-after.png</span></div></div>
      </div>
    </div>`,

    review: () => `${chrome('Ledung — Waiting for you')}
    <div class="body">
      <div class="main" style="padding:18px 22px;gap:12px">
        <div class="row"><span class="tag" style="color:var(--accent);border-color:var(--accent)">Review</span><span class="small muted">garden-api · Blocks a finished PR</span></div>
        <h2 style="margin:0;font-size:21px">Retry fix for slow uploads</h2>
        <div class="grid2">
          <div class="card"><b>What we were solving</b><div class="small muted" style="margin-top:4px">Uploads over a slow line gave up after one try and lost the photo.</div></div>
          <div class="card"><b>What was done</b><div class="small muted" style="margin-top:4px">Three tries with a growing wait; the page says "retrying" meanwhile.</div></div>
        </div>
        <b>Evidence</b>
        <div class="row" style="gap:12px;align-items:stretch">
          <div class="shot"><div class="shot-img"><div class="bar1"></div><div class="bar2"></div><div class="spin-txt">⟳ retrying 2 of 3…</div></div><div class="row small" style="gap:6px;margin-top:6px"><span class="btn" style="border-color:var(--ok);color:var(--ok)">Pass</span><span class="btn">Fail</span><span class="btn">Unsure</span></div></div>
          <div class="card small" style="flex:1"><div class="muted">upload-test.log</div><code style="display:block;margin-top:6px;white-space:pre">try 1: timeout after 10 s
try 2: timeout after 20 s
try 3: 201 Created</code></div>
        </div>
        <div style="flex:1"></div>
        <div class="row"><span class="btn primary">Accept</span><span class="btn">Changes needed…</span></div>
      </div>
    </div>`,
  });

  // Phone scenes sit in a phone-shaped stage of their own size.
  const PHONE = new Set(['phone', 'push']);

  function fit(el) {
    const stage = el.firstElementChild;
    const k = el.clientWidth / stage.offsetWidth;
    stage.style.transform = `scale(${k})`;
    if (!el.dataset.keepHeight) el.style.height = stage.offsetHeight * k + 'px';
  }

  function build() {
    document.querySelectorAll('.lui[data-scene]').forEach((el) => {
      el.innerHTML = `<div class="lui-stage${PHONE.has(el.dataset.scene) ? ' phone' : ''}">${scenes[el.dataset.scene]()}</div>`;
      fit(el);
      new ResizeObserver(() => fit(el)).observe(el);
    });
    // Free-standing ships elsewhere on the page are mounted by ship.js on DOMContentLoaded; these are new.
    if (window.LedungShip) window.LedungShip.init();
  }
  document.addEventListener('DOMContentLoaded', build);
})();
