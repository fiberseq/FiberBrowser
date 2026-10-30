# Workflow: footprint classes

[← Docs index](../index.md) · [← README](../../README.md)

The **Footprints** panel can define footprint classes across molecules. Its
consensus / lattice-recaller workflow (**Find footprint classes** on the
**Classes** tab) looks for footprints that recur at the same place across many
reads, groups them into classes, and gives each class a colour on the reads.
Original footprint calls keep their coordinates; classes are an added
annotation. Classes can be compared across strands (DAF-seq) and across
datasets, saved to the **Saved** tab, and used to filter, label, sort or cluster
reads. It uses the current view: a few kb (the demo's 4 kb) takes a minute or
two.

The inputs, parameters and outputs are described in
[LATTICE_CONSENSUS.md](../LATTICE_CONSENSUS.md).

The whole workflow (find the classes, read the class table, save a class,
plot its prevalence, compare strands, co-occupancy) is illustrated step by step
in the [user guide](../guide.md#24-footprint-classes), as is saving a single
footprint size range at one spot ([step 22](../guide.md#22-saving-a-footprint)).

The [Feature hub](feature-hub.md) lists these classes alongside scan hits.
New local native BAM lattice-recaller runs use the shared scan engine. Staged
and oriented class workflows still use the legacy engine. Restored runs keep
their saved results and curation; opening a session does not rerun them.

For scans over many regions, use the hub's **Scan…** or open a `fiberhmm-scan`
directory. Genome-wide `fp` scans are slow: about 154 hours on four workers at
30×. Prefer region scans for footprint classes. Use `nuc`, `nfr` or `peaks`
for genome-wide scans.
