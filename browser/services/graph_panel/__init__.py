"""The graph panel's backend (DESIGN_GRAPH_PANEL.md §§2–3, Gate B).

A persistent native helper, ``fiberbrowser-graph`` (graphlift), answers
bounded topology queries over a prepared, immutable graph package. This
package supervises it:

- ``frames``: the helper's framing (four-byte big-endian length + UTF-8 JSON)
  with header-first size checks;
- ``helper``: finding the helper (developer override, the app's bundled copy,
  the ``fiberbrowser-graph-native`` companion wheel) and its handshake;
- ``registration``: verified graph packages, addressed by registration ID only;
- ``worker``: one helper process: a reader that routes frames by job ID, a
  locked writer, a bounded stderr ring, startup/dispatch deadlines, kill/reap;
- ``pool``: at most two interactive processes, newest-only queueing per panel,
  shared jobs with subscriber-aware cancellation, memory policy, a byte-bounded
  result cache, clean shutdown.

Reads, joint layout and inspection are later gates; nothing here decodes a BAM.
"""
