# Feature hub API adoption

The browser uses the public nucleosome record-output tuple, measured recurrence
track, and cached group contracts/frame context. The former record calculation,
track arithmetic and record-header wrapper have been removed.

Association jobs pass cancellation and progress callbacks into the public
association functions. M2 phasing pools datasets while selecting each molecule's
own calibration. Dataset groups receive FiberHMM's interaction test. The Q2
preset rediscovers NFR anchors on physical-molecule hash halves, tests the
opposite half, and reverses the halves. Discovery territory comes from the
requested scope or completed scan zones, independently of full-data hits.
Cross-fit pooled estimates use independent null draws; group contrasts remain
separate readouts for the two held-out directions.

M3 can take a state set from another scan. Bindings translate dataset labels;
reference/frame checks and shared callable territory protect the comparison.
The overlay accepts loaded MA groups and scan state/mark groups. Unknown states
are excluded from denominators. Graph observations map through unique node
columns, respecting reversal and path clips; different alleles and repeated
nodes stay unmeasured.

## Target-frame evidence gate

Compact rows supply the target CIGAR through their molecular spans. Complete
source records supply sequence, flags, qualities and molecular annotations.
SAM auxiliary types are preserved: changing an `A` tag to `Z` changes the record
hash and can change discovery. Split alignments retain the longest segment as
primary. Evidence covers the entire input population used by calibration.
Lifted snapshot identities differ from source BAM identities, and saved record
maps join states and nucleosome outputs back to original records.

AluY (423 target records, eight units) and MHC (2,141 target records, 26 units)
passed exact comparison of all 27 public tables across `fp`, `nfr`, `nuc` and
`peaks`, including record hashes and calibration-derived values. No known-category
exemptions were needed. The sanitized table counts are recorded for
[AluY](validation/api-adoption/lift-aluy.json) and
[MHC](validation/api-adoption/lift-mhc.json). Parameters on both sides were:

```json
{"nfr":{"nfr":{"bootstrap":0,"kmax":3,"splits":2}},"nuc":{"calibration":"self"}}
```

`scripts/scan_lift_parity.py` reproduces the comparison with explicit input,
map, region and output arguments. The synthetic regression invokes a fresh
native `fiberhmm-lift` before comparing scan tables. Set
`FIBERBROWSER_TEST_LIFTBAM` to enable that regression.

Target-frame live-lift scans are enabled after these gates. Truncated,
hard-clipped, folded or noncolinear evidence is refused rather than scanned as
an incomplete population. Genome-scale performance remains a separate audit
work item.

## Coordinator browser checks

Run `feature-hub.spec.ts`, `feature-hub-assoc.spec.ts`,
`feature-hub-overlay.spec.ts`, `feature-hub-lifted.spec.ts`,
`nucleosomes.spec.ts` and `live-lift.spec.ts` with their configured demo inputs.
Exercise dataset interactions with distinct calibrations, Q2 held-out discovery,
a cross-scan M3 B choice, Cancel during resampling, a custom/state layer overlay,
partial graph carriers, and a target-frame live-lift scan followed by a source
record state join.

FiberHMM follow-up: `run_units` passes cancellation to evidence as a callable
but checks it as an event during dispatch. The browser bridges both interfaces;
upstream should normalize them. No FiberHMM source was edited.

## Final local verification

- Backend touched-area suites (`test_nuc*`, `test_hub*`, `test_scan*`,
  `test_lift_parity`), excluding slow server tests: **271 passed, 7 skipped**.
  This includes the fresh native-lift synthetic gate and cancellation during
  evidence snapshot loading. The existing haplotype test emits an overflow
  warning when constructing an unbounded odds-ratio interval.
- Full Vitest suite, four workers: **661 files passed; 4,885 tests passed,
  1 skipped**.
- `tsc --noEmit -p .`: passed.
- `git diff --check`: passed. Changes remain uncommitted.

No servers or e2e tests were run locally.
