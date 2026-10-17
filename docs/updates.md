# Updates and the FiberHMM FiberBrowser runs

## Which FiberHMM runs

FiberBrowser runs FiberHMM in its own process for footprint classes, chemistry detection, consensus BAM export and
DAF-seq runs. Which FiberHMM depends on how FiberBrowser was installed.

**The Mac app and the Windows app** (packaged apps) bring their own FiberHMM and use it by default:

1. `FIBERHMM_SOURCE_DIR` (an environment variable naming a FiberHMM source tree), when set;
2. else the app's own choice: **Settings > Analysis & Reproducibility > FiberHMM & Updates > FiberHMM**: *Bundled
   (default)* or *Custom path…* (a FiberHMM source tree). It is kept in `~/.fiberhmm/app_settings.json` and takes
   effect when the app restarts;
3. else the bundled FiberHMM.

`fiberhmm_source_dir` in `~/.fiberhmm/browser_settings.json` does **not** apply to the apps: that file is for
FiberBrowser started from source or pip, and scripts.

**FiberBrowser from pip or a source checkout** (`fiberbrowser`, `python browser.py`):

1. `FIBERHMM_SOURCE_DIR`;
2. else `fiberhmm_source_dir` in `~/.fiberhmm/browser_settings.json`;
3. else the `fiberhmm` package installed in FiberBrowser's Python.

**What a build needs.** Each build declares the FiberHMM features it needs (FiberHMM 3.0 for every build; a plugin
pack adds its own in its `fiberbrowser-pack.json`, ARCHITECTURE.md). The FiberHMM chosen above is checked from its
files when FiberBrowser starts. An app whose custom FiberHMM lacks something falls back to its bundled FiberHMM and
says so in one line (in the server log, in Settings and in About), for example:

> Custom FiberHMM at /Users/me/FiberHMM lacks the provenance API; using the bundled FiberHMM 3.0.0.

A pip or source run keeps the FiberHMM it was given and says what won't work with it. Nothing runs silently without
the features it needs.

**Where to see it.** Settings > FiberHMM & Updates shows the FiberHMM in use (version, folder, why) and any notice;
About shows it too, and the server prints it at startup.

## Updating

**The apps.** *FiberBrowser > Check for Updates…* (or the button in Settings > FiberHMM & Updates, or *Check for
updates* in the command palette) shows whether a newer build of your app's channel is out, with its notes. **Download**
fetches the DMG (Mac) or the installer (Windows) to your Downloads folder and checks it against the SHA-256 in the
channel's update manifest; **Open** then mounts the DMG or starts the installer. Quit FiberBrowser and finish the
install as usual: the app never replaces itself. Your settings, sessions and Library are kept. FiberHMM updates come
inside the app, since it is bundled.

A quiet check also runs when the app starts (once, a few seconds after the window opens). It shows a one-line note
only when there is an update or the check needs you to sign in. Turn it off with **Check for updates at startup**
(Settings > FiberHMM & Updates).

**pip.** Update both packages in FiberBrowser's Python:

```bash
pip install -U fiberbrowser "fiberhmm[consensus]>=3.0.2,<4"
```

(`pip install -U fiberhmm` updates FiberHMM alone; FiberHMM's own commands also tell pip users when a newer FiberHMM
is out, `FIBERHMM_NO_UPDATE_CHECK=1` turns that off.) The update check tells a pip install that a newer FiberBrowser
is out and gives this command instead of a download.

**The check at startup: on in the apps, off in source runs.** Until you set **Check for updates at startup**, it
follows how FiberBrowser runs: **on** in the Mac app and the Windows app, **off** when FiberBrowser runs from source
or a pip install (`python browser.py`, `fiberbrowser`, scripts that start a server), so those stay quiet. *Check for
Updates…* (the button in Settings > FiberHMM & Updates, or the command palette) works in every kind of run. Once you
set the switch, your choice is kept in `~/.fiberhmm/app_settings.json` (`"updates": {"check_at_startup": …}`) and
applies to every FiberBrowser on this computer; remove that key to go back to the default.

### Privacy

A check is a plain HTTPS GET of the channel's update manifest (and, for a channel on GitHub, of GitHub's release
metadata). Nothing about this computer, its data or how FiberBrowser is used is sent. The welcome screen's
*update available* note uses the same check (and so is off by default in source runs). Turn the check at startup
off in Settings; `FIBERBROWSER_NO_UPDATE_CHECK=1`
turns every check off (the welcome note, the startup check and *Check for Updates…*). Public and lab servers never
offer these settings to their visitors.

## Channels and the update manifest

