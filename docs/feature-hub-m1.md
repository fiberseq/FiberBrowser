# Feature hub M1 migration

Changes are additive and the session format remains `2.0`. Legacy panels keep their own state and routes.

- **Jobs and mapping:** class/NFR jobs share the scan worker while retaining their job ids, legacy endpoints, frozen results, curation, filters, scoring populations and active class id. The hub exposes a mapping from job/family/dataset to set/hit. Frozen hit snapshots use scan-format indexed tables beside job artifacts; changed snapshots get separate content-addressed directories. Legacy engines remain responsible for their original results and per-read states.
- **Import:** conversion runs after `session_import_end`, including the lab's restored NFR runs. A conversion problem is returned in `results.hub_legacy.problems` without preventing legacy restoration. The frontend adopts the mappings and converts selections, peaks, tree nodes, saved clusterings, history and carts after their legacy state is restored.
- **Peaks:** stable identities cover rule, custom, matched and graph peaks, with reference, matched member and graph metadata. A transaction updates current selections/modes and tree/saved-clustering projections. History uses each snapshot's own geometry. Removed hits cannot select a replacement at the same numeric index.
- **Dual-write:** sessions and snapshots still contain legacy run blocks, peak indices/modes, class/NFR carts and resolvable feature identities. SV insertions use one-base legacy stubs. Hub-only feature selections and split rules are preserved under `featureHub`; old builds get frozen split membership. The actual split rule wins if subsequently edited.
- **Carts:** class and NFR carts produce pinned hub hits, with a Pinned badge. They merge with live/restored sets instead of duplicating rows. Existing carts remain the editable source and are still exported.
- **Adapters:** existing SV/Differences adapters remain; SNPs include saved panel scans; graph layouts publish revision-scoped bubble/junction hits. Graph peaks retain their metadata. Custom and matched peaks now appear in the hub.

The [synthetic session corpus](../tests/fixtures/sessions/README.md) documents provenance and coverage. Release comparisons use commit `24c7a5c58`; the later graph/Differences fixture uses `13f19f21f`.

## Gates and limits

The backend endpoint and frontend store checks cover old-session restore equivalence, new-session legacy restore through the release importer, round trips, and peak selections/modes across count changes. Browser/render equivalence in the actual released 3.0.1 application remains a coordinator gate; no servers or e2e were run here.

Matched-window class hits are projected to their recorded genomic windows, including reverse windows. They are listed as hit-only, with a note to use the legacy panel for per-read states; the existing legacy feature resolver does not carry a window channel. A run lacking genomic provenance reports a conversion problem and retains its legacy panel.

The facade remains a projection of frozen output and never reruns restored analyses. New native BAM lattice-recaller, NFR and molecule peak jobs now execute through `run_units`; see [engine consolidation](feature-hub-engine.md) for adapters, parity gates and remaining compatibility paths.

## Validation

- TypeScript: `tsc --noEmit -p .` from the frontend, using the local binary.
- Frontend: 23 targeted vitest files cover the migration corpus, import/export, history, tree nodes, saved clusterings, matched regions, split sources, graph frames, association inputs and ReopenLastSession. The M1 file contains 37 tests.
- Backend: six files cover M1, the session endpoint, real frozen class sessions, Accessibility jobs/sessions, scan registry behavior and job progress. Router cases were deselected; these tests do not bind ports.
- The launch test helper now resets its simulated page-load time, so the 15-second startup guard remains deterministic even after the earlier delayed-offer tests.
- `git diff --check` and a scan of added text found no prohibited private strings.

Final counts are recorded in the task handoff. No commits were made.

| Final check | Result |
| --- | --- |
| TypeScript | Clean |
| Vitest, 23 targeted files | 355 passed, including 37 M1 tests and all 29 ReopenLastSession tests |
| Pytest, six targeted files | 94 passed; 3 router cases deselected; one environment warning about physical-core discovery |
| Old-session endpoint/store equivalence | Pass on the synthetic corpus |
| New-build legacy restore through release importers | Pass for the applicable 3.0.1 panels and generated run blocks |
| Peak selection/modes across count changes | Pass, including graph, matched and custom cases, tree nodes and saved/history state |
| Actual released-application browser gates | Pending coordinator e2e |
