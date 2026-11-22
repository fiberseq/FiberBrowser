"""Meta-locus (pooled loci) for headless figures, re-clustering and numbers.

A meta-locus is a BED file's sites pooled into one virtual contig ``meta:<pool>`` (services/meta_locus_jobs): every
read of a site's window, minus-strand sites flipped, shown on [0, 2 x flank) with the axis -flank..+flank around the
anchor. The browser shows it through the ordinary read routes, and so does the headless engine: this module only
finds (or builds) the pool, gives the figure a view of its own and renames a saved session's contig.

Where the pool comes from
    * a spec: ``{bed, anchor (start | centre | end, strand-aware), flank_bp, datasets, seed, count}``, plus the other
      pool rules the browser's Open dialog sends (policy, count_unit) and a session's added reads (extra_entries);
    * an existing ``pool_id`` (with seed / count for its view);
    * a session saved on a ``meta:<pool>`` view: its ``frontend.metaLocus`` block (the browser's session payload).
      The pool is rebuilt or reused from the saved spec; a missing BED fails loudly and names the path-remap helper.

The view
    The pool's own view (what an open browser tab shows) is never changed. The figure draws a view clone
    (``meta_locus_jobs.view_clone``) with the asked seed, count and added reads, which is exactly the working set the
    browser shows for the same pool, seed and count (tests/test_headless_meta_locus.py checks the read ids).

The observation unit is the read-site pair, as in the browser: a read overlapping two sites' windows is a row in each
(its id then carries ``#site<N>``).
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional

ANCHORS = ("start", "centre", "end")
ANCHOR_ALIASES = {"center": "centre", "tss": "start", "middle": "centre"}
DEFAULT_WAIT_S = 900.0

# How the headless path treats each field of the browser's meta-locus session payload (metaLocusSessionPayload in
# frontend/src/features/metaLocus/metaLocusStore.ts). The drift test (frontend .../metaLocus/headlessCoverage.test.ts
# and tests/test_headless_meta_locus_drift.py) fails when the browser saves a field that is in neither table.
SESSION_FIELDS_HANDLED = {
    "bed_path": "the pool's BED (rebuilt or reused; missing: a loud error naming the remap helper)",
    "name": "the pool's name (axis label)",
    "anchor": "the pool's anchor (start / centre / end, strand-aware)",
    "flank_bp": "the pool's window (axis -flank..+flank)",
    "policy": "the pool's per-site / nearest rule",
    "count_unit": "kept in the receipt; the drawn unit is always the read-site pair, as in the browser view",
    "dataset_ids": "the pooled datasets",
    "seed": "the working set's seed",
    "count": "the working set's size",
    "extra_entries": "reads Find more / Keep workspace full added (drawn too)",
    "pool_id": "the saved contig's id: renamed to the rebuilt pool's id everywhere in the session",
}
SESSION_FIELDS_NOT_DRAWN = {
    "lastRealLocus": "where the browser's Back button returns to; not part of the meta-locus view",
}

# The meta-locus spec of a figure / numbers request (BrowserClient.figure(meta_locus=...), fiberbrowser render --bed).
SPEC_FIELDS = ("bed", "bed_path", "regions", "name", "anchor", "flank_bp", "datasets", "dataset_ids", "seed", "count",
               "policy", "count_unit", "extra_entries", "pool_id", "window", "wait_s", "min_overlap_bp", "anchor_mark")


class MetaLocusError(ValueError):
    """A meta-locus request that cannot be met (missing BED, unknown pool, a pool that failed to build)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def meta_hidden_track(kind: str, metaprofile_composite: bool = False) -> bool:
    """metaHiddenTrack (frontend/src/features/metaLocus/metaChrom.ts): rows that need a real genome position are left
    out quietly on the meta contig. Metaprofiles (computed from the reads) stay."""
    if kind in ("sequence", "gene", "primer", "microc", "sv", "capture"):
        return True
    if kind.startswith("ortho-"):
        return True
    if kind.startswith("composite-"):
        return not metaprofile_composite
    return False


def is_meta_chrom(chrom) -> bool:
    return isinstance(chrom, str) and chrom.startswith("meta:")


