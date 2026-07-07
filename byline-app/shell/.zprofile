BYLINE_ZDOTDIR="${BYLINE_ZDOTDIR:-$HOME}"
[ -f "$BYLINE_ZDOTDIR/.zprofile" ] && builtin source "$BYLINE_ZDOTDIR/.zprofile"
[ -n "$BYLINE_INT_DIR" ] && ZDOTDIR="$BYLINE_INT_DIR"
