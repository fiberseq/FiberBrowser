"""Motif parsing, scoring, and JASPAR access helpers.

This module keeps motif CPU work and optional pyjaspar state out of the
FastAPI server module. The JASPAR database cache is thread-local by design:
pyjaspar uses sqlite connections, and sqlite connections cannot be shared
across FastAPI worker threads.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np
from services.lab.paths import open_local_text  # a lab server: motif files confined, by descriptor


GENOME_TO_JASPAR_SPECIES = {
    "hg38": 9606,
    "hg19": 9606,
    "mm39": 10090,
    "mm10": 10090,
    "dm6": 7227,
    "danRer11": 7955,
    "sacCer3": 4932,
    "ce11": 6239,
    "rn7": 10116,
}

JASPAR_SPECIES_NAMES = {9606: "human", 10090: "mouse", 7227: "fly", 7955: "zebrafish", 4932: "yeast",
                        6239: "worm", 10116: "rat"}


def genome_from_chroms(names) -> Optional[str]:
    """The assembly family the chromosome names point to (fly: chr2L/chr3R, ...), or None."""
    base = {str(n).lower().removeprefix("chr") for n in names or []}
    if {"2l", "3r"} <= base:
        return "dm6"
    if "xvi" in base and "i" in base:
        return "sacCer3"
    if {"i", "v", "x"} <= base and "1" not in base:
        return "ce11"
    if "25" in base:
        return "danRer11"
    if {"1", "21", "22"} <= base:
        return "hg38"
    if {"1", "20"} <= base:
        return "rn7"
    if {"1", "19"} <= base and "x" in base:
        return "mm10"
    return None


def _declaration_key(path) -> Optional[str]:
    if not path:
        return None
    text = str(path)
    return text if "://" in text else os.path.abspath(os.path.expanduser(text))


def declared_genome(state) -> Optional[str]:
    """The genome the user declared for this reference's FASTA (a custom contig: an insert, a construct).

    Declarations are kept per FASTA path (``state.genome_declarations``), so one holds for that file
    as the main reference or a panel's, and loading another file does not inherit it."""
    declarations = getattr(state, "genome_declarations", None) or {}
    key = _declaration_key(getattr(state, "fasta_path", None))
    return declarations.get(key) if key else None


def _base_state(state):
    return getattr(state, "__dict__", {}).get("_genome_base", state)  # a panel's view: the session's state


def declaration_revision(state) -> int:
    """Bumped by every declaration change: caches of genome-keyed results include it."""
    return int(getattr(_base_state(state), "genome_declaration_rev", 0) or 0)


def declare_genome(state, genome: Optional[str]) -> Optional[str]:
    from services.genome_loading import state_lock
    with state_lock(state):
        return _declare_genome_locked(state, genome)


def _declare_genome_locked(state, genome: Optional[str]) -> Optional[str]:
    """Record (or with None, clear) the genome of this state's FASTA; returns the FASTA path it is kept for.

    The declaration revision is bumped, and expanded inserts built from a source on this FASTA take
    the new identity (or lose it)."""
    key = _declaration_key(getattr(state, "fasta_path", None))
    if not key:
        return None
    base = _base_state(state)
    declarations = getattr(base, "genome_declarations", None)
    if not isinstance(declarations, dict):
        declarations = {}
        base.genome_declarations = declarations
    if genome:
        declarations[key] = genome
    else:
        declarations.pop(key, None)
    if base is not state:
        state.__dict__["genome_declarations"] = declarations
    base.genome_declaration_rev = declaration_revision(base) + 1
    if base is not state:
        state.__dict__["genome_declaration_rev"] = base.genome_declaration_rev
    try:
        from services.alt_allele import refresh_inherited_genomes
        refresh_inherited_genomes(base)
    except Exception:  # noqa: BLE001 - the declaration holds even if an insert's metadata can't be rewritten
        pass
    return key


def list_declarations(state) -> list[dict]:
    """The session's declarations as ``[{fasta_path, genome}]`` (what a session file and the autosave keep)."""
    declarations = getattr(_base_state(state), "genome_declarations", None) or {}
    return [{"fasta_path": path, "genome": genome} for path, genome in sorted(declarations.items())]


def restore_declarations(state, raw) -> bool:
    from services.genome_loading import state_lock
    with state_lock(state):
        return _restore_declarations_locked(state, raw)


