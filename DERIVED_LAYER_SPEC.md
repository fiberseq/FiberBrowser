# Footprint Rules and Derived Layer Bundle Spec

FiberBrowser supports two related persistence formats. In normal use, save
portable rule JSON first; only materialize per-read intervals when you need an
exact frozen overlay for one dataset/window.

- Portable footprint rule JSON: reusable cart definitions that can be applied
  to different datasets.
- Materialized derived layer bundles: frozen per-read interval calls exported
  from those rules for a specific dataset/window.

Both are built from native FiberHMM layers such as `tf`, `nuc`, `fire`, `deam`,
`m6a`, or future caller layers. `msp` is retained as an internal/backward
compatibility alias for FIRE-like intervals.

The design goal is to let users define classes in analysis panels, save the
definition for reproducibility, optionally save exact per-read overlays, reload
them later, and pass them through the same layer-based analysis paths as native
BAM/BigBed layers.

## Rule JSON

Portable rule files are the primary user-facing save/load path:

```text
cart_name.fiberlayer-rules.json
```

They contain Footprint Analysis cart entries: layer, size range, optional
absolute reference target, overlap thresholds, colors, and user labels. They do
not contain read IDs or materialized calls, so the same file can be loaded onto
new timepoints or replicate datasets and recomputed live.

```json
{
  "schema": "fiberbrowser.footprint_rules.v1",
  "name": "paper rules",
  "created_at": "2026-04-30T00:00:00Z",
  "context": {
    "chrom": "chr2R",
    "start": 9974319,
    "end": 9984319,
    "dataset_ids": ["stage_d_recalled"],
    "sample_seed": "paper-v1"
  },
  "groups": [
    {
      "id": "short_tf",
      "name": "Short TF near peak",
      "color": "#d95f02",
      "layer": "tf",
      "sizeMin": 6,
      "sizeMax": 35,
      "referenceAbsStart": 9978000,
      "referenceAbsEnd": 9978060,
      "minFpCoverage": 0.5,
      "minTargetCoverage": 0,
      "enabled": true,
      "sourceIndex": -1
    }
  ]
}
```

Loading a legacy `.fiberlayers.json` manifest into the cart converts its
classes back into rule entries when possible. Loading `.fiberlayers.bed` or
`.fiberlayers.bb` attaches frozen calls as derived layers instead.

## Bundle Layout

A materialized bundle is an exact per-read snapshot sidecar pair:

```text
sample.fiberlayers.bb
sample.fiberlayers.json
```

For small sets or machines without `bedToBigBed`, a BED payload may sit next to
the manifest and is sufficient for FiberBrowser reload. This is the preferred
fallback for interactive cart exports because these sets are usually small and
plain BED is easier to inspect/debug:

```text
sample.fiberlayers.bed
```

The source BAM/BigBed is never modified in place. `MA/AQ` remains the caller
contract for native `nuc+Q`, `msp+`, and `tf+QQQ` layers; derived layers are
browser/user products and therefore live in sidecars.

## Manifest

The JSON manifest is required for authored bundles and should be treated as the
catalog record for the BigBed/BED payload. Users may load/share the JSON as the
logical bundle entry; paths inside `files` are relative to the manifest unless
absolute. If the manifest points to a missing BigBed but includes a valid BED,
FiberBrowser should attach the BED payload without requiring `bedToBigBed`.

```json
{
  "schema": "fiberlayers.v1",
  "files": {
    "bigbed": "sample.fiberlayers.bb",
    "bed": "sample.fiberlayers.bed",
    "autosql": "sample.fiberlayers.as"
  },
  "source_dataset": {
    "path": "/path/sample_recalled.bam",
    "fingerprint": "sha256-or-stat-fingerprint",
    "genome": "dm6",
    "chrom_style": "chr"
  },
  "classes": {
    "tf_short_peak_local": {
      "label": "Short TF footprints near selected peak",
      "source_layer": "tf",
      "kind": "footprint_class",
      "color": "#d95f02",
      "rules": {
        "sizeMin": 6,
        "sizeMax": 35,
        "referenceAbsStart": 9978000,
        "referenceAbsEnd": 9978060,
        "minFpCoverage": 0.5,
        "minTargetCoverage": 0,
        "quality": { "tq_min": 50 }
      },
      "version": 1
    }
  },
  "scope": {
    "regions": ["chr2R:9974319-9984319"],
    "genomewide": false
  },
  "provenance": {
    "browser_commit": null,
    "sampling_seed": "fiberbrowser-analysis",
    "quality_filters": [],
    "created_at": "2026-04-30T00:00:00Z"
  },
  "statistics": {
    "classes": {
      "tf_short_peak_local": {
        "reads": 154,
        "intervals": 211
      }
    }
  }
}
```

Class IDs must be stable ASCII identifiers. UI labels can change without
changing the class ID.

## BigBed Shape

The preferred on-disk interval representation is BED12+4:

```text
chrom start end read_id score strand thickStart thickEnd color blockCount blockSizes chromStarts class_id source_layer rule_id blockQuality
```

One row represents one read/class pair. Blocks are all intervals of that class
on that read. This is compact for many intervals per read and keeps overlapping
classes explicit.

Field meanings:

- `read_id`: source read name, matching BAM/BigBed read IDs.
- `score`: mean class confidence, 0-1000 for generic BigBed tools.
- `class_id`: stable derived layer ID from the manifest.
- `source_layer`: native layer used to create the class, such as `tf` or `fire`.
- `rule_id`: stable cart/rule ID that produced the row.
- `blockQuality`: comma-separated byte-scale confidence values aligned to
  `blockSizes` and `chromStarts`. Use `.` if no per-block confidence exists.

Coordinates are absolute genomic coordinates in the BigBed. FiberBrowser
converts them into read-relative layer intervals at query time.

## Runtime Semantics

When a derived bundle is attached to a dataset:

- Each manifest class is added to `dataset.available_layers[class_id]`.
- Metadata is stored in `dataset.derived_layers[class_id]`.
- The UI lists these under a separate "Derived layers" subheading.
- The working-set loader treats each class as a normal named layer in
  `read["layers"][class_id]`.
- Clustering, co-accessibility, conditional filtering, read stats, exports, and
  Jupyter APIs should consume the class through the existing layer interface.

The Footprint Analysis cart is the natural draft/editing model for class
definitions. Saving rules preserves the portable definition. Materializing a
cart entry writes exact per-read intervals into the bundle; reloading the bundle
should not depend on re-running percentile scans or sampling decisions.

Portable rule JSON and materialized bundles intentionally serve different
reproducibility needs:

- Use `.fiberlayer-rules.json` to reapply the same biological definition to
  another timepoint, replicate, or reloaded BAM/BigBed.
- Use `.fiberlayers.bed` or `.fiberlayers.bb` plus the manifest to preserve the
  exact read-level calls from one analysis session.
- In both cases, `msp` inputs are normalized to user-facing `fire` in saved
  metadata, while the loader still accepts legacy aliases.

## Compatibility

Existing annotation BigBeds (`*.annotations.bb`, BED6+2) remain supported as
annotation overlays. `fiberlayers.v1` is stricter and layer-oriented: it should
be used when the saved calls need to behave like analysis layers rather than
external annotations.
