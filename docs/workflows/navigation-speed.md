# Navigation and speed

[← Docs index](../index.md) · [← User guide](../guide.md#4-pan-and-zoom)

Pan and zoom as usual. Native BAM views reuse cached reads when the view and
options allow it. An overlapping pan or outward zoom can fetch just the newly
exposed edges. Long molecules crossing an edge still need decoding. Filters,
circular views and changes of data can require a full load.

Live lift loads the view and a margin from the source assembly. Graph pans
reuse decoded records and decode the new ones. A first visit can take longer
than returning to the same region. Remote files also depend on the connection
and the server's file cache. These changes reduce repeated work; they do not
set a fixed navigation time.

## Choosing a memory budget

In **Settings › Reads & Display › Read Display**, choose **Performance mode**:

| Choice | What to expect |
|---|---|
| **Auto (default)** | Chooses a profile from browser capability, server memory and CPU cores. |
| **Low memory** | Smaller caches, sampled reads and analyses, and no background read loading. Analysis working sets use at most 2,000 reads. |
| **Standard** | Sampled display, full analysis working sets and background read loading. |
| **High performance** | Larger caches and background spans, more workers and full analysis working sets. |

**Advanced: memory and workers** shows the active budgets and counts. The
profile is kept on this computer. A separate **Analysis cap** can still limit
analyses. Check result sampling notices before comparing runs.

In graph mode the read bands share a budget. When not every molecule is drawn,
the band gives the count and shows a density strip. A low row count is not
evidence of low coverage. Fix the rows per band in **Reads**, or adjust the
performance mode. Graphs switch to linear above 50 kb and return at 40 kb by
default; see [Zooming out](graph-mode.md#zooming-out).

## Going back to a locus

**Back** and **Forward** follow locus jumps, including typed loci, saved
regions, Differences arrows and **Zoom to read**. They work with linked views
and with each panel's own navigation. A jump restores the panels it moved.
Use **Undo** for analysis and layout changes.

An automatic peak scan that stops after 60 seconds says
**Scan stopped after 60 s — press Scan to retry** beside **Scan**. Retry there
or narrow the view. A failed insert-expanded reconstruction has **Retry** on
its error banner.

## Scans have a different cost

Panning is cheaper than discovering features. A genome-wide footprint-class
scan at 30× takes about 154 hours on four workers. Use region scans for `fp`,
or the `nuc`, `nfr` and `peaks` modules for genome-wide work. The hub reuses
completed units when their inputs and settings match. See
[Scans](feature-hub.md#scans).
