// The product's name as a person sees it: the tab, the desktop app's window and taskbar entry (which take the
// page's title), the installed app and the empty view's heading. "Ledung", without "Project" (#428; Martin,
// Ledung question #647 on magto-mini: "b — Does not hold: rename it everywhere").
export const PRODUCT_NAME = 'Ledung';

// The tab title, with the number waiting in front so it shows from another tab or the phone's tab switcher.
export function pageTitle(waiting: number): string {
  return waiting ? `(${waiting}) ${PRODUCT_NAME}` : PRODUCT_NAME;
}