def _restore_declarations_locked(state, raw) -> bool:
    """Put back saved declarations (``[{fasta_path, genome}]``) over the session's: saved ones are set, others
    kept. Bumps the revision and refreshes inherited insert genomes once when anything changed."""
    wanted = normalize_declarations(raw)
    base = _base_state(state)
    declarations = getattr(base, "genome_declarations", None)
    if not isinstance(declarations, dict):
        declarations = {}
        base.genome_declarations = declarations
    changed = {k: v for k, v in wanted.items() if declarations.get(k) != v}
    if not changed:
        return False
    declarations.update(changed)
    base.genome_declaration_rev = declaration_revision(base) + 1
    try:
        from services.alt_allele import refresh_inherited_genomes
        refresh_inherited_genomes(base)
    except Exception:  # noqa: BLE001
        pass
    return True


def normalize_declarations(raw, path_mapping: Optional[dict] = None) -> dict:
    """Declarations from a session: ``[{fasta_path, genome}]`` (or the older ``{path: genome}``), with
    relinked paths mapped, as normalized keys."""
    mapping = path_mapping or {}
    items = raw.items() if isinstance(raw, dict) else (
        ((e.get("fasta_path"), e.get("genome")) for e in raw if isinstance(e, dict)) if isinstance(raw, list) else ())
    out = {}
    for path, genome in items:
        if not path or not genome:
            continue
        key = _declaration_key(mapping.get(str(path), str(path)))
        if key:
            out[key] = str(genome)
    return out


def reference_genome_basis(state) -> tuple[Optional[str], Optional[str]]:
    """(genome, how it is known) for this state's reference, without looking at its chromosome names.

    ``declared``: the user said so for this FASTA. ``genome``: the loaded genome (registry, or a FASTA
    named for one). ``inherited``: a panel reference built from another genome takes that genome's
    identity (an expanded insertion's alt allele, a plugin pack's contig). ``assembly``: a panel FASTA
    whose chromosome lengths identify it. Coordinates stay the reference's own; only the identity
    (species, JASPAR taxon, TE library) is shared."""
    declared = declared_genome(state)
    if declared:
        return declared, "declared"
    current = getattr(state, "current_genome", None)
    if current and current != "plasmids":
        return current, "genome"
    context = getattr(state, "__dict__", {}).get("_genome_context")
    spec = getattr(context, "_panel_genome_spec", None) or {}
    if spec.get("species_genome"):
        return spec["species_genome"], "inherited"
    for field in ("genome_id", "assembly"):
        if spec.get(field):
            return spec[field], "assembly"
    if context is None and getattr(state, "fasta", None) is not None:
        # The main FASTA's own chromosome lengths identify its assembly (custom_reference.fa with dm6's
        # lengths is dm6): an insert expanded from it inherits that species (fly motifs, the fly TE library).
        try:
            from services.genome_check import loaded_reference
            assembly = loaded_reference(state).get("assembly")
        except Exception:  # noqa: BLE001
            assembly = None
        if assembly:
            return assembly, "assembly"
    return None, None


def reference_genome(state) -> Optional[str]:
    """The genome this state's reference belongs to (``reference_genome_basis``), or None."""
    return reference_genome_basis(state)[0]


def coordinate_genome(state) -> Optional[str]:
    """The assembly whose coordinates this reference's are, when that is known rather than declared:
    the loaded genome, a panel's registry genome, or a FASTA whose chromosome lengths identify it.
    Coordinate lookups (UCSC rmsk, phyloP, ChIP-Atlas) use only this; an expanded insert or a
    declared custom FASTA has a species but no coordinate assembly."""
    current = getattr(state, "current_genome", None)
    if current and current != "plasmids":
        return current
    context = getattr(state, "__dict__", {}).get("_genome_context")
    spec = getattr(context, "_panel_genome_spec", None) or {}
    if spec.get("genome_id") or spec.get("assembly"):
        return spec.get("genome_id") or spec.get("assembly")
    if context is None and getattr(state, "fasta", None) is not None:
        try:
            from services.genome_check import loaded_reference
            return loaded_reference(state).get("assembly")
        except Exception:  # noqa: BLE001
            return None
    return None


def genome_identity_key(state) -> str:
    """What genome-keyed results depend on: species identity, coordinate assembly, declaration revision."""
    genome, basis = reference_genome_basis(state)
    return f"{genome}|{basis}|{coordinate_genome(state)}|{jaspar_genome(state)[0]}|r{declaration_revision(state)}"


