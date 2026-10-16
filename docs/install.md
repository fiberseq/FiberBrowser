# Installing FiberBrowser

[← Documentation](index.md)

| You want | Use |
|----------|-----|
| The browser on a Mac, no Python needed | [The Mac app](#the-mac-app) |
| The browser on a Windows PC, no Python needed | [The Windows app (WSL)](#windows) |
| The `fiberbrowser` command (Mac, Linux, or inside WSL on Windows), Jupyter, the Copilot | [pip or pipx](#pip-or-pipx) |
| A browser for reviewers on a server | [Docker](#docker) |
| To work on FiberBrowser itself | [A source checkout](#a-source-checkout) |

However you install it, FiberBrowser runs a small web server on your computer
and shows it in a window or browser tab. Every launch has a random access token
(like Jupyter): the launchers open the tokened link for you, and other users
of the machine or network can't use your browser without it. See
[Access token and workspaces](reference.md#access-token-and-workspaces).

## The Mac app

For Apple silicon Macs (M1 or newer) with macOS 14 (Sonoma) or newer.

1. Download `FiberBrowser-<version>-arm64.dmg` from
   [GitHub Releases](https://github.com/fiberseq/FiberBrowser/releases).
2. Open it and drag **FiberBrowser** onto **Applications**.
3. Start it from Launchpad, Spotlight or the Applications folder.

The app opens FiberBrowser in its own window. It starts its server on a free
port (8756 when available, so your display preferences are kept between
launches), with the access token on and its entry in
`~/.fiberhmm/browser_runtime.json` as usual, so `browser_client` in a notebook
finds it. The **File** menu has **New Window** (another window on the same
workspace), **New Independent Workspace**, **Open in Browser** (the same
session in your default web browser) and **Quit**. The guided tour opens in a
window of its own. Quitting (or closing the last window) stops the server.

It is self-contained: it bundles Python, FiberHMM 3 (footprint classes,
chemistry detection, BAM export), minimap2 (MIT licence, for new DAF-seq
runs) and NCBI BLAST+ 2.17.0 (`blastn` and `makeblastdb`, for primer checks;
NCBI's code is public domain, the libraries NCBI's binaries include keep
their own licences).
It also bundles the D. melanogaster canonical TE sequence set v10.2
(CC0; Identify uses it, and BLAST+, to find candidates for insertions without a download).
FiberHMM's commands are inside it, for example
`/Applications/FiberBrowser.app/Contents/Resources/bin/fiberhmm-call --help`;
the bundled programs are in `Contents/Helpers` and their licences in
`Contents/Resources/licenses`. A BLAST+ you prefer is still used if you set
its path in `~/.fiberhmm/browser_settings.json` (`"tools": {"blastn":
"/path/to/blastn"}` or `"blast_dir": "/path/to/ncbi-blast/bin"`).
FiberBrowser runs BLAST+ with NCBI's usage reporting off
(`BLAST_USAGE_REPORT=false`) unless you set that variable yourself.
UCSC `bedToBigBed` is not bundled (UCSC's tools are free for academic,
non-profit and personal use only, so they aren't redistributed here):
`fiberhmm-extract` then keeps its BED output and skips the bigBed conversion.
Programs you install with Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`),
such as `bedToBigBed`, are found by the app too.

It also includes the primer-design packages (primer3-py, seqfold), contact
maps (.cool / .mcool, also from s3://) and UMAP. Not in the app: the local
Copilot (its MLX runtime is large; install FiberBrowser with pip for it).

Server output goes to `~/.fiberhmm/logs/fiberbrowser-app-server.log`; caches
to `~/Library/Caches/FiberBrowser` and `~/Library/Caches/numba`.

**"FiberBrowser can't be opened" / "Apple could not verify…"**: release DMGs
are signed with a Developer ID and notarized by Apple, so this should not
appear. A build that isn't (a local or pre-release build) is blocked by
Gatekeeper the first time: open **System Settings > Privacy & Security** and
click **Open Anyway** next to the FiberBrowser message (or run
`xattr -dr com.apple.quarantine /Applications/FiberBrowser.app`).

## Windows

For 64-bit Windows 10 (version 2004, build 19041, or newer) and Windows 11 on
Intel or AMD processors. FiberBrowser runs there in **WSL 2** (Windows
Subsystem for Linux), in a Linux system of its own named *FiberBrowser*. Setup
installs everything; you don't need to know Linux, and your other WSL
distributions and settings are not changed. (The pip package can't run on
Windows itself: pysam, which reads BAM files, has no Windows build.)

1. Download `FiberBrowser-<version>-Setup.exe` from
   [GitHub Releases](https://github.com/fiberseq/FiberBrowser/releases).
2. Run it. The installer is not code-signed yet, so Windows SmartScreen shows
   *"Windows protected your PC"*: click **More info**, then **Run anyway**
   (your browser may also ask whether to keep the download: **Keep**).
3. Setup checks for WSL 2. If it is missing or too old, Setup explains and
   offers to install it (`wsl --install --no-distribution`): Windows asks for
   administrator approval and usually needs a restart; Setup starts again by
   itself after you sign in, to finish. Nothing else needs administrator
   rights: FiberBrowser is installed for you only, in
   `%LOCALAPPDATA%\FiberBrowser`.
4. Setup imports FiberBrowser's Linux system (about 1 GB on disk) and adds
   **FiberBrowser** to the Start menu and the desktop.

Start FiberBrowser from the Start menu or the desktop: it shows *Starting
FiberBrowser...* and then opens in its own window (a Microsoft Edge app
window, or Chrome's; without either, a tab of your web browser). As with the
Mac app, the launcher starts the server on a free port (8756 when available,
so display preferences are kept), with this launch's access token, and stops
it when you close the last FiberBrowser window. Starting FiberBrowser again
while it runs opens another window. Pin it to the taskbar from the Start menu
(not from its running window, which belongs to Edge).

**Files.** *Open*, *Add dataset* and *Open session* use the Windows open
dialog; Windows paths pasted anywhere FiberBrowser takes a path
(`C:\data\run1.bam`, `\\wsl.localhost\FiberBrowser\home\fiberbrowser\data\run1.bam`)
work as they are, and the Library's *Reveal in Explorer* opens File Explorer.
WSL reads Windows drives (C:, D:) through a bridge that is much slower than
its own disk, so FiberBrowser notes it when you open a large file from one:
for large BAMs, use FiberBrowser's own folder, which File Explorer shows under
**Linux > FiberBrowser > home > fiberbrowser > data**
(`\\wsl.localhost\FiberBrowser\home\fiberbrowser\data`). Network drives mapped in
Windows (Z:) are not visible to WSL unless mounted inside it (see the message
FiberBrowser shows); files of your other WSL distributions are not visible to
FiberBrowser's either: copy them to a Windows folder or FiberBrowser's own.

**What's inside**: the same as the Mac app (Python, FiberHMM 3, minimap2,
BLAST+ `blastn`/`makeblastdb` (Debian bookworm's `ncbi-blast+` 2.12.0, in
`/usr/bin`), primer design, contact maps,
UMAP; no Copilot; licences in `/usr/local/share/licenses` and, for the Debian
packages, `/usr/share/doc/<package>/copyright`). FiberHMM's commands run in a
FiberBrowser shell: open *Terminal* or *Command Prompt* and run
`wsl -d FiberBrowser`, then e.g. `fiberhmm-call --help`.

**Where things are**: `%LOCALAPPDATA%\FiberBrowser` holds the app (`app`), the
Linux system's disk (`distro`), the window's browser profile and the logs
(`logs\launcher.log`, `logs\server.log`, `logs\setup.log`). Your FiberBrowser
settings, sessions, Library and downloaded genomes are in the Linux home
(`~/.fiberhmm`, like on a Mac).

**Updating**: run the new version's Setup. It replaces the Linux system and
keeps your FiberBrowser data (backed up and restored).

**Uninstalling**: *Settings > Apps > Installed apps > FiberBrowser >
Uninstall*. It removes the WSL distribution, the shortcuts and the app, and
asks whether to delete your FiberBrowser data as well; by default it is kept
(`%LOCALAPPDATA%\FiberBrowser\UserData\home.tar`, a copy of the Linux home that
installing FiberBrowser again restores).

**If Setup.exe is blocked** (some organisations don't allow unsigned
installers), use `FiberBrowser-<version>-windows-portable.zip`: unzip it and
double-click `Install.cmd`, which does the same as Setup (and uninstalls from
*Apps* likewise).

**Troubleshooting**

- *"Virtualization is turned off"* / error `0x80370102`: WSL 2 needs hardware
  virtualization (Intel VT-x, AMD-V/SVM): turn it on in the PC's firmware
  (BIOS/UEFI) settings.
- WSL can't be installed (managed PCs): ask your IT department for WSL 2;
  some organisations also block PowerShell scripts, which Setup and the
  launcher use.
- FiberBrowser doesn't start: the message shows the end of the server log;
  the logs are in `%LOCALAPPDATA%\FiberBrowser\logs`.
  `wsl -d FiberBrowser -- fiberbrowser-check-distro` tests the installation.
- Windows on ARM (Snapdragon PCs) is not supported yet: the Linux system is
  built for x86-64.

## pip or pipx

Needs Python 3.10 or newer (macOS's built-in `/usr/bin/python3` is 3.9: use
python.org's installer, Homebrew or Miniforge). On Windows it runs inside a
WSL distribution (for example Ubuntu, `wsl --install`), not in Windows itself:
pysam has no Windows build. The [Windows app](#windows) sets that up for you.

```bash
pipx install "fiberbrowser[app]"          # its own environment, the command on PATH
# or, in a virtual environment of your own:
python3 -m pip install "fiberbrowser[app]"

fiberbrowser                              # opens the access link in your browser
fiberbrowser --app                        # the same in its own window (the [app] extra)
fiberbrowser -b sample.bam -g genes.gtf -f genome.fa
fiberbrowser --help                       # every option (the same as python browser.py)
```

This installs FiberHMM 3 (`fiberhmm[consensus]>=3.0,<4`) from PyPI with it.
FiberHMM runs footprint classes, chemistry detection, consensus BAM export,
DAF-seq runs and re-run advisories; browsing works without it. At startup the
server prints the FiberHMM version and location it uses and warns when it is
older than 3.0.

Extras (`pip install "fiberbrowser[app,copilot]"`, or `[all]`):

| Extra | Adds |
|-------|------|
| `app` | the app window (`fiberbrowser --app`, `fiberbrowser-app`; pywebview) |
| `copilot` | the local Copilot runtime (MLX; Apple silicon, macOS 13.5+, native arm64 Python) |
| `primers` | the Primer design panel (primer3-py, seqfold); BLAST+ checks also need `blastn`/`makeblastdb` (`conda install -c bioconda blast`; bundled in the Mac app and the Windows distribution) |
| `contact-maps` | .cool / .mcool contact matrices (cooler, h5py), local or s3:// |
| `umap` | UMAP in the cluster Projection tab |
| `plots` | server-side diagnostic plots, the standalone primer CLI |
| `pipeline` | mappy, the minimap2 Python module, for new DAF-seq runs when the `minimap2` program isn't installed |

**New DAF-seq runs** (FASTQ → aligned, called BAM) run FiberHMM's
`fiberhmm-pipeline`, which aligns with minimap2: install the program
(`conda install -c bioconda minimap2`, `brew install minimap2`, or your
Linux distribution's package) or the `pipeline` extra. The `fiberbrowser`
command puts its own environment's scripts folder on the server's PATH, so
FiberHMM's commands are found even when that folder isn't on yours.

The wheel includes the NAPA demo dataset that the guided tour uses and the
UCSC/ENCODE track catalogs (about 13 MB in all), so nothing is downloaded on
first use. Reference genomes you choose in the browser are downloaded to
`~/.fiberhmm/genomes`.

`import browser_client` (the Jupyter client) works after a pip install; it is
also `fiberbrowser.browser_client`. See [Jupyter / Python API](jupyter-api.md).

**External programs (BLAST+, minimap2, samtools).** Primer design runs
`blastn`/`makeblastdb`.
The insertion lens's Identify runs them too, and falls back to `minimap2`.
The Mac app started from the Finder doesn't see your shell's
PATH, so FiberBrowser looks for each program in this order and uses the first
one that runs (it checks `-version`): a path you set in
`~/.fiberhmm/browser_settings.json` (`"tools": {"blastn": "/path/to/blastn"}`,
or `"blast_dir": "/path/to/ncbi-blast/bin"`), the app's own copy, PATH, then
`/opt/homebrew/bin`, `/usr/local/bin`, the active conda environment,
`~/miniconda3`, `~/miniforge3`, `~/mambaforge`, `~/anaconda3` and
`~/.local/bin`. The Primer panel shows which BLAST+ (version and path) is in
use. The Mac app and the Windows distribution bundle BLAST+ and
minimap2; with a pip install, get BLAST+ with `brew install blast` or
`conda install -c bioconda blast`.

**conda.** FiberBrowser and FiberHMM aren't conda packages yet. In a conda
environment, install Python and the compiled packages from conda-forge /
bioconda, then FiberBrowser with pip:

```bash
conda create -n fiberbrowser -c conda-forge -c bioconda python=3.12 pysam pybigwig minimap2
conda activate fiberbrowser
python -m pip install "fiberbrowser[app]"
```

(pyBigWig built by pip inside a conda environment can end up linked against
conda's libcurl and fail to load elsewhere; `fiberbrowser --copilot-doctor`
spots it and prints the fix.)

**Install as an app from Chrome or Edge.** With FiberBrowser running, open its
link in Chrome or Edge and choose **Install FiberBrowser** (the install icon
in the address bar, or *Install page as app* / *Install this site as an app*
in the browser's menu). It then has its own window, Dock/taskbar icon and app-menu entry.
The installed app opens `http://localhost:8000/` with the cookie the access
link set, so:

- start FiberBrowser as usual first (it opens its link, which also refreshes the
  installed app's access), then open the installed app;
- keep the port the same (8000 by default): the app belongs to one address;
- if the window says it needs its access link, start FiberBrowser and reload,
  or paste the link from the terminal into the box on that page.

**Menu shortcut (Linux).** `fiberbrowser --install-shortcut` adds
FiberBrowser to the application menu (a `.desktop` entry in
`~/.local/share/applications`). It opens the app window (install the `app`
extra; without it, the browser tab). `fiberbrowser --uninstall-shortcut`
removes it. (On Windows, the [Windows app](#windows) adds its own Start-menu
entry.)

## Docker

The public/reviewer server image is published to the GitHub Container Registry
on every release:

```bash
docker pull ghcr.io/fiberseq/fiberbrowser:3.0.0
```

It runs `--public` (read-only catalog, per-visitor sessions, rate limits). How
to run it on a VM behind HTTPS: [A public FiberBrowser server](deployment/public-server.md).

## A source checkout

```bash
git clone https://github.com/fiberseq/FiberBrowser && cd FiberBrowser
bash scripts/install.sh          # or: python3 -m pip install -r requirements.txt
python browser.py                # same options as the fiberbrowser command
```

The double-click launchers (`Launch Browser.command`, `.sh`) start it
without a terminal (`Launch Browser.bat` needs a Windows Python with FiberBrowser's
packages, which pysam doesn't allow: on Windows, use the Windows app or a checkout
inside WSL). `python -m pip install .` installs the checkout as the
`fiberbrowser` package. To use a FiberHMM source checkout instead of the
installed package, set `FIBERHMM_SOURCE_DIR=/path/to/FiberHMM`.

Optional packages, as in the pip extras: `primer3-py seqfold` (primer design;
without them the hairpin, dimer and Tm filters fall back to length and GC
rules), `cooler h5py` (contact maps), `umap-learn`, and BLAST+
(`conda install -c bioconda blast`) for primer specificity checks.

Development:

```bash
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m pytest -m "not integration"            # backend tests
npm --prefix browser/frontend install
npm --prefix browser/frontend run test:run       # frontend unit tests
npm --prefix browser/frontend run build          # the production bundle the server serves
```

## Maintainers

- **Wheel and sdist**: `python -m build` (hatchling; `pyproject.toml`). The
  wheel mirrors the repository under `fiberbrowser/` (see
  `fiberbrowser/_paths.py`) and serves the committed `browser/frontend/dist`,
  so rebuild the frontend before a release. `tests/test_packaging.py` keeps
  the dependencies in step with `requirements.txt` and every backend folder in
  the wheel.
- **Mac app**: `bash packaging/macos/build_app.sh`, then
  `bash packaging/macos/check_app.sh`. Signing, notarization and the CI
  secrets: [packaging/macos/SIGNING.md](../packaging/macos/SIGNING.md).
- **Windows app** (builds on macOS or Linux with Docker and NSIS):
  `bash packaging/windows/build_wsl_distro.sh` (the WSL root filesystem;
  `FB_FIBERHMM` = a FiberHMM checkout or wheel to use instead of PyPI's), then
  `bash packaging/windows/check_distro.sh` (smoke test in Docker),
  `bash packaging/windows/build_installer.sh` (`FiberBrowser-<version>-Setup.exe`
  and the portable zip) and `bash packaging/windows/test_windows_scripts.sh`
  (lint + unit tests of the PowerShell launcher/setup). See
  [packaging/README.md](../packaging/README.md#the-windows-app).
- **Updates**: each build records its channel and version; publish a build's update
  manifest with the files (`tools/make_update_manifest.py`, `tools/publish_release.py
  --dry-run` first). See [Updates](updates.md#publishing-an-update-maintainers).
- **Icons**: edit the SVGs in `packaging/icons/`, then
  `python packaging/icons/build_icons.py`.
- **Releasing** (tag `v<version>` = `browser/version.py`): the wheel, the image
  and the app install FiberHMM 3.x from PyPI (`fiberhmm[consensus]>=3.0,<4`);
  the repository variable `FIBERHMM_REQUIREMENT` overrides it for the Mac and
  Python workflows, e.g. a git URL to test an unreleased FiberHMM. Pushing the
  tag runs:
  - `release-python.yml`: builds and tests the wheel, publishes it to PyPI and
    attaches it to the release;
  - `release-macos.yml`: builds, signs, notarizes and attaches the DMG;
  - `release-docker.yml`: pushes `ghcr.io/<owner>/fiberbrowser:<version>` and
    `:latest`. After the first push, make the package public (GitHub > the
    repository's *Packages* > fiberbrowser > *Package settings* > *Change
    visibility*).
- **PyPI trusted publishing** (once, no token): on pypi.org, *Your account >
  Publishing > Add a new pending publisher*: PyPI project `fiberbrowser`, owner
  `fiberseq`, repository `FiberBrowser`, workflow `release-python.yml`,
  environment `pypi`. In the GitHub repository, create the environment `pypi`
  (*Settings > Environments*; add required reviewers to approve each upload
  if you like).
