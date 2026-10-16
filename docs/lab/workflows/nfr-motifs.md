# Workflow: motifs at NFR variants

[← Docs index](../../index.md) · [← README](../../../README.md)

The **NFRs** panel finds the opening registers (variants) of each nucleosome-free region (NFR) from the
reads. An NFR card's **Motifs** view asks which transcription factors could bind there and what the molecules say
about it.

## The NFR list

The panel has one list of NFR cards (tabs **NFRs** and **NFR pairs**). **Open** expands a card in place: its
read controls (**Group in this panel**, **Split into panels**, **Split by combination pattern**, **Select as
features**), the pairs involving it and its analyses (Motifs, Footprints, V-plots, Phasing, Prevalence, Advanced,
Export). The star keeps a card (name, note, colour, ticked variants) with the session; **All / Starred** filters the
list, and starred NFRs of other runs are listed under **Earlier**. Clicking an NFR or a variant in the NFR channel
above the reads (or on the arcs) opens its card at that variant. **Copy sequence** and **Download FASTA** give the
NFR window's reference sequence.

The ChIP-Atlas experiment choice (per genome), the pinned motifs and your own motifs are kept on this computer in
`~/.fiberhmm/analysis_preferences.json`, so another port or app build finds them; sessions still carry their own.
A motif you add is found by its common name or an alias, whatever the case or punctuation, and says *0 sites here*
when it has no site in the window.

## The evidence is a hierarchy

A factor can only bind DNA that is open, so the evidence at a motif site is nested, never two alternatives:

1. **Open (the stable layer, NFR shape).** On each member read of a variant: is the site inside a nucleosome-free
   gap of at least the run's minimum gap? Stable openings are often the best evidence of binding: a factor such as
   Dorsal may leave no footprint, but the variant that opens over its site shows when the NFR is bound.
2. **Footprinted given open (the transient layer, footprints).** Among the reads open at the site, the share that
   are members of a **Find classes** footprint class covering the site core. Run Find classes on the window (the
   Sites tab offers it); its classes join the NFR run without re-running Find variants.
3. **Overall footprinted share** = P(open) × P(footprinted | open).

Each site shows, per variant, a stacked bar: closed / open, not footprinted / open and footprinted. A lattice class
labels a read a member when the class span is protected on it, which a nucleosome also satisfies: members whose site
lies in a nucleosome call (or a short linker) are protection, not footprints, and are left out (counted by reason).
Reads the class run abstained on are not labelled; the unlabelled share is shown.

The tests follow the hierarchy: openness between variants, and footprinting among open reads between variants
(Fisher or chi-square, BH q across the sites of the NFR). The openness test restates geometry for a site inside one
variant's span only; it is informative for sites shared by several spans or in the flanks.

## Motif sites

Sites pass a per-matrix **p-value** (default p ≤ 1e-4; log slider from 1e-2 to 1e-8, or type it), from each
matrix's exact score distribution under the background (local composition, the genome FASTA's, or uniform), so short
and long motifs are held to the same false-positive rate. **Relative %** (the older share of each matrix's best
score) stays available. The scoring, pinned key factors (Zelda / vfl, GAF / Trl, CLAMP, ...) and your own motifs
(IUPAC, a PFM, or JASPAR / MEME / HOMER text) are shared with the Footprints panel, per species, and kept in the
session.

## Views

- **Sites**: the hierarchy per site and variant, with the footprint class named (it opens in the Footprints panel)
  and, on request, conservation (UCSC phyloP: the site against its flanks).
- **Profile**: P(open) and P(footprinted | open) per variant around a motif family's sites, pooled over the NFR or
  the run: a variant-specific opening over the motif is NFR-shape evidence, a peak of footprinting at the motif is
  footprint evidence.
- **Enrichment** and **Between variants**: site counts per variant span against the local background, and in a
  variant's own part against its siblings' (binomial tests, BH q).
- **ChIP-Atlas**: peaks of the pinned factors over the NFR and each variant (downloaded on request, cached).
- **Footprint classes** (an open NFR card): every class inside the NFR with the hierarchy per variant, single-molecule
  co-occupancy of class pairs (footprinted together more or less often than independently), and links to the
  Footprints panel.

## Pooled over many NFRs

One NFR has a handful of sites per motif. The **Motifs pooled** tab pools every NFR of the runs you pick (run Find
variants in many regions from the Regions catalogue with **Find variants in regions**) and compares variant types
(full, core, extended, shifted, alternative, merged): sites in a variant's own part against its siblings', openness
and footprinting among open reads at the family's sites, each as a Mantel–Haenszel ratio over NFRs and sites, BH q
across the family × type heatmap. **De novo k-mers** finds sequences enriched in variant-specific openings for
factors JASPAR lacks, each named with its best JASPAR match.
