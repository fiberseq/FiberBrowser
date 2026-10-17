#!/usr/bin/env python
"""Live-lift P1 benchmarks (DESIGN_LIVE_LIFT.md §5.1, §6).

Navigation tables on a sidecar (chr1 and the whole genome): summary, outline
and tile sizes, build and decode times (Python, and JavaScript under node when
available), lookup times target->source and source->target. With --src-bam /
--native-bam also the §6 load targets on 50 kb views: selection (bin cache cold
and warm), source decode vs lift pass, lifted load vs a native decode of the
same molecules.

usage: benchmark_live_lift.py SIDECAR [--chrom chr1] [--src-bam BAM --native-bam BAM
       --haplotype HAP --views N --view-lo N --view-hi N] [--json OUT]"""
import argparse
import gzip
import json
import os
import random
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "browser"))

from services.lift import live_lift as ll  # noqa: E402
from services.lift import navigation as nav  # noqa: E402

JS_DECODER = r"""
const fs = require('fs');
function decode(buf) {
  let pos = 5;
  const uv = () => { let r = 0, s = 0, b; do { b = buf[pos++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b >= 0x80); return r; };
  const unzz = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
  const tile = uv(), n = uv();
  const start = new Float64Array(n), end = new Float64Array(n), other = new Float64Array(n), chain = new Uint32Array(n);
  let pe = tile * 1e6, po = 0;
  for (let i = 0; i < n; i++) {
    const s = pe + unzz(uv()); const e = s + uv(); const o = po + unzz(uv()); chain[i] = uv();
    start[i] = s; end[i] = e; other[i] = o; pe = e; po = o;
  }
  return { start, end, other, chain };
}
const files = JSON.parse(fs.readFileSync(process.argv[2]));
const times = [];
for (const f of files) {
  const buf = fs.readFileSync(f);
  decode(buf);                                   // warm the JIT on this shape
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 20; k++) decode(buf);
  times.push(Number(process.hrtime.bigint() - t0) / 20 / 1e6);
}
console.log(JSON.stringify(times));
"""


