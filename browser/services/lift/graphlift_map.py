# Vendored from graphlift v0.4 (commit 650b259; file last changed in 3dd79b9),
# scripts/graphlift_map.py, MIT licence (graphlift is our own code). Everything
# below the end marker is byte-identical to that file; tests/test_live_lift_map.py
# checks the body hash and, when the graphlift checkout is present, query parity.
# Do not edit below the marker: update graphlift and re-vendor instead.
# FiberBrowser reads sidecars only (format graphlift.sidecar v2); the plain-chain
# fallback ``sidecar_from_chain`` needs graphlift's chainlib and is not used here.
# body sha256: 3ac3c0db6afe745f599778f522e1423b86cf66af6f85d31d3ee0cf3ea29b5c56
# --- end of vendoring header ---
"""Reader for graphlift sidecars (format v2), mirroring ``src/liftmap.rs``.

    from graphlift_map import LiftMap
    lm = LiftMap.open("hg002.chain.graphlift.json")       # manifest only
    lm.target_to_source("chr1", 20_000_000, 20_010_000)   # loads chr1's block file on first use
    lm.source_to_target("chr1_MATERNAL", 19_990_000, 20_000_000)

Each piece is a ``Piece``: target interval, forward source interval, chain index, strand and
``primary`` (the chain is the net's primary projection over that interval for its haplotype).
Pieces are cut only at block ends and net boundaries; ``inferred_runs`` lists the bases of a
chain that are inferred bubble fills rather than exact graph anchors (loaded lazily from the
``.fills`` file). ``gap_span`` explains positions without a projection. Coordinates are
0-based, half-open. Standard library only; meant to be reused by FiberBrowser."""
import bisect
import gzip
import json
import os
from collections import namedtuple

FORMAT, VERSION = "graphlift.sidecar", 2

Piece = namedtuple("Piece", "chain t_start t_end q_start q_end strand primary")


def _load_json(path):
    with open(path, "rb") as fh:
        gz = fh.read(2) == b"\x1f\x8b"
    with (gzip.open(path, "rt") if gz else open(path)) as fh:
        return json.load(fh)


