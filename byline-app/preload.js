// Byline preload: sandboxed bridge between the xterm.js renderer and the PTY sessions.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byline', {
  start:  (id, cols, rows) => ipcRenderer.send('pty:start',  { id, cols, rows }),
  input:  (id, data)       => ipcRenderer.send('pty:input',  { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill:   (id)             => ipcRenderer.send('pty:kill',   { id }),
  zoomWindow: ()           => ipcRenderer.send('win:zoom'),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, d) => cb(d)),
  // configurable menu / shortcuts
  updateMenu:  (quick) => ipcRenderer.send('menu:update', quick),
  suspendMenu: ()      => ipcRenderer.send('menu:suspend'),
  onMenuAction: (cb)   => ipcRenderer.on('menu:action', (_e, d) => cb(d)),
  onHookState:  (cb)   => ipcRenderer.on('hook:state', (_e, d) => cb(d)),
});
