"""Map overlay samples through unique graph node columns, preserving path gaps."""
from __future__ import annotations

import numpy as np


async def prepare_graph_loci(state, request):
    """Resolve package occurrences on the API event loop before numerical work."""
    from services.graph_panel import service, columns as gc
    from services.scan.graph_hits import _fetch, merged_occurrences, package_bindings, _sources, _target_key
    if not request.get('loci') or not any(o.get('kind') == 'graph' for o in request.get('observations') or []):
        return request
    try:
        ready = await service.ensure_ready()
        unavailable = None if ready.available else 'Graph columns are unavailable'
    except Exception as error:
        unavailable = str(error)
    bindings_by_registration = {}
    loci = []
    for original in (request.get('loci') or [])[:2000]:
        locus = dict(original)
        if unavailable:
            loci.append(dict(locus, _graph_error=unavailable))
            continue
        alias = locus.get('graph')
        if not alias:
            for public in service.registry().list():
                reg = service.registry().get(public['id'])
                target = _target_key(reg, locus.get('chrom', ''))
                if target:
                    alias = dict(registration=reg.id, target=target, binding=target, anchor=[locus['start'], locus['end']])
                    locus['graph'] = alias
                    break
        if alias:
            try:
                reg = service.registry().get(alias['registration'])
                target = alias['target']
                flank = min(20_000, max(0, int(request.get('flank', 1000))))
                lo, hi = alias['anchor']
                cells = gc.cells_for(max(0, lo - flank), hi + flank + 1)
                tiles = await _fetch(reg, target, [None, *_sources(reg, target)], cells)
                if reg.id not in bindings_by_registration:
                    bindings_by_registration[reg.id] = package_bindings(state, reg)
                locus['_graph_geometry'] = dict(occurrences=merged_occurrences(tiles, target),
                    bindings=bindings_by_registration[reg.id], canonical=alias['binding'])
            except Exception as error:
                locus['_graph_error'] = str(error)
        else:
            locus['_graph_error'] = 'No registered graph covers this locus'
        loci.append(locus)
    return dict(request, loci=loci)


def graph_points(geometry, obs, points):
    """Canonical path bases -> node-forward offsets -> this observation's bases.

    Repeated nodes and offsets outside either path's clip stay unmeasured.
    A path with a different allele never borrows the canonical allele's bases.
    """
    from services.graph_panel.columns import visits
    binding_info = geometry['bindings']
    hap = (obs.get('graph') or {}).get('hap') or obs.get('liftHap')
    choices = [(key, info) for key, info in binding_info.items()
               if obs.get('datasetId') in info.get('datasets', []) and
               (not hap or hap == info.get('hap'))]
    out = np.full(len(points), -1, np.int64)
    if len(choices) != 1:
        return out, None
    binding, info = choices[0]
    contig = (info.get('contigs') or {}).get(obs.get('datasetId'))
    canonical = geometry['occurrences'].get(geometry['canonical'], {})
    own = geometry['occurrences'].get(binding, {})
    cv, ov = visits(canonical), visits(own)
    for node, occurrences in cv.items():
        carriers = ov.get(node, [])
        if len(occurrences) != 1 or len(carriers) != 1:
            continue
        a, b = occurrences[0], carriers[0]
        mask = (points >= a.span[0]) & (points < a.span[1])
        for i in np.flatnonzero(mask):
            offset = a.offset(int(points[i]))
            if a.carries(offset) and b.carries(offset):
                out[i] = b.pos(offset)
    return out, contig
