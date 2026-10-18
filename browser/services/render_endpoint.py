"""Endpoint workflow helpers for server-side browser rendering."""
from __future__ import annotations

import io
from dataclasses import replace

from fastapi.responses import Response

from models.requests import RenderRequest
from services.analysis_query import AnalysisReadQuery
from services.circular_genome import circular_query_segments_for_region
from services.fire_tracks import compute_fire_track
from services.read_metrics import (
    compute_metaprofile_from_compact_reads,
    random_state_from_seed,
)
from services.read_sorting import sort_reads_by_accessibility, sort_reads_by_kmeans, sort_similarity_for_dataset
from utils.chrom import get_chrom_variants



def _view_sequence(state, chrom: str, start: int, end: int) -> str:
    """The reference bases of [start, end), aligned to the view: a circular
    contig wraps across its origin, a plasmid map is used for its own contig
    (as /api/sequence does), and positions off a linear contig are blank."""
    from services.circular_genome import circular_chrom_size, circular_region_wraps, circular_view_segments
    from services.supplemental_sequences import supplemental_sequence_for_chrom
    from utils.chrom import resolve_reference_name

    supplemental = supplemental_sequence_for_chrom(state, chrom)
    if supplemental is not None:
        name, sequence = supplemental
        length = len(sequence)
        fetch = lambda s, e: sequence[s:e]  # noqa: E731
        circular = bool(circular_chrom_size(state, name))
    else:
        if state.fasta is None:
            return ""
        ref = resolve_reference_name(chrom, state.fasta.references, getattr(state, "chrom_map", None))
        if ref is None:
            return ""
        length = state.fasta.get_reference_length(ref)
        fetch = lambda s, e: state.fasta.fetch(ref, s, e)  # noqa: E731
        circular = bool(circular_chrom_size(state, chrom))
    if circular and circular_region_wraps(start, end, length):
        return "".join(fetch(seg.ref_start, seg.ref_end) for seg in circular_view_segments(start, end, length)).upper()
    lo, hi = max(0, start), min(end, length)
    if lo >= hi:
        return ""
    return (" " * (lo - start) + fetch(lo, hi).upper() + " " * (end - hi))

