# Issue #295: acceptance test, round 1

PR #298, head `b721bef` (the run-25 worktree, page built from it). Tested on 2026-11-12, 17:41–17:50.

**Setup:** a throwaway Ledung on port 4398 with its own config and data folder (no LAN). I added one throwaway project (an empty git folder in Temp) and started one Haiku test session in it. I drove the page with playwright-core on the installed Chrome, in dark mode, using real mouse drags (`mouse.down`/`move`/`up`). The 1280 px runs used a mouse. The 390 px runs used phone emulation (touch, coarse pointer) with CDP touch events for swipes, plus one 390 px run with a mouse. A request listener counted every `POST /api/resource-limits`, and `/api/machine` gave the stored limits.

The PC showed CPU, Memory, the RTX 4090 (GPU, GPU memory) and an AMD Radeon under "Other GPUs". The GPU bars appear once sampling has caught up, about a minute after start, so they were tested live too.

Screenshots are in [295-acceptance-1/](295-acceptance-1/).

## Points

| # | Point | Result |
|---|---|---|
| 1 | Handle at the limit line; faint at the right end with no limit, shown on hover/focus | **Pass** |
| 2 | Live line + label, snaps 5 % / 1 GB | **Pass** |
| 3 | Release applies at once; reload shows it | **Pass** |
| 4 | Drag all the way right removes the limit | **Pass** |
| 5 | A waiting job starts within seconds when dragged past its need | **Pass** (0.3 s) |
| 6 | Double-click / tap opens the editor, now with a slider, in sync | **Pass** |
| 7 | Keyboard: focusable, ←/→, Home/End, Enter, slider role and label | **Pass** |
| 8 | 390 px: tap opens the editor with a big slider; no overlap, no sideways scroll | **Pass** |
| 9 | Must NOT: graze sets a limit, page scrolls on touch drag, two saves, stuck label | **Pass** |
| 10 | Only the open page can set limits | **Pass** |

### 1. Handle at the limit line — Pass
- No limit: handle opacity 0 at rest ([01a](295-acceptance-1/01a-no-limit-idle.png)), 0.45 on hover, faint at the right end of the CPU bar ([01b](295-acceptance-1/01b-no-limit-hover.png)).
- Focused by keyboard: opacity 1 with an accent outline ([07c](295-acceptance-1/07c-focus-memory-handle.png)).
- With a limit set, the handle sits on the line on every bar: CPU, Memory, GPU, GPU memory ([03c](295-acceptance-1/03c-gpu-limits-applied.png)), and the Radeon's bars under "Other GPUs" ([02f](295-acceptance-1/02f-other-gpus.png)).

### 2. Live line and label, snapping — Pass
- CPU: the label read "CPU 80%" partway, then "CPU 50%", and the line moved with it (`left: calc(50% - 1px)`). Nothing was saved during the drag ([02a](295-acceptance-1/02a-drag-cpu-80.png), [02b](295-acceptance-1/02b-drag-cpu-50.png)).
- Memory: a slow sweep showed every whole GB from "Memory 60 GB" down to "Memory 24 GB", never a fraction ([02c](295-acceptance-1/02c-drag-memory.png)).
- GPU: "GPU 50%" ([02d](295-acceptance-1/02d-drag-gpu-50.png)).
- GPU memory: "GPU memory 10 GB" ([02e](295-acceptance-1/02e-drag-vram.png)).

### 3. Release applies; reload keeps it — Pass
- Release sent exactly one save, `{"dim":"cpu","value":50}`. The server then had `cpu: 50`, the label was gone and the handle said "50%" ([03a](295-acceptance-1/03a-cpu-50-applied.png)).
- After a reload: still 50 % with the line at 50 % ([03b](295-acceptance-1/03b-after-reload.png)).
- GPU 50 % and GPU memory 10 GB also survived a reload.

### 4. Dragging right removes the limit — Pass
- Dragged 40 px past the right end, the label read "CPU No limit" ([04a](295-acceptance-1/04a-drag-off-end.png)).
- Release saved `value: null`, `cpu` left the server's limits, the line went, and the handle read "No limit" ([04b](295-acceptance-1/04b-no-limit-after.png)).

### 5. A waiting job starts when dragged past its need — Pass
- I dragged the Memory limit down to 34 GB (about 40 GB was in use) and had the Haiku session call `reserve` with `ram_gb=4`.
- It got: "Wait: Waiting for memory room: needs ~4.0 GB, 0.0 GB left under the 34 GB limit (1st in line)". The sidebar showed "Waiting for room · 1" ([05a](295-acceptance-1/05a-job-waiting.png)).
- I dragged the Memory handle to "Memory 51 GB" and released: one save (`ram 51`). The line was empty **0.32 s** later and the job showed as going under "Jobs · 1" ([05b](295-acceptance-1/05b-job-going.png)).
- The session received "You may go: reservation r1 "acceptance job" (4.0 GB memory)…" and replied "going".

### 6. Editor with slider — Pass
- A single mouse click on a bar opens nothing.
- A double-click opens "Limit for CPU, for the whole PC" with the slider above the number field, and the field has the focus ([06a](295-acceptance-1/06a-editor-open.png)).
- The field and the slider stay in sync both ways:
  - Typing 35 moved the slider to 35, with "35%" beside it.
  - Dragging the slider with the mouse set the field to 75 without saving anything ([06b](295-acceptance-1/06b-editor-slider-moved.png)).
  - The slider's End key emptied the field and showed "No limit".
