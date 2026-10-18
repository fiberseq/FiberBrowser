# Live-lift differences and insertion inspection (P2a3)

Everything is gated by the server's live-lift flag and a displayed
`bam_livelift` dataset. Native sibling panels participate in the shared axis,
insertion columns and selected-site guide. Equivalent parental insertions at the same boundary (within 10% length, or 3 bp) share one column. Each parent draws its own payload at the same bp scale; the longer allele sets the width and a shorter allele has a marked tail. Labels flag differing lengths and boundary alignment. Competing matches remain separate; this does not imply internal sequence alignment.

- `DifferencesStrip.tsx`: debounced, abortable map requests scoped by dataset,
  lift key, haplotype and view; individual glyphs or density bins, per-haplotype
  lanes, native-evidence tooltips, previous/next search and a per-panel size
  filter. Navigation fetches map detail ahead without reading native BAMs.
- `DifferencePopover.tsx`: source/target bases, read alleles and chromatin,
  per-haplotype summaries and GRCh38-allele warnings. Selection and hover reuse
  read outlines without changing sampling pins or fetching compact reads.
- `axis.ts`, `persistence.ts`, `useLiveLiftAxis.ts`: one piecewise molecular axis
  per linked view; multiple blocks, inverse mapping and reversed panels.
  Expansion state is saved through the store extension's session/history hooks;
  the size filter lives on `PanelConfig`. Leaving a chromosome clears its blocks.
- `ReadTrackCanvas.ts` and `liveLiftInsertionCanvas.ts`: target layers are
  clipped out of inserted columns; insertion-local layers and marks draw only
  over each carrier's `covered` extent. Minus payloads are used as supplied.
  Assembly X marks are muted; read-specific marks use normal mismatch colours;
  GRCh38-allele marks are amber. The ruler, coverage and highlight washes share
  the same axis. Expansion/collapse does not reload compact reads.
- `sourceView.ts`: opens the original BAM on its source contig, retaining an
  existing source reference or using the BAM-header contig reference without a
  FASTA. A ViewLink anchors the insertion and its immediate flanks; it does not
  claim a chromosome-wide graphlift conversion. If source registration fails,
  matched native insertion evidence can open the existing alt-allele expansion.

## Limits exposed in the UI

- **Split by carrier** is disabled: `/api/sv/split` rejects lifted datasets
  (`services/lift/capability.py` does not support `sv_summary`). Existing native
  SV splitting and the SV view are unchanged.
- In-place chromatin payloads exist for **50 bp through 50 kb**. Smaller indels
  remain inspectable; larger blocks are refused with a notice.
- **Identify** reuses `IdentifyTab` and its job store with one full carrier's
  insertion sequence fetched on demand from `difference_reads?include_sequence=true`. Read indels do not require exact agreement with assembly length. It is labelled as read sequence,
  not an assembly consensus, and is disabled with a reason when no complete
  sequence is available. Job identity includes lift key and insertion ID, so
  equal-length MAT/PAT insertions cannot share the wrong result.
- Only reads, ruler, coverage and highlight bands accept the piecewise axis.
  SV, sequence, gene, metaprofile, FIRE, capture, primer, consensus, Micro-C,
  co-accessibility, orthogonal, annotation, composite and plugin tracks are
  dimmed with **“Insertion expanded: track not aligned”** until collapse.
  Pixel smoothing is suspended while blocks are open to avoid bleeding target
  signal into native insertion gaps.

## Stable browser hooks

`live-lift-diff-strip`, `live-lift-diff-prev`, `live-lift-diff-next`,
`live-lift-diff-popover`, `live-lift-expanded-block`,
`live-lift-expanded-collapse`, `live-lift-diff-item`,
`live-lift-misphased`, `live-lift-difference-guide`,
`live-lift-unaligned-track`.

The read canvas exposes `data-live-lift-insertion-calls` (visible drawn calls)
and `data-live-lift-badge-target` (actual visible Alu-size badge coordinates).
The Playwright spec uses these with store state to click a MAT badge and verify
MAT/PAT/native expansion, drawn insertion footprints, collapse, SNV inspection
and previous/next navigation, plus successful AluY Identify. Test data paths are supplied through environment variables.

Compact display loads keep badges and insertion SV evidence but omit hidden
annotation blocks until expansion. The frontend sends `viewport_start` and
`viewport_end`, plus comma-separated `insertion_ids` for expanded alleles.
`/api/reads/compact` enriches response copies on demand; shared broad/direct
caches retain collapsed rows, and collapsing cannot retain a stale block.
Each shared allele retains its source interval and strand through session
persistence. Header actions use the enclosing haplotype's allele, falling back
to a surviving panel for that dataset when the initiating panel is closed.
