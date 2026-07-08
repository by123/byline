#!/usr/bin/env node
// Package Byline.app — signed, notarized and wrapped in a DMG unless --unsigned.
//
// Arch: --arch=arm64|x64|universal. Releases default to universal (one DMG for
// Apple Silicon + Intel); unsigned dev builds default to the host arch.
//
// Unsigned (local dev, `npm run package`):
//   node scripts/release.js --unsigned
//
// Signed release (`npm run release`) additionally needs:
//   - a "Developer ID Application" certificate in the login keychain
//     (override auto-detection with CSC_NAME="Developer ID Application: …")
//   - notarization credentials in the environment, either an App Store
//     Connect API key:
//       APPLE_API_KEY=/path/to/AuthKey_XXXX.p8  APPLE_API_KEY_ID=…  APPLE_API_ISSUER=…
//     or an Apple ID with an app-specific password:
//       APPLE_ID=…  APPLE_APP_SPECIFIC_PASSWORD=…  APPLE_TEAM_ID=…
//
// See RELEASING.md for the one-time setup.

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packager } = require('@electron/packager');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
const unsigned = process.argv.includes('--unsigned');
const archArg = process.argv.find((a) => a.startsWith('--arch='));
const arch = archArg ? archArg.slice('--arch='.length) : unsigned ? process.arch : 'universal';
if (!['arm64', 'x64', 'universal'].includes(arch)) {
  console.error(`release: unknown --arch=${arch} (use arm64, x64 or universal)`);
  process.exit(1);
}

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

// Returns credentials in both shapes we need them: @electron/notarize options
// (app notarization, via packager) and notarytool CLI flags (DMG notarization).
function notarizeCredentials() {
  const e = process.env;
  if (e.APPLE_API_KEY && e.APPLE_API_KEY_ID && e.APPLE_API_ISSUER) {
    return {
      notarize: {
        appleApiKey: e.APPLE_API_KEY,
        appleApiKeyId: e.APPLE_API_KEY_ID,
        appleApiIssuer: e.APPLE_API_ISSUER,
      },
      notarytool: ['--key', e.APPLE_API_KEY, '--key-id', e.APPLE_API_KEY_ID, '--issuer', e.APPLE_API_ISSUER],
    };
  }
  if (e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID) {
    return {
      notarize: {
        appleId: e.APPLE_ID,
        appleIdPassword: e.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: e.APPLE_TEAM_ID,
      },
      notarytool: ['--apple-id', e.APPLE_ID, '--password', e.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', e.APPLE_TEAM_ID],
    };
  }
  fail(
    'notarization credentials missing. Set either\n' +
      '  APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER  (App Store Connect API key)\n' +
      'or\n' +
      '  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID\n' +
      'See RELEASING.md.'
  );
}

function signingIdentity() {
  if (process.env.CSC_NAME) return process.env.CSC_NAME;
  const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const m = out.match(/"(Developer ID Application: [^"]+)"/);
  if (!m) {
    fail(
      'no "Developer ID Application" certificate in the keychain.\n' +
        'Create one at https://developer.apple.com/account/resources/certificates\n' +
        '(or Xcode → Settings → Accounts → Manage Certificates), then retry.\n' +
        'See RELEASING.md.'
    );
  }
  return m[1];
}

