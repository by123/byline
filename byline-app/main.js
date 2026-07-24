// Byline main process. A real terminal: each session is a genuine interactive login zsh
// running on a PTY (node-pty). Raw bytes pass straight through to xterm.js in the renderer,
// so everything works: p10k prompt, native tab completion, colors, vim, ssh, claude, codex.
const { app, BrowserWindow, ipcMain, nativeTheme, screen, Menu, shell, clipboard, net } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const log = require('./logger');

app.setName('Byline');

const HOME = os.homedir();

// Open the log file before anything else so even early failures land on disk. Byline is an
// early build; every meaningful operation below is logged for after-the-fact investigation.
log.init();
log.info('main', 'app-start', {
  version: app.getVersion(), electron: process.versions.electron,
  platform: process.platform, arch: process.arch, pid: process.pid, log: log.file(),
});
// Last-resort nets: a crash in the main process should be recorded, not vanish.
process.on('uncaughtException', err => log.error('main', 'uncaughtException', { err: (err && err.stack) || String(err) }));
process.on('unhandledRejection', reason => log.error('main', 'unhandledRejection', { reason: (reason && reason.stack) || String(reason) }));
const SHELL_INT = path.join(__dirname, 'shell');   // Byline shell-integration z-files (bundled, read-only)
// Per-session status files (see hooks/README.md for the contract). The byline-status hook
// writes one word (start|think|confirm|done|off) to <dir>/<BYLINE_SID>. A list (not a single
// path) only so dev + installed instances can share one status dir.
const STATUS_DIRS = ['/tmp/byline_sessions'];
let RT_SHELL = SHELL_INT;                           // writable copy so zsh caches (.zcompdump) never touch the app bundle
let win = null;

function ensureShellDir() {
  try {
    RT_SHELL = path.join(app.getPath('userData'), 'shell');
    fs.mkdirSync(RT_SHELL, { recursive: true });
    for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      try { fs.copyFileSync(path.join(SHELL_INT, f), path.join(RT_SHELL, f)); }
      catch (e) { log.warn('main', 'shell-copy-fail', { file: f, err: e }); }
    }
    log.info('main', 'shell-dir-ready', { dir: RT_SHELL });
  } catch (e) { RT_SHELL = SHELL_INT; log.warn('main', 'shell-dir-fallback', { dir: RT_SHELL, err: e }); }
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
  if (!s.paused && s.unacked > HIGH_WATER) {
    s.paused = true;
    log.info('main', 'pty-pause', { id, unacked: s.unacked });   // renderer fell behind; flow control kicked in
    try { s.p.pause(); } catch (e) { log.warn('main', 'pty-pause-fail', { id, err: e }); }
  }
}

// Read the per-session status files that the byline-status hook writes (keyed by BYLINE_SID) and
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
      log.info('main', 'hook-state', { id, from: _hookStates[id] || '-', to: state });
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
    try { fs.watch(dir, () => pollHookStates()); }               // instant on change
    catch (e) { log.warn('main', 'hook-watch-fail', { dir, err: e }); }
  }
  setInterval(pollHookStates, 600);                              // robust fallback
  log.info('main', 'hook-watch-start', { dirs: STATUS_DIRS });
}
function unlinkStatus(id) {
  for (const dir of STATUS_DIRS) {
    try { fs.unlinkSync(path.join(dir, id)); } catch (_) {}
    try { fs.unlinkSync(path.join(dir, id + '.session')); } catch (_) {}   // per-tab handoff mapping
  }
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
    if (/^https?:\/\//i.test(url)) { log.info('main', 'window-open-external', { url }); shell.openExternal(url); }
    else log.warn('main', 'window-open-denied', { url });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => { log.warn('main', 'navigate-blocked', { url: e.url }); e.preventDefault(); });
  // a reloaded/crashed renderer regenerates its session ids: reap the old PTYs or they leak
  win.webContents.on('render-process-gone', (_e, d) => { log.error('main', 'render-process-gone', { reason: d && d.reason, exitCode: d && d.exitCode }); killAll(); });
  win.webContents.on('did-start-navigation', e => { if (e.isMainFrame && !e.isSameDocument) { log.warn('main', 'main-frame-navigation', { url: e.url }); killAll(); } });
  win.once('ready-to-show', () => { log.info('main', 'window-ready'); win.show(); });
  win.on('closed', () => { log.info('main', 'window-closed'); killAll(); win = null; });
  log.info('main', 'window-created');
}

