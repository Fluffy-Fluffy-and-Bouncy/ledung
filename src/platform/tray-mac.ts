// The macOS half of Ledung's tray icon (issue #347, docs/steps/tray-icon.md): an icon in the menu bar, through
// /usr/bin/osascript's JavaScript and its bridge to AppKit (NSStatusItem, NSMenu, NSAlert). osascript is part of
// macOS and signed by Apple, and this is text, so there is nothing for Gatekeeper to check (choice A). It talks to
// Ledung only over its own stdin and stdout, as the Windows helper does (src/platform/tray.ts):
//
// - In: a JSON line: the state ({status, address, waiting, restart}), {ask} with the Exit question's text, or {stop}.
// - Out: one of the fixed words open, restart, exit, exit-confirmed.
// - It is an "accessory" program: no Dock icon, not in Cmd+Tab.
// - The picture is a template image (choice G): macOS paints it in the menu bar's own colour, light or dark.
// - It removes the icon and exits on {stop}, when its input ends or, as a second net, when its parent (Ledung) is gone
//   (checked every second). macOS doesn't end a child with its parent, so it outlives a killed Ledung to do that.
//
// Input and the parent check also run while the Exit alert is open (its run loop mode is listed), so Ledung stopping
// takes the alert away with the icon, as on Windows.

/** The script, run as `/usr/bin/osascript -l JavaScript -e <this>`. */
export const MAC_TRAY_SCRIPT = String.raw`
ObjC.import('Cocoa');
ObjC.import('stdlib');

const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const input = $.NSFileHandle.fileHandleWithStandardInput;
const modes = $([$.NSDefaultRunLoopMode, $.NSModalPanelRunLoopMode, $.NSEventTrackingRunLoopMode]);
const parent = Number($.getenv('LEDUNG_TRAY_PARENT'));
let parentAlive = () => true;
try {
  ObjC.bindFunction('getppid', ['int', []]);
  parentAlive = () => $.getppid() === parent;
} catch (e) {}

let item = null;
let asking = false;
let buffer = '';

function send(word) {
  out.writeData($(word + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

function quit() {
  if (item) $.NSStatusBar.systemStatusBar.removeStatusItem(item);
  $.exit(0);
}

function apply(m) {
  if (m.stop) { quit(); return; }
  if (m.ask) {
    if (asking) return;
    asking = true;
    const alert = $.NSAlert.alloc.init;
    alert.setMessageText('Exit Ledung?');
    alert.setInformativeText(String(m.ask));
    alert.addButtonWithTitle('Exit Ledung');
    alert.addButtonWithTitle('Cancel');
    app.activateIgnoringOtherApps(true);
    const answer = alert.runModal;
    asking = false;
    if (answer === $.NSAlertFirstButtonReturn) send('exit-confirmed');
    return;
  }
  status.setTitle(String(m.status || ''));
  address.setTitle(String(m.address || ''));
  restart.setHidden(!m.restart);
  item.button.setTitle(m.waiting > 0 ? ' ' + m.waiting : '');
}

ObjC.registerSubclass({
  name: 'LedungTrayTarget',
  methods: {
    'open:': { types: ['void', ['id']], implementation: function () { send('open'); } },
    'restart:': { types: ['void', ['id']], implementation: function () { send('restart'); } },
    'exit:': { types: ['void', ['id']], implementation: function () { send('exit'); } },
    'noop:': { types: ['void', ['id']], implementation: function () {} },
    'tick:': { types: ['void', ['id']], implementation: function () { if (!parentAlive()) quit(); } },
    'read:': {
      types: ['void', ['id']],
      implementation: function (note) {
        const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
        if (!data || data.isNil() || data.length === 0) { quit(); return; }
        buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
        // Read on before handling: an Exit alert opened below still sees the input end.
        input.readInBackgroundAndNotifyForModes(modes);
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          try { apply(JSON.parse(line)); } catch (e) {}
        }
      },
    },
  },
});
const target = $.LedungTrayTarget.alloc.init;

const image = $.NSImage.alloc.initWithContentsOfFile($.getenv('LEDUNG_TRAY_ICON'));
image.setSize($.NSMakeSize(18, 18));
image.setTemplate(true);
item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
item.button.setImage(image);
item.button.setImagePosition($.NSImageLeft);
item.button.setToolTip('');

const menu = $.NSMenu.alloc.initWithTitle('Ledung');
menu.setAutoenablesItems(false);
function addItem(title, action, enabled) {
  const it = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, '');
  it.setTarget(target);
  it.setEnabled(enabled);
  menu.addItem(it);
  return it;
}
const status = addItem('Ledung', 'noop:', false);
const address = addItem('', 'noop:', false);
menu.addItem($.NSMenuItem.separatorItem);
addItem('Open Ledung', 'open:', true);
const restart = addItem('Restart Ledung', 'restart:', true);
restart.setHidden(true);
menu.addItem($.NSMenuItem.separatorItem);
addItem('Exit Ledung', 'exit:', true);
item.setMenu(menu);

$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(target, 'read:', $.NSFileHandleReadCompletionNotification, input);
input.readInBackgroundAndNotifyForModes(modes);
const timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(1, target, 'tick:', null, true);
$.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);
app.run;
`;
