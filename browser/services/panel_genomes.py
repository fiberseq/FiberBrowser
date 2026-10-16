"""Datasets on another assembly than the main genome, each with its own reference.

A BAM aligned to dm6 opened beside the hg38 demo used to offer only "load dm6",
which replaced hg38 for every panel. Here a dataset can be given a reference
of its own instead: a registry genome (``dm6``), a FASTA (and annotation) the
user picks, or none at all (the chromosomes of the BAM header, e.g. a plasmid
or amplicon; its sequence when the header's ``UR`` FASTA is on this computer).

The main genome stays where it always was (``state.fasta``, ``state.gtf_data``,
``state.chroms`` ...). Every other reference is a context: a bare
``BrowserState`` with only its reference loaded, so the app's own FASTA,
registry and GTF loaders are reused. One context per key, shared by every
dataset on that assembly, dropped when its last dataset goes:

    state.genome_contexts = {"dm6": <BrowserState>, ...}
    state.dataset_genomes = {"dm6_bam": "dm6", ...}

A request carrying ``panel_genome=<key>`` (state/dependencies.get_state) is served
from ``genome_view(state, key)``: the session's state with that context's
reference in place of the main one, so the sequence, genes, gene search,
chromosome list, top-windows and primer endpoints answer for the panel's
assembly without changing them.
"""
from __future__ import annotations

import os
import re
import threading
from typing import Any, Optional

# The reference a context carries (the attributes a view takes from it).
REFERENCE_ATTRS = (
    'gtf_data', 'gtf_path', 'fasta', 'fasta_path', 'fasta_error', 'reference_pairs',
    'chroms', 'chrom_map', 'current_genome', 'circular_chroms',
    'plasmid_sequences', 'plasmid_metadata', '_gtf_reference_lengths',
    # The registry genome whose download is this reference's FASTA (services/genome_loading).
    'registry_fasta',
    # Primer design reads the primer FASTA / BLAST database the main genome
    # was set up with: a panel on another assembly must not use them.
    'primer_fasta', 'primer_blast_db',
)
MAIN = 'main'
# One change to the references at a time (key choice, loading, assignment, pruning).
from services.lock_order import REGISTRY as _REGISTRY_LEVEL, OrderedLock as _OrderedLock
_LOCK = _OrderedLock(_REGISTRY_LEVEL, "panel_genomes._LOCK")  # level 3 (services/lock_order)
_KEY_RE = re.compile(r'[^A-Za-z0-9_.-]+')


class GenomeUnavailable(LookupError):
    """``panel_genome=<key>`` names no loaded reference."""


# ---------------------------------------------------------------------------
# Per-state registries (a forked session may predate them: read with getattr)
# ---------------------------------------------------------------------------

def contexts(state) -> dict:
    found = getattr(state, '__dict__', {}).get('genome_contexts')
    if found is None:
        found = {}
        try:
            object.__setattr__(state, 'genome_contexts', found)
        except Exception:
            pass
    return found


def assignments(state) -> dict:
    found = getattr(state, '__dict__', {}).get('dataset_genomes')
    if found is None:
        found = {}
        try:
            object.__setattr__(state, 'dataset_genomes', found)
        except Exception:
            pass
    return found


def start_loci(state) -> dict:
    """dataset id -> {'key', 'locus'}: where its panel opens on its own reference
    (its best-covered window, found when it was given the reference). A window
    opened later (a fresh browser profile) starts its panels there too (audit L12)."""
    found = getattr(state, '__dict__', {}).get('panel_genome_loci')
    if found is None:
        found = {}
        try:
            object.__setattr__(state, 'panel_genome_loci', found)
        except Exception:
            pass
    return found


def dataset_genome(state, dataset_id: Optional[str]) -> Optional[str]:
    """The key of the dataset's own reference, or None (the main genome)."""
    if not dataset_id:
        return None
    key = assignments(state).get(dataset_id)
    return key if key in contexts(state) else None


# ---------------------------------------------------------------------------
# The view a request with ``panel_genome=<key>`` is served from
# ---------------------------------------------------------------------------

