"""Read-only native opportunity transport for the *displayed* molecules.

Uses the same query encoder, CIGAR projection, native emissions and thresholds
as inference. It does not infer observations from an uncovered reference base,
run family discovery, or change native calls. BAM decoding is intentionally
separate from the render sample used by the consensus caller (which has none).
"""
from __future__ import annotations

from services.chemistry_metadata import dataset_consensus_chemistry


def lattice_payload(state, request):
    from services.consensus_workflow import _runtime
    from services.consensus_evidence import _runtime as reader_runtime, _chemistry_runtime, _flatten_paths, _resolve_bam_fetch_region
    _runtime()
    from fiberhmm.inference.strand_rescue import hard_observations, cigar_to_query_ref, N_CTX, UNMETH_OFFSET
    from fiberhmm.inference.tf_recaller import build_conditional_hit_tables
    from fiberhmm.inference.consensus.adapter import m5c_query_mask
    import numpy as np
    import pysam

    dsid=request.get('dataset_id');ds=state.get_dataset(dsid)
    if ds is None:raise ValueError('Dataset is not open')
    if getattr(ds,'data_type',None)!='bam':raise ValueError('Native per-read lattice requires BAM query observations; reference-only BigBed positions are not read-level observations')
    chrom=request.get('chrom');start=request.get('start');end=request.get('end')
    if not isinstance(chrom,str) or not chrom or any(not isinstance(v,int) or isinstance(v,bool) for v in (start,end)):
        raise ValueError('An integer half-open display region is required')
    if start<0 or end<=start or end-start>50000:raise ValueError('Zoom to 50 kb or less to display individual opportunity lattices')
    names=request.get('read_ids',[])
    if not isinstance(names,list) or len(names)>10000 or any(not isinstance(n,str) or len(n)>1000 for n in names):
        raise ValueError('At most 10,000 explicitly named displayed reads per lattice request; no inference sample is changed')
    wanted=set(names)
    # Optional per-name alignment identity (the compact read's library_id,
    # reference_start/end, alignment_orientation) to pick one of several primary
    # alignments sharing a name, e.g. the same QNAME in two merged BAMs.
    pinned=request.get('read_identities') or {}
    if not isinstance(pinned,dict):raise ValueError('read_identities must map read names to alignment identities')
    chemistry=request.get('chemistry') or dataset_consensus_chemistry(ds)
    if chemistry not in ('ddda','dddb','hia5-pacbio','hia5-nanopore'):
        raise ValueError('Choose the dataset datatype in Footprints before enabling its native lattice')
    use_m5c=request.get('ddda_m5c_correction',True)
    if not isinstance(use_m5c,bool):raise ValueError('mCG conditioning must be a boolean')
    preset,model,context_size,mode,_,_=_chemistry_runtime(reader_runtime(),chemistry,allow_population=True)
    pp,pa=build_conditional_hit_tables(model)
    # One entry per primary alignment: observations of different molecules that
    # share a name are never merged.
    by_name={}
    if wanted:
        from pathlib import Path
        for path in _flatten_paths(getattr(ds,'paths',None) or ds.path):
            from services.remote_sources import is_source_ref
            from services.remote_sources.opening import open_alignment_file
            library=str(path) if is_source_ref(path) else str(Path(path).expanduser().resolve())
            from services.plasmid_reconcile import contig_links
            actual,lo,hi,_=_resolve_bam_fetch_region(path,chrom,start,end,links=contig_links(state,dataset_id=dsid))
            with open_alignment_file(path,'rb') as bam:
                from services.graph_lift import lift_hidden_predicate
                lift_hidden=lift_hidden_predicate(bam.header)
                for read in bam.fetch(actual,lo,hi):
                    if read.query_name not in wanted or read.is_secondary or read.is_supplementary or read.is_unmapped:continue
                    if lift_hidden is not None and lift_hidden(read):continue
                    identity=dict(library_id=library,reference_start=int(read.reference_start),
                        reference_end=int(read.reference_end),
                        alignment_orientation='reverse' if read.is_reverse else 'forward')
                    encoded=hard_observations(read,preset['strand_mode'],mode,context_size,preset.get('prob_threshold'))
                    if encoded is None:
                        # Still a candidate for its name: a pin to it, or a
                        # duplicate name, must not fall through to another molecule.
                        by_name.setdefault(read.query_name,[]).append(dict(identity=identity,values=None))
                        continue
                    obs,strand=encoded;refs=np.asarray(cigar_to_query_ref(read));obs=np.asarray(obs)
                    size=min(len(obs),len(refs));obs=obs[:size];refs=refs[:size]
                    hit=(obs>=0)&(obs<N_CTX);miss=(obs>=UNMETH_OFFSET)&(obs<UNMETH_OFFSET+N_CTX)
                    keep=(refs>=start)&(refs<end)&(hit|miss)
                    pos=refs[keep];hits=hit[keep];ctx=np.where(hits,obs[keep],obs[keep]-UNMETH_OFFSET).astype(int)
                    valid=(ctx>=0)&(ctx<len(pa));pos,hits,ctx=pos[valid],hits[valid],ctx[valid]
                    if chemistry=='ddda' and use_m5c:
                        mask=m5c_query_mask(read,size);tagged=np.isin(pos,refs[mask&(refs>=0)])&((ctx%64)//16==3)
                        # Match the caller's current condition_unit_on_m5c
                        # semantics: mCG-tagged CpG opportunities are excluded,
                        # not assigned a synthetic emission probability.
                        untagged=~tagged;pos,hits,ctx=pos[untagged],hits[untagged],ctx[untagged]
                    acc=pa[ctx]
                    values={};bad=set()
                    for p,h,a,b in zip(pos,hits,acc,pp[ctx]):
                        key=int(p);value=(int(h),round(float(a),6),round(float(b),6))
                        if key in values and values[key]!=value:bad.add(key)
                        values[key]=value
                    by_name.setdefault(read.query_name,[]).append(dict(identity=identity,values=values,bad=bad,strand=strand))
    def matches(identity,want):
        return isinstance(want,dict) and all(identity.get(k)==want[k] for k in identity if want.get(k) is not None)
    reads={};ambiguous=[]
    for name,alignments in by_name.items():
        # A pin is always enforced, even when only one alignment could be encoded.
        if name in pinned:
            alignments=[a for a in alignments if matches(a['identity'],pinned[name])]
        if len(alignments)>1:
            ambiguous.append(name);continue
        if not alignments or alignments[0]['values'] is None:continue  # unavailable
        chosen=alignments[0]
        items=sorted((p,v) for p,v in chosen['values'].items() if p not in chosen['bad'])
        reads[name]=dict(positions=[p-start for p,v in items],hits=[v[0] for p,v in items],
            p_accessible=[v[1] for p,v in items],p_protected=[v[2] for p,v in items],
            strand=chosen['strand'],identity=chosen['identity'],
            conflicting_observations_omitted=len(chosen['bad']))
    return dict(dataset_id=dsid,chrom=chrom,start=start,end=end,chemistry=chemistry,reads=reads,
        probability_threshold=preset.get('prob_threshold'),ddda_m5c_correction=use_m5c,
        unavailable_read_ids=sorted(wanted-set(reads)),ambiguous_read_ids=sorted(ambiguous),
        semantics='Actual query-encoded, aligned, model-thresholded observations; omitted positions are not misses. No inference or source mutation.')
