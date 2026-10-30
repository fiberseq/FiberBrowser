# Packaging

How FiberBrowser is distributed; users start at [docs/install.md](../docs/install.md).

| Path | What |
|------|------|
| `../pyproject.toml`, `../fiberbrowser/` | The pip package and the `fiberbrowser` command (`fiberbrowser/cli.py`), the app window (`desktop.py`), menu shortcuts (`shortcut.py`) and the Mac app's entry (`frozen_entry.py`). |
| `python/browser_client_shim.py` | Installed as the top-level `browser_client` module (an alias of `fiberbrowser.browser_client`). |
| `icons/` | SVG sources of the FiberBrowser and FiberHMM icons and `build_icons.py`, which renders every PNG, `.ico` and `.icns` (committed outputs: `fiberbrowser/icons/`, `browser/frontend/public/assets/icons/`, `macos/*.icns`, `icons/png/`). |
| `third_party.sh`, `third_party/` | Pinned BLAST+ macOS release (sha256) that the builds bundle (the WSL distribution takes BLAST+ from Debian's `ncbi-blast+` package), the fetch helper, and the third-party notices copied into the app and the WSL distribution (`third_party/blast/`: what NCBI's macOS binaries include, with the licence texts). |
| `macos/` | FiberBrowser.app: `build_app.sh` (venv, PyInstaller, minimap2, BLAST+, signing, notarization, DMG), `FiberBrowser.spec`, `entitlements.plist`, `check_app.sh` (smoke test, entitlement check), [SIGNING.md](macos/SIGNING.md). |
| `windows/` | The Windows app (WSL 2): `build_wsl_distro.sh` + `Dockerfile` + `rootfs/` (the distribution's root filesystem), `check_distro.sh` (smoke test), `app/` (the launcher `FiberBrowser.ps1`, setup `FiberBrowserSetup.ps1`, shared helpers), `launcher.nsi` (`FiberBrowser.exe`), `installer.nsi` (`Setup.exe`), `portable/` (`Install.cmd`), `build_installer.sh`, `test_windows_scripts.sh` + `tests/` (PSScriptAnalyzer, Pester). |
| `../.github/workflows/release-*.yml` | On `v*` tags: the DMG, PyPI (trusted publishing) and the GHCR image. |
| `../deploy/` | The Docker image for public/reviewer servers. |

## Release build

The Mac app and WSL distribution build the same complete source tree, including
NFRs and Synchronise regions. The build and update channel are `public`.
`FB_FLAVOR=lab` is accepted by older build wrappers as an alias; it produces the
same public artifact. No feature-stripped tree is generated.

Every build bundles the D. melanogaster TE library, BLAST+ and minimap2. The
packaging smoke checks require those tools and the NFR and Synchronise modules.

Both builds write provenance with `packaging/write_build_info.py`: version, build
number (`FB_BUILD_NUMBER`, defaulting to the source commit's UTC time), source
commit, platform and bundled FiberHMM version. The Mac file is
`Contents/Resources/fiberbrowser-build.json`; the WSL file is
`/opt/fiberbrowser/share/fiberbrowser/build.json`. Packaged apps run their bundled
FiberHMM by default. `FB_UPDATE_URL` and `FB_UPDATE_REPO` can select the update
source. See [docs/updates.md](../docs/updates.md).

## The wheel

The backend imports its folders (`services`, `routers`, `state`, ...) as
top-level modules from `browser/` on `sys.path`, and finds data relative to
its files. So the wheel mirrors the repository root inside the package
instead of turning the backend into a package:

```
site-packages/
  fiberbrowser/            __init__, cli, desktop, shortcut, frozen_entry, icons/
    browser.py             what `fiberbrowser` runs (runpy), as `python browser.py` would
    browser_client.py
    browser/               backend, frontend/dist, data/ (demo, track catalogs, figure defaults)
    data/copilot_dataset/models.json
    plugins/
  browser_client.py        alias module
```

Nothing else lands at the top level of site-packages. When a new backend
folder or top-level module is added under `browser/`, add it to
`[tool.hatch.build.targets.wheel.force-include]`; `tests/test_packaging.py`
fails until then.

## The Mac app

One PyInstaller binary with several roles (`fiberbrowser/frozen_entry.py`):
the app window by default; `--serve` for the server it starts as a child;
`-m`, `-c` and `script.py` like a Python interpreter (FiberHMM's pipeline runs
`sys.executable -m fiberhmm.cli.call`, joblib's workers `-m ...popen_loky_posix`);
`--entry-point NAME` for the `fiberhmm-*` commands in
`Contents/Resources/bin`. `Contents/Helpers` holds minimap2, `blastn` and
`makeblastdb` (NCBI's release binaries, signed with the rest) and
`Contents/Resources/licenses` the third-party notices. Both program folders are
put on the server's PATH. The backend and FiberHMM ship as files (not only in
the archive) because the backend runs from its folder and numba reads
FiberHMM's sources to cache compiled kernels (in `~/Library/Caches`, never in
the signed bundle).

Why PyInstaller and not Briefcase: Briefcase installs binary wheels only
(`--only-binary`), and pyBigWig has no macOS arm64 wheel, so `briefcase
create` fails to resolve the requirements; PyInstaller bundles what the build
venv has (pyBigWig built from source against the system libcurl), and its
hooks cover numba, llvmlite, scikit-learn, uvicorn and pywebview.

Size (3.0.0, arm64): the app is about 480 MB (llvmlite ~120 MB, BLAST+ ~47 MB, SciPy,
pandas, scikit-learn, botocore, JASPAR 2024 + 2026 databases, the frontend and
demo), the DMG about 190 MB. A python.org / setup-python build Python is
smaller than a conda one (conda's sqlite pulls in ICU, ~38 MB).

Future FiberHMM runner app in the same DMG, sharing this runtime: see the end
of [macos/SIGNING.md](macos/SIGNING.md).

## The Windows app

pysam has no Windows build, so FiberBrowser can't run on Windows itself; the
Windows app is a WSL 2 distribution of its own plus a launcher:

- **The distribution** (`windows/build_wsl_distro.sh`): a linux/amd64 root
  filesystem made with Docker from `python:3.12-slim-bookworm`: a venv in
  `/opt/fiberbrowser` with the FiberBrowser and FiberHMM wheels and the Mac
  app's extras (primers, contact-maps, s3, umap), minimap2 2.31 built from
  source, the user `fiberbrowser` (default in `/etc/wsl.conf`, Windows interop
  on), `~/data` for large files, and `fiberbrowser-wsl-serve`, the server
  entry the launcher runs. Exported with `docker export` (gzip, about 320 MB;
  about 1 GB imported) for `wsl --import FiberBrowser <dir> <tarball>`, so it
  never touches the user's own distributions. `check_distro.sh` imports the
  tarball into Docker and runs `check_app.sh`'s checks plus the server as the
  launcher starts it; on Windows, `wsl -d FiberBrowser -- fiberbrowser-check-distro`.
- **Setup** (`windows/installer.nsi`, NSIS; `build_installer.sh` compiles it
  with makensis on macOS/Linux): per user in `%LOCALAPPDATA%\FiberBrowser`, no
  administrator rights unless WSL itself must be installed (`wsl --install
  --no-distribution`, elevated, then a RunOnce entry restarts Setup after the
  reboot). The work is in `app/FiberBrowserSetup.ps1` (check, import with
  a `.tar` fallback for older WSL, backup/restore of the Linux home across
  updates and uninstalls), shared with the portable zip's `Install.cmd`.
- **The launcher** (`app/FiberBrowser.ps1`, run hidden by `FiberBrowser.exe`,
  a 32-bit NSIS stub that runs the 64-bit PowerShell through `Sysnative`): one
  instance (a named mutex; a second launch opens another window on the running
  server), a free port (8756 first) and a new token, `wsl.exe -d FiberBrowser
  -u fiberbrowser -e fiberbrowser-wsl-serve ...`, a *Starting...* window until
  `/api/status` answers, then an Edge (or Chrome) `--app` window in a
  dedicated profile; the server stops (`/api/quit`) when that profile's
  browser process ends, and the windows close when the server stops.
- **In the server** (`browser/services/wsl_interop.py`): the Windows open
  dialogs (PowerShell WinForms, with the Supported-files filters), Windows
  paths translated everywhere, *Reveal in Explorer*, a Windows console for the
  cluster sign-in, and the note for large files on `/mnt/c`.

Nothing is code-signed: SmartScreen warns about Setup until it is signed with
an (OV/EV) Windows code-signing certificate (`osslsigncode` can sign from
macOS/Linux: sign `FiberBrowser.exe` before `installer.nsi` packs it, then the
Setup and the uninstaller).

## In-app update releases

Packaged apps offer **Install and restart** when the manifest contains a supported
payload. Source and pip runs continue to show the pip upgrade command. Download
and open remain available for manual installation.

1. Build macOS and Windows from the same source/version/build number. The Mac
   build now writes `FiberBrowser-<version>-arm64.zip` from the final signed and
   stapled app, alongside its DMG. Never zip the pre-notarization bundle. The
   updater extracts with `ditto` so framework links and bundle metadata survive.
2. Sign the Windows NSIS Setup executable with the release Authenticode
   certificate after building it. Unsigned or invalid signatures cannot use the
   in-app installer. The existing Windows build does not sign automatically.
   NSIS `/S` upgrades preserve data and abort on setup errors without prompts,
   including insufficient backup space; the updater never passes `-RemoveData`.
   Before building the WSL distribution, set `FB_WINDOWS_PUBLISHER_SUBJECT` to
   FiberBrowser's own release certificate's exact Subject and
   `FB_WINDOWS_PUBLISHER_THUMBPRINT` to its 40-hex SHA-1 certificate thumbprint.
   `windows/write_update_trust.py`, called by `build_wsl_distro.sh`, writes both
   as build-time constants under `windows_update_signer` in the installed
   `build.json`. Both must match the Authenticode signer at staging, handoff,
   and in the detached helper. The manifest cannot override this identity.
   Unset constants disable automatic Windows installation; partial or malformed
   configuration fails the build. For certificate rotation, first ship a release
   trusted by the installed certificate that embeds the next release's identity.
3. Generate `fiberbrowser.update.v1` with `tools/make_update_manifest.py`, giving
   both platform build-info files and the final DMG, zip and signed Setup.
   A DMG argument also discovers its already-built sibling zip automatically;
   explicitly listing both works too. The tool records each artifact's size and
   sha256. Publish all listed files together with the manifest, then publish the
   release only after the checks below.

For example, from the repository root (replace the version/build artifacts):

```sh
python3 tools/make_update_manifest.py --channel public --version 3.0.2 \
  --build-info build/macos/dist/FiberBrowser.app/Contents/Resources/fiberbrowser-build.json \
  --build-info build/windows/context/build.json \
  --out build/fiberbrowser-update-public.json \
  build/macos/dist/FiberBrowser-3.0.2-arm64.dmg \
  build/macos/dist/FiberBrowser-3.0.2-arm64.zip \
  build/windows/FiberBrowser-3.0.2-Setup.exe
```

The Mac updater checks sha256, stages beside the running bundle, runs
`codesign --verify --deep --strict`, compares the staged Team ID with the running
app's `codesign -dv` result, and requires `spctl --assess --type execute` to pass.
There is no hard-coded team exception. Unwritable bundle folders, unsafe zip
contents, checksum failures and verification failures keep the app running and
fetch/open the DMG with an explanation. A failed DMG download/open is shown too.

At Ready, the page awaits a durable autosave, records a one-time reopen request,
starts the verified helper and uses the existing normal Quit route. A save
failure blocks restart and offers retry; cancellation works through Ready.
The Mac helper waits for both server and desktop pids, rechecks the signature,
Team ID and Gatekeeper after they exit, moves the old bundle into a unique folder
in `~/.Trash`, replaces it, clears quarantine, then uses `open` to relaunch.
A failed replacement moves the old app back. The helper keeps `install.log` in
its staging folder and shows an alert on failure. Staging folders/logs remain
for diagnosis; cancelled or rejected staging is removed.

On Windows the installer and helper live on a Windows drive, outside the WSL
filesystem being replaced. PowerShell validates Authenticode before Ready and
again at handoff. The detached Windows helper waits for the Windows launcher
pid from `run/server.json`, rechecks sha256 and Authenticode, runs NSIS `/S`,
checks its exit code, then launches `app/FiberBrowser.exe`. Failures show an
alert and write `<installer>.install.log` beside the download; installer details
are in the installation's `logs/setup.log`. Signature failure offers Download
with the reason and does not automatically run the rejected executable.

### Phase G: manual signed update test (deferred)

Use disposable signed installations and test data, with separate OS test
accounts/profiles. These tests have not been run by the implementation's unit
checks. Do not use an active research session or the development profile.

1. Publish a test manifest pointing to a newer signed, notarized and stapled Mac
   zip plus DMG, and an Authenticode-signed Windows Setup. Verify versions,
   architecture, build numbers, sizes and hashes match the final files. Point
   the older packaged apps at that manifest through Settings > Updates.
2. On macOS, install the older app in a writable folder, open representative
   datasets, change the locus and analysis, and click **Install and restart**
   once. Observe Downloading, Verifying, Ready and Restarting. Confirm both app
   processes exit before any move, the new version launches from the same path,
   and the datasets/locus/analysis reopen even with the normal launch preference
   set to Ask or Fresh. Confirm that preference still applies on the next
   ordinary launch. Check the old bundle in Trash and the staging log.
3. Repeat with cancellation during download, verification and session saving.
   Confirm no helper installs or restarts, the old app stays usable, and staging
   is removed. Simulate unavailable/full browser storage: restart must be
   blocked with a save error, then succeed after retry when storage works.
4. Test a non-writable app folder, an invalid zip, a changed sha256, a damaged
   signature, a valid signature from a different team, and a Gatekeeper-rejected
   bundle (including offline assessment). Each must retain the original app and
   explain the failed gate while downloading/opening the verified DMG. Confirm
   rejected payloads have no quarantine removed. Make replacement fail after
   the Trash move; confirm rollback and the diagnostic alert/log.
5. On Windows 10/11 with WSL 2, update an older per-user installation. Confirm
   the helper survives the old launcher and WSL distribution exiting, NSIS runs
   silently, existing data and browser profile survive, the new launcher starts
   only after a zero installer exit, and the session reopens. Include a Windows
   account/install path with spaces and non-ASCII characters. Confirm a launcher
   that never exits times out with a log/alert and no replacement.
6. Repeat Windows with a modified hash, unsigned/invalid/revoked installer,
   a valid signature from an unrelated publisher, unset trusted build identity,
   missing launcher state, and insufficient backup space. Confirm signature/hash
   failures never execute Setup, setup failures never launch the new app, and
   no silent path offers or performs deletion of user data. Check both logs.
7. In source and pip runs, confirm there is no installation action and the pip
   command remains visible. Check manual Download/Open in both packaged apps.
   Record OS/build identifiers, logs, restore results and all failure cases for
   Phase G sign-off before enabling a public rollout.
