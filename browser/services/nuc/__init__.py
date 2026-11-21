"""The nucleosome panel's backend: FiberHMM's ``nuc`` module run in the browser (NUC design §5.2).

Molecule-wide outputs (``nucsz`` size calls, ``nucseg`` segments and events, ``nucmol`` scalars) come from one
per-record engine: FiberHMM's ``decode_record`` + ``molecule_outputs`` + ``group_rows`` on the **complete source
record** read from the BAM (never a window-clipped compact row), with the dataset's calibration record. It is
the code path ``fiberhmm-scan``'s ``nuc`` module runs for every owned record, so a live result equals the scan's
row for that record (``tests/test_nuc_equivalence.py``). Locus-level outputs (tracks, recurrence and phased
patches) stay with the scan: an opened scan directory or the feature hub's live scan (``services/scan``).

- ``engine``: FiberHMM's nuc module, its settings and settings hash.
- ``inputs``: a browser dataset as nuc inputs (its BAM files, content ids, chemistry, read policy).
- ``calibration``: the dataset's calibration record: a bound open scan's, else a cached one, else computed once
  on the declared population (``calibration_scope = 'data'``; the viewport never picks calibration molecules).
- ``store``: per-record outputs keyed by (BAM file, record SHA-256, occurrence), with a revision per file.
- ``live``: computing outputs for a region's records (native BAMs, live-lift source windows, graph paths).
- ``loaded``: the same rows read from an opened scan (tables mode) for comparison.
- ``layers``: outputs as read layers, attached where the compact-read loader builds each record's row, so
  native rows, live-lift rows and graph rows carry them through the existing projection.
- ``jobs``: calibration and live compute as jobs with progress and cancel.
- ``observations``: the panel's observation descriptors resolved to records, and per-observation summaries.
"""