- Set sent one save (40) and closed the editor.
- The Memory and GPU-memory editors run 1–63 GB and 1–23 GB with the current value filled in ([06c](295-acceptance-1/06c-memory-editor.png), [06d](295-acceptance-1/06d-vram-editor.png)).
- Enter on a focused bar opens the editor; Escape closes it.
- Tap: see point 8.

### 7. Keyboard — Pass
- The handle has `role="slider"`, `aria-label="CPU limit"`, `aria-valuemin=5`, `aria-valuemax=100`, `aria-valuenow=40`, `aria-valuetext="40%"` and `tabIndex=0`. Tab from the CPU bar lands on it.
- From 40 %, → showed "CPU 45% · Enter sets it" ([07a](295-acceptance-1/07a-key-right.png)), and ←← showed 35 %. Home gave 5 %, End "No limit". No save was sent while keying.
- Enter sent one save (15) and the label went ([07b](295-acceptance-1/07b-key-enter-applied.png)). Focus stayed on the handle.
- → then Escape dropped the change with no save. Arrow keys then clicking elsewhere also dropped it with no save.

### 8. At 390 px — Pass
- Touch (coarse pointer): the handles are hidden (`display: none`) and the bars still show their limit lines ([08a](295-acceptance-1/08a-390-home.png)).
- A tap on the CPU bar opened the editor. The slider is full width and 38 px tall, and the number field did **not** take the focus, so no keyboard pops up ([08b](295-acceptance-1/08b-390-editor.png)).
- A touch drag on the slider set 30 % in the field without saving and without scrolling the page ([08c](295-acceptance-1/08c-390-slider-dragged.png)). A tap on Set sent one save ([08d](295-acceptance-1/08d-390-applied.png)).
- A touch drag to the slider's right end gave "No limit" ([08e](295-acceptance-1/08e-390-memory-no-limit.png)). The GPU-memory editor works the same way ([08f](295-acceptance-1/08f-390-vram-editor.png)).
- A second tap on the open bar closes the editor.
- `scrollWidth` was 390 = `clientWidth` throughout, and nothing overlapped.
- At 390 px with a mouse, double-click opens the same editor, with a 38 px slider and no sideways scroll ([08g](295-acceptance-1/08g-390-mouse-editor.png)).

### 9. Must NOT — Pass
- **Graze:** a press on the handle that moved 2 px saved nothing, set no limit and left no label. A hover sweep across the bar saved nothing. A press that went 20 px and came back to the same value saved nothing.
- **Touch swipes:** a horizontal swipe and a vertical swipe on the thin bar on the phone set nothing and opened nothing.
- **Page scroll while dragging on touch:** scrollY stayed 0 during the slider touch drag, and the handle isn't there on touch. Caveat: the phone sidebar was short enough not to scroll at all, so this shows there's no sideways scroll but can't fully prove there's no vertical scroll on a long page.
- **Two saves:** a 30-step drag saved exactly once. So did a drag released far below the bar (y = 850), every keyboard Enter, and every Set.
- **Stuck label:** the label was gone after every release, after Escape during a drag (which also saved nothing), after Enter, and on blur.

### 10. Only the open page sets limits — Pass
- With the sign-in cookie and the right Origin but no page key: `POST /api/resource-limits` gave **403** "Only Ledung's open page can do this…". A wrong `X-Ledung-Page` gave 403, no Origin gave 403, and no cookie gave 401.
- Sessions have no tool that sets a limit (`reserve` and `release` only).
- The server code for the route is unchanged in this PR.

## Things a person might notice (no point covers them)
1. **The drag label covers the bar's heading while dragging.** It sits about 9 px above the track, right over the bar's name and its percentage (e.g. "Memory … 65%" is hidden under "Memory 24 GB"; [02c](295-acceptance-1/02c-drag-memory.png), [02e](295-acceptance-1/02e-drag-vram.png)). It only lasts while dragging, but those are the figures you'd glance at while choosing a limit.
2. **The memory slider's right end is "No limit" one step early.** The far end is the total rounded *down* to whole GB, and reaching it means "No limit". The RTX 4090 shows "24 GB" but reports 23.57 GB, so the slider runs 1–23 and dragging to 23 means No limit: the highest limit you can drag to is 22 GB. Likewise 62 GB on the 63.1 GB of RAM. The number field still accepts 23 GB or 23.5 GB.
3. **A GPU with under 1 GB of memory can only get a meaningless limit.** The AMD Radeon (486 MB) has a slider from 1 to 1. Home → Enter saved a **1 GB** limit, which is more than the card has, and the line sits at the far end ([09](295-acceptance-1/09-small-gpu-memory.png)). This is a rare edge case for an integrated GPU folded under "Other GPUs".
4. On desktop, a single click on a bar now does nothing (double-click opens the editor). This is as designed, but someone used to the old single click gets no hint apart from the tooltip ("double-click or tap to set its limit, or drag its handle").

## Not tested
- A real phone or Safari (Chrome's phone emulation only). A touchscreen laptop (fine pointer plus touch), where the handle stays visible and could be touch-dragged.
- Light mode (not part of this change).

## Cleanup
- I stopped the test Ledung by the process on port 4398 (PID 126400), and its session host by the command line containing the test data folder (PID 107748 and its children).
- No process with the test folder in its command line is left, and nothing listens on 4398.

## Verdict

**Passes**: all 10 points pass. Notes 1–3 above are small polish items for the coordinator to weigh. None blocks a point.
