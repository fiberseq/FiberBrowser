"""Genomic projection of frozen oriented-window evidence; inference stays in its own frame."""
from collections import defaultdict
from copy import deepcopy


def retain_provenance(result, payload):
    result['manifest']['pooling'] = deepcopy(payload['pooling'])
    result['manifest']['region_datasets'] = deepcopy(payload.get('region_datasets', {}))
    units = {s['dataset_id']+'::'+u['unit_id']: u for s in payload['strata'] for u in s['units']}
    units.update({u['unit_id']: u for s in payload['strata'] for u in s['units']})
    for ds in result['datasets'].values():
        for unit in ds['units']:
            original = units.get(unit['unit_id'])
            if original is None and unit.get('genomic_provenance'):continue
            if original is None:raise ValueError('Frozen result lost an evidence unit’s window identity.')
            unit.setdefault('genomic_provenance', deepcopy(original['genomic_provenance']))
    validate_result(result)


def validate_result(result):
    manifest = result.get('manifest', {})
    if not manifest.get('pooling') and manifest.get('region', {}).get('chrom') != 'oriented_BED':
        return
    for ds in result.get('datasets', {}).values():
        for unit in ds.get('units', []):
            w = (unit.get('genomic_provenance') or {}).get('window', {})
            if not w.get('chrom') or w.get('strand') not in ('+', '-') or not isinstance(w.get('start'), int) or not isinstance(w.get('end'), int) or w['start'] < 0 or w['end'] <= w['start']:
                raise ValueError('This result pools oriented BED windows but is missing each molecule’s genomic window. Export a frozen result with genomic_provenance from FiberHMM, or run Find classes on the selected regions here.')


def source_ids(result):
    mapping = result.get('manifest', {}).get('region_datasets', {})
    return list(dict.fromkeys(mapping.get(d, d) for d in result['datasets']))


def display_regions(result, dataset_id, chrom):
    from utils.chrom import normalize_chrom_name
    manifest = result['manifest']
    if not manifest.get('pooling') and manifest.get('region',{}).get('chrom') != 'oriented_BED':
        regions = [manifest['region']]
    else:
        mapping = manifest.get('region_datasets', {})
        windows=(manifest.get('pooling') or {}).get('windows', [])
        regions = ([w for w in windows if w['dataset_id']==dataset_id] if windows and all('dataset_id' in w for w in windows) else
                   [u['genomic_provenance']['window'] for key, ds in result['datasets'].items()
                   if mapping.get(key, key) == dataset_id for u in ds['units']])
    return [dict(t) for t in {tuple(sorted((k, r[k]) for k in ('chrom', 'start', 'end'))) for r in regions
                             if normalize_chrom_name(r['chrom']) == normalize_chrom_name(chrom)}]


def contains_chromosome(result, dataset_id, chrom):
    from utils.chrom import normalize_chrom_name
    manifest = result['manifest']
    if not manifest.get('pooling') and manifest.get('region', {}).get('chrom') != 'oriented_BED':
        return normalize_chrom_name(manifest['region']['chrom']) == normalize_chrom_name(chrom)
    return bool(display_regions(result, dataset_id, chrom))


def genomic_interval(interval, provenance):
    w = provenance['window']; origin = provenance.get('coordinate_origin', 0)
    a, b = interval[0] - origin, interval[1] - origin
    return [w['end'] - b, w['end'] - a] if w['strand'] == '-' else [w['start'] + a, w['start'] + b]


