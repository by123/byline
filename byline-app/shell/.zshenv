# Byline shell integration. Sources the user's real z-files, then re-asserts ZDOTDIR so
# Byline's .zshrc (with OSC 133 hooks) is what runs. Falls back gracefully.
BYLINE_ZDOTDIR="${BYLINE_ZDOTDIR:-$HOME}"
[ -f "$BYLINE_ZDOTDIR/.zshenv" ] && builtin source "$BYLINE_ZDOTDIR/.zshenv"
[ -n "$BYLINE_INT_DIR" ] && ZDOTDIR="$BYLINE_INT_DIR"