def jaspar_genome(state) -> tuple[Optional[str], bool]:
    """(genome to take JASPAR species from, inferred?).

    The recorded genome name can go stale (a restored session, an earlier
    genome load) while other sequences are loaded; when the loaded chromosome
    names clearly belong to another species, they win. A genome the user
    declared for the FASTA always holds.
    """
    recorded, basis = reference_genome_basis(state)
    if basis == "declared":
        return recorded, False
    inferred = genome_from_chroms(c.name for c in getattr(state, "chroms", None) or [])
    if recorded in GENOME_TO_JASPAR_SPECIES:
        if inferred and GENOME_TO_JASPAR_SPECIES[inferred] != GENOME_TO_JASPAR_SPECIES[recorded]:
            return inferred, True
        return recorded, False
    return (inferred, True) if inferred else (recorded, False)


# A sequence with no genome (a custom FASTA nothing declares) is scanned with this JASPAR taxon group.
FALLBACK_TAX_GROUP = "vertebrates"
FALLBACK_NOTE = ("No genome is declared for this sequence: JASPAR CORE vertebrates are scanned. "
                 "Declare the genome it comes from for that species' motifs.")


def fallback_species() -> dict:
    """``jaspar_species`` for the fallback scan (no species: the taxon group's matrices)."""
    return {"genome": None, "taxid": None, "inferred": False, "name": FALLBACK_TAX_GROUP,
            "tax_group": FALLBACK_TAX_GROUP, "fallback": True}


HAS_PYJASPAR = False
_jaspar_cache = {}  # (thread_id, release) -> jaspardb
_jaspar_core_motif_cache = {}  # (release, species_id) -> serializable motif records
_jaspar_core_fetch_locks = {}  # (release, species_id) -> Lock
_jaspar_lock = threading.Lock()
MOTIF_SCAN_CHUNK_WINDOWS = 200_000
_BASE_CODE_LUT = np.full(256, -1, dtype=np.int16)
_BASE_CODE_LUT[ord("A")] = 0
_BASE_CODE_LUT[ord("C")] = 1
_BASE_CODE_LUT[ord("G")] = 2
_BASE_CODE_LUT[ord("T")] = 3


@dataclass(frozen=True)
class MotifRecord:
    """Thread-safe subset of a JASPAR motif used by analysis code."""

    matrix_id: str
    name: str
    counts: Dict[str, List[float]]


def check_pyjaspar() -> bool:
    """Return True when pyjaspar can be imported."""
    global HAS_PYJASPAR
    try:
        from pyjaspar import jaspardb  # noqa: F401

        HAS_PYJASPAR = True
        return True
    except ImportError:
        return False


def get_jaspar_db(release: str = "JASPAR2024"):
    """Get a JASPAR database instance owned by the calling thread."""
    key = (threading.get_ident(), release)
    with _jaspar_lock:
        db = _jaspar_cache.get(key)
        if db is None:
            from pyjaspar import jaspardb

            db = jaspardb(release=release)
            _jaspar_cache[key] = db
    return db


def get_jaspar_core_motifs(species_id: int, release: str = "JASPAR2024"):
    """Return cached JASPAR CORE motif records for one species.

    The sqlite-backed pyjaspar DB remains thread-local, but the fetched motif
    payload is converted to plain records and shared process-wide. This avoids
    re-fetching the same species when FastAPI schedules requests on different
    worker threads.
    """
    key = (release, int(species_id))
    with _jaspar_lock:
        cached = _jaspar_core_motif_cache.get(key)
        fetch_lock = _jaspar_core_fetch_locks.setdefault(key, threading.Lock())
    if cached is not None:
        return cached

    with fetch_lock:
        with _jaspar_lock:
            cached = _jaspar_core_motif_cache.get(key)
        if cached is not None:
            return cached

        db = get_jaspar_db(release=release)
        motifs = db.fetch_motifs(
            collection="CORE",
            tax_group=None,
            species=[int(species_id)],
        )
        records = [
            MotifRecord(
                matrix_id=m.matrix_id,
                name=m.name,
                counts={base: [float(x) for x in m.counts.get(base, [])] for base in "ACGT"},
            )
            for m in motifs
        ]
        motifs_sorted = sorted(records, key=lambda m: -sum(m.counts.get("A", [0])))
        with _jaspar_lock:
            cached = _jaspar_core_motif_cache.setdefault(key, motifs_sorted)
        return cached


