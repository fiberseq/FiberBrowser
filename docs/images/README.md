# Documentation screenshots

[← Docs index](../index.md)

All paths below are relative to this directory. The images use the neutral
**Sample A** data staged by `scripts/unified_demo.py`. Do not substitute a
private dataset. The coordinator starts the demo server and runs capture.
These scripts do not start servers.

## Release capture set

Five files are new. Three existing images need refreshing to match the text.
Run from the repository root against the coordinator's running AluY demo:

```bash
node browser/frontend/scripts/capture-pangenome-screenshots.mjs \
  --base-url "$DEMO_URL" --work-dir "$PGLIFT_WORK" --only release-docs
```

Set `DEMO_URL` to the demo's existing address and `PGLIFT_WORK` to its data
folder. The server must serve the current frontend build and have FiberHMM's
scan, association and nucleosome modules. Use the launcher's default AluY
sample, with the graph helper and package enabled. Python with Pillow is
needed for compression (`--python` chooses it; `--no-compress` skips it).
No native file picker is used.

| Capture name | Output | State to review |
|---|---|---|
| `assoc-builder` | `feature-hub/assoc-builder.png` (refresh) | Associate tab after a real native scan; Q1 fills M3 and its inputs. |
| `overlay-profile` | `feature-hub/overlay-profile.png` (refresh) | Regular segments at selected NFR anchors; native and graph-path profiles with measured counts. |
| `hub-paging` | `feature-hub/hub-paging.png` (new) | Genome scope, page size 50, second page, selection retained from the first. |
| `graph-mode-site-sort` | `graph/graph-mode-site-sort.png` (new) | Right-click a real read; graph-column submenu expanded. |
| `panel-window` | `nucleosome/panel-window.png` (refresh) | NFR hand-off, Window mode, feature anchor and other selected NFRs as backgrounds. |
| `update-prompt` | `updates/update-prompt.png` (new) | Software update with Install and restart and manual download; explicitly simulated offer. |
| `whats-new-graph-hero` | `whats-new/graph-hero.png` (new) | Graph host beside the reference-aligned demo reads. |
| `whats-new-hub-hero` | `whats-new/hub-hero.png` (new) | Overlay tab beside the graph; the same real result as the workflow shot. |

The helper `capture-release-screenshots.mjs` is imported by the pangenome
script. Run it through that entry point so shared redaction, compression and
output routing apply. `--only` also accepts individual capture names.
Biological results are computed from the demo. Only the update API is mocked;
its install, download and quit actions are blocked. No update is installed.
The displayed update version is an example, not a release announcement.

The scan can take several minutes on a busy machine. A missing module, empty
NFR set, unavailable graph or failed compute fails its shots and gives a
nonzero exit status. Review every image for private paths, sample identifiers,
molecule names, clipped controls and misleading empty results before release.
The script redacts paths, sample identifiers, inspector names and graph-read
menu headings. It closes its pages and removes datasets it opened. It leaves
the demo's computed scans in its scratch cache for reuse.

## Images used by each page

The table includes existing images so a reviewer can check each complete page.
New files remain pending until the coordinator captures them.