def _view_class():
    from state.browser_state import BrowserState

    global _VIEW_CLASS
    if _VIEW_CLASS is None:
        class GenomeView(BrowserState):
            """The session's state with another reference in place of the main one.

            ``__dict__`` is a shallow copy of the base state's (its datasets,
            caches and settings are the same objects), with the reference
            attributes taken from the context. Attribute writes go through to
            the base state (reference attributes to the context), so nothing an
            endpoint stores is lost when the request ends.
            """

            def __setattr__(self, name, value):
                d = self.__dict__
                if name in REFERENCE_ATTRS:
                    # The shared context only: the view keeps no copy (reads go to the context, live).
                    setattr(d['_genome_context'], name, value)
                    return
                setattr(d['_genome_base'], name, value)
                object.__setattr__(self, name, value)

            def __getattr__(self, name):
                # Reference attributes are never copied into the view: read live from the context, so a
                # request that waited for the context's reference lock sees what the previous load left.
                if name in REFERENCE_ATTRS:
                    return getattr(self.__dict__['_genome_context'], name, None)
                # Not copied (set on the base after the view was made, or a
                # template-routed attribute of a forked session): ask the base.
                if name.startswith('__'):
                    raise AttributeError(name)
                return getattr(self.__dict__['_genome_base'], name)

        _VIEW_CLASS = GenomeView
    return _VIEW_CLASS


_VIEW_CLASS = None


def is_view(state) -> bool:
    return _VIEW_CLASS is not None and isinstance(state, _VIEW_CLASS)


def genome_view(state, key: Optional[str]):
    """``state`` for ``panel_genome=<key>``: itself for the main genome, else a view
    with that context's reference. Raises GenomeUnavailable for an unknown key."""
    if not key or key == MAIN:
        return state
    ctx = contexts(state).get(key)
    if ctx is None:
        # The main genome named by its id (a panel saved before a switch).
        if key == getattr(state, 'current_genome', None):
            return state
        raise GenomeUnavailable(key)
    cls = _view_class()
    view = object.__new__(cls)
    d = dict(state.__dict__)
    for name in REFERENCE_ATTRS:
        d.pop(name, None)  # read live from the context (GenomeView.__getattr__)
    d['_genome_base'] = state
    d['_genome_context'] = ctx
    d['_genome_key'] = key
    view.__dict__.update(d)
    return view


def mixed_references(state, dataset_ids) -> bool:
    """These datasets are on more than one reference (the main genome counts as one)."""
    if is_view(state):
        return False
    ids = [d for d in (dataset_ids or []) if d]
    if not ids:
        ids = list(getattr(state, 'dataset_order', None) or [])
    return len({dataset_genome(state, d) for d in ids}) > 1


def for_datasets(state, dataset_ids) -> Any:
    """The state an analysis of these datasets reads its reference from: their
    own reference's view when they all have the same one, else ``state``.
    (Footprint sequences and motif species, DAF evidence contexts.)"""
    if is_view(state):
        return state
    ids = [d for d in (dataset_ids or []) if d]
    if not ids:
        return state
    keys = {dataset_genome(state, d) for d in ids}
    if len(keys) != 1:
        return state
    (key,) = keys
    return genome_view(state, key) if key else state


# ---------------------------------------------------------------------------
# Loading a reference into a context
# ---------------------------------------------------------------------------

def _empty_context():
    from state.browser_state import BrowserState
    # Reference loaders reuse this state; analyses use the owning workspace's
    # view. Loading a FASTA must not reset machine budgets or Auto's browser tier.
    ctx = BrowserState(None, reference_only=True)
    object.__setattr__(ctx, '_panel_context', True)  # its lock is a context lock (services/lock_order)
    return ctx


def _context_info(key: str, ctx) -> dict:
    gtf = getattr(ctx, 'gtf_data', None)
    transcripts = gtf.get('transcripts') if isinstance(gtf, dict) else None
    spec = getattr(ctx, '_panel_genome_spec', None) or {}
    chroms = list(getattr(ctx, 'chroms', None) or [])
    return {
        'key': key,
        'label': spec.get('label') or key,
        'kind': spec.get('kind'),
        'genome_id': spec.get('genome_id'),
        'assembly': spec.get('assembly'),
        'fasta_path': getattr(ctx, 'fasta_path', None),
        'gtf_path': getattr(ctx, 'gtf_path', None),
        'has_fasta': getattr(ctx, 'fasta', None) is not None,
        'has_gtf': transcripts is not None and len(transcripts) > 0,
        'gene_count': int(len(transcripts)) if transcripts is not None else 0,
        'n_chroms': len(chroms),
        'chroms': [{'name': c.name, 'size': int(c.size), 'circular': bool(getattr(c, 'circular', False))}
                   for c in chroms[:2000]],
    }


