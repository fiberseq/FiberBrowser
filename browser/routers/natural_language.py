"""Natural-language browser command planning endpoints."""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Usage logs are off unless the user opts in to sharing (per request) or the
# operator sets FIBERBROWSER_USAGE_LOG=1 (e.g. to collect Copilot training
# data). They live in the per-user cache, never inside the installed package.
USAGE_LOG_DIR = Path(os.environ.get(
    "FIBERBROWSER_USAGE_LOG_DIR",
    str(Path.home() / ".fiberhmm" / "usage_logs"),
))
SHARED_USAGE_DIR = USAGE_LOG_DIR.parent


def local_usage_logging_enabled() -> bool:
    return os.environ.get("FIBERBROWSER_USAGE_LOG", "").strip().lower() in {"1", "true", "yes", "on"}
SHARED_USAGE_FILE = Path(os.environ.get(
    "FIBERBROWSER_SHARED_USAGE_FILE",
    str(SHARED_USAGE_DIR / "shared_usage.jsonl"),
))


# Path-shaped strings get redacted unconditionally — bam/bigbed/fasta/etc. paths
# leak system layout and lab inventory.
_REDACTED = "<redacted>"
_PATH_PREFIXES = ("/Users/", "/home/", "/private/", "/var/", "/tmp/", "C:\\", "D:\\", "//", "smb://", "\\\\",
                  # remote locations (and any token in their query), whatever the file type
                  "http://", "https://", "s3://", "gs://", "ftp://", "ssh://")
_SENSITIVE_KEYS = {
    "paths", "file", "files", "file_path", "filepath", "folder", "dir", "directory",
    "output", "output_dir", "output_folder", "bam_path", "fasta_path", "gtf_path",
    "bundle_path", "urls", "s3_url", "bucket", "prefix", "endpoint_url",
    "session_name", "user", "username", "home",
    # frontend store names (camelCase keys are snake_cased first): sessionName, fastaPath, ...
    "sessionname", "fastapath", "gtfpath", "bampath", "filepath", "outputdir",
}
# These keys carry either the API route (keep) or a filesystem path (redact)
# depending on the value. Decide per-leaf via _looks_like_path.
_CONDITIONALLY_SENSITIVE_KEYS = {"path", "url"}

# Field names whose VALUES are gene symbols. When the user has not opted into
# sharing gene names in cleartext, we replace these values with a stable
# session-scoped hash (gene_a1b2…) so the model still learns that the same
# gene appeared across multiple actions, but the identity is hidden.
# (All keys lowercased — key_norm lowercases before lookup.)
_GENE_VALUE_KEYS = {
    "gene", "gene_name", "relative_to_gene", "selected_gene",
    # frontend store names (camelCase lowercased)
    "relativegene", "relative_gene", "selectedgene",
}
_GENE_COLLECTION_KEYS = {"selectedgenes", "selected_genes", "genes"}

# External URLs and host paths inside free text (a typed request, a model's
# raw output) are redacted wherever they appear, not just as whole values.
_URL_IN_TEXT = re.compile(r"\b(?:https?|s3|gs|ftp|smb)://\S+", re.IGNORECASE)
# A path may follow a quote, bracket, '=' or ':' (a quoted argument, JSON, key=value).
_PATH_IN_TEXT = re.compile(
    r"(?:(?<=[\s\"'`(\[{<=:,])|^)(?:~/|/Users/|/home/|/private/|/var/|/tmp/|/mnt/|/Volumes/|/data/|/scratch/|[A-Za-z]:[\\/])"
    r"[^\s\"'`)\]}>,]+"
)

# Genomic positions inside text ("chr17:7,661,779-7,687,550", "7661779"):
# comma-grouped numbers and bare numbers of 5+ digits, not part of an
# identifier (ds_123456, cmd-1727170000000) or a decimal.
_COORD_IN_TEXT = re.compile(r"(?<![\w.])(?<![A-Za-z_]-)(\d{1,3}(?:,\d{3})+|\d{5,})(?![\w]|[.,]\d)")


def _bucket_coords_in_text(text: str) -> str:
    def bucket(m: re.Match) -> str:
        raw = m.group(1)
        n = _bucket_coord(int(raw.replace(",", "")))
        return f"{n:,}" if "," in raw else str(n)
    return _COORD_IN_TEXT.sub(bucket, text)


# Private per-session secrets for the pseudonyms. Never written anywhere: the
# shared file must not carry what it would take to reverse its hashes.
_SESSION_SECRETS: dict[str, str] = {}
_SESSION_SECRETS_MAX = 512


def _session_secret(session_id: str) -> str:
    secret = _SESSION_SECRETS.get(session_id)
    if secret is None:
        if len(_SESSION_SECRETS) >= _SESSION_SECRETS_MAX:
            _SESSION_SECRETS.pop(next(iter(_SESSION_SECRETS)))
        secret = secrets.token_hex(16)
        _SESSION_SECRETS[session_id] = secret
    return secret


def _stable_hash(name: str, salt: str, prefix: str) -> str:
    """Per-session stable pseudonym. Same value → same id within a session; the
    real value is unrecoverable without `salt`. Different sessions get different
    hashes so two shared files from the same lab don't link on identity."""
    import hashlib
    digest = hashlib.sha256(f"{salt}:{prefix}:{name}".encode("utf-8")).hexdigest()
    return f"{prefix}_{digest[:6]}"


def _hash_gene(name: str, salt: str) -> str:
    return _stable_hash(name, salt, "gene")


def _hash_motif(name: str, salt: str) -> str:
    return _stable_hash(name, salt, "motif")


# Free-form user-typed labels. We deliberately exclude generic `label` because
# many `label` fields are system-generated (activity-log entries, derived from
# already-hashed gene names) and redacting them loses training signal.
# region_label and color_name are reliably user-typed in our action vocab.
_LABEL_VALUE_KEYS = {"region_label", "color_name",
                     # names the user gives rules, groups, branches, tracks and datasets
                     "new_name", "group_name", "rule_name", "branch_name", "cluster_name",
                     "label_text", "track_label"}
