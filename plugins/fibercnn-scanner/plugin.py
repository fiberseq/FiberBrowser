"""FiberCNN TF Prediction Scanner plugin for FiberBrowser.

Scans the current viewport for per-fiber TF/histone binding predictions using
the FiberCNN tokenized cross-attention model. Produces a BigBed annotation file
that integrates with the existing annotation overlay system.

Launch with:
    python browser.py -b data.bam --plugin ./plugins/fibercnn-scanner/
"""
import asyncio
import json
import logging
import os
import sys
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, Query

logger = logging.getLogger(__name__)


class ScannerState:
    """Holds model, motif index, and scan progress/results."""

    def __init__(self, config):
        self.config = config
        self._model = None
        self._target_names = None
        self._n_motifs = None
        self._target_p99 = None
        self._motif_index = None
        self._model_loaded = False
        self._model_loading = False

        # Scan state
        self.scanning = False
        self.progress = 0.0
        self.message = ""
        self.error = None
        self.last_result = None  # {chrom, start, end, total_annotations, n_fibers, n_positions, targets}
        self.last_file_id = None  # annotation file ID from last scan

    def _config_path(self, key):
        raw = str(self.config.get(key, '') or '').strip()
        if not raw:
            return ''
        return os.path.expanduser(os.path.expandvars(raw))

    def _required_config_path(self, key):
        path = self._config_path(key)
        if not path or "$" in path:
            raise RuntimeError(
                f"FiberCNN plugin config `{key}` is not configured. "
                "Set it in fiberbrowser-plugin.json or export the referenced environment variable."
            )
        return path

    def _ensure_fibercnn_path(self):
        """Add FiberCNN repo to sys.path if not already there."""
        fibercnn_path = self._config_path('fibercnn_path')
        if "$" in fibercnn_path:
            raise RuntimeError(
                "FiberCNN plugin config `fibercnn_path` is not configured. "
                "Set it in fiberbrowser-plugin.json or export the referenced environment variable."
            )
        if fibercnn_path and fibercnn_path not in sys.path:
            sys.path.insert(0, fibercnn_path)

    def load_model(self):
        """Lazily load the model and motif index on first scan."""
        if self._model_loaded:
            return
        if self._model_loading:
            return

        self._model_loading = True
        try:
            self._ensure_fibercnn_path()

            checkpoint = self._required_config_path('checkpoint')
            device = self.config.get('device', 'cuda')

            from chipseq.validate_perfiber_overlay import load_model
            logger.info(f"Loading FiberCNN model from {checkpoint}...")
            self._model, self._target_names, self._n_motifs, self._target_p99 = load_model(
                checkpoint, device)
            logger.info(f"Model loaded: {len(self._target_names)} targets, {self._n_motifs} motifs")

            motif_path = self._required_config_path('motif_index')
            from chipseq.dataset_tokenized import MotifIndex
            logger.info(f"Loading motif index from {motif_path}...")
            self._motif_index = MotifIndex(motif_path)

            self._model_loaded = True
        except Exception as e:
            logger.error(f"Failed to load FiberCNN model: {e}")
            raise
        finally:
            self._model_loading = False

    @property
    def model(self):
        return self._model

    @property
    def target_names(self):
        return self._target_names

    @property
    def n_motifs(self):
        return self._n_motifs

    @property
    def target_p99(self):
        return self._target_p99

    @property
    def motif_index(self):
        return self._motif_index


