"""Example FiberBrowser plugin — footprint size histogram.

Copy this directory, rename, and modify to create your own plugin.
Launch with: python browser.py -b data.bam --plugin ./my-plugin/
"""

from fastapi import APIRouter, Query


def create_router(ctx):
    """Create the plugin's API router. Called once at startup.

    Args:
        ctx: AnalysisContext — provides access to datasets, reads, sequences, etc.
             Key methods:
               ctx.get_dataset_ids() -> list of dataset IDs
               ctx.get_reads(dataset_id, chrom, start, end) -> list of reads
               ctx.get_footprint_sizes(dataset_id, chrom, start, end) -> list of sizes
               ctx.get_genes(chrom, start, end) -> list of gene annotations
               ctx.fetch_sequence(chrom, start, end) -> str or None
               ctx.has_fasta() -> bool

    Returns:
        FastAPI APIRouter with endpoints.
        The router is mounted at /api/plugins/<name>/
        The frontend calls GET /api/plugins/<name>/data?chrom=...&start=...&end=...
    """
    router = APIRouter()

    @router.get("/data")
    async def get_data(
        chrom: str = Query(...),
        start: int = Query(...),
        end: int = Query(...),
    ):
        """Return chart data for the current viewport.

        The response must include a 'chart_type' field. Supported types:
          - histogram: { groups: [{ label, bars: [{ label, value, color }] }], y_label }
          - donut: { segments: [{ label, value, color }] }
          - heatmap: { matrix: number[][], row_labels, col_labels }
          - profile: { series: [{ data: number[], color, label }] }
          - scatter: { points: [{ x, y, color? }], x_label, y_label }
          - vplot: { matrix, size_min, size_max, size_bin, pos_bin }
          - table: { columns: string[], rows: [{ col1: val, col2: val, ... }] }
          - image: { src: "data:image/png;base64,..." }
          - multi: { charts: [ ...array of chart responses ] }
        """
        dataset_ids = ctx.get_dataset_ids()
        if not dataset_ids:
            return {"chart_type": "histogram", "groups": [], "y_label": "Count"}

        # Collect footprint sizes across all datasets
        all_sizes = []
        for ds_id in dataset_ids:
            sizes = ctx.get_footprint_sizes(ds_id, chrom, start, end)
            all_sizes.extend(sizes)

        if not all_sizes:
            return {"chart_type": "histogram", "groups": [], "y_label": "Count"}

        # Bin sizes into groups
        bins = [
            ("0-50bp", 0, 50, "#22c55e"),
            ("50-100bp", 50, 100, "#3b82f6"),
            ("100-200bp", 100, 200, "#f59e0b"),
            ("200+bp", 200, float("inf"), "#ef4444"),
        ]

        groups = []
        for label, lo, hi, color in bins:
            count = sum(1 for s in all_sizes if lo <= s < hi)
            groups.append({
                "label": label,
                "bars": [{"label": "All", "value": count, "color": color}],
            })

        return {
            "chart_type": "histogram",
            "groups": groups,
            "y_label": "Count",
            "title": f"Footprint sizes ({len(all_sizes)} total)",
        }

    return router
