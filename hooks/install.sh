#!/bin/sh
# Install (or remove) the Byline status hook for Claude Code.
#
#   ./install.sh              copy byline-status to ~/.byline/ and register it in
#                             ~/.claude/settings.json (a .byline-backup is kept)
#   ./install.sh --uninstall  remove the hook entries again
#
# Requires python3 (ships with Xcode Command Line Tools) to edit the JSON safely.
set -e

SRC="$(cd "$(dirname "$0")" && pwd)/byline-status"
DEST="$HOME/.byline/byline-status"

command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required to edit ~/.claude/settings.json" >&2; exit 1; }

if [ "$1" != "--uninstall" ]; then
  mkdir -p "$HOME/.byline"
  cp "$SRC" "$DEST"
  chmod +x "$DEST"
fi

MODE="${1:-install}" DEST="$DEST" python3 <<'PY'
import json, os, shutil

mode = os.environ['MODE']
dest = os.environ['DEST']
path = os.path.expanduser('~/.claude/settings.json')

try:
    with open(path) as f:
        settings = json.load(f)
except (FileNotFoundError, ValueError):
    settings = {}

# Byline sidebar states: think -> thinking, confirm -> needs confirmation, done -> done,
# start/off -> idle. Every event that means "the agent is working" maps to think.
EVENTS = {
    'SessionStart':       'start',
    'UserPromptSubmit':   'think',
    'PreToolUse':         'think',
    'PostToolUse':        'think',
    'PostToolUseFailure': 'think',
    'PermissionRequest':  'confirm',
    'Stop':               'done',
}

hooks = settings.setdefault('hooks', {})
is_ours = lambda h: 'byline-status' in h.get('command', '')
changed = False

for ev, word in EVENTS.items():
    groups = settings['hooks'].setdefault(ev, [])
    had = any(is_ours(h) for g in groups for h in g.get('hooks', []))
    if mode == '--uninstall':
        if had:
            for g in groups:
                g['hooks'] = [h for h in g.get('hooks', []) if not is_ours(h)]
            groups[:] = [g for g in groups if g.get('hooks')]
            if not groups:
                del settings['hooks'][ev]
            changed = True
    elif not had:
        groups.append({'hooks': [{'type': 'command',
                                  'command': '"%s" %s' % (dest, word),
                                  'timeout': 10, 'async': True}]})
        changed = True

if changed:
    if os.path.exists(path):
        shutil.copy2(path, path + '.byline-backup')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write('\n')
    verb = 'removed from' if mode == '--uninstall' else 'installed into'
    print('Byline status hook %s %s (backup: settings.json.byline-backup)' % (verb, path))
else:
    print('Nothing to do: Byline hooks %s.' % ('not present' if mode == '--uninstall' else 'already installed'))
PY

if [ "$1" != "--uninstall" ]; then
  echo "Hook script: $DEST"
  echo "New Claude Code sessions started inside Byline will now report live status."
fi
