// Loopback for issue #245 step 2 (docs/steps/manager-link.md): real managers (Haiku) on two linked throwaway
// Ledungs list each other's managers and message each other through the relay, end to end. Not in CI (it starts
// two Ledungs and spends a few Haiku turns).
//
//   node test/loopback/link-managers.ts              # ports 4397 and 4398
//
// The two Ledungs, the relay and the front: linked-pair.ts.
import path from 'node:path';
import { check, failed, link, type Page, repo, startPair, until } from './linked-pair.ts';

const work = path.join(repo, '.test', 'link-managers');
const TURN_MS = 180_000;

// A session's history as plain text: quotes inside nested JSON (tool results) come out escaped once or twice.
const messages = async (page: Page, id: string) => JSON.stringify((await page.api('GET', `sessions/${id}/messages?limit=500`)).json).replace(/\\+"/g, '"');
const status = async (page: Page, id: string) => ((await page.api('GET', 'state')).json.sessions as { id: string; status: string }[]).find((s) => s.id === id)?.status;
const idle = (page: Page, id: string, what: string) => until(async () => (await status(page, id)) === 'idle', what, TURN_MS);

async function main(): Promise<void> {
  const project = (name: string) => ({ name, runner: 'local', path: path.join(work, `project-${name}`), model: 'haiku', managerModel: 'haiku', permissionMode: 'default' });
  const pair = await startPair(work, { mac: [project('Alpha')], pc: [project('Beta')] });
  const { mac, pc } = pair.pages;
  try {
    console.log('== 1. Link, and start the PC\'s manager ==');
    await link(pair.pages);
    check(true, 'linked through the relay');
    const beta = (await pc.api('POST', 'projects/Beta/manager', {
      text: 'Test manager in a Ledung loopback. Reply with the single word "ready". Later a manager on another computer will message you: answer it once with message_manager (its id and computer "Mac", as the message says) with the text "pong from Beta", then stop. Use no other tools.',
    })).json;
    await idle(pc, beta.id, 'Beta to be ready');
    check(true, 'Beta is idle', beta.id);

    console.log('== 2. The Mac\'s manager lists every computer\'s managers and messages Beta on the PC ==');
    const sentAt = Date.now();
    const alpha = (await mac.api('POST', 'projects/Alpha/manager', {
      text: 'Test manager in a Ledung loopback. Call list_managers once. Then call message_manager once, to the manager of project Beta on computer "PC" (its id as list_managers shows it), with the text "ping from Alpha". Then wait; when the answer arrives, say "got it" and stop. Use no other tools.',
    })).json;
    const listed = await until(async () => { const m = await messages(mac, alpha.id); return /On your computer "pc"/i.test(m) ? m : null; }, 'Alpha\'s list_managers', TURN_MS);
    check(listed.includes(beta.id), 'list_managers on the Mac shows Beta\'s manager under "PC", with its id');

    const atBeta = await until(async () => { const m = await messages(pc, beta.id); return m.includes('ping from Alpha') ? m : null; }, 'the message at Beta', TURN_MS);
    check(atBeta.includes(`Message from manager "Manager: Alpha" (${alpha.id}) of Alpha on your computer "Mac"`), 'Beta got it marked as a manager\'s message from the Mac', `${Math.round((Date.now() - sentAt) / 1000)} s after Alpha's task`);
    check(atBeta.includes('not from Martin'), 'delivered as context, not as Martin\'s words');

    console.log('== 3. Beta was woken and answers; Alpha gets it marked as from the PC ==');
    const back = await until(async () => { const m = await messages(mac, alpha.id); return m.includes('pong from Beta') ? m : null; }, 'the answer at Alpha', TURN_MS);
    check(back.includes(`Message from manager "Manager: Beta" (${beta.id}) of Beta on your computer "pc"`), 'Alpha got Beta\'s answer, marked as from the PC');
    check(!pair.seen.clear && pair.seen.bytes > 0, 'the server\'s side carried only TLS', `${pair.seen.bytes} bytes`);
    await idle(mac, alpha.id, 'Alpha to finish');

    console.log('== 4. The PC off: list_managers says so, message_manager fails at once ==');
    await pair.pcOff();
    const t0 = Date.now();
    await mac.api('POST', `sessions/${alpha.id}/messages`, { text: 'Call list_managers once, then message_manager once to the same Beta manager on computer "PC" with "are you there?". Quote both tools\' answers exactly in one reply and stop.' });
    // list_managers's line for the computer, and message_manager's error (a tool error is recorded as "Error: …").
    const off = await until(async () => {
      const m = await messages(mac, alpha.id);
      return /On your computer "pc": pc\.l\.test is offline/.test(m) && /Error: pc\.l\.test is offline/.test(m) ? m : null;
    }, 'the offline answers', TURN_MS);
    check(!!off, 'list_managers said the PC is offline, and message_manager failed saying so', `${Math.round((Date.now() - t0) / 1000)} s`);
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
