# Genome windows and reference annotations

Use **Unlink** in a panel's location bar to detach that panel from the
main navigation. Unlinked panels have a local gene/coordinate search field;
coordinates are `chromosome:start-end` (zero-based, end-exclusive). The panel's
pan and zoom controls operate locally. Click **Link** to follow the main
view again. Detaching a haplotype window also removes its haplotype navigation
coupling.

**Genome → Reference Files → Multiple FASTA / annotation pairs** accepts several
FASTA files and optional matching GTF, GFF, or BED annotations. Load the list as
one reference set. Chromosome names must be distinct across references and must
match the BAMs; collisions are rejected. The set is included in backend session
save/restore. Existing single-reference controls remain available.

Gene annotation BED files support BED3/6 intervals and BED12 exon blocks, including
gzip input. BED names are searchable gene labels. BED coordinates retain their
zero-based, half-open interpretation. Invalid exon blocks produce a line-specific
error. BED intervals without a strand remain unstranded.

The main **Cluster** button pools reads from selected windows into one joint
feature matrix and fits shared clusters once. Cluster numbers and patterns mean
the same thing across windows; per-window assignment maps preserve read identity,
including when both haplotypes come from one BAM. Each window is queried at its
own chromosome and coordinates. Selected peak positions are compared as offsets
from each window's start. Different window widths are allowed; the user chooses
which promoter windows and relative peak positions are appropriate to compare.
Results for independent windows stay frozen until the next explicit joint Cluster
run, avoiding reassignment against the global chromosome.
