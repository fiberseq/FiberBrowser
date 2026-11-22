"""Scripted figures: render a saved session to PDF/SVG/PNG without a browser, with a receipt.

    python -m fiberbrowser render SESSION.json --out panel.pdf [--seed S --spanning-only --size 180x120mm
        --hide sv --dpi 600 --min-font 6 --fonts truetype --remap OLD=NEW --gtf genes.gtf --fasta ref.fa]

(``fiberbrowser render ...`` when installed.) From Python::

    from fiberbrowser.scripted import remap_session, render_session
    session, files = remap_session("fig.json", {"/old/data/": "/new/data/"})
    receipt = render_session(session, "panel.pdf", gtf="genes.gtf", fasta="ref.fa", sample_seed="fig",
                             hide_tracks=["sv"], page_size="180x120mm")

The renderer is the server's headless engine (``BrowserClient.figure(engine="headless")``); with no
options a session renders exactly as ``figure()`` renders it. See docs/jupyter-api.md, "Scripted figures
(headless)".
"""
from __future__ import annotations

import argparse
import copy
import datetime as _dt
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Iterable, Optional, Union

from ._paths import app_root, version

SF_DATALESS = 0x40000000          # macOS: an APFS "dataless" file (File Provider online-only placeholder)
WIN_OFFLINE = 0x1000              # FILE_ATTRIBUTE_OFFLINE
WIN_RECALL_ON_OPEN = 0x40000      # FILE_ATTRIBUTE_RECALL_ON_OPEN
WIN_RECALL_ON_DATA_ACCESS = 0x400000  # FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
_WIN_PLACEHOLDER = WIN_OFFLINE | WIN_RECALL_ON_OPEN | WIN_RECALL_ON_DATA_ACCESS


class SessionFileError(RuntimeError):
    """Files a session needs are missing or are cloud placeholders (online-only)."""

    def __init__(self, missing: list, online_only: list):
        self.missing, self.online_only = missing, online_only
        parts = []
        if missing:
            parts.append("MISSING:\n  " + "\n  ".join(missing))
        if online_only:
            parts.append("ONLINE-ONLY (cloud placeholders; make them available offline first, opening them "
                         "would start a full download):\n  " + "\n  ".join(f"{p}  [{why}]" for p, why in online_only))
        super().__init__("\n".join(parts))


