"""What FiberBrowser opens: one list, shared with the frontend.

The list lives in ``browser/frontend/src/data/supportedFiles.json`` (shipped
in the wheel with the rest of ``src/data``), so the open dialogs' filters, the
page's file dispatch and these backend checks can't disagree.

Index files (``.bai``, ``.csi``, ``.pbi``, ``.fai``, ``.tbi``, ...) are never
opened on their own: chosen together with their main file they are used as
they are (an index next to its BAM is not a mistake); chosen alone they get a
message naming the file to open instead.
"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
from functools import lru_cache
from typing import Iterable, Optional

_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "src", "data",
                     "supportedFiles.json")


@lru_cache(maxsize=1)
def spec() -> dict:
    with open(_FILE, encoding="utf-8") as handle:
        return json.load(handle)


def _name(path: str) -> str:
    """The lower-case file name of a path or URL (a URL's query is not part of it)."""
    text = str(path or "")
    if re.match(r"^[a-z][a-z0-9+.-]*://", text, re.I):
        text = urllib.parse.urlparse(text).path
    return os.path.basename(text.rstrip("/\\").replace("\\", "/")).lower()


def _without_query(path: str) -> str:
    """A URL without its query (a signed link's index has its own signature)."""
    text = str(path or "")
    return re.split(r"[?#]", text, maxsplit=1)[0] if re.match(r"^[a-z][a-z0-9+.-]*://", text, re.I) else text


def display_name(path: str) -> str:
    """A file's name for messages: never a URL's query (it can hold a signature)."""
    bare = _without_query(path).rstrip("/\\")
    return os.path.basename(bare.replace("\\", "/")) or bare


def _longest(name: str, suffixes: Iterable[str]) -> Optional[str]:
    best = None
    for suffix in suffixes:
        if name.endswith(suffix) and len(name) > len(suffix) and (best is None or len(suffix) > len(best)):
            best = suffix
    return best


def group_of(path: str) -> Optional[dict]:
    """The format group a file belongs to (None: an index, unsupported or unknown)."""
    name = _name(path)
    if sidecar_rule(path) is not None:
        return None
    best, best_len = None, 0
    for group in spec()["groups"]:
        suffix = _longest(name, group["suffixes"])
        if suffix and len(suffix) > best_len:
            best, best_len = group, len(suffix)
    return best


def is_dataset(path: str) -> bool:
    group = group_of(path)
    return bool(group and group.get("opens") == "dataset")


def sidecar_rule(path: str) -> Optional[dict]:
    name = _name(path)
    for rule in spec()["sidecars"]:
        if name.endswith(rule["suffix"]) and len(name) > len(rule["suffix"]):
            return rule
    return None


def is_sidecar(path: str) -> bool:
    return sidecar_rule(path) is not None


def is_coordinate_index(path: str) -> bool:
    """A coordinate index (BAI, CSI, CRAI, tabix): one a remote file can be opened with.
    A PacBio ``.pbi`` is a companion, not one (htslib can't use it as ``##idx##``)."""
    rule = sidecar_rule(path)
    return bool(rule and rule.get("coordinate_index"))


def sidecar_main_candidates(path: str) -> list[str]:
    """The files an index can belong to: ``x.bam.bai`` -> ``x.bam``; ``x.bai`` -> ``x.bam``."""
    rule = sidecar_rule(path)
    if rule is None:
        return []
    bare = _without_query(path)
    stem = bare[: -len(rule["suffix"])]
    out: list[str] = []
    if _longest(_name(stem), rule["for"]) is not None:
        out.append(stem)          # x.bam.bai -> x.bam
    for main_suffix in rule["for"]:
        out.append(stem + main_suffix)  # x.bai -> x.bam (samtools' other naming)
    return out


def not_supported_reason(path: str) -> Optional[str]:
    name = _name(path)
    best, best_len = None, 0
    for entry in spec().get("not_supported", []):
        if name.endswith(entry["suffix"]) and len(entry["suffix"]) > best_len:
            best, best_len = entry["why"], len(entry["suffix"])
    return best


def _same_file(a: str, b: str) -> bool:
    a, b = _without_query(a), _without_query(b)
    if a == b:
        return True
    if re.match(r"^[a-z][a-z0-9+.-]*://", a, re.I) or re.match(r"^[a-z][a-z0-9+.-]*://", b, re.I):
        return False  # URLs: case-sensitive keys, compared as they are
    # Local: one separator style, no ./ segments (Z:\\d\\x.bam is Z:/d/x.bam).
    def key(path: str) -> str:
        return os.path.normcase(os.path.normpath(os.path.abspath(path.replace("\\", "/"))))
    return key(a) == key(b)


def attach_remote_indexes(mains: list[str], indexes: list[str]) -> list[str]:
    """A remote BAM chosen with its own index URL (e.g. separately signed) opens
    with it, in htslib's ``bam##idx##index`` form; local indexes need nothing.
    Only a coordinate index (BAI/CSI) is used so: a ``.pbi`` chosen with it is not."""
    out = list(mains)
    for index in indexes:
        if not re.match(r"^https?://", index, re.I) or not is_coordinate_index(index):
            continue
        for i, main in enumerate(out):
            if "##idx##" in main or not re.match(r"^https?://", main, re.I):
                continue
            if any(_same_file(candidate, main) for candidate in sidecar_main_candidates(index)):
                out[i] = f"{main}##idx##{index}"
                break
    return out


def sidecar_message(path: str) -> str:
    """Why an index chosen on its own wasn't opened, and what to open instead."""
    rule = sidecar_rule(path) or {"label": "index", "for": []}
    base = display_name(path)
    mains = sidecar_main_candidates(path)
    main = next((m for m in mains if os.path.isfile(m)), mains[0] if mains else None)
    target = display_name(main) if main else "its main file"
    return (f"{base}: this is a {rule['label']} file, not a file to open on its own. "
            f"Open {target} instead; FiberBrowser uses the index next to it automatically.")


def partition_sidecars(paths: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Split a selection into (files to open, indexes used with them, messages).

    An index whose main file is also selected is dropped silently; an index
    chosen without its main file gets a message (``sidecar_message``)."""
    mains = [p for p in paths if not is_sidecar(p)]
    used, messages = [], []
    for path in paths:
        if not is_sidecar(path):
            continue
        if any(_same_file(candidate, main) for candidate in sidecar_main_candidates(path) for main in mains):
            used.append(path)
        else:
            messages.append(sidecar_message(path))
    return mains, used, messages


def not_openable_message(path: str, expected: str = "dataset") -> str:
    """A specific reason a file can't be opened (as a dataset, unless ``expected`` says otherwise)."""
    base = display_name(path)
    if is_sidecar(path):
        return sidecar_message(path)
    reason = not_supported_reason(path)
    if reason:
        return f"{base}: {reason}."
    group = group_of(path)
    if group is not None and expected == "dataset" and group.get("opens") != "dataset":
        return (f"{base}: a {group['label']} file is not a dataset; open it with Load File "
                "(or drop it on the window) and it is added as what it is.")
    return f"{base}: not a file type FiberBrowser opens. Supported: {supported_summary()}."


def supported_summary(picker: str = "open") -> str:
    labels = [group["label"] for group in picker_groups(picker)]
    return "; ".join(labels)


def picker_groups(picker: str) -> list[dict]:
    ids = spec()["pickers"].get(picker)
    if ids is None:
        return []
    by_id = {group["id"]: group for group in spec()["groups"]}
    return [by_id[i] for i in ids if i in by_id]


def has_picker(picker: str) -> bool:
    return picker in spec()["pickers"]


def dialog_filters(picker: str) -> list[tuple[str, list[str]]]:
    """[(label, suffixes)]: "Supported files" (every group), each group, then all files ([])."""
    groups = picker_groups(picker)
    if not groups:
        return []
    every: list[str] = []
    for group in groups:
        every.extend(s for s in group["suffixes"] if s not in every)
    out = [("Supported files", every)]
    if len(groups) > 1:
        out.extend((group["label"], list(group["suffixes"])) for group in groups)
    out.append(("All files", []))
    return out


def windows_filter(picker: str) -> Optional[str]:
    """A WinForms OpenFileDialog filter string, or None when the picker has no list."""
    parts = []
    for label, suffixes in dialog_filters(picker):
        pattern = ";".join(f"*{s}" for s in suffixes) if suffixes else "*.*"
        parts.append(f"{label}|{pattern}")
    return "|".join(parts) or None


def zenity_filters(picker: str) -> Optional[list[str]]:
    filters = []
    for label, suffixes in dialog_filters(picker):
        patterns = " ".join(f"*{s}" for s in suffixes) if suffixes else "*"
        filters.append(f"--file-filter={label} | {patterns}")
    return filters or None


def tk_filetypes(picker: str) -> Optional[list[tuple[str, str]]]:
    types = []
    for label, suffixes in dialog_filters(picker):
        types.append((label, " ".join(f"*{s}" for s in suffixes) if suffixes else "*"))
    return types or None


def mac_file_types(picker: str) -> list[str]:
    """The extensions macOS's ``choose file ... of type`` allows for a picker
    ("Supported files"), [] for no filter. macOS matches a name's last
    extension only (``.bed.gz`` -> ``gz``). The dialog has no "All files"
    switch, so a motif matrix (``.txt``, which Load File opens) is allowed too."""
    filters = dialog_filters(picker)
    if not filters or not filters[0][1]:
        return []
    exts: list[str] = []
    suffixes = list(filters[0][1])
    if any(group["id"] == "motifs" for group in picker_groups(picker)):
        suffixes.append(".txt")
    for suffix in suffixes:
        last = suffix.rsplit(".", 1)[-1]
        if re.fullmatch(r"\w+", last) and last not in exts:
            exts.append(last)
    return exts


def pywebview_file_types(picker: str) -> tuple[str, ...]:
    """pywebview's ``file_types`` ('Label (*.a;*.b)'). Its labels allow only letters,
    digits and spaces, and macOS matches only a name's last extension, so
    ``.bed.gz`` becomes ``*.gz`` and ``.fiberlayers.bb`` is already ``*.bb``."""
    out = []
    for label, suffixes in dialog_filters(picker):
        # "Fiber-seq BigBed (bb, bigBed)" -> "Fiberseq BigBed": the pattern lists the types.
        clean = re.sub(r"\s+", " ", re.sub(r"[^\w ]+", " ", label.split("(")[0].replace("-", ""))).strip()
        if not suffixes:
            out.append(f"{clean} (*.*)")
            continue
        exts: list[str] = []
        for suffix in suffixes:
            last = suffix.rsplit(".", 1)[-1]
            if re.fullmatch(r"\w+", last) and last not in exts:
                exts.append(last)
        out.append(f"{clean} ({';'.join('*.' + e for e in exts)})")
    return tuple(out)
