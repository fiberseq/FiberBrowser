# Differences workspace

The Differences row uses the existing resizable canvas track (`sv` remains a
session alias). Native BAMs retain their independent geometry summary, clip
piles, keyboard navigation, combination selection and carrier actions without
an assembly. Assembly lanes work without read discovery; the saved reads source
option explicitly requests composed discovery. The navigation table and read
markers share the inspector. Single click selects; double click or Inspect
opens inspection. On the native canvas, `i` inspects the keyboard-focused event.

The inspector has a single application host, including when a source panel is
closed. Assembly sequence/geometry inspection does not decode reads until an
observed-bases or molecule-call action is requested. Source alignment
observations and final molecule calls are separate tables. Unknown sequence,
geometry support, other alleles, dissent, unresolved source placement and partial
discovery remain explicit. Exact targets can be supplied as frozen snapshots;
loading a read string or preview never promotes geometry into exact identity.

## Columns and observed annotations

Shared axis, selection and persistence implementations live in
`features/differences`; old live-lift imports and session keys are compatibility
adapters. Columns belong to a saved reference/view scope and remain active with
lift disabled, a missing map or a closed source panel. Other references retain
their own axes. Replacement columns anchor at `ref_end`, retain the entire
replaced reference span and use the full alternate length at one bp scale.
Interiors are boundary aligned, with observed offsets and marked shorter tails.
Native geometry lengths are explicitly estimated and grow to accommodate the
bounded cohort's observed full lengths.

Native annotations are loaded lazily by record and query interval into
`alternate_blocks`, independently of `live_lift` and reference coverage. Blocks
retain the original record digest, query slice, observed length/preview, partial
coverage, annotation qualities and logical call/part identities. Native layout
association with an assembly column is an explicit saved action; geometric
association supplies no allele equivalence or read vote. Actual native endpoints
retain displacement connectors to the selected column.

Reads, ruler, Differences glyphs, coverage and highlights share the axis.
Reference-only canvas tracks replay their drawing through clipped reference
pieces, including vector export. Raster reference tracks use the same transform.
Inverse pointer mapping excludes alternate interiors from reference hit tests.
Alternate-local footprint inspection retains local offsets rather than creating
a genomic footprint at an invented coordinate.

## Scoped calls and frozen cohorts

`POST /api/differences/inspect` accepts an explicit target with `target_id`,
`revision`, `target_type`, `chrom`, `ref_start`, `ref_end` and `alt_bp`, a bounded
region and evidence options. Native insertion/deletion geometry uses the existing
independent SV adapter. Native replacements use both-span evidence. Lifted and
combined requests use the guarded projection producer; combined requests still
require declared shared provenance. The `differences:v1` response includes one
call per molecule and dataset-qualified row memberships. New highlights use
those memberships and cannot fan a raw name across unrelated datasets.

Splits save the target, evidence/conflict policy, analysis scope, producer
policy, completeness, molecule calls and row memberships. The active grouping
and an intent snapshot round-trip through session/history state. Display
changes and panning never refresh a frozen split. Explicit recompute previews
counts and target revisions before applying the current inspector policy.
Historical confirmed-only and unresolved-import behavior remains intact.

`POST /api/differences/alternate-blocks` loads expandable native blocks;
`/observations` also handles deletions and other replacements, including empty
observed alternates and reference observations. These requests accept bounded
row subsets, layers and annotation options. Blocks have a separate byte-bounded
cache keyed by data, target, signal/layer options and cohort revisions. Preview
fields are at most 60 bases with full observed lengths. `/sequence` is an
explicit, record-qualified page (at most 50 kb); empty and missing sequence are
different results. Assembly sequence pages retain their existing independent
reference/alternate endpoints.

Observations explicitly label reference versus alternate sequence; these roles
do not supply exact allele votes. Native Identify requires an available full
alternate observation. Unclipped footprint bounds and edge-quality channels
follow their intervals through partial-block offsets and map reflection.

`POST /api/differences/lens` opens the detailed lens from a frozen call snapshot.
It does not reclassify under current display settings. Full and partial observed
inputs retain their own axes; one molecule supplies at most one consensus input.
Source revisions are checked before decoding. Consensus uses the shared
allocation/work/deadline/cancellation gates and preserves basic chromatin
inspection after refusal. Missing observed inputs remain explicit in workspace
completeness. The workspace starts with alternate interiors and no reference
flanks. The original native lens remains available independently.

Footprint pattern clustering runs locally on this frozen observed cohort. Saved
options select nucleosome/MSP layers and two or four evenly spaced alternate
probes. Patterns distinguish a footprint, observed absence and unavailable
layer/coverage. Grouping reorders rows and adds exported group profiles; it does
not reclassify molecules or refetch reads. Patterns retain the same orientation
through view reversal. The legacy alternate-allele panel is not used for a frozen
workspace because that route would rediscover its carriers.

The versioned lifted lens has its own `difference_lens` capability. Legacy lifted
SV, Variants, insertion-lens and alternate-allele routes retain their refusals.
Unmapped read edits without a validated alternate-block mapping remain
inspectable as geometry/calls but cannot open an empty synthetic expansion.
For reversed-map DAF inputs, the current numerical path reports a majority
fallback; it does not silently relabel chemistry or claim a calibrated exact
allele consensus.

Workspace requests retain the 50 kb full-inspection limit, 500 observation rows,
2 Mb request window, 16 MiB response ceiling and existing numerical budgets.
Full session/API migration, scope-safe scan consolidation, biological calibration
and broader reconstruction performance work remain separate gates.
