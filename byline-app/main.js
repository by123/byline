// Byline main process. A real terminal: each session is a genuine interactive login zsh
// running on a PTY (node-pty). Raw bytes pass straight through to xterm.js in the renderer,
// so everything works: p10k prompt, native tab completion, colors, vim, ssh, claude, codex.
const { app, BrowserWindow, ipcMain, nativeTheme, screen, Menu, shell, clipboard } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

app.setName('Byline');

const HOME = os.homedir();
const SHELL_INT = path.join(__dirname, 'shell');   // Byline shell-integration z-files (bundled, read-only)
// Per-session status files (see hooks/README.md for the contract). Agent hooks write one
// word (start|think|confirm|done|off) to <dir>/<BYLINE_SID>. Two dirs are watched: Byline's
// own, plus the legacy ai-light dir so existing ai-light setups keep working unchanged.
const STATUS_DIRS = ['/tmp/byline_sessions', '/tmp/ai_light_sessions'];
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
const sessions = new Map();               // id -> {p, buf, bufLen, flushT, unacked, paused}

// Renderer ids become env vars and status filenames; reject anything that could traverse paths.
const validId = (id) => typeof id === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(id);

// PTY -> renderer flow control. xterm.js parses slower than a PTY can produce (and discards
// data past a 50MB backlog), so we count bytes in flight and pause the PTY when the renderer
// falls behind. Chunks are also coalesced per 8ms tick: one IPC message per frame, not per read.
const HIGH_WATER = 512 * 1024, LOW_WATER = 128 * 1024;
function flushPty(id, s) {
  if (!s.bufLen) return;
  const data = s.buf.join(''); s.buf.length = 0; s.bufLen = 0;
  s.unacked += data.length;
  if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data });
  if (!s.paused && s.unacked > HIGH_WATER) { s.paused = true; try { s.p.pause(); } catch (_) {} }
}

// Read the per-session status files that ai-light's hook writes (keyed by BYLINE_SID) and
// push each change to the renderer as authoritative status for that tab. We poll + rescan
// on every fs event because macOS fs.watch reports atomic renames unreliably (it often
// surfaces the temp filename, not the final one), which would drop updates.
let _hookStates = {};
function pollHookStates() {
  const newest = {};   // sid -> {state, mtime}; when both dirs have a file, the newer write wins
  for (const dir of STATUS_DIRS) {
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const id of files) {
      if (id.endsWith('.tmp') || !sessions.has(id)) continue;   // only sessions owned by this instance
      try {
        const fp = path.join(dir, id);
        const mtime = fs.statSync(fp).mtimeMs;
        if (newest[id] && newest[id].mtime >= mtime) continue;
        const state = fs.readFileSync(fp, 'utf8').trim();
        if (state) newest[id] = { state, mtime };
      } catch (_) {}
    }
  }
  for (const id of Object.keys(newest)) {
    const state = newest[id].state;
    if (_hookStates[id] !== state) {
      _hookStates[id] = state;
      if (win && !win.isDestroyed()) win.webContents.send('hook:state', { id, state });
    }
  }
}
function watchHookStates() {
  _hookStates = {};
  for (const dir of STATUS_DIRS) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    // Status dirs are shared across instances (dev + installed can run together): never wipe
    // them wholesale, only drop files old enough to be leftovers from a crashed run. Live
    // sessions clean up after themselves in killAll / pty:kill.
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try { if (now - fs.statSync(fp).mtimeMs > 86400e3) fs.unlinkSync(fp); } catch (_) {}
      }
    } catch (_) {}
    try { fs.watch(dir, () => pollHookStates()); } catch (_) {}  // instant on change
  }
  setInterval(pollHookStates, 600);                              // robust fallback
}
function unlinkStatus(id) {
  for (const dir of STATUS_DIRS) { try { fs.unlinkSync(path.join(dir, id)); } catch (_) {} }
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
  // a reloaded/crashed renderer regenerates its session ids: reap the old PTYs or they leak
  win.webContents.on('render-process-gone', () => killAll());
  win.webContents.on('did-start-navigation', e => { if (e.isMainFrame && !e.isSameDocument) killAll(); });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { killAll(); win = null; });
}

