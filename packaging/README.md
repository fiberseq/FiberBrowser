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
