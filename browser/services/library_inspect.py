"""Read what the Library shows about one file: headers only, never the reads.

Every function here only reads. A BAM gives its header (sample, chemistry
declaration, FiberHMM version and table digests, @SQ reference identity,
the plasmid map named by ``@CO FIBERHMM-REFERENCE:v1``) and its read count
from the index (no index: no count; an index is never built). QC comes from
the files fiberhmm-qc / fiberhmm-call / fiberhmm-pipeline leave beside the
BAM (``<stem>.qc.json``, ``qc/<stem>.qc.json``, ``.qc.curves.json``,
``outputs.json``). Cloud placeholders (0-byte files, macOS "dataless" files
such as Dropbox online-only files) are recorded without being opened, so a
scan never downloads them.
"""
from __future__ import annotations

import contextlib
import datetime as _dt
import hashlib
import json
import logging
import os
import re
import sys
from typing import Any, Optional

log = logging.getLogger(__name__)

BAM_EXTS = (".bam",)
BIGBED_EXTS = (".bb", ".bigbed")
PLASMID_MAP_EXTS = (".dna", ".gb", ".gbk", ".genbank", ".embl", ".emb")
KINDS = ("bam", "bigbed", "plasmid_map", "reference", "track")
OUTPUTS_SCHEMA = "fiberhmm.pipeline.outputs.v1"
CHEMISTRY_PREFIX = "FIBERHMM-CHEMISTRY:v1:"
MAX_STORED_CONTIGS = 64  # a genome is identified by its signature; plasmids have few contigs
MAX_SIDE_JSON_BYTES = 8 << 20  # qc.json / outputs.json larger than this are not read
CONTENT_SAMPLE_BYTES = 64 << 10  # content identity: three samples of this size
SF_DATALESS = 0x40000000  # macOS: the file's data lives in the cloud (File Provider)

# Name parts FiberHMM tools add after the sample name.
_SAMPLE_SUFFIXES = re.compile(
    r"(\.(fiberhmm|aligned|sorted|dedup|called|recalled|footprints|ddda|dddb|hia5|daf|m6a|nuc|tf)"
    r"|_(recalled|footprints|sorted|aligned))+$",
    re.IGNORECASE,
)

try:  # the authoritative parser when FiberHMM is installed
    from fiberhmm.io.bam_header import declared_chemistries as _declared_chemistries
except Exception:  # pragma: no cover - FiberHMM missing or too old
    _declared_chemistries = None
try:
    from fiberhmm.io.bam_header import infer_legacy_chemistry as _infer_legacy_chemistry
except Exception:  # pragma: no cover
    _infer_legacy_chemistry = None

_CHEM_FIELD = re.compile(r"^[a-z][a-z0-9_]*$")
_CHEM_VALUE = re.compile(r"^[A-Za-z0-9_.+-]+$")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def file_kind(path: str) -> Optional[str]:
    lower = path.lower()
    if lower.endswith(BAM_EXTS):
        return "bam"
    if lower.endswith(BIGBED_EXTS):
        return "bigbed"
    if lower.endswith(PLASMID_MAP_EXTS):
        return "plasmid_map"
    return None


def is_cluster_ref(path) -> bool:
    from services.remote_sources import is_source_ref
    return is_source_ref(path)


def cluster_identity(path: str) -> Optional[dict]:
    """``stat_identity`` of a file on a connected cluster (None when not connected or missing)."""
    from services.remote_sources import source_for_ref
    try:
        source = source_for_ref(path)
        if source is None or not source.is_connected(path):
            return None
        info = source.stat(path)
    except Exception:
        return None
    if not info or info.get("type") != "file":
        return None
    return {"size": int(info.get("size") or 0), "mtime_ns": int(info.get("mtime") or 0) * 10**9,
            "inode": 0, "cloud_only": False}


def stat_identity(path: str) -> Optional[dict]:
    """size / mtime / inode, plus whether the data is only in the cloud."""
    if is_cluster_ref(path):
        return cluster_identity(path)
    try:
        st = os.stat(path)
    except OSError:
        return None
    flags = getattr(st, "st_flags", 0) or 0
    cloud_only = bool(st.st_size == 0 or (sys.platform == "darwin" and flags & SF_DATALESS))
    if not cloud_only:
        # Also a placeholder with a size but no data here (metadata only, never a read).
        from services.cloud_placeholders import availability
        cloud_only = availability(path, st) == "cloud"
    return {
        "size": int(st.st_size),
        "mtime_ns": int(st.st_mtime_ns),
        "inode": int(st.st_ino),
        "cloud_only": cloud_only,
    }


