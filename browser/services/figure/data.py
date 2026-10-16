"""Data for one figure, loaded once and shared by its tracks.

Loads what the browser would fetch for the same view, through the same
server functions (e.g. the /api/reads/compact payload for reads), so a
figure shows the same reads, layers and metaprofiles as the browser.
"""
from __future__ import annotations

from typing import Any, Callable, Optional


def _int_or(value, default: int) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


class DataCache:
    def __init__(self, state, spec):
        self.state = state
        self.spec = spec
        self._cache: dict[tuple, Any] = {}

    def get(self, key: tuple, load: Callable[[], Any]) -> Any:
        """Memoize ``load()`` under ``key`` for this figure."""
        if key not in self._cache:
            self._cache[key] = load()
        return self._cache[key]

    def compact_reads(self, dataset_id: str, *, max_reads: Optional[int] = None, layer_names: Optional[list[str]] = None,
                      include_methylation: bool = False, include_metaprofile: bool = False,
                      metaprofile_layers: Optional[list[str]] = None, filter_ids: Optional[list[str]] = None,
                      strand: Optional[str] = None, region: Optional[tuple] = None) -> dict:
        """The /api/reads/compact payload the browser gets for this dataset and view."""
        from services.read_endpoint import compact_reads_payload_for_request

        fe = self.spec.fe
        cap = max_reads if max_reads is not None else int(fe.get("allReadsDisplayCap") or 2000)
        layers = sorted(set(layer_names or []))
        key = ("compact", dataset_id, cap, tuple(layers), include_methylation, include_metaprofile,
               tuple(sorted(metaprofile_layers or [])), tuple(sorted(filter_ids or [])), strand)
        chrom, start, end = region or (self.spec.chrom, self.spec.start, self.spec.end)
        key += (chrom, start, end)

        def load():
            return compact_reads_payload_for_request(
                self.state, chrom=chrom, start=start, end=end,
                max_reads=cap, spanning=bool(fe.get("spanningOnly")), dataset_id=dataset_id,
                include_methylation=include_methylation, include_layers=bool(layers),
                layer_names=",".join(layers) or None, include_layer_qualities=True,
                fill_gap_size=int(fe.get("fillGapSize") or 0) if fe.get("fillSmallGaps") else None,
                min_fp_quality=int(fe.get("minFpQuality") or 0),
                min_footprints=int(fe.get("minFootprints") or 0),
                filter_ids=",".join(filter_ids) if filter_ids else None,
                hide_terminal_gaps=bool(fe.get("hideTerminalGaps", True)),
                terminal_gap_threshold=int(fe.get("terminalGapThreshold") or 500),
                include_duplicates=bool(fe.get("showDuplicateReads")),
                include_metaprofile=include_metaprofile,
                profile_max_reads=int(fe.get("backgroundReadCap") or 0),
                metaprofile_layers=",".join(metaprofile_layers) if metaprofile_layers else None,
                sample_seed=fe.get("analysisSampleSeed"),
                strand=strand,
                # As the read track's own request (reads._fetch): a metaprofile
                # from inferred layers must use the same nucleosome size cut-off.
                infer_legacy_layers=bool(fe.get("legacyLayerInference", True)),
                legacy_nuc_min_size=_int_or(fe.get("legacyNucMinSize"), 90),
            )

        return self.get(key, load)
