"""Find a pasted DNA sequence in the loaded genome.

Two searches, chosen automatically (``choose_mode``):

- **Exact / IUPAC**: short queries (under ``exact_max_length`` bases) and any
  query with IUPAC codes. Both strands of the loaded reference FASTA are
  scanned, chunk by chunk through the shared FASTA readers
  (services/fasta_handles.py), plus any plasmid / custom sequences loaded
  beside it (held in memory). Up to ``max_mismatches`` mismatches are allowed;
  a query IUPAC code matches every base it stands for, and an N in the
  reference never matches. Overlapping hits are all reported; a query that is
  its own reverse complement is reported once per place (strand ``.``).
- **BLAST**: longer queries, or when approximate matches are asked for. It
  reuses the genome BLAST database the primer designer and Identify share
  (``insertion_identify.genome_blast_db``: primer design's database when it
  matches the loaded genome, else one built once beside it, with progress and
  Cancel) and its abort-aware ``blastn`` runner. Outside the app bundle without
  BLAST+ the search falls back to the exact scan, with a note.

Both run as background jobs (``insertion_identify.start_job``: progress,
Cancel, results kept per job, never written to disk). The request carries the
sequence and numeric settings only: no file paths. Coordinates are 0-based,
half-open, on the FASTA's own contig names.
"""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import asdict, dataclass, fields
from typing import Callable, Optional

import numpy as np

from services import insertion_identify as ii

SCHEMA = "fiberbrowser.sequence_search/1"

# Defaults of the adjustable settings (the panel shows them; every request may override them).
DEFAULTS = {
    "mode": "auto",              # auto | exact | blast
    "exact_max_length": 30,      # auto: shorter queries (and any with IUPAC codes) use the exact scan
    "max_mismatches": 0,         # exact scan: mismatches allowed per hit
    "evalue": 0.01,              # BLAST: report hits at or below this e-value
    "max_hits": 500,             # hits listed (the total is always counted)
    "min_length": 12,            # shortest query searched
    "blast_task": "auto",        # auto | megablast | blastn | blastn-short
}
LIMITS = {
    "exact_max_length": (8, 10_000),
    "max_mismatches": (0, 5),
    "evalue": (1e-200, 1000.0),
    "max_hits": (1, 10_000),
    "min_length": (6, 1_000),
}
MAX_QUERY = 100_000             # longest pasted sequence (BLAST)
EXACT_HARD_MAX = 10_000         # longest query the exact scan takes
CHUNK = 8_000_000               # reference bases read per step of the exact scan
MATCHED_SEQ_MAX = 1_000         # matched bases kept per hit (longer ones are cut, marked)
BLAST_TASKS = ("megablast", "blastn", "blastn-short")
SHORT_TASK_BELOW = 50           # auto: blastn-short under this length

NO_GENOME_MESSAGE = ("No reference genome is loaded. Open a genome first (Settings › Reference & Tracks, or "
                     "Open file… with a FASTA), then search again.")
REMOTE_REFERENCE_MESSAGE = ("The loaded reference is not a local file, so it can't be searched here. Download the "
                            "genome (or reopen it once its download has finished) and search again.")


class SequenceSearchError(ii.IdentifyError):
    """A search that can't run; ``code`` says why (no_genome, bad_query, remote_reference, unavailable)."""

    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Settings


@dataclass
class SearchSettings:
    mode: str = DEFAULTS["mode"]
    exact_max_length: int = DEFAULTS["exact_max_length"]
    max_mismatches: int = DEFAULTS["max_mismatches"]
    evalue: float = DEFAULTS["evalue"]
    max_hits: int = DEFAULTS["max_hits"]
    min_length: int = DEFAULTS["min_length"]
    blast_task: str = DEFAULTS["blast_task"]

    @classmethod
    def from_request(cls, values: Optional[dict]) -> "SearchSettings":
        """Settings from a request: unknown keys ignored, numbers clamped to LIMITS, a bad value an error."""
        values = values or {}
        out = cls()
        for f in fields(cls):
            raw = values.get(f.name)
            if raw is None or raw == "":
                continue
            if f.name in ("mode", "blast_task"):
                text = str(raw).strip().lower()
                allowed = ("auto", "exact", "blast") if f.name == "mode" else ("auto",) + BLAST_TASKS
                if text not in allowed:
                    raise SequenceSearchError(f"{f.name} must be one of {', '.join(allowed)}", "bad_query")
                setattr(out, f.name, text)
                continue
            try:
                number = float(raw)
            except (TypeError, ValueError):
                raise SequenceSearchError(f"{f.name} must be a number", "bad_query") from None
            if number != number:  # NaN
                raise SequenceSearchError(f"{f.name} must be a number", "bad_query")
            low, high = LIMITS[f.name]
            number = min(max(number, low), high)
            setattr(out, f.name, number if f.name == "evalue" else int(number))
        return out


