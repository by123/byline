# byline-app

The Electron app. Full docs live in the repository root: [README](../README.md)
([中文](../README.zh-CN.md)).

## Develop

```bash
npm install       # first time only
npm run rebuild   # first time only: builds node-pty against Electron's ABI
npm start
```

## Package

```bash
npm run package   # -> dist/Byline-darwin-arm64/Byline.app
npm run deploy    # package + install into /Applications
```

## Layout

```
main.js              Main process: node-pty PTY sessions, status-file watcher
                     (/tmp/byline_sessions), agent handoff (claude <-> codex), app menu
preload.js           Sandboxed window.byline bridge (context-isolated)
renderer/index.html  xterm.js UI: tabs, sidebar, status state machine, palette, settings
renderer/vendor/     Vendored xterm.js + addons (no CDN at runtime)
shell/               ZDOTDIR z-files: source the user's config + OSC 133 markers
build/               App icon (icon.png / icon.icns / icon.iconset)
```

Status semantics and the hook protocol are documented in [../hooks/README.md](../hooks/README.md).