def anchor_word(anchor: Optional[str]) -> str:
    """anchorWord (metaChrom.ts)."""
    return {"start": "TSS", "end": "end"}.get(str(anchor or ""), "centre")


def normalize_spec(raw: Any) -> dict:
    """A meta-locus spec from a request (dict, or a pool id string)."""
    if raw is None:
        return {}
    if isinstance(raw, str):
        raw = {"pool_id": raw}
    if not isinstance(raw, dict):
        raise MetaLocusError("meta_locus must be an object ({bed, anchor, flank_bp, ...}) or a pool id")
    unknown = sorted(set(raw) - set(SPEC_FIELDS))
    if unknown:
        raise MetaLocusError(f"meta_locus: unknown field(s) {', '.join(unknown)}; known: {', '.join(SPEC_FIELDS)}")
    spec = {k: v for k, v in raw.items() if v is not None}
    if "bed_path" in spec and "bed" not in spec:
        spec["bed"] = spec.pop("bed_path")
    spec.pop("bed_path", None)
    if "datasets" in spec and "dataset_ids" not in spec:
        spec["dataset_ids"] = spec.pop("datasets")
    spec.pop("datasets", None)
    if isinstance(spec.get("dataset_ids"), str):
        spec["dataset_ids"] = [d for d in spec["dataset_ids"].replace(",", " ").split() if d]
    if "anchor" in spec:
        a = ANCHOR_ALIASES.get(str(spec["anchor"]).lower(), str(spec["anchor"]).lower())
        if a not in ANCHORS:
            raise MetaLocusError("meta_locus anchor must be start, centre or end")
        spec["anchor"] = a
    for key in ("flank_bp", "seed", "count", "min_overlap_bp"):
        if key in spec:
            try:
                spec[key] = int(spec[key])
            except (TypeError, ValueError):
                raise MetaLocusError(f"meta_locus {key} must be an integer") from None
    if "count" in spec and not 0 < spec["count"] <= 200_000:
        raise MetaLocusError("meta_locus count must be 1..200,000")
    if "window" in spec:
        w = spec["window"]
        if not (isinstance(w, (list, tuple)) and len(w) == 2) or int(w[1]) <= int(w[0]):
            raise MetaLocusError("meta_locus window must be [from, to] on the relative axis (bp from the anchor)")
        spec["window"] = [int(w[0]), int(w[1])]
    if not (spec.get("bed") or spec.get("regions") or spec.get("pool_id")):
        raise MetaLocusError("meta_locus needs bed (a BED path), regions or pool_id")
    return spec


def session_meta(session: Optional[dict]) -> Optional[dict]:
    """The saved meta-locus of a session whose view is on a meta contig (None otherwise)."""
    if not isinstance(session, dict):
        return None
    fe = session.get("frontend") if isinstance(session.get("frontend"), dict) else {}
    viewport = session.get("viewport") if isinstance(session.get("viewport"), dict) else {}
    chrom = viewport.get("chrom") or fe.get("chrom")
    saved = fe.get("metaLocus")
    if not is_meta_chrom(chrom):
        return None
    if not isinstance(saved, dict) or not saved.get("bed_path"):
        raise MetaLocusError(
            f"The session's view is on a meta-locus ({chrom}) but it saved no meta-locus spec (frontend.metaLocus "
            "with bed_path); open its BED as a meta-locus in the browser and save the session again")
    return saved


def spec_from_session(saved: dict) -> dict:
    """sessionSpec + the working set (metaLocusStore.ts): what the browser reopens a saved meta-locus with."""
    def number(key, default):
        # parseSeed / Number(...) || default: 0 is a valid seed (kept); missing or unreadable values take the default.
        try:
            v = int(saved.get(key))
        except (TypeError, ValueError):
            return default
        return v if (v or key == "seed") else default

    spec = {"bed": saved["bed_path"], "anchor": saved.get("anchor") or "centre",
            "flank_bp": number("flank_bp", 10_000), "seed": number("seed", 1),
            "count": number("count", 2000), "extra_entries": list(saved.get("extra_entries") or [])}
    for key in ("name", "policy", "count_unit"):
        if saved.get(key):
            spec[key] = saved[key]
    if saved.get("dataset_ids"):
        spec["dataset_ids"] = list(saved["dataset_ids"])
    return spec