# Collections of things the user names (saved clusterings, footprint groups,
# rules, tracks, capture regions, branches, colormaps): their name/label fields
# are the user's own words, whatever key they sit under.
_USER_NAMED_COLLECTION_KEYS = {
    "savedclusters", "saved_clusters", "footprintgroups", "footprint_groups",
    "peakrules", "peak_rules", "savedtracks", "saved_tracks", "compositetracks",
    "composite_tracks", "orthogonaltracks", "orthogonal_tracks", "catalog",
    "captureregions", "capture_regions", "navigatorregions", "navigator_regions",
    "clusterfeaturerules", "cluster_feature_rules", "analysissortrules",
    "analysis_sort_rules", "analysisfilterrules", "analysis_filter_rules",
    "clustertreenodes", "cluster_tree_nodes", "primersavedprimers", "primer_saved_primers",
    "activecolormap", "active_colormap", "colormaps",
}
_USER_NAME_FIELDS = {"name", "label", "title", "description", "note", "notes"}
# Actions whose `name` is one the user chose (a rule, a group, a branch, an annotation).
_NAMED_ACTION_TYPES = {
    "add_cluster_rule", "add_sort_rule", "add_filter_rule", "add_footprint_group",
    "capture_cluster_branch", "switch_cluster_branch", "rename_cluster_branch",
    "delete_cluster_branch", "toggle_annotation_visibility",
}
# The browser's own default names carry no identity and are kept.
_BUILTIN_NAMES = {"default", "pol ii", "tf", "subnucleosome", "accessibility", "nucleosome",
                  "custom", "new cluster rule", "new filter rule", "new sort rule",
                  "footprint class"}
# Raw model diagnostics (thinking, raw output): free text that can't be
# sanitized reliably, so anonymized exports leave them out.
_RAW_DIAGNOSTIC_KEYS = {"debug", "rawcontent", "raw_content", "thinking"}
# Copilot troubleshooting diagnostics (utils/copilotDiagnostics.ts): their
# messages quote dataset/panel labels ("A3 tumor"), which may not appear in any
# structured field of the same request, so quoted names are redacted outright.
_TROUBLESHOOTING_DIAGNOSTIC_KEYS = {"diagnostics"}
_QUOTED_NAME = re.compile(r'"[^"]{1,200}"')


_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _norm_key(key: Any) -> str:
    """A field name in snake_case: the frontend's camelCase fields (regionLabel,
    regionStart) match the same rules as the backend's snake_case ones."""
    return _CAMEL_BOUNDARY.sub("_", str(key)).lower().replace("-", "_")


