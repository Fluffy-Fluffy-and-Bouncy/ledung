// The desktop app's preload: what Ledung's page may ask of the app. Showing its window (#360): a click on
// one of the page's notifications calls it, since `window.focus()` does nothing for a hidden window (Mac spike, "What a
// real shell needs next"). Opening another window (#414): the page's New window button. Plain CommonJS, not
// TypeScript: a sandboxed preload is run by the page's process, which strips no types and loads no modules. The page
// gets these functions and nothing else: no Node, no ipcRenderer. The main process checks that the call came from
// Ledung's own page before it does anything (main.ts).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledungDesktop', {
  showWindow: () => ipcRenderer.send('ledung-desktop:show-window'),
  newWindow: () => ipcRenderer.send('ledung-desktop:new-window'),
  // Updating Ledung (#408): the window restarts into the new version, `now` from the page's Restart button, else once
  // no window is in sight. Only in the made app, which main.ts marks with an argument: a clone run can't restart into
  // an update.
  ...(process.argv.includes('--ledung-made-app') ? { restartForUpdate: (now) => ipcRenderer.send('ledung-desktop:restart-for-update', now === true) } : {}),
});