# ---------------------------------------------------------------------------
# online-only (cloud placeholder) detection
# ---------------------------------------------------------------------------
def placeholder_reason(path: str) -> Optional[str]:
    """Why ``path`` looks like a cloud placeholder, or None. Uses stat data only (never opens the file).

    - zero-size file (older Dropbox placeholders; a real BAM/bigBed/FASTA is never empty)
    - macOS: the SF_DATALESS flag, set on File Provider online-only files (Dropbox and Google Drive under
      ~/Library/CloudStorage); such files also report 0 allocated blocks
    - any OS: a non-empty file with 0 allocated blocks
    - Windows: the OFFLINE / RECALL_ON_OPEN / RECALL_ON_DATA_ACCESS attributes (Dropbox, OneDrive)
    - WSL: the same Windows attributes for files under /mnt/<drive>/, read with powershell.exe
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    if st.st_size == 0:
        return "zero-size file"
    flags = getattr(st, "st_flags", 0) or 0
    if flags & SF_DATALESS:
        return "macOS dataless (online-only) file"
    attrs = getattr(st, "st_file_attributes", 0) or 0
    if attrs & _WIN_PLACEHOLDER:
        return "Windows offline/recall-on-access attribute"
    if getattr(st, "st_blocks", None) == 0 and st.st_size > 0 and os.name != "nt":
        return "no data blocks on disk"
    return _wsl_reason(path)


def _wsl_reason(path: str) -> Optional[str]:
    """/mnt/<drive>/... on WSL: the Windows file attributes (drvfs does not expose them to stat)."""
    if not (path.startswith("/mnt/") and len(path) > 6 and path[6] in "/" and path[5].isalpha()):
        return None
    if not _is_wsl():
        return None
    win = path[5].upper() + ":\\" + path[7:].replace("/", "\\")
    try:
        out = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-c",
                              "[int](Get-Item -LiteralPath '" + win.replace("'", "''") + "' -Force).Attributes"],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        attrs = int(out.splitlines()[-1])
    except Exception:
        return None
    return "Windows offline/recall-on-access attribute (WSL)" if attrs & _WIN_PLACEHOLDER else None


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


# ---------------------------------------------------------------------------
# session paths
# ---------------------------------------------------------------------------
def load_session(session: Union[str, os.PathLike, dict]) -> tuple[dict, Optional[str]]:
    """(session dict, path or None)."""
    if isinstance(session, dict):
        return session, None
    path = os.path.expanduser(str(session))
    with open(path, encoding="utf-8") as handle:
        return json.load(handle), path


def _mapping_pairs(mapping) -> list[tuple[str, str]]:
    if not mapping:
        return []
    pairs = list(mapping.items()) if isinstance(mapping, dict) else [tuple(p) for p in mapping]
    # Longest old prefix first, so a deeper rule wins over a shallower one.
    return sorted(((str(a), str(b)) for a, b in pairs), key=lambda p: -len(p[0]))


def _remap(value, pairs):
    if isinstance(value, dict):
        return {k: _remap(v, pairs) for k, v in value.items()}
    if isinstance(value, list):
        return [_remap(v, pairs) for v in value]
    if isinstance(value, str):
        for old, new in pairs:
            if value.startswith(old):
                return new + value[len(old):]
    return value


def _browser_on_path() -> None:
    folder = str(app_root() / "browser")
    if folder not in sys.path:
        sys.path.insert(0, folder)


def session_files(session: dict) -> list[str]:
    """Every local file the session's restore opens, plus BAM indexes and the figure's annotation BED."""
    _browser_on_path()
    from services.session_files import session_file_refs
    files = []
    for ref in session_file_refs(session):
        path = ref["path"]
        files.append(path)
        low = path.lower()
        if low.endswith(".bam") or low.endswith(".cram"):
            index = [path + ".bai", path[:-4] + ".bai", path + ".csi", path + ".crai"]
            found = next((i for i in index if os.path.exists(i)), None)
            files.append(found or path + ".bai")
    ann = ((session.get("headless_figure") or {}).get("annotations") or {}) if isinstance(session, dict) else {}
    if ann.get("bed"):
        files.append(ann["bed"])
    # A session saved on a meta-locus view reopens its pool from this BED (remap and check it like the BAMs).
    meta = ((session.get("frontend") or {}).get("metaLocus") or {}) if isinstance(session, dict) else {}
    if isinstance(meta, dict) and meta.get("bed_path"):
        files.append(meta["bed_path"])
    return list(dict.fromkeys(files))


def check_files(files: Iterable[str]) -> None:
    """Raise SessionFileError naming every missing file and every cloud placeholder."""
    missing, online = [], []
    for path in files:
        if not os.path.exists(path):
            missing.append(path)
            continue
        why = placeholder_reason(path)
        if why:
            online.append((path, why))
    if missing or online:
        raise SessionFileError(missing, online)


def remap_session(session: Union[str, os.PathLike, dict], mapping=None, *, check: bool = True,
                  drop_history: bool = True) -> tuple[dict, list[str]]:
    """Rewrite path prefixes (``{old prefix: new prefix}`` or ``[(old, new), ...]``; longest first) everywhere in
    a session, then check every file it needs exists and is local. Returns (new session, files).

    ``drop_history`` drops the browser's undo snapshots (``frontend.historySnapshots``), which the renderer
    never reads and which can be tens of MB."""
    data, _path = load_session(session)
    out = _remap(copy.deepcopy(data), _mapping_pairs(mapping))
    if drop_history and isinstance(out.get("frontend"), dict):
        out["frontend"].pop("historySnapshots", None)
    files = session_files(out)
    if check:
        check_files(files)
    return out, files


# ---------------------------------------------------------------------------
# receipt
# ---------------------------------------------------------------------------
def git_commit() -> Optional[str]:
    """The FiberBrowser commit: from git when this is a checkout, from the archive stamp in a ``git archive``
    snapshot, else ``$FIBERBROWSER_GIT``."""
    root = app_root()
    try:
        if not (root / ".git").exists():
            raise FileNotFoundError  # a snapshot inside some other repository must not report that one's commit
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
        if out.returncode == 0 and out.stdout.strip():
            dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"],
                                   capture_output=True, text=True, timeout=30).stdout.strip()
            return out.stdout.strip() + ("-dirty" if dirty else "")
    except Exception:
        pass
    stamp = Path(__file__).with_name("_git_archive.txt")
    try:
        text = stamp.read_text().strip()
        if text and "$Format" not in text:
            return text.split()[0]
    except OSError:
        pass
    return os.environ.get("FIBERBROWSER_GIT") or None


def file_hash(path: str, mode: str = "sha256") -> Optional[str]:
    """``sha256`` (whole file), ``fast`` (sha256 of size + first and last MiB) or ``none``."""
    if mode == "none":
        return None
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        if mode == "fast":
            size = os.fstat(handle.fileno()).st_size
            h.update(str(size).encode())
            h.update(handle.read(1 << 20))
            if size > 2 << 20:
                handle.seek(-(1 << 20), os.SEEK_END)
                h.update(handle.read(1 << 20))
            return "fast:" + h.hexdigest()
        for chunk in iter(lambda: handle.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def _iso(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).isoformat(timespec="seconds")


def build_receipt(*, output: str, session: dict, session_path: Optional[str], files: Iterable[str],
                  manifest: Optional[dict], options: dict, hash_mode: str = "sha256", extra: Optional[dict] = None) -> dict:
    inputs = []
    for path in files:
        entry = {"path": path}
        try:
            st = os.stat(path)
            entry.update(size=st.st_size, mtime=_iso(st.st_mtime))
            entry["sha256" if hash_mode == "sha256" else "hash"] = file_hash(path, hash_mode)
        except OSError as exc:
            entry["error"] = str(exc)
        inputs.append(entry)
    canonical = json.dumps(session, sort_keys=True, separators=(",", ":")).encode()
    panels = (manifest or {}).get("panels") or []
    receipt = {
        "created": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "output": {"path": output, "sha256": file_hash(output, "sha256") if os.path.exists(output) else None},
        "fiberbrowser": {"version": version(), "git_commit": git_commit(), "app_root": str(app_root())},
        "python": sys.version.split()[0],
        "session": {"path": session_path,
                    "file_sha256": file_hash(session_path, "sha256") if session_path else None,
                    "rendered_sha256": hashlib.sha256(canonical).hexdigest()},
        "seed": (manifest or {}).get("sample_seed"),
        "options": options,
        "inputs": inputs,
        "input_hash": hash_mode,
        "read_counts": [{k: p.get(k) for k in ("panel_id", "dataset_id", "label", "reads_drawn", "reads_loaded",
                                                "clusters") if k in p} for p in panels],
        "manifest": manifest,
    }
    if session.get("headless_cluster"):
        receipt["cluster"] = session["headless_cluster"]
    if (manifest or {}).get("meta_locus"):
        # Pooled loci: BED sha256, anchor, flank, datasets, pool size (sites, read-site pairs), seed, count, spec hash.
        receipt["meta_locus"] = manifest["meta_locus"]
    if extra:
        receipt.update(extra)
    return receipt


def receipt_path(output: str) -> str:
    return str(Path(output).with_name(Path(output).name + ".receipt.json"))


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------
def _client_class():
    root = str(app_root())
    if root not in sys.path:
        sys.path.insert(0, root)
    from browser_client import BrowserClient
    return BrowserClient


FIGURE_OPTIONS = ("spanning_only", "sample_seed", "max_reads", "hide_tracks", "annotations", "page_size", "page_fit",
                  "min_font_pt", "raster_dpi", "pdf_fonts", "scale", "width", "row_height", "region", "dataset_ids",
                  "title", "include_coords", "meta_locus")


def _meta_files(meta_locus) -> list:
    """The meta-locus spec's BED (checked and hashed like the session's files)."""
    if isinstance(meta_locus, dict):
        bed = meta_locus.get("bed") or meta_locus.get("bed_path")
        if bed:
            return [os.path.abspath(os.path.expanduser(str(bed)))]
    return []


def _dataset_path(spec: str) -> str:
    """"PATH" or "PATH:LABEL" -> PATH."""
    spec = str(spec)
    if os.path.exists(spec) or ":" not in spec:
        return os.path.abspath(os.path.expanduser(spec))
    return os.path.abspath(os.path.expanduser(spec.rsplit(":", 1)[0]))


def _start_client(gtf, fasta, datasets, port, timeout, quiet):
    """A headless server; ``datasets`` ("PATH" or "PATH:LABEL") are loaded at start (needed without a session)."""
    return _client_class().headless(gtf=gtf, fasta=fasta, dataset=list(datasets or []) or None, port=port,
                                    timeout=timeout, quiet=quiet)


def render_session(session: Union[str, os.PathLike, dict, None], output: str, *, gtf: Optional[str] = None,
                   fasta: Optional[str] = None, remap=None, check: bool = True, recluster: Optional[dict] = None,
                   cluster_tsv: Optional[str] = None, save_session: Optional[str] = None,
                   receipt: Union[bool, str] = True, hash_mode: str = "sha256", manifest_read_ids: bool = False,
                   client=None, port: Optional[int] = None, timeout: int = 180, quiet: bool = True,
                   datasets: Optional[list] = None, **figure_kwargs) -> dict:
    """Render ``session`` to ``output`` (format from its extension) and write a JSON receipt next to it.

    ``remap``: path prefixes to rewrite first ({old: new}); every file is then checked (missing / online-only
    fail loudly unless ``check=False``). ``recluster``: re-cluster before drawing, e.g.
    ``{"method": "kmeans", "k": 6, "seed": "fig", "features": [(start, end), ...]}``
    (BrowserClient.recluster_session); ``cluster_tsv`` writes its assignments and counts. ``client``: an
    existing BrowserClient (else a headless server is started with ``gtf``/``fasta``). Other keyword
    arguments go to BrowserClient.figure(). Returns the receipt."""
    unknown = sorted(set(figure_kwargs) - set(FIGURE_OPTIONS))
    if unknown:
        raise TypeError(f"unknown figure option(s): {', '.join(unknown)}")
    meta_locus = figure_kwargs.get("meta_locus")
    if session is None:
        # Pooled loci by spec (meta_locus) with no session: the datasets come from ``datasets`` (or the client).
        if meta_locus is None:
            raise ValueError("Give a session, or meta_locus (with datasets) for pooled loci")
        data, session_path, files = None, None, []
    else:
        data, session_path = load_session(session)
        data, files = remap_session(data, remap, check=check)
    # A BED given with the call (or --bed) is an input like the session's: checked, and hashed in the receipt.
    ann = figure_kwargs.get("annotations")
    call_bed = ann.get("bed") if isinstance(ann, dict) else None
    if call_bed:
        call_bed = os.path.expanduser(str(call_bed))
        files = list(dict.fromkeys([*files, call_bed]))
    extra_files = _meta_files(meta_locus) + [_dataset_path(d) for d in (datasets or [])]
    if check:
        check_files(extra_files)
    files = list(dict.fromkeys(files + extra_files))
    for path in (gtf, fasta, call_bed):
        if path and check:
            check_files([path])
    fmt = Path(output).suffix.lower().lstrip(".")
    if fmt not in ("pdf", "svg", "png"):
        raise ValueError(f"output must end in .pdf, .svg or .png: {output}")
    own = client is None
    if own:
        client = _start_client(gtf, fasta, datasets, port, timeout, quiet)
    try:
        if recluster:
            # Cluster where the figure is drawn: a --region render clusters that region, not the saved view.
            extra = {"region": figure_kwargs["region"]} if figure_kwargs.get("region") and "region" not in recluster else {}
            reply = client.recluster_session(data, out_tsv=cluster_tsv, meta_locus=meta_locus, **recluster, **extra)
            data = reply["session"]
            # The re-clustered session holds the pool's spec and working set: it now drives the figure.
            figure_kwargs = {k: v for k, v in figure_kwargs.items() if k != "meta_locus"}
        if save_session and data is not None:
            Path(save_session).write_text(json.dumps(data, indent=1))
        body, manifest = client.figure(session=data, load_session=data is not None, format=fmt, engine="headless",
                                       return_manifest=True, manifest_read_ids=manifest_read_ids, **figure_kwargs)
    finally:
        if own:
            client.close()
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_bytes(body)
    options = {k: v for k, v in figure_kwargs.items()}
    if recluster:
        options["recluster"] = recluster
    info = build_receipt(output=str(output), session=data or {}, session_path=session_path,
                         files=files + [p for p in (gtf, fasta) if p], manifest=manifest, options=options,
                         hash_mode=hash_mode)
    if receipt:
        target = receipt if isinstance(receipt, str) else receipt_path(str(output))
        Path(target).write_text(json.dumps(info, indent=1, default=str))
        info["receipt_path"] = target
    return info


# ---------------------------------------------------------------------------
# CLI: fiberbrowser render
# ---------------------------------------------------------------------------
def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="fiberbrowser render",
        description="Render a saved FiberBrowser session to PDF, SVG or PNG with the headless engine (no browser), "
                    "and write a JSON receipt next to it. With no options the session renders as the browser's "
                    "figure() does.")
    p.add_argument("session", nargs="?", help="session JSON (saved with the browser's Save); optional for pooled "
                                             "loci given by --bed/--anchor/--flank with --bam")
    p.add_argument("--out", "-o", required=True, help="output file: .pdf, .svg or .png")
    _meta_args(p)
    g = p.add_argument_group("data")
    g.add_argument("--gtf", help="gene annotation for the server")
    g.add_argument("--fasta", help="reference FASTA for the server")
    g.add_argument("--remap", action="append", default=[], metavar="OLD=NEW",
                   help="rewrite a path prefix in the session (repeatable; longest prefix wins)")
    g.add_argument("--no-check", action="store_true", help="skip the missing / online-only file check")
    g = p.add_argument_group("reads")
    g.add_argument("--seed", help="sample seed for which reads a panel draws when it has more than it shows")
    span = g.add_mutually_exclusive_group()
    span.add_argument("--spanning-only", dest="spanning_only", action="store_true", default=None,
                      help="only reads spanning the region")
    span.add_argument("--all-reads", dest="spanning_only", action="store_false",
                      help="all overlapping reads (overrides the session)")
    g.add_argument("--max-reads", action="append", default=[], metavar="N|DATASET=N",
                   help="reads per panel; DATASET=N for one dataset (id, panel id or label; repeatable)")
    g.add_argument("--region", help="render another region, e.g. chr2L:1,000-6,000")
    g = p.add_argument_group("layout")
    g.add_argument("--hide", action="append", default=[], metavar="TRACK",
                   help="leave out a row in every panel: sv, sv_marks, coverage, axis, gene, header, fire, "
                        "sequence, composite, annotation (repeatable or comma-separated)")
    g.add_argument("--size", help="physical page size, e.g. 180x120mm, 7x5in, 510x340pt (one side: 180mm)")
    g.add_argument("--fit", choices=("contain", "width", "height", "stretch"), help="how the figure fits --size")
    g.add_argument("--dpi", type=float, help="read raster resolution on the page (and PNG resolution)")
    g.add_argument("--min-font", type=float, metavar="PT", help="smallest text size in final points")
    g.add_argument("--fonts", choices=("standard", "truetype"),
                   help="PDF text: base-14 Helvetica (default) or embedded TrueType (fonttype 42)")
    g.add_argument("--scale", type=float, help="PNG pixels per CSS px (default 2; ignored with --size/--dpi)")
    g.add_argument("--width", type=int, help="layout width in CSS px")
    g.add_argument("--row-height", type=float, help="read row height in CSS px")
    g = p.add_argument_group("annotation")
    g.add_argument("--bed", help="BED overlay (name column = labels)")
    g.add_argument("--bed-draw", choices=("track", "through", "both", "none"), help="where the BED is drawn")
    g.add_argument("--target", help="the BED interval for classes/stats: its name, index, or START-END")
    g.add_argument("--classes", nargs="?", const="175,300,500", metavar="T1,T2,...",
                   help="colour each read's opening at the target by width class (thresholds in bp)")
    g.add_argument("--class-names", help="comma-separated class names (one more than thresholds)")
    g.add_argument("--stats", nargs="?", const="both", choices=("panel", "cluster", "both"),
                   help="side labels: n reads and %% with no opening at the target")
    g.add_argument("--patch-layer", help="read layer used as the accessible patch (default msp)")
    g = p.add_argument_group("re-cluster")
    g.add_argument("--recluster", metavar="METHOD:K", help="re-cluster before drawing, e.g. kmeans:6")
    g.add_argument("--cluster-seed", help="seed for --recluster (default: --seed, else the browser default)")
    g.add_argument("--cluster-features", metavar="BED", help="cluster on these intervals (default: the whole region)")
    g.add_argument("--cluster-window", metavar="FROM,TO",
                   help="meta-locus: cluster on this window, bp from the anchor (default -500,500)")
    g.add_argument("--cluster-tsv", help="write the assignments here (and counts to <name>.counts.tsv)")
    g.add_argument("--save-session", help="write the session as rendered (remapped, re-clustered) here")
    g = p.add_argument_group("receipt and server")
    g.add_argument("--receipt", help="receipt path (default: <out>.receipt.json)")
    g.add_argument("--no-receipt", action="store_true")
    g.add_argument("--hash", choices=("sha256", "fast", "none"), default="sha256",
                   help="input file hashes in the receipt: sha256 (default), fast (size + first/last MiB), none")
    g.add_argument("--read-ids", action="store_true", help="list each panel's drawn read ids in the receipt")
    g.add_argument("--port", type=int, help="headless server port (default: a free one)")
    g.add_argument("--timeout", type=int, default=180, help="server start-up timeout in s")
    g.add_argument("--verbose", "-v", action="store_true", help="show the server's log")
    return p


META_FLAGS = ("anchor", "flank", "count", "sites")


def _meta_args(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group(
        "pooled loci (meta-locus)",
        "A BED's sites pooled into one virtual locus, reads aligned on each site's anchor (minus-strand sites "
        "flipped), as the browser's Open BED as meta-locus. Any of --anchor, --flank, --count or --sites turns it "
        "on; then --bed names the sites, --seed the working set's seed, and BED overlays are not available.")
    g.add_argument("--sites", metavar="BED", help="the sites BED (same as --bed in this mode)")
    g.add_argument("--anchor", choices=("start", "centre", "center", "end"),
                   help="where each site is anchored (strand-aware; start = TSS); default centre")
    g.add_argument("--flank", type=int, metavar="BP", help="bp each side of the anchor (default 10000)")
    g.add_argument("--count", type=int, help="working-set size (read-site pairs; default 2000)")
    g.add_argument("--datasets", help="datasets to pool (ids, comma-separated; default every loaded BAM)")
    g.add_argument("--bam", action="append", default=[], metavar="PATH[:LABEL]",
                   help="load this BAM on the headless server (repeatable; needed without a session)")
    g.add_argument("--window", metavar="FROM,TO", help="bp from the anchor, e.g. -500,500 (default the whole window)")
    g.add_argument("--no-anchor-mark", action="store_true", help="leave the anchor mark off the axis")


def meta_from_args(a) -> Optional[dict]:
    """The meta-locus spec of the CLI flags (None when none of them is given)."""
    if not any(getattr(a, k, None) is not None for k in META_FLAGS):
        return None
    bed = a.sites or getattr(a, "bed", None)
    if not bed:
        raise SystemExit("pooled loci need --bed (or --sites) naming the sites BED")
    for flag in ("target", "classes", "stats", "bed_draw", "patch_layer"):
        if getattr(a, flag, None):
            raise SystemExit(f"--{flag.replace('_', '-')}: BED overlays need real genome coordinates, not a meta-locus")
    spec: dict = {"bed": os.path.abspath(os.path.expanduser(bed))}
    if a.anchor:
        spec["anchor"] = "centre" if a.anchor == "center" else a.anchor
    if a.flank is not None:
        spec["flank_bp"] = a.flank
    if a.count is not None:
        spec["count"] = a.count
    if getattr(a, "seed", None) is not None:
        try:
            spec["seed"] = int(a.seed)
        except ValueError:
            raise SystemExit("--seed: a meta-locus working-set seed is an integer") from None
    if a.datasets:
        spec["datasets"] = [d for d in a.datasets.replace(",", " ").split() if d]
    if a.window:
        lo, hi = (int(x) for x in a.window.replace(" ", "").split(",", 1))
        spec["window"] = [lo, hi]
    if a.no_anchor_mark:
        spec["anchor_mark"] = False
    return spec


WINDOW_FLAGS = ("--window", "--cluster-window", "--window-genomic")


def _join_negative_values(argv: Optional[list]) -> Optional[list]:
    """``--window -200,50`` -> ``--window=-200,50`` (argparse would read -200,50 as a flag)."""
    if argv is None:
        argv = sys.argv[1:]
    out, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a in WINDOW_FLAGS and i + 1 < len(argv) and argv[i + 1][:1] == "-" and argv[i + 1][1:2].isdigit():
            out.append(f"{a}={argv[i + 1]}")
            i += 2
            continue
        out.append(a)
        i += 1
    return out


def _split(values: list) -> list:
    return [v for item in values for v in str(item).replace(",", " ").split() if v]


def options_from_args(a) -> dict:
    """figure()/render_session() keyword arguments from parsed CLI arguments."""
    kw: dict = {}
    meta = meta_from_args(a)
    if meta is not None:
        kw["meta_locus"] = meta
        a = argparse.Namespace(**{**vars(a), "bed": None, "seed": None})  # --bed / --seed belong to the pool here
    if a.seed:
        kw["sample_seed"] = a.seed
    if a.spanning_only is not None:
        kw["spanning_only"] = a.spanning_only
    if a.max_reads:
        per, total = {}, None
        for item in a.max_reads:
            if "=" in item:
                key, n = item.rsplit("=", 1)
                per[key] = int(n)
            else:
                total = int(item)
        if per and total is not None:
            raise SystemExit("--max-reads: give N or DATASET=N entries, not both")
        kw["max_reads"] = per or total
    for name, value in (("region", a.region), ("page_size", a.size), ("page_fit", a.fit), ("raster_dpi", a.dpi),
                        ("min_font_pt", a.min_font), ("pdf_fonts", a.fonts), ("scale", a.scale), ("width", a.width),
                        ("row_height", a.row_height)):
        if value is not None:
            kw[name] = value
    if a.hide:
        kw["hide_tracks"] = _split(a.hide)
    if a.bed or a.classes or a.stats:
        if not a.bed:
            raise SystemExit("--classes and --stats need --bed")
        ann: dict = {"bed": os.path.abspath(a.bed)}
        if a.bed_draw:
            ann["draw"] = a.bed_draw
        if a.target:
            t = a.target
            if t.isdigit():
                ann["target"] = int(t)
            elif "-" in t and t.replace("-", "").replace(",", "").isdigit():
                lo, hi = t.replace(",", "").split("-")
                ann["target"] = [int(lo), int(hi)]
            else:
                ann["target"] = t
        if a.classes:
            classes: dict = {"thresholds": [float(x) for x in a.classes.split(",") if x]}
            if a.class_names:
                classes["names"] = [x.strip() for x in a.class_names.split(",")]
            ann["classes"] = classes
        if a.stats:
            ann["stats"] = {"per": a.stats}
        if a.patch_layer:
            ann["patch_layer"] = a.patch_layer
        kw["annotations"] = ann
    return kw


def render_main(argv: Optional[list] = None) -> int:
    a = _parser().parse_args(_join_negative_values(argv))
    remap = {}
    for item in a.remap:
        if "=" not in item:
            raise SystemExit(f"--remap {item!r}: use OLD=NEW")
        old, new = item.split("=", 1)
        remap[old] = new
    kw = options_from_args(a)
    recluster = _recluster_from_args(a, kw.get("meta_locus"))
    if a.session is None and "meta_locus" not in kw:
        raise SystemExit("fiberbrowser render: give a session, or pooled loci (--bed with --anchor/--flank/--count)")
    try:
        info = render_session(a.session, a.out, gtf=a.gtf, fasta=a.fasta, remap=remap, check=not a.no_check,
                              recluster=recluster, cluster_tsv=a.cluster_tsv, save_session=a.save_session,
                              receipt=False if a.no_receipt else (a.receipt or True), hash_mode=a.hash,
                              manifest_read_ids=a.read_ids, port=a.port, timeout=a.timeout, quiet=not a.verbose,
                              datasets=a.bam, **kw)
    except SessionFileError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except (RuntimeError, ValueError) as exc:
        print(f"fiberbrowser render: {exc}", file=sys.stderr)
        return 1
    counts = ", ".join(f"{p.get('label')}: {p.get('reads_drawn')}" for p in info.get("read_counts") or [])
    print(f"wrote {a.out} ({counts})" + (f"; receipt {info['receipt_path']}" if info.get("receipt_path") else ""))
    return 0


def _recluster_from_args(a, meta) -> Optional[dict]:
    if not getattr(a, "recluster", None):
        return None
    method, _, k = a.recluster.partition(":")
    recluster = {"method": method or "kmeans", "k": int(k or 5)}
    seed = a.cluster_seed or (a.seed if meta is None else None) or (str(meta["seed"]) if meta and "seed" in meta else None)
    if seed:
        recluster["seed"] = seed
    if getattr(a, "cluster_features", None):
        if meta is not None:
            raise SystemExit("--cluster-features: on a meta-locus give --cluster-window FROM,TO (bp from the anchor)")
        _browser_on_path()
        from services.figure.annotations import read_bed
        recluster["features"] = [(r["start"], r["end"]) for r in read_bed(a.cluster_features)]
    if getattr(a, "cluster_window", None):
        lo, hi = (int(x) for x in a.cluster_window.replace(" ", "").split(",", 1))
        recluster["features_relative"] = [(lo, hi)]
    return recluster


# ---------------------------------------------------------------------------
# quantify: the Quantify card's table, headless
# ---------------------------------------------------------------------------
def quantify_session(session: Union[str, os.PathLike, dict, None], out_tsv: str, *, meta_locus: Optional[dict] = None,
                     window: Optional[list] = None, window_genomic: Optional[list] = None,
                     measures: Optional[list] = None, comparison: Optional[str] = None, seed: Optional[int] = None,
                     spec: Optional[dict] = None, profile_tsv: Optional[str] = None,
                     profile_channels: Optional[list] = None, recluster: Optional[dict] = None,
                     cluster_tsv: Optional[str] = None, save_session: Optional[str] = None,
                     datasets: Optional[list] = None, gtf: Optional[str] = None, fasta: Optional[str] = None,
                     remap=None, check: bool = True, receipt: Union[bool, str] = True, hash_mode: str = "sha256",
                     client=None, port: Optional[int] = None, timeout: int = 180, quiet: bool = True) -> dict:
    """Quantify a window of a meta-locus (``meta_locus`` spec) or a session's view with the browser's Quantify
    engine (BrowserClient.quantify_window) and write its TSV, optionally the metaprofile TSV, and a receipt
    (``<out>.receipt.json``: inputs with sha256, the meta-locus record, the spec and the result)."""
    if session is None and meta_locus is None:
        raise ValueError("Give a session, or meta_locus (with datasets) for pooled loci")
    data, session_path, files = None, None, []
    if session is not None:
        data, session_path = load_session(session)
        data, files = remap_session(data, remap, check=check)
    extra_files = _meta_files(meta_locus) + [_dataset_path(d) for d in (datasets or [])]
    if check:
        check_files(extra_files + [p for p in (gtf, fasta) if p])
    files = list(dict.fromkeys(files + extra_files))
    own = client is None
    if own:
        client = _start_client(gtf, fasta, datasets, port, timeout, quiet)
    try:
        loaded = False
        if recluster:
            reply = client.recluster_session(data, out_tsv=cluster_tsv, meta_locus=meta_locus,
                                             load_session=data is not None, **recluster)
            data, meta_locus, loaded = reply["session"], None, True
        if save_session and data is not None:
            Path(save_session).write_text(json.dumps(data, indent=1))
        bounds: dict = {}
        if meta_locus is not None:
            bounds["meta_locus"] = meta_locus
        if data is not None:
            bounds["session"] = data
        if window is not None:
            bounds["window"] = window
        if window_genomic is not None:
            bounds["window_genomic"] = window_genomic
        # A session's datasets are loaded once (figure(load_session=True) does the same), unless re-clustering did.
        reply = client.quantify_window(bounds, measures=measures, comparison=comparison, seed=seed, spec=spec,
                                       out_tsv=out_tsv, load_session=data is not None and not loaded)
        profile = None
        if profile_tsv:
            profile = client.get_meta_locus_profile(meta_locus, session=data, channels=profile_channels,
                                                    out_tsv=profile_tsv)
    finally:
        if own:
            client.close()
    info = build_receipt(output=str(out_tsv), session=data or {}, session_path=session_path,
                         files=files + [p for p in (gtf, fasta) if p], manifest={"meta_locus": reply.get("meta_locus")},
                         options={"window": window, "window_genomic": window_genomic, "measures": measures,
                                  "comparison": comparison, "seed": seed, "spec": reply.get("spec"),
                                  **({"recluster": recluster} if recluster else {})},
                         hash_mode=hash_mode,
                         extra={"quantify": {"bounds": reply.get("bounds"), "comparison": reply.get("comparison"),
                                             "read_source": reply.get("read_source"), "header": reply.get("header"),
                                             "sampled": reply.get("sampled"), "result": reply.get("result")},
                                **({"profile": {"path": profile_tsv, "channels": profile["channels"],
                                                "bins": profile["bins"], "sha256": file_hash(profile_tsv)}}
                                   if profile else {})})
    info.pop("read_counts", None)
    info["seed"] = (reply.get("spec") or {}).get("seed")
    if receipt:
        target = receipt if isinstance(receipt, str) else receipt_path(str(out_tsv))
        Path(target).write_text(json.dumps(info, indent=1, default=str))
        info["receipt_path"] = target
    info["reply"] = reply
    return info


def _quantify_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="fiberbrowser quantify",
        description="Quantify a window as the browser's Quantify card does (measures x bounds x comparison, Wilson "
                    "and bootstrap intervals, the same seeds), for pooled loci (--bed/--anchor/--flank) or a saved "
                    "session's view, and write the table as TSV with a JSON receipt next to it.")
    p.add_argument("session", nargs="?", help="session JSON (optional for pooled loci given by --bed/--anchor/--flank)")
    p.add_argument("--out", "-o", required=True, help="output TSV")
    p.add_argument("--bed", help="the sites BED (pooled loci)")
    _meta_args(p)
    g = p.add_argument_group("quantify")
    g.add_argument("--measures", help="comma-separated: layer:nuc, layer:tf, layer:fire, layer:m6a, size:band "
                                      "(default: the active layers)")
    g.add_argument("--comparison", default=None, choices=("clusters", "datasets", "clusters-datasets", "pools"),
                   help="groups compared (default: the session's saved comparison, else clusters; clusters falls back "
                        "to datasets when nothing is clustered)")
    g.add_argument("--seed", help="sampling seed (meta-locus: the working set's; also the bootstrap seed)")
    g.add_argument("--window-genomic", metavar="START,END", help="a window on the view's contig instead of --window")
    g.add_argument("--value", choices=("raw", "enrichment"))
    g.add_argument("--baseline", choices=("auto", "pooled", "rest", "reference", "region", "flank", "dataset"))
    g.add_argument("--form", choices=("log2", "ratio", "percent"))
    g.add_argument("--compare", choices=("off", "diff", "log2ratio"))
    g.add_argument("--reference", help="reference group id (e.g. cl:0, ds:<dataset>)")
    g.add_argument("--stat", choices=("mean", "area"))
    g.add_argument("--ci", choices=("auto", "bootstrap", "wilson", "none"))
    g.add_argument("--resamples", type=int)
    g.add_argument("--boot-seed", type=int)
    g.add_argument("--layer-units", choices=("curve", "exact"))
    g.add_argument("--read-source", choices=("panel", "fetch"))
    g.add_argument("--size-band", metavar="FROM-TO", help="the size-band measure's band in bp, e.g. 10-80")
    g.add_argument("--profile", metavar="TSV", help="also write the metaprofile per bin (group, channel, bin, ...)")
    g.add_argument("--profile-channels", help="comma-separated layers for --profile (default the active layers)")
    g = p.add_argument_group("re-cluster first")
    g.add_argument("--recluster", metavar="METHOD:K", help="re-cluster the view first, e.g. kmeans:4")
    g.add_argument("--cluster-seed", help="seed for --recluster")
    g.add_argument("--cluster-window", metavar="FROM,TO", help="cluster on this window (bp from the anchor; "
                                                               "default -500,500)")
    g.add_argument("--cluster-tsv", help="write the assignments here")
    g.add_argument("--save-session", help="write the (re-clustered) session here")
    g = p.add_argument_group("data, receipt and server")
    g.add_argument("--gtf")
    g.add_argument("--fasta")
    g.add_argument("--remap", action="append", default=[], metavar="OLD=NEW")
    g.add_argument("--no-check", action="store_true")
    g.add_argument("--receipt")
    g.add_argument("--no-receipt", action="store_true")
    g.add_argument("--hash", choices=("sha256", "fast", "none"), default="sha256")
    g.add_argument("--port", type=int)
    g.add_argument("--timeout", type=int, default=180)
    g.add_argument("--verbose", "-v", action="store_true")
    return p


def quantify_main(argv: Optional[list] = None) -> int:
    a = _quantify_parser().parse_args(_join_negative_values(argv))
    a.target = a.classes = a.stats = a.bed_draw = a.patch_layer = None
    remap = {}
    for item in a.remap:
        if "=" not in item:
            raise SystemExit(f"--remap {item!r}: use OLD=NEW")
        old, new = item.split("=", 1)
        remap[old] = new
    meta = meta_from_args(a)
    if meta is None and a.bed:
        raise SystemExit("--bed: pooled loci also need --anchor, --flank or --count")
    if a.session is None and meta is None:
        raise SystemExit("fiberbrowser quantify: give a session, or pooled loci (--bed with --anchor/--flank/--count)")
    window = meta.pop("window", None) if meta else (
        [int(x) for x in a.window.split(",", 1)] if a.window else None)
    spec: dict = {}
    for name, key in (("value", "value"), ("baseline", "baseline"), ("form", "form"), ("compare", "compare"),
                      ("reference", "reference"), ("stat", "stat"), ("ci", "ci"), ("resamples", "resamples"),
                      ("boot_seed", "bootSeed"), ("layer_units", "layerUnits"), ("read_source", "readSource")):
        if getattr(a, name) is not None:
            spec[key] = getattr(a, name)
    if a.size_band:
        lo, hi = (int(x) for x in a.size_band.split("-", 1))
        spec["sizeFrom"], spec["sizeTo"] = lo, hi
    seed = None
    if a.seed is not None:
        try:
            seed = int(a.seed)
        except ValueError:
            raise SystemExit("--seed must be an integer") from None
    recluster = _recluster_from_args(a, meta)
    try:
        info = quantify_session(
            a.session, a.out, meta_locus=meta, window=window,
            window_genomic=[int(x) for x in a.window_genomic.split(",", 1)] if a.window_genomic else None,
            measures=[m for m in (a.measures or "").replace(",", " ").split() if m] or None,
            comparison=a.comparison, seed=seed, spec=spec, profile_tsv=a.profile,
            profile_channels=[c for c in (a.profile_channels or "").replace(",", " ").split() if c] or None,
            recluster=recluster, cluster_tsv=a.cluster_tsv, save_session=a.save_session, datasets=a.bam,
            gtf=a.gtf, fasta=a.fasta, remap=remap, check=not a.no_check,
            receipt=False if a.no_receipt else (a.receipt or True), hash_mode=a.hash, port=a.port,
            timeout=a.timeout, quiet=not a.verbose)
    except SessionFileError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except (RuntimeError, ValueError) as exc:
        print(f"fiberbrowser quantify: {exc}", file=sys.stderr)
        return 1
    cells = (info["reply"].get("result") or {}).get("cells") or []
    print(f"wrote {a.out} ({len(cells)} rows)" + (f"; receipt {info['receipt_path']}" if info.get("receipt_path") else ""))
    return 0
