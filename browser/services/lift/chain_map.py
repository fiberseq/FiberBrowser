"""Plain UCSC ``.chain`` maps (liftOver, CHM13<->GRCh38, ...) as an in-memory LiftMap.

The reader and net builder follow graphlift's own Python fallback
(``scripts/chainlib.py`` and ``sidecar_from_chain`` in ``scripts/graphlift_map.py``,
graphlift 3dd79b9, MIT, our own code); they are re-implemented here because the
vendored ``graphlift_map.py`` body must stay byte-identical and imports
``chainlib``, which FiberBrowser does not ship. Additions over that fallback:
gzip input, target and source sizes from the chain headers, and validation.

What a plain chain cannot say, and this loader does not invent:
- primary flags come from a score-ranked net (the Rust builder's span policy:
  bridge target gaps < ``min_gap``), without its structural-conflict exemptions;
- gap reasons are guessed from shape (dt == 0: source insertion, dq == 0:
  target insertion, else dissimilar); there are no bubble fills or provenance.
Coordinates and blocks are exactly the chain's.
"""
from __future__ import annotations

import bisect
import gzip

from services.lift.graphlift_map import FORMAT, VERSION, LiftMap, haplotype_of

CHAIN_SUFFIXES = (".chain", ".chain.gz", ".over.chain", ".over.chain.gz")


def is_chain_path(path: str) -> bool:
    return str(path).lower().endswith(CHAIN_SUFFIXES)


class _Chain:
    __slots__ = ("score", "tname", "tsize", "tstart", "tend", "qname", "qsize", "qstrand", "qstart", "qend", "id",
                 "blocks", "_t", "_q")

    def __init__(self, fields, line_no):
        if len(fields) < 12:
            raise ValueError(f"chain header on line {line_no} has {len(fields)} fields (12 or 13 expected)")
        self.score = int(float(fields[1]))
        self.tname, self.tsize = fields[2], int(fields[3])
        if fields[4] != "+":
            raise ValueError(f"chain on line {line_no}: target strand must be '+'")
        self.tstart, self.tend = int(fields[5]), int(fields[6])
        self.qname, self.qsize, self.qstrand = fields[7], int(fields[8]), fields[9]
        if self.qstrand not in "+-":
            raise ValueError(f"chain on line {line_no}: query strand must be '+' or '-'")
        self.qstart, self.qend = int(fields[10]), int(fields[11])
        self.id = fields[12] if len(fields) > 12 else str(line_no)
        self.blocks = []
        self._t, self._q = self.tstart, self.qstart

    def add(self, nums, line_no):
        if len(nums) not in (1, 3) or any(n < 0 for n in nums):
            raise ValueError(f"chain data on line {line_no}: expected 'size' or 'size dt dq'")
        self.blocks.append((self._t, self._q, nums[0]))
        self._t += nums[0]
        self._q += nums[0]
        if len(nums) == 3:
            self._t += nums[1]
            self._q += nums[2]

    def finish(self):
        if not self.blocks or self._t != self.tend or self._q != self.qend:
            raise ValueError(f"chain {self.id}: blocks do not end at the header's target/query end")

    def gaps(self):
        for a, b in zip(self.blocks, self.blocks[1:]):
            t0, q0 = a[0] + a[2], a[1] + a[2]
            yield t0, q0, b[0] - t0, b[1] - q0


def read_chains(path):
    opener = gzip.open if open(path, "rb").read(2) == b"\x1f\x8b" else open
    out = []
    with opener(path, "rt") as fh:
        for n, line in enumerate(fh, 1):
            if line.startswith("chain"):
                if out:
                    out[-1].finish()
                out.append(_Chain(line.split(), n))
            elif line.strip() and not line.startswith("#"):
                if not out:
                    raise ValueError(f"chain data before any header (line {n})")
                out[-1].add([int(x) for x in line.split()], n)
    if not out:
        raise ValueError("no chains in this file")
    out[-1].finish()
    return out


def load_chain_map(path, haplotypes=None, min_gap=200):
    """An in-memory ``LiftMap`` (sidecar format v2 shape) for a UCSC chain file."""
    cs = read_chains(path)
    targets, sources, chains, blocks = {}, {}, [], {}
    for i, c in enumerate(cs):
        ti = targets.setdefault(c.tname, (len(targets), c.tsize))[0]
        si = sources.setdefault(c.qname, (len(sources), c.qsize))[0]
        hap = haplotype_of(c.qname, haplotypes)
        qf = (c.qstart, c.qend) if c.qstrand == "+" else (c.qsize - c.qend, c.qsize - c.qstart)
        gaps = [(t0, q0, dt, dq, 0 if dt == 0 else (1 if dq == 0 else 3)) for t0, q0, dt, dq in c.gaps()]
        chains.append(dict(key=c.id, ucsc_id=int(c.id) if c.id.isdigit() else i, haplotype=hap, target=ti, source=si,
                           strand=c.qstrand, t_start=c.tstart, t_end=c.tend, q_start=c.qstart, q_end=c.qend,
                           q_start_forward=qf[0], q_end_forward=qf[1], score=c.score,
                           aligned=sum(b[2] for b in c.blocks)))
        b = blocks.setdefault(ti, {"target": c.tname, "blocks": {}, "gaps": {}})
        b["blocks"][i] = [list(x) for x in c.blocks]
        b["gaps"][i] = gaps
    nets = {}
    for hap in sorted({c["haplotype"] for c in chains}):
        idx = sorted((i for i, c in enumerate(chains) if c["haplotype"] == hap), key=lambda i: (-chains[i]["score"], i))
        rank = {ci: r for r, ci in enumerate(idx)}
        rows = []
        for t, _size in targets.values():
            claims = []
            for ci in idx:
                if chains[ci]["target"] != t:
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
        nets[hap] = [list(r) for r in rows]
    manifest = dict(format=FORMAT, version=VERSION, block_kinds=["anchor", "substitution", "aligned"],
                    gap_reasons=["source_insertion", "target_insertion", "aligned_indel", "dissimilar", "too_big", "conflict"],
                    targets=[dict(name=n, size=sz) for n, (_i, sz) in targets.items()],
                    sources=[dict(name=n, size=sz, uncovered=[]) for n, (_i, sz) in sources.items()],
                    chains=chains, nets=nets, target_files={}, plain_chain=True)
    return LiftMap(manifest, payload={t: (b, {}) for t, b in blocks.items()})