function killAll() {
  for (const [id, s] of sessions) {
    clearTimeout(s.flushT);
    try { s.p.kill(); } catch (_) {}
    unlinkStatus(id);
  }
  sessions.clear();
}

ipcMain.on('pty:start', (_e, { id, cols, rows, cwd }) => {
  if (!validId(id) || sessions.has(id)) return;
  const shellPath = process.env.SHELL || '/bin/zsh';
  let startCwd = HOME;                                   // open-in-same-dir: honor the renderer's requested cwd
  if (typeof cwd === 'string' && cwd) { try { if (fs.statSync(cwd).isDirectory()) startCwd = cwd; } catch (_) {} }
  const p = pty.spawn(shellPath, ['-il'], {
    name: 'xterm-256color',
    cols: cols || 100, rows: rows || 30,
    cwd: startCwd,
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
  const s = { p, buf: [], bufLen: 0, flushT: null, unacked: 0, paused: false };
  p.onData(data => {
    s.buf.push(data); s.bufLen += data.length;
    if (s.bufLen >= 65536) { clearTimeout(s.flushT); s.flushT = null; flushPty(id, s); }
    else if (!s.flushT) s.flushT = setTimeout(() => { s.flushT = null; flushPty(id, s); }, 8);
  });
  p.onExit(() => {
    clearTimeout(s.flushT); s.flushT = null;
    flushPty(id, s);                                       // deliver the final output before the exit event
    sessions.delete(id);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id });
  });
  sessions.set(id, s);
});

