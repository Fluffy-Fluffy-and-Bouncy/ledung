// Loopback for issue #158: managers (Haiku) on two linked throwaway Ledungs send each other files through a real
// relay, end to end: a PNG and a log from the Mac's manager to the PC's, which shows the PNG in a question and gives
// the log as a review's evidence; a screenshot from a worktree on the PC back to the Mac's manager, in its question;
// the refusals, a locked project, the PC off; and the bytes in Settings. Not in CI (two Ledungs, a few Haiku turns).
//
//   node test/loopback/link-files.ts              # ports 4396 and 4397
//   PLAYWRIGHT=/path/to/playwright-core CHROMIUM=/path/to/chrome node test/loopback/link-files.ts   # with screenshots (dark)
//
// The two Ledungs, the relay and the front: linked-pair.ts. Shots and logs land in .test/link-files.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { check, failed, link, type Page, repo, startPair, until } from './linked-pair.ts';

const work = path.join(repo, '.test', 'link-files');
const TURN_MS = 240_000;

/** A real PNG, w × h of one colour, so a browser shows it. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A session's history as plain text: quotes inside nested JSON (tool results) come out escaped once or twice.
const messages = async (page: Page, id: string) => JSON.stringify((await page.api('GET', `sessions/${id}/messages?limit=500`)).json).replace(/\\+"/g, '"').replace(/\\+n/g, '\n');
const state = async (page: Page) => (await page.api('GET', 'state')).json as { sessions: { id: string; status: string }[]; questions: { id: number; sessionId: string; question: string; shots: { path: string }[] | null; details: any }[] };
const idle = (page: Page, id: string, what: string) => until(async () => (await state(page)).sessions.find((s) => s.id === id)?.status === 'idle', what, TURN_MS);
const raw = async (page: Page, route: string) => {
  const res = await fetch(`${page.origin}/api/${route}`, { headers: { Cookie: `ledung_auth=${page.token}` } });
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
};
const linkedFiles = (data: string) => {
  const dir = path.join(data, 'linked-files');
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(png|jpg|txt)$/.test(f)) : [];
};
/**
 * The manager's question with a screenshot. Haiku now and then calls ask_user without the screenshots it was told to
 * give (seen in a run of this loopback: the call's input had no screenshots at all); then it is told the handle once
 * more, and asked again. What is checked is Ledung's part: the handle taken, the image shown.
 */
async function shotQuestion(page: Page, id: string, handle: string, title: string) {
  const find = async () => (await state(page)).questions.find((q) => q.sessionId === id && q.shots?.length) ?? null;
  await idle(page, id, `${title}: the manager's turn`);
  if (!(await find())) {
    console.log(`(the manager asked without the screenshot; telling it the handle again: ${handle})`);
    await page.api('POST', `sessions/${id}/messages`, {
      text: `Your question had no screenshot. Call ask_user once more with tier "Record only", title "${title}", question "Does it show?", and the parameter screenshots set to exactly [{"file": "${handle}", "look_for": "the rectangle"}]. Then stop.`,
    });
  }
  return until(find, `${title}: a question with the screenshot`, TURN_MS);
}

/**
 * Whether a WebP shows exactly the pixels of a PNG (issue #306: a question keeps its screenshot as a lossless WebP), by
 * the codecs' own decoders.
 */
async function samePixels(png: Buffer, webp: Buffer): Promise<boolean> {
  const wasm = (spec: string) => WebAssembly.compile(fs.readFileSync(fileURLToPath(import.meta.resolve(spec))));
  const own = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
  const p = await import('@jsquash/png/decode.js');
  await p.init(await wasm('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
  const w = await import('@jsquash/webp/decode.js');
  await (w.init as unknown as (m: WebAssembly.Module) => Promise<void>)(await wasm('@jsquash/webp/codec/dec/webp_dec.wasm'));
  const a = await p.decode(own(png)) as unknown as { data: Uint8ClampedArray; width: number; height: number };
  const b = await w.default(own(webp)) as unknown as { data: Uint8ClampedArray; width: number; height: number };
  return a.width === b.width && a.height === b.height && Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength).equals(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength));
}

