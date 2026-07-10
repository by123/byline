#!/bin/sh
# Install (or remove) the Byline status hook for Claude Code and Codex CLI.
#
#   ./install.sh              copy byline-status to ~/.byline/ and register it in
#                             ~/.claude/settings.json AND ~/.codex/hooks.json
#                             (a .byline-backup of each edited file is kept)
#   ./install.sh --uninstall  remove the hook entries again
#
# The hook publishes live per-tab status and, from the agent's hook payload, the tab's
# session id + transcript path (see byline-status) so Byline hands off THIS tab's session.
# Requires python3 (ships with Xcode Command Line Tools) to edit the JSON safely.
set -e

SRC="$(cd "$(dirname "$0")" && pwd)/byline-status"
DEST="$HOME/.byline/byline-status"

command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required to edit the hook config JSON" >&2; exit 1; }

if [ "$1" != "--uninstall" ]; then
  mkdir -p "$HOME/.byline"
  cp "$SRC" "$DEST"
  chmod +x "$DEST"
fi

MODE="${1:-install}" DEST="$DEST" python3 <<'PY'
import json, os, shutil

mode = os.environ['MODE']
dest = os.environ['DEST']

# Byline sidebar states: think -> thinking, confirm -> needs confirmation, done -> done,
# start/off -> idle. Every event that means "the agent is working" maps to think. Codex
# uses the same hook schema and event names as Claude Code, minus PostToolUseFailure.
CLAUDE_EVENTS = {
    'SessionStart':       'start',
    'UserPromptSubmit':   'think',
    'PreToolUse':         'think',
    'PostToolUse':        'think',
    'PostToolUseFailure': 'think',
    'PermissionRequest':  'confirm',
    'Stop':               'done',
}
CODEX_EVENTS = {k: v for k, v in CLAUDE_EVENTS.items() if k != 'PostToolUseFailure'}

is_ours = lambda h: 'byline-status' in h.get('command', '')

def apply(path, events, extra):
    """Register (or, in uninstall mode, drop) our hook in a Claude/Codex hooks JSON file.

    Both files share the shape {"hooks": {<Event>: [ {"hooks": [ {command...} ]} ]}}. We only
    ever add/remove our own group, leaving any other hooks (lynx-memory, etc.) intact.
    Returns 'changed' | 'nothing' | 'skipped' (skipped: uninstall of a file that doesn't exist).
    """
    try:
        with open(path) as f:
            settings = json.load(f)
    except FileNotFoundError:
        if mode == '--uninstall':
            return 'skipped'
        settings = {}
    except ValueError:
        settings = {}

    hooks = settings.setdefault('hooks', {})
    changed = False
    for ev, word in events.items():
        groups = hooks.setdefault(ev, [])
        had = any(is_ours(h) for g in groups for h in g.get('hooks', []))
        if mode == '--uninstall':
            if had:
                for g in groups:
                    g['hooks'] = [h for h in g.get('hooks', []) if not is_ours(h)]
                groups[:] = [g for g in groups if g.get('hooks')]
                if not groups:
                    del hooks[ev]
                changed = True
        elif not had:
            entry = {'type': 'command', 'command': '"%s" %s' % (dest, word), 'timeout': 10}
            entry.update(extra)
            groups.append({'hooks': [entry]})
            changed = True

    if not changed:
        return 'nothing'
    if os.path.exists(path):
        shutil.copy2(path, path + '.byline-backup')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write('\n')
    return 'changed'

targets = [
    ('Claude Code', os.path.expanduser('~/.claude/settings.json'), CLAUDE_EVENTS, {'async': True}),
    ('Codex CLI',   os.path.expanduser('~/.codex/hooks.json'),     CODEX_EVENTS, {}),
]
verb = 'removed from' if mode == '--uninstall' else 'installed into'
codex_changed = False
for name, path, events, extra in targets:
    res = apply(path, events, extra)
    if res == 'changed':
        print('Byline status hook %s %s: %s (backup kept)' % (verb, name, path))
        if name == 'Codex CLI' and mode != '--uninstall':
            codex_changed = True
    elif res == 'nothing':
        print('Nothing to do for %s: hooks %s.' % (name, 'not present' if mode == '--uninstall' else 'already installed'))
    # 'skipped' (codex not installed) prints nothing

# Codex gates newly added hooks behind a one-time interactive trust screen.
if codex_changed:
    print('')
    print('Codex: on your next `codex` launch it will show "Review hooks" —')
    print('choose "Trust all and continue" so the Byline hook is allowed to run.')
PY

if [ "$1" != "--uninstall" ]; then
  echo "Hook script: $DEST"
  echo "New Claude Code / Codex sessions started inside Byline will now report live status"
  echo "and enable per-tab agent handoff."
fi