def defaults_payload() -> dict:
    return {"defaults": dict(DEFAULTS), "limits": {k: list(v) for k, v in LIMITS.items()},
            "max_query": MAX_QUERY, "exact_hard_max": EXACT_HARD_MAX, "blast_tasks": list(BLAST_TASKS)}


# ---------------------------------------------------------------------------
# The query

# Bit masks: A=1, C=2, G=4, T=8; an IUPAC code is the union of its bases.
IUPAC = {
    "A": 1, "C": 2, "G": 4, "T": 8,
    "R": 1 | 4, "Y": 2 | 8, "S": 2 | 4, "W": 1 | 8, "K": 4 | 8, "M": 1 | 2,
    "B": 2 | 4 | 8, "D": 1 | 4 | 8, "H": 1 | 2 | 8, "V": 1 | 2 | 4, "N": 15,
}
_COMPLEMENT = str.maketrans("ACGTRYSWKMBDHVN", "TGCAYRSWMKVHDBN")
_REFERENCE_MASK = np.zeros(256, dtype=np.uint8)
for _base, _bit in (("A", 1), ("C", 2), ("G", 4), ("T", 8)):
    _REFERENCE_MASK[ord(_base)] = _bit
    _REFERENCE_MASK[ord(_base.lower())] = _bit
_STRIP = re.compile(r"[\s\d]+")


def reverse_complement(seq: str) -> str:
    return seq.translate(_COMPLEMENT)[::-1]