def rename_meta_chroms(value, to: str, old: set):
    """renameMetaChroms (components/controls/CrashRecoveryBanner.tsx): every string and key equal to an old meta contig
    becomes ``to`` (the session's metaLocus block is kept as saved)."""
    old = {c for c in old if c and c != to}
    if not old:
        return value

    def walk(v):
        if isinstance(v, str):
            return to if v in old else v
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {(to if k in old else k): walk(x) for k, x in v.items()}
        return v

    out = walk(value)
    fe_in = (value or {}).get("frontend") if isinstance(value, dict) else None
    if isinstance(fe_in, dict) and "metaLocus" in fe_in and isinstance(out.get("frontend"), dict):
        out["frontend"]["metaLocus"] = fe_in["metaLocus"]
    return out


def _bed_regions(path: str) -> tuple[list, str, str]:
    """(regions, name, sha256 of the file) of a BED the server reads (the browser route's reader and confinement)."""
    import os
    from fastapi import HTTPException
    from routers.files import parse_bed_regions, read_bed_text
    try:
        text, shown = read_bed_text(path)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise MetaLocusError(
                f"The meta-locus BED is missing: {path}. If the session was saved on another computer, point it at "
                "this one's copy with fiberbrowser.scripted.remap_session(session, {old_prefix: new_prefix}) or "
                "fiberbrowser render --remap OLD=NEW", status=404) from None
        raise MetaLocusError(str(exc.detail), status=exc.status_code) from None
    regions = parse_bed_regions(text)["regions"]
    if not regions:
        raise MetaLocusError(f"The BED has no usable regions: {path}", status=422)
    name = os.path.basename(shown).removesuffix(".gz").removesuffix(".bed")
    return regions, name, hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class MetaView:
    """A meta-locus as a figure or a quantification uses it."""
    pool: Any                       # the pool (meta_locus_jobs.PoolState)
    view: Any                       # its view clone: what is drawn / counted
    spec: dict                      # the normalized request spec (with the session's when from a session)
    bed_path: Optional[str]
    bed_sha256: Optional[str]
    regions_sha256: str
    source: str                     # 'spec' | 'pool_id' | 'session'
    hide_uncalled: bool = True
    session: Optional[dict] = None  # the session with its old contig renamed (session source)
    old_chroms: list = field(default_factory=list)

    @property
    def chrom(self) -> str:
        return self.view.chrom

    def release(self) -> None:
        """End this request's lease on its view clone (taken by ``resolve``); call it in a ``finally``."""
        from services.meta_locus_jobs import release_view_clone
        if not getattr(self, "_released", False):
            self._released = True
            release_view_clone(self.view)

    @property
    def flank(self) -> int:
        return int(self.pool.sites.flank)

    @property
    def width(self) -> int:
        return 2 * self.flank

    @property
    def anchor(self) -> str:
        return str(self.pool.spec.get("anchor") or "centre")

    def region(self, window: Optional[list] = None) -> tuple[str, int, int]:
        """The contig region of a relative window (bp from the anchor; None: the whole pool window)."""
        if not window:
            return self.chrom, 0, self.width
        a, b = max(-self.flank, int(window[0])), min(self.flank, int(window[1]))
        if b <= a:
            raise MetaLocusError(f"meta_locus window {window} is outside the pool's ±{self.flank:,} bp")
        return self.chrom, a + self.flank, b + self.flank

    def axis(self) -> dict:
        """What the axis draws: the anchor at x = flank (axis offset -flank), the label, the anchor word."""
        return {"zero": self.flank, "axis_offset": -self.flank, "anchor": self.anchor,
                "anchor_word": anchor_word(self.anchor), "label": self.pool.label, "flank": self.flank,
                "anchor_mark": bool(self.spec.get("anchor_mark", True))}

    def spec_hash(self) -> str:
        """A portable hash of what the pool is (BED content, anchor, flank, policy, datasets): unlike the pool id, it
        does not depend on file paths or modification times, so the same spec hashes the same on any computer."""
        core = {"bed_sha256": self.bed_sha256, "regions_sha256": self.regions_sha256, "anchor": self.anchor,
                "flank_bp": self.flank, "policy": self.pool.spec.get("policy"),
                "min_overlap_bp": self.pool.spec.get("min_overlap_bp"), "datasets": list(self.pool.order)}
        return hashlib.sha256(json.dumps(core, sort_keys=True).encode()).hexdigest()

    def record(self) -> dict:
        """The receipt's meta-locus block (BED sha256, anchor, flank, datasets, pool size, seed, count, spec hash)."""
        view = self.view
        per = {}
        for d in self.pool.order:
            ix = self.pool.index_for(d)
            if ix is None:
                continue
            per[d] = {"read_site_pairs": int(ix.n_entries(self.hide_uncalled)), "molecules": int(ix.n_molecules)}
        return {
            "source": self.source, "pool_id": self.pool.pool_id, "contig": self.chrom, "name": self.pool.name,
            "bed": self.bed_path, "bed_sha256": self.bed_sha256, "regions_sha256": self.regions_sha256,
            "anchor": self.anchor, "flank_bp": self.flank, "policy": self.pool.spec.get("policy"),
            "count_unit": self.spec.get("count_unit") or "observation", "datasets": list(self.pool.order),
            "sites": int(len(self.pool.sites)),
            "read_site_pairs": int(sum(p["read_site_pairs"] for p in per.values())),
            "per_dataset": per, "hide_uncalled": self.hide_uncalled,
            "seed": int(view.view_seed), "count": int(view.view_count),
            "extra_entries": len(view.view_extra), "spec_hash": self.spec_hash(),
            "unit": "read-site pair",
        }


