// Byline logger. Byline is still an early build, so we log every meaningful operation to a
// file the maintainer can retrieve after the fact — the main process writes it, the renderer
// forwards its own events over IPC (see preload's `log` + main's `log:write` handler).
//
// Location: ~/Library/Logs/Byline/byline.log (macOS-standard; also visible in Console.app).
// One human-readable line per event: `<ISO ts> <LEVEL> <scope> <event> key=value …`.
// Rotation is size-based and checked at init, keeping a single .1 backup, so the file can
// never grow without bound across runs. High-frequency data paths (PTY bytes, keystrokes,
// acks, resize) are intentionally NOT logged by callers — this module just records what it
// is handed; it never sees terminal I/O.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BYTES = 5 * 1024 * 1024;   // rotate byline.log -> byline.log.1 past this size
const MAX_VAL = 300;                  // truncate any single value to keep lines readable & bounded
const PID = process.pid;

let logDir = path.join(os.homedir(), 'Library', 'Logs', 'Byline');
let logFile = path.join(logDir, 'byline.log');
let stream = null;

// Best-effort file value formatting: strings/numbers inline, objects as compact JSON, all
// truncated. Never throws — logging must not be able to crash a caller.
function fmtVal(v) {
  try {
    if (v == null) return String(v);
    if (typeof v === 'string') return v.length > MAX_VAL ? v.slice(0, MAX_VAL) + '…' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Error) return (v.message || String(v));
    let s = JSON.stringify(v);
    if (s == null) s = String(v);
    return s.length > MAX_VAL ? s.slice(0, MAX_VAL) + '…' : s;
  } catch (_) { try { return String(v); } catch (__) { return '?'; } }
}

// data is an optional flat object -> ` key=value` pairs. Nested objects are JSON-encoded.
function fmtData(data) {
  if (data == null || typeof data !== 'object') return data == null ? '' : ' ' + fmtVal(data);
  const parts = [];
  for (const k of Object.keys(data)) {
    if (data[k] === undefined) continue;
    parts.push(k + '=' + fmtVal(data[k]));
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function write(level, scope, event, data) {
  let line;
  try {
    const ts = new Date().toISOString();
    line = ts + ' ' + level.toUpperCase().padEnd(5) + ' [' + scope + '#' + PID + '] ' + event + fmtData(data);
  } catch (_) { return; }
  if (stream) { try { stream.write(line + '\n'); } catch (_) {} }
  // Also surface in the dev console (`npm start`) so live runs show the same stream.
  try { (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line); } catch (_) {}
}

// Open the log file (call once, early). Rotates first if the existing file is oversized.
// Safe to call before app 'ready'; falls back to console-only if the dir can't be created.
function init(dir) {
  try {
    if (dir) { logDir = dir; logFile = path.join(logDir, 'byline.log'); }
    fs.mkdirSync(logDir, { recursive: true });
    try {
      const st = fs.statSync(logFile);
      if (st.size > MAX_BYTES) fs.renameSync(logFile, path.join(logDir, 'byline.log.1'));
    } catch (_) {}
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.on('error', () => { stream = null; });   // disk full / permissions: degrade to console only
  } catch (_) { stream = null; }
  return logFile;
}

module.exports = {
  init,
  file: () => logFile,
  info:  (scope, event, data) => write('info',  scope, event, data),
  warn:  (scope, event, data) => write('warn',  scope, event, data),
  error: (scope, event, data) => write('error', scope, event, data),
};
