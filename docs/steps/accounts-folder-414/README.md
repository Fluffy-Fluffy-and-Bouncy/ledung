# Issue #414: Open folder per account (built), and a readable accounts file (proposal)

Martin, 2026-10-29 13:43, Ledung question #424: "What I do want is a way to open the account folders from the
settings menu and a more descriptive and more human readable json file so the user can enter the credentials he
or she wants."

## What there is today

- Accounts live in Ledung's database and are added in Settings → Claude & accounts. **No file lists them**: the
  config file has no accounts, and its first-start comment says they are added in the page.
- Each account's sign-in folder holds only Claude Code's own `.credentials.json` (Windows, Linux; macOS uses the
  Keychain): one line, Claude Code's shape, which Ledung never reads or writes (#342) and cannot reword without
  Claude Code no longer reading it.
- So "credentials the user enters" cannot be a Ledung file: Ledung takes no sign-in (#342). What a person can
  enter by hand is *which accounts exist and where their sign-in folders are*; signing in stays `/login`.

Before and after, as text: [accounts-file-before.txt](accounts-file-before.txt),
[accounts-file-after.txt](accounts-file-after.txt).

## Proposed

Status 2026-10-29: Martin passed the Open folder shot (Ledung question #429) and chose nothing for the file yet; 1 is built in PR #424, 2 and 3 wait for his choice in a card of their own.

1. **Open folder** next to Remove for each account (built in this draft, shot: [open-folder-dark.png](open-folder-dark.png)).
   Finder on macOS, Explorer on Windows, `xdg-open` elsewhere. Only on the computer Ledung runs on and from its
   open page: refused through the relay (a phone) and from a manager's tools, like linking computers; greyed out
   on a page that came through the public name.
2. **A `claudeAccounts` block in the config file**, the file people already edit and Ledung re-reads when it
   changes: account names with a description, the sign-in folder here and in containers, each field explained by
   a `$…` line and a worked example. Ledung adds and updates accounts from it; removing stays in the page.
   A config without the block reads as today.
3. **`ABOUT THIS FOLDER.txt` in each sign-in folder**, saying what the folder is and how to sign in, so Open
   folder lands somewhere self-explaining. Nothing secret in it.

Alternatives for 2: only 1 and 3 (no hand-edited list); or a separate `accounts.json` that Ledung keeps in step
with the page both ways (lists every account, but two writers to one file).