def normalize_query(text: str, *, min_length: int = DEFAULTS["min_length"]) -> str:
    """The query as upper-case IUPAC DNA: FASTA header lines, whitespace and numbers (a GenBank listing's)
    dropped, U read as T. Raises ``SequenceSearchError('bad_query')`` for anything else."""
    if not isinstance(text, str) or not text.strip():
        raise SequenceSearchError("Paste a DNA sequence to search for.", "bad_query")
    lines = text.strip().splitlines()
    headers = [line for line in lines if line.lstrip().startswith(">")]
    if len(headers) > 1:
        raise SequenceSearchError("Paste one sequence at a time (this text has several FASTA records).", "bad_query")
    body = "".join(line for line in lines if not line.lstrip().startswith(">"))
    seq = _STRIP.sub("", body).upper().replace("U", "T")
    if not seq:
        raise SequenceSearchError("Paste a DNA sequence to search for.", "bad_query")
    bad = sorted(set(seq) - set(IUPAC))
    if bad:
        shown = " ".join(repr(c) for c in bad[:6])
        raise SequenceSearchError(f"Not DNA: {shown}. Use A, C, G, T (and IUPAC codes such as N, R, Y).", "bad_query")
    if len(seq) > MAX_QUERY:
        raise SequenceSearchError(f"The sequence is {len(seq):,} bases; the longest searched is {MAX_QUERY:,}.", "bad_query")
    if len(seq) < min_length:
        raise SequenceSearchError(f"The sequence is {len(seq)} bases; search at least {min_length} "
                                  "(shorter ones match too many places).", "bad_query")
    defined = sum(seq.count(b) for b in "ACGT")
    if defined < max(6, len(seq) // 2):
        raise SequenceSearchError("The sequence is mostly ambiguous bases (N and other IUPAC codes); "
                                  "give at least half of it as A, C, G or T.", "bad_query")
    return seq


def has_iupac(seq: str) -> bool:
    return any(c not in "ACGT" for c in seq)


# ---------------------------------------------------------------------------
# The reference


class SearchReference:
    """What a search reads, captured at request time so a job keeps searching the genome that was loaded
    when it started: the reference FASTA as a local file (a downloaded genome's cached copy), the plasmid /
    custom sequences loaded beside it, and the state Identify's genome BLAST database lookup needs."""

    def __init__(self, state):
        self.current_genome = getattr(state, "current_genome", None)
        self.loaded_fasta = getattr(state, "fasta_path", None)
        self.local_fasta = ii.local_reference_fasta(state)
        # Several paired references (services/reference_collection.py): fasta_path names only the first;
        # every FASTA of the collection is searched.
        self.local_fastas = _paired_fastas(state) or ([self.local_fasta] if self.local_fasta else [])
        plasmids = getattr(state, "plasmid_sequences", None)
        self.plasmids = dict(plasmids) if isinstance(plasmids, dict) else {}
        self.reference_id = search_reference_id(state, self.local_fastas)
        # Identify's snapshot: its genome_blast_db resolves primer design's database or the default one.
        self.blast_state = ii.StateSnapshot(state) if self.local_fasta else None

    def blast_states(self) -> list:
        """One Identify snapshot per FASTA (each paired reference has a BLAST database of its own)."""
        if self.blast_state is None:
            return []
        if len(self.local_fastas) <= 1:
            return [self.blast_state]
        import copy
        from services.primer_config import default_blast_db_prefix
        out = []
        used: set[str] = set()
        primer_fasta = getattr(self.blast_state, "primer_fasta", None)
        primer_db = getattr(self.blast_state, "primer_blast_db", None)

        def norm(p: str) -> str:
            return os.path.abspath(os.path.expanduser(p))

        def owns_primer_db(i: int, path: str) -> bool:
            # Primer design's database belongs to its FASTA (or the loaded one): never another paired reference's.
            return bool(primer_db) and (i == 0 if not primer_fasta else norm(primer_fasta) == norm(path))

        # A primer database a reference may resolve to is taken: another reference's default prefix can be that very
        # path (hap1's primer database named after reference.fa, hap2's default named the same), and building there
        # would replace it before either search runs.
        reserved = {norm(primer_db)} if primer_db and any(owns_primer_db(i, p) for i, p in enumerate(self.local_fastas)) else set()
        for i, path in enumerate(self.local_fastas):
            snap = copy.copy(self.blast_state)
            snap.fasta_path = path
            owner = owns_primer_db(i, path)
            # Each FASTA a database prefix of its own: named as a lone reference would be (the loaded one by the
            # genome, others by their file name), with a tag of the file's path when that name is already taken
            # (hap1/reference.fa and hap2/reference.fa), so one build never replaces another.
            prefix = default_blast_db_prefix(self.blast_state, path)
            if norm(prefix) in used or (norm(prefix) in reserved and not owner):
                tag = hashlib.sha256(os.path.abspath(os.path.expanduser(path)).encode()).hexdigest()[:10]
                label = f"{os.path.basename(prefix)}-{tag}"
                prefix = os.path.join(os.path.dirname(os.path.dirname(prefix)), label, label)
            used.add(norm(prefix))
            snap.blast_db_prefix = prefix
            if i > 0 and not (primer_fasta and os.path.abspath(primer_fasta) == os.path.abspath(path)):
                snap.primer_blast_db = None
            out.append(snap)
        return out

    @property
    def has_genome(self) -> bool:
        return bool(self.local_fasta or self.loaded_fasta)

    def check(self) -> None:
        if not self.loaded_fasta and not self.plasmids:
            raise SequenceSearchError(NO_GENOME_MESSAGE, "no_genome")
        if self.loaded_fasta and not self.local_fasta and not self.plasmids:
            raise SequenceSearchError(REMOTE_REFERENCE_MESSAGE, "remote_reference")

    def contigs(self) -> list[tuple[str, int, Callable[[int, int], str]]]:
        """(name, length, fetch(start, end)) per contig: the FASTA's in file order, then loaded plasmids
        (a plasmid named like a FASTA contig is the one the browser shows under that name)."""
        out: list = []
        from services.fasta_handles import ThreadLocalFasta
        for path in self.local_fastas:
            fasta = ThreadLocalFasta(path)
            for name, length in zip(fasta.references, fasta.lengths):
                if name in self.plasmids:
                    continue
                out.append((name, int(length), (lambda f, n: (lambda s, e: f.fetch(n, s, e)))(fasta, name)))
        for name, seq in self.plasmids.items():
            out.append((name, len(seq), (lambda q: (lambda s, e: q[s:e]))(seq)))
        return out


def _paired_fastas(state) -> list[str]:
    """The local FASTAs of a collection of several paired references, in order ([] for one reference)."""
    pairs = getattr(state, "reference_pairs", None)
    if not isinstance(pairs, list) or len(pairs) < 2:
        return []
    paths = [p.get("fasta") for p in pairs if isinstance(p, dict)]
    if not all(isinstance(path, str) and os.path.isfile(path) for path in paths):
        return []
    return paths


def _sequence_reference_id(state) -> str:
    """Identify's reference id without the annotation: hits depend on the sequence only, so reloading or editing
    the genes of the same genome keeps them (Identify's results name genes and keep the annotation in theirs)."""
    fasta = getattr(state, "fasta_path", None) or ""
    try:
        st = os.stat(fasta)
        ref = f"{os.path.abspath(fasta)}:{st.st_size}:{st.st_mtime_ns}"
    except OSError:
        ref = fasta
    text = f"{getattr(state, 'current_genome', None)}|{ii._identity(state)}|{ref}"
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def search_reference_id(state, fastas: list[str]) -> str:
    """The sequence's reference id, extended with every FASTA of a paired-reference collection (``fasta_path``
    names only the first), so replacing a later FASTA marks old results stale and starts a new job."""
    base = _sequence_reference_id(state)
    if len(fastas) <= 1:
        return base
    parts = [base]
    for path in fastas:
        try:
            st = os.stat(path)
            parts.append(f"{os.path.abspath(path)}:{st.st_size}:{st.st_mtime_ns}")
        except OSError:
            parts.append(path)
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Exact / IUPAC scan


CHECK_WORK = 20_000_000          # candidate-position tests (or literal hits) between cancellation checks


def _scan_masks(ref: np.ndarray, query: np.ndarray, order: np.ndarray, max_mm: int,
                check: Callable[[], None] = lambda: None) -> tuple[np.ndarray, np.ndarray]:
    """Start positions in ``ref`` (reference base masks) where ``query`` (query masks) matches with at
    most ``max_mm`` mismatches, and their mismatch counts. Query positions are tested most-specific first
    (``order``) and candidates pruned as they exceed ``max_mm``, so the work after the first few positions
    is on the survivors only. ``check`` (Cancel) is called every ``CHECK_WORK`` tests: a repetitive query
    on a repetitive contig can keep millions of candidates alive through thousands of positions."""
    length = len(query)
    n = len(ref) - length + 1
    if n <= 0:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.uint8)
    head = order[:max_mm + 1]
    if max_mm == 0:
        i = int(head[0])
        idx = np.flatnonzero(ref[i:i + n] & query[i])
        counts = np.zeros(idx.size, dtype=np.uint8)
    else:
        mism = np.zeros(n, dtype=np.uint8)
        for i in head:
            i = int(i)
            mism += (ref[i:i + n] & query[i]) == 0
        idx = np.flatnonzero(mism <= max_mm)
        counts = mism[idx]
    work = 0
    for i in order[len(head):]:
        if not idx.size:
            break
        work += idx.size
        if work >= CHECK_WORK:
            check()
            work = 0
        miss = (ref[idx + int(i)] & query[int(i)]) == 0
        if max_mm == 0:
            idx = idx[~miss]
            counts = counts[~miss]
        else:
            counts = counts + miss
            keep = counts <= max_mm
            idx, counts = idx[keep], counts[keep]
    return idx, counts