// renderer confirms parsed bytes; resume the PTY once the backlog drains
ipcMain.on('pty:ack', (_e, { id, n }) => {
  const s = sessions.get(id); if (!s || typeof n !== 'number') return;
  s.unacked = Math.max(0, s.unacked - n);
  if (s.paused && s.unacked < LOW_WATER) { s.paused = false; try { s.p.resume(); } catch (_) {} }
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

// Finder's Cmd+C puts file *references* on the pasteboard, not paths, so the renderer can't
// read them from the DOM paste event alone. Resolve them here: NSFilenamesPboardType is an
// XML plist listing every copied file; public.file-url covers single-file copies from other apps.
ipcMain.handle('clipboard:files', () => {
  const out = [];
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
  try {
    const buf = clipboard.readBuffer('NSFilenamesPboardType');
    if (buf && buf.length) {
      const re = /<string>([\s\S]*?)<\/string>/g;
      let m; while ((m = re.exec(buf.toString('utf8')))) out.push(unesc(m[1]));
    }
  } catch (_) {}
  if (!out.length) {
    try { const u = clipboard.read('public.file-url'); if (u) out.push(fileURLToPath(u.trim())); } catch (_) {}
  }
  return out.filter(p => { try { return typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p); } catch (_) { return false; } });
});

ipcMain.handle('clipboard:text', () => { try { return clipboard.readText(); } catch (_) { return ''; } });
ipcMain.on('clipboard:write', (_e, { text }) => { try { if (typeof text === 'string') clipboard.writeText(text); } catch (_) {} });

// --- Agent handoff (claude <-> codex) -------------------------------------------------
// One click hands a live agent session over to the other CLI: the source session's
// transcript is copied to ~/.byline/handoffs/<stamp>/ (the archive survives both CLIs'
// retention cleanup), and a run.sh is written that (1) asks the SOURCE model to distill
// a structured handoff summary from its own session — claude via `-p --resume --fork-session`
// (fork: never appends to the live session file), codex via `codex exec resume -o` (every
// codex run writes its own rollout file, so the live TUI session is untouched) — and
// (2) execs the target CLI with an intro prompt pointing at summary + archive. The
// renderer runs that script in a fresh tab, so every step is visible in the terminal.
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Claude Code stores sessions per project dir: ~/.claude/projects/<cwd with non-alnum -> '-'>.
// The live session is being written constantly, so newest mtime == the source session.
function newestClaudeSession(cwd) {
  const dir = path.join(HOME, '.claude', 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  let best = null, files;
  try { files = fs.readdirSync(dir); } catch (_) { return null; }
  for (const f of files) {
    if (!/^[0-9a-fA-F-]{36}\.jsonl$/.test(f)) continue;   // main sessions only (<uuid>.jsonl)
    try {
      const fp = path.join(dir, f), m = fs.statSync(fp).mtimeMs;
      if (!best || m > best.mtime) best = { file: fp, mtime: m, sid: f.slice(0, -6) };
    } catch (_) {}
  }
  return best;
}

// Codex rollouts live in ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl; the first
// line is a session_meta record carrying id + cwd. It can be huge (inlined base
// instructions), so pull id/cwd with regexes from the head instead of JSON.parse.
function newestCodexSession(cwd) {
  const root = path.join(HOME, '.codex', 'sessions');
  const all = [];
  (function walk(d, depth) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(fp, depth + 1); }
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { all.push({ file: fp, mtime: fs.statSync(fp).mtimeMs }); } catch (_) {}
      }
    }
  })(root, 0);
  all.sort((a, b) => b.mtime - a.mtime);
  for (const cand of all.slice(0, 50)) {
    try {
      const fd = fs.openSync(cand.file, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const head = buf.toString('utf8', 0, n);
      const id = (head.match(/"id":"([0-9a-fA-F-]{36})"/) || [])[1];
      const cwdM = (head.match(/"cwd":"((?:[^"\\]|\\.)*)"/) || [])[1];
      if (!id) continue;
      let sessCwd = null;
      if (cwdM != null) { try { sessCwd = JSON.parse('"' + cwdM + '"'); } catch (_) {} }
      if (!cwd || sessCwd === cwd) return { ...cand, sid: id };
    } catch (_) {}
  }
  return null;
}

ipcMain.handle('handoff:prepare', (_e, req) => {
  try {
    req = req || {};
    const src = req.srcAgent, dst = req.dstAgent;
    if (!['claude', 'codex'].includes(src) || !['claude', 'codex'].includes(dst) || src === dst) return { ok: false, err: 'bad-args' };
    const cwd = (typeof req.cwd === 'string' && path.isAbsolute(req.cwd)) ? req.cwd : HOME;
    const tx = {};
    for (const k of ['summaryPrompt', 'intro', 'generating', 'warnFail', 'archived']) {
      const v = (req.texts || {})[k];
      tx[k] = typeof v === 'string' ? v.slice(0, 4000) : '';
    }
    const found = src === 'claude' ? newestClaudeSession(cwd) : newestCodexSession(cwd);
    if (!found || !found.sid) return { ok: false, err: 'no-session' };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(HOME, '.byline', 'handoffs', stamp + '-' + src + '-to-' + dst);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, 'transcript.jsonl');
    fs.copyFileSync(found.file, archive);
    const summary = path.join(dir, 'handoff.md');

    const intro = tx.intro
      .replaceAll('{SRC}', src === 'claude' ? 'Claude' : 'Codex')
      .replaceAll('{SUMMARY}', summary)
      .replaceAll('{ARCHIVE}', archive);
    const sumCmd = src === 'claude'
      ? 'claude -p --resume ' + shq(found.sid) + ' --fork-session ' + shq(tx.summaryPrompt) + ' > ' + shq(summary)
      : 'codex exec resume ' + shq(found.sid) + ' --skip-git-repo-check -o ' + shq(summary) + ' ' + shq(tx.summaryPrompt);

    const script = path.join(dir, 'run.sh');
    fs.writeFileSync(script, [
      '#!/bin/sh',
      'cd ' + shq(cwd) + ' 2>/dev/null || cd "$HOME"',
      // the new tab's zsh reported $HOME via OSC 7 before this script ran; re-report the
      // project dir so a chained handoff from this tab resolves sessions correctly
      "printf '\\033]7;file://%s\\007' \"$PWD\"",
      'echo ' + shq('📦 ' + tx.archived + ' ' + archive),
      'echo ' + shq('⏳ ' + tx.generating),
      sumCmd + ' || echo ' + shq('⚠️ ' + tx.warnFail),
      'echo ""',
      'exec ' + dst + ' ' + shq(intro),
      '',
    ].join('\n'), { mode: 0o755 });
    return { ok: true, dir, script, archive, summary, sid: found.sid };
  } catch (err) {
    return { ok: false, err: String((err && err.message) || err) };
  }
});