def project_indexes(result, indexes):
    if not result.get('manifest', {}).get('pooling') and result.get('manifest', {}).get('region', {}).get('chrom') != 'oriented_BED':
        return indexes
    validate_result(result)
    mapping = result['manifest'].get('region_datasets', {})
    projected = {}
    for alias, ds in result['datasets'].items():
        target = mapping.get(alias, alias)
        dest = projected.setdefault(target, dict(per_unit={}, unit_windows={}, unit_sources={}, by_name=defaultdict(list), projection_members=defaultdict(list), layers=[]))
        src = indexes[alias]
        dest['layers'] = sorted(set(dest['layers']) | set(src['layers']))
        members_by_unit = defaultdict(list)
        for name, members in src['projection_members'].items():
            for member in members: members_by_unit[member['unit_id']].append((name, member))
        for unit in ds['units']:
            uid = unit['unit_id']; provenance = unit['genomic_provenance']; w = provenance['window']
            dest['unit_windows'][uid] = w
            dest['unit_sources'][uid] = alias
            dest['per_unit'][uid] = deepcopy(src['per_unit'].get(uid, {}))
            for records in dest['per_unit'][uid].values():
                for record in records:
                    for key in ('interval', 'consensus_interval', 'lattice_interval'):
                        if record.get(key): record[key] = genomic_interval(record[key], provenance)
                    if record.get('source_intervals'):
                        record['source_intervals'] = [genomic_interval(iv, provenance) for iv in record['source_intervals']]
                    if w['strand'] == '-' and record.get('strand'):
                        record['strand'] = {'CT': 'GA', 'GA': 'CT', 'FWD': 'REV', 'REV': 'FWD'}.get(record['strand'], record['strand'])
                    record['_chrom'] = w['chrom']
                    # Uncertainty ranges in frame coordinates cannot be used as genomic edges.
                    record.pop('edge_range', None)
            for name, member in members_by_unit[uid]:
                m = deepcopy(member); m['chrom'] = w['chrom']
                # Source members are genomic; only the representative fallback is oriented.
                if not unit.get('source_members'):
                    for field in ('reference_start', 'reference_end'):
                        if field in provenance: m['identity'][field] = provenance[field]
                if not unit.get('source_members') and w['strand'] == '-' and 'chemical_strand' in m['identity']:
                    m['identity']['chemical_strand'] = {'CT': 'GA', 'GA': 'CT'}[m['identity']['chemical_strand']]
                dest['projection_members'][name].append(m)
                if uid not in dest['by_name'][name]: dest['by_name'][name].append(uid)
    return {**indexes, **projected}


def request_windows(result, state):
    """Reconstruct a pooled run's explicit inputs when restoring it as the next run."""
    manifest = result.get('manifest', {})
    if not manifest.get('pooling') and manifest.get('region', {}).get('chrom') != 'oriented_BED':
        return []
    rows = (manifest.get('pooling') or {}).get('windows', [])
    if rows and all('dataset_id' in w for w in rows):
        return deepcopy(rows)
    from services.panel_genomes import dataset_genome
    mapping = manifest.get('region_datasets', {})
    out = {}
    for alias, ds in result['datasets'].items():
        dataset_id = mapping.get(alias, alias)
        for unit in ds['units']:
            w = unit['genomic_provenance']['window']
            key = (dataset_id, w['chrom'], w['start'], w['end'], w['strand'])
            if key not in out:
                out[key] = dict(w, name=f"{w.get('name', 'region')}@{alias}", dataset_id=dataset_id,
                                genome=dataset_genome(state, dataset_id))
    return list(out.values())


def catalog_sources(result):
    """Keep display channels tied to their real dataset and genomic window."""
    mapping = result.get('manifest', {}).get('region_datasets', {})
    sources = {}
    for alias, ds in result.get('datasets', {}).items():
        provenance = next((u['genomic_provenance'] for u in ds.get('units', []) if u.get('genomic_provenance')), None)
        if provenance is None:
            windows = (result.get('manifest', {}).get('pooling') or {}).get('windows', [])
            window = next((w for w in windows if alias == str(w.get('dataset_id', '')) + '@' + str(w.get('name', ''))), None)
            if window is not None:
                provenance = dict(window=window, coordinate_origin=result['manifest']['region'].get('start', 0))
        if provenance:
            sources[alias] = dict(dataset_id=mapping.get(alias, alias), window=deepcopy(provenance['window']),
                                  coordinate_origin=provenance.get('coordinate_origin', 0))
    return sources