| Page | Images |
|---|---|
| [whats-new.md](../whats-new.md) | [whats-new/graph-hero.png](whats-new/graph-hero.png)<br>[whats-new/hub-hero.png](whats-new/hub-hero.png) |
| [updates.md](../updates.md) | [updates/update-prompt.png](updates/update-prompt.png) |
| [pangenome-setup.md](../workflows/pangenome-setup.md) | [pangenome/setup-graph-packages.png](pangenome/setup-graph-packages.png)<br>[pangenome/setup-preview-features.png](pangenome/setup-preview-features.png) |
| [live-lift.md](../workflows/live-lift.md) | [pangenome/live-lift-split.png](pangenome/live-lift-split.png)<br>[pangenome/live-lift-open-menu.png](pangenome/live-lift-open-menu.png)<br>[pangenome/live-lift-dialog.png](pangenome/live-lift-dialog.png)<br>[pangenome/live-lift-insertions.png](pangenome/live-lift-insertions.png)<br>[pangenome/live-lift-hatching.png](pangenome/live-lift-hatching.png)<br>[pangenome/live-lift-settings.png](pangenome/live-lift-settings.png) |
| [linked-panels.md](../workflows/linked-panels.md) | [pangenome/linked-source-view.png](pangenome/linked-source-view.png)<br>[pangenome/linked-hover.png](pangenome/linked-hover.png) |
| [differences.md](../workflows/differences.md) | [pangenome/differences-row.png](pangenome/differences-row.png)<br>[pangenome/differences-expanded.png](pangenome/differences-expanded.png)<br>[pangenome/differences-menu.png](pangenome/differences-menu.png)<br>[pangenome/differences-table.png](pangenome/differences-table.png)<br>[pangenome/differences-inspector.png](pangenome/differences-inspector.png)<br>[pangenome/differences-comparison.png](pangenome/differences-comparison.png)<br>[pangenome/differences-comparison-inspector.png](pangenome/differences-comparison-inspector.png)<br>[pangenome/differences-native-inspector.png](pangenome/differences-native-inspector.png)<br>[pangenome/differences-lens.png](pangenome/differences-lens.png) |
| [structural-variants.md](../workflows/structural-variants.md) | [pangenome/sv-tab.png](pangenome/sv-tab.png)<br>[pangenome/sv-row-menu.png](pangenome/sv-row-menu.png)<br>[pangenome/sv-highlight.png](pangenome/sv-highlight.png)<br>[pangenome/sv-settings.png](pangenome/sv-settings.png) |
| [graph-mode.md](../workflows/graph-mode.md) | [graph/graph-mode-host.png](graph/graph-mode-host.png)<br>[graph/graph-mode-strips.png](graph/graph-mode-strips.png)<br>[graph/graph-mode-menu.png](graph/graph-mode-menu.png)<br>[graph/graph-mode-joined.png](graph/graph-mode-joined.png)<br>[graph/graph-mode-popout.png](graph/graph-mode-popout.png)<br>[graph/graph-mode-site-sort.png](graph/graph-mode-site-sort.png)<br>[graph/graph-mode-cluster.png](graph/graph-mode-cluster.png)<br>[graph/graph-mode-not-a-carrier.png](graph/graph-mode-not-a-carrier.png)<br>[graph/graph-mode-handoff.png](graph/graph-mode-handoff.png) |
| [feature-hub.md](../workflows/feature-hub.md) | [feature-hub/hub-panel.png](feature-hub/hub-panel.png)<br>[feature-hub/scan-dialog.png](feature-hub/scan-dialog.png)<br>[feature-hub/hub-paging.png](feature-hub/hub-paging.png)<br>[feature-hub/lifted-hits.png](feature-hub/lifted-hits.png)<br>[feature-hub/lifted-hits-graph.png](feature-hub/lifted-hits-graph.png)<br>[feature-hub/cluster-regions.png](feature-hub/cluster-regions.png)<br>[feature-hub/assoc-builder.png](feature-hub/assoc-builder.png)<br>[feature-hub/assoc-no-contrast.png](feature-hub/assoc-no-contrast.png)<br>[feature-hub/overlay-profile.png](feature-hub/overlay-profile.png)<br>[feature-hub/overlay-carriers.png](feature-hub/overlay-carriers.png) |
| [nucleosome-panel.md](../workflows/nucleosome-panel.md) | [nucleosome/panel-segments.png](nucleosome/panel-segments.png)<br>[nucleosome/panel-window.png](nucleosome/panel-window.png)<br>[nucleosome/patches.png](nucleosome/patches.png)<br>[nucleosome/reads-classes.png](nucleosome/reads-classes.png) |
| [session-migration.md](../workflows/session-migration.md) | No screenshot needed. |
| [navigation-speed.md](../workflows/navigation-speed.md) | No screenshot needed. |
| [footprint-classes.md](../workflows/footprint-classes.md) | No screenshot needed. |

The [user guide](../guide.md) keeps its existing `guide/*.png` tour images.
Its new paragraphs link to the pages above and need no extra tour images.
The [index](../index.md) and changelog also need no images.

## Other refreshes

The pangenome entry point already captures the existing `pangenome/*.png`
and `graph/graph-mode-*.png` views listed above. Run without `--only` to
capture the AluY set plus the release additions. The source assembly FASTA
must be loaded for assembly-comparison labels. The MHC image needs a separate
coordinator-run demo with `--locus mhc`, then:

```bash
node browser/frontend/scripts/capture-pangenome-screenshots.mjs \
  --base-url "$MHC_DEMO_URL" --work-dir "$PGLIFT_WORK" \
  --locus mhc --only graph-mode-not-a-carrier
```

Refresh `graph/graph-mode-host.png` for the chip that names all haplotypes,
and `graph/graph-mode-not-a-carrier.png` for its wrapped carrier label.
Refresh `pangenome/differences-inspector.png` and
`pangenome/differences-comparison-inspector.png` for current comparison text.

Other existing hub and nucleosome images are retained for review. They show
states outside the eight-shot release set. Check their labels and provenance
on the current build before publishing. The guide's existing capture entry
points are documented in [Updating the screenshots](../guide.md#updating-the-screenshots).
