# Byline

A macOS **control center for multiple terminal AI agents**. Run `claude`, `codex`,
`cursor-agent` (or anything) each in its own tab, and watch a sidebar that tells you, at a
glance, which agent is **running**, which **needs your input**, and which is **idle** - so
you can drive several agents at once and only jump in when one is waiting on you.

Built on a real terminal: xterm.js over a real PTY (node-pty) running your interactive
`zsh`, so everything works (native tab completion, colors, vim, ssh, your `.zshrc`/p10k).

## Run

```bash
cd byline-app
npm install     # first time only
npm run rebuild # first time only: builds node-pty for Electron's ABI
npm start
```

## Build the app (Byline.app)

```bash
npm run rebuild   # ensure node-pty matches Electron's ABI
npm run package   # -> dist/Byline-darwin-arm64/Byline.app
open dist/Byline-darwin-arm64/Byline.app
```

Produces a real macOS app named **Byline** with its own icon (`build/icon.png` /
`build/icon.icns`), not "Electron". Unsigned (local use); if Gatekeeper blocks a
double-click, run `xattr -dr com.apple.quarantine dist/Byline-darwin-arm64/Byline.app`, or
right-click the app and choose Open once.

## Using it

- The **Sessions sidebar** (right; toggle with `Cmd B`) lists every tab with a live status:
  - 🟢 **Running** - the agent is actively working (streaming output).
  - 🟡 **Needs input** - it paused for you (an approval prompt like `y/n` / "proceed?", or a
    quiet full-screen agent UI). A background tab entering this state raises a toast, an amber
    badge on the sidebar button, and an amber dot on the tab.
  - ⚪ **Idle** - back at the shell prompt, nothing running.
- Open agents fast from the **command palette** (`Cmd K`): *New Claude / Codex / Cursor
  session*. Or just type the command in any tab.
- Click a sidebar row (or a tab) to jump to that session.

## How status detection works

- **Shell integration** (`byline-app/shell/`): loaded via `ZDOTDIR`, it sources your real
  z-files and adds OSC 133 markers (`preexec` = command started, `precmd` = returned to
  prompt). This gives exact **running vs idle**.
- **Needs-input** is inferred while a command is active: output goes quiet (~1s) and either
  the recent output matches an approval pattern (`y/n`, `proceed?`, `approve`, `permission`,
  `❯` menus) or the program is in a full-screen (alternate-screen) UI.

Status detection is heuristic; if a specific agent's prompts are misread, the patterns in
`renderer/index.html` (`WAIT_RE`) are easy to tune.

## Keyboard

`Cmd T` new tab · `Cmd W` close · `Cmd 1..9` switch · `Cmd B` sidebar · `Cmd K` palette ·
`Cmd +/-/0` font · `Cmd C/V` copy/paste. Everything else goes to the shell.

## Layout

```
main.js              node-pty PTY sessions; ZDOTDIR shell integration
shell/               z-files: source user config + OSC 133 hooks
preload.js           sandboxed window.byline bridge
renderer/index.html  xterm.js UI, sessions sidebar, status state machine, palette
renderer/vendor/     vendored xterm.js + addon-fit + xterm.css
```

## Next steps

- Tune per-agent "needs input" patterns from real usage.
- Split panes; persist/restore sessions.
- Package a signed `.app` / `.dmg` (electron-builder) + login `PATH` for double-click launch.
