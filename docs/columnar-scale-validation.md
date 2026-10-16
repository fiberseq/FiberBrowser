# Columnar clustering scale validation

`scripts/benchmark_columnar_scale.py` generates deterministic BAM records and
exercises the real uncapped combinatorial clustering endpoint. Each record has
a unique name, a 3,000-base alignment, and one of 256 programmed occupancy
patterns across eight nucleosome features. Annotation coordinates, lengths and
qualities vary between molecules while preserving the programmed pattern.

The check verifies every assignment, all eligible and feature-covering counts,
the top 50 patterns, frequency ties, nearest-pattern ties and cluster totals.
It also verifies that broad and working-set caches retain packed reads. A
second request tests a revisit in the same process. Each response is encoded
through FastAPI's JSON encoder and the application's ORJSON response class;
serialization is timed separately from analysis.

Run from the repository root with FiberHMM and the browser dependencies
installed, using a fresh local output directory:

```bash
PYTHONPATH=browser python scripts/benchmark_columnar_scale.py prepare --count 500000 --root /tmp/fiberbrowser-scale
PYTHONPATH=browser OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 python scripts/benchmark_columnar_scale.py run --count 500000 --root /tmp/fiberbrowser-scale
PYTHONPATH=browser python scripts/benchmark_columnar_scale.py prepare --count 1000000 --root /tmp/fiberbrowser-scale
PYTHONPATH=browser OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 python scripts/benchmark_columnar_scale.py run --count 1000000 --root /tmp/fiberbrowser-scale
```

Prepare the inputs before timing. Run the measurements serially on an otherwise
idle machine; prevent system sleep for their duration. The harness uses one
decode worker, no prefetch margin and 512 MiB budgets for each of the broad and
working-set caches. It does not change the owner's browser settings.

Results include source hashes, an input hash, analysis phase timings, assignment
digests, response sizes, retained cache bytes and columnar storage diagnostics.
RSS and available system memory are sampled every 100 ms across analysis,
serialization and validation; the process high-water RSS is also recorded.
Errors preserve the memory samples and completed visits in a failure report.

These are deterministic engineering checks. They do not measure browser
rendering, HTTP transfer, biological accuracy or genome-scale workstation
performance. The statistical engine and full result schema are unchanged;
assignment maps and membership lists still grow with the cohort size.

## Recorded run: 10 October 2026

Apple M3 Max, 16 CPU cores, 64 GiB RAM; macOS 26.7.1; Python 3.10.13,
NumPy 1.26.4; pinned FiberHMM 3.0 candidate `a210fc4`. One fresh-process
first/revisit pair per depth, serial, with system sleep inhibited. All 500,000
and 1,000,000 assignments and counts passed; assignment digests were identical
between first visit and revisit. Input and measured-source hashes were checked
after the runs.

| Molecules | First analysis (s) | Revisit analysis (s) | Serialization first / revisit (s) | OS peak RSS (GiB) | Sampled peak RSS (GiB) | Pattern bytes | First response bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 500,000 | 79.73 | 19.39 | 1.05 / 1.06 | 0.981 | 0.920 | 4,000,000 | 12,424,444 |
| 1,000,000 | 164.41 | 43.50 | 2.15 / 2.17 | 1.725 | 1.710 | 8,000,000 | 24,846,368 |

Both depths used at most 512 expanded feature rows and 131,072 bytes (128 KiB)
for a positional-feature block. The response sizes describe the real API
response, not all internal clustering state. Measurements cover these generated
BAMs and eight equal-width features; native-parity regression tests separately
cover unequal widths, footprint classes, modification marks and threshold
precision. No display speed or biological inference is derived from this run.