def _stem(path: str) -> str:
    base = os.path.basename(str(path).split('?', 1)[0])
    for ext in ('.fa.gz', '.fasta.gz', '.fna.gz', '.fa', '.fasta', '.fna'):
        if base.lower().endswith(ext):
            return base[: -len(ext)]
    return base


def _unique_key(state, wanted: str, same) -> str:
    """``wanted``, or ``wanted-2``... when another reference already has that key."""
    existing = contexts(state)
    key = wanted
    n = 2
    while key in existing and not same(existing[key]):
        key = f'{wanted}-{n}'
        n += 1
    return key


def _load_registry(genome_id: str):
    from services.genome_loading import load_genome_blocking
    from services.genome_registry import GENOME_REGISTRY
    from services.runtime import allow_shared_writes

    info = GENOME_REGISTRY[genome_id]
    ctx = _empty_context()
    with allow_shared_writes():
        result = load_genome_blocking(ctx, genome_id, info)
    if not result.get('success'):
        raise RuntimeError(result.get('fasta_error') or result.get('gtf_error') or f'Could not load {genome_id}')
    from services.assembly_fingerprint import short_name
    ctx._panel_genome_spec = {'kind': 'registry', 'genome_id': genome_id, 'assembly': genome_id,
                              'label': genome_id, 'source': {'genome_id': genome_id},
                              'default_gtf_path': getattr(ctx, 'gtf_path', None),
                              'name': info.get('name') or short_name(genome_id)}
    return ctx


def _load_fasta_context(fasta_path: str, gtf_path: Optional[str]):
    ctx = _empty_context()
    err = ctx._load_fasta(fasta_path)
    if err:
        raise RuntimeError(err)
    if gtf_path:
        from services.gene_annotations import load_gtf
        ctx.gtf_data = load_gtf(gtf_path)
        ctx.gtf_path = gtf_path
    label = _stem(fasta_path)
    from services.genome_check import loaded_reference
    assembly = loaded_reference(ctx).get('assembly')
    ctx._panel_genome_spec = {'kind': 'fasta', 'genome_id': None, 'assembly': assembly, 'label': label,
                              'source': {'fasta_path': fasta_path, **({'gtf_path': gtf_path} if gtf_path else {})}}
    # A reference a plugin pack built: named for what it is, however it is attached.
    from plugins.packs import run_hooks
    run_hooks("fasta_context", ctx, fasta_path)
    return ctx


def _header_fasta(dataset) -> Optional[str]:
    """The FASTA a BAM header's ``UR`` names, when it is on this computer (with its index)."""
    from services.remote_sources.opening import open_alignment_file
    for path in (getattr(dataset, 'paths', None) or [getattr(dataset, 'path', '')]):
        from services.signed_urls import split_index
        if not split_index(str(path))[0].lower().split('?', 1)[0].endswith(('.bam', '.cram', '.sam')):
            continue
        try:
            with open_alignment_file(path, 'rb', check_sq=False) as bam:
                for sq in bam.header.to_dict().get('SQ', []):
                    ur = str(sq.get('UR') or '')
                    if ur.startswith('file:'):
                        ur = ur[5:]
                    if ur and os.path.isfile(ur) and os.path.isfile(ur + '.fai'):
                        return ur
        except Exception:
            continue
    return None


def _load_contigs_context(state, dataset_id: str):
    """No reference: the dataset's own contigs (and the header's FASTA when it is here)."""
    from models.domain import ChromInfo
    from services.genome_check import dataset_header
    from utils.chrom import build_chrom_map

    dataset = state.datasets[dataset_id]
    ctx = _empty_context()
    fasta = _header_fasta(dataset)
    if fasta and ctx._load_fasta(fasta) is None:
        kind = 'header_fasta'
    else:
        header = dataset_header(dataset)
        if not header['contigs']:
            raise RuntimeError(header.get('error') or 'No contigs in the file header')
        chroms = [ChromInfo(name=c.name, size=int(c.length)) for c in header['contigs']]
        ctx.chroms = chroms
        ctx.chrom_map = build_chrom_map(chroms)
        kind = 'contigs'
    label = str(getattr(dataset, 'label', None) or dataset_id)
    ctx._panel_genome_spec = {'kind': kind, 'genome_id': None, 'assembly': None,
                              'label': f'{label} contigs', 'source': {'contigs': True, 'dataset_id': dataset_id}}
    return ctx