class LiftMap:
    def __init__(self, manifest, base_dir=".", payload=None):
        m = manifest
        if m.get("format") != FORMAT or m.get("version") != VERSION:
            raise ValueError(f"unsupported sidecar {m.get('format')} v{m.get('version')}")
        self.m, self.dir = m, base_dir
        self.kinds, self.reasons = m["block_kinds"], m["gap_reasons"]
        self.chains = m["chains"]
        self.targets, self.sources = {}, {}
        for idx, (store, items, label) in enumerate(((self.targets, m["targets"], "target"), (self.sources, m["sources"], "source"))):
            for i, c in enumerate(items):
                if c["name"] in store:
                    raise ValueError(f"duplicate {label} name {c['name']!r}")
                store[c["name"]] = i
        self.by_source = {}
        for ci, c in enumerate(self.chains):
            self.by_source.setdefault(c["source"], []).append(ci)
        self.nets = {}
        for hap, rows in m["nets"].items():
            for t, s, e, p, _alts in rows:
                self.nets.setdefault((hap, t), []).append((s, e, p))
        for v in self.nets.values():
            v.sort()
        self._net_ends = {k: [r[1] for r in v] for k, v in self.nets.items()}
        self._blocks, self._fills = {}, {}
        if payload:  # in-memory payload: {target index: (blocks dict, fills dict)}
            for ti, (b, f) in payload.items():
                self._set_blocks(ti, b)
                self._fills[ti] = f

    @classmethod
    def open(cls, path):
        return cls(_load_json(path), os.path.dirname(os.path.abspath(path)))

    def _set_blocks(self, ti, data):
        d = {}
        for ci, bl in data["blocks"].items():
            ci = int(ci)
            d[ci] = dict(blocks=bl, bt=[b[0] + b[2] for b in bl], bq=[b[1] + b[2] for b in bl],
                         gaps=data["gaps"].get(str(ci), data["gaps"].get(ci, [])))
            d[ci]["gq"] = [g[1] for g in d[ci]["gaps"]]
        self._blocks[ti] = d

    def _target(self, ti):
        if ti not in self._blocks:
            name = self.m["targets"][ti]["name"]
            data = _load_json(os.path.join(self.dir, self.m["target_files"][name][0]))
            if data.get("target") != name:
                raise ValueError(f"{self.m['target_files'][name][0]} holds target {data.get('target')!r}, expected {name!r}")
            self._set_blocks(ti, data)
        return self._blocks[ti]

    def chain_data(self, ci):
        return self._target(self.chains[ci]["target"])[ci]

    def inferred_runs(self, ci, start, end):
        """Inferred runs ``(t, len, kind)`` of chain ``ci`` overlapping ``[start, end)``."""
        if end <= start:
            return []
        ti = self.chains[ci]["target"]
        if ti not in self._fills:
            name = self.m["targets"][ti]["name"]
            data = _load_json(os.path.join(self.dir, self.m["target_files"][name][1]))
            if data.get("target") != name:
                raise ValueError(f"fills file holds target {data.get('target')!r}, expected {name!r}")
            self._fills[ti] = data["fills"]
        runs = self._fills[ti].get(str(ci), self._fills[ti].get(ci, []))
        ends = [r[0] + r[1] for r in runs]
        out = []
        for r in runs[bisect.bisect_right(ends, start):]:
            if r[0] >= end:
                break
            out.append((r[0], r[1], self.kinds[r[2]]))
        return out

    def _pieces(self, ci, c, t, t_end, q, out):
        qsize = self.m["sources"][c["source"]]["size"]
        key = (c["haplotype"], c["target"])
        rows, ends = self.nets.get(key, []), self._net_ends.get(key, [])
        cuts, pos = [], t
        for r in rows[bisect.bisect_right(ends, t):]:
            if r[0] >= t_end:
                break
            s, e = max(r[0], pos), min(r[1], t_end)
            if s > pos:
                cuts.append([pos, s, False])
            if e > s:
                cuts.append([s, e, r[2] == ci])
            pos = max(e, pos)
        if pos < t_end:
            cuts.append([pos, t_end, False])
        merged = []
        for cut in cuts:
            if merged and merged[-1][1] == cut[0] and merged[-1][2] == cut[2]:
                merged[-1][1] = cut[1]
            else:
                merged.append(cut)
        for s, e, prim in merged:
            qs = q + (s - t)
            if c["strand"] == "+":
                qa, qb = qs, qs + (e - s)
            else:
                qa, qb = qsize - qs - (e - s), qsize - qs
            out.append(Piece(ci, s, e, qa, qb, c["strand"], prim))

    def target_to_source(self, t_name, start, end):
        ti = self.targets.get(t_name)
        out = []
        if ti is None or end <= start:
            return out
        for ci, d in self._target(ti).items():
            c = self.chains[ci]
            if c["t_end"] <= start or c["t_start"] >= end:
                continue
            for b in d["blocks"][bisect.bisect_right(d["bt"], start):]:
                if b[0] >= end:
                    break
                s, e = max(b[0], start), min(b[0] + b[2], end)
                self._pieces(ci, c, s, e, b[1] + (s - b[0]), out)
        return out

    def source_to_target(self, q_name, start, end):
        si = self.sources.get(q_name)
        out = []
        if si is None:
            return out
        qsize = self.m["sources"][si]["size"]
        start, end = min(start, qsize), min(end, qsize)
        if end <= start:
            return out
        for ci in self.by_source.get(si, []):
            c = self.chains[ci]
            if c["q_end_forward"] <= start or c["q_start_forward"] >= end:
                continue
            d = self.chain_data(ci)
            qs, qe = (start, end) if c["strand"] == "+" else (qsize - end, qsize - start)
            for b in d["blocks"][bisect.bisect_right(d["bq"], qs):]:
                if b[1] >= qe:
                    break
                s, e = max(b[1], qs), min(b[1] + b[2], qe)
                t = b[0] + (s - b[1])
                self._pieces(ci, c, t, t + (e - s), s, out)
        return out

    def gap_span(self, q_name, pos):
        """``(reason, lo, hi)`` for a forward source position without a projection: the
        reason holds for all of ``[lo, hi)``. Reasons are gap reasons, 'uncovered' (not in the
        graph) or 'outside_chains'."""
        si = self.sources.get(q_name)
        if si is None:
            return ("unknown_source", pos, pos + 1)
        src = self.m["sources"][si]
        for s, e in src["uncovered"]:
            if s <= pos < e:
                return ("uncovered", s, e)
        qsize = src["size"]
        hi_out, lo_out = qsize, 0
        for ci in self.by_source.get(si, []):
            c = self.chains[ci]
            a, b = c["q_start_forward"], c["q_end_forward"]
            if not (a <= pos < b):
                if b <= pos:
                    lo_out = max(lo_out, b)
                else:
                    hi_out = min(hi_out, a)
                continue
            d = self.chain_data(ci)
            qq = pos if c["strand"] == "+" else qsize - 1 - pos
            k = bisect.bisect_right(d["gq"], qq) - 1
            while k >= 0:
                g = d["gaps"][k]
                if g[1] <= qq < g[1] + g[3]:
                    lo, hi = g[1], g[1] + g[3]
                    if c["strand"] == "-":
                        lo, hi = qsize - hi, qsize - lo
                    return (self.reasons[g[4]], lo, hi)
                if g[1] + g[3] <= qq and g[3] > 0:
                    break
                k -= 1
        for s, e in src["uncovered"]:
            if e <= pos:
                lo_out = max(lo_out, e)
            elif s > pos:
                hi_out = min(hi_out, s)
        return ("outside_chains", lo_out, hi_out)