ipcMain.on('pty:input',  (_e, { id, data }) => { const s = sessions.get(id); if (s) s.p.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const s = sessions.get(id); if (s) { try { s.p.resize(cols, rows); } catch (_) {} } });
ipcMain.on('pty:kill',   (_e, { id }) => {
  const s = sessions.get(id);
  if (s) { clearTimeout(s.flushT); try { s.p.kill(); } catch (_) {} }
  sessions.delete(id);
  if (validId(id)) unlinkStatus(id);
});

// The app menu is data-driven: the renderer sends the user's configurable quick-launch
// commands (label/command/accelerator) and we build the "会话" menu from them, so the
// shortcuts work app-wide and show in the menu. Menu clicks/accelerators post back to the
// renderer, which actually opens the session.
function buildMenu(payload) {
  payload = payload || {};
  const quick = Array.isArray(payload.quick) ? payload.quick : [];
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const L = payload.labels || {};                    // localized labels from the renderer (default English)
  const lb = (k, fb) => L[k] || fb;
  const send = (d) => { if (win && !win.isDestroyed()) win.webContents.send('menu:action', d); };
  const accOf = (id) => { const a = actions.find(x => x.id === id); return (a && a.accel) ? a.accel : undefined; };
  const labelOf = (id, fb) => { const a = actions.find(x => x.id === id); return (a && a.label) || fb; };
  const act = (id, fb) => ({ label: labelOf(id, fb), accelerator: accOf(id), click: () => send({ type: 'action', id }) });

  const quickItems = quick.filter(q => q && q.cmd).map(q => ({
    label: lb('newQuickSession', 'New {name} session').replace('{name}', q.label || q.cmd),
    accelerator: q.accel || undefined,
    click: () => send({ type: 'newQuick', cmd: q.cmd, label: q.label || q.cmd }),
  }));
  const sessionSub = quickItems.slice();
  if (quickItems.length) sessionSub.push({ type: 'separator' });
  sessionSub.push(act('newShell', 'New terminal'));
  sessionSub.push(act('closeTab', 'Close current tab'));

  const opSub = [
    act('rename', 'Rename current tab'),
    act('sidebar', 'Show/hide sessions sidebar'),
    act('palette', 'Command palette'),
    act('search', 'Search'),
    act('zoom', 'Zoom window'),
    act('theme', 'Toggle theme'),
    act('clear', 'Clear screen'),
  ];

  const template = [
    { label: 'Byline', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: lb('settings', 'Preferences…'), accelerator: accOf('settings') || 'Cmd+,', click: () => send({ type: 'action', id: 'settings' }) },
      { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: lb('menuSession', 'Session'), submenu: sessionSub },
    { label: lb('menuOps', 'Actions'), submenu: opSub },
    { label: lb('menuEdit', 'Edit'), submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: lb('menuView', 'View'), submenu: [
      { role: 'toggleDevTools' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ]},
    { label: lb('menuWindow', 'Window'), submenu: [
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