_jaspar_core_pssm_cache = {}  # (release, species_id) -> [(record, pssm)]


def get_jaspar_core_pssms(species_id: int, release: str = "JASPAR2024"):
    """JASPAR CORE motifs for one species with their scoring matrices, cached."""
    key = (release, int(species_id))
    with _jaspar_lock:
        cached = _jaspar_core_pssm_cache.get(key)
    if cached is not None:
        return cached
    scored = [
        (m, pwm_to_pssm(m.counts))
        for m in get_jaspar_core_motifs(species_id, release=release)
        if all(m.counts.get(base) for base in "ACGT")
    ]
    with _jaspar_lock:
        return _jaspar_core_pssm_cache.setdefault(key, scored)


_jaspar_catalog_cache = {}  # release -> list of catalog entries


def jaspar_catalog(release: str = "JASPAR2024") -> list[dict]:
    """Every current JASPAR CORE matrix (all taxa) with its counts, cached."""
    with _jaspar_lock:
        cached = _jaspar_catalog_cache.get(release)
    if cached is not None:
        return cached
    db = get_jaspar_db(release=release)
    entries = [
        {
            "matrix_id": m.matrix_id,
            "name": m.name,
            "tax_group": m.tax_group or "",
            "counts": {base: [float(x) for x in m.counts.get(base, [])] for base in "ACGT"},
        }
        for m in db.fetch_motifs(collection="CORE", all_versions=False)
    ]
    with _jaspar_lock:
        return _jaspar_catalog_cache.setdefault(release, entries)


def get_jaspar_taxon_pssms(tax_group: str, release: str = "JASPAR2024"):
    """JASPAR CORE motifs (latest versions) of one taxon group with their scoring matrices, cached."""
    key = (release, "tax:" + str(tax_group))
    with _jaspar_lock:
        cached = _jaspar_core_pssm_cache.get(key)
    if cached is not None:
        return cached
    scored = [
        (MotifRecord(matrix_id=e["matrix_id"], name=e["name"], counts=e["counts"]), pwm_to_pssm(e["counts"]))
        for e in jaspar_catalog(release)
        if e["tax_group"] == tax_group and all(e["counts"].get(base) for base in "ACGT")
    ]
    with _jaspar_lock:
        return _jaspar_core_pssm_cache.setdefault(key, scored)


_GENOME_TAXON_PREFIXES = (
    (("hg", "grch", "mm", "grcm", "rn", "danrer", "galgal", "susscr", "bostau", "canfam"), "vertebrates"),
    (("dm", "bdgp"), "insects"),
    (("ce", "wbcel"), "nematodes"),
    (("saccer", "r64"), "fungi"),
    (("tair", "araport"), "plants"),
)


def genome_taxon(genome: Optional[str]) -> Optional[str]:
    """JASPAR tax_group for a genome assembly name (hg38 -> vertebrates, dm6 -> insects)."""
    name = (genome or "").lower()
    for prefixes, taxon in _GENOME_TAXON_PREFIXES:
        if name.startswith(prefixes):
            return taxon
    return None


def search_jaspar(query: str, limit: int = 20, release: str = "JASPAR2024", taxon: Optional[str] = None) -> list[dict]:
    """JASPAR matrices whose name or ID matches ``query``: exact, then prefix, then
    substring; within each, matrices from ``taxon`` (the loaded genome's) first."""
    needle = (query or "").strip().upper()
    if not needle:
        return []
    ranked = []
    for entry in jaspar_catalog(release):
        name, matrix_id = entry["name"].upper(), entry["matrix_id"].upper()
        if needle in (name, matrix_id, matrix_id.split(".")[0]):
            rank = 0
        elif name.startswith(needle) or matrix_id.startswith(needle):
            rank = 1
        elif needle in name:
            rank = 2
        else:
            continue
        other_taxon = 0 if not taxon or entry["tax_group"] == taxon else 1
        ranked.append((rank, other_taxon, len(name), name, entry))
    ranked.sort(key=lambda item: item[:4])
    return [
        {key: entry[key] for key in ("matrix_id", "name", "tax_group")}
        | {"length": len(entry["counts"]["A"])}
        for *_ignored, entry in ranked[:limit]
    ]


