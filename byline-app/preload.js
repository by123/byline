// Byline preload: sandboxed bridge between the xterm.js renderer and the PTY sessions.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('byline', {
  start:  (id, cols, rows, cwd) => ipcRenderer.send('pty:start',  { id, cols, rows, cwd }),
  input:  (id, data)       => ipcRenderer.send('pty:input',  { id, data }),
  ack:    (id, n)          => ipcRenderer.send('pty:ack',    { id, n }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill:   (id)             => ipcRenderer.send('pty:kill',   { id }),
  zoomWindow: ()           => ipcRenderer.send('win:zoom'),
  openExternal: (url)      => ipcRenderer.send('shell:open-external', { url }),
  // file paste / drag-drop -> full paths (File.path was removed in Electron 32)
  pathForFile: (f)         => { try { return webUtils.getPathForFile(f); } catch (_) { return ''; } },
  clipboardFiles: ()       => ipcRenderer.invoke('clipboard:files'),
  clipboardText: ()        => ipcRenderer.invoke('clipboard:text'),
  clipboardWrite: (text)   => ipcRenderer.send('clipboard:write', { text }),
  // agent handoff: archive the source session's transcript and write the run.sh
  // that generates a summary and launches the target agent in a new tab
  handoffPrepare: (req)    => ipcRenderer.invoke('handoff:prepare', req),
  // read a tab's agent transcript for the sidebar conversation dialog (clean past record)
  sessionTranscript: (req) => ipcRenderer.invoke('session:transcript', req),
  // terminal right-click 翻译: Google Translate via main (net.fetch -> system proxy)
  translate: (req)         => ipcRenderer.invoke('translate:run', req),
  translateCancel: (id)    => ipcRenderer.send('translate:cancel', { id }),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, d) => cb(d)),
  // configurable menu / shortcuts
  updateMenu:  (quick) => ipcRenderer.send('menu:update', quick),
  suspendMenu: ()      => ipcRenderer.send('menu:suspend'),
  onMenuAction: (cb)   => ipcRenderer.on('menu:action', (_e, d) => cb(d)),
  onHookState:  (cb)   => ipcRenderer.on('hook:state', (_e, d) => cb(d)),
  // renderer -> main log bridge: everything lands in the one byline.log file
  log: (level, event, data) => ipcRenderer.send('log:write', { level, event, data }),
});
