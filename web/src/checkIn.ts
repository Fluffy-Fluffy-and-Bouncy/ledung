// Words for the anonymous daily check-in (#220): the notice above the page and Settings → About → Usage count.
import type { CheckInView } from '../../src/shared/protocol.ts';

/** What one check-in holds, in the words the README uses. */
export const CHECKIN_WHAT =
  'Once a day Ledung sends a random install ID, its version, its update channel and the operating system, so we can count how many people use it. Nothing else: no names, projects, sessions or usage. The server sees your IP address in transit and does not keep it.';

/** The notice, shown until OK or Turn off (at first start, and once to everyone who updates into it). */
export function noticeText(view: CheckInView): string {
  if (view.doNotTrack) return `Ledung counts its users anonymously. DO_NOT_TRACK is set here, so this Ledung sends nothing. ${CHECKIN_WHAT}`;
  return `Ledung counts its users anonymously. ${CHECKIN_WHAT} You can turn it off now or later in Settings → About.`;
}

/** The line under the switch: whether this Ledung sends, and if not, why not. */
export function statusLine(view: CheckInView): string {
  if (view.doNotTrack) return 'Not sent: DO_NOT_TRACK is set where Ledung runs.';
  if (!view.on) return 'Off: nothing is sent.';
  if (!view.fromPackage) return 'Not sent: only Ledung installed from npm checks in, not one run from a source folder.';
  if (view.notice) return 'Not sent until the notice above the page is answered.';
  return view.lastAt ? `On: last sent or tried ${new Date(view.lastAt).toLocaleString()}; the next goes a day after that.` : 'On: the first check-in goes out within the hour.';
}
