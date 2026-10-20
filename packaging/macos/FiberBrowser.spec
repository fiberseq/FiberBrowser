# PyInstaller spec for FiberBrowser.app. Run through build_app.sh, which
# prepares the build venv (fiberbrowser, FiberHMM, pywebview installed) and
# signs, notarizes and packages the result.
#
# Layout of what this collects:
# - fiberbrowser/ (the installed package: backend, frontend build, demo,
#   catalogs, icons) as plain files, because the backend runs from its folder
#   (browser.py puts fiberbrowser/browser on sys.path) and finds its data next
#   to its modules. Its top-level modules (services, routers, ...) are analysed
#   only to collect what they import, then left out of the archive.
# - FiberHMM with its sources beside the compiled modules (numba reads them to
#   cache its compiled kernels, in ~/Library/Caches/FiberBrowser/numba).
# - dist-info metadata of FiberHMM and FiberBrowser (console-script lookup,
#   version reporting).
# pyinstaller-hooks-contrib covers numba, llvmlite, sklearn, uvicorn, botocore,
# orjson and pywebview; pysam and pyjaspar are collected here.
import importlib.util
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules, copy_metadata

import fiberbrowser

SPEC_DIR = Path(SPECPATH).resolve()  # noqa: F821 (PyInstaller global)
PKG = Path(fiberbrowser.__file__).resolve().parent
BACKEND = PKG / "browser"
VERSION = fiberbrowser.__version__
MIN_MACOS = os.environ.get("FB_MIN_MACOS", "14.0")
BUNDLE_ID = os.environ.get("FB_BUNDLE_ID", "org.fiberseq.FiberBrowser")

# Backend module names as the server imports them (services.x, routers.y, ...).
backend_modules = []
for path in sorted(BACKEND.rglob("*.py")):
    rel = path.relative_to(BACKEND)
    if rel.parts[0] in ("frontend", "data", "plugin-template"):
        continue
    parts = list(rel.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    if parts:
        backend_modules.append(".".join(parts))
backend_top = {m.split(".")[0] for m in backend_modules}

datas = []
for path in sorted(PKG.rglob("*")):
    if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
        datas.append((str(path), str(Path("fiberbrowser") / path.relative_to(PKG).parent)))
datas += copy_metadata("fiberhmm") + copy_metadata("fiberbrowser")
datas += collect_data_files("fiberhmm")
# pyjaspar bundles every JASPAR release (~20 MB each); the browser reads
# JASPAR2024 (services/motifs.py). Keep that and the newest.
JASPAR_KEEP = set(os.environ.get("FB_JASPAR_RELEASES", "JASPAR2024,JASPAR2026").split(","))

binaries = []
hiddenimports = backend_modules + collect_submodules("fiberhmm") + [
    "fiberbrowser.desktop", "fiberbrowser.shortcut", "fiberbrowser.cli",
    "joblib.externals.loky.backend.popen_loky_posix",
    "joblib.externals.loky.backend.resource_tracker",
    "multiprocessing.resource_tracker",
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
    "multipart", "python_multipart", "pyBigWig",
]
# Optional features bundled in the app; skipped when not installed in the build venv.
OPTIONAL_PACKAGES = ("primer3", "seqfold", "cooler", "h5py", "umap", "pynndescent", "s3fs", "fsspec")
for package in ("pysam", "pyjaspar") + tuple(
        name for name in OPTIONAL_PACKAGES if importlib.util.find_spec(name) is not None):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
    pkg_datas = [(src, dst) for src, dst in pkg_datas
                 if not (src.endswith(".sqlite") and Path(src).stem.startswith("JASPAR")
                         and Path(src).stem not in JASPAR_KEEP)]
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

# The graph view's native helper (fiberbrowser-graph, DESIGN_GRAPH_PANEL.md §2): FB_GRAPH_HELPER, else the
# fiberbrowser-graph-native companion package installed in the build venv. Collected into graph-helper/
# (services/graph_panel/helper.py finds it there); build_app.sh signs and smoke-tests it. FB_REQUIRE_GRAPH_HELPER=1
# makes a build without one fail.
GRAPH_HELPER = os.environ.get("FB_GRAPH_HELPER", "").strip()
if not GRAPH_HELPER and importlib.util.find_spec("fiberbrowser_graph_native") is not None:
    import fiberbrowser_graph_native
    GRAPH_HELPER = str(fiberbrowser_graph_native.helper_path())
if GRAPH_HELPER:
    if not os.access(GRAPH_HELPER, os.X_OK):
        raise SystemExit(f"FiberBrowser.spec: the graph helper {GRAPH_HELPER} is not an executable")
    binaries.append((GRAPH_HELPER, "graph-helper"))
    _graph_notices = Path(GRAPH_HELPER).resolve().parent.parent / "THIRD_PARTY_NOTICES.txt"
    if _graph_notices.is_file():
        datas.append((str(_graph_notices), "graph-helper"))
elif os.environ.get("FB_REQUIRE_GRAPH_HELPER") == "1":
    raise SystemExit("FiberBrowser.spec: FB_REQUIRE_GRAPH_HELPER=1 but no graph helper (FB_GRAPH_HELPER or fiberbrowser-graph-native)")
# Its Python module is not needed in the app (the executable is found in graph-helper/).
GRAPH_EXCLUDES = ["fiberbrowser_graph_native"]

a = Analysis(  # noqa: F821
    [str(SPEC_DIR / "fiberbrowser_app.py")],
    pathex=[str(BACKEND)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "jupyter", "notebook", "pytest", "torch",
              "mlx", "mlx_lm", "transformers"] + GRAPH_EXCLUDES,
    module_collection_mode={"fiberhmm": "pyz+py"},
    noarchive=False,
)
# The backend runs from fiberbrowser/browser on disk, never from the archive
# (its modules find their data relative to their own files).
a.pure = [entry for entry in a.pure if entry[0].split(".")[0] not in backend_top]

pyz = PYZ(a.pure)  # noqa: F821
exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="FiberBrowser",
    debug=False,
    strip=False,
    upx=False,
    console=False,
    argv_emulation=False,
    target_arch="arm64",
    codesign_identity=None,  # build_app.sh signs the finished bundle
    entitlements_file=None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="FiberBrowser")  # noqa: F821
app = BUNDLE(  # noqa: F821
    coll,
    name="FiberBrowser.app",
    icon=str(SPEC_DIR / "FiberBrowser.icns"),
    bundle_identifier=BUNDLE_ID,
    version=VERSION,
    info_plist={
        "CFBundleName": "FiberBrowser",
        "CFBundleDisplayName": "FiberBrowser",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        "LSMinimumSystemVersion": MIN_MACOS,
        "LSApplicationCategoryType": "public.app-category.education",
        "NSHighResolutionCapable": True,
        "NSRequiresAquaSystemAppearance": False,
        "NSHumanReadableCopyright": "FiberBrowser Authors",
        # The window shows the app's own server on 127.0.0.1.
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        # fiberbrowser://open?session=<URL> links from other pages: staged on the
        # app's server and confirmed by the user before anything loads
        # (fiberbrowser/open_link.py, docs/workflows/open-from-links.md).
        "CFBundleURLTypes": [{
            "CFBundleURLName": f"{BUNDLE_ID}.open-link",
            "CFBundleURLSchemes": ["fiberbrowser"],
            "CFBundleTypeRole": "Viewer",
        }],
    },
)