const filesOf = async (page: Page) => (await page.api('GET', 'links')).json.links[0].files as { today: { sent: number; received: number }; month: { sent: number; received: number } };

/** A page in a browser, dark, if one was given: the question view, or Settings → Linked computers. */
async function shot(page: Page, hash: string, file: string, section?: string): Promise<boolean> {
  if (!process.env.PLAYWRIGHT || !process.env.CHROMIUM) return false;
  const mod = await import(process.env.PLAYWRIGHT) as { chromium?: any; default?: { chromium: any } };
  const chromium = mod.chromium ?? mod.default!.chromium;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'dark' });
    const tab = await ctx.newPage();
    await tab.goto(`${page.origin}/login?token=${page.token}`);
    await tab.goto(`${page.origin}/#/${hash}`);
    if (section) {
      const s = tab.locator('section', { has: tab.locator('h3', { hasText: section }) });
      await s.waitFor();
      await s.screenshot({ path: path.join(work, 'shots', file) });
    } else {
      const found = await tab.locator('img[src*="kept%3A"]').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await tab.waitForTimeout(500);
      await tab.screenshot({ path: path.join(work, 'shots', file) });
      if (!found) {
        console.log(`(no kept image on ${hash}; at ${tab.url()}, images: ${JSON.stringify(await tab.locator('img').evaluateAll((els: { src: string }[]) => els.map((e) => e.src)))})`);
        return false;
      }
    }
    return true;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const project = (name: string, extra: Record<string, unknown> = {}) => ({ name, runner: 'local', path: path.join(work, `project-${name}`), model: 'haiku', managerModel: 'haiku', permissionMode: 'default', ...extra });
  const sensitive = { sensitive: { commandPatterns: [], pathPatterns: ['private-notes'], mcpTools: [] } };
  const pair = await startPair(work, {
    mac: [project('Alpha'), project('Island', { lockdown: { level: 'A' } })],
    pc: [project('Beta'), project('Fort', { lockdown: { level: 'A' } })],
  }, { ports: { mac: 4396, pc: 4397 }, config: { mac: sensitive, pc: sensitive } });
  const { mac, pc } = pair.pages;
  const alphaDir = path.join(work, 'project-Alpha');
  const betaDir = path.join(work, 'project-Beta');
  const islandDir = path.join(work, 'project-Island');
  // The files: a screenshot and a 6,000-character log on the Mac; a worker's screenshot in a worktree on the PC.
  const shotPng = png(320, 180, [40, 140, 220]);
  const log = Array.from({ length: 200 }, (_, i) => `step ${String(i + 1).padStart(3, '0')} ok: ${'x'.repeat(16)}`).join('\n');
  fs.writeFileSync(path.join(alphaDir, 'shot.png'), shotPng);
  fs.writeFileSync(path.join(alphaDir, 'run.log'), log);
  const cartPng = png(240, 160, [220, 120, 40]);
  fs.mkdirSync(path.join(betaDir, '.claude', 'worktrees', 'fix-1'), { recursive: true });
  fs.writeFileSync(path.join(betaDir, '.claude', 'worktrees', 'fix-1', 'cart.png'), cartPng);
  // What must be refused.
  fs.writeFileSync(path.join(work, 'outside.png'), shotPng);
  fs.writeFileSync(path.join(alphaDir, '.env'), 'X=1');
  fs.mkdirSync(path.join(alphaDir, 'private-notes'), { recursive: true });
  fs.writeFileSync(path.join(alphaDir, 'private-notes', 'a.png'), shotPng);
  fs.writeFileSync(path.join(alphaDir, 'secret.log'), 'db password: hunter2-loopback-158\n');
  fs.writeFileSync(path.join(alphaDir, 'big.png'), Buffer.concat([shotPng, Buffer.alloc(5 * 1024 * 1024)]));
  fs.writeFileSync(path.join(alphaDir, 'big.log'), 'y'.repeat(512 * 1024 + 1));
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(alphaDir, `n${i}.log`), `file ${i}`);
  fs.writeFileSync(path.join(islandDir, 'ok.png'), shotPng);
  try {
    console.log('== 1. Link, and start the PC\'s managers ==');
    await link(pair.pages);
    check(true, 'linked through the relay');
    const beta = (await pc.api('POST', 'projects/Beta/manager', {
      text: 'Test manager in a Ledung loopback. Reply with the single word "ready" and stop. Later a manager on another computer will message you with two files, each given as a file name in quotes starting with "linked:". Then do exactly this, nothing else: '
        + '(1) call ask_user with tier "Record only", title "Screenshot from the Mac", question "Does the screenshot show?", and screenshots [{"file": <the PNG\'s linked: name, exactly>, "look_for": "a blue rectangle"}]; '
        + '(2) call ask_user with tier "Record only", title "Log from the Mac", and review {"solving": "loopback", "done": "loopback", "evidence": [{"file": <the log\'s linked: name, exactly>, "caption": "the log"}]}; '
        + '(3) call message_manager to that manager, with computer "Mac", text "pong", and attachments [".claude/worktrees/fix-1/cart.png"]; then stop.',
    })).json;
    await idle(pc, beta.id, 'Beta to be ready');
    const fort = (await pc.api('POST', 'projects/Fort/manager', { text: 'Test manager in a Ledung loopback. Reply "ready" and stop. Use no tools.' })).json;
    await idle(pc, fort.id, 'Fort to be ready');
    check(true, 'Beta and Fort are idle', `${beta.id} ${fort.id}`);

    console.log('== 2. The Mac\'s manager sends a PNG and a log to Beta on the PC ==');
    const alpha = (await mac.api('POST', 'projects/Alpha/manager', {
      text: `Test manager in a Ledung loopback. Call message_manager once: id "${beta.id}", computer "PC", text "ping with files", attachments ["shot.png", "run.log"]. Then wait. When Beta answers with a file named in quotes starting with "linked:", call ask_user with tier "Record only", title "Screenshot from the PC", question "Does the cart show?", and screenshots [{"file": <that linked: name, exactly>, "look_for": "an orange rectangle"}]. Then stop.`,
    })).json;
    const atBeta = await until(async () => { const m = await messages(pc, beta.id); return m.includes('Files sent with it') ? m : null; }, 'the files at Beta', TURN_MS);
    const pngHandle = /"(linked:[0-9a-f]{16}\/shot\.png)"/.exec(atBeta)?.[1];
    const logHandle = /"(linked:[0-9a-f]{16}\/run\.log)"/.exec(atBeta)?.[1];
    check(!!pngHandle && !!logHandle, 'Beta\'s message lists both files, with a linked: handle each', `${pngHandle} ${logHandle}`);
    check(atBeta.includes('step 001 ok') && atBeta.includes(`[cut by Ledung: ${log.length - 4000} more characters in the file]`), 'the log is inline, cut at 4,000 characters', `${log.length} characters`);
    check(linkedFiles(pair.pages.pc.data).length === 2 && linkedFiles(pair.pages.mac.data).length === 0, 'two copies kept on the PC, none on the Mac');
    check((await state(mac)).questions.length === 0, 'nothing was asked of Martin on the Mac before the files left');

    console.log('== 3. Beta asks with the PNG as a screenshot and the log as a review\'s evidence ==');
    const reviewQ = await until(async () => (await state(pc)).questions.find((q) => q.sessionId === beta.id && q.details?.review) ?? null, 'Beta\'s review', TURN_MS);
    const shotQ = await shotQuestion(pc, beta.id, pngHandle!, 'Screenshot from the Mac');
    // Kept as the question's own copy (issue #306), so it outlives the linked copy, as a lossless WebP.
    const shotRef = shotQ.shots![0]!.path;
    check(/^kept:[0-9a-f]{32}\/linked: shot\.png$/.test(shotRef), 'the question on the PC keeps the PNG as its own copy, marked linked', shotRef);
    const image = await raw(pc, `sessions/${beta.id}/image?path=${encodeURIComponent(shotRef)}`);
    check(image.status === 200 && image.type === 'image/webp' && await samePixels(shotPng, image.bytes), 'the PC\'s page gets it through Beta as WebP, every pixel the PNG\'s', `${image.status} ${image.type} ${image.bytes.length} bytes`);
    const evidence = await pc.api('GET', `questions/${reviewQ.id}/evidence/0`);
    check(evidence.status === 200 && evidence.json.content === log, 'the whole log is the review\'s evidence', `${evidence.json?.content?.length} characters`);
    if (await shot(pc, `waiting/q/${shotQ.id}`, 'pc-question-linked-shot.png')) check(true, 'shot: the PC\'s question with the Mac\'s PNG (dark)', 'shots/pc-question-linked-shot.png');

    console.log('== 4. The reverse: Beta sends a worktree screenshot; the Mac\'s manager asks with it ==');
    const atAlpha = await until(async () => /"(linked:[0-9a-f]{16}\/cart\.png)"/.exec(await messages(mac, alpha.id))?.[1] ?? null, 'the cart at Alpha', TURN_MS);
    const macQ = await shotQuestion(mac, alpha.id, atAlpha, 'Screenshot from the PC');
    const cartRef = macQ.shots![0]!.path;
    check(/^kept:[0-9a-f]{32}\/linked: cart\.png$/.test(cartRef), 'the Mac\'s question keeps the PC worker\'s screenshot as its own copy, marked linked', cartRef);
    const cart = await raw(mac, `sessions/${alpha.id}/image?path=${encodeURIComponent(cartRef)}`);
    check(cart.status === 200 && cart.type === 'image/webp' && await samePixels(cartPng, cart.bytes), 'the Mac\'s page gets it as WebP, every pixel the PNG\'s', `${cart.type} ${cart.bytes.length} bytes`);
    if (await shot(mac, `waiting/q/${macQ.id}`, 'mac-question-linked-shot.png')) check(true, 'shot: the Mac\'s question with the PC\'s screenshot (dark)', 'shots/mac-question-linked-shot.png');
    await idle(mac, alpha.id, 'Alpha to finish');
    await idle(pc, beta.id, 'Beta to finish');

    console.log('== 5. Bytes per link, counted both ways and shown in Settings ==');
    const sent = shotPng.length + Buffer.byteLength(log);
    const macBytes = await filesOf(mac);
    const pcBytes = await filesOf(pc);
    check(macBytes.today.sent === sent && macBytes.month.sent === sent && macBytes.today.received === cartPng.length, 'the Mac counts what it sent and received', JSON.stringify(macBytes));
    check(pcBytes.today.received === sent && pcBytes.today.sent === cartPng.length, 'the PC counts the same the other way', JSON.stringify(pcBytes));
    if (await shot(mac, 'settings/remote', 'mac-settings-linked-bytes.png', 'Linked computers')) check(true, 'shot: Settings → Linked computers with the bytes (dark)', 'shots/mac-settings-linked-bytes.png');

    console.log('== 6. What can\'t go is refused with the reason, and nothing is sent ==');
    const locked = await mac.api('POST', `sessions/${alpha.id}/secrets`, { name: 'db', value: 'hunter2-loopback-158', lifetime: 'project' });
    check(locked.status === 200, 'a secret locked on the Mac', String(locked.status));
    const copiesBefore = linkedFiles(pair.pages.pc.data).length;
    const tries: [string, string, RegExp][] = [
      ['["../outside.png"]', beta.id, /Only files inside the project folder/],
      ['[".env"]', beta.id, /only PNG and JPEG images and \.txt, \.log or \.md/],
      ['["private-notes/a.png"]', beta.id, /sensitive path pattern \/private-notes\//],
      ['["secret.log"]', beta.id, /contains a secret locked in Ledung/],
      ['["n1.log", "n2.log", "n3.log", "n4.log", "n5.log", "n6.log"]', beta.id, /at most 5 files per message, and this one has 6|"path": \[\s*"attachments"\s*\],\s*"message": "Too big: expected array to have <=5 items"/],
      ['["big.png"]', beta.id, /big\.png is too large/],
      ['["big.log"]', beta.id, /big\.log is too large .*at most 512 KB/],
      ['["shot.png"]', fort.id, /No files go to or from a locked project/],
    ];
    await mac.api('POST', `sessions/${alpha.id}/messages`, {
      text: `Loopback refusal checks. Make these ${tries.length} message_manager calls one after another, each with computer "PC" and text "test", and the id and attachments given; every one is expected to fail. Then say "done" and stop. Use no other tools.\n`
        + tries.map(([files, to], i) => `${i + 1}. id "${to}", attachments ${files}`).join('\n'),
    });
    await until(async () => (await messages(mac, alpha.id)).includes('No files go to or from a locked project'), 'the refusals', TURN_MS);
    await idle(mac, alpha.id, 'Alpha to finish the refusals');
    const afterRefusals = await messages(mac, alpha.id);
    for (const [files, , reason] of tries) check(reason.test(afterRefusals), `refused: ${files}`, reason.source);
    check(linkedFiles(pair.pages.pc.data).length === copiesBefore && (await filesOf(mac)).today.sent === sent, 'nothing more kept on the PC and nothing more counted as sent');
    check(!(await messages(pc, beta.id)).includes('"test"') && !(await messages(pc, fort.id)).includes('Files sent with it'), 'neither PC manager got a message');

    console.log('== 7. A locked project\'s manager sends no files ==');
    const island = (await mac.api('POST', 'projects/Island/manager', {
      text: `Test manager in a Ledung loopback. Call message_manager once: id "${beta.id}", computer "PC", text "from island", attachments ["ok.png"]. Quote the tool's answer exactly and stop. Use no other tools.`,
    })).json;
    const islandSaid = await until(async () => { const m = await messages(mac, island.id); return /sends no files to other computers/.test(m) ? m : null; }, 'Island\'s refusal', TURN_MS);
    check(islandSaid.includes('the project "Island" is locked, so its manager sends no files to other computers'), 'refused at the Mac for a locked project');

    console.log('== 8. The PC off: the send fails at once, nothing left on either side ==');
    await idle(mac, island.id, 'Island to finish');
    await pair.pcOff();
    const pcCopies = linkedFiles(pair.pages.pc.data).length;
    // The Mac keeps the PC worker's screenshot it received in step 4; nothing more may come.
    const macCopies = linkedFiles(pair.pages.mac.data).length;
    const t0 = Date.now();
    await mac.api('POST', `sessions/${alpha.id}/messages`, { text: `Call message_manager once: id "${beta.id}", computer "PC", text "are you there?", attachments ["shot.png"]. Quote the tool's answer exactly and stop.` });
    const off = await until(async () => { const m = await messages(mac, alpha.id); return /pc\.l\.test is offline \(its Ledung is not connected to the relay\)/.test(m) ? m : null; }, 'the offline answer', TURN_MS);
    check(!!off, 'message_manager with a file failed with the offline sentence', `${Math.round((Date.now() - t0) / 1000)} s including Haiku's turn`);
    check(linkedFiles(pair.pages.pc.data).length === pcCopies && linkedFiles(pair.pages.mac.data).length === macCopies && (await filesOf(mac)).today.sent === sent, 'no copy on either side, nothing counted', `PC ${pcCopies}, Mac ${macCopies} as before`);

    console.log('== 9. The trace ==');
    check(!pair.seen.clear && pair.seen.bytes > sent, 'the server\'s side carried only TLS, the files inside it', `${pair.seen.bytes} bytes`);
  } finally {
    await pair.close();
  }
  console.log(failed() ? `${failed()} FAILED` : 'ALL PASSED');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
