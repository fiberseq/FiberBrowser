# Identify: candidates for an insertion

The insertion lens's **Identify** tab searches an insertion's consensus sequence on your own computer: against the
loaded reference genome (BLAST+, or minimap2 when BLAST+ is missing) and a TE library (the bundled *D. melanogaster*
canonical transposon set v10.2, or Dfam's curated families for other species, downloaded once). Optionally it names
genome hits from UCSC's RepeatMasker track (sends only hit coordinates), and *Search Dfam online…* sends the sequence
to dfam.org after asking.

What it returns is a **candidate**, not an identification: the best-scoring match among local alignments, with the
numbers needed to judge it. Check the alignments (the tables, *Copy report*) before naming an insertion in a paper.

## The verdict

Every result carries one of three outcomes (the coloured label under the summary line; the report's `Verdict:` line;
`result.verdict` in the API):

| Outcome | When |
|---|---|
| **Best candidate** | The best TE family has at least **80% identity** over at least **50% of the insert**. Without such a family: an exonic gene match, a RepeatMasker family of genome copies, or a genome locus that passes the same two minimums. |
| **Ambiguous** | Another TE family (a different family, not the LTR or a fragment of the same one) passes the minimums too and scores within **5% of the best bitscore** over largely the **same bases** (at least half of the shorter alignment's insert bases shared). Both (or all) are listed. Two families on *different* parts of the insert (a nested or composite insertion) are not ambiguous. |
| **No confident match** | Nothing reaches the minimums; the line says what came closest. |

The thresholds are defined once on each side and kept in step:

- server: `browser/services/insertion_identify.py` (`VERDICT_MIN_IDENTITY`, `VERDICT_MIN_QUERY_COVERAGE`,
  `AMBIGUOUS_BITSCORE_FRACTION`, `AMBIGUOUS_MIN_OVERLAP`);
- browser: `browser/frontend/src/features/insertion/identifyModel.ts` (the same names), which also computes the verdict
  for results saved before verdicts existed.

Why these values: 80% identity is the level below which the TE search already reports a family only as *related*
(`FAMILY_MIN_IDENTITY`); half the insert is the share at which a genome locus counts as a copy of the insert
(`COPY_QCOV`, also used for *Open the reference copies*); 5% of the bitscore flags only near-ties: in the numb insertions the
next family scores far lower (roo 18,196 vs rooA 258; jockey 8,900 vs jockey2 735).

## What is shown with the candidate

- **Coverage and identity**: for each candidate TE family its identity, the share of the insert it covers and the share
  of the element present (the *Candidate TE families* table adds the element coordinates, shape and strand); for a gene
  or genome candidate its identity and insert coverage.
- **Databases and versions**: the TE library's name and version (with its licence and citation), the genome assembly,
  RepeatMasker (UCSC rmsk) when it named the hits, and the search program with its version and path (e.g.
  `BLAST+ 2.17.0+`).

Results are saved with the session (per insertion cluster) and marked stale when the consensus, the reference or the
annotation changes.
