# Macros (#410)

Martin, 2026-10-29 13:41: "I think I want user defined macros (that could be bound to a keybind/klickable chip (like
the usage/board chips) that are above the inputbox but below the "boat/info bar" OR if they should be to the right
(aligned right) of the infobar area."

Martin, 2026-10-29 13:46: "I think having the option to have the chips/maccros be global or per project would be good.
no need to have it per manager/session etc. if you have them you have them everywhere for now. And I dont want it to
have to be a chip to have a macro keybinded."

Martin, 2026-10-29 14:07, Ledung question #425 (screenshot verdicts on the mockups): placement A (a row of its own
above the message box) Fail; placement B (right-aligned in the info bar) and the Settings list and edit form Pass.
Recorded on the issue: https://github.com/Fluffy-Fluffy-and-Bouncy/Project-Ledung/issues/410#issuecomment-6497547771

So this is placement B, built. The shots are the built page, dark mode, at 1280 px and 390 px, taken by
`test/loopback/macros.ts` on a throwaway Ledung with stand-in sessions; the example macros are generic.

## The shots

| Shot | What it shows |
|---|---|
| `410-b-3chips-*` | Three macros: chips right-aligned in the info bar, after the ship and "Done at …". At 1280 px all three fit and the last chip is ＋ (Edit macros…). On a phone two fit and the third is under "+1". ↵ marks one that sends at once. |
| `410-b-8chips-*` | Eight chips (the global ones and this project's; a macro of another project is not here) and one keybind-only macro. At 1280 px seven fit and "+2" holds the eighth and the keybind-only one; on a phone two fit and "+7". |
| `410-b-8chips-menu-*` | The last chip's menu open: the chips that did not fit, the keybind-only "Go on", their keybinds, and Edit macros…. |
| `410-settings-list-*` | Settings → Ledung → Macros: every macro in chip order, as its chip (or "· keybind only"), its text, Sends/Inserts, its keybind (or "no key"), Global or its project, a handle to drag, Edit. On a phone each row is three lines and ↑ moves a macro up. |
| `410-settings-removed-*` | Settings → Ledung → Macros, after review round 1: "Old one" is kept for a project Ledung no longer has, and its scope reads "Gone (removed)". At 1280 the scope column cuts it to "Gone (remo…". Taken at e0ff6d3. |
| `410-settings-edit-*` | Editing "Run checks": name, text with the placeholders, when used (put in the box / send at once), where (Global or one project), and the chip and the keybind each on a switch of its own. |
| `410-settings-clash-*` | Ctrl+O pressed in the keybind box: refused, with what uses it, Save greyed, and free keybinds to pick. |
| `410-settings-search-*` | Settings search for "keybind" finds Macros. |

## What a macro does

- **Insert or send, per macro.** Insert puts the text in the message box (after what is there); send sends it at
  once, like a typed message, so every check a typed message meets still applies. **Shift+click** a chip does the
  other one. A text starting with `!` always goes into the box, where the shell command's own check runs (#212); a
  text starting with `/` is sent as a slash command, as typed.
- **Placeholders** `{issue}` (the session's ticket, else the number in its branch, as `#408`), `{branch}`, `{pr}` (as
  `#412`), `{project}`, `{session}` (its title). A macro with a placeholder the session has no value for is not sent:
  its text goes into the box with the placeholder left in, to finish by hand.
- **Global or one project** (Chats counts as one). No split by role.
- **A chip, a keybind, or both.** A keybind-only macro is in the info bar's last-chip menu, so a phone (no keys) can
  still use it. Neither is refused, since nothing could use it.
- **Kept by Ledung**, not the browser: the phone and other browsers have the same list. Only the open page can change
  it, so a session cannot put words in the person's chips.
- **When the chips show:** in every session whose message box takes text; none in an ended session that can't be
  resumed. The bar takes at most 60 % of the line (62 % on a phone), so the status keeps room; the chips that don't fit
  go into the menu.

## Keybinds

The default and the free ones offered are **Ctrl+Shift+1 … 9**: they type nothing on the Mac or on Windows, and no
browser uses them. The mockups proposed Alt+1…0, but on a Mac ⌥2 types @ and ⌥7/8/9 type | [ ] on a Swedish keyboard,
so Alt keys are allowed only with a warning.

A keybind is Ctrl, Alt or Cmd with a letter or a digit, read on the physical key, so the layout doesn't change it. It
works in the message box too. Every computer shares the list, so the check covers the Mac and Windows both:

- **Refused** (can't be saved): Cmd keys (the browser's and the Mac's; Windows has none); Ctrl+Alt (AltGr on Windows,
  which types @ { [); Ctrl+O (Ledung's tool calls); Ctrl or Ctrl+Shift with a letter (new tab, copy, find, developer
  tools…); Alt+D, Alt+E, Alt+F (the browser's address bar and menu on Windows); Shift alone; another macro's keybind.
- **Warned** (can be saved): Ctrl with a digit (switches tabs on Windows and Linux); Alt with a letter or digit (takes
  the character ⌥ types on a Mac; Alt+1–9 also switch tabs on Linux).

What the page itself uses, for reference: Enter and Shift+Enter in the message box; Ctrl/Cmd+Enter; Ctrl+O; Escape;
`/` in Settings; single keys in Waiting for you, outside a text box; arrows, Home and End on the resize grips.

## Not built

A long press on a phone for "the other one" (Shift+click has no touch counterpart yet); a Macros list on a project's
own Settings tab; placing an insert at the cursor rather than after what is typed.
