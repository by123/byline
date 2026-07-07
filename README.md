# Byline

**A macOS control center for running multiple terminal AI agents at once.**

Run `claude`, `codex`, `cursor-agent` (or anything else) each in its own tab, and watch a
live sidebar that tells you — at a glance — which agent is **running**, which **needs your
input**, and which is **idle**. Drive several agents in parallel and only jump in when one
is actually waiting on you.

Byline is a *real* terminal, not a wrapper: it's [xterm.js](https://xtermjs.org/) over a
genuine PTY ([node-pty](https://github.com/microsoft/node-pty)) running your interactive
login `zsh`. So everything just works — native tab completion, colors, `vim`, `ssh`, and
your own `.zshrc` / Powerlevel10k prompt.

> Status: early and local-use (`v0.7.0`). Apple Silicon (arm64), unsigned build.

---

## Repository layout

```
byline-app/            The real Electron app (this is the product)
├── main.js            Main process: node-pty PTY sessions + ZDOTDIR shell integration
├── preload.js         Sandboxed window.byline bridge (context-isolated)
├── renderer/
│   ├── index.html     xterm.js UI, sessions sidebar, status state machine, palette
│   └── vendor/        Vendored xterm.js + addon-fit + xterm.css
├── shell/             Integration z-files: source the user's config + add OSC 133 hooks
└── build/             App icon (icon.png / icon.icns / icon.iconset)

byline-terminal/       Early single-file HTML design prototype (kept for reference)
```

---

## Quick start (development)

```bash
cd byline-app
npm install       # first time only
npm run rebuild   # first time only: builds node-pty against Electron's ABI
npm start
```

## Build the app (`Byline.app`)

```bash
cd byline-app
npm run rebuild   # ensure node-pty matches Electron's ABI
npm run package   # -> dist/Byline-darwin-arm64/Byline.app
open dist/Byline-darwin-arm64/Byline.app
```

This produces a real macOS app named **Byline** with its own icon — not "Electron". It's
unsigned (local use); if Gatekeeper blocks a double-click:

```bash
xattr -dr com.apple.quarantine dist/Byline-darwin-arm64/Byline.app
```

…or right-click the app and choose **Open** once. `npm run deploy` packages and installs
straight into `/Applications`.

---

## Using it

- **Sessions sidebar** (right; toggle with `⌘B`) — every tab with a live status:
  - 🟢 **Running** — the agent is actively working (streaming output).
  - 🟡 **Needs input** — it paused for you (an approval prompt like `y/n` / "proceed?", or a
    quiet full-screen agent UI). A background tab entering this state raises a toast, an
    amber badge on the sidebar button, and an amber dot on the tab.
  - ⚪ **Idle** — back at the shell prompt, nothing running.
- **Command palette** (`⌘K`) — open agents fast: *New Claude / Codex / Cursor session*. Or
  just type the command in any tab.
- Click a sidebar row (or a tab) to jump to that session.

### Keyboard

| Shortcut | Action | Shortcut | Action |
| --- | --- | --- | --- |
| `⌘T` | New tab | `⌘B` | Toggle sidebar |
| `⌘W` | Close tab | `⌘K` | Command palette |
| `⌘1..9` | Switch tab | `⌘ +/-/0` | Font size |
| `⌘C / ⌘V` | Copy / paste | | |

Everything else goes straight to the shell.

---

## How status detection works

- **Shell integration** (`byline-app/shell/`) — loaded via `ZDOTDIR`, it sources your real
  z-files first and then adds OSC 133 markers (`preexec` = a command started, `precmd` =
  returned to the prompt). This gives an exact **running vs. idle** signal. Byline copies
  these z-files to a writable location at runtime, so zsh caches (`.zcompdump`) never touch
  the read-only app bundle.
- **Needs-input** is *inferred* while a command is active: output goes quiet (~1s) and
  either the recent output matches an approval pattern (`y/n`, `proceed?`, `approve`,
  `permission`, `❯` menus) or the program is in a full-screen (alternate-screen) UI.
- **Hook states** — agents that write per-session state files (keyed by `BYLINE_SID` under
  `/tmp/ai_light_sessions`) get authoritative status pushed straight to the matching tab,
  overriding the heuristic.

Status detection is heuristic; if a specific agent's prompts get misread, the patterns live
in `renderer/index.html` (`WAIT_RE`) and are easy to tune.

---

## Tech

- **Electron** (main + sandboxed, context-isolated renderer)
- **node-pty** — real interactive login `zsh` per session
- **xterm.js** + `addon-fit` — terminal rendering, vendored locally
- **OSC 133** shell-integration escape sequences for prompt/command lifecycle

---

## Roadmap

- Tune per-agent "needs input" patterns from real usage.
- Split panes; persist / restore sessions across launches.
- A signed `.app` / `.dmg` (electron-builder) + login `PATH` for clean double-click launch.
- Intel (x64) build alongside arm64.

---

## License

MIT