function killAll() {
  const n = sessions.size;
  for (const [id, s] of sessions) {
    clearTimeout(s.flushT);
    try { s.p.kill(); } catch (e) { log.warn('main', 'kill-fail', { id, err: e }); }
    unlinkStatus(id);
  }
  sessions.clear();
  if (n) log.info('main', 'kill-all', { count: n });
}

ipcMain.on('pty:start', (_e, { id, cols, rows, cwd }) => {
  if (!validId(id) || sessions.has(id)) {
    log.warn('main', 'pty-start-reject', { id, reason: !validId(id) ? 'bad-id' : 'duplicate' });
    return;
  }
  const shellPath = process.env.SHELL || '/bin/zsh';
  let startCwd = HOME;                                   // open-in-same-dir: honor the renderer's requested cwd
  if (typeof cwd === 'string' && cwd) { try { if (fs.statSync(cwd).isDirectory()) startCwd = cwd; } catch (e) { log.warn('main', 'pty-cwd-reject', { id, cwd, err: e }); } }
  let p;
  try {
    p = pty.spawn(shellPath, ['-il'], {
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
        BYLINE_SID: id,                                      // per-tab id so the byline-status hook can report per session
      },
    });
  } catch (e) {
    log.error('main', 'pty-spawn-fail', { id, shell: shellPath, cwd: startCwd, err: e });
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id });   // let the renderer clean up the dead tab
    return;
  }
  log.info('main', 'pty-start', { id, shell: shellPath, cwd: startCwd, cols: cols || 100, rows: rows || 30, pid: p.pid });
  const s = { p, buf: [], bufLen: 0, flushT: null, unacked: 0, paused: false };
  p.onData(data => {
    s.buf.push(data); s.bufLen += data.length;
    if (s.bufLen >= 65536) { clearTimeout(s.flushT); s.flushT = null; flushPty(id, s); }
    else if (!s.flushT) s.flushT = setTimeout(() => { s.flushT = null; flushPty(id, s); }, 8);
  });
  p.onExit(({ exitCode, signal } = {}) => {
    log.info('main', 'pty-exit', { id, pid: p.pid, exitCode, signal });
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
  if (s.paused && s.unacked < LOW_WATER) {
    s.paused = false;
    log.info('main', 'pty-resume', { id, unacked: s.unacked });
    try { s.p.resume(); } catch (e) { log.warn('main', 'pty-resume-fail', { id, err: e }); }
  }
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
ipcMain.on('win:zoom', () => { log.info('main', 'win-zoom'); zoomWindow(); });

ipcMain.on('shell:open-external', (_e, { url }) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) { log.info('main', 'open-external', { url }); shell.openExternal(url); }
  else log.warn('main', 'open-external-reject', { url });
});

// File-tree double-click: open a file with the system default app. shell.openPath
// resolves to '' on success or an error message.
ipcMain.handle('shell:open-path', async (_e, { path: p } = {}) => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) { log.warn('main', 'open-path-reject', {}); return { ok: false, err: 'bad-path' }; }
  const err = await shell.openPath(p);
  log[err ? 'warn' : 'info']('main', err ? 'open-path-fail' : 'open-path', err ? { err } : {});   // path omitted (may be sensitive)
  return err ? { ok: false, err } : { ok: true };
});

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
  } catch (e) { log.warn('main', 'clipboard-files-plist-fail', { err: e }); }
  if (!out.length) {
    try { const u = clipboard.read('public.file-url'); if (u) out.push(fileURLToPath(u.trim())); } catch (e) { log.warn('main', 'clipboard-files-url-fail', { err: e }); }
  }
  const files = out.filter(p => { try { return typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p); } catch (_) { return false; } });
  log.info('main', 'clipboard-files', { count: files.length });   // paths themselves omitted (may be sensitive)
  return files;
});