def _render_sync(request: RenderRequest, state):
    """Blocking render logic — runs in thread pool."""
    from services.lift.capability import require_for_ids
    from services.query_params import resolve_dataset_ids
    require_for_ids(state, resolve_dataset_ids(state, request.dataset_ids, request.dataset_id), "figure")
    from render import (
        render_axis_track,
        render_meta_track,
        render_peaks_track,
        render_compact_reads_track,
        render_genes_track,
        render_composite,
        render_sequence_track,
        render_signal_track,
        render_coverage_track,
    )

    start, end = request.start, request.end
    width = request.width
    region_width = end - start

    if region_width <= 0:
        raise ValueError(f"Invalid region: {start}-{end}")

    requested_layers = []
    if request.show_fire:
        requested_layers.append("fire")
    if request.show_layers:
        requested_layers.append(
            str((request.tf_overlay or {}).get("layer") or "tf")
        )
    if request.show_deam_opportunities:
        requested_layers.append("deam_opportunity")

    render_query = AnalysisReadQuery.from_request(
        state,
        chrom=request.chrom,
        start=start,
        end=end,
        spanning=request.spanning_only,
        dataset_id=request.dataset_id,
        dataset_ids=request.dataset_ids,
        read_ids=request.read_ids,
        sample_seed=request.sample_seed,
        include_methylation=request.show_mods or request.show_deam_opportunities,
        include_layers=bool(requested_layers),
        requested_layers=requested_layers,
    )
    chrom = render_query.chrom
    sample_seed = render_query.sample_seed
    dataset_id = render_query.dataset_ids[0] if render_query.dataset_ids else None

    track_images = []

    if "axis" in request.tracks:
        track_images.append(("axis", render_axis_track(width, request.chrom, start, end)))

    if "meta" in request.tracks:
        # The reads track's own query (so its read subset applies), without the
        # methylation and layers a metaprofile doesn't use.
        meta_query = replace(
            render_query,
            include_methylation=False,
            include_layers=False,
            requested_layers=(),
        ) if dataset_id else None
        ws = meta_query.build_working_set(state, dataset_id) if meta_query and dataset_id else None
        if ws and ws.reads:
            nuc = compute_metaprofile_from_compact_reads(
                ws.reads,
                region_width,
                90,
                100000,
            )
            sub = compute_metaprofile_from_compact_reads(
                ws.reads,
                region_width,
                10,
                90,
            )
            track_images.append(("meta", render_meta_track(nuc, sub, width)))

    if "peaks" in request.tracks:
        if state.fire_df is not None:
            chrom_variants = get_chrom_variants(chrom)
            fire_track, _peak_pos, peak_regions = None, [], []
            query_segments = circular_query_segments_for_region(state, chrom, start, end)
            for variant in chrom_variants:
                fire_track, _peak_pos, peak_regions = compute_fire_track(
                    state.fire_df,
                    variant,
                    start,
                    end,
                    query_segments=query_segments,
                )
                if fire_track is not None and fire_track.max() > 0:
                    break
            if peak_regions:
                peaks_dicts = [
                    {"start": start + region[0], "end": start + region[1]}
                    for region in peak_regions
                ]
                track_images.append(
                    ("peaks", render_peaks_track(peaks_dicts, width, start, end))
                )

    if "reads" in request.tracks:
        ds_ids = render_query.dataset_ids
        multi_ds = len(ds_ids) > 1

        for ds_id in ds_ids:
            dataset = state.get_dataset(ds_id)
            cluster_assignments = None
            if request.use_clusters and dataset and hasattr(dataset, "cluster_assignments"):
                cluster_assignments = dataset.cluster_assignments

            ws = render_query.build_working_set(
                state,
                ds_id,
                read_ids=request.read_ids,
            )
            if not ws.reads:
                continue

            compact_reads = list(ws.reads)

            sorted_by_clusters = False
            if request.use_clusters and cluster_assignments:
                explicit_read_order = None
                if request.read_sort_order and ds_id in request.read_sort_order:
                    explicit_read_order = request.read_sort_order[ds_id]

                effective_cluster_order = None
                if request.cluster_order and ds_id in request.cluster_order:
                    effective_cluster_order = request.cluster_order[ds_id]

                if not explicit_read_order and not effective_cluster_order:
                    try:
                        sim = sort_similarity_for_dataset(
                            state,
                            ds_id,
                            chrom,
                            start,
                            end,
                            request.spanning_only,
                            sample_seed=sample_seed,
                        )
                        effective_cluster_order = sim.get("cluster_order") or []
                    except Exception as exc:
                        print(f"  Warning: similarity sort for {ds_id} failed: {exc}")
                        effective_cluster_order = []

                if explicit_read_order:
                    rid_idx = {rid: i for i, rid in enumerate(explicit_read_order)}
                    fallback = len(rid_idx)
                    compact_reads.sort(key=lambda read: rid_idx.get(read["id"], fallback))
                    sorted_by_clusters = True
                elif effective_cluster_order:
                    ord_idx = {cluster_id: i for i, cluster_id in enumerate(effective_cluster_order)}
                    fallback = len(effective_cluster_order)
                    compact_reads.sort(
                        key=lambda read: ord_idx.get(
                            cluster_assignments.get(read["id"]),
                            fallback,
                        )
                    )
                    sorted_by_clusters = True

            if sorted_by_clusters:
                pass
            elif request.sort_by == "accessibility":
                compact_reads = sort_reads_by_accessibility(compact_reads)
            elif request.sort_by == "kmeans" and len(compact_reads) > request.n_clusters:
                try:
                    render_random_state = random_state_from_seed(sample_seed, "render", "kmeans")
                    compact_reads = sort_reads_by_kmeans(
                        compact_reads,
                        region_width,
                        n_clusters=request.n_clusters,
                        random_state=render_random_state,
                    )
                except Exception as exc:
                    print(f"  Warning: kmeans sorting failed: {exc}")

            ds_label = None
            ds_color = None
            if multi_ds and request.show_labels and dataset:
                ds_label = getattr(dataset, "label", ds_id)
                ds_color = getattr(dataset, "color", "#3b82f6")

            img = render_compact_reads_track(
                compact_reads,
                region_width,
                width=width,
                row_height=request.row_height,
                show_mods=request.show_mods,
                show_deam_opportunities=request.show_deam_opportunities,
                show_fire=request.show_fire,
                show_cigar=request.show_cigar,
                show_layers=request.show_layers,
                cluster_assignments=cluster_assignments,
                max_reads=request.max_reads,
                subnuc_threshold=request.subnuc_threshold,
                dataset_label=ds_label,
                dataset_color=ds_color,
                colors=request.colors,
                quality_shading=request.quality_shading,
                tf_overlay=request.tf_overlay,
            )
            if img is not None:
                track_images.append(("reads", img))

    if "genes" in request.tracks:
        if state.gtf_data is not None and "transcripts" in state.gtf_data:
            tx_df = state.gtf_data["transcripts"]
            from services.gene_annotations import exon_table

            ex_df = exon_table(state.gtf_data.get("exons"))
            chrom_variants = get_chrom_variants(chrom)
            # A view across a circular contig's origin reads each reference
            # piece and places it at its logical (viewport) position.
            segments = circular_query_segments_for_region(state, chrom, start, end) or [(start, end, 0)]
            genes = []
            for seg_start, seg_end, shift in segments:
                visible = tx_df[
                    (tx_df["chrom"].isin(chrom_variants))
                    & (tx_df["start"] <= seg_end)
                    & (tx_df["end"] >= seg_start)
                ]
                for _, tx in visible.iterrows():
                    exons = ex_df[
                        (ex_df["transcript_id"] == tx["transcript_id"])
                        & (ex_df["start"] <= seg_end)
                        & (ex_df["end"] >= seg_start)
                    ]
                    genes.append({
                        "name": str(tx["gene_name"]),
                        "start": int(tx["start"]) + shift,
                        "end": int(tx["end"]) + shift,
                        "strand": str(tx["strand"]),
                        "exons": [
                            {"start": int(e["start"]) + shift, "end": int(e["end"]) + shift}
                            for _, e in exons.iterrows()
                        ],
                    })
            if genes:
                track_images.append(("genes", render_genes_track(genes, width, start, end)))

    if "sequence" in request.tracks:
        try:
            ref_seq = _view_sequence(state, chrom, start, end)
            seq_img = render_sequence_track(ref_seq, width, start, end) if ref_seq else None
            if seq_img is not None:
                track_images.append(("sequence", seq_img))
        except Exception as exc:
            print(f"  Warning: sequence track rendering failed: {exc}")

    if "signal" in request.tracks and state.orthogonal_tracks:
        for idx, track in enumerate(state.orthogonal_tracks):
            if not track.get("enabled", True):
                continue
            try:
                values = state.get_track_data(idx, chrom, start, end, bins=width)
                if values and any(value != 0 for value in values):
                    label = track.get("label", f"Track {idx}")
                    track_color = track.get("color", "#4682b4")
                    if isinstance(track_color, str) and track_color.startswith("#") and len(track_color) == 7:
                        rgb = (
                            int(track_color[1:3], 16),
                            int(track_color[3:5], 16),
                            int(track_color[5:7], 16),
                        )
                    else:
                        rgb = (70, 130, 180)
                    track_images.append(
                        ("signal", render_signal_track(values, width, color=rgb, label=label))
                    )
            except Exception as exc:
                print(f"  Warning: signal track rendering failed: {exc}")

    if "coverage" in request.tracks and dataset_id:
        ws_cov = render_query.build_working_set(
            state,
            dataset_id,
            read_ids=request.read_ids,
            include_methylation=False,
            include_layers=False,
        )
        if ws_cov.reads:
            track_images.append(
                ("coverage", render_coverage_track(ws_cov.reads, region_width, width, label="Coverage"))
            )

    composite = render_composite(track_images, title=request.title, width=width)

    common_headers = {
        "X-Width": str(composite.width),
        "X-Height": str(composite.height),
        "X-Tracks": ",".join(label for label, _ in track_images),
    }

    fmt = request.format.lower()
    buf = io.BytesIO()

    if fmt == "pdf":
        try:
            from reportlab.lib.utils import ImageReader
            from reportlab.pdfgen import canvas

            dpi = request.dpi
            pdf_w = composite.width * 72 / dpi
            pdf_h = composite.height * 72 / dpi

            pdf_canvas = canvas.Canvas(buf, pagesize=(pdf_w, pdf_h))
            img_reader = ImageReader(composite)
            pdf_canvas.drawImage(img_reader, 0, 0, width=pdf_w, height=pdf_h)
            pdf_canvas.save()
        except ImportError:
            composite.save(buf, format="PDF", resolution=request.dpi)

        buf.seek(0)
        return Response(
            content=buf.getvalue(),
            media_type="application/pdf",
            headers={**common_headers, "Content-Disposition": "attachment; filename=fiberbrowser_render.pdf"},
        )
    if fmt == "svg":
        import base64
        png_buf = io.BytesIO()
        composite.save(png_buf, format="PNG")
        b64 = base64.b64encode(png_buf.getvalue()).decode()
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{composite.width}" height="{composite.height}">\n'
            f'  <image width="{composite.width}" height="{composite.height}" '
            f'href="data:image/png;base64,{b64}"/>\n'
            f"</svg>"
        )
        return Response(
            content=svg.encode(),
            media_type="image/svg+xml",
            headers={**common_headers, "Content-Disposition": "attachment; filename=fiberbrowser_render.svg"},
        )

    composite.save(buf, format="PNG")
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers=common_headers,
    )
