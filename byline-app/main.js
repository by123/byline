// Byline main process. A real terminal: each session is a genuine interactive login zsh
// running on a PTY (node-pty). Raw bytes pass straight through to xterm.js in the renderer,
// so everything works: p10k prompt, native tab completion, colors, vim, ssh, claude, codex.
const { app, BrowserWindow, ipcMain, nativeTheme, screen, Menu, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

app.setName('Byline');

const HOME = os.homedir();
const SHELL_INT = path.join(__dirname, 'shell');   // Byline shell-integration z-files (bundled, read-only)
const STATUS_DIR = '/tmp/ai_light_sessions';       // ai-light hooks write per-session state here
let RT_SHELL = SHELL_INT;                           // writable copy so zsh caches (.zcompdump) never touch the app bundle
let win = null;

function ensureShellDir() {
  try {
    RT_SHELL = path.join(app.getPath('userData'), 'shell');
    fs.mkdirSync(RT_SHELL, { recursive: true });
    for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      try { fs.copyFileSync(path.join(SHELL_INT, f), path.join(RT_SHELL, f)); } catch (_) {}
    }
  } catch (_) { RT_SHELL = SHELL_INT; }
}
const sessions = new Map();               // id -> pty process

// Read the per-session status files that ai-light's hook writes (keyed by BYLINE_SID) and
// push each change to the renderer as authoritative status for that tab. We poll + rescan
// on every fs event because macOS fs.watch reports atomic renames unreliably (it often
// surfaces the temp filename, not the final one), which would drop updates.
let _hookStates = {};
function pollHookStates() {
  let files;
  try { files = fs.readdirSync(STATUS_DIR); } catch (_) { return; }
  for (const id of files) {
    if (id.endsWith('.tmp')) continue;
    let state;
    try { state = fs.readFileSync(path.join(STATUS_DIR, id), 'utf8').trim(); } catch (_) { continue; }
    if (state && _hookStates[id] !== state) {
      _hookStates[id] = state;
      if (win && !win.isDestroyed()) win.webContents.send('hook:state', { id, state });
    }
  }
}
function watchHookStates() {
  try { fs.mkdirSync(STATUS_DIR, { recursive: true }); } catch (_) {}
  try { for (const f of fs.readdirSync(STATUS_DIR)) fs.unlinkSync(path.join(STATUS_DIR, f)); } catch (_) {} // drop stale from prior runs
  _hookStates = {};
  try { fs.watch(STATUS_DIR, () => pollHookStates()); } catch (_) {}  // instant on change
  setInterval(pollHookStates, 600);                                   // robust fallback
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 640, minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16191d' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Terminal output is untrusted (OSC 8 links, agent output): links open in the default
  // browser, never as a child window, and the app page itself can never be navigated away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { killAll(); win = null; });
}

function killAll() {
  for (const p of sessions.values()) { try { p.kill(); } catch (_) {} }
  sessions.clear();
}

ipcMain.on('pty:start', (_e, { id, cols, rows }) => {
  if (sessions.has(id)) return;
  const shellPath = process.env.SHELL || '/bin/zsh';
  const p = pty.spawn(shellPath, ['-il'], {
    name: 'xterm-256color',
    cols: cols || 100, rows: rows || 30,
    cwd: HOME,
    env: {
      ...process.env,
      TERM: 'xterm-256color', COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      ZDOTDIR: RT_SHELL,                                   // load Byline integration first (writable copy)
      BYLINE_INT_DIR: RT_SHELL,
      BYLINE_ZDOTDIR: process.env.ZDOTDIR || HOME,         // then the user's real config
      BYLINE_SID: id,                                      // per-tab id so ai-light hooks can report per session
    },
  });
  p.onData(data => { if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data }); });
  p.onExit(() => { sessions.delete(id); if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id }); });
  sessions.set(id, p);
});

