BYLINE_ZDOTDIR="${BYLINE_ZDOTDIR:-$HOME}"
[ -f "$BYLINE_ZDOTDIR/.zshrc" ] && builtin source "$BYLINE_ZDOTDIR/.zshrc"

# --- Byline shell integration: OSC 133 command markers for per-session status ---
# 133;C = a command started running.  133;D;<exit> = returned to the prompt (idle).
_byline_preexec() { printf '\033]133;C\007'; printf '\033]697;%s\007' "$1" }
_byline_precmd()  { printf '\033]133;D;%s\007' "$?" }
if autoload -Uz add-zsh-hook 2>/dev/null && whence add-zsh-hook >/dev/null 2>&1; then
  add-zsh-hook preexec _byline_preexec
  add-zsh-hook precmd  _byline_precmd
else
  typeset -ag precmd_functions preexec_functions
  preexec_functions+=(_byline_preexec)
  precmd_functions+=(_byline_precmd)
fi
