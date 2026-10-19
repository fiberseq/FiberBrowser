"""Map-only adapter into the shared model, with no BAM/sequence fetch.

Phase 0's display payload remains a legacy adapter. The caller supplies verified
map/reference content identities and its saved ledger, never lift_key/mtime.
"""
from dataclasses import asdict

from .identity import content_id, observation_id
from .model import Difference, Geometry, Observation, Phase, Sequence, Span


def assembly_difference(item, *, reference_id, map_content_id, target_contig, ledger, phase=None):
    if not reference_id or not map_content_id:
        raise ValueError('verified reference/map namespace required')
    source = item.get('src') or {}
    source_span = (Span(source['contig'], source['start'], source['end'])
                   if source.get('contig') and source.get('start') is not None and source.get('end') is not None else None)
    geometry = Geometry(Span(target_contig, int(item['t_start']), int(item['t_end'])),
                        int(item['alt_bp']), item['kind'])
    alternate = item.get('alt')
    if item['kind'] == 'deletion' and source_span is not None:
        alternate = ''
    complete = alternate is not None and len(alternate) == geometry.alt_bp and not item.get('alt_truncated')
    sequence = Sequence('available' if complete else 'partial' if alternate is not None else 'unavailable',
                        geometry.alt_bp, alternate[:60] if alternate is not None else None,
                        locator={'content_id': map_content_id, 'span': asdict(source_span) if source_span else None},
                        provenance='assembly')
    raw_identity = content_id('map-operation:v1', [item.get('hap'), item.get('chain'), item.get('strand'),
                              asdict(source_span) if source_span else None, asdict(geometry.reference), geometry.alt_bp])
    observation = Observation(observation_id(map_content_id, raw_identity, 'map_edit'), 'assembly',
                              'map-geometry:v1', map_content_id, source_span, None, raw_identity, sequence)
    phase = phase or Phase(haplotype=item.get('hap'), provenance='map_occurrence')
    snapshot = {'reference_id': reference_id, 'map_content_id': map_content_id, 'geometry': geometry.payload(),
                'legacy_aliases': [item['id'], *item.get('aliases', [])], 'identity_state': 'provisional',
                'phase': asdict(phase)}
    namespace = content_id('assembly-scope:v1', [map_content_id, reference_id])
    identity = ledger.register(namespace, [observation.observation_id], snapshot)
    record = ledger.data['records'][identity]
    difference = Difference(identity, record['revision'], 'assembly', reference_id, geometry, sequence,
                            (observation.observation_id,), phase, record['identity_state'], record['exact_allele_id'])
    return {'difference': difference.payload(), 'observations': [asdict(observation)]}