def _find_all(text: str, query: str, check: Callable[[], None] = lambda: None) -> np.ndarray:
    """Every start of ``query`` in ``text``, overlapping ones included (``check``: Cancel, now and then)."""
    out = []
    find = text.find
    pos = find(query)
    every = max(1, CHECK_WORK // max(1, len(query)))
    while pos >= 0:
        out.append(pos)
        if len(out) % every == 0:
            check()
        pos = find(query, pos + 1)
    return np.asarray(out, dtype=np.int64)


def _query_masks(seq: str) -> tuple[np.ndarray, np.ndarray]:
    masks = np.array([IUPAC[c] for c in seq], dtype=np.uint8)
    # Most specific first (A/C/G/T before two-base codes before N), then left to right.
    popcount = np.array([bin(int(m)).count("1") for m in masks])
    order = np.lexsort((np.arange(len(masks)), popcount))
    return masks, order


class _HitKeeper:
    """The best ``max_hits`` hits (fewest mismatches first, then in genome order), and the total count."""

    def __init__(self, max_hits: int, max_mm: int):
        self.max_hits = max_hits
        self.by_mm: list[list[dict]] = [[] for _ in range(max_mm + 1)]
        self.total = 0

    def room(self, mm: int) -> int:
        """How many more hits with ``mm`` mismatches could still be among the best ``max_hits``."""
        return self.max_hits - sum(len(b) for b in self.by_mm[:mm + 1])

    def add(self, hit: dict) -> None:
        self.by_mm[hit["mismatches"]].append(hit)

    def hits(self) -> list[dict]:
        out: list[dict] = []
        for bucket in self.by_mm:
            out.extend(bucket)
        return out[:self.max_hits]


def exact_search(seq: str, reference: SearchReference, settings: SearchSettings, *,
                 check: Callable[[], None] = lambda: None,
                 progress: Callable[[str, float], None] = lambda m, f: None) -> dict:
    """Scan both strands of every contig for ``seq`` (IUPAC codes, up to ``max_mismatches`` mismatches)."""
    length = len(seq)
    max_mm = min(int(settings.max_mismatches), max(0, length - 1))
    forward, forward_order = _query_masks(seq)
    rc = reverse_complement(seq)
    palindrome = rc == seq
    strands = [("+", forward, forward_order)]
    if not palindrome:
        reverse, reverse_order = _query_masks(rc)
        strands.append(("-", reverse, reverse_order))
    # A plain A/C/G/T query with no mismatches: str.find (much faster than the mask scan).
    literal = max_mm == 0 and not has_iupac(seq)
    contigs = reference.contigs()
    total_bp = sum(c[1] for c in contigs) or 1
    keeper = _HitKeeper(int(settings.max_hits), max_mm)
    done_bp = 0
    for name, contig_len, fetch in contigs:
        for start in range(0, contig_len, CHUNK):
            check()
            stop = min(contig_len, start + CHUNK)
            text = fetch(start, min(contig_len, stop + length - 1))
            if literal:
                upper = text.upper()
            else:
                ref = _REFERENCE_MASK[np.frombuffer(text.encode("ascii", "replace"), dtype=np.uint8)]
            for strand, query, order in strands:
                if literal:
                    idx = _find_all(upper, seq if strand != "-" else rc, check)
                    counts = np.zeros(idx.size, dtype=np.uint8)
                else:
                    idx, counts = _scan_masks(ref, query, order, max_mm, check)
                inside = idx < (stop - start)  # a start past this chunk is the next chunk's
                idx, counts = idx[inside], counts[inside]
                keeper.total += int(idx.size)
                for mm in range(max_mm + 1):
                    room = keeper.room(mm)
                    if room <= 0 or not idx.size:
                        continue
                    for pos in (idx[counts == mm][:room] if max_mm else idx[:room]).tolist():
                        matched = text[pos:pos + length].upper()
                        keeper.add({
                            "chrom": name, "start": start + pos, "end": start + pos + length,
                            "strand": "." if palindrome else strand,
                            "mismatches": int(mm),
                            "identity": round(100.0 * (length - mm) / length, 2),
                            "evalue": None, "bitscore": None,
                            "qstart": 0, "qend": length,
                            "matched": matched if strand == "+" else reverse_complement(matched),
                        })
            done_bp += stop - start
            progress(f"Scanning {name}", done_bp / total_bp)
    rank = {c[0]: i for i, c in enumerate(contigs)}
    hits = sorted(keeper.hits(), key=lambda h: (h["mismatches"], rank.get(h["chrom"], 0), h["start"]))
    return {"hits": hits, "total": keeper.total, "total_is_lower_bound": False,
            "palindrome": palindrome, "max_mismatches": max_mm}


# ---------------------------------------------------------------------------
# BLAST


def blast_status(reference: Optional[SearchReference] = None) -> dict:
    """Whether BLAST can search the loaded genome here: the tools, and whether its database is built."""
    from services.external_tools import tool_path
    blastn = tool_path("blastn")
    makeblastdb = tool_path("makeblastdb")
    db_ready = False
    if reference is not None and reference.blast_state is not None:
        try:
            for snap in reference.blast_states():
                ii.genome_blast_db(snap, build=False)
            db_ready = True
        except ii.IdentifyError:
            db_ready = False
    available = bool(blastn) and (db_ready or bool(makeblastdb))
    hint = ""
    if not available:
        from services.primer_config import blast_install_message
        hint = blast_install_message()
    return {"available": available, "blastn": bool(blastn), "makeblastdb": bool(makeblastdb),
            "db_ready": db_ready, "hint": hint}


def choose_task(seq: str, settings: SearchSettings, approximate: bool) -> str:
    if settings.blast_task in BLAST_TASKS:
        return settings.blast_task
    if len(seq) < SHORT_TASK_BELOW:
        return "blastn-short"
    return "blastn" if approximate else "megablast"


def blast_search(seq: str, reference: SearchReference, settings: SearchSettings, *, runner, progress,
                 approximate: bool) -> dict:
    """``seq`` against the genome BLAST database (built once if missing, with progress and Cancel)."""
    progress("Finding the genome's BLAST database", 0.02)
    dbs = [ii.genome_blast_db(snap, runner=runner, progress=progress) for snap in reference.blast_states()]
    task = choose_task(seq, settings, approximate)
    progress(f"Searching with BLAST ({task})", 0.5)
    # -max_hsps caps the hits per contig; -max_target_seqs counts contigs. The total is then a lower
    # bound when any contig reached the cap. Paired references: each FASTA's database in turn.
    per_contig = int(settings.max_hits)
    hits = []
    for db in dbs:
        runner.check()
        hits += ii.run_blastn(seq, db, task=task, runner=runner, evalue=float(settings.evalue),
                              max_target_seqs=100_000, max_hsps=per_contig, dust="no")
    by_contig: dict[str, int] = {}
    for h in hits:
        by_contig[h["subject"]] = by_contig.get(h["subject"], 0) + 1
    lower_bound = any(n >= per_contig for n in by_contig.values())
    hits.sort(key=lambda h: (h["evalue"] if h["evalue"] is not None else 1e9, -h["bitscore"]))
    total = len(hits)
    kept = hits[:int(settings.max_hits)]
    progress("Reading the matched sequence", 0.9)
    fetchers = {name: (length, fetch) for name, length, fetch in reference.contigs()} if kept else {}
    out = []
    for h in kept:
        chrom = h["subject"]
        length, fetch = fetchers.get(chrom, (None, None))
        matched, cut = "", False
        if fetch is not None:
            # Kept from the hit's 5' end in query orientation: on the minus strand that is the reference end.
            if h["strand"] == "-":
                begin = max(h["sstart"], h["send"] - MATCHED_SEQ_MAX)
                cut = begin > h["sstart"]
                matched = reverse_complement(fetch(begin, h["send"]).upper())
            else:
                stop = min(h["send"], h["sstart"] + MATCHED_SEQ_MAX)
                cut = stop < h["send"]
                matched = fetch(h["sstart"], stop).upper()
        nident = h.get("nident")
        out.append({
            "chrom": chrom, "start": h["sstart"], "end": h["send"], "strand": h["strand"],
            "mismatches": (h["length"] - nident) if nident is not None else None,
            "identity": h["identity"], "evalue": h["evalue"], "bitscore": h["bitscore"],
            "qstart": h["qstart"], "qend": h["qend"], "matched": matched, "matched_truncated": cut,
        })
    return {"hits": out, "total": total, "total_is_lower_bound": lower_bound, "task": task}


# ---------------------------------------------------------------------------
# Choosing, running


def choose_mode(seq: str, settings: SearchSettings, blast: dict, *, public: bool = False) -> tuple[str, list[str]]:
    """('exact' | 'blast', notes): the search this query gets, and why another was not used."""
    notes: list[str] = []
    wanted = settings.mode
    if wanted == "auto":
        wanted = "exact" if (has_iupac(seq) or len(seq) < settings.exact_max_length) else "blast"
    if wanted == "blast" and not blast.get("available"):
        reason = ("BLAST+ is not available here" + (f" ({blast['hint']})" if blast.get("hint") else "")
                  if not public else "BLAST is not offered on this server")
        if len(seq) > EXACT_HARD_MAX:
            raise SequenceSearchError(f"{reason}, and the exact search takes at most {EXACT_HARD_MAX:,} bases.",
                                      "unavailable")
        notes.append(f"{reason}: used the exact search instead (finds only matches within "
                     f"{settings.max_mismatches} mismatch{'es' if settings.max_mismatches != 1 else ''}).")
        wanted = "exact"
    if wanted == "exact" and len(seq) > EXACT_HARD_MAX:
        raise SequenceSearchError(f"The exact search takes at most {EXACT_HARD_MAX:,} bases; "
                                  "use BLAST for longer sequences.", "bad_query")
    return wanted, notes


def search(seq: str, reference: SearchReference, settings: SearchSettings, *, runner=None,
           progress: Callable[[str, float], None] = lambda m, f: None, public: bool = False) -> dict:
    """Run one search synchronously (the job body; tests call it directly)."""
    runner = runner or ii._Runner()
    reference.check()
    blast = blast_status(reference) if (reference.local_fasta and not public) else {"available": False, "hint": ""}
    mode, notes = choose_mode(seq, settings, blast, public=public)
    if mode == "blast" and reference.plasmids:
        names = ", ".join(sorted(reference.plasmids)[:3]) + ("…" if len(reference.plasmids) > 3 else "")
        notes.append(f"Loaded plasmid sequences ({names}) are not in the genome's BLAST database; "
                     "search them with the exact search.")
    if mode == "exact":
        result = exact_search(seq, reference, settings, check=runner.check, progress=progress)
    else:
        result = blast_search(seq, reference, settings, runner=runner, progress=progress,
                              approximate=settings.mode == "blast")
    total, shown = result["total"], len(result["hits"])
    if total > shown:
        notes.append(f"Showing {shown:,} of {'at least ' if result.get('total_is_lower_bound') else ''}"
                     f"{total:,} hits; raise Max hits to list more.")
    return {
        "schema": SCHEMA, "mode": mode, "query": seq, "query_length": len(seq),
        "genome": reference.current_genome, "reference_id": reference.reference_id,
        "settings": asdict(settings), "notes": notes, **result,
    }


def _owner() -> Optional[str]:
    from services.runtime import lab_owner_key
    return lab_owner_key()


def _job_key(seq: str, settings: SearchSettings, reference: SearchReference, owner: Optional[str] = None) -> str:
    text = "|".join([SCHEMA, hashlib.sha256(seq.encode()).hexdigest(), repr(sorted(asdict(settings).items())),
                     reference.reference_id, repr(sorted(reference.plasmids))]
                    + ([repr(reference.local_fastas)] if len(reference.local_fastas) > 1 else [])
                    + ([f"owner={owner}"] if owner is not None else []))
    return "seqsearch-" + hashlib.sha256(text.encode()).hexdigest()[:24]


def search_request(state, *, sequence: str, settings: Optional[dict] = None, public: bool = False) -> dict:
    """Validate now (a bad query or no genome is answered at once), then search in a background job."""
    try:
        parsed = SearchSettings.from_request(settings)
        seq = normalize_query(sequence, min_length=parsed.min_length)
        reference = SearchReference(state)
        reference.check()
    except SequenceSearchError as exc:
        return {"success": False, "error": str(exc), "code": exc.code}

    def work(runner, progress):
        return search(seq, reference, parsed, runner=runner, progress=progress, public=public)

    owner = _owner()
    # On a lab server each member's workspace gets its own job (and Cancel); identical local searches share one.
    job = ii.start_job("sequence_search", _job_key(seq, parsed, reference, owner), work, persist=False)
    return {"success": True, **job}


def status_payload(state, *, public: bool = False) -> dict:
    reference = SearchReference(state)
    blast = blast_status(reference) if (reference.local_fasta and not public) else {
        "available": False, "blastn": False, "makeblastdb": False, "db_ready": False,
        "hint": "BLAST is not offered on this server" if public else ""}
    problem = None
    try:
        reference.check()
    except SequenceSearchError as exc:
        problem = {"code": exc.code, "message": str(exc)}
    return {
        "success": True, "genome": reference.current_genome, "genome_loaded": reference.has_genome,
        "searchable": problem is None, "problem": problem,
        "plasmids": sorted(reference.plasmids), "reference_id": reference.reference_id,
        "blast": blast, **defaults_payload(),
    }


def get_search_job(job_id: str) -> Optional[dict]:
    """The search ``job_id`` when this request may see it (on a lab server: the member/workspace that started it)."""
    return ii.get_job(job_id, kinds=SEARCH_JOB_KINDS)  # the registry checks the owner


def cancel_search_job(job_id: str) -> bool:
    return ii.cancel_job(job_id, kinds=SEARCH_JOB_KINDS)


SEARCH_JOB_KINDS = ("sequence_search",)


# ---------------------------------------------------------------------------
# Hits as a track / BED


def bed_name(hit: dict, index: int) -> str:
    mm = hit.get("mismatches")
    return f"hit{index + 1}" + (f"_mm{mm}" if mm else "")


def hits_to_bed(hits: list[dict], *, track_name: str = "sequence_search") -> str:
    """BED6: chrom, start, end, name, score (identity x 10), strand."""
    lines = [f'track name="{track_name}" description="FiberBrowser sequence search"']
    for i, h in enumerate(hits):
        score = int(round(min(1000.0, max(0.0, float(h.get("identity") or 0) * 10))))
        lines.append(f"{h['chrom']}\t{h['start']}\t{h['end']}\t{bed_name(h, i)}\t{score}\t{h.get('strand') or '.'}")
    return "\n".join(lines) + "\n"


def add_hits_track(state, job_id: str, *, label: Optional[str] = None) -> dict:
    """The finished job's hits as an annotation track for this session (in memory; never saved in sessions)."""
    job = get_search_job(job_id)
    if job is None or job.get("status") != "done" or not isinstance(job.get("result"), dict):
        return {"success": False, "message": "That search has no results (it may still be running, or the server restarted)."}
    result = job["result"]
    if result.get("reference_id") != SearchReference(state).reference_id:
        return {"success": False, "code": "stale_reference",
                "message": "That search was run on a different reference than the one loaded now; search again."}
    hits = result.get("hits") or []
    if not hits:
        return {"success": False, "message": "No hits to show."}
    intervals: dict[str, list[dict]] = {}
    for i, h in enumerate(hits):
        iv = {"start": int(h["start"]), "end": int(h["end"]), "name": bed_name(h, i),
              "score": int(round(float(h.get("identity") or 0) * 10))}
        if h.get("strand") in ("+", "-"):
            iv["strand"] = h["strand"]
        intervals.setdefault(h["chrom"], []).append(iv)
    query = str(result.get("query") or "")
    name = label or f"Sequence {query[:12]}{'…' if len(query) > 12 else ''} ({len(hits)} hits)"
    path = f"seqsearch://{job_id}"
    tracks = state.orthogonal_tracks
    for index, track in enumerate(tracks):
        if isinstance(track, dict) and track.get("path") == path:
            return {"success": True, "track_index": index, "path": path, "label": track.get("label"), "existing": True}
    tracks.append({"path": path, "label": name, "format": "bed", "render_mode": "annotation",
                   "bed_intervals": intervals, "temporary": True})
    return {"success": True, "track_index": len(tracks) - 1, "path": path, "label": name,
            "message": f"Added {len(hits)} hits as a track"}


def is_temporary_track(track) -> bool:
    return isinstance(track, dict) and bool(track.get("temporary"))