ipcMain.handle('clipboard:text', () => { try { return clipboard.readText(); } catch (e) { log.warn('main', 'clipboard-text-fail', { err: e }); return ''; } });
ipcMain.on('clipboard:write', (_e, { text }) => { try { if (typeof text === 'string') { clipboard.writeText(text); log.info('main', 'clipboard-write', { len: text.length }); } } catch (e) { log.warn('main', 'clipboard-write-fail', { err: e }); } });

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

// Authoritative per-tab source: the byline-status hook writes /tmp/byline_sessions/<sid>.session
// = "<session_id>\n<transcript_path>" for the agent session running in that tab. Both Claude and
// Codex hooks carry the same fields (session_id + transcript_path — for codex the transcript is
// the rollout file). Preferring this over newest-mtime is what keeps a handoff bound to the tab
// the user clicked, even when two tabs of the same agent share one project dir. Each read is
// gated on the transcript living under THAT agent's own store, so a stale map left by a tab's
// previous agent can never be used for the wrong handoff (we fall back to newest-mtime instead).
function mappedSession(agent, sid) {
  if (!validId(sid)) return null;
  const root = (agent === 'claude'
    ? path.join(HOME, '.claude', 'projects')
    : path.join(HOME, '.codex', 'sessions')) + path.sep;
  for (const dir of STATUS_DIRS) {
    try {
      const [id, file] = fs.readFileSync(path.join(dir, sid + '.session'), 'utf8').split('\n');
      const fileV = (file || '').trim();
      if (!fileV || !fileV.startsWith(root) || !fs.existsSync(fileV)) continue;
      let sidV = (id || '').trim();
      if (!sidV) {                                              // fall back to the id in the filename
        const base = path.basename(fileV).replace(/\.jsonl$/, '');
        sidV = agent === 'claude' ? base : base.slice(-36);     // codex: rollout-<ts>-<uuid>.jsonl
      }
      if (sidV) return { file: fileV, sid: sidV };
    } catch (_) {}
  }
  return null;
}

ipcMain.handle('handoff:prepare', (_e, req) => {
  try {
    req = req || {};
    const src = req.srcAgent, dst = req.dstAgent;
    log.info('main', 'handoff-prepare', { src, dst, cwd: req.cwd });
    if (!['claude', 'codex'].includes(src) || !['claude', 'codex'].includes(dst) || src === dst) { log.warn('main', 'handoff-bad-args', { src, dst }); return { ok: false, err: 'bad-args' }; }
    const cwd = (typeof req.cwd === 'string' && path.isAbsolute(req.cwd)) ? req.cwd : HOME;
    const tx = {};
    for (const k of ['summaryPrompt', 'intro', 'generating', 'warnFail', 'archived']) {
      const v = (req.texts || {})[k];
      tx[k] = typeof v === 'string' ? v.slice(0, 4000) : '';
    }
    const mapped = mappedSession(src, req.sid);
    const found = mapped || (src === 'claude' ? newestClaudeSession(cwd) : newestCodexSession(cwd));
    if (!found || !found.sid) { log.warn('main', 'handoff-no-session', { src, cwd, tab: req.sid }); return { ok: false, err: 'no-session' }; }
    log.info('main', 'handoff-source-found', { src, sid: found.sid, file: found.file, tab: req.sid, via: mapped ? 'tab-map' : 'newest-mtime' });

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
    log.info('main', 'handoff-ready', { src, dst, dir, sid: found.sid });
    return { ok: true, dir, script, archive, summary, sid: found.sid };
  } catch (err) {
    log.error('main', 'handoff-fail', { src: req && req.srcAgent, dst: req && req.dstAgent, err });
    return { ok: false, err: String((err && err.message) || err) };
  }
});

