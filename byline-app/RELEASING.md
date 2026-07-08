# Releasing Byline (signed + notarized)

`npm run release` produces a signed, notarized, stapled `Byline.app` and a
`dist/Byline-<version>-universal.dmg` (one image for Apple Silicon + Intel)
ready for public download. Universal builds rebuild node-pty for both arches
and `lipo` the artifacts automatically; pass `--arch=arm64` or `--arch=x64`
for a single-arch build. `npm run package` stays the unsigned local-dev build
(host arch).

## One-time setup

You need a paid Apple Developer Program membership.

### 1. Developer ID Application certificate

Easiest via Xcode: **Settings → Accounts → (your team) → Manage Certificates →
"+" → Developer ID Application**. Or create it at
<https://developer.apple.com/account/resources/certificates> and double-click
the downloaded `.cer` to install it into the login keychain.

Verify it's visible:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

The release script auto-detects this certificate; if you have several, pin one
with `CSC_NAME="Developer ID Application: Your Name (TEAMID)"`.

> Note: "Apple Development" certificates (from normal Xcode dev work) cannot be
> used for distribution — it must say **Developer ID Application**.

### 2. Notarization credentials

Preferred: an **App Store Connect API key** — App Store Connect →
**Users and Access → Integrations → App Store Connect API → "+"** (role:
Developer is enough). Download the `.p8` once, note the Key ID and Issuer ID,
then put in your shell profile:

```bash
export APPLE_API_KEY="$HOME/keys/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Alternative: Apple ID + app-specific password (from
<https://account.apple.com> → Sign-In and Security):

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"   # from https://developer.apple.com/account (Membership)
```

## Every release

```bash
# 1. Bump "version" in package.json, commit.
cd byline-app
npm run release
```

The script packages the app, signs everything (frameworks, helpers, the
node-pty addon) with the hardened runtime + `build/entitlements.plist`,
submits to Apple for notarization (usually 1–5 min), staples the ticket,
then builds, signs, notarizes and staples the DMG.

Verify before publishing:

```bash
spctl --assess --type open --context context:primary-signature -v dist/Byline-*.dmg
xcrun stapler validate dist/Byline-*.dmg
```

Then upload the DMG somewhere publicly downloadable (GitHub Releases on a
public repo, or a website). Once a stable URL exists, a Homebrew Cask
(`brew install --cask byline`) is the natural next channel.

## Troubleshooting

- **Notarization "Invalid"** — run
  `xcrun notarytool log <submission-id> --key … --key-id … --issuer …` for the
  itemized reasons; the usual culprit is an unsigned nested binary.
- **Signing succeeds but app won't launch** — entitlements too strict; Electron
  needs `allow-jit` (see `build/entitlements.plist`).
- **`errSecInternalComponent` during signing** — keychain locked; run
  `security unlock-keychain login.keychain-db`.