def _wait_ready(pool, wait_s: float) -> None:
    deadline = time.monotonic() + max(0.0, float(wait_s))
    while pool.status == "building":
        if time.monotonic() > deadline:
            raise MetaLocusError(f"The meta-locus pool {pool.pool_id} is still building after {wait_s:g} s "
                                 "(pass a longer wait_s)", status=504)
        time.sleep(0.05)
    if pool.status != "ready":
        raise MetaLocusError(f"The meta-locus pool {pool.pool_id} could not be built: {pool.error or pool.status}",
                             status=500)


def resolve(state, spec: Optional[dict] = None, session: Optional[dict] = None, *,
            hide_uncalled: bool = True) -> Optional[MetaView]:
    """The meta-locus of a request: its ``spec`` (a figure's / numbers' meta_locus), else a session saved on a meta
    contig. None when neither names one. The pool is built (or reused) and waited for; the view clone is made."""
    from services import meta_locus_jobs as mj
    spec = normalize_spec(spec) if spec else {}
    # A request's own spec wins; the session's meta-locus block is needed (and checked) only without one. A session on
    # a meta contig has that contig renamed to the drawn one either way.
    saved = session_meta(session) if session is not None and not spec else None
    on_meta = _session_meta_chroms(session)
    source = "spec"
    if not spec and saved is not None:
        spec = normalize_spec(spec_from_session(saved))
        source = "session"
    if not spec:
        return None
    wait_s = float(spec.get("wait_s") or DEFAULT_WAIT_S)
    bed_path = bed_sha = None
    if spec.get("pool_id") and not (spec.get("bed") or spec.get("regions")):
        source = "pool_id"
        pool = mj.get_pool(str(spec["pool_id"]))
        if pool is None:
            raise MetaLocusError(f"No meta-locus pool {spec['pool_id']} on this server (pools are kept in memory; "
                                 "pass the spec - bed, anchor, flank_bp - to rebuild it)", status=404)
        bed_path = pool.spec.get("bed_path")
        if bed_path:
            try:
                bed_sha = _bed_regions(bed_path)[2]
            except MetaLocusError:
                bed_sha = None
    else:
        if spec.get("bed"):
            bed_path = str(spec["bed"])
            regions, name, bed_sha = _bed_regions(bed_path)
        else:
            regions = [r for r in spec.get("regions") or [] if isinstance(r, (list, tuple)) and len(r) >= 3]
            name = "regions"
            if not regions:
                raise MetaLocusError("meta_locus regions has no usable [chrom, start, end, strand, name] rows")
        body = {"anchor": spec.get("anchor", "centre"), "flank_bp": spec.get("flank_bp", 10_000)}
        for key in ("policy", "min_overlap_bp", "dataset_ids"):
            if spec.get(key) is not None:
                body[key] = spec[key]
        if bed_path:
            body["bed_path"] = bed_path
        try:
            pool = mj.start_pool(state, body, regions, str(spec.get("name") or name))
        except KeyError as exc:
            raise MetaLocusError(f"meta_locus: no dataset {exc} is loaded", status=404) from None
        except ValueError as exc:
            raise MetaLocusError(f"meta_locus: {exc}", status=422) from None
    _wait_ready(pool, wait_s)
    seed = int(spec.get("seed", 1))
    count = int(spec.get("count", 2000))
    clone = mj.view_clone(pool, seed=seed, count=count, extra_entries=spec.get("extra_entries"))
    out = MetaView(pool=pool, view=clone, spec=spec, bed_path=bed_path, bed_sha256=bed_sha,
                   regions_sha256=str(pool.spec.get("regions_sha256") or ""), source=source, hide_uncalled=hide_uncalled)
    if session is not None and on_meta:
        out.old_chroms = sorted(on_meta)
        out.session = rename_meta_chroms(session, clone.chrom, on_meta)
    return out


