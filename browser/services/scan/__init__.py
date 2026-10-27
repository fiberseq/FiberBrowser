"""fiberhmm-scan directories in FiberBrowser: open them, serve their rows, run live scans with the same engine.

A scan directory (``fiberhmm-scan``, FiberHMM's ``fiberhmm.scan``) holds ``manifest.json`` and bgzip + tabix
tables of pooled hits per module; per-molecule results are MA groups of annotated BAMs (grid scans) or the
``states`` / ``marks`` / ``molecules`` tables (BED-scoped scans and the browser's cache). Reading needs only pysam
(``tables``); running a live scan needs FiberHMM's ``fiberhmm.scan`` (``jobs``).

- ``tables``: tabix readers for scan tables.
- ``identity``: ``content_id`` (binds a scan's files to loaded datasets) and the record key of a source record.
- ``registry``: the scans open in a session, their dataset bindings and feature sets.
- ``serve``: hits with per-group values, native rows, units, per (hit, record) states.
- ``planning``: the browser's read policy, units for a view / BED / genes / regions, coverage by open scans,
  the equivalent command line.
- ``jobs``: ``ScanJobManager``, live scans into the scan cache through ``fiberhmm.scan.run_units``.
- ``overlay``: scan state groups as read-track layers of the working set.
"""
