`sv_p0_evidence.json` contains anonymised, sequence-free local evidence snapshots
from an HG002 Fiber-seq sample's GRCh38 Alu and MHC primary records. Alignment bounds and
CIGAR/clip events within 3 kb of the target are retained; other tags and SA entries
are omitted. These insertion fixtures test summary/split/frontend parity without
requiring external BAMs. Expected Alu support is 79 (38 clips); MHC support is 6,
with 78 informative molecules. The same JSON is exercised by Python and Vitest.
