"""Meta-locus phase 1 benchmark: background build (cold), cache reopen, working sets by stored file position, More
reads, Resample; wall-clock and peak RSS per phase, with the load average. Data: scripts/meta_locus_synth.py or any
local BAMs with a BED.

    python scripts/benchmark_meta_locus_pool.py --bam d1.bam --bam d2.bam --bed sites.bed [--sites 20000]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))

import psutil

PROC = psutil.Process()


class Peak:
    def __enter__(self):
        self.peak, self.stop = PROC.memory_info().rss, threading.Event()
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()
        self.t0 = time.perf_counter()
        return self

    def _run(self):
        while not self.stop.wait(0.02):
            self.peak = max(self.peak, PROC.memory_info().rss)

    def __exit__(self, *exc):
        self.s = time.perf_counter() - self.t0
        self.stop.set()
        self.t.join()

    def out(self, **kw):
        return dict(s=round(self.s, 3), peak_rss_mb=round(max(self.peak, PROC.memory_info().rss) / 2**20, 1),
                    load=round(os.getloadavg()[0], 2), **kw)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bam", action="append", required=True)
    p.add_argument("--bed", help="sites (or --tile-spacing)")
    p.add_argument("--tile-spacing", type=int, default=0, help="sites every N bp over each contig's read extent (first BAM)")
    p.add_argument("--policy", default="per_site")
    p.add_argument("--sites", type=int, default=0)
    p.add_argument("--flank", type=int, default=10_000)
    p.add_argument("--working", type=int, default=2000)
    p.add_argument("--more", type=int, default=1000)
    p.add_argument("--layers", action="store_true", help="decode with annotation layers (default: primary intervals)")
    p.add_argument("--cache-dir")
    p.add_argument("--decode-workers", type=int, default=0, help="0: automatic, 1: in process")
    p.add_argument("--warm-s", type=float, default=3.0, help="wait after the pool is ready (workers start then)")
    p.add_argument("--out")
    a = p.parse_args()
    os.environ.setdefault("FIBERBROWSER_META_LOCUS_CACHE_DIR", a.cache_dir or tempfile.mkdtemp(prefix="metalocus_bench_"))
    from models.domain import Dataset
    from routers.files import parse_bed_regions
    from services import meta_locus_jobs as mj
    from services.plots_regions import subsample_regions

    if a.tile_spacing:
        import pysam
        regions = []
        with pysam.AlignmentFile(a.bam[0]) as f:
            for st in f.get_index_statistics():
                if not st.mapped:
                    continue
                lo = hi = None
                for r in f.fetch(st.contig):
                    lo = r.reference_start if lo is None else lo
                    hi = max(hi or 0, r.reference_end or 0)
                for i, x in enumerate(range(lo, hi, a.tile_spacing)):
                    regions.append([st.contig, x, x + 1, "+" if (i * 2654435761) & 1 else "-", f"t{len(regions)}"])
    else:
        regions = parse_bed_regions(Path(a.bed).read_text())["regions"]
    if a.sites and a.sites < len(regions):
        idx = subsample_regions([{"id": "bed", "regions": regions}], "random", a.sites, 1, 10**9)[0]
        regions = [regions[i] for i in idx]
    ids = [f"d{i + 1}" for i in range(len(a.bam))]
    state = SimpleNamespace(datasets={d: Dataset(d, b, data_type="bam") for d, b in zip(ids, a.bam)}, dataset_order=ids,
                            chrom_map={}, short_terminal_footprint_bp=0)
    res = {"argv": sys.argv[1:], "sites": len(regions), "cpu": os.cpu_count(), "load_start": os.getloadavg()}
    body = {"flank_bp": a.flank, "policy": a.policy}
    ws_opts = {"include_layers": a.layers, "include_layer_qualities": False, "decode_workers": a.decode_workers}
    with Peak() as ph:
        pool = mj.start_pool(state, body, regions, "bench")
        first_provisional = None
        while pool.status == "building":
            if first_provisional is None and pool.progress.entries >= a.working:
                t = time.perf_counter()
                w = mj.working_set(pool, {"seed": 1, "count": a.working, **ws_opts}, state)
                first_provisional = dict(after_s=round(time.perf_counter() - ph.t0, 2), decode_s=round(time.perf_counter() - t, 2),
                                         returned=w["returned"], fraction=w["pool_fraction"])
            time.sleep(0.05)
    res["build"] = ph.out(status=pool.status, error=pool.error, progress=pool.progress.as_dict(),
                          entries={d: len(ix) for d, ix in pool.indexes.items()},
                          index_mb=round(sum(ix.nbytes() for ix in pool.indexes.values()) / 2**20, 1), provisional_working_set=first_provisional)
    import numpy as np
    overlap = {}
    for d, ix in pool.indexes.items():
        per_mol = np.bincount(ix.mol, minlength=ix.n_molecules) if len(ix) else np.zeros(0, int)
        overlap[d] = dict(molecules=int(ix.n_molecules), entries=int(len(ix)),
                          molecules_in_several_windows=round(float((per_mol > 1).mean()) if len(per_mol) else 0.0, 4),
                          windows_per_molecule_mean=round(float(per_mol.mean()) if len(per_mol) else 0.0, 2),
                          windows_per_molecule_max=int(per_mol.max()) if len(per_mol) else 0)
    res["overlap"] = overlap
    mj._pools.clear()
    with Peak() as ph:
        pool = mj.start_pool(state, body, regions, "bench")
    res["cache_reopen"] = ph.out(status=pool.status, datasets=dict(pool.dataset_status))
    if a.decode_workers != 1:
        from services.meta_locus_decode import warm_workers
        warm_workers(a.decode_workers or None)
    time.sleep(a.warm_s)
    res["decode_workers"] = a.decode_workers
    with Peak() as ph:
        w = mj.working_set(pool, {"seed": 1, "count": a.working, **ws_opts}, state)
    res["working_set"] = ph.out(returned=w["returned"], stats=w["stats"])
    import orjson
    res["payload_bytes_per_read"] = round(len(orjson.dumps(w["reads"])) / max(1, len(w["reads"])))
    more = []
    cursor = w["cursor"]
    for _ in range(3):
        with Peak() as ph:
            m = mj.working_set(pool, {"seed": 1, "count": a.more, "cursor": cursor, **ws_opts}, state)
        cursor = m["cursor"]
        more.append(ph.out(returned=m["returned"]))
    res["more_reads"] = more
    with Peak() as ph:
        r = mj.working_set(pool, {"seed": 2, "count": a.working, **ws_opts}, state)
    res["resample"] = ph.out(returned=r["returned"])
    with Peak() as ph:
        big = mj.working_set(pool, {"seed": 1, "count": 5000, **ws_opts}, state)
    res["working_set_5k"] = ph.out(returned=big["returned"])
    res["load_end"] = os.getloadavg()
    text = json.dumps(res, indent=1)
    if a.out:
        Path(a.out).write_text(text)
    print(text)


if __name__ == "__main__":
    main()