def _same_source(ctx, source: dict) -> bool:
    spec = getattr(ctx, '_panel_genome_spec', None) or {}
    current = dict(spec.get('source') or {})
    if current.get('fasta_path'):
        current.pop('gtf_path', None)
        if getattr(ctx, 'gtf_path', None):
            current['gtf_path'] = ctx.gtf_path
    return current == source


def attach(state, dataset_ids: list[str], *, genome_id: Optional[str] = None,
           fasta_path: Optional[str] = None, gtf_path: Optional[str] = None,
           contigs: bool = False, span: int = 10_000, key: Optional[str] = None) -> dict:
    """Give these datasets their own reference; returns it and where each one's reads are.

    ``key``: the key to use for a FASTA or contigs reference (a session's
    own, so its panels find it again), unless another reference has it."""
    # Loading a reference (a registry download, a FASTA, a header) happens before the registry lock: _LOCK is
    # process-wide and every session's dataset removal / prune waits on it, so it is held only for bookkeeping.
    key_hint, force = key, False
    while True:
        prepared = _prepare_context(state, dataset_ids, genome_id=genome_id, fasta_path=fasta_path,
                                    gtf_path=gtf_path, contigs=contigs, force=force)
        with _LOCK:
            try:
                key, main = _attach_locked(state, dataset_ids, genome_id=genome_id, fasta_path=fasta_path,
                                           gtf_path=gtf_path, contigs=contigs, key_hint=key_hint, prepared=prepared)
            except _NeedsContext:
                # The context it saw went away before this commit (its last dataset detached): load it again,
                # outside the lock, and retry. Never loaded under _LOCK.
                force = True
                continue
            info = None if main else _context_info(key, contexts(state)[key])
            break
    loci = _loci(state, None if main else key, dataset_ids, span) if span else {}
    if not main:
        with _LOCK:
            remembered = start_loci(state)
            for dataset_id, locus in loci.items():
                if assignments(state).get(dataset_id) == key:
                    remembered[dataset_id] = {'key': key, 'locus': dict(locus)}
    return {'success': True, 'genome': info, 'main': main, 'loci': loci}


class _NeedsContext(Exception):
    """_attach_locked needs a context nobody prepared (no loading under _LOCK)."""


def _prepare_context(state, dataset_ids, *, genome_id, fasta_path, gtf_path, contigs, force=False):
    """The context ``attach`` would create, loaded outside the registry lock, or None when none is needed
    (the main genome, a reference this session already has, nothing valid asked: ``_attach_locked`` decides)."""
    datasets = getattr(state, 'datasets', {}) or {}
    if not dataset_ids or any(d not in datasets for d in dataset_ids):
        return None
    if genome_id:
        from services.genome_registry import GENOME_REGISTRY
        if genome_id not in GENOME_REGISTRY or genome_id == getattr(state, 'current_genome', None):
            return None
        with _LOCK:
            if genome_id in contexts(state) and not force:
                return None
        return _load_registry(genome_id)
    if fasta_path:
        source = {'fasta_path': fasta_path, **({'gtf_path': gtf_path} if gtf_path else {})}
        with _LOCK:
            if any(_same_source(c, source) for c in contexts(state).values()) and not force:
                return None
        return _load_fasta_context(fasta_path, gtf_path)
    if contigs and len(dataset_ids) == 1:
        return _load_contigs_context(state, dataset_ids[0])
    return None