def pct(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


def ms(t0):
    return round((time.perf_counter() - t0) * 1000, 3)


def size_stats(blobs):
    sizes = [len(b) for b in blobs]
    return {"tiles": len(sizes), "median_bytes": pct(sizes, 0.5), "p95_bytes": pct(sizes, 0.95),
            "max_bytes": max(sizes) if sizes else 0, "total_bytes": sum(sizes)}


def js_decode_times(blobs):
    node = shutil.which("node")
    if not node or not blobs:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        files = []
        for i, b in enumerate(blobs):
            path = os.path.join(tmp, f"t{i}.bin")
            with open(path, "wb") as fh:
                fh.write(b)
            files.append(path)
        listing = os.path.join(tmp, "files.json")
        with open(listing, "w") as fh:
            json.dump(files, fh)
        script = os.path.join(tmp, "decode.js")
        with open(script, "w") as fh:
            fh.write(JS_DECODER)
        out = subprocess.run([node, script, listing], capture_output=True, text=True, check=True).stdout
    times = json.loads(out)
    return {"median_ms": round(pct(times, 0.5), 4), "p95_ms": round(pct(times, 0.95), 4),
            "max_ms": round(max(times), 4)}


def navigation_bench(handle, chroms, label, rng):
    out = {"label": label}
    t0 = time.perf_counter()
    summary = nav.map_summary(handle)
    out["summary_build_ms"] = ms(t0)
    raw = nav.encode_json(summary)
    gz = gzip.compress(raw)
    t0 = time.perf_counter()
    json.loads(gzip.decompress(gz))
    out["summary"] = {"rows": len(summary), "json_bytes": len(raw), "gzip_bytes": len(gz),
                      "decode_ms": ms(t0)}

    t0 = time.perf_counter()
    pieces = {c: nav.primary_pieces(handle, c) for c in chroms}
    out["primary_pieces_ms"] = ms(t0)
    out["primary_runs"] = sum(len(v) for v in pieces.values())
    exact_json = gzip.compress(nav.encode_json([[p.t_start, p.t_end, p.q_start, p.q_end, p.strand, p.chain]
                                                for c in chroms for p in pieces[c]]))
    out["exact_runs_json_gzip_bytes"] = len(exact_json)

    t0 = time.perf_counter()
    outlines = {c: nav.outline(handle, c, pieces[c]) for c in chroms}
    out["outline_build_ms"] = ms(t0)
    gz_sizes = {c: len(gzip.compress(nav.encode_json(rows))) for c, rows in outlines.items()}
    out["outline"] = {"rows": sum(len(r) for r in outlines.values()), "gzip_bytes_total": sum(gz_sizes.values()),
                      "gzip_bytes_max_chrom": max(gz_sizes.values()),
                      "max_chrom": max(gz_sizes, key=gz_sizes.get),
                      "max_drift_p95": pct([r[6] for rows in outlines.values() for r in rows], 0.95),
                      "max_drift_max": max(r[6] for rows in outlines.values() for r in rows)}

    t0 = time.perf_counter()
    target_tiles = {(c, k): b for c in chroms for k, b in nav.build_tiles(pieces[c], 0).items()}
    by_source = {}
    for c in chroms:
        for p in pieces[c]:
            by_source.setdefault(p.source, []).append(p)
    source_tiles = {(s, k): b for s, ps in by_source.items() for k, b in nav.build_tiles(ps, 1).items()}
    out["tile_build_ms"] = ms(t0)
    out["target_tiles"] = size_stats(list(target_tiles.values()))
    out["source_tiles"] = size_stats(list(source_tiles.values()))

    sample = rng.sample(list(target_tiles.values()), min(200, len(target_tiles)))
    times = []
    for b in sample:
        t0 = time.perf_counter()
        nav.decode_tile(b)
        times.append((time.perf_counter() - t0) * 1000)
    out["tile_decode_python_ms"] = {"median": round(pct(times, 0.5), 3), "p95": round(pct(times, 0.95), 3),
                                    "max": round(max(times), 3)}
    biggest = sorted(target_tiles.values(), key=len)[-20:]
    out["tile_decode_js_ms"] = js_decode_times(sample + biggest)

    # Lookups with every needed tile decoded once (the client's LRU).
    decoded_t = {k: nav.decode_tile(b) for k, b in target_tiles.items()}
    decoded_s = {k: nav.decode_tile(b) for k, b in source_tiles.items()}
    sizes = {c: handle.target_size(c) for c in chroms}
    hits = []
    t0 = time.perf_counter()
    n = 20_000
    for _ in range(n):
        c = rng.choice(chroms)
        t = rng.randrange(0, sizes[c])
        tile = decoded_t.get((c, t // nav.TILE_BP))
        if tile is not None:
            hits.extend((c, chain, q) for chain, q in nav.tile_lookup(tile, t)[:1])
    out["lookup_target_to_source_us"] = round((time.perf_counter() - t0) / n * 1e6, 2)
    sources = [(handle.manifest["sources"][handle.map.chains[chain]["source"]]["name"], q) for _c, chain, q in hits]
    t0 = time.perf_counter()
    for s, q in sources:
        nav.tile_lookup(decoded_s[(s, q // nav.TILE_BP)], q)
    out["lookup_source_to_target_us"] = round((time.perf_counter() - t0) / max(1, len(sources)) * 1e6, 2)
    outline_index = {c: nav.Outline(rows) for c, rows in outlines.items()}
    t0 = time.perf_counter()
    for _ in range(n):
        c = rng.choice(chroms)
        outline_index[c].lookup(rng.randrange(0, sizes[c]))
    out["lookup_outline_us"] = round((time.perf_counter() - t0) / n * 1e6, 2)
    return out


def load_bench(sidecar, src_bam, native_bam, chrom, hap, views, lo, hi, rng):
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.lift.compose import lift_compact_reads

    ll.clear_selection_cache()
    t0 = time.perf_counter()
    handle = ll.LiftMapHandle(sidecar)
    open_ms = ms(t0)
    t0 = time.perf_counter()
    handle.map.target_to_source(chrom, 0, 1)
    chrom_load_ms = ms(t0)
    settings = ll.LiftSettings()
    key = ll.lift_key(handle, [hap], settings)
    options = dict(include_methylation=True, include_cigar=False, hide_terminal_gaps=True)
    rows = []
    for i in range(views):
        s = rng.randrange(lo, hi - 50_000)
        e = s + 50_000
        t0 = time.perf_counter()
        sel = ll.select_pieces(handle, chrom, s, e, haplotypes=[hap], settings=settings, key=key, use_cache=False)
        fresh = ms(t0)
        t0 = time.perf_counter()
        ll.select_pieces(handle, chrom, s, e, haplotypes=[hap], settings=settings, key=key)
        cold = ms(t0)
        t0 = time.perf_counter()
        s100 = ll.select_pieces(handle, chrom, s, s + 100_000, haplotypes=[hap], settings=settings, key=key)
        warm100 = ms(t0)
        t0 = time.perf_counter()
        plan = ll.plan_fetch(sel, settings)
        plan_ms = ms(t0)
        t0 = time.perf_counter()
        decoded = ll.decode_source_records([src_bam], plan, loader_options=options)
        decode_ms = ms(t0)
        t0 = time.perf_counter()
        molecules = ll.resolve_primary_metadata(handle, decoded, settings=settings, counts={})
        lifted = lift_compact_reads(decoded, plan, handle=handle, region_start=sel.start, region_end=sel.end,
                                    settings=settings, key=key, dataset_id="bench", molecules=molecules,
                                    loader_options=options)
        lift_ms = ms(t0)
        t0 = time.perf_counter()
        native = build_compact_reads_from_bam(native_bam, chrom, sel.start, sel.end, spanning_only=False, **options)
        native_ms = ms(t0)
        rows.append({"view": [s, e], "pieces": len(sel.pieces), "selection_fresh_ms": fresh,
                     "selection_bincache_cold_ms": cold, "selection_100kb_warm_ms": warm100,
                     "plan_ms": plan_ms, "source_records": len(decoded), "source_decode_ms": decode_ms,
                     "lift_ms": lift_ms, "lifted_rows": len(lifted), "native_records": len(native),
                     "native_decode_ms": native_ms,
                     "lift_over_decode": round(lift_ms / max(decode_ms, 1e-9), 3),
                     "lifted_over_native": round((decode_ms + lift_ms) / max(native_ms, 1e-9), 3)})
        del s100
    summary = {k: {"median": pct([r[k] for r in rows[1:]], 0.5), "p95": pct([r[k] for r in rows[1:]], 0.95)}
               for k in ("selection_fresh_ms", "selection_bincache_cold_ms", "selection_100kb_warm_ms", "plan_ms",
                         "source_decode_ms", "lift_ms", "native_decode_ms", "lift_over_decode",
                         "lifted_over_native")}
    return {"sidecar_open_ms": open_ms, "target_chrom_first_load_ms": chrom_load_ms, "views": rows,
            "summary_excluding_first_view": summary}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sidecar")
    ap.add_argument("--chrom", default="chr1")
    ap.add_argument("--src-bam")
    ap.add_argument("--native-bam")
    ap.add_argument("--haplotype")
    ap.add_argument("--views", type=int, default=12)
    ap.add_argument("--view-lo", type=int, default=19_600_000)
    ap.add_argument("--view-hi", type=int, default=23_700_000)
    ap.add_argument("--skip-genome", action="store_true")
    ap.add_argument("--json")
    a = ap.parse_args()
    from services.gc_tuning import configure_gc
    configure_gc()  # the server's collector settings (services/gc_tuning.py)
    rng = random.Random(11)
    result = {}
    t0 = time.perf_counter()
    handle = ll.LiftMapHandle(a.sidecar)
    result["sidecar_open_ms"] = ms(t0)
    t0 = time.perf_counter()
    handle.map.target_to_source(a.chrom, 0, 1)
    result["chrom_first_load_ms"] = ms(t0)
    result["nav_chrom"] = navigation_bench(handle, [a.chrom], a.chrom, rng)
    if not a.skip_genome:
        t0 = time.perf_counter()
        chroms = [t["name"] for t in handle.manifest["targets"]]
        for c in chroms:
            handle.map.target_to_source(c, 0, 1)
        result["genome_load_ms"] = ms(t0)
        result["nav_genome"] = navigation_bench(handle, chroms, "genome", rng)
    if a.src_bam and a.native_bam:
        hap = a.haplotype or handle.haplotypes[0]
        result["load"] = load_bench(a.sidecar, a.src_bam, a.native_bam, a.chrom, hap, a.views, a.view_lo,
                                    a.view_hi, rng)
    print(json.dumps(result, indent=1))
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(result, fh, indent=1)


if __name__ == "__main__":
    main()
