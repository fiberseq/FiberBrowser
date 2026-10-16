"""Filtered regional inputs for inference loaders that do not accept a predicate."""
from __future__ import annotations

from contextlib import contextmanager, ExitStack
from pathlib import Path
import tempfile
import weakref

from services.signal_evidence import active_signal_filters, record_keeps_signal, signal_header, signal_filter_key


@contextmanager
def filtered_bam_inputs(datasets, region):
    """Preserve complete records in scratch BAMs, before the engine samples them."""
    if not any(signal_filter_key()):
        yield datasets, {}
        return
    import pysam
    from services.remote_sources.opening import open_alignment_file
    from services.background_work import checkpoint
    from utils.chrom import resolve_reference_name

    with tempfile.TemporaryDirectory(prefix="fiberbrowser-signal-") as folder:
        replacements, inputs = {}, []
        for dataset in datasets:
            paths = dataset["paths"]
            paths = [paths] if isinstance(paths, str) else paths
            selected = []
            for path in paths:
                target = str(Path(folder) / f"input-{len(replacements)}.bam")
                with open_alignment_file(path, "rb") as bam:
                    provenance = signal_header(bam.header)
                    chrom = resolve_reference_name(region["chrom"], bam.references)
                    if chrom is None:
                        raise ValueError(f"Chromosome {region['chrom']} is not in the signal input")
                    with pysam.AlignmentFile(target, "wb", header=bam.header) as out:
                        for i, read in enumerate(bam.fetch(chrom, max(0, region["start"]), region["end"])):
                            if not i & 255:
                                checkpoint()
                            if record_keeps_signal(read, provenance):
                                out.write(read)
                pysam.index(target)
                replacements[target] = str(path) if "://" in str(path) else str(Path(path).resolve())
                selected.append(target)
            inputs.append({**dataset, "paths": selected})
        yield inputs, replacements


def restore_source_paths(value, replacements):
    """Keep provenance tied to the original files after a temporary input load."""
    if isinstance(value, dict):
        return {k: restore_source_paths(v, replacements) for k, v in value.items()}
    if isinstance(value, list):
        return [restore_source_paths(v, replacements) for v in value]
    if isinstance(value, tuple):
        return tuple(restore_source_paths(v, replacements) for v in value)
    if isinstance(value, str):
        for temporary, original in replacements.items():
            if value == temporary or value.endswith(":" + temporary):
                return value[:-len(temporary)] + original
    return value


def load_signal_bam_payload(loader, datasets, region, options, progress):
    """The native loader sees only retained records; source identity stays original."""
    stack = ExitStack()
    try:
        inputs, replacements = stack.enter_context(filtered_bam_inputs(datasets, region))
        payload = loader(inputs, region, options, progress)
        if not replacements:
            return payload
        filters = active_signal_filters()
        def decorate(body):
            body = restore_source_paths(body, replacements)
            for source in body.get("input_files", []):
                if "://" not in source["path"]:
                    stat = Path(source["path"]).stat()
                    source.update(size=stat.st_size, mtime_ns=stat.st_mtime_ns)
            body["signal_filters"] = filters
            return body
        if hasattr(payload, "refine"):
            from fiberhmm.inference.consensus.loader_sampling import SampledPayload
            def refine(requirements):
                payload.refine(requirements)
                return decorate(payload)
            wrapped = SampledPayload(decorate(payload), refine)
            # Refinement opens the same filtered files again. Keep them for the
            # lifetime of this payload, including pooled member refinements.
            cleanup = stack.pop_all()
            weakref.finalize(wrapped, cleanup.close)
            return wrapped
        return decorate(payload)
    finally:
        stack.close()


def load_signal_region_evidence(loader, path, chrom, start, end, **options):
    """The same record gate for an individual evidence loader in a mixed run."""
    with filtered_bam_inputs([dict(paths=[path])], dict(chrom=chrom, start=start, end=end)) as (inputs, replacements):
        reads = loader(inputs[0]["paths"][0], chrom, start, end, **options)
        for read in reads:
            if replacements:
                read.library_id = restore_source_paths(read.library_id, replacements)
        return reads