// node-pty ships per-arch Mach-O artifacts (pty.node + spawn-helper). A
// universal app needs them as fat binaries: rebuild for each arch, then lipo
// the results back into build/Release. Single foreign-arch builds just rebuild.
async function ensureNodePty() {
  if (arch === process.arch) return; // npm run rebuild already produced this
  const { rebuild } = require('@electron/rebuild');
  const electronVersion = require('electron/package.json').version;
  const relDir = path.join(root, 'node_modules', 'node-pty', 'build', 'Release');
  const arches = arch === 'universal' ? ['x64', 'arm64'] : [arch];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'byline-pty-'));
  try {
    for (const a of arches) {
      console.log(`Rebuilding node-pty for ${a} …`);
      await rebuild({ buildPath: root, electronVersion, arch: a, force: true, onlyModules: ['node-pty'] });
      fs.cpSync(relDir, path.join(tmp, a), { recursive: true });
    }
    if (arch === 'universal') {
      for (const f of fs.readdirSync(path.join(tmp, 'arm64'))) {
        const parts = arches.map((a) => path.join(tmp, a, f));
        if (!parts.every((p) => fs.existsSync(p) && fs.statSync(p).isFile())) continue;
        if (!execFileSync('file', ['-b', parts[0]], { encoding: 'utf8' }).includes('Mach-O')) continue;
        execFileSync('lipo', ['-create', '-output', path.join(relDir, f), ...parts]);
        console.log(`node-pty ${f}: now universal`);
      }
    } else {
      console.log(`Note: node_modules/node-pty is now built for ${arch}; run "npm run rebuild" before "npm start".`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  // Validate prerequisites before the slow packaging step.
  const creds = unsigned ? null : notarizeCredentials();
  const identity = unsigned ? null : signingIdentity();
  if (!unsigned) console.log(`Signing as: ${identity}`);

  await ensureNodePty();

  const [outDir] = await packager({
    dir: root,
    name: 'Byline',
    platform: 'darwin',
    arch,
    icon: path.join(root, 'build', 'icon.icns'),
    appBundleId: 'sh.byline.app',
    appVersion: pkg.version,
    appCategoryType: 'public.app-category.developer-tools',
    overwrite: true,
    out: path.join(root, 'dist'),
    ignore: [
      /^\/dist/,
      /^\/scripts/,
      /^\/RELEASING\.md$/,
      /zcompdump/,
      /zsh_history/,
      /zsh_sessions/,
      // node-pty's loader only reads build/{Release,Debug} and prebuilds/ — the
      // npm-shipped bin/ prebuilds are dead weight (and single-arch, breaking universal).
      /^\/node_modules\/node-pty\/(bin|prebuilds|third_party|deps|src)($|\/)/,
      // Compile-time leftovers; runtime only needs build/Release/{pty.node,spawn-helper}.
      // Single-arch .o files also break @electron/universal's Mach-O merge.
      /^\/node_modules\/node-pty\/build\/(?!Release($|\/))/,
      /^\/node_modules\/node-pty\/build\/Release\/(\.deps|\.forge-meta|obj\.target|node-addon-api)($|\/)/,
    ],
    ...(unsigned
      ? {}
      : {
          osxSign: {
            identity,
            optionsForFile: () => ({
              hardenedRuntime: true,
              entitlements: path.join(root, 'build', 'entitlements.plist'),
            }),
          },
          // Also staples the ticket to the .app once Apple approves.
          osxNotarize: creds.notarize,
        }),
  });

  const app = path.join(outDir, 'Byline.app');
  if (unsigned) {
    console.log(`Packaged (unsigned): ${app}`);
    return;
  }
  console.log(`Signed, notarized and stapled: ${app}`);

  // Wrap in a DMG with an /Applications drop target, then sign, notarize
  // and staple the image itself so it mounts clean even offline.
  const dmg = path.join(root, 'dist', `Byline-${pkg.version}-${arch}.dmg`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'byline-dmg-'));
  try {
    execFileSync('ditto', [app, path.join(staging, 'Byline.app')]);
    fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
    fs.rmSync(dmg, { force: true });
    execFileSync('hdiutil', ['create', '-volname', 'Byline', '-srcfolder', staging, '-format', 'UDZO', dmg], {
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  execFileSync('codesign', ['--sign', identity, '--timestamp', dmg], { stdio: 'inherit' });
  console.log('Notarizing DMG (usually 1–5 minutes) …');
  execFileSync('xcrun', ['notarytool', 'submit', dmg, '--wait', ...creds.notarytool], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  console.log(`\nRelease ready: ${dmg}`);
}

main().catch((err) => fail(err.stack || String(err)));