def _session_meta_chroms(session) -> set:
    """The meta contigs a session saved on a meta view names (its view's, and its meta-locus block's pool), else
    an empty set (a session at a real locus is not renamed)."""
    if not isinstance(session, dict):
        return set()
    viewport = session.get("viewport") if isinstance(session.get("viewport"), dict) else {}
    fe = session.get("frontend") if isinstance(session.get("frontend"), dict) else {}
    chroms = {c for c in (viewport.get("chrom"), fe.get("chrom")) if is_meta_chrom(c)}
    if not chroms:
        return set()
    saved = fe.get("metaLocus") if isinstance(fe.get("metaLocus"), dict) else {}
    if saved.get("pool_id"):
        chroms.add(f"meta:{saved['pool_id']}")
    return chroms


def session_region(mv: MetaView, session: Optional[dict]) -> Optional[tuple[str, int, int]]:
    """The saved view's region on the (renamed) contig, clamped to the pool's window (None: no saved view)."""
    if not isinstance(session, dict):
        return None
    vp = session.get("viewport") if isinstance(session.get("viewport"), dict) else {}
    fe = session.get("frontend") if isinstance(session.get("frontend"), dict) else {}
    chrom = vp.get("chrom") or fe.get("chrom")
    start = vp.get("start", fe.get("start"))
    end = vp.get("end", fe.get("end"))
    if chrom != mv.chrom or start is None or end is None:
        return None
    s, e = max(0, int(start)), min(mv.width, int(end))
    return (mv.chrom, s, e) if e > s else None


def view_share(mv: MetaView, dataset_id: str, hide_uncalled: bool = True) -> int:
    """At most how many reads of ``dataset_id`` the figure's view decodes: its balanced share of the working set
    (filtered reads are replaced from later ranks, added reads are not counted in it) plus every added read."""
    from services.meta_locus_jobs import view_cursor
    extra = {e for d, e in mv.view.view_extra if d == dataset_id}
    return int(view_cursor(mv.view, hide_uncalled).get(dataset_id, 0)) + len(extra)


def draw_whole_working_set(spec, mv: MetaView, *, explicit_cap: bool) -> None:
    """A meta-locus figure draws each panel's whole share of the working set (the reads the browser's working-set
    control shows), unless the request caps reads itself (max_reads). The metaprofile keeps the browser's own rule
    (backgroundReadCap), so its curves are the browser's. Panels at a real locus are untouched."""
    if explicit_cap:
        return
    hide = int(spec.fe.get("minFootprints") or 0) >= 0
    mv.hide_uncalled = hide
    for panel in spec.panels:
        chrom = panel.region[0] if panel.region else spec.chrom
        if chrom == mv.chrom and panel.dataset_id in mv.pool.order:
            spec.max_reads_by_panel[panel.id] = max(1, view_share(mv, panel.dataset_id, hide))