def haplotype_of(qname, mapping=None):
    """Haplotype key of a chain query name: an explicit mapping first, then generated
    ``SAMPLE#HAP#CONTIG`` names (-> ``SAMPLE#HAP``), then ``_MATERNAL`` / ``_PATERNAL``
    suffixes, else 'H'."""
    if mapping and qname in mapping:
        return mapping[qname]
    parts = qname.split('#')
    if len(parts) == 3:
        return parts[0] + '#' + parts[1]
    suffix = qname.rsplit('_', 1)[-1] if '_' in qname else ''
    return suffix if suffix in ('MATERNAL', 'PATERNAL') else 'H'


def sidecar_from_chain(path, haplotypes=None, min_gap=200):
    """In-memory LiftMap for a plain UCSC chain file, for chains without a sidecar.

    Haplotypes come from ``haplotype_of`` (pass ``haplotypes={qname: key}`` to override).
    The net uses the same span policy as the Rust builder (rank by score, bridge target gaps
    < ``min_gap``) but cannot exempt structural conflict gaps, because plain chains carry no
    gap reasons; primary flags are authoritative only with a gbz2chain sidecar. Gap reasons
    are guessed from shape and there is no provenance or clipping information."""
    from chainlib import read_chains
    cs = read_chains(path)
    targets, sources, chains = {}, {}, []
    blocks = {}
    for i, c in enumerate(cs):
        ti = targets.setdefault(c.tname, len(targets))
        si = sources.setdefault(c.qname, (len(sources), c.qsize))[0]
        hap = haplotype_of(c.qname, haplotypes)
        qf = (c.qstart, c.qend) if c.qstrand == '+' else (c.qsize - c.qend, c.qsize - c.qstart)
        gaps = [(t0, q0, dt, dq, 0 if dt == 0 else (1 if dq == 0 else 3)) for t0, q0, dt, dq in c.gaps()]
        chains.append(dict(key=c.id, ucsc_id=int(c.id), haplotype=hap, target=ti, source=si, strand=c.qstrand,
                           t_start=c.tstart, t_end=c.tend, q_start=c.qstart, q_end=c.qend,
                           q_start_forward=qf[0], q_end_forward=qf[1], score=c.score))
        b = blocks.setdefault(ti, {"target": c.tname, "blocks": {}, "gaps": {}})
        b["blocks"][i] = [list(x) for x in c.blocks]
        b["gaps"][i] = gaps
    nets = {}
    for hap in sorted({c['haplotype'] for c in chains}):
        idx = sorted((i for i, c in enumerate(chains) if c['haplotype'] == hap), key=lambda i: (-chains[i]['score'], i))
        rank = {ci: r for r, ci in enumerate(idx)}
        rows = []
        for t in targets.values():
            claims = []
            for ci in idx:
                if chains[ci]['target'] != t:
                    continue
                cur = None
                for b0, _, n in blocks[t]["blocks"][ci]:
                    if cur is not None and b0 - cur[1] < min_gap:
                        cur[1] = b0 + n
                    else:
                        if cur:
                            claims.append((cur[0], cur[1], rank[ci]))
                        cur = [b0, b0 + n]
                if cur:
                    claims.append((cur[0], cur[1], rank[ci]))
            bps = sorted({x for s, e, _ in claims for x in (s, e)})
            cover = [[] for _ in bps]
            for s, e, r in claims:
                for k in range(bisect.bisect_left(bps, s), bisect.bisect_left(bps, e)):
                    cover[k].append(r)
            for k in range(len(bps) - 1):
                if cover[k]:
                    rk = sorted(cover[k])
                    row = (t, bps[k], bps[k + 1], idx[rk[0]], [idx[x] for x in rk[1:]])
                    if rows and rows[-1][0] == t and rows[-1][2] == row[1] and rows[-1][3] == row[3] and rows[-1][4] == row[4]:
                        rows[-1] = (t, rows[-1][1], row[2], row[3], row[4])
                    else:
                        rows.append(row)
        nets[hap] = rows
    m = dict(format=FORMAT, version=VERSION, block_kinds=['anchor', 'substitution', 'aligned'],
             gap_reasons=['source_insertion', 'target_insertion', 'aligned_indel', 'dissimilar', 'too_big', 'conflict'],
             targets=[dict(name=n) for n in targets], sources=[dict(name=n, size=sz, uncovered=[]) for n, (i, sz) in sources.items()],
             chains=chains, nets=nets, target_files={})
    return LiftMap(m, payload={t: (b, {}) for t, b in blocks.items()})