def _attach_locked(state, dataset_ids, *, genome_id, fasta_path, gtf_path, contigs, key_hint, prepared=None):
    datasets = getattr(state, 'datasets', {}) or {}
    missing = [d for d in dataset_ids if d not in datasets]
    if missing:
        raise KeyError(f"Dataset not found: {', '.join(missing)}")
    if not dataset_ids:
        raise ValueError('No dataset given')
    ctxs = contexts(state)
    if genome_id:
        from services.genome_registry import GENOME_REGISTRY
        if genome_id not in GENOME_REGISTRY:
            raise KeyError(f'Unknown genome: {genome_id}')
        if genome_id == getattr(state, 'current_genome', None):
            # It is the main genome: the datasets simply follow it.
            for dataset_id in dataset_ids:
                assignments(state).pop(dataset_id, None)
            prune(state)
            return None, True
        key = genome_id
        if key not in ctxs:
            if prepared is None:
                raise _NeedsContext(key)
            ctxs[key] = prepared
    elif fasta_path:
        source = {'fasta_path': fasta_path, **({'gtf_path': gtf_path} if gtf_path else {})}
        wanted = key_hint if key_hint and key_hint.startswith('fasta:') else 'fasta:' + _KEY_RE.sub('_', _stem(fasta_path))
        key = _unique_key(state, wanted, lambda c: _same_source(c, source))
        if key not in ctxs:
            if prepared is None:
                raise _NeedsContext(key)
            ctxs[key] = prepared
    elif contigs:
        if len(dataset_ids) != 1:
            raise ValueError("A dataset's own contigs are for that dataset only")
        source = {'contigs': True, 'dataset_id': dataset_ids[0]}
        wanted = key_hint if key_hint and key_hint.startswith('contigs:') else 'contigs:' + _KEY_RE.sub('_', dataset_ids[0])
        key = _unique_key(state, wanted, lambda c: _same_source(c, source))
        if key not in ctxs:
            if prepared is None:
                raise _NeedsContext(key)
            ctxs[key] = prepared
    else:
        raise ValueError('Say which reference: genome_id, fasta_path or contigs')
    for dataset_id in dataset_ids:
        assignments(state)[dataset_id] = key
    prune(state)
    return key, False


def _loci(state, key: Optional[str], dataset_ids: list[str], span: int) -> dict:
    """Each dataset's best-covered window on its reference (where its panel opens)."""
    from services.random_window import top_covered_windows
    view = genome_view(state, key)
    out = {}
    for dataset_id in dataset_ids:
        try:
            found = top_covered_windows(view, span=max(100, int(span)), dataset_id=dataset_id, n=1, fit=True)
            windows = found.get('windows') or []
            if windows:
                w = windows[0]
                out[dataset_id] = {'chrom': w['chrom'], 'start': int(w['start']), 'end': int(w['end'])}
        except Exception:
            continue
    return out


def detach(state, dataset_ids: list[str]) -> dict:
    with _LOCK:
        for dataset_id in dataset_ids:
            assignments(state).pop(dataset_id, None)
        dropped = prune(state)
        return {'success': True, 'dropped': dropped}


def prune(state) -> list[str]:
    """Close the references no dataset uses any more (frees their memory)."""
    with _LOCK:
        used = set(assignments(state).values())
        datasets = getattr(state, 'datasets', {}) or {}
        for dataset_id in list(assignments(state)):
            if dataset_id not in datasets:
                assignments(state).pop(dataset_id, None)
        remembered = start_loci(state)
        for dataset_id, entry in list(remembered.items()):
            if assignments(state).get(dataset_id) != entry.get('key'):
                remembered.pop(dataset_id, None)  # closed, or on another reference now
        used = set(assignments(state).values())
        dropped = []
        ctxs = contexts(state)
        for key in list(ctxs):
            if key in used:
                continue
            ctx = ctxs.pop(key)
            dropped.append(key)
            handle = getattr(ctx, 'fasta', None)
            if handle is not None:
                try:
                    handle.close()
                except Exception:
                    pass
        return dropped


def release_main_genome(state) -> list[str]:
    """The main genome is now a registry genome some datasets had as their own:
    they use the main one, and that second copy is closed."""
    with _LOCK:
        current = getattr(state, 'current_genome', None)
        if not current:
            return []
        released = [d for d, k in assignments(state).items() if k == current]
        for dataset_id in released:
            assignments(state).pop(dataset_id, None)
        prune(state)
        return released


def clear(state) -> None:
    """Forget every own reference (a session import replaces them)."""
    with _LOCK:
        assignments(state).clear()
        prune(state)


def payload(state) -> dict:
    """``GET /api/panel_genomes``: the references besides the main one and who uses them."""
    with _LOCK:
        return _payload(state)


def _payload(state) -> dict:
    ctxs = contexts(state)
    owners: dict[str, list[str]] = {}
    for dataset_id, key in assignments(state).items():
        if key in ctxs:
            owners.setdefault(key, []).append(dataset_id)
    return {
        'main': {'genome_id': getattr(state, 'current_genome', None),
                 'fasta_path': getattr(state, 'fasta_path', None)},
        'genomes': [{**_context_info(key, ctx), 'datasets': owners.get(key, [])} for key, ctx in ctxs.items()],
        'datasets': {d: k for d, k in assignments(state).items() if k in ctxs},
        # Where a panel with no locus on its reference yet opens (a fresh window).
        'loci': {d: dict(entry['locus']) for d, entry in start_loci(state).items()
                 if entry.get('key') in ctxs and assignments(state).get(d) == entry.get('key')},
    }


