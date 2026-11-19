// The find bar's preload (#445): what desktop/find-bar.html may ask of the app, and how the app tells it the count.
// Plain CommonJS for the same reason as preload.cjs: a sandboxed preload strips no types and loads no modules. The bar
// gets these functions and nothing else; main.ts checks each message came from a window's own bar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledungFind', {
  query: (text) => ipcRenderer.send('ledung-find:query', String(text)),
  step: (forward) => ipcRenderer.send('ledung-find:step', forward === true),
  close: () => ipcRenderer.send('ledung-find:close'),
  // The app opened the bar: `kept` is the last search's text.
  onOpen: (callback) => ipcRenderer.on('ledung-find:open', (_event, kept) => callback(kept)),
  // "n of m" or "No matches".
  onCount: (callback) => ipcRenderer.on('ledung-find:count', (_event, line) => callback(line)),
});