// --- Session transcript viewer (sidebar conversation dialog) --------------------------
// The renderer's per-tab conversation list can open a dialog showing the real agent
// conversation. The terminal only ever sees a full-screen agent's redraw noise, so the
// clean record must come from the agent's own transcript file — the same source handoff
// uses (tab-map first, newest-mtime fallback). Read-only; only the agent's own store.
function txtFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    // keep spoken text only; skip thinking / tool_use / tool_result so the view stays clean
    if ((b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}
// injected/system user messages that aren't things the human actually typed
const INJECTED_USER_RE = /^\s*(<(command-name|command-message|command-args|local-command-stdout|environment_context|permissions|user_instructions|system-reminder|turn_aborted)\b|# AGENTS\.md|# Codebase|Caveat: The messages below)/i;
function parseTranscript(file) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    let role = null, text = '';
    const ts = o.timestamp || null;
    if (o.message && (o.message.role === 'user' || o.message.role === 'assistant')) {   // claude
      role = o.message.role; text = txtFromContent(o.message.content);
    } else if (o.type === 'event_msg' && o.payload) {                                   // codex (cleanest stream)
      if (o.payload.type === 'user_message') { role = 'user'; text = String(o.payload.message || ''); }
      else if (o.payload.type === 'agent_message') { role = 'assistant'; text = String(o.payload.message || ''); }
    }
    if (!role) continue;
    text = text.trim();
    if (!text) continue;                                   // drops tool-result / thinking-only turns
    if (role === 'user' && INJECTED_USER_RE.test(text)) continue;
    out.push({ role, text: text.slice(0, 12000), ts });
  }
  return out;
}
ipcMain.handle('session:transcript', (_e, req) => {
  try {
    req = req || {};
    let agent = req.agent === 'codex' ? 'codex' : (req.agent === 'claude' ? 'claude' : null);
    const cwd = (typeof req.cwd === 'string' && path.isAbsolute(req.cwd)) ? req.cwd : HOME;
    // resolve the transcript: prefer the tab-map (authoritative), else newest by mtime. When the
    // agent is unknown, try whichever store has a map for this tab, then claude, then codex.
    let found = null;
    if (agent) found = mappedSession(agent, req.sid) || (agent === 'claude' ? newestClaudeSession(cwd) : newestCodexSession(cwd));
    else {
      for (const a of ['claude', 'codex']) { const m = mappedSession(a, req.sid); if (m) { found = m; agent = a; break; } }
      if (!found) { found = newestClaudeSession(cwd); agent = 'claude'; if (!found) { found = newestCodexSession(cwd); agent = 'codex'; } }
    }
    if (!found || !found.file) { log.warn('main', 'transcript-no-session', { agent, cwd, tab: req.sid }); return { ok: false, err: 'no-session' }; }
    let messages = parseTranscript(found.file);
    const total = messages.length;
    let truncated = false;
    if (messages.length > 600) { messages = messages.slice(-600); truncated = true; }   // cap payload for very long sessions
    log.info('main', 'transcript-read', { agent, sid: found.sid, shown: messages.length, total, tab: req.sid });
    return { ok: true, agent, sid: found.sid, messages, truncated };
  } catch (err) {
    log.error('main', 'transcript-fail', { tab: req && req.sid, err: String((err && err.message) || err) });
    return { ok: false, err: String((err && err.message) || err) };
  }
});

