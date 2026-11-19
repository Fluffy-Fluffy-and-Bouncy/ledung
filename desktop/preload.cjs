// The desktop app's preload (#360): the one thing Ledung's page may ask of the app, showing its window. A click on
// one of the page's notifications calls it, since `window.focus()` does nothing for a hidden window (Mac spike, "What a
// real shell needs next"). Plain CommonJS, not TypeScript: a sandboxed preload is run by the page's process, which
// strips no types and loads no modules. The page gets this one function and nothing else: no Node, no ipcRenderer.
// The main process checks that the call came from Ledung's own page before it shows anything (main.ts).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledungDesktop', {
  showWindow: () => ipcRenderer.send('ledung-desktop:show-window'),
});
