"""ChIP-Atlas external-track lookup helpers."""
from __future__ import annotations

import os
import threading
import time
import urllib.request


chipatlas_metadata: dict = {}
chipatlas_loading = False
chipatlas_load_progress = {"status": "idle", "message": ""}


def chipatlas_data_dir() -> str:
    path = os.path.expanduser("~/.fiberhmm/chipatlas")
    os.makedirs(path, exist_ok=True)
    return path


def load_chipatlas_metadata_sync() -> None:
    """Download and parse ChIP-Atlas experimentList.tab."""
    global chipatlas_metadata, chipatlas_loading
    chipatlas_loading = True
    chipatlas_load_progress["status"] = "downloading"
    chipatlas_load_progress["message"] = "Downloading ChIP-Atlas metadata..."
    try:
        data_dir = chipatlas_data_dir()
        tsv_path = os.path.join(data_dir, "experimentList.tab")

        need_download = True
        if os.path.exists(tsv_path):
            age = time.time() - os.path.getmtime(tsv_path)
            if age < 7 * 86400:
                need_download = False

        if need_download:
            url = "https://chip-atlas.dbcls.jp/data/metadata/experimentList.tab"
            req = urllib.request.Request(url, headers={"User-Agent": "FiberHMM-Browser/1.0"})
            # Downloaded to a temporary file and moved into place only when
            # complete: an interrupted download must not leave a fresh-looking
            # truncated cache that the next load would trust for a week.
            tmp_path = f"{tsv_path}.part-{os.getpid()}-{threading.get_ident()}"
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    expected = resp.headers.get("Content-Length") if getattr(resp, "headers", None) else None
                    written = 0
                    with open(tmp_path, "wb") as handle:
                        while True:
                            chunk = resp.read(1024 * 1024)
                            if not chunk:
                                break
                            handle.write(chunk)
                            written += len(chunk)
                if expected is not None and str(expected).isdigit() and written != int(expected):
                    raise IOError(f"ChIP-Atlas metadata download incomplete ({written} of {expected} bytes)")
                if written == 0:
                    raise IOError("ChIP-Atlas metadata download was empty")
                os.replace(tmp_path, tsv_path)
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

        chipatlas_load_progress["status"] = "parsing"
        chipatlas_load_progress["message"] = "Parsing ChIP-Atlas metadata..."

        metadata: dict = {}
        with open(tsv_path, "r", errors="replace") as handle:
            for line in handle:
                parts = line.strip().split("\t")
                if len(parts) < 6:
                    continue
                exp_id = parts[0]
                genome = parts[1]
                antigen_class = parts[2] if len(parts) > 2 else ""
                antigen = parts[3] if len(parts) > 3 else ""
                cell_type_class = parts[4] if len(parts) > 4 else ""
                cell_type = parts[5] if len(parts) > 5 else ""

                metadata.setdefault(genome, []).append({
                    "id": exp_id,
                    "antigen_class": antigen_class,
                    "antigen": antigen,
                    "cell_type_class": cell_type_class,
                    "cell_type": cell_type,
                })

        chipatlas_metadata = metadata
        chipatlas_load_progress["status"] = "ready"
        total_exps = sum(len(values) for values in metadata.values())
        chipatlas_load_progress["message"] = (
            f"Loaded {total_exps} experiments across {len(metadata)} genomes"
        )
    except Exception as exc:
        chipatlas_load_progress["status"] = "error"
        chipatlas_load_progress["message"] = str(exc)
    finally:
        chipatlas_loading = False


def get_chipatlas_status_payload() -> dict:
    return {
        "status": chipatlas_load_progress["status"],
        "message": chipatlas_load_progress["message"],
        "loading": chipatlas_loading,
        "genomes_loaded": list(chipatlas_metadata.keys()),
    }


def get_chipatlas_facets_for_genome(genome: str) -> dict:
    """Get available ChIP-Atlas facets for a genome."""
    if not chipatlas_metadata and not chipatlas_loading:
        thread = threading.Thread(target=load_chipatlas_metadata_sync, daemon=True)
        thread.start()
        return {
            "supported": True,
            "loading": True,
            "genome": genome,
            "antigen_classes": [],
            "cell_type_classes": [],
        }

    if chipatlas_loading:
        return {
            "supported": True,
            "loading": True,
            "genome": genome,
            "antigen_classes": [],
            "cell_type_classes": [],
        }

    experiments = chipatlas_metadata.get(genome, [])
    if not experiments:
        return {"supported": False, "genome": genome, "antigen_classes": [], "cell_type_classes": []}

    antigen_classes: dict = {}
    cell_type_classes: dict = {}
    for experiment in experiments:
        antigen_class = experiment.get("antigen_class", "")
        if antigen_class:
            antigen_classes[antigen_class] = antigen_classes.get(antigen_class, 0) + 1
        cell_type_class = experiment.get("cell_type_class", "")
        if cell_type_class:
            cell_type_classes[cell_type_class] = cell_type_classes.get(cell_type_class, 0) + 1

    return {
        "supported": True,
        "loading": False,
        "genome": genome,
        "total_experiments": len(experiments),
        "antigen_classes": [
            {"key": key, "count": value}
            for key, value in sorted(antigen_classes.items(), key=lambda item: -item[1])
        ],
        "cell_type_classes": [
            {"key": key, "count": value}
            for key, value in sorted(cell_type_classes.items(), key=lambda item: -item[1])
        ],
    }


def search_chipatlas_tracks(
    *,
    genome: str,
    antigen_class: str = "",
    antigen: str = "",
    cell_type_class: str = "",
    cell_type: str = "",
    limit: int = 25,
) -> dict:
    """Search ChIP-Atlas experiments and return bigWig URLs."""
    experiments = chipatlas_metadata.get(genome, [])
    if not experiments:
        return {"supported": False, "genome": genome, "tracks": []}

    filtered = experiments
    if antigen_class:
        filtered = [exp for exp in filtered if exp.get("antigen_class") == antigen_class]
    if antigen:
        antigen_lower = antigen.lower()
        filtered = [exp for exp in filtered if antigen_lower in exp.get("antigen", "").lower()]
    if cell_type_class:
        filtered = [exp for exp in filtered if exp.get("cell_type_class") == cell_type_class]
    if cell_type:
        cell_type_lower = cell_type.lower()
        filtered = [exp for exp in filtered if cell_type_lower in exp.get("cell_type", "").lower()]

    tracks = []
    for experiment in filtered[:limit]:
        exp_id = experiment["id"]
        url = f"https://chip-atlas.dbcls.jp/data/{genome}/eachData/bw/{exp_id}.bw"
        label_parts = [experiment.get("antigen", exp_id)]
        if experiment.get("cell_type"):
            label_parts.append(experiment["cell_type"])
        tracks.append({
            "url": url,
            "label": " - ".join(label_parts),
            "id": exp_id,
            "antigen_class": experiment.get("antigen_class", ""),
            "antigen": experiment.get("antigen", ""),
            "cell_type_class": experiment.get("cell_type_class", ""),
            "cell_type": experiment.get("cell_type", ""),
        })

    return {
        "supported": True,
        "genome": genome,
        "tracks": tracks,
        "total": len(filtered),
    }
