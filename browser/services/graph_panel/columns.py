"""Graph columns for analysis (DESIGN_GRAPH_PRIMARY §2.3–2.6, graph primary G2).

A column is a base of a graph node: ``(node, offset)``, the offset along the node's forward orientation. Columns come
from fixed analysis tiles, never from the display layout, so they do not depend on pans, zoom, compression, the
marks/bubbles setting, the selected paths or their order.

**Tiles.** Fixed 10 kb target cells ``[10k·i, 10k·(i+1))``, each requested as a 14 kb interval (the cell ± 2 kb, the
helper's ``flank_bp`` is capped at 1 kb) with the target and **one** source path, because the helper shares its
budgets across the selected paths in request order. A feature uses only the cells its own target span meets; its
occurrences are merged across those cells by occurrence id (identical across requests) with their clips unioned, and
only then is a visit counted, so one visit split across two tiles is never a repeat.

**Availability per (path, column)** (§2.3):

- *carried*: the path visits the node exactly once in the feature's tiles and the column is inside that visit's clip;
- *absent*: the path's tile response is complete (topology and path ``complete``, no plan summary, every coverage
  portion covered) and the column's target span is covered by owned plan candidates with no overlapping unowned
  candidate, and the path does not visit the node;
- *unresolved*: anything else (a coverage gap, an open end, a limit cut, a plan summary, an unowned candidate, a
  repeat, a clip that stops short).

**Frames** (§2.3, §2.5). A region (a target span) gives:

1. the shared target feature: frame ``[0, len)`` along the target's walk (frame position ``u`` is target position
   ``start + u``); every observation's blocks map it to its own coordinates, oriented by
   ``reverse = carrier.reverse XOR canonical.reverse`` at the node;
2. non-target node runs inside the region (insertions, a substitution's other allele): one feature per run, its
   frame along its first carrier's walk in the package's binding order, sampled on the parent's 10 bp grid continued
   across the boundary (``sample_positions``);
3. target runs only some observations carry (deleted stretches): carrier-only features on the parent's frame and
   grid.

A feature every participating observation carries is a shared (stage 1) feature; one a strict subset carries is a
carrier-only feature, refined within carriers (§2.6 ``refineWithinCarriers``). Blocks are maximal colinear runs:
consecutive frame positions mapped to consecutive path positions in the same relative orientation.

Pure functions over helper responses: ``services/graph_panel/analysis.py`` fetches the tiles and runs the fits.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from typing import Iterable, Optional

CELL_BP = 10_000
TILE_PAD_BP = 2_000
GRID_BP = 10
# A feature longer than the helper's target window is refused (§2.4).
MAX_FEATURE_BP = 50_000
# Carrier-only features with fewer sampled positions are dropped and reported: a lone SNP column refined within
# every parent cluster splits it on one base (graph primary G4; the design allowed any number of samples).
DEFAULT_CARRIER_MIN_SAMPLES = 3
SCHEMA = 1


# ── Tiles ───────────────────────────────────────────────────────────────────

def cells_for(start: int, end: int) -> list[int]:
    """The fixed 10 kb cells a target span ``[start, end)`` meets."""
    if end <= start:
        return []
    return list(range(start // CELL_BP, (end - 1) // CELL_BP + 1))


def tile_interval(cell: int, size: Optional[int]) -> tuple[int, int]:
    """A cell's request interval: the cell ± 2 kb, inside the target contig."""
    a = max(0, cell * CELL_BP - TILE_PAD_BP)
    b = (cell + 1) * CELL_BP + TILE_PAD_BP
    if size:
        b = min(int(size), b)
    return a, max(a + 1, b)


# ── Occurrences ─────────────────────────────────────────────────────────────