def _is_user_label(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and value.strip().lower() not in _BUILTIN_NAMES


def _redact_user_names(value: Any, depth: int = 0) -> Any:
    """Inside a user-named collection: name/label fields -> "<note>"."""
    if depth > 12:
        return value
    if isinstance(value, dict):
        return {k: ("<note>" if str(k).lower() in _USER_NAME_FIELDS and _is_user_label(v)
                    else _redact_user_names(v, depth + 1))
                for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_user_names(item, depth + 1) for item in value]
    return value


def _collect_user_labels(value: Any, found: dict[str, str], depth: int = 0, *, named: bool = False) -> dict[str, str]:
    """User-chosen names (see above) -> "<note>", to replace them in free text too."""
    if depth > 12:
        return found

    def add(name: Any) -> None:
        if _is_user_label(name) and len(name.strip()) >= 2:
            found.setdefault(name.strip(), "<note>")

    if isinstance(value, dict):
        if value.get("type") in _NAMED_ACTION_TYPES:
            add(value.get("name"))
        for key, child in value.items():
            key_norm = _norm_key(key)
            if named and key_norm in _USER_NAME_FIELDS:
                add(child)
            elif key_norm in _LABEL_VALUE_KEYS:
                add(child)
            _collect_user_labels(child, found, depth + 1,
                                 named=named or key_norm in _USER_NAMED_COLLECTION_KEYS)
    elif isinstance(value, list):
        for item in value:
            _collect_user_labels(item, found, depth + 1, named=named)
    return found
# Motif name fields (commands, motif track adds, motif queries).
_MOTIF_VALUE_KEYS = {"motif", "motif_name", "custom_motif_names",
                     # load_jaspar_motifs {names: [...]}, frontend customMotifNames
                     "names", "motif_names", "custommotifnames", "motifnames"}
# Numeric coordinate fields. Bucketed to nearest BUCKET bp to prevent decoding
# a hashed gene back to identity via the public GTF.
_COORD_VALUE_KEYS = {
    "start", "end", "position", "tss", "viewpoint",
    "padding_bp", "tolerance_bp", "width_bp", "offset_bp",
    "relativetss", "relative_tss",  # frontend relativeTSS
    # frontend saved positions (colormap conditions, footprint definitions)
    "region_start", "region_end", "reference_abs_start", "reference_abs_end",
}
_COORD_BUCKET_BP = 1000

# Dataset identifiers and labels — reveal experimental design.
_DATASET_ID_VALUE_KEYS = {"dataset_id"}
_DATASET_ID_LIST_KEYS = {"dataset_ids", "datasetids", "selecteddatasets", "selected_datasets"}
_DATASET_COLLECTION_KEYS = {"datasets"}


def _hash_dataset(name: str, salt: str) -> str:
    return _stable_hash(name, salt, "ds")


def _anonymize_dataset_record(value: Any, salt: str) -> Any:
    if not isinstance(value, dict):
        return value
    out = dict(value)
    for key in ("id", "dataset_id"):
        if isinstance(out.get(key), str) and out[key]:
            out[key] = _hash_dataset(out[key], salt)
    if isinstance(out.get("label"), str) and out["label"]:
        out["label"] = _hash_dataset(out["label"], salt)
    return out


def _bucket_coord(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        try:
            n = int(value)
        except (ValueError, OverflowError):
            return value
        if n < 0:
            return -((-n // _COORD_BUCKET_BP) * _COORD_BUCKET_BP)
        return (n // _COORD_BUCKET_BP) * _COORD_BUCKET_BP
    return value


def _looks_like_path(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    if any(value.startswith(prefix) for prefix in _PATH_PREFIXES):
        return True
    if value.endswith((".bam", ".bai", ".bb", ".bigBed", ".bw", ".bigWig", ".gtf",
                       ".gff", ".bed", ".fa", ".fasta", ".cool", ".mcool")):
        return True
    return False


def _shorten_user_agent(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    lower = value.lower()
    if "mac os" in lower or "darwin" in lower or "macintosh" in lower:
        return "macOS"
    if "windows" in lower:
        return "Windows"
    if "linux" in lower or "x11" in lower:
        return "Linux"
    return "unknown"


# Search routes whose query is a gene or motif name: (route, parameter) -> kind.
_SEARCH_QUERY_PARAMS = {
    ("/api/gene_search", "query"): "gene",
    ("/api/motifs/jaspar/search", "q"): "motif",
}


def _search_query_names(url: str) -> list[tuple[str, str]]:
    """(kind, name) for the gene/motif names searched in an /api/ URL."""
    if not url.startswith("/api/") or "?" not in url:
        return []
    from urllib.parse import parse_qsl
    route, query = url.split("?", 1)
    out = []
    for key, val in parse_qsl(query, keep_blank_values=False):
        kind = _SEARCH_QUERY_PARAMS.get((route, key))
        if kind and val.strip():
            out.append((kind, val.strip()))
    return out


def _scrub_url_query(value: str, *, bucket_coords: bool = False, redact_labels: bool = False,
                     known: Optional[dict[str, str]] = None) -> str:
    """Keep the route, redact filesystem-path-ish query values.

    `/api/load_fasta?path=/Users/me/dm6.fa` -> `/api/load_fasta?path=<redacted>`
    `/api/genes?chrom=2R&start=100&end=200`  -> unchanged unless bucket_coords
    `/api/gene_search?query=TP53`            -> its pseudonym when anonymized
    """
    if "?" not in value:
        return value
    from urllib.parse import unquote
    base, query = value.split("?", 1)
    out_pairs = []
    for chunk in query.split("&"):
        if "=" not in chunk:
            out_pairs.append(chunk)
            continue
        k, v = chunk.split("=", 1)
        decoded = unquote(v.replace("+", " "))
        key_norm = _norm_key(k)
        if redact_labels and (base, k) in _SEARCH_QUERY_PARAMS:
            # A searched gene/motif name: its pseudonym (collected up front), never cleartext.
            name = decoded.strip()
            out_pairs.append(f"{k}={(known or {}).get(name, _REDACTED) if name else ''}")
        elif key_norm in _SENSITIVE_KEYS or _looks_like_path(decoded):
            out_pairs.append(f"{k}={_REDACTED}")
        elif redact_labels and (key_norm in _LABEL_VALUE_KEYS or key_norm == "label") and decoded:
            out_pairs.append(f"{k}=<note>")
        elif bucket_coords and key_norm in _COORD_VALUE_KEYS:
            try:
                bucketed = _bucket_coord(int(decoded))
                out_pairs.append(f"{k}={bucketed}")
            except (ValueError, TypeError):
                out_pairs.append(chunk)
        else:
            out_pairs.append(chunk)
    return f"{base}?{'&'.join(out_pairs)}"


def _anonymize_gene_record(value: Any, salt: str, *, bucket_coords: bool) -> Any:
    """Walk a gene dict: hash the symbol/id fields, bucket the coordinate
    fields (start/end/tss). Other fields (chrom, strand) pass through."""
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for key, child in value.items():
        if key in ("name", "gene_name", "id", "gene_id") and isinstance(child, str) and child:
            out[key] = _hash_gene(child, salt)
        elif bucket_coords and key in ("start", "end", "tss", "position"):
            out[key] = _bucket_coord(child)
        elif bucket_coords and key in _GENE_STRUCTURE_KEYS:
            # Exact exon/CDS/transcript positions would identify the gene
            # against the reference annotation: bucket them like its bounds.
            out[key] = _bucket_gene_structure(child, salt)
        else:
            out[key] = child
    return out


_GENE_STRUCTURE_KEYS = frozenset((
    "exons", "cds", "utrs", "introns", "transcripts", "exon_starts", "exon_ends",
    "exonStarts", "exonEnds", "thick_start", "thick_end", "thickStart", "thickEnd",
))


def _bucket_gene_structure(value: Any, salt: str, depth: int = 0) -> Any:
    if depth > 8:
        return None
    if isinstance(value, dict):
        return _anonymize_gene_record(value, salt, bucket_coords=True)
    if isinstance(value, (list, tuple)):
        return [_bucket_gene_structure(item, salt, depth + 1) for item in value]
    return _bucket_coord(value)


def _collect_identifiers(value: Any, salt: str, found: dict[str, str], depth: int = 0) -> dict[str, str]:
    """Gene, motif and dataset names in structured fields -> their pseudonyms.

    The same names also appear in free text (the typed request, a plan's
    summary and labels, the model's raw output); _anonymize replaces them there
    too, so hashing the structured field isn't undone by the sentence next to it.
    """
    if depth > 12:
        return found

    def add(name: Any, hasher) -> None:
        if isinstance(name, str) and len(name.strip()) >= 2:
            found.setdefault(name.strip(), hasher(name.strip(), salt))

    if isinstance(value, dict):
        for key, child in value.items():
            key_norm = _norm_key(key)
            if key_norm in _GENE_VALUE_KEYS or key_norm in _GENE_COLLECTION_KEYS:
                items = child if isinstance(child, list) else [child]
                for item in items:
                    if isinstance(item, dict):
                        for k in ("name", "gene_name", "id", "gene_id"):
                            add(item.get(k), _hash_gene)
                    else:
                        add(item, _hash_gene)
            elif key_norm in _MOTIF_VALUE_KEYS:
                for item in (child if isinstance(child, list) else [child]):
                    add(item, _hash_motif)
            elif key_norm in _DATASET_ID_VALUE_KEYS or key_norm in _DATASET_ID_LIST_KEYS:
                for item in (child if isinstance(child, list) else [child]):
                    add(item, _hash_dataset)
            elif key_norm in _DATASET_COLLECTION_KEYS:
                records = child.items() if isinstance(child, dict) else enumerate(child if isinstance(child, list) else [])
                for record_key, record in records:
                    if isinstance(child, dict):
                        add(record_key, _hash_dataset)
                    if isinstance(record, dict):
                        for k in ("id", "dataset_id", "label"):
                            add(record.get(k), _hash_dataset)
            _collect_identifiers(child, salt, found, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _collect_identifiers(item, salt, found, depth + 1)
    elif isinstance(value, str):
        # Names searched for (an activity-log /api/gene_search?query=… URL).
        for kind, name in _search_query_names(value):
            add(name, _hash_gene if kind == "gene" else _hash_motif)
    return found


def _identifier_pattern(known: dict[str, str]) -> Optional[re.Pattern]:
    if not known:
        return None
    names = sorted(known, key=len, reverse=True)
    return re.compile(
        r"(?<![A-Za-z0-9_])(" + "|".join(re.escape(n) for n in names) + r")(?![A-Za-z0-9_])",
        re.IGNORECASE,
    )


def _scrub_text(value: str, known: Optional[dict[str, str]], pattern: Optional[re.Pattern],
                *, bucket_coords: bool = False) -> str:
    """Redact URLs and host paths inside a string; swap known names for pseudonyms;
    bucket positions when coordinates are bucketed."""
    text = _URL_IN_TEXT.sub(_REDACTED, value)
    text = _PATH_IN_TEXT.sub(_REDACTED, text)
    if pattern is not None and known:
        lower = {k.lower(): v for k, v in known.items()}
        text = pattern.sub(lambda m: lower.get(m.group(1).lower(), m.group(1)), text)
    if bucket_coords:
        text = _bucket_coords_in_text(text)
    return text


def _anonymize_dataset_record(value: Any, salt: str, *, hash_identifiers: bool,
                              bucket_coords: bool, redact_labels: bool,
                              known: Optional[dict[str, str]] = None,
                              pattern: Optional[re.Pattern] = None) -> Any:
    """Hash dataset id/label, redact paths, recurse into anything else."""
    if not isinstance(value, dict):
        return _anonymize(value, hash_identifiers=hash_identifiers, bucket_coords=bucket_coords,
                          redact_labels=redact_labels, salt=salt, known=known, pattern=pattern)
    out: dict[str, Any] = {}
    for key, child in value.items():
        if key in ("id", "dataset_id") and isinstance(child, str) and child:
            out[key] = _hash_dataset(child, salt)
        elif key == "label" and isinstance(child, str) and child:
            out[key] = _hash_dataset(child, salt)
        else:
            out[key] = _anonymize(
                child,
                hash_identifiers=hash_identifiers,
                bucket_coords=bucket_coords,
                redact_labels=redact_labels,
                salt=salt,
                known=known,
                pattern=pattern,
            )
    return out


def _anonymize(
    value: Any,
    depth: int = 0,
    *,
    hash_identifiers: bool = True,
    bucket_coords: bool = True,
    redact_labels: bool = True,
    salt: str = "",
    known: Optional[dict[str, str]] = None,
    pattern: Optional[re.Pattern] = None,
) -> Any:
    """Walk a session payload and apply the configured privacy posture.

    Defaults are "real privacy" (B):
      - gene, motif and dataset names → stable per-session hashes, in their
        own fields and wherever they recur in free text (`known`/`pattern`
        from _collect_identifiers)
      - free-form labels (region_label, color_name) → "<note>"
      - numeric coordinates (start/end/position/tss/...) → bucketed to 1 kb
      - paths/files/URLs → redacted unconditionally, inside text too
    Setting all three flags False yields "share full details" (C).
    """
    if depth > 12:
        return _REDACTED
    names = known if hash_identifiers else None
    names_re = pattern if hash_identifiers else None

    def recurse(child: Any, next_depth: int) -> Any:
        return _anonymize(child, next_depth, hash_identifiers=hash_identifiers,
                          bucket_coords=bucket_coords, redact_labels=redact_labels,
                          salt=salt, known=known, pattern=pattern)

    def scrub(text: str) -> str:
        return _scrub_text(text, names, names_re, bucket_coords=bucket_coords)

    if isinstance(value, dict):
        if redact_labels and value.get("type") in _NAMED_ACTION_TYPES and _is_user_label(value.get("name")):
            value = {**value, "name": "<note>"}
        # An activity entry for a store change ({label: "change:<field>",
        # details: {value}}): the value is that field's, so it's treated as if
        # stored under the field's own name (sessionName, relativeTSS, ...).
        label = value.get("label")
        details = value.get("details")
        if (isinstance(label, str) and label.startswith("change:") and isinstance(details, dict)
                and "value" in details):
            field = label[len("change:"):]
            safe_value = recurse({field: details["value"]}, depth + 1).get(field)
            safe_details = {k: recurse(v, depth + 2) for k, v in details.items() if k != "value"}
            out = {k: recurse(v, depth + 1) for k, v in value.items() if k != "details"}
            out["details"] = {**safe_details, "value": safe_value}
            return out
        out: dict[str, Any] = {}
        for key, child in value.items():
            key_norm = _norm_key(key)
            if key_norm in _SENSITIVE_KEYS:
                out[key] = _REDACTED if child else child
                continue
            if key_norm == "user_agent":
                out[key] = _shorten_user_agent(child)
                continue
            if redact_labels and key_norm in _RAW_DIAGNOSTIC_KEYS:
                out[key] = _REDACTED if child else child
                continue
            if redact_labels and key_norm in _TROUBLESHOOTING_DIAGNOSTIC_KEYS and isinstance(child, list):
                out[key] = [
                    recurse({**item, "message": _QUOTED_NAME.sub('"<name>"', item["message"])}
                            if isinstance(item, dict) and isinstance(item.get("message"), str) else item,
                            depth + 1)
                    for item in child
                ]
                continue
            if redact_labels and key_norm in _USER_NAMED_COLLECTION_KEYS:
                out[key] = recurse(_redact_user_names(child), depth + 1)
                continue
            if hash_identifiers and key_norm in _GENE_VALUE_KEYS:
                if isinstance(child, str) and child:
                    out[key] = _hash_gene(child, salt)
                elif isinstance(child, dict):
                    out[key] = _anonymize_gene_record(child, salt, bucket_coords=bucket_coords)
                else:
                    out[key] = child
                continue
            if hash_identifiers and key_norm in _GENE_COLLECTION_KEYS and isinstance(child, list):
                out[key] = [_hash_gene(item, salt) if isinstance(item, str) and item
                            else _anonymize_gene_record(item, salt, bucket_coords=bucket_coords)
                            for item in child]
                continue
            if hash_identifiers and key_norm in _MOTIF_VALUE_KEYS:
                if isinstance(child, str) and child:
                    out[key] = _hash_motif(child, salt)
                elif isinstance(child, list):
                    out[key] = [_hash_motif(c, salt) if isinstance(c, str) and c else c
                                for c in child]
                else:
                    out[key] = recurse(child, depth + 1)
                continue
            if hash_identifiers and key_norm in _DATASET_ID_VALUE_KEYS:
                if isinstance(child, str) and child:
                    out[key] = _hash_dataset(child, salt)
                else:
                    out[key] = child
                continue
            if hash_identifiers and key_norm in _DATASET_ID_LIST_KEYS and isinstance(child, list):
                out[key] = [_hash_dataset(c, salt) if isinstance(c, str) and c else c
                            for c in child]
                continue
            if hash_identifiers and key_norm in _DATASET_COLLECTION_KEYS and isinstance(child, (list, dict)):
                record = lambda item: _anonymize_dataset_record(  # noqa: E731
                    item, salt, hash_identifiers=hash_identifiers, bucket_coords=bucket_coords,
                    redact_labels=redact_labels, known=known, pattern=pattern)
                if isinstance(child, dict):
                    # {dataset_id: record}: the keys are identifiers too.
                    out[key] = {_hash_dataset(str(k), salt): record(v) for k, v in child.items()}
                else:
                    out[key] = [record(item) for item in child]
                continue
            if redact_labels and key_norm in _LABEL_VALUE_KEYS and isinstance(child, str) and child:
                out[key] = "<note>"
                continue
            if bucket_coords and key_norm in _COORD_VALUE_KEYS:
                out[key] = _bucket_coord(child)
                continue
            if key_norm in _CONDITIONALLY_SENSITIVE_KEYS and isinstance(child, str):
                # API routes win — keep the route and scrub only path-like
                # query values. _looks_like_path is checked second because
                # URL-encoded query strings can end in .bam/.fa and falsely
                # match the path heuristic for the whole URL.
                if child.startswith("/api/"):
                    out[key] = scrub(_scrub_url_query(child, bucket_coords=bucket_coords,
                                                      redact_labels=redact_labels, known=known))
                elif _looks_like_path(child):
                    out[key] = _REDACTED
                else:
                    out[key] = scrub(child)
                continue
            out[key] = recurse(child, depth + 1)
        return out
    if isinstance(value, list):
        return [recurse(item, depth + 1) for item in value]
    if _looks_like_path(value):
        return _REDACTED
    if isinstance(value, str):
        return scrub(value)
    return value

from state.dependencies import get_state
from services.natural_language_commands import (
    build_copilot_api_capabilities,
    build_copilot_system_prompt,
    plan_natural_language_command,
    stream_natural_language_command,
    _user_message,
    list_ollama_models,
    probe_mlx_server,
    resolve_ollama_model,
    COPILOT_DEFAULT_MODEL,
)
import services.natural_language_commands as nlc
from services.copilot_agent import agent_step, COPILOT_TOOLS, COPILOT_AGENT_MAX_STEPS

def _copilot_included_here() -> None:
    """Every Copilot route refuses, with a plain reason, on a server that leaves
    the Copilot out (FiberBrowser.app: --no-copilot / FIBERBROWSER_COPILOT=off)."""
    from services.runtime import COPILOT_NOT_INCLUDED_MESSAGE, copilot_included
    if not copilot_included():
        raise HTTPException(status_code=403, detail=COPILOT_NOT_INCLUDED_MESSAGE)


router = APIRouter(tags=["natural-language"], dependencies=[Depends(_copilot_included_here)])


class NaturalLanguagePlanRequest(BaseModel):
    text: str
    context: Optional[dict[str, Any]] = None
    model: Optional[str] = None
    previous_turns: Optional[list[dict[str, Any]]] = None
    # Troubleshooting context the browser computes (utils/copilotDiagnostics.ts).
    diagnostics: Optional[list[dict[str, Any]]] = None
    raw_state: Optional[dict[str, Any]] = None


@router.post("/api/nl/stream")
async def stream_browser_command(req: NaturalLanguagePlanRequest, request: Request, state=Depends(get_state)):
    """Stream a Copilot plan as NDJSON events.

    Each line is a JSON object with an `event` field: start, thinking, token,
    raw, plan, warning, error, done. The frontend renders thinking/token live
    and runs the validated plan only after the user confirms.
    """
    generator = stream_natural_language_command(
        state,
        req.text,
        req.context,
        app=request.app,
        model=req.model,
        previous_turns=req.previous_turns,
        diagnostics=req.diagnostics,
        raw_state=req.raw_state,
    )
    # X-Accel-Buffering: no disables proxy buffering (nginx-style). Cache-
    # Control: no-store stops any intermediary from holding events. Without
    # these, thinking deltas could arrive in one big block at the end of the
    # stream instead of progressively, defeating the "show your work live"
    # UX users expect from a streaming planner.
    return StreamingResponse(
        generator,
        media_type="application/x-ndjson",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-store",
        },
    )


@router.post("/api/nl/plan")
async def plan_browser_command(req: NaturalLanguagePlanRequest, request: Request, state=Depends(get_state)):
    """Non-streaming convenience endpoint for clients that don't want NDJSON."""
    # The planner waits on the model over HTTP; off the event loop so the
    # browser's other requests keep flowing meanwhile.
    return await asyncio.to_thread(
        plan_natural_language_command,
        state,
        req.text,
        req.context,
        app=request.app,
        model=req.model,
        previous_turns=req.previous_turns,
        diagnostics=req.diagnostics,
        raw_state=req.raw_state,
    )


@router.get("/api/nl/capabilities")
async def get_copilot_capabilities(request: Request):
    """Return the safe API catalog, the cached system prompt, and Ollama status."""
    return build_copilot_api_capabilities(request.app)


class AgentStepRequest(BaseModel):
    """One iteration of the agentic tool-call loop.

    The frontend maintains the conversation thread. On each turn it posts the
    full message list (including any prior tool calls + tool results) and gets
    back the next assistant message. If the message has tool_calls, the
    frontend executes each via the existing browser-action executor, appends
    a tool-role message with the result, and calls again. When the assistant
    returns content with no tool_calls (or calls `respond_to_user`), the loop
    stops.
    """
    messages: list[dict[str, Any]]
    model: Optional[str] = None
    context: Optional[dict[str, Any]] = None
    text: Optional[str] = None  # initial user request, if messages is just system+user
    previous_turns: Optional[list[dict[str, Any]]] = None
    diagnostics: Optional[list[dict[str, Any]]] = None
    raw_state: Optional[dict[str, Any]] = None


@router.post("/api/nl/agent_step")
async def agent_step_endpoint(req: AgentStepRequest, request: Request, state=Depends(get_state)):
    """Run one step of the agentic tool-call loop. The frontend drives the loop."""
    # If frontend sends only the first turn (text + context), build the messages here.
    messages = list(req.messages or [])
    if not messages and req.text:
        system_prompt = build_copilot_system_prompt(request.app)
        user_msg = _user_message(state, req.text, req.context, previous_turns=req.previous_turns,
                                 diagnostics=req.diagnostics, raw_state=req.raw_state)
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ]

    # Resolve model id per backend. (Probes and the model call block on HTTP:
    # run them off the event loop.)
    if nlc.COPILOT_BACKEND == "mlx":
        mlx_probe = await asyncio.to_thread(probe_mlx_server, timeout=4.0)
        available = list(mlx_probe["models"])
        if not available:
            if mlx_probe["reachable"]:
                return {"success": False, "error": "mlx_lm.server is reachable but has not reported a loaded model yet"}
            return {"success": False, "error": "mlx_lm.server not reachable"}
        model = req.model or available[0]
        if model not in available:
            model = available[0]
    else:
        available = await asyncio.to_thread(list_ollama_models, timeout=1.0)
        if not available:
            return {"success": False, "error": "Ollama not reachable"}
        requested = req.model or COPILOT_DEFAULT_MODEL
        model, _ = resolve_ollama_model(requested, available)

    try:
        assistant = await asyncio.to_thread(agent_step, model=model, messages=messages)
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}

    return {
        "success": True,
        "model": model,
        "assistant": assistant,
        "max_steps": COPILOT_AGENT_MAX_STEPS,
    }


@router.get("/api/nl/agent_tools")
async def get_agent_tools():
    """Return the tool schema the frontend needs to render / pre-validate."""
    return {"tools": COPILOT_TOOLS, "max_steps": COPILOT_AGENT_MAX_STEPS}


class CopilotSetupRequest(BaseModel):
    model_id: Optional[str] = None


@router.post("/api/nl/setup")
async def setup_copilot_endpoint(req: CopilotSetupRequest):
    """First-run / on-demand model install: download from HF + start mlx_lm.server.

    Idempotent — if a server is already running on the configured port, this
    just rebinds env vars and returns. Otherwise it downloads the chosen tier
    (or auto-picks based on host RAM) and launches the model server as a
    managed child process.
    """
    from types import SimpleNamespace
    from services.copilot_lifecycle import setup_copilot, _pick_model, last_setup_error, copilot_setup_message
    args = SimpleNamespace(
        copilot="mlx",
        copilot_model=req.model_id,
        copilot_port=int(os.environ.get("FIBERBROWSER_COPILOT_MLX_PORT", "8080")),
    )
    try:
        # Downloads and waits for the model server: off the event loop.
        ready = await asyncio.to_thread(setup_copilot, args)
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}
    if not ready:
        err = last_setup_error()
        return {"success": False,
                "error": err.get("message") or copilot_setup_message(args.copilot),
                "log_tail": err.get("log_tail")}
    picked = _pick_model(override_id=req.model_id)
    return {
        "success": True,
        "model": (picked or {}).get("id"),
        "message": f"Loaded {(picked or {}).get('label', 'model')}",
    }


@router.post("/api/nl/download")
async def start_copilot_download_endpoint(req: CopilotSetupRequest):
    """Begin a consented model download in the background (non-blocking).

    Returns immediately with the initial status; the frontend polls
    /api/nl/download_status for byte-level progress and the auto-start that
    follows. This is how the panel's "Download & start" works — startup never
    downloads on its own.
    """
    from services.copilot_lifecycle import start_background_download
    port = int(os.environ.get("FIBERBROWSER_COPILOT_MLX_PORT", "8080"))
    status = start_background_download(model_id=req.model_id, copilot_port=port)
    return {"success": status.get("state") != "error", **status}


@router.get("/api/nl/doctor")
async def copilot_doctor_endpoint(network: bool = True):
    """The Copilot setup check ("Check setup" in the panel; `browser.py --copilot-doctor`)."""
    from services.copilot_doctor import run_doctor
    return await asyncio.to_thread(run_doctor, network=network)


@router.get("/api/nl/download_status")
async def copilot_download_status_endpoint():
    """Live status of an in-app model download (bytes_done/bytes_total/pct/state)."""
    from services.copilot_lifecycle import get_download_status
    return get_download_status()


class SessionLogRequest(BaseModel):
    """Browser session dump used to build organic-usage training data."""
    session_id: Optional[str] = None
    started_at: Optional[float] = None
    snapshots: Optional[list[dict[str, Any]]] = None
    command_history: Optional[list[dict[str, Any]]] = None
    activity_log: Optional[list[dict[str, Any]]] = None
    metadata: Optional[dict[str, Any]] = None
    share: Optional[bool] = False  # opt-in: also append anonymized to shared file
    # A user-initiated save ("Save session log", Jupyter) always writes;
    # automatic saves only write when logging is enabled or shared.
    explicit: Optional[bool] = False
    # Privacy posture for the shared file. Default = real privacy:
    #   - gene + motif names hashed per session (stable within a session)
    #   - free-form labels redacted to "<note>"
    #   - coordinates bucketed to 1 kb so coords + public GTF can't decode genes
    # When true, all three relax to cleartext — strictly more informative for
    # training but reveals which genes / motifs / regions the lab is studying.
    share_full_details: Optional[bool] = False


@router.post("/api/nl/log_session")
async def log_session(req: SessionLogRequest):
    """Persist a browser session dump for offline distillation into training data.

    The frontend posts on unload (via sendBeacon) and on a manual "Save session
    log" action. Files are gitignored — they may contain user-specific gene
    names / dataset paths and should be filtered before being shared.
    """
    if not (req.explicit or req.share or local_usage_logging_enabled()):
        return {"success": True, "skipped": True, "reason": "usage logging is off"}
    USAGE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    session_id = (req.session_id or uuid.uuid4().hex)[:24]
    timestamp = int(req.started_at or time.time())
    safe_id = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in session_id)
    filename = f"session_{timestamp}_{safe_id}.json"
    path = USAGE_LOG_DIR / filename
    payload = {
        "session_id": session_id,
        "started_at": req.started_at,
        "logged_at": time.time(),
        "snapshots": req.snapshots or [],
        "command_history": req.command_history or [],
        "activity_log": req.activity_log or [],
        "metadata": req.metadata or {},
        "share": bool(req.share),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    shared_path: Optional[str] = None
    if req.share:
        full_details = bool(req.share_full_details)
        # Pseudonyms come from a private per-session secret, never the exported
        # session id: with the salt in the file, hashing ~20k gene symbols
        # would undo them.
        salt = _session_secret(session_id)
        known = _collect_identifiers(payload, salt, {}) if not full_details else {}
        if not full_details:
            # The user's own names (rules, groups, saved clusterings, ...) wherever they recur.
            for name, note in _collect_user_labels(payload, {}).items():
                known.setdefault(name, note)
        shared = _anonymize(
            {**payload, "session_id": _stable_hash(session_id, salt, "session")},
            hash_identifiers=not full_details,
            bucket_coords=not full_details,
            redact_labels=not full_details,
            salt=salt,
            known=known,
            pattern=_identifier_pattern(known),
        )
        SHARED_USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with SHARED_USAGE_FILE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(shared, ensure_ascii=False) + "\n")
        shared_path = str(SHARED_USAGE_FILE)

    return {
        "success": True,
        "path": str(path.relative_to(USAGE_LOG_DIR.parent)),
        "snapshot_count": len(payload["snapshots"]),
        "command_count": len(payload["command_history"]),
        "shared_path": shared_path,
    }


@router.get("/api/nl/share_status")
async def share_status():
    """Report the path, line count, and size of the shared usage file."""
    file = SHARED_USAGE_FILE
    if not file.exists():
        return {
            "success": True,
            "local_logging": local_usage_logging_enabled(),
            "absolute_path": str(file),
            "exists": False,
            "line_count": 0,
            "size_bytes": 0,
        }
    line_count = 0
    with file.open("r", encoding="utf-8") as fh:
        for _ in fh:
            line_count += 1
    return {
        "success": True,
        "local_logging": local_usage_logging_enabled(),
        "absolute_path": str(file),
        "exists": True,
        "line_count": line_count,
        "size_bytes": file.stat().st_size,
    }


@router.post("/api/nl/share_clear")
async def share_clear():
    """Delete the shared usage file (user-initiated wipe)."""
    if SHARED_USAGE_FILE.exists():
        SHARED_USAGE_FILE.unlink()
    return {"success": True}


USAGE_UPLOAD_URL = os.environ.get("FIBERBROWSER_USAGE_UPLOAD_URL", "").strip()
USAGE_UPLOAD_TOKEN = os.environ.get("FIBERBROWSER_USAGE_UPLOAD_TOKEN", "").strip()


@router.get("/api/nl/share_upload_status")
async def share_upload_status():
    """Tell the frontend whether an upload destination is configured.

    Returns the URL host (not the full URL with secrets) and whether a token
    is set, so the panel can show/hide the "Send to maintainer" button.
    """
    if not USAGE_UPLOAD_URL:
        return {"configured": False}
    try:
        from urllib.parse import urlparse
        parsed = urlparse(USAGE_UPLOAD_URL)
        host = f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else USAGE_UPLOAD_URL
    except Exception:
        host = USAGE_UPLOAD_URL
    return {
        "configured": True,
        "host": host,
        "has_token": bool(USAGE_UPLOAD_TOKEN),
    }


@router.post("/api/nl/share_send")
async def share_send():
    """POST the locally-accumulated anonymized usage file to the maintainer's
    configured receiver. Bearer-token auth, opt-in by the tester.
    """
    if not USAGE_UPLOAD_URL:
        return {"success": False, "error": "FIBERBROWSER_USAGE_UPLOAD_URL is not set"}
    if not SHARED_USAGE_FILE.exists() or SHARED_USAGE_FILE.stat().st_size == 0:
        return {"success": False, "error": "No usage data to send yet — toggle 'Share anonymized usage' and use the browser first."}
    import urllib.request
    import urllib.error
    body = SHARED_USAGE_FILE.read_bytes()
    headers = {"Content-Type": "application/x-ndjson"}
    if USAGE_UPLOAD_TOKEN:
        headers["Authorization"] = f"Bearer {USAGE_UPLOAD_TOKEN}"
    request = urllib.request.Request(
        USAGE_UPLOAD_URL,
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
            response_body = response.read().decode("utf-8", errors="replace")[:400]
    except urllib.error.HTTPError as exc:
        return {"success": False, "error": f"HTTP {exc.code}: {exc.reason}"}
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}
    return {
        "success": 200 <= status < 300,
        "status_code": status,
        "response": response_body,
        "bytes_sent": len(body),
        "lines_sent": body.count(b"\n"),
    }


@router.get("/api/nl/probe_backends")
async def probe_backends():
    """Tell the panel which Copilot backends are currently reachable.

    Used to surface a one-click "Switch to MLX" when the user is in Ollama
    mode but an mlx_lm.server is running, or vice versa.
    """
    mlx_probe = probe_mlx_server(timeout=2.0)
    return {
        "current": nlc.COPILOT_BACKEND,
        "mlx_reachable": bool(mlx_probe["reachable"]),
        "mlx_models": list(mlx_probe["models"]),
        "ollama_reachable": bool(list_ollama_models(timeout=0.5)),
    }


class FeedbackRequest(BaseModel):
    """User feedback on a generated plan. Free-text comment is alpha-only;
    once we have enough signal we'll likely keep thumbs only."""
    rating: str  # 'up' | 'down'
    comment: Optional[str] = ""
    prompt: Optional[str] = ""
    summary: Optional[str] = None
    planner: Optional[str] = None
    actions: Optional[list] = None
    thinking: Optional[str] = None
    context: Optional[dict] = None


@router.post("/api/nl/feedback")
async def submit_feedback(req: FeedbackRequest):
    """Append a feedback record to data/copilot_dataset/usage_logs/feedback.jsonl.

    Fire-and-forget endpoint for the Copilot panel's thumbs-up/down +
    free-text feedback row. distill_session_logs.py picks these up alongside
    the regular session logs when building the next training round.

    No anonymization here — feedback is dev-only signal during alpha. The
    file is gitignored along with the rest of usage_logs/.
    """
    if req.rating not in ("up", "down"):
        return {"success": False, "error": "rating must be 'up' or 'down'"}
    USAGE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": time.time(),
        "rating": req.rating,
        "comment": (req.comment or "").strip(),
        "prompt": req.prompt or "",
        "summary": req.summary,
        "planner": req.planner,
        "actions": req.actions or [],
        "thinking": req.thinking,
        "context": req.context or {},
    }
    path = USAGE_LOG_DIR / "feedback.jsonl"
    line = json.dumps(record, ensure_ascii=False) + "\n"
    # Append-only — concurrent writes from multiple browser tabs are rare
    # but harmless because each write is one JSON line.
    with open(path, "a", encoding="utf-8") as fp:
        fp.write(line)
    return {"success": True, "path": str(path)}


class SetBackendRequest(BaseModel):
    backend: str  # 'mlx' | 'ollama'


@router.post("/api/nl/set_backend")
async def set_backend_endpoint(req: SetBackendRequest):
    """Switch the active Copilot backend at runtime — no process restart."""
    from services.natural_language_commands import set_backend
    if req.backend not in ("mlx", "ollama"):
        return {"success": False, "error": "backend must be 'mlx' or 'ollama'"}
    set_backend(req.backend)
    return {"success": True, "current": req.backend}


@router.post("/api/nl/share_reveal")
async def share_reveal():
    """Open the parent folder of the shared usage file in Finder/Explorer."""
    import subprocess
    target = SHARED_USAGE_FILE if SHARED_USAGE_FILE.exists() else SHARED_USAGE_FILE.parent
    target.parent.mkdir(parents=True, exist_ok=True)
    from services import wsl_interop
    try:
        wsl_argv = wsl_interop.reveal_argv(str(target)) if wsl_interop.is_wsl() else None
        if wsl_argv:  # the Windows app (WSL): Explorer
            subprocess.Popen(wsl_argv, cwd=wsl_interop.windows_cwd(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "darwin":
            cmd = ["open", "-R", str(target)] if SHARED_USAGE_FILE.exists() else ["open", str(target.parent)]
            subprocess.Popen(cmd)
        elif os.name == "posix":
            subprocess.Popen(["xdg-open", str(target if target.is_dir() else target.parent)])
        elif os.name == "nt":
            subprocess.Popen(["explorer", "/select,", str(target)])
        else:
            return {"success": False, "error": "unsupported platform"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
    return {"success": True, "absolute_path": str(target)}