def jaspar_matrix(matrix_id: str, release: str = "JASPAR2024") -> Optional[dict]:
    wanted = (matrix_id or "").strip().upper()
    for entry in jaspar_catalog(release):
        if entry["matrix_id"].upper() == wanted:
            return entry
    return None


def pwm_to_pssm(
    counts: Dict[str, List[float]],
    pseudocount: float = 0.1,
    background: Optional[Dict[str, float]] = None,
) -> np.ndarray:
    """Convert count matrix to a position-specific scoring matrix."""
    if background is None:
        background = {"A": 0.25, "C": 0.25, "G": 0.25, "T": 0.25}

    bases = ["A", "C", "G", "T"]
    count_matrix = np.array([counts[base] for base in bases], dtype=float)
    count_matrix += pseudocount

    prob_matrix = count_matrix / count_matrix.sum(axis=0, keepdims=True)
    bg = np.array([background[base] for base in bases]).reshape(-1, 1)
    return np.log2(prob_matrix / bg)


def scan_sequence(seq: str, pssm: np.ndarray, threshold: float) -> List[Dict]:
    """Scan one DNA strand with a PSSM and return hits above threshold."""
    seq = seq.upper()
    motif_len = pssm.shape[1]

    if motif_len <= 0 or len(seq) < motif_len:
        return []

    min_score = pssm.min(axis=0).sum()
    max_score = pssm.max(axis=0).sum()
    score_range = max_score - min_score

    hits = []
    encoded = seq.encode("ascii", "replace")
    codes = _BASE_CODE_LUT[np.frombuffer(encoded, dtype=np.uint8)]
    window_count = len(seq) - motif_len + 1
    position_idx = np.arange(motif_len)
    windows = np.lib.stride_tricks.sliding_window_view(codes, motif_len)

    for chunk_start in range(0, window_count, MOTIF_SCAN_CHUNK_WINDOWS):
        chunk_end = min(window_count, chunk_start + MOTIF_SCAN_CHUNK_WINDOWS)
        chunk_windows = windows[chunk_start:chunk_end]
        valid_mask = np.all(chunk_windows >= 0, axis=1)
        if not np.any(valid_mask):
            continue
        valid_windows = chunk_windows[valid_mask]
        scores = pssm[valid_windows, position_idx].sum(axis=1)
        if score_range > 0:
            rel_scores = (scores - min_score) / score_range
        else:
            rel_scores = np.zeros_like(scores, dtype=float)
        passed = rel_scores >= threshold
        if not np.any(passed):
            continue
        valid_offsets = np.flatnonzero(valid_mask)
        for offset, score, rel_score in zip(
            valid_offsets[passed],
            scores[passed],
            rel_scores[passed],
        ):
            i = int(chunk_start + offset)
            window = seq[i : i + motif_len]
            hits.append(
                {
                    "start": i,
                    "end": i + motif_len,
                    "score": float(score),
                    "rel_score": float(rel_score),
                    "matched_seq": window,
                }
            )

    return hits


def scan_both_strands(seq: str, pssm: np.ndarray, threshold: float) -> List[Dict]:
    """Scan both strands, returning hits in input-sequence coordinates."""
    forward_hits = scan_sequence(seq, pssm, threshold)
    for hit in forward_hits:
        hit["strand"] = "+"

    rev_seq = reverse_complement(seq)
    rev_hits = scan_sequence(rev_seq, pssm, threshold)

    seq_len = len(seq)
    for hit in rev_hits:
        orig_end = seq_len - hit["start"]
        orig_start = seq_len - hit["end"]
        hit["start"] = orig_start
        hit["end"] = orig_end
        hit["strand"] = "-"

    return forward_hits + rev_hits


def consensus_to_pwm(sequence: str) -> Dict[str, List[float]]:
    """Convert an IUPAC consensus sequence to a PWM count matrix."""
    iupac = {
        "A": {"A": 1},
        "C": {"C": 1},
        "G": {"G": 1},
        "T": {"T": 1},
        "R": {"A": 1, "G": 1},
        "Y": {"C": 1, "T": 1},
        "S": {"G": 1, "C": 1},
        "W": {"A": 1, "T": 1},
        "K": {"G": 1, "T": 1},
        "M": {"A": 1, "C": 1},
        "B": {"C": 1, "G": 1, "T": 1},
        "D": {"A": 1, "G": 1, "T": 1},
        "H": {"A": 1, "C": 1, "T": 1},
        "V": {"A": 1, "C": 1, "G": 1},
        "N": {"A": 1, "C": 1, "G": 1, "T": 1},
    }
    counts: Dict[str, List[float]] = {"A": [], "C": [], "G": [], "T": []}
    for base in sequence.upper():
        mapping = iupac.get(base)
        if mapping is None:
            raise ValueError(f"Invalid IUPAC character: {base}")
        share = 100.0 / len(mapping)
        for pwm_base in "ACGT":
            counts[pwm_base].append(share if pwm_base in mapping else 0.0)
    return counts