def create_router(ctx):
    """Create the FiberCNN scanner plugin router."""
    router = APIRouter()

    # Load config from manifest
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    manifest_path = os.path.join(plugin_dir, 'fiberbrowser-plugin.json')
    with open(manifest_path) as f:
        manifest = json.load(f)
    config = manifest.get('config', {})

    scanner = ScannerState(config)

    @router.get("/data")
    async def get_data(
        chrom: str = Query(...),
        start: int = Query(...),
        end: int = Query(...),
    ):
        """Panel data: status + scan results summary.

        Returns a 'scanner' chart_type for custom rendering in PythonPluginPanel.
        """
        region_size = end - start
        max_region = config.get('max_region_bp', 30000)

        base = {
            "chart_type": "scanner",
            "region_size": region_size,
            "max_region": max_region,
            "model_loaded": scanner._model_loaded,
        }

        if scanner.error:
            return {**base, "status": "error", "message": scanner.error,
                    "progress": 0.0, "results": None}

        if scanner.scanning:
            return {**base, "status": "scanning", "progress": scanner.progress,
                    "message": scanner.message, "results": None}

        if scanner.last_result:
            return {**base, "status": "done", "progress": 1.0,
                    "message": "", "results": scanner.last_result}

        return {**base, "status": "ready", "progress": 0.0,
                "message": "", "results": None}

    @router.post("/scan")
    async def start_scan(
        chrom: str = Query(...),
        start: int = Query(...),
        end: int = Query(...),
        min_confidence: float = Query(None),
    ):
        """Start scanning the viewport region in a background thread."""
        region_size = end - start
        max_region = config.get('max_region_bp', 30000)

        if region_size > max_region:
            return {"error": f"Region too large ({region_size:,}bp). Zoom to <{max_region // 1000}kb."}

        if scanner.scanning:
            return {"error": "Scan already in progress"}

        if min_confidence is None:
            min_confidence = config.get('min_confidence', 0.3)

        # Run scan in background thread
        def _run_scan():
            try:
                scanner.scanning = True
                scanner.progress = 0.0
                scanner.error = None
                scanner.message = "Loading model..."

                # Load model lazily
                scanner.load_model()

                scanner.message = "Getting reads..."

                # Get reads from FiberBrowser
                dataset_ids = ctx.get_dataset_ids()
                if not dataset_ids:
                    scanner.error = "No datasets loaded"
                    scanner.scanning = False
                    return

                all_reads = []
                for ds_id in dataset_ids:
                    reads = ctx.get_reads(ds_id, chrom, start, end, spanning=True)
                    all_reads.extend(reads)

                if not all_reads:
                    scanner.error = "No reads found in region"
                    scanner.scanning = False
                    return

                scanner.message = f"Building fiber cache ({len(all_reads)} reads)..."

                # Import scanner module
                from scanner import FiberCacheCompact, scan_region, write_temp_bigbed

                # Build fiber cache from compact reads
                fiber_cache = FiberCacheCompact(all_reads, start)

                scanner.message = "Scanning motif positions..."

                def progress_callback(current, total, n_emitted):
                    scanner.progress = current / total if total > 0 else 0.0
                    scanner.message = f"Position {current}/{total} ({n_emitted:,} annotations)"

                # Run scan
                device = config.get('device', 'cuda')
                pred_window = config.get('pred_window', 1000)

                rows, per_target_counts, n_positions = scan_region(
                    model=scanner.model,
                    target_names=scanner.target_names,
                    n_motifs=scanner.n_motifs,
                    target_p99=scanner.target_p99,
                    fiber_cache=fiber_cache,
                    motif_index=scanner.motif_index,
                    chrom=chrom,
                    region_start=start,
                    region_end=end,
                    pred_window=pred_window,
                    min_confidence=min_confidence,
                    device=device,
                    progress_callback=progress_callback,
                )

                if not rows:
                    scanner.last_result = {
                        "chrom": chrom, "start": start, "end": end,
                        "total_annotations": 0,
                        "n_fibers": len(all_reads),
                        "n_positions": n_positions,
                        "targets": [],
                    }
                    scanner.message = "No predictions above threshold"
                    scanner.scanning = False
                    return

                scanner.message = f"Writing BigBed ({len(rows):,} annotations)..."

                # Generate chrom sizes file from BrowserState
                chrom_sizes_path = ctx.get_chrom_sizes_path()

                # Write temp BigBed
                bb_path = write_temp_bigbed(rows, chrom_sizes_path)

                # Register with annotation system
                ann_state = ctx.get_annotation_state()
                file_id = f"fibercnn_{chrom}_{start}_{end}"

                # Remove previous scan's annotation file if exists
                if scanner.last_file_id and scanner.last_file_id in ann_state.files:
                    # Deactivate and remove
                    old_af = ann_state.files[scanner.last_file_id]
                    old_af.active = False
                    keys_to_remove = [k for k in ann_state._cache if k[0] == scanner.last_file_id]
                    for k in keys_to_remove:
                        del ann_state._cache[k]
                    del ann_state.files[scanner.last_file_id]

                # Ensure unique file ID
                base_id = file_id
                counter = 1
                while file_id in ann_state.files:
                    file_id = f"{base_id}_{counter}"
                    counter += 1

                from models.domain import AnnotationFile
                af = AnnotationFile(file_id, bb_path,
                                    label=f"TF Predictions ({chrom}:{start:,}-{end:,})")
                af.dataset_ids = list(ctx.get_dataset_ids())

                # Write manifest alongside BigBed for type metadata
                from scanner import TARGET_METADATA
                manifest_data = {
                    'source': 'fibercnn_scanner',
                    'types': {}
                }
                for name in scanner.target_names:
                    meta = TARGET_METADATA.get(name, {'category': 'other', 'description': name})
                    manifest_data['types'][name] = meta.copy()

                manifest_json_path = bb_path.replace('.ann.bb', '_manifest.json')
                with open(manifest_json_path, 'w') as mf:
                    json.dump(manifest_data, mf, indent=2)
                af.manifest = manifest_data

                ann_state.files[file_id] = af
                scanner.last_file_id = file_id

                # Auto-activate: discover types and enable
                from server import discover_annotation_types
                types_count = discover_annotation_types(bb_path)

                af.annotation_types = {}
                from models.domain import AnnotationType
                from routers.annotations import _assign_color
                for type_name, count in types_count.items():
                    category = ''
                    description = ''
                    if af.manifest and 'types' in af.manifest:
                        type_info = af.manifest['types'].get(type_name, {})
                        category = type_info.get('category', '')
                        description = type_info.get('description', '')

                    color = _assign_color(ann_state, type_name)
                    af.annotation_types[type_name] = AnnotationType(
                        name=type_name, category=category,
                        description=description, color=color)

                    if type_name not in ann_state.enabled_types:
                        ann_state.enabled_types[type_name] = True

                af.active = True

                # Build targets summary for the panel
                targets_summary = []
                for name in scanner.target_names:
                    count = per_target_counts.get(name, 0)
                    if count > 0:
                        at = af.annotation_types.get(name)
                        targets_summary.append({
                            "name": name,
                            "category": TARGET_METADATA.get(name, {}).get('category', 'other'),
                            "count": count,
                            "color": at.color if at else '#888',
                            "description": TARGET_METADATA.get(name, {}).get('description', name),
                        })

                targets_summary.sort(key=lambda t: -t['count'])

                scanner.last_result = {
                    "chrom": chrom, "start": start, "end": end,
                    "total_annotations": len(rows),
                    "n_fibers": len(all_reads),
                    "n_positions": n_positions,
                    "targets": targets_summary,
                    "file_id": file_id,
                }

                scanner.progress = 1.0
                scanner.message = f"Done: {len(rows):,} annotations"
                logger.info(f"FiberCNN scan complete: {len(rows):,} annotations at "
                            f"{n_positions} positions across {len(all_reads)} reads")

            except Exception as e:
                logger.error(f"FiberCNN scan failed: {e}", exc_info=True)
                scanner.error = str(e)
            finally:
                scanner.scanning = False

        thread = threading.Thread(target=_run_scan, daemon=True)
        thread.start()

        return {"status": "started", "message": "Scan started"}

    @router.get("/status")
    async def get_status():
        """Poll scan progress."""
        return {
            "scanning": scanner.scanning,
            "progress": scanner.progress,
            "message": scanner.message,
            "error": scanner.error,
        }

    @router.get("/config")
    async def get_config():
        """Model info, available targets, categories."""
        if not scanner._model_loaded:
            return {
                "loaded": False,
                "checkpoint": config.get('checkpoint', ''),
                "device": config.get('device', 'cuda'),
            }

        from scanner import TARGET_METADATA, TARGET_MOTIFS
        targets = []
        for name in scanner.target_names:
            meta = TARGET_METADATA.get(name, {})
            has_motifs = name in TARGET_MOTIFS
            targets.append({
                "name": name,
                "category": meta.get('category', 'other'),
                "description": meta.get('description', name),
                "has_motifs": has_motifs,
            })

        return {
            "loaded": True,
            "checkpoint": config.get('checkpoint', ''),
            "device": config.get('device', 'cuda'),
            "n_targets": len(scanner.target_names),
            "n_motifs": scanner.n_motifs,
            "targets": targets,
        }

    return router
