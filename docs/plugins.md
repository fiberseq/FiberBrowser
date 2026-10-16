# Plugins

[← Docs index](index.md) · [← README](../README.md)

A Python plugin adds a custom analysis panel. The plugin provides an HTTP route
that returns chart data for the current view; FiberBrowser adds a panel (a tile in the
rail at the right edge) that calls the route and draws the chart.

## Layout

```
my-plugin/
├── fiberbrowser-plugin.json    # manifest
└── plugin.py                   # defines create_router(ctx)
```

### Manifest

```json
{
  "name": "my-plugin",
  "label": "My Analysis",
  "headerColor": "#e11d48",
  "description": "One line shown as the panel's tooltip"
}
```

| Key | Required | Meaning |
|-----|----------|---------|
| `name` | yes | Identifier. The plugin's routes are mounted at `/api/plugins/<name>/`. |
| `label` | no | Panel name on its rail tile and header (defaults to `name`). |
| `headerColor` | no | Panel header colour. |
| `description` | no | Panel description. |

The whole manifest is also returned by `GET /api/plugins/registry`, so a plugin
can keep its own settings in extra keys and read them from the file.

### Code

`plugin.py` must define `create_router(ctx)` and return a FastAPI `APIRouter`.
The panel calls `GET /api/plugins/<name>/data?chrom=...&start=...&end=...`
whenever the view changes, and when you click **Refresh**.

```python
from fastapi import APIRouter

def create_router(ctx):
    router = APIRouter()

    @router.get("/data")
    async def data(chrom: str, start: int, end: int):
        dataset_id = ctx.get_dataset_ids()[0]
        sizes = ctx.get_footprint_sizes(dataset_id, chrom, start, end)
        small = sum(1 for s in sizes if s < 90)
        return {
            "chart_type": "histogram",
            "title": "Footprints by size",
            "y_label": "count",
            "groups": [{
                "label": f"{chrom}:{start}-{end}",
                "bars": [
                    {"label": "< 90 bp", "value": small, "color": "#db2777"},
                    {"label": ">= 90 bp", "value": len(sizes) - small, "color": "#16a34a"},
                ],
            }],
        }

    return router
```

Return `{"error": "message"}` to show an error in the panel.

### Chart types

| `chart_type` | Fields |
|--------------|--------|
| `histogram` | `groups: [{label, bars: [{label, value, color}]}]`, `y_label` |
| `donut` | `segments: [{label, value, color}]` |
| `heatmap` | `matrix`, `row_labels`, `col_labels` |
| `profile` | `series: [{data, color, label}]` |
| `scatter` | `points: [{x, y, label?, color?}]`, `x_label`, `y_label` |
| `vplot` | `matrix`, `size_min`, `size_max`, `size_bin`, `pos_bin` |
| `table` | `columns`, `rows` (list of dicts) |
| `image` | `src` (URL or data URI) |
| `multi` | `charts`: a list of the above |

All types accept an optional `title`.

## The `ctx` object

`ctx` is an `AnalysisContext` (`browser/plugins/context.py`), a stable wrapper
around the browser's state.

| Method | Returns |
|--------|---------|
| `get_dataset_ids()` | Loaded dataset IDs, in display order. |
| `get_dataset(dataset_id)` | The dataset object. |
| `get_working_set(dataset_id, chrom, start, end, spanning=False, read_ids=None)` | The analysis working set for a region. |
| `get_reads(dataset_id, chrom, start, end, spanning=True)` | Compact reads for a region (each with `intervals`, read ID, ...). |
| `get_footprint_sizes(dataset_id, chrom, start, end, spanning=True)` | All footprint sizes in a region. |
| `has_fasta()` | Whether a reference FASTA is loaded. |
| `fetch_sequence(chrom, start, end)` | Reference sequence, or `None` without a FASTA. |
| `get_genes(chrom, start, end)` | Transcripts overlapping a region (`id`, `name`, `start`, `end`, `strand`). |
| `get_chromosomes()` | `[{name, size}]`. |
| `current_genome` | Loaded genome ID (property), or `None`. |
| `get_track_data(track_index, chrom, start, end)` | Data from a loaded bigWig/bigBed/BED track. |
| `get_config()` | Server configuration. |

## Loading plugins

```bash
python browser.py -b data.bam --plugin ./my-plugin           # one plugin (repeatable)
python browser.py -b data.bam --plugin-dir ./plugins/        # every subdirectory with a manifest
```

The launcher prints `Plugin loaded: <label>` for each plugin, or a warning with
the error. Plugin panels appear in the rail (or the classic strip) after the built-in groups.
The repository's `plugins/fibercnn-scanner/` is a larger example.