// --- Translate (terminal right-click 翻译) ---------------------------------------------
// Free Google Translate endpoint (gtx) via net.fetch: the Chromium network stack, so the
// system proxy applies — reachability matches the user's browser. Sub-second results.
// The renderer passes Google language codes mapped from the UI locale list; the text
// travels in the POST body, never in a URL or shell command line.
const transJobs = new Map();   // id -> {ac, canceled, timedOut}, so closing the popover can cancel
ipcMain.handle('translate:run', async (_e, req) => {
  req = req || {};
  const id = validId(req.id) ? req.id : null;
  const text = typeof req.text === 'string' ? req.text.slice(0, 20000) : '';
  const langOk = c => typeof c === 'string' && /^[A-Za-z-]{2,7}$/.test(c);
  if (!id || !text.trim()) return { ok: false, err: 'empty' };
  const sl = langOk(req.sl) ? req.sl : 'auto';
  const tl = langOk(req.tl) ? req.tl : 'zh-CN';
  log.info('main', 'translate-start', { id, sl, tl, len: text.length });   // text omitted (may be sensitive)
  const t0 = Date.now();
  const job = { ac: new AbortController(), canceled: false, timedOut: false };
  transJobs.set(id, job);
  const killT = setTimeout(() => { job.timedOut = true; job.ac.abort(); }, 20e3);
  let res;
  try {
    const r = await net.fetch('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' + encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(text),
      signal: job.ac.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    // response shape: [[["译文","source",…],…],…] — segment 0 of each row is the translation
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('unexpected response');
    res = { ok: true, text: data[0].map(seg => (seg && seg[0]) || '').join('').trim() };
  } catch (e) {
    res = { ok: false, err: job.canceled ? 'canceled' : job.timedOut ? 'timeout' : String((e && e.message) || e).slice(0, 300) };
  }
  clearTimeout(killT);
  transJobs.delete(id);
  log[res.ok ? 'info' : 'warn']('main', res.ok ? 'translate-ok' : 'translate-fail', { id, ms: Date.now() - t0, err: res.err });
  return res;
});
ipcMain.on('translate:cancel', (_e, { id } = {}) => {
  const job = transJobs.get(id);
  if (job) { log.info('main', 'translate-cancel', { id }); job.canceled = true; try { job.ac.abort(); } catch (_) {} }
});

// --- File tree (left panel) -------------------------------------------------------------
// Read-only directory listing for the renderer's file tree. Names + is-dir only, never file
// contents. Non-absolute or unreadable roots fall back to $HOME; the resolved root is echoed
// back so the renderer can label the panel and build child paths from it.
const FT_MAX = 400;   // per-directory cap so node_modules-sized dirs don't flood the IPC
ipcMain.handle('fs:list', (_e, { dir } = {}) => {
  let root = (typeof dir === 'string' && path.isAbsolute(dir)) ? path.normalize(dir) : HOME;
  try { if (!fs.statSync(root).isDirectory()) root = HOME; } catch (_) { root = HOME; }
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true }).map(e => {
      let isDir = e.isDirectory();
      // a symlinked dir should still be expandable; a broken link stays a plain file
      if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(root, e.name)).isDirectory(); } catch (_) {} }
      return { name: e.name, dir: isDir };
    }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const more = Math.max(0, entries.length - FT_MAX);
    return { ok: true, dir: root, entries: more ? entries.slice(0, FT_MAX) : entries, more };
  } catch (err) {
    log.warn('main', 'fs-list-fail', { err: String((err && err.message) || err) });   // path omitted (may be sensitive)
    return { ok: false, dir: root, err: String((err && err.message) || err) };
  }
});

// File-tree right-click operations. Every path must be absolute and exist; a supplied
// name is validated so it can never escape its parent directory. Full paths stay out of
// the log (may be sensitive) — the renderer already has them and re-reads on success.
const errStr = e => String((e && e.message) || e).slice(0, 300);
const okPath = p => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p);
const badName = n => typeof n !== 'string' || !n.length || n === '.' || n === '..' || /[/\\\x00]/.test(n);

// Reveal in Finder (select the item in its containing folder).
ipcMain.handle('fs:reveal', (_e, { path: p } = {}) => {
  if (!okPath(p)) { log.warn('main', 'fs-reveal-reject', {}); return { ok: false, err: 'bad-path' }; }
  try { shell.showItemInFolder(p); log.info('main', 'fs-reveal', {}); return { ok: true }; }
  catch (e) { log.warn('main', 'fs-reveal-fail', { err: errStr(e) }); return { ok: false, err: errStr(e) }; }
});

// Move to Trash (reversible from Finder). Refuse $HOME and the volume root as a guard.
ipcMain.handle('fs:trash', async (_e, { path: p } = {}) => {
  if (!okPath(p)) { log.warn('main', 'fs-trash-reject', {}); return { ok: false, err: 'bad-path' }; }
  if (p === HOME || p === path.parse(p).root) { log.warn('main', 'fs-trash-protected', {}); return { ok: false, err: 'protected' }; }
  try { await shell.trashItem(p); log.info('main', 'fs-trash', {}); return { ok: true }; }
  catch (e) { log.warn('main', 'fs-trash-fail', { err: errStr(e) }); return { ok: false, err: errStr(e) }; }
});

// Rename within the same directory.
ipcMain.handle('fs:rename', (_e, { path: p, name } = {}) => {
  if (!okPath(p)) { log.warn('main', 'fs-rename-reject', {}); return { ok: false, err: 'bad-path' }; }
  if (badName(name)) { log.warn('main', 'fs-rename-badname', {}); return { ok: false, err: 'bad-name' }; }
  const target = path.join(path.dirname(p), name);
  if (target === p) return { ok: true, path: p };
  if (fs.existsSync(target)) { log.warn('main', 'fs-rename-exists', {}); return { ok: false, err: 'exists' }; }
  try { fs.renameSync(p, target); log.info('main', 'fs-rename', {}); return { ok: true, path: target }; }
  catch (e) { log.warn('main', 'fs-rename-fail', { err: errStr(e) }); return { ok: false, err: errStr(e) }; }
});