def content_digest(path: str, size: int) -> Optional[str]:
    """What makes two files the same data: sha256 over the exact size and three
    ``CONTENT_SAMPLE_BYTES`` samples (start, middle, end; a file up to three
    samples long is read whole).

    A header digest alone is not identity (two runs of one pipeline share a
    header), and hashing whole multi-GB BAMs on every scan is not affordable.
    The start covers the header and first records, the end the last records;
    a different dataset differs in size or in these bytes. A copied or moved
    file gives the same digest. Never used on cloud-only or cluster files.
    """
    digest = hashlib.sha256(f"{int(size)}\n".encode())
    offsets = sorted({0, max(0, size // 2 - CONTENT_SAMPLE_BYTES // 2), max(0, size - CONTENT_SAMPLE_BYTES)})
    try:
        with open(path, "rb") as handle:
            for offset in offsets:
                handle.seek(offset)
                digest.update(handle.read(CONTENT_SAMPLE_BYTES))
    except OSError:
        return None
    return digest.hexdigest()


def same_data(recorded: Optional[dict], found: Optional[dict]) -> tuple[bool, str]:
    """(is ``found`` the data an entry recorded, why not). Both are ``identity`` dicts."""
    recorded, found = recorded or {}, found or {}
    if recorded.get("size") is not None and found.get("size") != recorded.get("size"):
        return False, "its size differs"
    if recorded.get("header_sha256") and found.get("header_sha256") != recorded.get("header_sha256"):
        return False, "its header differs"
    if recorded.get("content_sha256"):
        if not found.get("content_sha256"):
            return False, "its content could not be read to compare"
        if found["content_sha256"] != recorded["content_sha256"]:
            return False, "its content differs"
    return True, ""


def same_stat(a: Optional[dict], b: Optional[dict]) -> bool:
    """Unchanged on disk (the scanner then skips re-reading the header)."""
    if not a or not b:
        return False
    return all(a.get(k) == b.get(k) for k in ("size", "mtime_ns", "inode"))


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    try:
        return _dt.datetime.fromtimestamp(float(ts)).isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):
        return None


def read_small_json(path: Optional[str]) -> Optional[dict]:
    """A small JSON object file; None when missing, too large, not an object, or
    cloud-only (a placeholder is never opened: that would download it)."""
    if not path:
        return None
    identity = stat_identity(path)
    if identity is None or identity["cloud_only"]:
        return None
    try:
        if os.path.getsize(path) > MAX_SIDE_JSON_BYTES:
            return None
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def sample_from_name(path: str) -> str:
    base = os.path.basename(path)
    for ext in (".bam", ".bb", ".bigbed", ".bigBed") + PLASMID_MAP_EXTS:
        if base.lower().endswith(ext):
            base = base[: -len(ext)]
            break
    stripped = _SAMPLE_SUFFIXES.sub("", base)
    return stripped or base


def bam_stem(path: str) -> str:
    base = os.path.basename(path)
    return base[:-4] if base.lower().endswith(".bam") else os.path.splitext(base)[0]


def inside(path: str, root: str) -> bool:
    """``path`` is ``root`` or below it (both already resolved)."""
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def sidecar_stamp(path: str) -> Optional[list]:
    """[size, mtime_ns, inode, cloud_only] of a sidecar (a stat only), None when absent."""
    identity = stat_identity(path)
    if identity is None:
        return None
    return [identity["size"], identity["mtime_ns"], identity["inode"], identity["cloud_only"]]


class Sidecars:
    """What one inspection may read beside a data file, and what it read.

    Only regular files inside the approved folders are used (``roots``: the
    watched folder for a scan; otherwise the file's own folder, plus the run
    folder of a pipeline outputs.json that is really there), so a symlinked
    QC/outputs/index file cannot lead a scan or a download outside what the
    user chose. Cloud-only placeholders are recorded but never opened. Every
    file consulted is stamped (``stamps``) so a rescan notices when one
    changes or disappears; a malformed one is noted in ``errors`` and the
    data file's own metadata is kept.
    """

    def __init__(self, roots: list[str], fixed: bool = False):
        self.roots: list[str] = []
        self.fixed = fixed  # a watched folder: nothing outside it, not even a run folder
        for root in roots:
            self.add_root(root)
        self.stamps: dict[str, list] = {}
        self.errors: list[str] = []
        self.online_only: list[str] = []

    def add_root(self, root: Optional[str]) -> None:
        if root:
            real = os.path.realpath(root)
            if real not in self.roots:
                self.roots.append(real)

    def contains(self, path: str) -> bool:
        from services.lab.paths import allowed
        real = os.path.realpath(path)
        # On a lab server also inside its data roots, whatever a stored entry says.
        return any(inside(real, root) for root in self.roots) and allowed(real)

    def usable(self, path: Optional[str]) -> bool:
        """A regular, local file inside the approved folders (stamped when it is)."""
        if not path or not os.path.isfile(path) or not self.contains(path):
            return False
        stamp = sidecar_stamp(path)
        if stamp is None:
            return False
        self.stamps[path] = stamp
        if stamp[3]:
            if path not in self.online_only:
                self.online_only.append(path)
            return False
        return True

    def read_json(self, path: Optional[str]) -> Optional[dict]:
        if not self.usable(path):
            return None
        try:
            if os.path.getsize(path) > MAX_SIDE_JSON_BYTES:
                self.errors.append(f"{os.path.basename(path)}: larger than {MAX_SIDE_JSON_BYTES >> 20} MB, not read")
                return None
            from services.lab import get_config
            if get_config() is not None:
                # A lab server: read from the descriptor the confined walk opened
                # (a regular file in an approved folder; no symlink, never a FIFO).
                from services.lab.paths import open_confined
                opened = open_confined(path, self.roots)
                if opened is None:
                    raise FileNotFoundError(path)
                with opened[0] as handle:
                    data = json.loads(handle.read(MAX_SIDE_JSON_BYTES + 1).decode("utf-8"))
            else:
                with open(path, encoding="utf-8") as handle:
                    data = json.load(handle)
        except (OSError, ValueError) as exc:
            self.errors.append(f"{os.path.basename(path)}: not readable JSON ({type(exc).__name__})")
            return None
        if not isinstance(data, dict):
            self.errors.append(f"{os.path.basename(path)}: not a JSON object")
            return None
        return data


def default_sidecars(path: str, root: Optional[str] = None) -> Sidecars:
    """The approved folders for ``path``: the watched folder, else the file's own folder."""
    if root:
        return Sidecars([root], fixed=True)
    return Sidecars([os.path.dirname(os.path.abspath(path)), os.path.dirname(os.path.realpath(path))])


# ---------------------------------------------------------------------------
# Header parsing
# ---------------------------------------------------------------------------

def _parse_chemistry_comment(comment: str) -> Optional[dict]:
    if not str(comment).startswith(CHEMISTRY_PREFIX):
        return None
    fields: dict[str, str] = {}
    for item in str(comment)[len(CHEMISTRY_PREFIX):].split(";"):
        key, sep, value = item.partition("=")
        if not sep or key in fields or not _CHEM_FIELD.fullmatch(key) or not _CHEM_VALUE.fullmatch(value):
            return None
        fields[key] = value
    if any(not fields.get(k) for k in ("assay", "enzyme", "platform", "mode")):
        return None
    return fields


def declared_chemistries(header: dict) -> list[dict]:
    """``@CO FIBERHMM-CHEMISTRY:v1`` declarations (FiberHMM's parser when installed)."""
    if _declared_chemistries is not None:
        try:
            return [dict(d) for d in _declared_chemistries(header)]
        except Exception:  # pragma: no cover - defensive
            pass
    out, seen = [], set()
    for comment in (header or {}).get("CO", []) or []:
        parsed = _parse_chemistry_comment(str(comment))
        if parsed is None:
            continue
        identity = tuple(sorted(parsed.items()))
        if identity not in seen:
            seen.add(identity)
            out.append(parsed)
    return out


def _chemistry_key(assay: str, enzyme: str, platform: str) -> Optional[str]:
    if assay == "daf" and enzyme in ("ddda", "dddb"):
        return enzyme
    if enzyme == "hia5" and platform in ("pacbio", "nanopore"):
        return f"hia5-{platform}"
    return None


def legacy_chemistry(header: dict) -> Optional[dict]:
    """A pre-v1 FiberHMM BAM: FiberHMM's own narrow reading of its fiberhmm-call @PG
    (never file names or other tools' provenance). Shown as inferred."""
    if _infer_legacy_chemistry is None:
        return None
    try:
        legacy = _infer_legacy_chemistry(header)
    except Exception:
        return None
    if not legacy:
        return None
    assay, enzyme, platform = (str(legacy.get(k, "")).lower() for k in ("assay", "enzyme", "platform"))
    key = _chemistry_key(assay, enzyme, platform)
    if key is None:
        return None
    return {"key": key, "declared": False, "inferred": True, "source": "fiberhmm-call @PG (pre-3.0 BAM)",
            "assay": assay, "enzyme": enzyme, "platform": platform, "mode": str(legacy.get("mode", "")).lower()}


def chemistry_summary(header: dict) -> dict:
    """Chemistry from the v1 declaration; a pre-v1 FiberHMM BAM is inferred from its
    fiberhmm-call @PG; anything else (fibertools, other tools) is ``unknown``."""
    declarations = declared_chemistries(header)
    if not declarations:
        return legacy_chemistry(header) or {"key": "unknown", "declared": False}
    cores = {tuple(str(d.get(k, "")).lower() for k in ("assay", "enzyme", "platform", "mode")) for d in declarations}
    if len(cores) != 1:
        return {"key": "conflict", "declared": True, "declarations": declarations}
    last = declarations[-1]
    enzyme = str(last.get("enzyme", "")).lower()
    platform = str(last.get("platform", "")).lower()
    assay = str(last.get("assay", "")).lower()
    key = _chemistry_key(assay, enzyme, platform) or enzyme or "unknown"
    return {"key": key, "declared": True, "assay": assay, "enzyme": enzyme,
            "platform": platform, "mode": str(last.get("mode", "")).lower(), "fields": dict(last)}


def fiberhmm_provenance(header: dict, chemistry: dict) -> dict:
    """FiberHMM version/commit and table digests: from the declaration, else the last fiberhmm @PG."""
    fields = chemistry.get("fields") or {}
    out = {k: fields[k] for k in ("fiberhmm_version", "fiberhmm_commit", "apply_sha256", "recall_sha256")
           if fields.get(k)}
    programs = []
    for pg in (header or {}).get("PG", []) or []:
        name = str(pg.get("PN") or pg.get("ID") or "")
        if name.lower().startswith("fiberhmm"):
            programs.append({"name": name, "version": pg.get("VN")})
    if programs:
        out["programs"] = programs[-8:]
        if "fiberhmm_version" not in out:
            version = next((p["version"] for p in reversed(programs) if p.get("version")), None)
            if version:
                out["fiberhmm_version"] = str(version)
                out["version_source"] = "@PG"
    elif "fiberhmm_version" in out:
        out["version_source"] = "declaration"
    if "fiberhmm_version" in out and "version_source" not in out:
        out["version_source"] = "declaration"
    return out


BASECALLER_FIELDS = ("program", "version", "basecall_model", "modbase_models")
_DS_BASECALLER_KEYS = {"program": "basecaller", "version": "basecaller_version",
                       "basecall_model": "basecall_model", "modbase_models": "modbase_models"}


def _ds_basecaller(ds: str) -> dict:
    """FiberHMM's basecaller tokens in a @PG DS (as fiberhmm.io.provenance.parse_ds_tokens reads them)."""
    try:
        from fiberhmm.io.provenance import parse_ds_tokens
        return parse_ds_tokens(ds) or {}
    except Exception:
        pass
    pairs = {}
    for token in re.split(r"[\s;]+", str(ds or "")):
        key, sep, value = token.partition("=")
        if sep and key:
            pairs[key] = value
    if "basecaller" not in pairs:
        return {}
    values: dict = {}
    for field, key in _DS_BASECALLER_KEYS.items():
        value = pairs.get(key)
        if value is None or value == "unknown":
            continue
        values[field] = ([] if value == "none" else [m for m in value.split(",") if m]) \
            if field == "modbase_models" else value
    sources = {}
    for item in str(pairs.get("basecaller_sources", "")).split(","):
        field, sep, source = item.partition(":")
        if sep and field in BASECALLER_FIELDS:
            sources[field] = source
    return {"values": values, "sources": sources}


def compact_basecaller(prov: Optional[dict], source: str) -> dict:
    """The basecaller fields a Library entry keeps: program, version, models, where each came from.
    ``modbase_models``: None = unknown, [] = none (FiberHMM's convention)."""
    prov = prov if isinstance(prov, dict) else {}
    out: dict[str, Any] = {"available": bool(prov.get("available")), "source": source}
    for key in ("program", "version", "basecall_model", "platform"):
        out[key] = _text(prov.get(key))
    mods = prov.get("modbase_models")
    out["modbase_models"] = [str(m) for m in mods] if isinstance(mods, list) else None
    sources = prov.get("sources")
    out["sources"] = {str(k): str(v) for k, v in sources.items()} if isinstance(sources, dict) else {}
    out["overridden"] = any(v in ("override", "recorded-override") for v in out["sources"].values())
    return out


def basecaller_from_header(header: dict) -> dict:
    """Basecaller provenance from a BAM header alone (never the reads): FiberHMM's detection
    (fiberhmm.io.provenance: the basecaller's @PG/@RG, FiberHMM's @PG DS tokens) when it is
    importable, else the newest FiberHMM @PG whose DS records ``basecaller=``."""
    try:
        from fiberhmm.io.provenance import basecaller_provenance
        return compact_basecaller(basecaller_provenance(header or {}), "BAM header")
    except Exception:
        pass
    for pg in reversed((header or {}).get("PG", []) or []):
        name = str(pg.get("PN") or pg.get("ID") or "").lower()
        if not name.startswith("fiberhmm"):
            continue
        parsed = _ds_basecaller(str(pg.get("DS") or ""))
        if parsed:
            values = parsed.get("values") or {}
            prov = {**values, "available": bool(values), "sources": parsed.get("sources") or {}}
            return compact_basecaller(prov, "BAM header")
    return compact_basecaller(None, "BAM header")


def _guess_genome(lengths: dict[str, int]) -> Optional[str]:
    """The registry genome these contig lengths are (services/assembly_fingerprint.py)."""
    from services.assembly_fingerprint import REGISTRY_IDS, fingerprint
    fp = fingerprint(lengths.items())
    return fp.assembly if fp.kind == "genome" and fp.assembly in REGISTRY_IDS else None


def reference_identity(header: dict, bam_path: Optional[str] = None) -> dict:
    """@SQ names/lengths/M5/topology, a digest of the whole list, and what it looks like."""
    sq = (header or {}).get("SQ", []) or []
    contigs = []
    lengths = {}
    digest = hashlib.sha256()
    for row in sq:
        name = str(row.get("SN", ""))
        length = int(row.get("LN", 0) or 0)
        md5 = str(row.get("M5", "") or "").lower() or None
        circular = str(row.get("TP", "")).lower() == "circular"
        lengths[name] = length
        digest.update(f"{name}\t{length}\t{md5 or ''}\n".encode("utf-8", "replace"))
        if len(contigs) < MAX_STORED_CONTIGS:
            contig: dict[str, Any] = {"name": name, "length": length}
            if md5:
                contig["md5"] = md5
            if circular:
                contig["circular"] = True
            contigs.append(contig)
    out: dict[str, Any] = {
        "n_contigs": len(sq),
        "contigs": contigs,
        "digest": digest.hexdigest()[:16] if sq else None,
        "genome": _guess_genome(lengths),
        "total_length": sum(lengths.values()),
    }
    try:
        from services.plasmid_reconcile import parse_reference_comments, resolve_near
        declared = parse_reference_comments(header)
    except Exception:  # pragma: no cover - defensive
        declared, resolve_near = [], None
    maps = []
    for entry in declared:
        raw = entry.get("map")
        if not raw:
            continue
        resolved = resolve_near(raw, bam_path) if (resolve_near and bam_path) else None
        maps.append({"name": os.path.basename(raw), "path": resolved, "contig": entry.get("contig"),
                     "md5": entry.get("map_md5")})
    if maps:
        out["plasmid_maps"] = maps
    circular = any(str(row.get("TP", "")).lower() == "circular" for row in sq)
    small = bool(sq) and len(sq) <= 20 and max(lengths.values() or [0]) <= 500_000
    out["plasmid"] = bool(maps) or (circular and small)
    if out["plasmid"] and not out["genome"]:
        out["genome"] = None
    return out


def read_count(bam) -> dict:
    """Mapped/unmapped reads from the index; nothing (None) without one."""
    try:
        if not bam.has_index():
            return {"reads": None}
        stats = bam.get_index_statistics()
        mapped = sum(int(s.mapped) for s in stats)
        unmapped = sum(int(s.unmapped) for s in stats) + int(getattr(bam, "nocoordinate", 0) or 0)
        return {"reads": mapped + unmapped, "mapped": mapped, "unmapped": unmapped}
    except Exception:
        return {"reads": None}


def _index_path(path: str, sidecars: Optional[Sidecars] = None) -> Optional[str]:
    """The BAM's index when it may be read (inside the approved folders, not cloud-only)."""
    if is_cluster_ref(path):
        return None
    sidecars = sidecars or default_sidecars(path)
    for candidate in (path + ".bai", path[:-4] + ".bai" if path.lower().endswith(".bam") else None,
                      path + ".csi"):
        if candidate and os.path.isfile(candidate) and sidecars.usable(candidate):
            return candidate
    return None


# ---------------------------------------------------------------------------
# QC and pipeline outputs beside a BAM
# ---------------------------------------------------------------------------

def qc_verdicts(qc: Optional[dict]) -> dict:
    """What fiberhmm-pipeline reports from a .qc.json (plus a few key numbers)."""
    if not qc:
        return {}
    out: dict[str, Any] = {}
    # efficiency/background: the in-MSP and outside-MSP rate grades of a state-aware
    # QC (FiberHMM >= 3.0), as fiberhmm-pipeline writes them into outputs.json.
    for key in ("overall", "signal", "periodicity", "efficiency", "background"):
        section = qc.get(key) or {}
        if isinstance(section, dict):
            if isinstance(section.get("status"), str) and section["status"]:
                out[key] = section["status"]
            if section.get("score") is not None:
                try:
                    out[f"{key}_score"] = round(float(section["score"]), 1)
                except (TypeError, ValueError):
                    pass
    dedup = qc.get("deduplication") or {}
    if isinstance(dedup, dict) and isinstance(dedup.get("duplicate_fraction"), (int, float)):
        out["duplicate_fraction"] = dedup["duplicate_fraction"]
    overall = qc.get("overall") or {}
    if isinstance(overall, dict) and isinstance(overall.get("verdict_basis"), str) and overall["verdict_basis"]:
        out["verdict_basis"] = overall["verdict_basis"]
    return out


#: The state-aware rates a Library entry keeps (fiberhmm-pipeline's outputs.json
#: ``qc.verdicts.state_rates`` names, read from a .qc.json's ``state_rates``).
STATE_NUMBER_KEYS = ("state_source", "msp_rate", "outside_msp_rate", "msp_to_outside_ratio",
                     "msp_length_fraction", "overall_state_rate")


def state_numbers(qc: Optional[dict] = None, summary: Optional[dict] = None) -> dict:
    """In-MSP / outside-MSP rates from a .qc.json, or from an outputs.json
    ``qc.verdicts.state_rates`` summary; {} for an older QC without them."""
    raw: dict = {}
    states = (qc or {}).get("state_rates") if isinstance(qc, dict) else None
    if isinstance(states, dict) and states.get("available"):
        def part(name: str) -> dict:
            value = states.get(name)
            return value if isinstance(value, dict) else {}
        raw = {
            "state_source": states.get("source"),
            "msp_rate": part("msp").get("median_per_read_rate"),
            "outside_msp_rate": part("outside_msp").get("median_per_read_rate"),
            "msp_to_outside_ratio": states.get("msp_to_outside_ratio"),
            "msp_length_fraction": states.get("msp_length_fraction"),
            "overall_state_rate": part("all_states").get("aggregate_rate"),
        }
    elif isinstance(summary, dict):
        raw = {
            "state_source": summary.get("source"),
            "msp_rate": summary.get("msp_rate"),
            "outside_msp_rate": summary.get("outside_msp_rate"),
            "msp_to_outside_ratio": summary.get("msp_to_outside_ratio"),
            "msp_length_fraction": summary.get("msp_length_fraction"),
            "overall_state_rate": summary.get("overall_rate"),
        }
    return {key: value for key, value in raw.items()
            if isinstance(value, (str, int, float)) and not isinstance(value, bool)}


def qc_numbers(qc: Optional[dict]) -> dict:
    if not qc:
        return {}
    out = {}

    def section(name: str) -> dict:
        value = qc.get(name)
        return value if isinstance(value, dict) else {}

    signal, periodicity = section("signal"), section("periodicity")
    footprints, sampling = section("footprints"), section("sampling")
    for key, value in (
        ("signal_label", signal.get("label")),
        ("median_per_read_rate", signal.get("median_per_read_rate")),
        ("nrl_bp", periodicity.get("nrl_bp")),
        ("median_nucleosome_bp", footprints.get("median_nucleosome_bp")),
        ("sampled_reads", sampling.get("sampled_reads")),
    ):
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            out[key] = value
    out.update(state_numbers(qc))
    return out


def find_outputs_json(bam_path: str, sidecars: Optional[Sidecars] = None) -> Optional[tuple[str, dict]]:
    """The fiberhmm-pipeline outputs.json this BAM belongs to (called or aligned), if any.

    Outside a watched folder the run folder holding a real outputs.json (not a
    symlink to elsewhere) becomes an approved folder for the run's QC files."""
    sidecars = sidecars or default_sidecars(bam_path)
    real = os.path.realpath(bam_path)
    folder = os.path.dirname(real)
    for candidate in (os.path.join(folder, "outputs.json"), os.path.join(os.path.dirname(folder), "outputs.json")):
        if not os.path.isfile(candidate):
            continue
        base = os.path.dirname(candidate)
        if not inside(os.path.realpath(candidate), os.path.realpath(base)):
            continue  # a symlink to an outputs.json elsewhere
        if not sidecars.fixed and not sidecars.contains(candidate):
            probe = Sidecars([base])
            data = probe.read_json(candidate)
            sidecars.stamps.update(probe.stamps)
            sidecars.errors.extend(probe.errors)
            sidecars.online_only.extend(p for p in probe.online_only if p not in sidecars.online_only)
        else:
            data = sidecars.read_json(candidate)
        if not data or data.get("schema") != OUTPUTS_SCHEMA:
            continue
        for key in ("called_bam", "aligned_bam"):
            value = data.get(key)
            if isinstance(value, str) and value:
                resolved = value if os.path.isabs(value) else os.path.join(base, value)
                if os.path.realpath(resolved) == real:
                    if not sidecars.fixed:
                        sidecars.add_root(base)
                    return candidate, data
    return None


def _resolve_near(value: Any, base: str) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    return value if os.path.isabs(value) else os.path.join(base, value)


def qc_candidates(bam_path: str) -> list[str]:
    """Where fiberhmm-qc (default prefix) and fiberhmm-call (qc/ folder) put a BAM's QC JSON."""
    folder = os.path.dirname(os.path.abspath(bam_path))
    stem = bam_stem(bam_path)
    return [os.path.join(folder, f"{stem}.qc.json"), os.path.join(folder, "qc", f"{stem}.qc.json"),
            os.path.join(folder, f"{os.path.basename(bam_path)}.qc.json")]


def extras_stale(previous: dict, path: str) -> bool:
    """An unchanged file whose Library entry is out of date anyway: a QC file, a
    pipeline's outputs.json or the index it was read with appeared, changed or
    vanished, or FiberHMM changed since its advisories."""
    if previous.get("kind") != "bam" or previous.get("cloud_only") or previous.get("remote"):
        return False
    stamps = previous.get("sidecars")
    if not isinstance(stamps, dict):
        return True  # recorded before sidecars were stamped: read once more
    if "basecaller" not in previous and not previous.get("error"):
        return True  # recorded before basecaller provenance was read: read once more
    if "frame_unverifiable" not in previous and not previous.get("error"):
        return True  # recorded before the frame-evidence check: read once more
    for sidecar, stamp in stamps.items():
        if sidecar_stamp(sidecar) != stamp:
            return True  # a QC / outputs.json / index file changed, vanished or was downloaded
    qc = previous.get("qc") or {}
    if qc.get("json"):
        if not os.path.isfile(qc["json"]):
            return True
    elif any(os.path.isfile(candidate) for candidate in qc_candidates(path)):
        return True
    if not previous.get("pipeline") and os.path.isfile(os.path.join(os.path.dirname(os.path.abspath(path)), "outputs.json")):
        return True
    if _advisories_module() is not None:
        key = str((previous.get("advisories") or {}).get("key") or "")
        if key.split("|", 1)[-1] != str(current_fiberhmm_version()) or "|" not in key:
            return True
    return False


def qc_summary_for_bam(bam_path: str, outputs: Optional[tuple[str, dict]] = None,
                       sidecars: Optional[Sidecars] = None) -> Optional[dict]:
    """QC verdicts and numbers for a BAM from the files beside it; None when there are none."""
    sidecars = sidecars or default_sidecars(bam_path)
    usable = sidecars.usable
    json_path = curves_path = report_path = None
    source = None
    verdicts: dict = {}
    state_summary = None
    if outputs is not None:
        out_path, data = outputs
        base = os.path.dirname(out_path)
        qc = data.get("qc")
        if isinstance(qc, dict):
            json_path = _resolve_near(qc.get("json"), base)
            curves_path = _resolve_near(qc.get("curves"), base)
            report_path = _resolve_near(qc.get("report"), base)
            if isinstance(qc.get("verdicts"), dict):
                verdicts = {k: v for k, v in qc["verdicts"].items() if isinstance(v, (str, int, float))}
                state_summary = qc["verdicts"].get("state_rates")
        if not report_path:
            report_path = _resolve_near(data.get("qc_report"), base)
        source = "outputs.json"
    if not usable(json_path):
        json_path = None
        for candidate in qc_candidates(bam_path):
            if usable(candidate):
                json_path = candidate
                source = source or "qc.json"
                break
    if not usable(curves_path):
        curves_path = None
        if json_path and json_path.endswith(".qc.json"):
            candidate = json_path[: -len(".qc.json")] + ".qc.curves.json"
            if usable(candidate):
                curves_path = candidate
    qc = sidecars.read_json(json_path) if json_path else None
    if qc:
        own = qc_verdicts(qc)
        # A section the QC JSON has is authoritative for its status and score: an
        # ungraded (score null) component never keeps an older outputs.json score.
        decided = {name for key in ("overall", "signal", "periodicity", "efficiency", "background")
                   if isinstance(qc.get(key), dict) for name in (key, f"{key}_score")}
        if isinstance(qc.get("overall"), dict):
            decided.add("verdict_basis")
        verdicts = {**own, **{k: v for k, v in verdicts.items() if k not in own and k not in decided}}
    elif curves_path and not verdicts:
        curves = sidecars.read_json(curves_path) or {}
        if isinstance(curves.get("verdicts"), dict):
            verdicts = {k: v for k, v in curves["verdicts"].items() if isinstance(v, (str, int, float))}
        source = source or "qc.curves.json"
    if not verdicts and not json_path:
        return None
    if not usable(report_path):
        report_path = None
    if not report_path and json_path and json_path.endswith(".qc.json"):
        for suffix in (".qc.pdf", ".qc.png"):
            candidate = json_path[: -len(".qc.json")] + suffix
            if usable(candidate):
                report_path = candidate
                break
    numbers = qc_numbers(qc) if qc else {}
    if not (qc and isinstance(qc.get("state_rates"), dict)):
        # The QC JSON has no state block (older or partial): outputs.json's summary, if any.
        numbers = {**state_numbers(summary=state_summary), **numbers}
    return {"verdicts": verdicts, "numbers": numbers, "json": json_path, "curves": curves_path,
            "report": report_path, "source": source}


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def pipeline_summary(outputs: tuple[str, dict], bam_path: str) -> dict:
    out_path, data = outputs
    base = os.path.dirname(out_path)
    real = os.path.realpath(bam_path)
    called = _resolve_near(data.get("called_bam"), base)
    role = "called" if called and os.path.realpath(called) == real else "aligned"
    opener = data.get("open") if isinstance(data.get("open"), dict) else {}
    return {
        "outputs_json": out_path,
        "outdir": base,
        "role": role,
        "version": _text(data.get("version")),
        "sample": _text(data.get("sample")),
        "enzyme": _text(data.get("enzyme")),
        "aligned_bam": _resolve_near(data.get("aligned_bam"), base),
        "called_bam": called,
        "reference_fasta": _resolve_near(data.get("reference_fasta"), base),
        "plasmid_map": _resolve_near(data.get("plasmid_map"), base),
        "region": opener.get("region") if isinstance(opener.get("region"), str) else None,
        "open_fasta": _resolve_near(opener.get("fasta"), base),
        "open_plasmid_maps": [p for p in (_resolve_near(x, base) for x in (opener.get("plasmid_maps")
                                                                             if isinstance(opener.get("plasmid_maps"), list)
                                                                             else [])) if p],
        "settings": data.get("settings") if isinstance(data.get("settings"), dict) else None,
        "basecalled_bam": _resolve_near(data.get("basecalled_bam"), base),
    }


# ---------------------------------------------------------------------------
# FiberHMM advisories (optional module; absent: nothing is shown)
# ---------------------------------------------------------------------------

def _advisories_module():
    try:
        from fiberhmm import advisories  # type: ignore
    except Exception:
        return None
    return advisories if hasattr(advisories, "check_header") else None


def current_fiberhmm_version() -> Optional[str]:
    try:
        import fiberhmm
        return str(getattr(fiberhmm, "__version__", None) or "") or None
    except Exception:
        return None


def _plain(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "__dict__"):
        return _plain({k: v for k, v in vars(value).items() if not k.startswith("_")})
    return str(value)


def check_advisories(header: dict, header_sha256: Optional[str]) -> Optional[dict]:
    """``fiberhmm.advisories.check_header`` for this header, or None when the module is absent.

    Keyed by (header digest, FiberHMM version) so the Library re-checks after a
    FiberHMM update. Never raises: a failing check is logged and shows nothing.
    """
    module = _advisories_module()
    if module is None:
        return None
    version = current_fiberhmm_version()
    try:
        items = module.check_header(header)
    except Exception as exc:
        log.warning("fiberhmm.advisories.check_header failed: %s", exc)
        return None
    rows = []
    for item in items or []:
        row = _plain(item)
        if isinstance(row, dict):
            rows.append(row)
    return {"key": f"{header_sha256}|{version}", "fiberhmm_version": version, "items": rows}


def needs_rerun(advisories: Optional[dict]) -> Optional[str]:
    """The Library badge for an entry's FiberHMM advisories.

    'rerun-required' / 'rerun-recommended' when an advisory with that severity
    is confirmed ('affected'); 'possible' when such advisories only *may* apply
    ('possibly_affected': the header can't tell, e.g. an old dev snapshot);
    None otherwise (clean, or information only).
    """
    items = [a for a in (advisories or {}).get("items") or []
             if str(a.get("severity", "")) in ("rerun-required", "rerun-recommended")]
    confirmed = {str(a.get("severity")) for a in items if str(a.get("status", "affected")) == "affected"}
    for level in ("rerun-required", "rerun-recommended"):
        if level in confirmed:
            return level
    return "possible" if items else None


# ---------------------------------------------------------------------------
# One file
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def _open_bam(path: str, index: Optional[str]):
    """The BAM with exactly ``index`` (None: no index at all).

    ``pysam.AlignmentFile(path)`` loads whatever ``<path>.bai`` / ``.csi`` it
    finds, which may be a symlink out of the watched folder or a cloud-only
    placeholder; the index is therefore chosen here, and without one the BAM
    is opened through a file descriptor so pysam has no name to look one up by.
    """
    import pysam

    if index:
        with pysam.AlignmentFile(path, "rb", check_sq=False, index_filename=index) as bam:
            yield bam
        return
    # A bare descriptor: a Python file object's numeric name would make htslib probe <fd>.bai / <fd>.csi.
    from services.bam_tags import open_bam_without_index
    bam, descriptor = open_bam_without_index(path)
    try:
        with bam:
            yield bam
    finally:
        descriptor.close()


def inspect_bam(path: str, identity: dict, sidecars: Optional[Sidecars] = None) -> dict:
    from services.htslib_quiet import quiet_htslib

    info: dict[str, Any] = {}
    cluster = is_cluster_ref(path)
    index = None if cluster else _index_path(path, sidecars or default_sidecars(path))
    with quiet_htslib():  # no "index file is older than the data file" noise per file
        if cluster:
            from services.remote_sources.opening import open_alignment_file
            opened = open_alignment_file(path, "rb", check_sq=False)
        else:
            opened = _open_bam(path, index)
        with opened as bam:
            header = bam.header.to_dict()
            text = str(bam.text or "")
            info.update(read_count(bam))
    info["header_sha256"] = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
    chemistry = chemistry_summary(header)
    info["chemistry"] = chemistry
    info["fiberhmm"] = fiberhmm_provenance(header, chemistry)
    info["reference"] = reference_identity(header, path)
    samples = [str(rg.get("SM")) for rg in header.get("RG", []) or [] if rg.get("SM")]
    dates = [str(rg.get("DT")) for rg in header.get("RG", []) or [] if rg.get("DT")]
    info["header_sample"] = samples[0] if samples else None
    info["header_date"] = dates[0] if dates else None
    info["index_path"] = index
    try:
        info["basecaller"] = basecaller_from_header(header)
    except Exception:  # never costs the BAM its entry
        info["basecaller"] = compact_basecaller(None, "BAM header")
    advisories = check_advisories(header, info["header_sha256"])
    if advisories is not None:
        info["advisories"] = advisories
    # No frame evidence over frame-dependent footprints (FiberHMM 3.0.1's warning): a Library badge. The check reads
    # the BAM through a file descriptor, never an index beside it (one this inspection may have refused).
    if not cluster:
        from services.bam_tags import bam_frame_unverifiable
        info["frame_unverifiable"] = bam_frame_unverifiable(path)
    return info


def inspect_bigbed(path: str) -> dict:
    from services.remote_sources.opening import open_bigwig

    handle = open_bigwig(path)
    try:
        if handle is None or not handle.isBigBed():
            raise ValueError("not a BigBed file")
        chroms = handle.chroms() or {}
        sql = handle.SQL() if hasattr(handle, "SQL") else b""
        header = handle.header() or {}
    finally:
        if handle is not None:
            handle.close()
    if isinstance(sql, bytes):
        sql = sql.decode("utf-8", "replace")
    digest = hashlib.sha256()
    for name in sorted(chroms):
        digest.update(f"{name}\t{chroms[name]}\n".encode())
    digest.update(str(sql).encode("utf-8", "replace"))
    lengths = {str(k): int(v) for k, v in chroms.items()}
    contigs = [{"name": k, "length": v} for k, v in list(lengths.items())[:MAX_STORED_CONTIGS]]
    table = re.search(r"table\s+(\S+)", str(sql))
    return {
        "header_sha256": digest.hexdigest(),
        "reads": None,  # a BigBed header has no item count (counting would read the data)
        "bases_covered": int(header.get("nBasesCovered") or 0) or None,
        "bigbed_table": table.group(1) if table else None,
        "chemistry": {"key": "unknown", "declared": False},
        "reference": {"n_contigs": len(lengths), "contigs": contigs, "digest": None,
                      "genome": _guess_genome(lengths), "plasmid": False,
                      "total_length": sum(lengths.values())},
    }


def inspect_plasmid_map(path: str) -> dict:
    from services.plasmid_maps import parse_plasmid_map
    from services.plasmid_reconcile import sequence_md5

    if is_cluster_ref(path):
        from services.remote_sources.opening import local_copy
        plasmid = parse_plasmid_map(local_copy(path))
    else:
        plasmid = parse_plasmid_map(path)
    md5 = sequence_md5(plasmid.sequence)
    return {
        "header_sha256": hashlib.sha256(f"{plasmid.name}\n{md5}".encode()).hexdigest(),
        "chemistry": None,
        "reference": {"n_contigs": 1, "contigs": [{"name": plasmid.name, "length": len(plasmid.sequence),
                                                   "md5": md5, "circular": bool(plasmid.circular)}],
                      "digest": None, "genome": None, "plasmid": True,
                      "total_length": len(plasmid.sequence)},
        "plasmid_features": len(plasmid.features),
    }


def inspect_file(path: str, kind: Optional[str] = None, *, identity: Optional[dict] = None,
                 root: Optional[str] = None) -> dict:
    """Everything the Library records about one file. Never raises for a bad file:
    the result then has ``error`` (the entry is still listed); a bad QC or
    outputs.json beside it is noted in ``sidecar_errors`` and the file's own
    metadata is kept.

    ``root``: the watched folder a scan found it in; files beside it (index,
    QC, outputs.json) are then read only from inside that folder. Otherwise
    only from the file's own folder and its pipeline run folder.
    """
    cluster = is_cluster_ref(path)
    if not cluster:
        path = os.path.abspath(os.path.expanduser(path))
    kind = kind or file_kind(path) or "track"
    identity = identity or stat_identity(path)
    info: dict[str, Any] = {"kind": kind, "path": path,
                            "folder": path.rsplit("/", 1)[0] if cluster else os.path.dirname(path),
                            "label": path.rsplit("/", 1)[-1] if cluster else os.path.basename(path)}
    if identity is None:
        info["error"] = "file not found"
        return info
    info["identity"] = {k: identity[k] for k in ("size", "mtime_ns", "inode")}
    info["cloud_only"] = bool(identity.get("cloud_only"))
    info["sample"] = sample_from_name(path)
    info["date"] = _iso(identity["mtime_ns"] / 1e9)
    info["date_source"] = "modified"
    if info["cloud_only"]:
        return info
    sidecars = None if cluster else default_sidecars(path, root)
    try:
        if kind == "bam":
            info.update(inspect_bam(path, identity, sidecars))
        elif kind == "bigbed":
            info.update(inspect_bigbed(path))
        elif kind == "plasmid_map":
            info.update(inspect_plasmid_map(path))
    except Exception as exc:
        info["error"] = f"{type(exc).__name__}: {exc}"
        return info
    info["identity"]["header_sha256"] = info.pop("header_sha256", None)
    if not cluster:
        info["identity"]["content_sha256"] = content_digest(path, identity["size"])
    if cluster:
        info["remote"] = True
        return info  # run outputs / QC beside a cluster BAM are not read over the network
    if kind == "bam":
        if info.get("header_sample"):
            info["sample"] = info["header_sample"]
        if info.get("header_date"):
            info["date"] = info["header_date"]
            info["date_source"] = "@RG DT"
        outputs = None
        try:
            outputs = find_outputs_json(path, sidecars)
            if outputs is not None:
                pipeline = pipeline_summary(outputs, path)
                info["pipeline"] = pipeline
                info["role"] = pipeline["role"]
                if pipeline.get("sample"):
                    info["sample"] = pipeline["sample"]
                if pipeline.get("plasmid_map"):
                    info.setdefault("reference", {})["plasmid"] = True
                recorded = (pipeline.get("settings") or {}).get("basecaller")
                if isinstance(recorded, dict) and (recorded.get("available") or not (info.get("basecaller") or {}).get("available")):
                    # The pipeline's own reading of its inputs (headers and read groups, and any override).
                    info["basecaller"] = compact_basecaller(recorded, "outputs.json")
        except Exception as exc:  # a malformed outputs.json never costs the BAM its entry
            outputs = None
            info.pop("pipeline", None)
            sidecars.errors.append(f"outputs.json: {type(exc).__name__}: {exc}")
        if outputs is None and re.search(r"\.aligned(\.sorted)?\.bam$", path, re.IGNORECASE):
            info["role"] = "aligned"
        try:
            qc = qc_summary_for_bam(path, outputs if outputs is not None and info.get("role") != "aligned" else None,
                                    sidecars)
            if qc:
                info["qc"] = qc
        except Exception as exc:
            sidecars.errors.append(f"QC: {type(exc).__name__}: {exc}")
    if sidecars is not None and kind == "bam":
        info["sidecars"] = dict(sidecars.stamps)
        info["sidecar_roots"] = list(sidecars.roots)
        if sidecars.errors:
            info["sidecar_errors"] = list(dict.fromkeys(sidecars.errors))[:8]
        if sidecars.online_only:
            info["sidecars_online_only"] = list(sidecars.online_only)
    return info
