#!/usr/bin/env python3
"""Load and abuse test for a ``--public`` FiberBrowser server.

Simulates many anonymous viewers browsing the catalog (each with its own
client address and session, as a browser would) and, in a second phase, adds
abusive clients: one hammering the analysis endpoints, one flooding without
cookies, one asking for oversized regions. It reports latency percentiles per
request class, status counts, shared-cache hits, the server's memory, and
whether the viewers were affected.

The server must believe the simulated addresses: start it with the loopback
as a trusted proxy, e.g.

    python browser.py --public --catalog deploy/demo/catalog.json \\
        --host 127.0.0.1 --port 9001 --trusted-proxy 127.0.0.1

    python scripts/load_test_public.py --base-url http://127.0.0.1:9001 \\
        --viewers 80 --duration 60 --server-pid <pid>

Only needs httpx (and psutil, optional, for the memory samples). Point it at
your own server only.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import statistics
import subprocess
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Optional

import httpx

READ_PARAMS = {
    "hide_terminal_gaps": "true", "include_cigar": "false", "include_duplicates": "false",
    "include_layer_qualities": "false", "include_layers": "true", "include_metaprofile": "true",
    "include_methylation": "false", "infer_legacy_layers": "true", "layer_names": "nuc,tf",
    "legacy_nuc_min_size": "90", "metaprofile_layers": "nuc,tf", "min_footprints": "5",
    "ml_threshold": "125", "profile_max_reads": "1000", "sample_seed": "fiberbrowser-analysis",
    "spanning": "false", "terminal_gap_threshold": "500",
}
# The browser's quality filter default, sent on every page load.
QUALITY_FILTERS = {"filters": [{"layer": "fire", "quality_name": "aq", "min_value": 230}]}


@dataclass
class Stats:
    latency: dict = field(default_factory=lambda: defaultdict(list))
    status: dict = field(default_factory=lambda: defaultdict(Counter))
    cache: Counter = field(default_factory=Counter)

    def record(self, kind: str, started: float, response: Optional[httpx.Response], error: str = "") -> None:
        self.latency[kind].append(time.perf_counter() - started)
        if response is None:
            self.status[kind][error or "error"] += 1
            return
        self.status[kind][response.status_code] += 1
        cache = response.headers.get("x-fiberbrowser-cache")
        if cache:
            self.cache[cache] += 1


def percentile(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(q / 100 * (len(ordered) - 1)))))
    return ordered[index]


async def call(client: httpx.AsyncClient, stats: Stats, kind: str, method: str, url: str, **kw):
    started = time.perf_counter()
    try:
        response = await client.request(method, url, **kw)
    except httpx.HTTPError as exc:
        stats.record(kind, started, None, type(exc).__name__)
        return None
    stats.record(kind, started, response)
    return response


def client_for(base: str, address: str, cookies: bool = True, timeout: float = 120) -> httpx.AsyncClient:
    headers = {"X-Forwarded-For": address, "Accept-Encoding": "gzip",
               "User-Agent": "fiberbrowser-load-test", "Sec-Fetch-Site": "same-origin"}
    return httpx.AsyncClient(base_url=base, headers=headers, timeout=timeout,
                             cookies=None if cookies else httpx.Cookies(),
                             limits=httpx.Limits(max_connections=8))


async def viewer(base: str, index: int, stats: Stats, stop: float, args) -> None:
    """One visitor: open the page, load the catalog dataset, then browse."""
    address = f"10.{(index >> 8) & 255}.{index & 255}.{random.randint(1, 254)}"
    rng = random.Random(index)
    # Common screens: the read cap follows the window height.
    max_reads = rng.choice([270, 270, 306, 306, 342])
    async with client_for(base, address) as client:
        await call(client, stats, "page", "GET", "/")
        await asyncio.gather(*(call(client, stats, "startup", "GET", path) for path in
                               ("/api/status", "/api/tracks", "/api/overlays", "/api/catalog", "/api/version",
                                "/api/datasets", "/api/chroms", "/api/plugins/registry")))
        await call(client, stats, "startup", "POST", "/api/quality_filters", json=QUALITY_FILTERS)
        await call(client, stats, "startup", "POST", "/api/legacy_layer_inference",
                   json={"enabled": True, "nuc_min_size": 90})
        loaded = await call(client, stats, "startup", "POST", "/api/catalog/load?group_index=0")
        dataset = "catalog_0_0"
        if loaded is not None and loaded.status_code == 200:
            dataset = (loaded.json().get("dataset_ids") or [dataset])[0]
        # Everyone starts at the paper's locus, then pans and zooms around it.
        center, width = args.center, args.width
        first_view = True
        while time.monotonic() < stop:
            start = max(0, center - width // 2)
            end = start + width
            params = {**READ_PARAMS, "chrom": args.chrom, "dataset_id": dataset, "start": start, "end": end,
                      "max_reads": max_reads}
            view = [call(client, stats, "reads", "GET", "/api/reads/compact", params=params),
                    call(client, stats, "genes", "GET", "/api/genes",
                         params={"chrom": args.chrom, "start": start - width, "end": end + width})]
            if first_view or rng.random() < 0.05:  # the genome overview
                view.append(call(client, stats, "coverage", "GET", "/api/coverage",
                                 params={"chrom": args.chrom, "start": 0, "end": 58_617_616, "bins": 1000,
                                         "dataset_id": dataset}))
            await asyncio.gather(*view)
            first_view = False
            if rng.random() < 0.5:  # the page's peak scan after a view change
                await call(client, stats, "scan", "POST", "/api/scan_peaks",
                           params={"chrom": args.chrom, "start": start, "end": end, "dataset_id": dataset},
                           json={"min_width": 80, "min_reads": 5, "read_ids": None})
            await asyncio.sleep(rng.uniform(args.think_min, args.think_max))
            # Most views stay at the locus (shared); some pan away (own reads).
            if rng.random() < args.pan_fraction:
                center = args.center + rng.choice([-1, 1]) * rng.randint(1, 4) * width // 2
                width = rng.choice([args.width, args.width, args.width * 2])
            else:
                center, width = args.center, args.width


async def abuser_heavy(base: str, stats: Stats, stop: float, args) -> None:
    """One address running analyses as fast as it can, 20 at a time."""
    async with client_for(base, "172.16.0.66", timeout=300) as client:
        await call(client, stats, "abuse-setup", "POST", "/api/catalog/load?group_index=0")
        region = {"chrom": args.chrom, "start": args.center - 50_000, "end": args.center + 50_000,
                  "dataset_id": "catalog_0_0"}

        async def hammer():
            while time.monotonic() < stop:
                choice = random.choice(("cluster", "projection", "scan", "coacc", "render"))
                if choice == "cluster":
                    await call(client, stats, "abuse-heavy", "POST", "/api/cluster", params=region,
                               json={"k": 500, "max_reads": 0})
                elif choice == "projection":
                    await call(client, stats, "abuse-heavy", "POST", "/api/cluster_projection", params=region,
                               json={"method": "tsne", "n_components": 3})
                elif choice == "scan":
                    await call(client, stats, "abuse-heavy", "POST", "/api/scan_peaks", params=region,
                               json={"min_width": 10, "min_reads": 1, "downsample": 0})
                elif choice == "coacc":
                    await call(client, stats, "abuse-heavy", "GET", "/api/coacc/matrix/data",
                               params={**region, "bin_size": 1})
                else:
                    await call(client, stats, "abuse-heavy", "POST", "/api/render",
                               json={"chrom": args.chrom, "start": region["start"], "end": region["end"],
                                     "width": 12000, "scale": 8, "format": "png"})
        await asyncio.gather(*(hammer() for _ in range(20)))


async def abuser_flood(base: str, stats: Stats, stop: float, args) -> None:
    """One address without cookies: every request would mint a session."""
    async with client_for(base, "172.16.0.77", cookies=False) as client:
        async def flood():
            while time.monotonic() < stop:
                client.cookies.clear()
                await call(client, stats, "abuse-flood", "GET", "/api/datasets")
        await asyncio.gather(*(flood() for _ in range(10)))


async def abuser_oversize(base: str, stats: Stats, stop: float, args) -> None:
    """One address asking for whole chromosomes of reads and huge bodies."""
    async with client_for(base, "172.16.0.88") as client:
        while time.monotonic() < stop:
            await call(client, stats, "abuse-oversize", "GET", "/api/reads/compact",
                       params={"chrom": args.chrom, "start": 0, "end": 58_000_000, "dataset_id": "catalog_0_0",
                               "max_reads": 10_000_000})
            await call(client, stats, "abuse-oversize", "POST", "/api/reads/compile",
                       content=b'{"regions": [' + b",".join([b'{"chrom":"chr19","start":0,"end":100}'] * 60_000) + b"]}",
                       headers={"content-type": "application/json"})
            await call(client, stats, "abuse-oversize", "POST", "/api/tracks/add_motif_pwm",
                       files={"file": ("x.bam", b"x" * 10_000)})


_processes: dict = {}


def process_sample(pid: Optional[int]):
    """(RSS MB, CPU %) of the server process (psutil, else ps)."""
    if not pid:
        return None
    try:
        import psutil
        proc = _processes.setdefault(pid, psutil.Process(pid))
        return proc.memory_info().rss / 2**20, proc.cpu_percent(interval=None)
    except ImportError:
        pass
    except Exception:
        return None
    try:
        out = subprocess.run(["ps", "-o", "rss=,pcpu=", "-p", str(pid)], capture_output=True, text=True, check=True)
        rss, cpu = out.stdout.split()
        return int(rss) / 1024, float(cpu)
    except Exception:
        return None


async def sample_memory(pids: list[int], samples: list, stop: float, cpu: list) -> None:
    """Total RSS and CPU of the server processes (several behind a load balancer)."""
    for pid in pids:
        process_sample(pid)  # prime psutil's CPU counters
    while time.monotonic() < stop:
        await asyncio.sleep(1.0)
        values = [v for v in (process_sample(pid) for pid in pids) if v is not None]
        if values:
            samples.append(sum(v[0] for v in values))
            cpu.append(sum(v[1] for v in values))


def summarize(name: str, stats: Stats, memory: list, elapsed: float, cpu: Optional[list] = None) -> dict:
    report = {"phase": name, "seconds": round(elapsed, 1), "classes": {}, "cache": dict(stats.cache)}
    print(f"\n=== {name} ({elapsed:.0f} s) ===")
    print(f"{'class':<16}{'n':>7}{'p50 ms':>9}{'p95 ms':>9}{'p99 ms':>9}{'max ms':>9}  statuses")
    for kind in sorted(stats.latency):
        values = stats.latency[kind]
        row = {"n": len(values), "p50_ms": percentile(values, 50) * 1000, "p95_ms": percentile(values, 95) * 1000,
               "p99_ms": percentile(values, 99) * 1000, "max_ms": max(values) * 1000,
               "status": {str(k): v for k, v in stats.status[kind].items()}}
        report["classes"][kind] = row
        print(f"{kind:<16}{row['n']:>7}{row['p50_ms']:>9.0f}{row['p95_ms']:>9.0f}{row['p99_ms']:>9.0f}"
              f"{row['max_ms']:>9.0f}  {dict(stats.status[kind])}")
    viewer_kinds = ("page", "startup", "reads", "genes", "coverage", "scan")
    total = sum(sum(stats.status[k].values()) for k in viewer_kinds)
    failed = sum(v for k in viewer_kinds for s, v in stats.status[k].items() if not (isinstance(s, int) and s < 400))
    report["viewer_requests"] = total
    report["viewer_failures"] = failed
    hits, misses = stats.cache.get("hit", 0), stats.cache.get("miss", 0)
    report["cache_hit_ratio"] = hits / (hits + misses) if hits + misses else None
    if memory:
        report["rss_mb"] = {"start": memory[0], "max": max(memory), "end": memory[-1]}
    if cpu:
        report["cpu_percent"] = {"mean": statistics.mean(cpu), "max": max(cpu)}
        print(f"server CPU: mean {statistics.mean(cpu):.0f}%, max {max(cpu):.0f}% (100% = one core)")
    report["rss_note"] = "sum over the sampled server processes"
    print(f"viewer requests {total}, failed (non-2xx/3xx or errors) {failed} "
          f"({(failed / total * 100) if total else 0:.2f}%); "
          f"cache hits {hits}, misses {misses}"
          + (f"; RSS start {memory[0]:.0f} MB, max {max(memory):.0f} MB, end {memory[-1]:.0f} MB" if memory else ""))
    return report


async def run_phase(name: str, args, abusive: bool) -> dict:
    stats = Stats()
    started = time.monotonic()
    stop = started + args.duration
    memory: list[float] = []
    cpu: list[float] = []
    tasks = [viewer(args.base_url, i + (1000 if abusive else 0), stats, stop, args) for i in range(args.viewers)]
    if abusive:
        tasks += [abuser_heavy(args.base_url, stats, stop, args), abuser_flood(args.base_url, stats, stop, args),
                  abuser_oversize(args.base_url, stats, stop, args)]
    pids = [int(p) for p in str(args.server_pid or "").split(",") if p.strip()]
    tasks.append(sample_memory(pids, memory, stop, cpu))
    # Viewers arrive over the first few seconds, as people following a link would.
    async def staggered(task, delay):
        await asyncio.sleep(delay)
        await task
    await asyncio.gather(*(staggered(t, random.uniform(0, args.ramp)) for t in tasks))
    return summarize(name, stats, memory, time.monotonic() - started, cpu)


async def main_async(args) -> None:
    async with httpx.AsyncClient(base_url=args.base_url, timeout=10) as probe:
        health = await probe.get("/api/health")
        health.raise_for_status()
    reports = []
    if not args.skip_baseline:
        reports.append(await run_phase(f"{args.viewers} viewers", args, abusive=False))
    reports.append(await run_phase(f"{args.viewers} viewers + abusive clients", args, abusive=True))
    if len(reports) == 2:
        base, abuse = reports
        for kind in ("reads", "genes", "page"):
            if kind in base["classes"] and kind in abuse["classes"]:
                print(f"viewer {kind} p95: {base['classes'][kind]['p95_ms']:.0f} ms alone, "
                      f"{abuse['classes'][kind]['p95_ms']:.0f} ms with abusers")
    if args.json:
        with open(args.json, "w") as handle:
            json.dump(reports, handle, indent=2, default=str)
        print(f"\nwrote {args.json}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:9001")
    parser.add_argument("--viewers", type=int, default=60)
    parser.add_argument("--duration", type=float, default=90, help="seconds per phase")
    parser.add_argument("--ramp", type=float, default=5, help="viewers arrive over this many seconds")
    parser.add_argument("--chrom", default="chr19")
    parser.add_argument("--center", type=int, default=47_516_640)
    parser.add_argument("--width", type=int, default=2_000)
    # A reader looks at a view for a while before moving on.
    parser.add_argument("--think-min", type=float, default=5.0)
    parser.add_argument("--think-max", type=float, default=20.0)
    parser.add_argument("--pan-fraction", type=float, default=0.3,
                        help="share of view changes that leave the shared locus")
    parser.add_argument("--server-pid", default=None,
                        help="sample these processes' memory and CPU (comma-separated pids)")
    parser.add_argument("--skip-baseline", action="store_true")
    parser.add_argument("--json", default=None, help="also write the numbers here")
    args = parser.parse_args()
    random.seed(os.getpid())
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