Every build has a **channel**, its flavour (`public`, or a plugin pack's). Each channel has a small JSON update
manifest, made from the built files by `tools/make_update_manifest.py`:

```json
{"schema": "fiberbrowser.update.v1", "channel": "public", "version": "3.0.1", "build": "20261005.1432",
 "released": "2026-10-05", "notes": "Short plain-text notes.", "notes_url": "https://…",
 "minimum_macos": "14.0",
 "downloads": {
   "macos-arm64": [{"kind": "dmg", "name": "FiberBrowser-3.0.1-arm64.dmg", "sha256": "…", "size": 190000000},
                   {"kind": "zip", "name": "FiberBrowser-3.0.1-arm64.zip", "sha256": "…", "size": 185000000}],
   "windows-x64": [{"kind": "installer", "name": "FiberBrowser-3.0.1-Setup.exe", "sha256": "…", "size": 330000000}]}}
```

A newer `version` is an update; on the same version a newer `build` is too (a rebuild). A Mac older than
`minimum_macos` is told so instead of getting a DMG it can't open. Files are named: the app finds them among the
release's assets, or next to the manifest; `--base-url` gives https links instead.

Where the app looks for the manifest, first match wins:

1. `FIBERBROWSER_UPDATE_URL`;
2. **Update manifest** in Settings > FiberHMM & Updates;
3. the address the build was made with (`FB_UPDATE_URL`, below);
4. the latest GitHub release of the channel's repository, the manifest being one of its assets
   (`fiberbrowser-update-<channel>.json`). The public channel reads
   [fiberseq/FiberBrowser](https://github.com/fiberseq/FiberBrowser) releases without signing in.

Steps 1-3 take an `https://` address, a `file://` address or a plain path, so a manifest can sit on a shared drive
or in a Dropbox-synced folder next to the files it lists.

### Signing in to GitHub (private channels)

A channel whose releases are private needs a GitHub account that can read its repository. FiberBrowser tries, in this
order, moving on when GitHub refuses one:

1. **The GitHub CLI**: if `gh` is installed and signed in (`gh auth login`), its token is used. Nothing to set up.
2. **A personal access token**: create a fine-grained token with read-only access to that repository (*Repository
   permissions > Contents: Read-only*) and paste it once in Settings > FiberHMM & Updates > **GitHub token**. It is
   kept in the OS keychain (the macOS Keychain; the Windows Credential Manager for the Windows app; a `keyring`
   backend elsewhere), never in a settings file, a log or a session.
3. **GitHub sign-in (OAuth device flow)**: not built in. It needs the organisation to register an OAuth App (with
   device flow enabled) and give its client ID, which then goes in `FIBERBROWSER_GITHUB_OAUTH_CLIENT_ID` or the
   build's `github_oauth_client_id` (`services/github_auth.py` `device_flow_client_id` is the hook). Never use another
   project's client ID.

Settings says when no account is signed in or the token is refused (*Sign in to check for … updates*); the check
never fails silently. The token is sent only to `api.github.com`: release downloads redirect to GitHub's storage, and
FiberBrowser follows those redirects itself without the token.

## Publishing an update (maintainers)

1. Build: `bash packaging/macos/build_app.sh` (the DMG) and the Windows app (`packaging/windows/build_wsl_distro.sh`,
   then `build_installer.sh`). Each build writes its channel, version and build number into the app
   (`Contents/Resources/fiberbrowser-build.json`; `/opt/fiberbrowser/share/fiberbrowser/build.json` in the WSL
   distribution, `packaging/write_build_info.py`). Their presence is what makes the app use its bundled FiberHMM
   by default; `check_app.sh` and `check_distro.sh` check it. Optional: `FB_BUILD_NUMBER` (default: the source
   commit's UTC time, so the Mac and Windows builds of one commit share it; one manifest serves both),
   `FB_UPDATE_URL` (a manifest address baked into the build), `FB_UPDATE_REPO` (another GitHub repository).
2. The manifest:

   ```bash
   python3 tools/make_update_manifest.py --channel public \
       --build-info build/macos/dist/FiberBrowser.app/Contents/Resources/fiberbrowser-build.json \
       --build-info build/windows/context/build.json \
       --notes-file notes.txt --notes-url https://github.com/fiberseq/FiberBrowser/releases/tag/v3.0.1 \
       --out fiberbrowser-update-public.json \
       build/macos/dist/FiberBrowser-3.0.1-arm64.dmg build/windows/FiberBrowser-3.0.1-Setup.exe
   ```

3. Publish the files and the manifest together. On GitHub (push the tag `v3.0.1` first):

   ```bash
   python3 tools/publish_release.py --channel public --tag v3.0.1 \
       --manifest fiberbrowser-update-public.json --notes-file notes.md \
       build/macos/dist/FiberBrowser-3.0.1-arm64.dmg build/windows/FiberBrowser-3.0.1-Setup.exe --dry-run
   ```

   `--dry-run` prints the exact `gh release create` it would run and runs nothing; drop it to publish (it asks
   before uploading). It refuses a manifest whose files, checksums, channel or version don't match. On a shared
   folder instead: copy the files and the manifest there and point `FIBERBROWSER_UPDATE_URL` or the setting (or
   `FB_UPDATE_URL` at build time) at the manifest.

## Bundled analysis requirements

Every release uses the public update channel and includes the full analysis pack.
Its FiberHMM requirements are declared in `browser/lab/fiberbrowser-pack.json`:
the NFR engine (`fiberhmm.inference.accessibility`, schema
`fiberhmm.accessibility.preview.v1` or newer) and the provenance API
(`fiberhmm.io.provenance`). A packaged app uses its bundled FiberHMM by default.
