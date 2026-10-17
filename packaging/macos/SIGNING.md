# Signing and notarizing FiberBrowser.app

For the maintainer. `build_app.sh` signs with a **Developer ID Application**
identity when the keychain has one and notarizes when the `fiberhmm-notary`
notarytool profile exists; otherwise it signs ad-hoc and says so. CI does the
same from repository secrets (`.github/workflows/release-macos.yml`). No
secret is stored in the repository.

Placeholders below: `TEAMID` (10 characters, e.g. `ABCDE12345`), `KEYID`
(the API key's ID), `ISSUER` (a UUID), `Your Name`.

## 1. The Developer ID Application certificate

Only the Apple Developer account holder can create it.

- **Xcode** (simplest): *Xcode > Settings > Accounts*, select the team, *Manage
  Certificates…*, **+**, *Developer ID Application*.
- **Or the website**: in Keychain Access, *Certificate Assistant > Request a
  Certificate From a Certificate Authority…* (saved to disk); then
  developer.apple.com > *Certificates, IDs & Profiles > Certificates* > **+** >
  *Developer ID Application* (G2 Sub-CA), upload the request, download the
  certificate and double-click it.

Check:

```bash
security find-identity -v -p codesigning
#   1) 0123…ABCD "Developer ID Application: Your Name (TEAMID)"
```

If `codesign` keeps asking for the *login* keychain password (common on
managed Macs, where it differs from the login password), keep the identity in
a separate keychain with a password you choose instead and build with
`FB_KEYCHAIN=<that keychain>`; `build_app.sh` asks for its password once at
the start (in the terminal, or in a macOS dialog when run without one).

## 2. Notarization credentials on this Mac

Either an App Store Connect API key (as CI uses, section 4):

```bash
xcrun notarytool store-credentials fiberhmm-notary \
  --key ~/Downloads/AuthKey_KEYID.p8 --key-id KEYID --issuer ISSUER
```

or an app-specific password (appleid.apple.com > *Sign-In and Security >
App-Specific Passwords*):

```bash
xcrun notarytool store-credentials fiberhmm-notary \
  --apple-id you@example.org --team-id TEAMID --password abcd-efgh-ijkl-mnop
```

Check: `xcrun notarytool history --keychain-profile fiberhmm-notary`.

## 3. Build, sign and notarize locally

```bash
bash packaging/macos/build_app.sh          # prints "Signing with Developer ID: …" and "notarized: yes"
bash packaging/macos/check_app.sh          # smoke test of the result
```

`FB_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"` picks one
identity when there are several; `FB_SIGN_IDENTITY=-` forces ad-hoc;
`FB_NOTARIZE=0` skips notarization. The app and the DMG are both notarized
and stapled, so Gatekeeper accepts them offline.

How it signs: every nested Mach-O (Python extensions, dylibs, minimap2) inside
out with `codesign --force --options runtime --timestamp`, then the app with
`entitlements.plist`. Apple advises against `codesign --deep` for signing (it
gives nested executables the wrong entitlements); it is used only to verify.

**Entitlements** (`entitlements.plist`): the hardened runtime is required for
notarization, and numba compiles FiberHMM's kernels with LLVM at run time into
memory it then executes, which the runtime forbids by default.
`check_app.sh --entitlements` tests this on ad-hoc copies (29 Sep 2026, numba
0.67, macOS 26, arm64):

| Entitlements | numba JIT |
|--------------|-----------|
| allow-jit + allow-unsigned-executable-memory (shipped) | works |
| allow-unsigned-executable-memory only | works |
| allow-jit only | fails |
| none | fails |

So `com.apple.security.cs.allow-unsigned-executable-memory` is the one numba
needs (llvmlite doesn't allocate with `MAP_JIT`); `allow-jit` is kept as
harmless belt-and-braces. The ad-hoc copies also need
`disable-library-validation`, because library validation requires a Team ID
that ad-hoc signatures lack (which is also why ad-hoc builds are signed
without the hardened runtime). A Developer ID build signs every bundled
library with the same Team ID and does **not** need it; confirm on the first
Developer ID build that `check_app.sh` passes (if a library is refused,
`codesign -dv` on it will show a different or missing TeamIdentifier).

## 4. CI secrets

Export the certificate with its private key: Keychain Access > *login* >
*My Certificates*, right-click **Developer ID Application: Your Name (TEAMID)**
(the entry with the key under it) > *Export…* > *Personal Information Exchange
(.p12)*, with a strong password.

Create the API key for notarytool: App Store Connect > *Users and Access >
Integrations > App Store Connect API* > *Team Keys* > **+**, name it (e.g.
"FiberBrowser notarization"), access **Developer**. Download
`AuthKey_KEYID.p8` (possible once only) and note the Key ID and the Issuer ID
shown above the list.

Then, from any machine with the GitHub CLI logged in:

```bash
REPO=fiberseq/FiberBrowser
base64 -i DeveloperID.p12 | gh secret set MACOS_CERT_P12 --repo "$REPO"
gh secret set MACOS_CERT_PASSWORD --repo "$REPO" --body 'the-p12-password'
gh secret set APPLE_TEAM_ID       --repo "$REPO" --body 'TEAMID'
gh secret set ASC_KEY_ID          --repo "$REPO" --body 'KEYID'
gh secret set ASC_ISSUER_ID       --repo "$REPO" --body 'ISSUER'
base64 -i AuthKey_KEYID.p8 | gh secret set ASC_KEY_P8 --repo "$REPO"
gh secret list --repo "$REPO"
```

Delete the exported `.p12` and keep the `.p8` somewhere safe (a password
manager). The workflow imports the certificate into a temporary keychain,
checks its team against `APPLE_TEAM_ID`, stores the notarytool profile in that
keychain, builds, verifies, and deletes the keychain. Run it by hand from the
Actions tab (*Release macOS app > Run workflow*) to test the secrets before a
tag.

## 5. Verify a build

```bash
APP=build/macos/dist/FiberBrowser.app
DMG=build/macos/dist/FiberBrowser-3.0.1-arm64.dmg
codesign -dv --verbose=4 "$APP"             # Authority=Developer ID Application: …, TeamIdentifier=TEAMID,
                                            # Runtime Version=…, Timestamp=…
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vv "$APP"                         # accepted, source=Notarized Developer ID
spctl -a -vv -t open --context context:primary-signature "$DMG"
xcrun stapler validate "$APP"               # The validate action worked!
xcrun stapler validate "$DMG"
```

A notarization that is refused prints its log (`xcrun notarytool log <id>
--keychain-profile fiberhmm-notary`); the usual causes are a nested binary
without the hardened runtime or a secure timestamp, which `build_app.sh`
already handles.

## 6. What is still open until the certificate exists

Everything above was run ad-hoc on 29 Sep 2026 (no Developer ID identity or
notarytool profile on the build Mac yet). Not yet exercised: Developer ID
signing with library validation, notarization, stapling, `spctl` acceptance,
and the CI secrets path. `build_app.sh` switches to them automatically once
section 1 and 2 are done.

## Later: a FiberHMM app in the same DMG

The plan for a FiberHMM runner app (`FiberHMM.icns` is already made) that
shares FiberBrowser.app's runtime rather than bundling a second copy of
Python, numba and FiberHMM (~400 MB):

- `FiberHMM.app` is a small bundle (its own icon, bundle id
  `org.fiberseq.FiberHMM`, `LSMinimumSystemVersion` as FiberBrowser.app) whose
  executable starts `FiberBrowser.app/Contents/MacOS/FiberBrowser --runner`
  (found next to it, or through its bundle id). The one app binary already
  dispatches on its arguments (`fiberbrowser/frozen_entry.py`); `--runner`
  becomes another role, the runner UI (pywebview, like `fiberbrowser.desktop`).
- Jobs run in a background service owned by FiberBrowser.app: a LaunchAgent in
  `FiberBrowser.app/Contents/Library/LaunchAgents/org.fiberseq.fiberhmm-runner.plist`,
  registered with `SMAppService.agent(plistName:)` (macOS 13+), running the same
  binary with `--runner-service`. The service keeps jobs going when both apps
  are closed and reports progress over a local socket; the FiberHMM commands in
  `Contents/Resources/bin` are what it runs.
- `build_app.sh` gains a step after the PyInstaller build: assemble
  `FiberHMM.app`, sign it with the same identity and entitlements, and put both
  apps plus the Applications link in the DMG; notarization covers the DMG and
  both apps are stapled. Both apps must be signed by the same team, or the
  LaunchAgent and the shared binary won't be trusted across them.