// Double-click title bar: maximize when small, or restore to 2/3 of the screen (centered) when large.
function workAreaFor() {
  return (screen.getDisplayMatching(win.getBounds()) || screen.getPrimaryDisplay()).workArea;
}
function setTwoThirdsCentered() {
  const wa = workAreaFor();
  const w = Math.round(wa.width * 2 / 3);
  const h = Math.round(wa.height * 2 / 3);
  win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h }, true);
}
function zoomWindow() {
  if (!win) return;
  if (win.isFullScreen()) { win.once('leave-full-screen', () => setTwoThirdsCentered()); win.setFullScreen(false); return; }
  const wa = workAreaFor();
  const b = win.getBounds();
  const large = win.isMaximized() || (b.width >= wa.width - 24 && b.height >= wa.height - 24);
  if (large) { if (win.isMaximized()) win.unmaximize(); setTwoThirdsCentered(); }
  else { win.maximize(); }
}
ipcMain.on('win:zoom', () => zoomWindow());

ipcMain.on('shell:open-external', (_e, { url }) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url); });

ipcMain.on('pty:input',  (_e, { id, data }) => { const p = sessions.get(id); if (p) p.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const p = sessions.get(id); if (p) { try { p.resize(cols, rows); } catch (_) {} } });
ipcMain.on('pty:kill',   (_e, { id }) => { const p = sessions.get(id); if (p) { try { p.kill(); } catch (_) {} } sessions.delete(id); try { fs.unlinkSync(path.join(STATUS_DIR, id)); } catch (_) {} });

// The app menu is data-driven: the renderer sends the user's configurable quick-launch
// commands (label/command/accelerator) and we build the "会话" menu from them, so the
// shortcuts work app-wide and show in the menu. Menu clicks/accelerators post back to the
// renderer, which actually opens the session.
function buildMenu(payload) {
  payload = payload || {};
  const quick = Array.isArray(payload.quick) ? payload.quick : [];
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const send = (d) => { if (win && !win.isDestroyed()) win.webContents.send('menu:action', d); };
  const accOf = (id) => { const a = actions.find(x => x.id === id); return (a && a.accel) ? a.accel : undefined; };
  const labelOf = (id, fb) => { const a = actions.find(x => x.id === id); return (a && a.label) || fb; };
  const act = (id, fb) => ({ label: labelOf(id, fb), accelerator: accOf(id), click: () => send({ type: 'action', id }) });

  const quickItems = quick.filter(q => q && q.cmd).map(q => ({
    label: '新建 ' + (q.label || q.cmd) + ' 会话',
    accelerator: q.accel || undefined,
    click: () => send({ type: 'newQuick', cmd: q.cmd, label: q.label || q.cmd }),
  }));
  const sessionSub = quickItems.slice();
  if (quickItems.length) sessionSub.push({ type: 'separator' });
  sessionSub.push(act('newShell', '新建终端'));
  sessionSub.push(act('closeTab', '关闭当前标签'));

  const opSub = [
    act('rename', '重命名当前标签'),
    act('sidebar', '显示/隐藏会话栏'),
    act('palette', '命令面板'),
    act('search', '搜索'),
    act('zoom', '缩放窗口'),
    act('theme', '切换主题'),
    act('clear', '清屏'),
  ];

  const template = [
    { label: 'Byline', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: '偏好设置…', accelerator: accOf('settings') || 'Cmd+,', click: () => send({ type: 'action', id: 'settings' }) },
      { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: '会话', submenu: sessionSub },
    { label: '操作', submenu: opSub },
    { label: '编辑', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: '视图', submenu: [
      { role: 'toggleDevTools' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ]},
    { label: '窗口', submenu: [
      { role: 'minimize' }, { role: 'zoom' }, { role: 'front' },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
ipcMain.on('menu:update', (_e, quick) => buildMenu(quick));
ipcMain.on('menu:suspend', () => Menu.setApplicationMenu(null));  // free keys while recording a shortcut

app.whenReady().then(() => {
  ensureShellDir();
  buildMenu({});
  try { if (app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch (_) {}
  createWindow();
  watchHookStates();
});
app.on('window-all-closed', () => { killAll(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });
app.on('before-quit', () => killAll());
