# CLAUDE.md

Byline is a macOS terminal (Electron + xterm.js + node-pty) that watches AI agent
sessions and hands them between agents. Product docs live in README.md (EN) and
README.zh-CN.md (zh); the app is `byline-app/`, the status protocol is `hooks/`.

## Commands (run in `byline-app/`)

- `npm start` — dev run; `npm run rebuild` first time (node-pty vs Electron ABI)
- `npm run package` — unsigned local build → `dist/Byline-darwin-arm64/Byline.app`
- `npm run deploy` — package + install into /Applications
- `npm run release` — signed + notarized + stapled app **and** DMG (the shippable
  artifact). Universal (Apple Silicon + Intel) by default; `--arch=arm64|x64` to override.

## Release & distribution conventions

- The version lives only in `package.json` `"version"`; `scripts/release.js` reads it
  everywhere (app metadata, DMG filename). Never hardcode versions in scripts.
- `npm run package` and `npm run release` are the same script (`scripts/release.js`,
  `--unsigned` for the former). Packaging options are defined once, in that script.
- Signing: Developer ID cert auto-detected from the keychain (`CSC_NAME` to pin);
  hardened runtime + `build/entitlements.plist`. All three entitlements are required —
  JIT and unsigned-exec-memory for Electron, disable-library-validation because
  node-pty's `.node` addon loads via dlopen. Don't trim them without launching the
  signed build to verify.
- Notarization credentials come from env vars (see `byline-app/RELEASING.md`); on the
  maintainer's machine they are already exported in `~/.zshrc` and the API key lives in
  `~/keys/` (chmod 600). Never place `.p8` keys in the repo or on the Desktop (iCloud
  syncs Desktop).
- Do NOT add signing/notarization npm deps — `@electron/packager` v18 already bundles
  `@electron/osx-sign` and `@electron/notarize`.
- Universal builds: node-pty ships per-arch Mach-O artifacts (`pty.node` +
  `spawn-helper`); `scripts/release.js` rebuilds it for x64 and arm64 and `lipo`s the
  results before packaging. Don't package a foreign/universal arch without this step —
  the app would crash on the other chip.
- Publishing = GitHub Releases on this (public) repo:
  `gh release create v<version> byline-app/dist/Byline-<version>-universal.dmg`.
  Release notes: English body + a short Chinese footer. READMEs link
  `releases/latest`, so no README edit is needed per release.
- Known-harmless warning during packaging: `Could not find icon … with extension
  ".icon"` — packager probing the new macOS icon format; the `.icns` is still applied
  (verified by checksum once; don't chase it).
- Never edit files under `byline-app/` while a universal build is running: the two
  arch slices copy the source at different times, and `@electron/universal` fails on
  any non-binary file whose SHA differs between slices. Repo-root files (README,
  CLAUDE.md) are outside the packaged dir and safe to edit.

## Docs conventions

- `README.md` and `README.zh-CN.md` are mirrors: every content change lands in both,
  same section order.
- Positioning: two co-flagship features, in this order — (1) live agent status,
  (2) agent handoff (claude ↔ codex, context included). README section order:
  Why → status detection → handoff → real terminal → multi-session. Keep the
  download blockquote directly under the showcase screenshot.
- Maintainer release runbook (one-time setup, troubleshooting): `byline-app/RELEASING.md`.