# ---------------------------------------------------------------------------
# A track file on another assembly than the main genome
# ---------------------------------------------------------------------------

def _reference_fit(chroms, contigs: dict) -> float:
    """The share of a track's data (weights) on a reference's chromosomes, at
    coordinates that fit them (a size that matches, an end within the length)."""
    from utils.chrom import normalize_chrom_name
    sizes: dict[str, int] = {}
    for c in chroms or []:
        name = getattr(c, 'name', None)
        if name is None:
            continue
        size = int(getattr(c, 'size', 0) or 0)
        sizes.setdefault(str(name), size)
        sizes.setdefault('~' + normalize_chrom_name(str(name)), size)
    total = fit = 0.0
    for name, info in contigs.items():
        weight = float(info.get('weight') or 0)
        total += weight
        size = sizes.get(name, sizes.get('~' + normalize_chrom_name(name)))
        if size is None:
            continue
        if info.get('size') and size and int(info['size']) != size:
            continue  # same name, another assembly (chrX of dm6 is not chrX of hg38)
        ends = info.get('ends')
        if ends is not None and size and weight:
            # BED: each interval within the chromosome counts (one past its end doesn't sink the rest).
            fit += weight * sum(1 for end in ends if int(end) <= size) / max(1, len(ends))
            continue
        fit += weight
    return fit / total if total else 1.0


def _main_reference_name(state) -> str:
    genome = getattr(state, 'current_genome', None)
    if genome:
        return str(genome)
    fasta = getattr(state, 'fasta_path', None)
    return _stem(fasta) if fasta else 'the loaded reference'


def track_reference_warning(state, name: str, contigs: dict) -> Optional[str]:
    """A warning when a track's chromosomes are not the main genome's (None: they are).

    ``contigs``: chromosome -> {'weight': how much of the track is there (BED
    intervals, or a bigWig's chromosome length), 'ends': the BED intervals'
    ends, or 'size': the file's length for it}. Tracks are drawn in the main view, so a
    dm6 BED added while hg38 is the main genome shows nothing (audit L11). The
    panel references (``dm6`` for a dataset's own panel) it does fit are named.
    """
    if is_view(state) or not contigs:
        return None
    main_chroms = list(getattr(state, 'chroms', None) or [])
    if not main_chroms or _reference_fit(main_chroms, contigs) >= 0.5:
        return None
    from utils.chrom import normalize_chrom_name
    main_names = {normalize_chrom_name(str(c.name)) for c in main_chroms}
    by_weight = sorted(contigs, key=lambda c: (-float(contigs[c].get('weight') or 0), c))
    missing = [c for c in by_weight if normalize_chrom_name(c) not in main_names]
    shown = missing[:3] or by_weight[:3]
    listed = ', '.join(shown) + (', …' if len(missing) > 3 else '')
    main = _main_reference_name(state)
    with _LOCK:
        others = [_context_info(key, ctx)['label'] for key, ctx in contexts(state).items()
                  if _reference_fit(getattr(ctx, 'chroms', None), contigs) >= 0.5]
    if not missing:
        if any(info.get('size') for info in contigs.values()):
            return (f"{name}: its chromosomes ({listed}) have other lengths than on {main}, the main genome: "
                    "it was made for another assembly, so what it shows there is misplaced.")
        return (f"{name}: most of its intervals lie past the ends of {main}'s chromosomes ({listed}): "
                "was it made for another assembly?")
    if others:
        where = ' or '.join(others)
        return (f"{name}: its chromosomes ({listed}) are not on {main}, the main genome; they match {where}. "
                f"Tracks are drawn in the main view, so it shows nothing until {where} is the main genome.")
    return (f"{name}: its chromosomes ({listed}) are not on {main}, the main genome, so it shows nothing there. "
            "Was it made for another assembly?")


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def session_export(state, portable=lambda p: p) -> Optional[dict]:
    ctxs = contexts(state)
    if not assignments(state) or not ctxs:
        return None
    specs = {}
    for key, ctx in ctxs.items():
        spec = getattr(ctx, '_panel_genome_spec', None) or {}
        source = dict(spec.get('source') or {})
        # A reference a plugin pack or a core feature built (its contig): marked, so the session's file check leaves
        # it to what rebuilds it.
        for marker in ('pack', 'built_by'):
            if spec.get(marker):
                source[marker] = spec[marker]
        # Annotation and topology can be edited after the reference was attached.
        annotation = getattr(ctx, 'gtf_path', None)
        # Registry defaults are downloaded on restore; only overrides need a file path.
        if annotation and annotation != spec.get('default_gtf_path'):
            source['gtf_path'] = annotation
        source['circular_chroms'] = dict(getattr(ctx, 'circular_chroms', None) or {})
        for name in ('fasta_path', 'gtf_path'):
            if source.get(name):
                source[name] = portable(source[name])
        specs[key] = source
    out = {'contexts': specs, 'datasets': {d: k for d, k in assignments(state).items() if k in ctxs}}
    # Where each panel starts in a window opened later (restored with the session).
    loci = {d: dict(entry['locus']) for d, entry in start_loci(state).items()
            if entry.get('key') in ctxs and assignments(state).get(d) == entry.get('key')}
    if loci:
        out['loci'] = loci
    return out