def parse_homer_file(file_path: str) -> Dict[str, Dict]:
    """Parse a HOMER .motif format file."""
    motifs = {}
    current_name = None
    current_probs = []

    with open_local_text(file_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if current_name and current_probs:
                    counts = {"A": [], "C": [], "G": [], "T": []}
                    for row in current_probs:
                        for i, base in enumerate(["A", "C", "G", "T"]):
                            counts[base].append(row[i] * 100)
                    motifs[current_name] = {"counts": counts}
                parts = line[1:].split("\t")
                current_name = parts[1] if len(parts) > 1 else parts[0]
                current_probs = []
            elif line[0].isdigit() or (line[0] == "0" or line.startswith("0.")):
                probs = [float(x) for x in line.split()]
                if len(probs) == 4:
                    current_probs.append(probs)

    if current_name and current_probs:
        counts = {"A": [], "C": [], "G": [], "T": []}
        for row in current_probs:
            for i, base in enumerate(["A", "C", "G", "T"]):
                counts[base].append(row[i] * 100)
        motifs[current_name] = {"counts": counts}

    return motifs


def parse_jaspar_file(file_path: str) -> Dict[str, Dict]:
    """Parse a JASPAR format motif file."""
    motifs = {}
    current_name = None
    current_id = None
    current_counts = {}

    def finish():
        if not (current_name and current_counts):
            return
        # Matrices share a TF name across versions (MA0001.1 / MA0001.2): each
        # is kept, the later ones named with their matrix ID.
        key = current_name
        if key in motifs and current_id:
            key = f"{current_name} ({current_id})"
        n = 2
        while key in motifs:
            key = f"{current_name} ({n})"
            n += 1
        motifs[key] = {"counts": current_counts}

    with open_local_text(file_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            if line.startswith(">"):
                finish()
                parts = line[1:].split()
                current_name = parts[1] if len(parts) > 1 else parts[0]
                current_id = parts[0] if len(parts) > 1 else None
                current_counts = {}
            elif line[0] in "ACGT":
                base = line[0]
                nums = line.split("[")[1].split("]")[0] if "[" in line else line[2:]
                counts = [float(x) for x in nums.split()]
                current_counts[base] = counts

    finish()
    return motifs


def parse_meme_file(file_path: str) -> Dict[str, Dict]:
    """Parse a MEME format motif file."""
    motifs = {}
    current_name = None
    current_probs = []
    in_matrix = False

    with open_local_text(file_path) as f:
        for line in f:
            line = line.strip()

            if line.startswith("MOTIF"):
                if current_name and current_probs:
                    counts = {"A": [], "C": [], "G": [], "T": []}
                    for row in current_probs:
                        for i, base in enumerate(["A", "C", "G", "T"]):
                            counts[base].append(row[i] * 100)
                    motifs[current_name] = {"counts": counts}

                parts = line.split()
                current_name = parts[1] if len(parts) > 1 else "unnamed"
                current_probs = []
                in_matrix = False

            elif "letter-probability matrix" in line.lower():
                in_matrix = True

            elif in_matrix and line and line[0].isdigit():
                probs = [float(x) for x in line.split()]
                if len(probs) == 4:
                    current_probs.append(probs)

    if current_name and current_probs:
        counts = {"A": [], "C": [], "G": [], "T": []}
        for row in current_probs:
            for i, base in enumerate(["A", "C", "G", "T"]):
                counts[base].append(row[i] * 100)
        motifs[current_name] = {"counts": counts}

    return motifs


def reverse_complement(seq: str) -> str:
    """Compute reverse complement of a DNA sequence."""
    complement = {
        "A": "T",
        "T": "A",
        "C": "G",
        "G": "C",
        "a": "t",
        "t": "a",
        "c": "g",
        "g": "c",
        "N": "N",
        "n": "n",
    }
    return "".join(complement.get(base, "N") for base in reversed(seq))


# ------------------------------------------------------------------ p-value thresholds (exact score distributions)
# The relative score above ((s - min) / (max - min)) is not comparable across matrices: a short or low-information
# matrix passes 0.85 by chance every few hundred bp, a long one almost never. The functions below threshold every
# matrix at the same false-positive rate instead, as FIMO / MOODS do: the PSSM's exact score distribution under a
# 0-order background is computed by dynamic programming over integer scores, and a site passes when
# P(S >= its score) <= p. Scores are log2-odds rounded to 1/PSSM_SCALE bit; the scan uses the same integer matrix,
# so a site's p-value is exact for that matrix (no interpolation).
PSSM_SCALE = 100
UNIFORM_BACKGROUND = {"A": 0.25, "C": 0.25, "G": 0.25, "T": 0.25}


BACKGROUND_FLOOR = 0.01      # share of the uniform mixed in, so no base has probability 0
BACKGROUND_DECIMALS = 4      # a background is quantised once, then used (and reported) as quantised


def normalize_background(background: Dict[str, float]) -> Dict[str, float]:
    """A strand-symmetric (A = T, C = G), strictly positive background (each base >= BACKGROUND_FLOOR / 4),
    quantised to BACKGROUND_DECIMALS: the one used for the pseudocounts, the log-odds, the null distribution and the
    report. Idempotent."""
    a = max(0.0, float(background.get("A", 0))) + max(0.0, float(background.get("T", 0)))
    c = max(0.0, float(background.get("C", 0))) + max(0.0, float(background.get("G", 0)))
    total = a + c
    at = 0.25 if total <= 0 else a / (2 * total)
    low = BACKGROUND_FLOOR / 4
    at = round(min(0.5 - low, max(low, at)), BACKGROUND_DECIMALS)
    gc = round(0.5 - at, BACKGROUND_DECIMALS)
    return {"A": at, "C": gc, "G": gc, "T": at}


def background_composition(seq: str, min_bases: int = 200) -> Dict[str, float]:
    """0-order base composition of ``seq`` for scanning both strands: A = T and C = G (each strand's composition is
    the other's complement), with 1% of the uniform mixed in (no base at probability 0) and quantised
    (normalize_background); uniform when fewer than ``min_bases`` called bases."""
    s = seq.upper()
    a, c, g, t = (s.count(b) for b in "ACGT")
    n = a + c + g + t
    if n < min_bases:
        return dict(UNIFORM_BACKGROUND)
    at = (a + t) / (2 * n)
    at = (1 - BACKGROUND_FLOOR) * at + BACKGROUND_FLOOR * 0.25
    return normalize_background({"A": at, "C": 0.5 - at, "G": 0.5 - at, "T": at})


def jaspar_pseudocounts(counts: Dict[str, List[float]], background: Dict[str, float]) -> Dict[str, float]:
    """JASPAR's pseudocounts (Biopython ``Bio.motifs.jaspar.calculate_pseudocounts``; Wasserman & Sandelin 2004):
    sqrt(mean column total) shared out by the background."""
    length = len(counts["A"])
    total = sum(float(counts[b][i]) for b in "ACGT" for i in range(length))
    root = float(np.sqrt(total / max(length, 1)))
    norm = sum(background[b] for b in "ACGT")
    return {b: root * background[b] / norm for b in "ACGT"}


def log_odds_pssm(counts: Dict[str, List[float]], background: Optional[Dict[str, float]] = None) -> np.ndarray:
    """4 x L log2-odds matrix (rows A, C, G, T) against ``background``, with JASPAR pseudocounts: equal to Biopython's
    ``motif.counts.normalize(pseudocounts=calculate_pseudocounts(motif)).log_odds(background)``."""
    bg = background or UNIFORM_BACKGROUND
    pc = jaspar_pseudocounts(counts, bg)
    m = np.array([[float(x) + pc[b] for x in counts[b]] for b in "ACGT"], dtype=float)
    prob = m / m.sum(axis=0, keepdims=True)
    return np.log2(prob / np.array([bg[b] for b in "ACGT"], dtype=float).reshape(-1, 1))


def integer_pssm(pssm: np.ndarray, scale: int = PSSM_SCALE) -> np.ndarray:
    return np.rint(np.asarray(pssm, dtype=float) * scale).astype(np.int64)


def score_tail(int_pssm: np.ndarray, background: Dict[str, float]) -> tuple[int, np.ndarray]:
    """(minimum score, tail) with tail[k] = P(S >= minimum + k) for a random site drawn from the 0-order
    ``background``: the exact distribution of the integer PSSM's score (a convolution, column by column)."""
    bg = np.array([background[b] for b in "ACGT"], dtype=float)
    bg = bg / bg.sum()
    lows = int_pssm.min(axis=0)
    span = int((int_pssm.max(axis=0) - lows).sum())
    dist = np.zeros(span + 1)
    dist[0] = 1.0
    width = 0
    for j in range(int_pssm.shape[1]):
        shifts = int_pssm[:, j] - lows[j]
        step = int(shifts.max())
        nxt = np.zeros(span + 1)
        for b in range(4):
            s = int(shifts[b])
            nxt[s:s + width + 1] += bg[b] * dist[:width + 1]
        dist = nxt
        width += step
    tail = np.cumsum(dist[::-1])[::-1]
    return int(lows.sum()), np.minimum(tail, 1.0)


@dataclass
class ScoredMatrix:
    """A matrix ready for p-value scanning against one background."""

    matrix_id: str
    name: str
    int_pssm: np.ndarray
    rc_pssm: np.ndarray
    smin: int
    tail: np.ndarray
    background: Dict[str, float]

    @property
    def length(self) -> int:
        return int(self.int_pssm.shape[1])

    @property
    def smax(self) -> int:
        return self.smin + len(self.tail) - 1

    @property
    def min_p(self) -> float:
        """The smallest p-value any site can have (the best-scoring sequence's)."""
        return float(self.tail[-1])

    def pvalue(self, score: int) -> float:
        k = int(score) - self.smin
        if k <= 0:
            return 1.0
        if k >= len(self.tail):
            return 0.0
        return float(self.tail[k])

    def cutoff_for_p(self, p: float) -> Optional[int]:
        """The lowest integer score whose P(S >= score) <= p; None when even the best site's p-value exceeds p."""
        ok = np.flatnonzero(self.tail <= p * (1 + 1e-9))      # a tail equal to p passes (rounding)
        return None if not len(ok) else int(self.smin + ok[0])

    def cutoff_for_relative(self, rel: float) -> int:
        return int(np.ceil(self.smin + float(rel) * (self.smax - self.smin) - 1e-9))


def scored_matrix(matrix_id: str, name: str, counts: Dict[str, List[float]], background: Optional[Dict[str, float]] = None,
                  scale: int = PSSM_SCALE) -> ScoredMatrix:
    bg = normalize_background(background or UNIFORM_BACKGROUND)
    ip = integer_pssm(log_odds_pssm(counts, bg), scale)
    smin, tail = score_tail(ip, bg)
    return ScoredMatrix(matrix_id, name, ip, ip[::-1, ::-1].copy(), smin, tail, bg)


def scan_scored(seq: str, matrix: ScoredMatrix, cutoff: int) -> List[Dict]:
    """Sites of ``matrix`` on both strands of ``seq`` scoring >= ``cutoff`` (integer units), each with its exact
    p-value; coordinates on ``seq``. A window with a base other than ACGT is skipped."""
    L = matrix.length
    if L <= 0 or len(seq) < L:
        return []
    codes = _BASE_CODE_LUT[np.frombuffer(seq.upper().encode("ascii", "replace"), dtype=np.uint8)]
    windows = np.lib.stride_tricks.sliding_window_view(codes, L)
    pos = np.arange(L)
    hits = []
    for start in range(0, len(windows), MOTIF_SCAN_CHUNK_WINDOWS):
        chunk = windows[start:start + MOTIF_SCAN_CHUNK_WINDOWS]
        valid = np.all(chunk >= 0, axis=1)
        if not valid.any():
            continue
        safe = np.where(chunk >= 0, chunk, 0)
        for strand, mat in (("+", matrix.int_pssm), ("-", matrix.rc_pssm)):
            scores = mat[safe, pos].sum(axis=1)
            for off in np.flatnonzero(valid & (scores >= cutoff)):
                i = int(start + off)
                sc = int(scores[off])
                hits.append(dict(start=i, end=i + L, strand=strand, score=sc / PSSM_SCALE, int_score=sc,
                                 p=matrix.pvalue(sc), rel=(sc - matrix.smin) / max(matrix.smax - matrix.smin, 1),
                                 matched_seq=seq[i:i + L]))
    return hits
