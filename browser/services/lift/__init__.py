"""Live lift: a BAM aligned to a source assembly drawn on the main genome
through a graphlift sidecar, without realigning or rewriting a record
(DESIGN_LIVE_LIFT.md, v3).

P1 is an internal library; nothing here is wired to a router yet.

- ``graphlift_map``: vendored graphlift sidecar reader (format v2);
- ``live_lift``: settings and ``lift_key``, map registry, piece selection with
  the 1 Mb bin cache, fetch plan and budgets, the lifted source load, and the
  primary-metadata lookup;
- ``compose``: ``lift_compact_reads``, the pure source -> target mapping of
  decoded compact reads;
- ``navigation``: map summary, per-chromosome outline and exact tiles.
"""