// Create an empty file or a folder inside an existing directory.
ipcMain.handle('fs:create', (_e, { parent, name, dir } = {}) => {
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) { log.warn('main', 'fs-create-reject', {}); return { ok: false, err: 'bad-path' }; }
  try { if (!fs.statSync(parent).isDirectory()) return { ok: false, err: 'bad-path' }; } catch (_) { return { ok: false, err: 'bad-path' }; }
  if (badName(name)) { log.warn('main', 'fs-create-badname', {}); return { ok: false, err: 'bad-name' }; }
  const target = path.join(parent, name);
  if (fs.existsSync(target)) { log.warn('main', 'fs-create-exists', {}); return { ok: false, err: 'exists' }; }
  try {
    if (dir) fs.mkdirSync(target);
    else fs.writeFileSync(target, '', { flag: 'wx' });
    log.info('main', 'fs-create', { dir: !!dir });
    return { ok: true, path: target };
  } catch (e) { log.warn('main', 'fs-create-fail', { err: errStr(e) }); return { ok: false, err: errStr(e) }; }
});

// Duplicate a file or folder next to it as "name copy", "name copy 2", … (Finder-style).
ipcMain.handle('fs:duplicate', (_e, { path: p } = {}) => {
  if (!okPath(p)) { log.warn('main', 'fs-dup-reject', {}); return { ok: false, err: 'bad-path' }; }
  let isDir = false;
  try { isDir = fs.statSync(p).isDirectory(); } catch (_) {}
  const parent = path.dirname(p), full = path.basename(p);
  const ext = isDir ? '' : path.extname(full);
  const base = isDir ? full : path.basename(full, ext);
  let target = '';
  for (let i = 1; i < 1000; i++) {
    const cand = path.join(parent, base + (i === 1 ? ' copy' : ' copy ' + i) + ext);
    if (!fs.existsSync(cand)) { target = cand; break; }
  }
  if (!target) { log.warn('main', 'fs-dup-nofree', {}); return { ok: false, err: 'exists' }; }
  try { fs.cpSync(p, target, { recursive: true }); log.info('main', 'fs-dup', {}); return { ok: true, path: target }; }
  catch (e) { log.warn('main', 'fs-dup-fail', { err: errStr(e) }); return { ok: false, err: errStr(e) }; }
});

// pty:input (keystrokes) and pty:resize are intentionally not logged: keystrokes are
// high-frequency and could capture secrets; resize fires continuously while dragging.
ipcMain.on('pty:input',  (_e, { id, data }) => { const s = sessions.get(id); if (s) s.p.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const s = sessions.get(id); if (s) { try { s.p.resize(cols, rows); } catch (e) { log.warn('main', 'pty-resize-fail', { id, cols, rows, err: e }); } } });
ipcMain.on('pty:kill',   (_e, { id }) => {
  const s = sessions.get(id);
  if (s) { log.info('main', 'pty-kill', { id, pid: s.p && s.p.pid }); clearTimeout(s.flushT); try { s.p.kill(); } catch (e) { log.warn('main', 'kill-fail', { id, err: e }); } }
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
    act('filetree', 'Show/hide files panel'),
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

// Renderer forwards its own log events here so everything lands in one file (see preload.log).
ipcMain.on('log:write', (_e, entry) => {
  entry = entry || {};
  const level = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info';
  log[level]('renderer', String(entry.event || 'event'), entry.data);
});

app.whenReady().then(() => {
  log.info('main', 'app-ready');
  ensureShellDir();
  buildMenu({});
  try { if (app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch (e) { log.warn('main', 'dock-icon-fail', { err: e }); }
  createWindow();
  watchHookStates();
});
app.on('window-all-closed', () => { log.info('main', 'window-all-closed'); killAll(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { log.info('main', 'app-activate', { hasWindow: !!win }); if (!win) createWindow(); });
app.on('before-quit', () => { log.info('main', 'app-quit'); killAll(); });