def _restore_start_loci(state, saved_loci: Any, dataset_ids: list[str]) -> None:
    """The saved start windows of these datasets, on the reference they have now."""
    if not isinstance(saved_loci, dict):
        return
    with _LOCK:
        ctxs = contexts(state)
        for dataset_id in dataset_ids:
            locus = saved_loci.get(dataset_id)
            key = assignments(state).get(dataset_id)
            ctx = ctxs.get(key) if key else None
            if not isinstance(locus, dict) or ctx is None:
                continue
            try:
                chrom, start, end = str(locus['chrom']), int(locus['start']), int(locus['end'])
            except (KeyError, TypeError, ValueError):
                continue
            size = next((int(c.size) for c in (getattr(ctx, 'chroms', None) or []) if c.name == chrom), None)
            # On that reference and within its chromosome (a relinked, shorter FASTA: the fallback).
            if size is not None and 0 <= start < end <= size:
                start_loci(state)[dataset_id] = {'key': key, 'locus': {'chrom': chrom, 'start': start, 'end': end}}


def session_restore(state, saved: Any) -> dict:
    """Re-attach the saved datasets to their references. Problems are reported, never raised."""
    clear(state)
    if not isinstance(saved, dict):
        return {'restored': 0, 'failed': []}
    specs = saved.get('contexts') or {}
    by_key: dict[str, list[str]] = {}
    for dataset_id, key in (saved.get('datasets') or {}).items():
        if dataset_id in (getattr(state, 'datasets', {}) or {}):
            by_key.setdefault(str(key), []).append(dataset_id)
    restored, failed = 0, []
    for key, dataset_ids in by_key.items():
        source = specs.get(key) or {}
        try:
            if source.get('genome_id'):
                result = attach(state, dataset_ids, genome_id=source['genome_id'], span=0)
            elif source.get('fasta_path'):
                result = attach(state, dataset_ids, fasta_path=source['fasta_path'],
                                gtf_path=source.get('gtf_path'), span=0, key=key)
            elif source.get('contigs'):
                result = attach(state, dataset_ids[:1], contigs=True, span=0, key=key)
            else:
                raise ValueError('no reference recorded')
            restored_key = assignments(state).get(dataset_ids[0])
            ctx = contexts(state).get(restored_key)
            if ctx is not None:
                annotation = source.get('gtf_path')
                from services.genome_loading import reference_lock
                gtf = None
                if annotation and annotation != getattr(ctx, 'gtf_path', None):
                    from services.gene_annotations import load_gtf
                    gtf = load_gtf(annotation)        # parsed outside the context's lock
                with reference_lock(ctx):
                    if gtf is not None:
                        ctx.gtf_data = gtf
                        ctx.gtf_path = annotation
                    if isinstance(source.get('circular_chroms'), dict):
                        ctx.circular_chroms = dict(source['circular_chroms'])
                        ctx.refresh_circular_chrom_flags()
            restored += len(dataset_ids) if result.get('success') else 0
            _restore_start_loci(state, saved.get('loci'), dataset_ids)
        except Exception as exc:
            failed.append({'genome': key, 'datasets': dataset_ids, 'error': str(exc)})
    return {'restored': restored, 'failed': failed}