def synthesize_session(state, mv: MetaView, base: Optional[dict] = None) -> dict:
    """A session on the meta-locus view (for re-clustering by spec, or a real-locus session moved onto the pool):
    the pool's datasets, the view clone's contig, and the meta-locus block, so the result reopens in the browser."""
    import copy
    from services.figure.recluster import meta_session_payload
    if isinstance(base, dict) and mv.session is not None:
        base = mv.session  # a meta session's old contig, renamed to the drawn one everywhere
    session = copy.deepcopy(base) if isinstance(base, dict) else {"version": "2.0"}
    if not session.get("datasets"):
        rows = []
        for d in mv.pool.order:
            ds = (getattr(state, "datasets", {}) or {}).get(d)
            if ds is None:
                continue
            rows.append({"id": d, "label": getattr(ds, "label", None) or d,
                         "paths": [str(p) for p in getattr(ds, "paths", []) or []], "data_type": "bam"})
        session["datasets"] = rows
    _c, start, end = mv.region(mv.spec.get("window"))
    session["viewport"] = {"chrom": mv.chrom, "start": start, "end": end}
    fe = session.setdefault("frontend", {})
    fe.update({"chrom": mv.chrom, "start": start, "end": end})
    fe["metaLocus"] = meta_session_payload(mv)
    return session


def axis_for_chrom(chrom: str) -> Optional[dict]:
    """The axis of a meta contig shown without a meta-locus request (a live tab's view, a plain region on meta:<pool>):
    the pool of that contig, as the browser's AxisTrack reads the open pool's status. None off a meta contig."""
    if not is_meta_chrom(chrom):
        return None
    from services.meta_locus_jobs import pool_for_chrom
    pool = pool_for_chrom(chrom)
    if pool is None:
        return None
    flank = int(pool.sites.flank)
    anchor = str(pool.spec.get("anchor") or "centre")
    return {"zero": flank, "axis_offset": -flank, "anchor": anchor, "anchor_word": anchor_word(anchor),
            "label": pool.label, "flank": flank, "anchor_mark": True}


def read_sites(mv: MetaView, ids_by_dataset: dict) -> dict:
    """{dataset: {read id: {key, read_name, site, site_name, chrom, strand}}} for the given read ids of the pool, looked up
    in its index (a read in one window has the bare name, a read in several ``name#site<N>``), so every assigned read
    gets its site whatever the decoder's top-up took."""
    import numpy as np
    pool = mv.pool
    out = {}
    for d, ids in ids_by_dataset.items():
        ix = pool.index_for(d)
        if ix is None:
            out[d] = {}
            continue
        candidates = set()
        for rid in ids:
            rid = str(rid)
            candidates.add(rid)
            name, sep, tail = rid.rpartition("#site")
            if sep and tail.isdigit():
                candidates.add(name)
        mol_of = {n: m for m, n in enumerate(ix.names) if n in candidates}
        wanted = {}
        for rid in ids:
            rid = str(rid)
            name, sep, tail = rid.rpartition("#site")
            # As the decoder names rows (_with_meta): name#site<N> for a read in several windows (shared), the bare
            # name for a read in one. The parsed form is tried first and kept only if that entry is shared.
            wanted[rid] = [(name, int(tail), True)] if sep and tail.isdigit() and name in mol_of else []
            wanted[rid].append((rid, None, False))
        ms = np.array(sorted(mol_of.values()), dtype=np.int64)
        entries = np.flatnonzero(np.isin(np.asarray(ix.mol), ms)) if len(ms) else np.array([], dtype=np.int64)
        by_mol = {}
        for e in entries.tolist():
            by_mol.setdefault(int(ix.mol[e]), []).append((int(ix.site[e]), bool(ix.shared[e])))
        table = {}
        for rid, options in wanted.items():
            table[rid] = None
            for name, site, shared in options:
                entries_m = by_mol.get(mol_of.get(name, -1), [])
                if site is not None:
                    hit = next((si for si, sh in entries_m if si == site and sh == shared), None)
                else:
                    unshared = [si for si, sh in entries_m if not sh]
                    hit = unshared[0] if len(unshared) == 1 else None
                if hit is None:
                    continue
                prov = pool.sites.provenance(hit)
                table[rid] = {"key": f"{name}#site{hit}", "read_name": name, "site": hit, "site_name": prov["site_name"],
                              "chrom": prov["chrom"], "strand": prov["strand"]}
                break
        out[d] = table
    return out