def _merge(spans: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[list[int]] = []
    for a, b in sorted((int(a), int(b)) for a, b in spans if int(b) > int(a)):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


@dataclass
class Occ:
    """One visit of a node by a path, merged across tiles: its node-forward clips (the carried bases)."""
    id: str
    node: str
    length: int
    reverse: bool
    span: tuple[int, int]
    clips: list[tuple[int, int]] = field(default_factory=list)

    def carries(self, o: int) -> bool:
        return any(a <= o < b for a, b in self.clips)

    def pos(self, o: int) -> int:
        """The path coordinate of node-forward offset ``o`` (§2.3)."""
        return self.span[0] + o if not self.reverse else self.span[1] - 1 - o

    def offset(self, p: int) -> int:
        """The node-forward offset of path coordinate ``p``."""
        return p - self.span[0] if not self.reverse else self.span[1] - 1 - p

    def walk_offsets(self) -> list[int]:
        """Carried node-forward offsets in the path's traversal order."""
        offs = [o for a, b in self.clips for o in range(a, b)]
        return sorted(offs, reverse=self.reverse)


def forward_clip(clip: dict, length: int, reverse: bool) -> tuple[int, int]:
    """A traversal-oriented clip in node-forward offsets (§2.3)."""
    c0, c1 = int(clip["start"]), int(clip["end"])
    return (c0, c1) if not reverse else (length - c1, length - c0)


def merge_occurrences(results: Iterable[dict], binding: str) -> dict[str, Occ]:
    """A path's occurrences over several tile responses, merged by id, clips unioned."""
    out: dict[str, Occ] = {}
    for res in results:
        lengths = {n["id"]: int(n["length"]) for n in res.get("nodes") or ()}
        for p in res.get("paths") or ():
            if p.get("binding") != binding:
                continue
            for o in p.get("occurrences") or ():
                length = lengths.get(o["node"])
                if length is None:
                    continue
                reverse = bool(o.get("reverse"))
                clip = forward_clip(o["clip"], length, reverse)
                span = (int(o["path_span"]["start"]), int(o["path_span"]["end"]))
                hit = out.get(o["id"])
                if hit is None:
                    out[o["id"]] = Occ(o["id"], str(o["node"]), length, reverse, span, _merge([clip]))
                else:
                    hit.clips = _merge([*hit.clips, clip])
    return out


def visits(occs: dict[str, Occ]) -> dict[str, list[Occ]]:
    by: dict[str, list[Occ]] = {}
    for occ in occs.values():
        by.setdefault(occ.node, []).append(occ)
    return by


# ── Availability ────────────────────────────────────────────────────────────

def _path(res: dict, binding: str) -> Optional[dict]:
    return next((p for p in res.get("paths") or () if p.get("binding") == binding), None)


def complete_at(res: Optional[dict], binding: str, t0: int, t1: int) -> bool:
    """Whether a path's tile response proves what it does not visit over target ``[t0, t1)`` (or the boundary point
    ``t0 == t1``): complete topology and path, no plan summary, every coverage portion covered, and the span covered
    by owned plan candidates with no overlapping unowned one (§2.3; ``correspondence_complete`` is not used)."""
    if res is None or not res.get("complete") or res.get("summaries"):
        return False
    p = _path(res, binding)
    if p is None or not p.get("complete"):
        return False
    plan = p.get("plan") or {}
    if plan.get("summaries"):
        return False
    if any(c.get("kind") != "covered" for c in p.get("coverage") or ()):
        return False
    cands = plan.get("candidates") or []
    if not cands:
        return False
    if t1 <= t0:   # a boundary: some owned candidate touches it, no unowned one spans it
        if any(not c.get("owned") and int(c["target"]["start"]) < t0 < int(c["target"]["end"]) for c in cands):
            return False
        return any(c.get("owned") and int(c["target"]["start"]) <= t0 <= int(c["target"]["end"]) for c in cands)
    if any(not c.get("owned") and int(c["target"]["start"]) < t1 and int(c["target"]["end"]) > t0 for c in cands):
        return False
    owned = _merge((int(c["target"]["start"]), int(c["target"]["end"])) for c in cands if c.get("owned"))
    return any(a <= t0 and t1 <= b for a, b in owned)


# ── Geometry ────────────────────────────────────────────────────────────────

@dataclass
class Observation:
    """One canonical observation (§3.4): a (dataset, path) fitted once. ``binding``: the package path its rows are on
    (a source path of a lifted dataset in graph mode); None: a linear observation on target coordinates."""
    id: str
    binding: Optional[str]


@dataclass
class Feature:
    kind: str                    # 'target' | 'insertion' | 'deleted'
    region: int                  # index of the region it belongs to
    length: int                  # frame length
    samples: list[int]           # candidate frame positions (before the carried-by-all intersection)
    blocks: dict                 # observation id -> [(u0, u1, g0, g1, reverse)]
    carriers: list[str]          # observation ids that carry at least one sample
    label: str = ""
    nodes: list[str] = field(default_factory=list)
    anchor: Optional[tuple[int, int]] = None   # target span it replaces / sits at (insertions)
    span: Optional[tuple[int, int]] = None     # frame span (deleted stretches)

    def public(self) -> dict:
        return {"kind": self.kind, "region": self.region, "length": self.length, "label": self.label,
                "carriers": list(self.carriers), "samples": len(self.samples),
                **({"nodes": self.nodes[:512], "node_count": len(self.nodes)} if self.nodes else {}),
                **({"anchor": list(self.anchor)} if self.anchor else {}),
                **({"frame_span": list(self.span)} if self.span else {})}


def _runs(points: list[tuple[int, int, bool]]) -> list[tuple[int, int, int, int, bool]]:
    """Maximal colinear blocks from ``(u, path position, reverse)`` sorted by ``u``: ``(u0, u1, g0, g1, reverse)``."""
    out = []
    cur = None
    for u, g, rev in points:
        if cur is not None and u == cur[1] and rev == cur[4] and g == (cur[5] - 1 if rev else cur[5] + 1):
            cur[1] = u + 1
            cur[5] = g
            continue
        if cur is not None:
            out.append(cur)
        cur = [u, u + 1, g, g, rev, g]
    if cur is not None:
        out.append(cur)
    return [(u0, u1, min(g0, last), max(g0, last) + 1, rev) for u0, u1, g0, _g, rev, last in out]


def _grid(start: int, end: int, phase: int = 0) -> list[int]:
    first = start + ((phase - start) % GRID_BP)
    return list(range(first, end, GRID_BP))


@dataclass
class RegionColumns:
    region: int
    start: int
    end: int
    features: list[Feature]          # non-target runs (insertions); target features are built per run (stage_plan)
    report: dict
    carried: dict                    # obs id -> {frame position: (path position, reverse)} on the target walk
    walk: list[bool]                 # frame positions the target walk carries (unresolved: repeats, clips)

    def target_features(self, participants: list[str]) -> list[Feature]:
        """The shared target feature and the deleted stretches, relative to the run's participants: positions every
        participant carries are shared; maximal runs a strict, non-empty subset carries are carrier-only."""
        length = self.end - self.start
        grid = _grid(0, length)
        full = frozenset(participants)
        carriers_at = [frozenset(i for i in participants if u in self.carried[i]) for u in range(length)]
        blocks = {i: _runs([(u, *self.carried[i][u]) for u in sorted(self.carried[i])]) for i in participants}
        out = [Feature("target", self.region, length, [u for u in grid if carriers_at[u] == full], blocks,
                       list(participants), label=f"{self.start:,}–{self.end:,}")]
        u = 0
        while u < length:
            cs = carriers_at[u]
            if not cs or cs == full or not self.walk[u]:
                u += 1
                continue
            v = u
            while v < length and carriers_at[v] == cs and self.walk[v]:
                v += 1
            members = sorted(cs)
            out.append(Feature("deleted", self.region, length, [x for x in grid if u <= x < v],
                               {i: _runs([(x, *self.carried[i][x]) for x in range(u, v)]) for i in members}, members,
                               label=f"{self.start + u:,}–{self.start + v:,} (carried by {len(members)} of {len(participants)})",
                               span=(u, v)))
            u = v
        return out


def region_columns(region: int, start: int, end: int, target: str, target_occs: dict[str, Occ],
                   observations: list[Observation], path_occs: dict[str, dict[str, Occ]],
                   tile_results: dict[str, dict[int, dict]], *, insertions: bool = True,
                   binding_order: Optional[list[str]] = None) -> RegionColumns:
    """A region's features (shared target feature, non-target runs, deleted stretches) with every observation's
    blocks, from the merged occurrences of the cells the region meets. ``path_occs[binding]`` and
    ``tile_results[binding][cell]`` hold each graph observation's path; linear observations carry the target walk
    by identity."""
    if end - start > MAX_FEATURE_BP:
        raise ValueError(f"A graph region is at most {MAX_FEATURE_BP:,} bp; this one is {end - start:,} bp")
    length = end - start
    report: dict = {"unresolved": {}, "absent": {}, "repeats": {}, "dropped": []}
    t_visits = visits(target_occs)
    # The target walk: frame position u -> (node, node-forward offset, target occurrence).
    cols: list[Optional[tuple[str, int, Occ]]] = [None] * length
    target_repeats = 0
    for occ in target_occs.values():
        a, b = max(occ.span[0], start), min(occ.span[1], end)
        for t in range(a, b):
            o = occ.offset(t)
            if not occ.carries(o):
                continue
            if len(t_visits[occ.node]) != 1:
                target_repeats += 1
                continue
            cols[t - start] = (occ.node, o, occ)
    if target_repeats:
        report["target_repeats"] = target_repeats
    report["target_unresolved"] = sum(1 for c in cols if c is None)

    # Per observation and frame position: (path position, reverse) when carried.
    carried: dict[str, dict[int, tuple[int, bool]]] = {}
    for ob in observations:
        own: dict[int, tuple[int, bool]] = {}
        if ob.binding is None or ob.binding == target:
            for u, c in enumerate(cols):
                if c is not None:
                    own[u] = (start + u, False)
            carried[ob.id] = own
            continue
        vis = visits(path_occs.get(ob.binding) or {})
        unresolved = absent = repeats = 0
        cells = tile_results.get(ob.binding) or {}
        for u, c in enumerate(cols):
            if c is None:
                continue
            node, o, tocc = c
            hits = vis.get(node) or []
            if len(hits) == 1 and hits[0].carries(o):
                q = hits[0]
                own[u] = (q.pos(o), q.reverse != tocc.reverse)
            elif len(hits) > 1:
                repeats += 1
            elif not hits and complete_at(cells.get((start + u) // CELL_BP), ob.binding, start + u, start + u + 1):
                absent += 1
            else:
                unresolved += 1
        carried[ob.id] = own
        if unresolved:
            report["unresolved"][ob.id] = unresolved
        if absent:
            report["absent"][ob.id] = absent
        if repeats:
            report["repeats"][ob.id] = repeats

    features: list[Feature] = []
    if insertions:
        features.extend(_insertion_features(region, start, end, target, t_visits, observations, path_occs, report,
                                            binding_order))
    return RegionColumns(region, start, end, features, report, carried, [c is not None for c in cols])


def _insertion_runs(binding, occs_by_id, start, end, target_nodes, t_visits):
    """A path's non-target runs between two target anchors inside the region: ``[(run occurrences, (lo, hi))]``,
    plus how many were left out as repeats. Contiguous visits only, every run base carried, carried flank bases
    (§2.3: the unclipped path_span authorises nothing beyond the clips)."""
    occs = sorted(occs_by_id.values(), key=lambda q: (q.span[0], q.span[1]))
    vis = visits(occs_by_id)
    out, repeats = [], 0
    i = 0
    while i < len(occs):
        if occs[i].node in target_nodes:
            i += 1
            continue
        j = i
        while j < len(occs) and occs[j].node not in target_nodes:
            j += 1
        run = occs[i:j]
        left = occs[i - 1] if i > 0 else None
        right = occs[j] if j < len(occs) else None
        i = j
        walk = [left, *run, right]
        if left is None or right is None or any(a.span[1] != b.span[0] for a, b in zip(walk, walk[1:])) \
                or any(q.clips != [(0, q.length)] for q in run):
            continue
        tl, tr = _flank_target(left, True, t_visits), _flank_target(right, False, t_visits)
        if tl is None or tr is None:
            continue
        lo, hi = min(tl, tr), max(tl, tr)
        if not (start <= lo and hi < end):
            continue
        if any(len(vis[q.node]) != 1 for q in run):
            repeats += 1
            continue
        out.append((run, (lo, hi)))
    return out, repeats


def _insertion_features(region, start, end, target, t_visits, observations, path_occs, report,
                        binding_order=None) -> list[Feature]:
    """Non-target node runs between two target anchors inside the region (§2.5).

    - **Canonical frames** come from every package path in the tiles (each compared with the target), read in the
      package's binding order, never from the run's observations: a run of new nodes is a frame along the first
      path that walks it, sampled on the parent's 10 bp grid continued across the boundary along that path's walk;
      a later path joins the frames of nodes already framed. So the sampled columns of a path never depend on which
      other paths are in the run.
    - **Features** are maximal stretches of a frame with one carrier set among the observations (a column is carried
      by an observation whose path walks that node in a valid run), so a carrier's private sequence and a stretch
      only some carriers share are features of their own.
    """
    target_nodes = set(t_visits)
    rank = {b: i for i, b in enumerate(binding_order or ())}
    walkers = sorted((b for b in path_occs if b != target), key=lambda b: (rank.get(b, len(rank)), b))
    frames: list[dict] = []    # {canon: [Occ], skip, anchor}
    owner: dict[str, int] = {}
    valid: dict[str, list] = {}
    for b in walkers:
        runs, repeats = _insertion_runs(b, path_occs[b], start, end, target_nodes, t_visits)
        valid[b] = runs
        for ob in observations:
            if ob.binding == b and repeats:
                report["repeats"][ob.id] = report["repeats"].get(ob.id, 0) + repeats
        for run, anchor in runs:
            offset = 0
            k = 0
            while k < len(run):
                fid = owner.get(run[k].node)
                m = k
                while m < len(run) and owner.get(run[m].node) == fid:
                    m += 1
                if fid is None:
                    frames.append({"canon": run[k:m], "skip": offset, "anchor": anchor})
                    for q in run[k:m]:
                        owner[q.node] = len(frames) - 1
                offset += sum(q.length for q in run[k:m])
                k = m
    # Each observation's carried bases of each frame: its path's valid runs.
    obs = sorted((ob for ob in observations if ob.binding is not None and ob.binding != target), key=lambda ob: ob.id)
    out = []
    for f in frames:
        frame = [(q.node, o, q.reverse) for q in f["canon"] for o in q.walk_offsets()]
        index = {(n, o): u for u, (n, o, _r) in enumerate(frame)}
        canon_rev = {n: r for n, _o, r in frame}
        nodes = set(canon_rev)
        lo, hi = f["anchor"]
        phase = (GRID_BP - (hi - start) % GRID_BP) % GRID_BP
        grid = set(_grid(0, len(frame), (phase - f["skip"]) % GRID_BP))
        pts: dict[str, dict[int, tuple[int, bool]]] = {}
        for ob in obs:
            mine = {}
            for run, _anchor in valid.get(ob.binding, ()):
                for q in run:
                    if q.node in nodes:
                        for o in q.walk_offsets():
                            u = index.get((q.node, o))
                            if u is not None:
                                mine[u] = (q.pos(o), q.reverse != canon_rev[q.node])
            if mine:
                pts[ob.id] = mine
        carriers_at = [tuple(sorted(oid for oid, mine in pts.items() if u in mine)) for u in range(len(frame))]
        u = 0
        while u < len(frame):
            cs = carriers_at[u]
            v = u
            while v < len(frame) and carriers_at[v] == cs:
                v += 1
            if cs:
                part_nodes = list(dict.fromkeys(frame[x][0] for x in range(u, v)))
                samples = [x - u for x in range(u, v) if x in grid]
                blocks = {oid: _runs([(x - u, *pts[oid][x]) for x in range(u, v)]) for oid in cs}
                out.append(Feature("insertion", region, v - u, samples, blocks, list(cs) if samples else [],
                                   label=f"{v - u:,} bp at {lo:,}–{hi:,}", nodes=part_nodes, anchor=(lo, hi)))
            u = v
    return out


def _flank_target(occ: Occ, left: bool, t_visits: dict) -> Optional[int]:
    """The target position where a path leaves (left flank's last base) or rejoins (right flank's first base) the
    target walk."""
    hits = t_visits.get(occ.node) or []
    if len(hits) != 1:
        return None
    p = occ.span[1] - 1 if left else occ.span[0]
    o = occ.offset(p)
    t = hits[0]
    if not (0 <= o < t.length) or not occ.carries(o) or not t.carries(o):
        return None
    return t.pos(o)


# ── Stages ──────────────────────────────────────────────────────────────────

@dataclass
class Plan:
    """A run's features split into stage 1 (shared) and carrier sets (stage 2), with each feature's realised samples
    (carried by every window of its stage)."""
    shared: list[Feature]
    carrier_sets: list[dict]          # {carriers: [obs ids], features: [Feature]}
    participants: list[str]           # observations in stage 1
    left_out: dict                    # obs id -> reason
    report: dict


def _carried_samples(f: Feature, members: list[str]) -> list[int]:
    def has(oid, u):
        return any(u0 <= u < u1 for u0, u1, *_ in f.blocks.get(oid) or ())
    return [u for u in f.samples if all(has(m, u) for m in members)]


def stage_plan(regions: list[RegionColumns], observation_ids: list[str], *, carrier_features: str = "refine",
               carrier_min_samples: int = DEFAULT_CARRIER_MIN_SAMPLES) -> Plan:
    """Stage 1 takes the features every participating observation carries; an observation that carries no sampled
    position of some region's target walk is left out of the run (its rows: "not in this run"). Carrier-only
    features group by identical carriers into carrier sets, in a deterministic order (stage 2)."""
    left_out: dict = {}
    participants = []
    for oid in sorted(observation_ids):
        lacking = [r.region for r in regions
                   if not any(u in r.carried.get(oid, {}) for u in _grid(0, r.end - r.start) if r.walk[u])]
        if lacking:
            left_out[oid] = f"no columns of region {', '.join(str(i + 1) for i in lacking)} on this path"
        else:
            participants.append(oid)
    if not participants:
        raise ValueError("No path carries every region: choose regions inside the graph's covered span")
    shared: list[Feature] = []
    by_set: dict[tuple, list[Feature]] = {}
    dropped = []
    pset = set(participants)
    for r in regions:
        # (Copies: a region's columns are reusable across plans, never changed by one.)
        for f in [*r.target_features(participants), *(replace(f) for f in r.features)]:
            carriers = sorted(c for c in f.carriers if c in pset)
            if f.kind == "target":
                if f.samples:
                    shared.append(f)
                else:
                    # Nothing every path carries here (e.g. two paths carrying different halves): its carrier-only
                    # parts still refine, and the other regions' shared features fit as usual.
                    dropped.append({**f.public(), "reason": "no position every path carries"})
                continue
            if not carriers:
                continue
            if set(carriers) == pset:
                samples = _carried_samples(f, participants)
                if samples:
                    shared.append(replace(f, samples=samples, carriers=carriers))
                else:
                    dropped.append({**f.public(), "reason": "no sampled position every path carries"})
                continue
            samples = _carried_samples(f, carriers)
            if carrier_features == "drop":
                dropped.append({**f.public(), "reason": "carrier-only features are dropped (option)"})
                continue
            if len(samples) < carrier_min_samples:
                dropped.append({**f.public(), "samples": len(samples),
                                "reason": f"{len(samples)} sampled position(s); at least {carrier_min_samples} needed"})
                continue
            by_set.setdefault(tuple(carriers), []).append(replace(f, samples=samples, carriers=carriers))
    order = sorted(by_set.items(), key=lambda kv: (kv[0], min((f.region, f.kind, tuple(f.anchor or f.span or (0, 0)))
                                                              for f in kv[1])))
    sets = [{"carriers": list(k), "features": fs} for k, fs in order]
    report: dict = {"dropped": dropped}
    for r in regions:
        for k in ("unresolved", "absent", "repeats"):
            for oid, n in r.report.get(k, {}).items():
                report.setdefault(k, {}).setdefault(oid, 0)
                report[k][oid] += n
        if r.report.get("target_unresolved"):
            report.setdefault("target_unresolved", 0)
            report["target_unresolved"] += r.report["target_unresolved"]
    return Plan(shared, sets, participants, left_out, report)


def feature_blocks(features: list[Feature], oid: str) -> list[dict]:
    """An observation's FrameBlocks for features (indexed by their position in ``features``)."""
    out = []
    for i, f in enumerate(features):
        for u0, u1, g0, g1, rev in f.blocks.get(oid) or ():
            out.append({"feature": i, "frame": (u0, u1), "genomic": (g0, g1), "reverse": rev})
    return out


def geometry_digest(features: list[Feature], oids: list[str]) -> str:
    """A digest of a stage's realised geometry: feature lengths, sampled positions and every window's blocks."""
    payload = [[f.kind, f.region, f.length, f.samples, {o: f.blocks.get(o) or [] for o in oids}] for f in features]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=list).encode()).hexdigest()
