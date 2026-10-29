"""Session-scoped async adapter for the FiberHMM lattice consensus workflow.

No benchmark imports. Source BAMs and producer layers are never changed.
Successful results are installed atomically and displayed from frozen records.
"""
from __future__ import annotations
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import tempfile
import threading
import time
import uuid
from services.fiberhmm_runtime import configure_fiberhmm_runtime
from services.consensus_progress import update_progress, finish_progress
from services.chemistry_metadata import dataset_consensus_chemistry
from utils.chrom import normalize_chrom_name
from services.oriented_regions import source_ids, request_windows

from services.scan.jobs import _EXECUTOR  # shared scan worker; legacy routes keep their job identities
_INIT_LOCK=threading.Lock()
LAYER_LABELS={
    'nuc_native_replay':('Native replay · nucleosomes','#64748b'),
    'msp_native_replay':('Native replay · MSPs','#a7c7bd'),
    'tf_native_replay':('Native · analysis baseline','#94a3b8'),
    'tf_sr_lattice':('Cross-strand footprint states','#8b5cf6'),
    'tf_cr':('Population footprint states','#0891b2'),
    'tf_rc':('Footprint classes','#7c3aed'),
    'tf_cr_manual':('Manual footprint groups','#d97706'),
    'tf_recall':('Recall · new footprint hypotheses','#db2777'),
    'tf_cr_recalled':('CR · including new-call hypotheses','#0d9488'),
    'tf_xcr':('Cross-dataset state relationships','#06b6d4'),
    'nuc_cr_split':('Alternative protected pieces','#14b8a6'),
    'cr_split_gap':('Internal accessible separators','#f59e0b'),
}
NATIVE_CR_MODE='native_family_distribution'
HARMONIZATION_MODE='call_harmonization'
STAGED_MODE='staged_native_families'
# Lattice recaller (FiberHMM engine lattice_recaller): k-means class discovery plus per-molecule lattice EM. Its
# results use the staged browser snapshot (catalog, per-call records), so display and indexing treat it like
# staged; score reprojection and the assignment-reference filter are staged-only (no saved Monte Carlo scores).
RECALLER_MODE='lattice_recaller'
STAGED_LIKE=(STAGED_MODE,RECALLER_MODE)


def viewed_result(job):
    result=job['result']
    stage=job.get('view_stage',result.get('final_stage'))
    if stage in job.get('_assignment_views',{}):
        return dict(result,**job['_assignment_views'][stage])
    return dict(result,**result['stage_results'][stage]) if result.get('stage_results') else result


def _staged_assignment_view(job, reference, stage=None, inspect_only=False):
    """Reproject saved scores; no BAM access, fitting, or Monte Carlo.

    ``inspect_only``: projecting a stage other than the curated final one to look
    at it, which leaves manual edits alone.
    """
    from fiberhmm.inference.consensus.artifacts import read_json
    from fiberhmm.inference.consensus.harmonized_families.presentation import browser_snapshot, presentation_context
    if not 50 <= reference <= 99.9:
        raise ValueError('Staged assignment reference must be between 50 and 99.9')
    if job.get('_curation',{}).get('history') and not inspect_only:
        raise ValueError('Live assignment changes require an unedited automatic run; start a new run to preserve the current manual edits.')
    stage=stage or job.get('view_stage',job['result']['final_stage'])
    if '_assignment_inputs' not in job:
        root=Path(job['artifact_dir']);sources={};scopes={}
        # Each dataset's frozen model record (its native LLR floor among them):
        # without it the presentation falls back to the default floor.
        models={row.get('dataset_id'):row.get('model') for row in
            (job['result'].get('manifest',{}).get('datasets') or []) if isinstance(row,dict)}
        for path in sorted((root/'sources').glob('*/source.json.gz')):
            source=read_json(path)
            target=sources.setdefault(source['dataset_id'],dict(dataset_id=source['dataset_id'],chemistry=source['chemistry'],units=[]))
            if models.get(source['dataset_id']) is not None:
                target['model_manifest']=models[source['dataset_id']]
            target['units'].extend(source['browser_units'].values())
        for name in job['result'].get('stage_results',{}):
            scopes[name]=[(None,read_json(path)) for path in sorted((root/'scopes').glob('*/'+name+'.json.gz'))]
        if not sources or not scopes.get(stage):
            raise ValueError('This result lacks saved assignment evidence; run Find again once to enable live stringency.')
        if any('assignment_compatibility' not in row for items in scopes.values() for _,annotation in items for row in annotation['records']):
            raise ValueError('This older result lacks numeric assignment scores; run Find again once to enable live stringency.')
        job['_assignment_inputs']=(list(sources.values()),scopes,presentation_context(list(sources.values())))
    sources,scopes,context=job['_assignment_inputs']
    params=job['result']['manifest']['parameters'];families=params['families']
    mode='XCR' if params['cross']['enabled'] else 'SR' if params['sr']['enabled'] else 'CR'
    return browser_snapshot(scopes[stage],sources,mode,stage,context,
        minimum_primary_units=families['minimum_display_primary_units'],
        minimum_primary_fraction=families['minimum_display_primary_fraction'],
        assignment_reference_percent=reference)


def stage_index(job, dataset_id, stage=None):
    """A dataset's index for ``stage`` (default: the viewed one).

    A saved class keeps the stage it was found in: looking at another stage
    must not change which reads carry it.
    """
    result=job['result'];stages=result.get('stage_results') or {}
    if not stage or stage==job.get('view_stage',result.get('final_stage')) or stage not in stages:
        return job.get('index',{}).get(dataset_id)
    cache=job.setdefault('_stage_indexes',{})
    if stage not in cache:
        cache[stage]=_index(dict(result,**job.get('_assignment_views',{}).get(stage,stages[stage])))[0]
    return cache[stage].get(dataset_id)


def viewing_final(job):
    return job.get('view_stage',job['result'].get('final_stage'))==job['result'].get('final_stage')


def membership_is_curated(job, stage=None):
    """Whether membership at ``stage`` (as ``stage_index`` resolves it) follows
    manual curation. The display shows curated records on the final stage only,
    so final-stage membership, automatic classes included, uses them too;
    earlier stages keep their uncurated assignments. Without any curation
    decision the curated view is the automatic one, so it isn't built."""
    store=job.get('_curation')
    if not store:return False
    snapshots=store.get('snapshots') or []
    cursor=store.get('cursor',0)
    current=snapshots[cursor] if 0<=cursor<len(snapshots) else {}
    if not (current.get('manual_groups') or current.get('ignored_families')):return False
    result=job['result'];stages=result.get('stage_results') or {}
    final=result.get('final_stage')
    effective=job.get('view_stage',final) if (not stage or stage not in stages) else stage
    return effective==final


def assignment_export_result(job):
    result=job['result'];views=job.get('_assignment_views',{})
    if not views:return result
    final=result.get('final_stage')
    output=dict(result,stage_results={**result.get('stage_results',{}),**views})
    if final in views:output.update(views[final])
    if final in views:
        # The reference the final assignments were projected at, which is not
        # the current filter when that was changed while viewing another stage.
        reference=job.get('_assignment_view_refs',{}).get(final,job['filters']['classification_reference_percent'])
        parameters=result['manifest']['parameters']
        output['manifest']=dict(result['manifest'],parameters=dict(parameters,
            families=dict(parameters['families'],assignment_reference_percent=reference)))
    return output


def select_stage(state,job_id,stage):
    jobs,lock=_session(state)
    with lock:
        job=jobs[job_id]
        if job['status']!='complete' or stage not in job['result'].get('stage_results',{}):
            raise ValueError('Select a completed frozen stage from this job')
        views=job.get('_assignment_views')
        if views:
            reference=job['filters']['classification_reference_percent']
            refs=job.setdefault('_assignment_view_refs',{})
            final=job['result'].get('final_stage')
            curated=bool(job.get('_curation',{}).get('history'))
            # Reuse a view already at this reference; never reproject the final
            # stage under manual edits (they were made on its current view).
            if (stage not in views or refs.get(stage)!=reference) and not (stage==final and curated):
                views[stage]=_staged_assignment_view(job,reference,stage,inspect_only=stage!=final)
                refs[stage]=reference
                # New final assignments: an (unedited) curation store built on the
                # old ones is rebuilt from these, as set_filters does.
                if stage==final:job.pop('_curation',None)
            elif stage==final and curated:
                # Kept as edited: report the stringency its assignments were made at
                # (never reprojected: the run's own).
                made_at=refs.get(stage)
                if made_at is None:
                    made_at=(job['result'].get('manifest',{}).get('parameters',{}).get('families',{})
                             .get('assignment_reference_percent'))
                if made_at is not None:
                    job['filters']['classification_reference_percent']=made_at
        index,layers=_index(dict(job['result'],**job.get('_assignment_views',{}).get(stage,job['result']['stage_results'][stage])))
        job.update(view_stage=stage,index=index,layers=layers)
        job.pop('_native_call_lookup',None)
        job.pop('_stage_indexes',None)
        # Another job's stage: its layers aren't the ones on the tracks.
        if getattr(state,'consensus_workflow_active',None)==job_id:
            _register(state,job)
        return _summary(job)


def _cr_mode(result):
    return result.get('cr_mode') or result.get('manifest',{}).get('cr_mode') or 'legacy_configuration'


def _session(state):
    with _INIT_LOCK:
        if 'consensus_workflow_jobs' not in state.__dict__:
            state.consensus_workflow_jobs={}
            state.consensus_workflow_lock=threading.RLock()
            state.consensus_workflow_active=None
    return state.consensus_workflow_jobs,state.consensus_workflow_lock


def _consensus_install_help(configured=None):
    from services.fiberhmm_runtime import fiberhmm_install_help
    return (fiberhmm_install_help(configured) + ' Footprint classes require a FiberHMM release with the '
            'lattice recaller (or the staged engine); no alternate engine is substituted.')


def _validate_consensus_runtime(workflow, parameters):
    groups = parameters.parameter_schema()
    engines = next((control.get('choices', []) for control in groups.get('cr', [])
                    if control.get('name') == 'engine'), [])
    if (RECALLER_MODE not in engines or 'recaller' not in groups or 'families' not in groups
            or not callable(getattr(workflow, 'run_analysis', None))):
        raise ValueError('Installed FiberHMM lacks the required staged consensus API. ' + _consensus_install_help())


def _runtime():
    configured=configure_fiberhmm_runtime(strict=True)
    try:
        from fiberhmm.inference.consensus import workflow,parameters
    except ImportError as error:
        raise ValueError(f'FiberHMM consensus is unavailable ({error}). ' + _consensus_install_help(configured)) from error
    _validate_consensus_runtime(workflow, parameters)
    return workflow,parameters


def _snapshot(state,dataset_ids):
    result={}
    for dsid in dataset_ids:
        ds=state.get_dataset(dsid)
        if ds is None:raise ValueError(f'Dataset {dsid!r} is no longer open')
        paths=getattr(ds,'paths',None) or [ds.path]
        if isinstance(paths,str):paths=[paths]
        # BigBed evidence also reads the companion layer files: a replaced TF or
        # modification companion is a changed source too.
        evidence=list(map(str,paths))
        from services.remote_sources import is_source_ref
        if any(is_source_ref(p) for p in evidence):
            raise ValueError(f'{ds.label} is on a cluster (ssh://). Footprint-class runs read every molecule in the region '
                'through FiberHMM, which needs the files on this computer: copy the BAM here (or run FiberHMM on the cluster) '
                'and load the local copy.')
        from utils.validation import is_url
        if getattr(ds,'data_type',None)=='bam' and any(is_url(p) for p in evidence):
            # FiberHMM opens the BAM by name and records its size and time: a URL
            # failed deep inside with "Could not open alignment file ... 's3:/...'".
            raise ValueError(f'{ds.label} is read over the network (https:// or s3://). Footprint-class runs read every '
                'molecule in the region through FiberHMM, which opens BAMs on this computer only: download the BAM and '
                'its index (or just this region: samtools view -b <URL> chrom:start-end), index it, and open the local copy.')
        for group in (getattr(ds,'companion_layers',None) or {}).values():
            for p in ([group] if isinstance(group,str) else group or []):
                if str(p) not in evidence:evidence.append(str(p))
        result[dsid]=dict(paths=list(map(str,paths)),chemistry=dataset_consensus_chemistry(ds),
            files=[[p,Path(p).stat().st_size,Path(p).stat().st_mtime_ns] for p in evidence if Path(p).is_file()])
    return result


def _same_sources(left,right):
    # Chemistry is frozen in the request/model manifest, not a mutable display
    # declaration. Keep that declaration in receipts only as provenance.
    return {k:{p:v for p,v in row.items() if p!='chemistry'} for k,row in left.items()}=={
        k:{p:v for p,v in row.items() if p!='chemistry'} for k,row in right.items()}


def schema():
    workflow,parameters=_runtime()
    groups=parameters.parameter_schema()
    # FiberBrowser's normal path is the lattice recaller; the staged Monte Carlo
    # engine stays selectable in the panel, other engines in advanced controls.
    for control in groups.get('cr',[]):
        if control.get('name')=='engine':control['default']=RECALLER_MODE
    return dict(schema='fiberhmm.consensus.v1',cr_mode=RECALLER_MODE,groups=groups,layers=LAYER_LABELS,
        runtime=dict(workflow_path=str(Path(workflow.__file__).resolve()),
            source_root=str(Path(workflow.__file__).resolve().parents[3])),
        display_defaults=dict(minimum_model_q=0.,minimum_rescue_model_q=0.,minimum_comparability_q=0.,require_population_comparable=False,
            require_molecule_comparable=False,require_cross_comparable=False,show_quality_outlines=True,recaller_edges='native',recaller_class_tiers={},
            classification_reference_percent=99.9),
        classification_display=dict(parameter='classification_reference_percent',minimum=50.,maximum=99.999,
            semantics='Native predictive reference compatibility, not accuracy, posterior probability, or FDR. Higher reference values admit more alternatives; source spans are fixed.'))


def load_payload(state,request,options,progress):
    """Every regional read before collapse; no viewport read sample enters inference."""
    if all(state.get_dataset(dsid).data_type == 'bam' for dsid in request['dataset_ids']):
        try:
            from fiberhmm.inference.consensus.bam import load_bam_payload
        except ImportError as error:
            raise ValueError(_consensus_install_help()) from error
        datasets=[]
        for dsid in request['dataset_ids']:
            ds=state.get_dataset(dsid)
            datasets.append(dict(dataset_id=dsid,paths=getattr(ds,'paths',None) or ds.path,
                chemistry=request.get('chemistry_overrides',{}).get(dsid) or dataset_consensus_chemistry(ds)))
        from services.signal_bam_input import load_signal_bam_payload
        return load_signal_bam_payload(load_bam_payload, datasets, {k:request[k] for k in ('chrom','start','end')}, options, progress)

    from services.consensus_evidence import (_runtime as loader_runtime,_load_dataset_evidence,_flatten_paths,_resolve_bam_fetch_region,
        _chemistry_runtime,_prefix_library,_projection_members,_projection_member_key)
    from fiberhmm.inference.consensus.adapter import evidence_unit,replay_alignment,condition_unit_on_m5c
    from fiberhmm.inference.tf_recaller import ENZYME_PRESETS
    runtime=loader_runtime();strata=[];start,end=request['start'],request['end'];chrom=request['chrom'];warnings=[]
    explicit=set(request.get('explicit_parameters') or ())
    for ordinal,dsid in enumerate(request['dataset_ids']):
        ds=state.get_dataset(dsid)
        chemistry=request.get('chemistry_overrides',{}).get(dsid) or dataset_consensus_chemistry(ds)
        if chemistry not in ('ddda','dddb','hia5-pacbio','hia5-nanopore'):
            raise ValueError(f'{ds.label}: choose a datatype in the Footprint panel; guessing the opportunity model is unsafe')
        from fiberhmm.inference.consensus.progress import report
        report(progress,'loading',f'{ds.label}: loading all regional observations ({chemistry})',dataset_id=dsid)
        reads,model,preset,diagnostics=_load_dataset_evidence(state,dsid,chemistry,chrom=chrom,
            evidence_start=start,evidence_end=end,maximum_reads=0,runtime=runtime,
            allow_population=True,require_nucleosomes=False,tf_layer='tf',minimum_mapq=options['input'].minimum_mapq,
            **({'legacy_annotation_frame':options['input'].legacy_hia5_annotation_frame} if chemistry.startswith('hia5') and options['cr'].engine in (HARMONIZATION_MODE,*STAGED_LIKE) else {}))
        for read in reads:_prefix_library(read,dsid)
        if chemistry in ('ddda','dddb'):
            representatives,collapse=runtime['collapse'](reads,min_jaccard=options['input'].molecule_min_jaccard,
                min_deam=options['input'].molecule_min_deam)
        else:
            representatives=reads;collapse=dict(raw_reads=len(reads),analyzed_molecules=len(reads),duplicate_reads_collapsed=0)
        projections=_projection_members(reads,representatives,exact_records=True)
        # As FiberHMM's BAM loader: a unit is named by the dataset's position in the run and the file's index in the
        # dataset, never its label or path, so the same files give the same classes wherever they are opened from.
        units=[evidence_unit(read,model,dsid,projections.get(_projection_member_key(read),[]),start,end,dataset_ordinal=ordinal)
               for read in representatives]
        use_m5c=chemistry=='ddda' and options['input'].ddda_m5c_correction
        if use_m5c and ds.data_type!='bam' and ds.available_layers.get('ddda_mcg'):
            # mCG conditioning needs BAM query coordinates. On by default: a BigBed run proceeds without it (and says
            # so); only a user who turned it on explicitly is refused.
            if 'input.ddda_m5c_correction' in explicit:
                raise ValueError('Tagged DddA mCG conditioning currently needs BAM query coordinates; use BAM or explicitly disable that input option')
            use_m5c=False
            warnings.append(f'{ds.label}: DddA mCG conditioning was skipped: it needs BAM query coordinates and this dataset is '
                            'BigBed. Open the BAM to use it, or turn off "Honor DddA mCG substrate annotations".')
        minimum_llr=None
        if options['input'].correct_native or (use_m5c and ds.data_type=='bam'):
            if ds.data_type!='bam':
                if options['cr'].engine==RECALLER_MODE:raise ValueError(f'{ds.label}: '+RECALLER_NEEDS_BAM+'Open the BAM, or choose the staged engine.')
                raise ValueError(f'{ds.label}: actual-query decoder replay requires BAM; disable native replay to use existing BigBed TF calls')
            import pysam
            lookup=defaultdict(list)
            for read,unit in zip(representatives,units):lookup[str(read.record_sha256)].append((read,unit))
            found=set()
            _,_,context_size,mode,_,_=_chemistry_runtime(runtime,chemistry,allow_population=True)
            enzyme='hia5' if chemistry.startswith('hia5') else chemistry
            minimum_llr=getattr(options['input'],chemistry.replace('-','_')+'_minimum_llr')
            if minimum_llr<0:minimum_llr=ENZYME_PRESETS[enzyme]['min_llr']
            for path in _flatten_paths(getattr(ds,'paths',None) or ds.path):
                from services.plasmid_reconcile import contig_links
                actual,lo,hi,_=_resolve_bam_fetch_region(path,chrom,start,end,links=contig_links(state,dataset_id=dsid))
                from services.remote_sources.opening import open_alignment_file
                with open_alignment_file(path,'rb') as bam:  # a lab server: confined on every reopen
                    for alignment in bam.fetch(actual,lo,hi):
                        if alignment.is_secondary or alignment.is_supplementary:continue
                        key=hashlib.sha256(alignment.to_string().encode()).hexdigest()
                        if key not in lookup or key in found:continue
                        if len(found)%32==0:
                            report(progress,'native',f'{ds.label}: replaying the native caller {len(found)}/{len(lookup)} alignments',
                                dataset_id=dsid,completed=len(found),total=len(lookup),unit='alignments')
                        else:progress('native',None)
                        # Identical SAM records may be distinct retained evidence
                        # units. Replay every unit; never collapse them in this lookup.
                        for read,u in lookup[key]:
                            if use_m5c:condition_unit_on_m5c(alignment,u)
                            if options['input'].correct_native:
                                if options['cr'].engine in STAGED_LIKE and chemistry.startswith('hia5') and options['families'].recall_hia5_nucleosomes:
                                    from fiberhmm.inference.consensus.upstream_recall import recall_hia5_alignment,install_recall
                                    recalled=recall_hia5_alignment(alignment,u,model,preset['strand_mode'],mode,context_size,preset.get('prob_threshold'),
                                        minimum_llr,minimum_opportunities=options['input'].native_minimum_opportunities,
                                        split_minimum_llr=options['families'].nuc_split_minimum_llr,
                                        maximum_alignment_gap_bp=options['input'].native_maximum_alignment_gap_bp,
                                        minimum_nfr_length=options['input'].minimum_nfr_length,
                                        legacy_annotation_frame=options['input'].legacy_hia5_annotation_frame)
                                    install_recall(u,recalled)
                                    continue
                                replay_unit=u
                                if options['cr'].engine==HARMONIZATION_MODE:
                                    domains=[[max(start,a),min(end,b)] for a,b in u['msp_intervals'] if a<end and b>start]
                                    replay_unit=dict(u,msp_intervals=domains)
                                    u['provenance']['native_replay_scope']=dict(region=[start,end],effective_msp_intersections=domains,
                                        minimum_nfr_length=options['input'].minimum_nfr_length,boundary_clipping_is_scope_not_quality=True)
                                calls=replay_alignment(alignment,replay_unit,model,preset['strand_mode'],mode,context_size,preset.get('prob_threshold'),
                                    minimum_llr,minimum_opportunities=options['input'].native_minimum_opportunities,
                                    minimum_nfr_length=options['input'].minimum_nfr_length,use_m5c=use_m5c,
                                    maximum_alignment_gap_bp=int(getattr(options['input'],'native_maximum_alignment_gap_bp',0)))
                                u['native_multi_interval_calls']=calls;u['native_multi_interval_tf_intervals']=[c['interval'] for c in calls]
                        found.add(key)
            if len(found)!=len(lookup):raise ValueError(f'{ds.label}: could not identify every representative alignment for native replay')
        # Keep chemical CT/GA order, but never split Hia5 by mapping orientation.
        units.sort(key=lambda u:((0 if u['strand']=='CT' else 1),u['unit_id']) if chemistry in ('ddda','dddb') else (0,u['unit_id']))
        model_hash=hashlib.sha256(model.emissionprob_.astype('<f8').tobytes()).hexdigest()
        strata.append(dict(dataset_id=dsid,stratum_id=dsid,chemistry=chemistry,units=units,
            model_manifest=dict(preset=chemistry,emissions_sha256=model_hash,efficiency_scaling=False,
                native_minimum_llr=minimum_llr if options['input'].correct_native else None,
                replay_scope=('query_nuc_recall_then_TF_replay' if any('upstream_nuc_tf_recall' in u for u in units) else
                    'fixed_MSP_intersection_with_analysis_region' if options['cr'].engine==HARMONIZATION_MODE else 'fixed_MSP_only') if options['input'].correct_native else 'existing_calls',
                legacy_hia5_annotation_frame=options['input'].legacy_hia5_annotation_frame if chemistry.startswith('hia5') else None,
                native_minimum_msp_bp=options['input'].minimum_nfr_length,
                native_minimum_opportunities=options['input'].native_minimum_opportunities,
                upstream_nuc_tf_recall=any('upstream_nuc_tf_recall' in u for u in units),
                upstream_nuc_tf_settings=next((u['upstream_nuc_tf_recall']['settings'] for u in units if 'upstream_nuc_tf_recall' in u),None),
                m5c_conditioned_opportunities=sum(u['provenance'].get('native_m5c_conditioned_opportunities',0) for u in units)),
            evidence_units=dict(**collapse,physical_duplex_independence_established=False),load=diagnostics))
    payload=dict(region=dict(chrom=chrom,start=start,end=end),strata=strata)
    if warnings:payload['browser_warnings']=warnings   # the worker moves these onto the job (not inference input)
    return payload


def _rescue_numerics(rescue):
    if rescue.get('model')!='population_assisted':return None
    models=rescue.get('source_recipes',[])
    return dict(model='population_assisted',source_models=len(models),
        provisional_source_models=sum(bool(m.get('numerical_provisional')) for m in models),
        minimum_source_ess=min((m['integration']['effective_sample_size'] for m in models),default=0.),
        maximum_source_rhat=max((m['integration'].get('maximum_split_Rhat',1.) for m in models),default=1.),
        retained_additions=rescue.get('retained_calls',0))


def rescue_rate_summary(dataset,filters):
    """Current addition counts without editing the frozen native catalog/rates."""
    rescue=dataset.get('rescue',{})
    if rescue.get('model')!='population_assisted':return None
    threshold=1-10**(-filters.get('minimum_rescue_model_q',filters['minimum_model_q'])/10)
    totals=defaultdict(set);base=defaultdict(lambda:defaultdict(set));added=defaultdict(lambda:defaultdict(set))
    for row in dataset.get('cr',{}).get('records',[]):
        strand=row['strand'];uid=row['unit_id'];totals[strand].add(uid)
        for call in row['proposals']:
            if call['model_membership']>=.5:base[call['family']][strand].add(uid)
    for row in rescue.get('records',[]):
        for call in row['calls']:
            if call['model_membership']>=threshold:added[call['family']][row['strand']].add(row['unit_id'])
    families={c['family'] for c in dataset.get('cr',{}).get('catalog',[])}|set(base)|set(added)
    values={f:{s:dict(baseline_units=len(base[f][s]),added_units=len(added[f][s]-base[f][s]),
        combined_units=len(base[f][s]|added[f][s]),all_units=len(totals[s])) for s in sorted(totals)} for f in sorted(families)}
    return dict(probability_threshold=threshold,baseline_probability_threshold=.5,
        denominator='All evidence units per chemical strand, not testability-normalized',by_family=values)


def _summary(job):
    result={k:v for k,v in job.items() if not k.startswith('_') and k not in ('result','index')}
    if 'result' in job:
        from fiberhmm.inference.consensus.numerics import summarize_fits
        visible=viewed_result(job)
        result['loader_sampling']=job['result'].get('manifest',{}).get('loader_sampling',[])
        result['molecule_sampling']=job['result'].get('manifest',{}).get('molecule_sampling',[])
        result['summary']={ds:dict(units=len(v['units']),sr_changed=v['sr'].get('changed',0),
            classes=len(v.get('cr',{}).get('catalog',[])),assignments=sum(len(r['proposals']) for r in v.get('cr',{}).get('records',[])),
            rescued=v.get('rescue',{}).get('accepted_calls',0),split_spans=v.get('split',{}).get('accepted_spans',0),
            population_rescue=_rescue_numerics(v.get('rescue',{})),
            numerical_fit=v.get('cr',{}).get('fit_diagnostics',{}).get('global_fit') or summarize_fits(v.get('cr',{}).get('fits',[])),
            statuses={k:v.get(k,{}).get('status','disabled') for k in ('sr','cr','rescue','comparability','split')}) for ds,v in visible['datasets'].items()}
        result['cross_summary']={k:v for k,v in visible['cross'].items() if k not in ('edges','count_groups')}
        result['cross_summary']['count_group_statuses']=dict(Counter(g['kind'] for g in job['result']['cross'].get('count_groups',[])))
        result['layers']=job.get('layers',[])
        result['cr_mode']=_cr_mode(job['result'])
        result['stages']=job['result'].get('stages',[])
        if _cr_mode(job['result'])==STAGED_MODE:
            result['checkpoints']=job['result'].get('manifest',{}).get('checkpoints')
        if job['result'].get('transfer'):
            # A fiberhmm-transfer run: frozen classes scored on these molecules (no discovery).
            transfer=job['result']['transfer']
            result['transfer']={k:transfer.get(k) for k in ('schema','catalog_sha256','source','window','discovery') if k in transfer}
        result['view_stage']=job.get('view_stage',job['result'].get('final_stage'))
        result['final_stage']=job['result'].get('final_stage')
        if result['cr_mode'] in STAGED_LIKE:
            for ds,summary in result['summary'].items():
                calls=[p for row in visible['datasets'][ds]['cr']['records'] for p in row['proposals']]
                summary.update(source_calls=len(calls),assignments=sum(bool(c.get('family')) for c in calls),
                    unclassified_calls=sum(not c.get('family') for c in calls),numerical_fit=None)
        if result['cr_mode']==HARMONIZATION_MODE:
            result['comparison_summary']=job['result'].get('comparison',{}).get('counts',{})
            region=job['result']['manifest']['region']
            for ds,summary in result['summary'].items():
                calls=[c for row in job['result']['datasets'][ds].get('cr',{}).get('records',[]) for c in row['proposals']]
                contained=sum(region['start']<=c['interval'][0] and c['interval'][1]<=region['end'] for c in calls)
                overlapping=sum(c['interval'][0]<region['end'] and c['interval'][1]>region['start'] for c in calls)
                summary.update(numerical_fit=None,source_calls=len(calls),source_calls_in_region=contained,
                    boundary_crossing_calls=overlapping-contained,outside_region_calls=len(calls)-overlapping,
                    assignments=sum(c.get('family') is not None for c in calls),
                    unclassified_calls=sum(c.get('family') is None for c in calls))
        if result['cr_mode']==NATIVE_CR_MODE:
            for ds,summary in result['summary'].items():
                calls=[call for row in job.get('index',{}).get(ds,{}).get('per_unit',{}).values()
                       for call in row.get('tf_cr',[])]
                if not job.get('index'):
                    calls=[call for row in job['result']['datasets'][ds].get('cr',{}).get('records',[])
                           for call in row['proposals']]
                summary.update(cr_mode=NATIVE_CR_MODE,source_calls=len(calls),
                    native_catalog_update=job['result']['datasets'][ds].get('cr',{}).get('native_catalog_update'),
                    assignments=sum(c.get('classification_status')=='compatible_catalog_label' for c in calls),
                    unclassified_calls=sum(c.get('classification_status')=='provisional_unresolved' for c in calls),
                    ambiguous_calls=sum(bool(c.get('compatible_alternatives')) for c in calls),
                    classification_reference_percent=job.get('filters',{}).get('classification_reference_percent',99.9),
                    numerical_fit=None,classification_semantics='Frozen native shape compatibility, not posterior/model-Q or new-call rescue')
    return result


RECALLER_NEEDS_BAM=('The lattice recaller (the default engine) finds and scores classes from the native caller replayed '
    'on each read, which needs the BAM with its MM/ML modification tags; existing BigBed TF calls cannot be used. ')


def recaller_preflight(state,dataset_ids,options):
    """Refuse a lattice recaller run that could only 'complete' with no classes: without native replay (BigBed input,
    or replay turned off) no molecule carries the calls the recaller discovers and scores classes from."""
    if getattr(options.get('cr'),'engine',None)!=RECALLER_MODE:return
    bigbed=[]
    for dsid in dataset_ids:
        ds=state.get_dataset(dsid)
        if ds is not None and getattr(ds,'data_type','bam')!='bam':bigbed.append(str(getattr(ds,'label',None) or dsid))
    if bigbed:
        raise ValueError(f"{', '.join(bigbed)}: "+RECALLER_NEEDS_BAM+
            'Open the BAM for this dataset, or choose Engine: Staged Monte Carlo (deprecated) with '
            '"Replay corrected native TF decoder" turned off to use the BigBed calls.')
    if not getattr(options.get('input'),'correct_native',True):
        raise ValueError(RECALLER_NEEDS_BAM.replace('existing BigBed TF calls cannot be used','it cannot run on existing calls')+
            'Turn "Replay corrected native TF decoder" back on, or choose Engine: Staged Monte Carlo (deprecated) to use the existing calls.')


def submit(state,request,*,payload_loader=None,analysis_runner=None):
    # Live-lift datasets first (409, services/lift/capability.py): never the BAM/BigBed guidance below.
    from services.lift.capability import require_for_ids
    require_for_ids(state,list(request.get('dataset_ids') or ()) or [request.get('dataset_id')],'consensus')
    from services.signal_evidence import active_signal_filters
    request = {**request, "signal_filters": active_signal_filters()}
    if request.get("region_windows") and payload_loader is None:
        raise ValueError("Use the selected-region analysis entry point for oriented windows.")
    workflow,parameters=_runtime()
    from fiberhmm.inference.consensus.regions import automatic_parameters
    strata=[dict(dataset_id=dsid,chemistry=request.get('chemistry_overrides',{}).get(dsid) or
        dataset_consensus_chemistry(state.get_dataset(dsid))) for dsid in request.get('dataset_ids',[])]
    from services.read_depth import NAMES, depth_parameters, machine_depth_parameters
    params = dict(request.get('parameters') or {})
    if getattr(state, 'performance', {}).get('effective') == 'low':
        params['recaller'] = machine_depth_parameters(state, params.get('recaller'))
    param_schema = getattr(parameters, 'parameter_schema', None)
    controls = {c['name'] for c in param_schema().get('recaller', [])} if callable(param_schema) else set()
    if 'recaller' in params:
        params['recaller'] = depth_parameters(params['recaller'], set(NAMES) <= controls)
    request={**request,'parameters':automatic_parameters(params,strata)}
    try:
        options=parameters.parse_options(request['parameters'])
    except ValueError as error:
        # FiberHMM >= 3 rejects settings the chosen engine ignores (e.g. native
        # replay off under the recaller) in CLI terms; say it in the panel's.
        if 'correct_native=false is not supported by the lattice recaller' in str(error):
            raise ValueError(RECALLER_NEEDS_BAM.replace('existing BigBed TF calls cannot be used','it cannot run on existing calls')+
                'Turn "Replay corrected native TF decoder" back on, or choose Engine: Staged Monte Carlo (deprecated) to use the existing calls.') from error
        raise
    ids=request.get('dataset_ids',[])
    if not ids or len(set(ids))!=len(ids):raise ValueError('Select one or more distinct datasets')
    # One run covers one region of one reference (services/panel_genomes.py).
    from services.panel_genomes import mixed_references
    if not payload_loader and mixed_references(state,ids):raise ValueError('These datasets are on different references (a dataset with its own reference '
        'is on another assembly). A footprint-class run covers one region of one reference: run the datasets of each reference separately.')
    if not isinstance(request.get('chrom'),str) or not request['chrom']:raise ValueError('Chromosome is required')
    if any(not isinstance(request.get(k),int) or isinstance(request[k],bool) for k in ('start','end')):raise ValueError('Integer half-open region required')
    if request['start']<0 or request['end']<=request['start'] or request['end']-request['start']>options['compute'].maximum_region_bp:raise ValueError('Invalid region or maximum analysis span exceeded')
    if options['cross'].enabled and len(ids)<2:raise ValueError('XCR requires at least two datasets')
    explicit=request.get('explicit_parameters')
    if explicit is not None and (not isinstance(explicit,list) or len(explicit)>500 or not all(isinstance(x,str) and len(x)<=100 for x in explicit)):
        raise ValueError('explicit_parameters lists the "group.name" parameters the user set')
    recaller_preflight(state,ids,options)
    snapshot=_snapshot(state,ids);jobs,lock=_session(state)
    request={**request,'chemistry_overrides':{dsid:request.get('chemistry_overrides',{}).get(dsid)
        or dataset_consensus_chemistry(state.get_dataset(dsid)) for dsid in ids}}
    with lock:
        if any(j['status'] in ('queued','running','cancelling') for j in jobs.values()):raise ValueError('A consensus job is already running in this session; cancel it or wait')
        if getattr(options.get('cr'),'engine',None)==STAGED_MODE:
            # One session-scoped, content-addressed store survives cancelled and
            # partial jobs. A changed upstream dependency invalidates its own
            # downstream entries; no old scores are reused by geometry alone.
            compute=dict(request.get('parameters',{}).get('compute',{}))
            if compute.get('fit_cache_dir'):
                from services.lab.paths import confine
                confine(str(compute['fit_cache_dir']),write=True)  # a lab server: a writable data root
            if not compute.get('fit_cache_dir'):
                if not getattr(state,'consensus_family_cache_dir',None):
                    state.consensus_family_cache_dir=tempfile.mkdtemp(prefix='fiberbrowser-family-cache-')
                compute['fit_cache_dir']=state.consensus_family_cache_dir
                request={**request,'parameters':{**request.get('parameters',{}),'compute':compute}}
        job_id=uuid.uuid4().hex;out=Path(tempfile.mkdtemp(prefix='fiberbrowser-consensus-'))
        job=dict(job_id=job_id,status='queued',stage='queued',message='Waiting for consensus worker',created_at=time.time(),
            request=request,artifact_dir=str(out),_cancel=threading.Event(),_snapshot=snapshot,
            filters=schema()['display_defaults'])
        jobs[job_id]=job
    def worker():
        from services.background_work import configure_worker_threads
        configure_worker_threads()
        try:
            def progress(stage,message,**work):
                if job['_cancel'].is_set():raise workflow.ConsensusCancelled('Cancelled; previous successful layers retained')
                with lock:
                    job.setdefault('started_at',time.time())
                    # A solver's next callback must not undo Cancel requested.
                    if job['status']!='cancelling':job['status']='running'
                    update_progress(job,stage,message,**work)
            progress.report=progress
            progress('loading','Loading native observations')
            payload=(payload_loader or load_payload)(state,request,options,progress)
            skipped=payload.pop('browser_warnings',None)
            if skipped:
                with lock:job['warnings']=list(skipped)
            if not any(s['units'] for s in payload['strata']):
                raise ValueError('No eligible observations in the pinned region. Check chromosome, coordinates, MAPQ and datatype before running.')
            # A dataset with no reads in the region adds nothing but still
            # costs a full cross-dataset scoring pass; leave it out.
            empty=[st.get('dataset_id') for st in payload['strata'] if not st['units']]
            if empty and not payload.get('pooling'):
                payload['strata']=[st for st in payload['strata'] if st['units']]
                kept=[dsid for dsid in request['dataset_ids'] if dsid not in empty]
                params=dict(request.get('parameters') or {})
                if len(kept)<2 and (params.get('cross') or {}).get('enabled'):
                    params['cross']={**params['cross'],'enabled':False}
                with lock:
                    # Keep the source snapshot in step with the datasets used,
                    # or reactivating this job later reads as "inputs changed".
                    job['_snapshot']={k:v for k,v in job['_snapshot'].items() if k in kept}
                    job['request']={**job['request'],'dataset_ids':kept,'parameters':params,'skipped_datasets':empty}
                request.update(dataset_ids=kept,parameters=params)
                progress('loading',f"Skipping {', '.join(map(str,empty))}: no reads in this region")
            payload['browser_sources']=job['_snapshot']
            from fiberhmm.inference.consensus.artifacts import write_json
            progress('saving_input','Saving the complete native evidence snapshot')
            write_json(out/'evidence.json.gz',payload)
            result=(analysis_runner or workflow.run_analysis)(payload,request.get('parameters'),out,progress)
            if payload.get('pooling'):
                from services.oriented_regions import retain_provenance
                retain_provenance(result,payload)
                write_json(out/'result.json.gz',result)
                write_json(out/'manifest.json',result['manifest'])
            progress('finalizing','Building browser layer indexes; previous layers remain active')
            # Index construction can be large. Do it outside the session lock
            # so progress polls and cancellation remain responsive. Installation
            # and the source/cancellation checks below are still atomic.
            index,layers=_index(result)
            with lock:
                if job['_cancel'].is_set():raise workflow.ConsensusCancelled('Cancelled before layer installation')
                if not _same_sources(job['_snapshot'],_snapshot(state,job['request']['dataset_ids'])):raise ValueError('Input datasets changed during inference; result retained on disk but not installed')
                job['result']=result;job['index'],job['layers']=index,layers
                if _cr_mode(result)==STAGED_MODE:
                    job['filters']['classification_reference_percent']=result['manifest']['parameters']['families'].get('assignment_reference_percent',99.9)
                _register(state,job)
                state.consensus_workflow_active=job_id
                job.update(status='complete',stage='complete',message='Frozen consensus layers installed',finished_at=time.time())
                finish_progress(job)
        except workflow.ConsensusCancelled as exc:
            with lock:job.update(status='cancelled',message=str(exc),finished_at=time.time())
        except Exception as exc:
            import traceback
            traceback.print_exc()
            with lock:job.update(status='error',message=str(exc),error_type=type(exc).__name__,finished_at=time.time())
    import contextvars
    job['_future']=_EXECUTOR.submit(contextvars.copy_context().run, worker)
    return _summary(job)


def dispose_session(state,keep_fit_cache=False,keep_job_ids=()):
    """A dropped (expired) session: cancel its runs and delete the directories
    FiberBrowser made for them (job artifacts, the session fit cache) once its
    workers have stopped. A fit cache the user chose is never touched.

    keep_fit_cache: the session lives on (a session import replaces its
    datasets): its runs and overlays go, the content-addressed fit cache stays.
    keep_job_ids: completed runs the imported session restores (its saved classes
    refer to them): kept as they are, artifacts included, never deleted first."""
    if 'consensus_workflow_jobs' not in state.__dict__:return
    jobs,lock=_session(state)
    with lock:
        keep={j for j in keep_job_ids if jobs.get(j,{}).get('status')=='complete'}
        dropped=[j for k,j in jobs.items() if k not in keep]
        dirs=[j.get('artifact_dir') for j in dropped if j.get('artifact_dir')]
        futures=[j.get('_future') for j in dropped if j.get('_future') is not None]
        for j in dropped:
            if j.get('_cancel') is not None:j['_cancel'].set()
        if not keep_fit_cache:
            cache=state.__dict__.get('consensus_family_cache_dir')
            if cache:dirs.append(cache)
            state.consensus_family_cache_dir=None
        for k in [k for k in jobs if k not in keep]:jobs.pop(k)
        state.consensus_workflow_active=None
    def cleanup():
        import shutil
        for fut in futures:
            try:fut.result(timeout=3600)
            except Exception:pass
        for d in dirs:shutil.rmtree(d,ignore_errors=True)
    threading.Thread(target=cleanup,name='consensus-session-cleanup',daemon=True).start()


def get_job(state,job_id):
    jobs,lock=_session(state)
    with lock:
        if job_id not in jobs:raise KeyError(job_id)
        return _summary(jobs[job_id])


def export_with_curation(state,job_id):
    from services.consensus_curation import export_history
    from fiberhmm.inference.consensus.artifacts import write_json
    jobs,lock=_session(state)
    with lock:
        job=jobs[job_id]
        if job['status']!='complete':raise ValueError('Completed result required')
        # The original result file and automatic model records stay untouched.
        # browser_job_id: importing the file (e.g. after a restart) restores the run under the id its saved classes
        # refer to; browser_scored_units: each recaller class's exact scoring population (co-occupancy eligibility).
        from services.consensus_occupancy import recaller_scored_units
        scored=({ds:{c:sorted(u) for c,u in (recaller_scored_units(job,ds) or {}).items()} for ds in job['result']['datasets']}
                if _cr_mode(job['result'])==RECALLER_MODE else None)
        result=dict(assignment_export_result(job),manual_curation=export_history(job),browser_job_id=job_id,
                    **({'browser_scored_units':scored} if scored is not None else {}))
        path=Path(job['artifact_dir'])/'result_with_curation.json.gz'
        write_json(path,result)
        return path


def get_native_call(state,job_id,dataset_id,source_call_id):
    """On-demand full frozen ledger for exactly one original native call."""
    from copy import deepcopy
    from fiberhmm.inference.consensus.native_presentation import classify_proposal
    jobs,lock=_session(state)
    with lock:
        job=jobs[job_id]
        if job.get('status')!='complete':raise ValueError('Only completed results have a frozen call ledger')
        mode=_cr_mode(job['result'])
        if mode not in (NATIVE_CR_MODE,HARMONIZATION_MODE,*STAGED_LIKE):raise ValueError('Full native call lookup requires native-call mode')
        dataset=viewed_result(job)['datasets'][dataset_id]
        lookup=job.setdefault('_native_call_lookup',{})
        if dataset_id not in lookup:
            lookup[dataset_id]={p['source_call_id']:(row,p) for row in dataset.get('cr',{}).get('records',[])
                                for p in row['proposals']}
        row,proposal=lookup[dataset_id][source_call_id]
        reference=job['filters'].get('classification_reference_percent',99.9)
        call=deepcopy(proposal if mode in (HARMONIZATION_MODE,*STAGED_LIKE) else classify_proposal(proposal,reference))
        if mode==STAGED_MODE and job['result'].get('evidence_encoding')=='shared_json_v1':
            from fiberhmm.inference.consensus.harmonized_families.evidence import expand
            call['family_evidence']=expand(call.get('family_evidence'),job['result']['evidence_pool'])
        call.update(unit_id=row['unit_id'],strand=row.get('strand'),native_cross_tests=[])
        for edge in job['result'].get('cross',{}).get('edges',[]):
            for score in edge.get('call_evidence',{}).get(dataset_id,[]):
                key=score.get('source_call_id') or f"{dataset_id}:{score['unit_id']}:{score['source_ordinal']}"
                if key==source_call_id:
                    call['native_cross_tests'].append(dict(link_id=edge.get('link_id'),
                        recipient_evidence=deepcopy(score),families=deepcopy(edge.get('families',{})),
                        native_intervals=deepcopy(edge.get('native_intervals',{})),
                        link_status=edge.get('status'),comparable=edge.get('comparable'),calibrated=False))
        return dict(job_id=job_id,dataset_id=dataset_id,source_call_id=source_call_id,call=call,
                    classification_reference_percent=reference,frozen_family=proposal.get('family'))


RECALLER_EDGES=('native','lattice','class')
RECALLER_TIERS=('core','edge','loose')   # strict members; clean core lined up with a class edge; clean core under other protection


def tier_parts(spec):
    parts=[t for t in str(spec or '').split('+') if t in RECALLER_TIERS]
    return parts or ['core']


def recaller_tier(job,family,tier=None):
    """What counts as a class ('core', 'core+edge', ...): the spec given (a saved class), else the one chosen for it
    in the run, else strict."""
    return '+'.join(tier_parts(tier or job.get('filters',{}).get('recaller_class_tiers',{}).get(family)))


def saved_tier(group):
    """What a saved Cart class counts. A saved definition is fixed when it is saved: a missing tier (a strict save,
    or one from before tiers were stored) is strict, never the run's current display tier."""
    return '+'.join(tier_parts((group or {}).get('consensusTier') or 'core'))


def within_tier(record,spec):
    return (record.get('tier') or 'core') in tier_parts(spec)


def membership_records(index,unit_id,family,job,tier=None):
    """The records that decide whether a unit is a member of a class: the recaller's own calls up to the class's tier
    when the run has them (its counts, whether or not the native caller called the footprint), else the labelled
    native calls."""
    layers=index.get('per_unit',{}).get(unit_id,{})
    if 'tf_rc' in index.get('layers',[]) and not str(family).startswith('manual:'):
        t=recaller_tier(job,family,tier)
        return [r for r in layers.get('tf_rc',()) if r.get('kind')=='recaller_class' and within_tier(r,t)],False
    return [r for r in layers.get('tf_cr',()) if _visible(r,job['filters'],str(r.get('strand','')))],True


def unit_strands(job,dataset_id):
    """Unit id -> its channel strand ('CT'/'GA' for DAF; Hia5 its alignment orientation), cached on the job."""
    cache=job.setdefault('_unit_strands',{})
    if dataset_id not in cache:
        cache[dataset_id]={u['unit_id']:str(u.get('strand','')) for u in job['result']['datasets'].get(dataset_id,{}).get('units',[])}
    return cache[dataset_id]


def state_read_ids(state,job_id,dataset_id,family_id,stage=None,strand=None,tier=None):
    """Return molecular read names whose primary display assignment is a state.

    This powers Cart filtering for automatic and manually curated consensus
    states. Compatible alternatives are deliberately not matches: the same
    single best-fit label that colors a footprint defines the filter.
    ``stage``: the stage the state was found in (a saved class); default the
    viewed one. Manual classes belong to the final stage. ``strand``: restrict
    to molecules of one DAF strand (a class saved for CT or GA only).
    """
    from services.consensus_curation import curated_records_for_unit
    jobs,lock=_session(state)
    with lock:
        job=jobs[job_id]
        if job.get('status')!='complete':raise ValueError('Only completed results can filter reads by state')
        manual=str(family_id).startswith('manual:')
        stage_used=job['result'].get('final_stage') if manual else stage
        index=stage_index(job,dataset_id,stage_used)
        if index is None:raise ValueError('Selected state does not belong to this dataset')
        # The final stage's membership is its curated one, as displayed: an
        # automatic class ignored by curation matches nothing there, and one it
        # promotes matches.
        curated=manual or membership_is_curated(job,stage_used)
        matching_units=set()
        strands=unit_strands(job,dataset_id) if strand else None
        for unit_id,layers in index.get('per_unit',{}).items():
            if strands is not None and strands.get(unit_id)!=strand:continue
            automatic,native=membership_records(index,unit_id,family_id,job,tier)
            records=curated_records_for_unit(job,dataset_id,unit_id,automatic) if curated and native else automatic
            # The primary label: a manual group's id is the record's family (a
            # call in several restored subclasses has no single manual_group_id).
            # Ignored and unresolved records match nothing (as in co-occupancy).
            if any((record.get('manual_group_id') or record.get('family'))==family_id
                   for record in records
                   if not record.get('manual_ignored')
                   and record.get('classification_status') not in ('manual_ignored','provisional_unresolved')):
                matching_units.add(str(unit_id))
        # Filtering is by read name: a name whose alignments (the same QNAME in
        # two merged BAMs) disagree would keep the non-member too, so it is
        # left out and reported as ambiguous (as the lattice does).
        read_ids,ambiguous=[],[]
        for name,unit_ids in sorted(index.get('by_name',{}).items()):
            hits={str(u) in matching_units for u in unit_ids}
            if hits=={True}:read_ids.append(name)
            elif len(hits)>1:ambiguous.append(name)
        return dict(job_id=job_id,dataset_id=dataset_id,family_id=family_id,
                    read_ids=read_ids,ambiguous_read_ids=ambiguous,matching_units=len(matching_units),
                    semantics='Primary best-fit display assignment; compatible alternatives excluded')


def list_jobs(state):
    jobs,lock=_session(state)
    with lock:return dict(active_job=state.consensus_workflow_active,jobs=[_summary(v) for v in jobs.values()])


def cancel(state,job_id):
    jobs,lock=_session(state)
    with lock:
        job=jobs[job_id]
        if job['status'] in ('running','queued','cancelling'):
            job['_cancel'].set();job['status']='cancelling';job['message']='Cancelling at the next safe evidence/optimizer checkpoint'
            job['updated_at']=time.time()
        return _summary(job)


def activate(state,job_id):
    jobs,lock=_session(state)
    with lock:
        job=jobs[job_id]
        if job['status']!='complete':raise ValueError('Only completed runs can be activated')
        if not _same_sources(job['_snapshot'],_snapshot(state,job['request']['dataset_ids'])):
            raise ValueError('The loaded input files changed; rerun instead of attaching stale assignments')
        _register(state,job)
        state.consensus_workflow_active=job_id
        return _summary(job)


def _expanded_import_bytes(raw, *, maximum_expanded_import_bytes=512*1024**2):
    """Bound decompression before JSON allocation; larger budgets are local-only.

    The HTTP route uses the unchanged default. A trusted local launcher may
    explicitly allocate a larger expanded-byte budget, not a larger compressed
    upload budget. The extra byte detects over-budget input without unbounded
    decompression.
    """
    import gzip
    import io
    if (isinstance(maximum_expanded_import_bytes,bool)
            or not isinstance(maximum_expanded_import_bytes,int)
            or maximum_expanded_import_bytes<=0):
        raise ValueError('Maximum expanded import bytes must be a positive integer')
    if len(raw)>128*1024**2:raise ValueError('Compressed artifact exceeds 128 MiB')
    if raw.startswith(b'\x1f\x8b'):
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as handle:raw=handle.read(maximum_expanded_import_bytes+1)
    if len(raw)>maximum_expanded_import_bytes:
        raise ValueError(f'Expanded artifact exceeds {maximum_expanded_import_bytes} bytes')
    return raw


def _install_result(state,result,snapshot,*,job_id=None,message='Imported frozen consensus layers installed',
                    curation=None,filters=None,scored_units=None,activate=True,region_meta=None):
    """Install a completed frozen result as a job of this session: validated before anything changes, written to its
    own artifact directory, optionally made the active run. ``job_id`` keeps a run's identity (a restored session's
    saved classes refer to it); ``curation``, ``filters`` and ``scored_units`` restore what the run had."""
    manifest=result.get('manifest',{})
    ids=source_ids(result)
    _,parameters=_runtime();parameters.parse_options(manifest['parameters'])
    index,layers=_index(result)  # Validate structure before touching session layers.
    region=manifest['region'];jobs,lock=_session(state)
    windows=request_windows(result,state)
    from fiberhmm.inference.consensus.artifacts import write_json
    with lock:
        if any(j['status'] in ('queued','running','cancelling') for j in jobs.values()):
            raise ValueError('Wait for or cancel the current run before importing')
        job_id=job_id or uuid.uuid4().hex
        if job_id in jobs:raise ValueError('A run with this identity is already open')
        out=Path(tempfile.mkdtemp(prefix='fiberbrowser-consensus-import-'))
        try:
            write_json(out/'result.json.gz',result);write_json(out/'manifest.json',manifest)
            defaults=schema()['display_defaults']
            job=dict(job_id=job_id,status='complete',stage='complete',message=message,
                created_at=time.time(),finished_at=time.time(),artifact_dir=str(out),result=result,index=index,layers=layers,
                _snapshot=snapshot,filters=dict(defaults,**{k:v for k,v in (filters or {}).items() if k in defaults}),
                request=dict(dataset_ids=ids,chemistry_overrides={manifest.get('region_datasets',{}).get(s['dataset_id'],s['dataset_id']):s['chemistry'] for s in manifest['datasets']},
                    **region,parameters=manifest['parameters'],**{**_region_meta(region_meta),
                    **({'region_windows':windows,'region_source':'matched'} if windows else {})}))
            if _cr_mode(result)==STAGED_MODE and not (filters or {}).get('classification_reference_percent'):
                # The assignments were projected at this reference; the controls say so.
                job['filters']['classification_reference_percent']=manifest['parameters'].get('families',{}).get('assignment_reference_percent',99.9)
            if scored_units is not None:
                job['_scored_units']={ds:{c:set(u) for c,u in classes.items()} for ds,classes in scored_units.items()}
            if curation is not None:
                from services.consensus_curation import restore_history
                restore_history(job,curation)
            jobs[job_id]=job
            if activate:_register(state,job)
        except BaseException:
            # A rejected import (bad curation, catalog mismatch, ...) leaves no
            # unregistered artifact directory that session cleanup can't reach.
            jobs.pop(job_id,None)
            import shutil
            shutil.rmtree(out,ignore_errors=True)
            raise
        if activate:state.consensus_workflow_active=job_id
        return _summary(job)


def _region_meta(value):
    """Where a run's region came from, as the panel recorded it (region_source / region_label: 'peaks', 'the
    selected peak', ...): kept with a run saved in a session so its results still say what was analysed."""
    if not isinstance(value,dict):return {}
    return {k:value[k][:200] for k in ('region_source','region_label') if isinstance(value.get(k),str) and value[k]}


def _remap_dataset_ids(value,mapping,key=''):
    """A result's dataset ids renamed (a FiberHMM CLI run's dataset_1, ... to the open datasets holding its BAMs):
    map keys, dataset-id fields, 'dataset::unit' / 'dataset::strand' prefixes and 'browser:dataset:' library ids, as
    a Browser run of those datasets would have written them."""
    if isinstance(value,dict):
        return {mapping.get(k,k) if isinstance(k,str) else k:_remap_dataset_ids(v,mapping,str(k)) for k,v in value.items()}
    if isinstance(value,list):
        return [_remap_dataset_ids(v,mapping,key) for v in value]
    if isinstance(value,str):
        if value in mapping and 'dataset' in key:return mapping[value]
        for old,new in mapping.items():
            if value.startswith(old+'::'):return new+value[len(old):]
            if value.startswith('browser:'+old+':'):return 'browser:'+new+value[len('browser:'+old):]
    return value


def _match_cli_sources(state,result):
    """For a FiberHMM CLI (or fiberhmm-transfer) result, which records its input BAMs but no Browser sources: the
    open dataset holding exactly each result dataset's BAMs (same resolved paths, sizes and modification times)."""
    manifest=result.get('manifest',{})
    from services.oriented_regions import validate_result
    validate_result(result)
    files=manifest.get('input_files') or []
    if not files:
        raise ValueError('Open the same source datasets before importing this Browser result. Source paths, IDs, sizes, and timestamps must match. '
                         '(This result records neither Browser sources nor its input BAMs.)')
    wanted=defaultdict(set)
    for row in files:
        wanted[row['dataset_id']].add((str(Path(row['path']).expanduser().resolve()),int(row['size']),int(row['mtime_ns'])))
    open_sets={}
    for dsid in getattr(state,'dataset_order',None) or list(getattr(state,'datasets',{})):
        ds=state.get_dataset(dsid)
        if ds is None or getattr(ds,'data_type','bam')!='bam':continue
        paths=getattr(ds,'paths',None) or [ds.path]
        paths=[paths] if isinstance(paths,str) else paths
        entries=set()
        for p in paths:
            q=Path(p).expanduser().resolve()
            if not q.is_file():break
            st=q.stat();entries.add((str(q),st.st_size,st.st_mtime_ns))
        else:open_sets[dsid]=entries
    mapping={}
    for old,entries in wanted.items():
        hits=[dsid for dsid,have in open_sets.items() if have==entries]
        if len(hits)!=1:
            names=', '.join(sorted(Path(p).name for p,_,_ in entries))
            raise ValueError(f'Open the BAM file(s) this result was made from as one dataset before importing ({old}: {names}); '
                             'paths, sizes and modification times must match.' if not hits else
                             f'Several open datasets hold the BAMs of {old}; keep one open.')
        mapping[old]=hits[0]
    if set(mapping)!=set(result.get('datasets',{})):
        raise ValueError('The result\'s datasets and its recorded input BAMs disagree')
    return mapping


def import_result(state,raw, *, maximum_expanded_import_bytes=512*1024**2):
    """Restore frozen records with a bounded, explicit trusted-local budget.

    Normal HTTP imports retain the 512 MiB default and 128 MiB compressed cap.
    Source-fingerprint, schema and completed-result validation are unchanged.
    Results from the FiberHMM command line (fiberhmm-consensus, fiberhmm-transfer)
    record their input BAMs instead of Browser sources: they are matched to the
    open datasets holding exactly those BAMs, and renamed to those datasets.
    """
    raw=_expanded_import_bytes(raw,maximum_expanded_import_bytes=maximum_expanded_import_bytes)
    def invalid_constant(value):raise ValueError(f'Nonfinite JSON value {value}')
    result=json.loads(raw,parse_constant=invalid_constant)
    if not isinstance(result,dict) or result.get('schema')!='fiberhmm.consensus.v1':
        raise ValueError('Not a supported frozen consensus result')
    manifest=result.get('manifest',{})
    if manifest.get('status')!='complete':raise ValueError('Incomplete results cannot be installed')
    message='Imported frozen consensus layers installed'
    if not manifest.get('browser_sources'):
        mapping=_match_cli_sources(state,result)
        if manifest.get('pooling') or manifest.get('region',{}).get('chrom')=='oriented_BED':
            manifest['region_datasets']=mapping
        elif any(k!=v for k,v in mapping.items()):result=_remap_dataset_ids(result,mapping)
        manifest=result['manifest']
        manifest['browser_sources']=_snapshot(state,source_ids(result))
        catalog=str((result.get('transfer') or {}).get('catalog_sha256') or '')[:12]
        message=(f'Imported fiberhmm-transfer result installed (frozen classes, catalog {catalog or "unrecorded"})'
                 if result.get('transfer') else 'Imported FiberHMM command-line result installed')
    ids=source_ids(result);snapshot=manifest.get('browser_sources')
    if not ids or not snapshot or not _same_sources(snapshot,_snapshot(state,ids)):
        raise ValueError('Open the same source datasets before importing this Browser result. Source paths, IDs, sizes, and timestamps must match.')
    # A Browser download keeps its run's identity when that id is free here, so saved classes made from the run
    # (restored from a session or Rules JSON) resolve again after a restart.
    job_id=result.get('browser_job_id')
    jobs,_=_session(state)
    import re
    if not (isinstance(job_id,str) and re.fullmatch(r'[A-Za-z0-9_-]{8,64}',job_id) and job_id not in jobs):job_id=None
    scored=result.get('browser_scored_units')
    if not (isinstance(scored,dict) and all(isinstance(c,dict) and all(isinstance(u,list) for u in c.values()) for c in scored.values())):
        scored=None
    return _install_result(state,result,snapshot,job_id=job_id,message=message,curation=result.get('manual_curation'),
                           scored_units=scored)


SESSION_RUNS_SCHEMA='fiberbrowser.session_consensus_runs.v1'


def export_session_runs(state,frontend):
    """The completed runs a saved session needs, frozen into it: every run a Cart entry (a saved class) refers to,
    plus the active run. Each keeps its identity (job id), its displayed assignments and manual curation, its display
    filters and, for lattice recaller runs, each class's scoring population. None when there is nothing to keep."""
    import base64
    import gzip
    if 'consensus_workflow_jobs' not in state.__dict__:return None
    groups=(frontend or {}).get('footprintGroups') or []
    wanted=[str(g['consensusJobId']) for g in groups if isinstance(g,dict) and g.get('consensusJobId')]
    jobs,lock=_session(state)
    from services.consensus_curation import export_history
    from services.consensus_occupancy import recaller_scored_units
    with lock:
        active=state.consensus_workflow_active
        runs=[]
        for job_id in dict.fromkeys([*wanted,*([active] if active else [])]):
            job=jobs.get(job_id)
            if not job or job.get('status')!='complete':continue
            curation=job.get('_curation') or {}
            try:
                scored=None
                if _cr_mode(job['result'])==RECALLER_MODE:
                    scored={ds:{c:sorted(u) for c,u in (recaller_scored_units(job,ds) or {}).items()} for ds in job['result']['datasets']}
                payload=dict(result=assignment_export_result(job),
                    manual_curation=export_history(job) if curation.get('history') else None,
                    filters=job.get('filters'),scored_units=scored,message=job.get('message'),
                    region=_region_meta(job.get('request')) or None)
                blob=gzip.compress(json.dumps(payload,separators=(',',':')).encode(),compresslevel=6)
            except Exception:
                # Saving the rest of the session must not fail on one run; its saved classes then show it unavailable.
                import traceback
                traceback.print_exc()
                continue
            runs.append(dict(job_id=job_id,sources=job.get('_snapshot'),payload_gz_b64=base64.b64encode(blob).decode('ascii')))
    if not runs:return None
    return dict(schema=SESSION_RUNS_SCHEMA,active_job=active if any(r['job_id']==active for r in runs) else None,runs=runs)


def session_run_ids(session):
    """Job ids of the completed runs a session carries (the runs to keep while it is imported)."""
    block=(session or {}).get('consensus_runs')
    if not isinstance(block,dict) or block.get('schema')!=SESSION_RUNS_SCHEMA:return set()
    return {str(r.get('job_id')) for r in block.get('runs') or [] if isinstance(r,dict) and r.get('job_id')}


def _same_session_sources(saved,current):
    """A restored session's files are the ones the run read: same datasets and paths (after any relinking) and
    sizes. Modification times may differ for relinked copies, which the session's file fingerprints check."""
    strip=lambda rows:{k:dict(paths=row.get('paths'),files=[f[:2] for f in row.get('files',[])]) for k,row in (rows or {}).items()}
    return bool(saved) and strip(saved)==strip(current)


def restore_session_runs(state,session):
    """After a session's datasets are open again: bring back the runs it carries under their own ids (so its saved
    classes resolve), and make its active run active. A run still open in this server (the same session saved and
    reopened) is kept as it is. Returns (restored ids, [problems])."""
    import base64
    import gzip
    block=(session or {}).get('consensus_runs')
    if not isinstance(block,dict) or block.get('schema')!=SESSION_RUNS_SCHEMA:return [],[]
    jobs,lock=_session(state)
    restored,problems=[],[]
    for run in block.get('runs') or []:
        job_id=str((run or {}).get('job_id') or '')
        if not job_id:continue
        with lock:
            present=jobs.get(job_id,{}).get('status')=='complete'
        if present:
            restored.append(job_id);continue
        try:
            payload=json.loads(gzip.decompress(base64.b64decode(run['payload_gz_b64'])))
            result=payload['result']
            ids=source_ids(result)
            current=_snapshot(state,ids)
            if not _same_session_sources(run.get('sources'),current):
                raise ValueError('its source files changed or are not open')
            _install_result(state,result,current,job_id=job_id,activate=False,
                message=payload.get('message') or 'Restored with the session',curation=payload.get('manual_curation'),
                filters=payload.get('filters'),scored_units=payload.get('scored_units'),region_meta=payload.get('region'))
            restored.append(job_id)
        except Exception as error:
            problems.append(f'Footprint class run {job_id[:8]}: {error}')
    active=block.get('active_job')
    if active in restored:
        with lock:
            job=jobs.get(active)
            if job is not None:
                _register(state,job);state.consensus_workflow_active=active
    return restored,problems


def set_filters(state,job_id,filters):
    jobs,lock=_session(state); defaults=schema()['display_defaults']
    if set(filters)-set(defaults):raise ValueError('Unknown display filter')
    for name,value in filters.items():
        if name=='recaller_edges':
            if value not in RECALLER_EDGES:raise ValueError(f'recaller_edges must be one of {", ".join(RECALLER_EDGES)}')
            continue
        if name=='recaller_class_tiers':
            if not isinstance(value,dict) or any(not isinstance(k,str) or not isinstance(v,str) or not v
                                                 or any(t not in RECALLER_TIERS for t in v.split('+')) for k,v in value.items()):
                raise ValueError(f'recaller_class_tiers maps class ids to categories joined by + ({", ".join(RECALLER_TIERS)})')
            continue
        if name=='classification_reference_percent':
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 50<=value<=99.999:
                raise ValueError('Classification reference must be between 50 and 99.999 percent')
            continue
        if isinstance(defaults[name],bool):
            if not isinstance(value,bool):raise ValueError('Boolean display switch required')
        elif isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<=value<=120:
            raise ValueError('Display model Q must be between 0 and 120')
    with lock:
        job=jobs[job_id]
        if job['status']!='complete':raise ValueError('Only completed frozen results can be filtered')
        if _cr_mode(job['result'])==STAGED_MODE and 'classification_reference_percent' in filters:
            reference=filters['classification_reference_percent']
            if reference!=job['filters'].get('classification_reference_percent',99.9):
                stage=job.get('view_stage',job['result']['final_stage'])
                inspecting=stage!=job['result']['final_stage']
                # Looking at an earlier stage leaves the final stage's manual edits alone.
                projected=_staged_assignment_view(job,reference,stage,inspect_only=inspecting)
                index,layers=_index(dict(job['result'],**projected))
                job.setdefault('_assignment_views',{})[stage]=projected
                job.setdefault('_assignment_view_refs',{})[stage]=reference
                job.pop('_stage_indexes',None)
                job.update(index=index,layers=layers)
                job.pop('_native_call_lookup',None)
                if not inspecting:job.pop('_curation',None)
        if (_cr_mode(job['result'])==NATIVE_CR_MODE and 'classification_reference_percent' in filters
                and filters['classification_reference_percent']!=job['filters'].get('classification_reference_percent',99.9)):
            # Pure projection of an already frozen candidate ledger. No source,
            # native model, family catalog, or curation membership is updated.
            index,layers=_index(job['result'],classification_reference_percent=filters['classification_reference_percent'])
            job['index']=index;job['layers']=layers
        job['filters'].update(filters)
        return _summary(job)


def _register(state,job):
    # Registration is independent of Cart contents and of nonempty assignments.
    for ds in getattr(state,'datasets',{}).values():
        for layer,metadata in list(ds.derived_layers.items()):
            if metadata.get('kind')=='consensus-workflow':
                ds.derived_layers.pop(layer,None);ds.available_layers.pop(layer,None)
    for dsid in job['index']:
        ds=state.get_dataset(dsid)
        if ds is None:continue  # closed since the run; its layers come back if it's reloaded
        layers=job['index'][dsid].get('layers',job['layers'])
        for layer in layers:
            # Recaller runs: the recaller's calls are the class layer; the native-labelled one would duplicate it.
            if layer=='tf_cr' and 'tf_rc' in layers:continue
            label,color=LAYER_LABELS[layer]
            ds.available_layers[layer]=True
            ds.derived_layers[layer]=dict(id=layer,label=label,color=color,kind='consensus-workflow',
                source_layer='nuc' if layer in ('nuc_cr_split','cr_split_gap') else 'tf',
                frozen=layer!='tf_cr_manual',manual=layer=='tf_cr_manual',
                cr_mode=_cr_mode(job['result']),consensus_job_id=job['job_id'])


def active(state,dataset_id,chrom,start,end):
    job_id=getattr(state,'consensus_workflow_active',None)
    if not job_id:return False
    jobs,lock=_session(state)
    with lock:
        job=jobs.get(job_id)
        if not job or job['status']!='complete' or dataset_id not in job['index']:return False
        from services.oriented_regions import display_regions
        regions=display_regions(job['result'],dataset_id,chrom)
        return any(r['end']>start and r['start']<end for r in regions)


def source_layers(requested):
    """Virtual layers have no producer file; retain their native backing layers."""
    if not requested:return requested
    return tuple(sorted((set(requested)-set(LAYER_LABELS))|{'tf','nuc','msp'}))


def _projection_identity(record, *, chemical_strand=None):
    """Explicit record identity only; never infer a mate from marks or geometry.

    Compact BAM rows historically carry QNAME alone. Optional richer identity
    fields can disambiguate them, but clipped display intervals are NOT an
    alignment fingerprint. Hia5 mapping orientation is useful for identity,
    never a substitute for a biochemical CT/GA stratum.
    """
    identity = {}
    for name in ('library_id', 'source_path', 'record_sha256',
                 'alignment_occurrence', 'reference_start', 'reference_end'):
        value = record.get(name)
        if value is not None and value != '':
            identity[name] = value
    strand = str(record.get('chemical_strand') or record.get('daf_strand')
                 or record.get('strand') or '').upper()
    if strand in ('CT', 'GA'):
        identity['chemical_strand'] = strand
    elif chemical_strand in ('CT', 'GA'):
        identity['chemical_strand'] = chemical_strand
    orientation = record.get('alignment_orientation')
    if orientation is None and str(record.get('strand', '')) in ('+', '-'):
        orientation = record['strand']
    orientation = {'+': 'forward', '-': 'reverse', 'forward': 'forward',
                   'reverse': 'reverse'}.get(str(orientation).lower())
    if orientation is not None:
        identity['alignment_orientation'] = orientation
    return identity


def _unit_projection_members(unit):
    """Keep each alias's own identity, not the representative's alignment."""
    chemical = str(unit.get('strand', '')).upper()
    members = [m for m in unit.get('source_members', []) if m.get('read_name')]
    # Current artifacts include the representative among source_members. Do
    # not also add a weaker QNAME-only alias that could defeat a mismatch.
    if not any(str(m['read_name']) == str(unit['read_name']) for m in members):
        members = [unit, *members]
    return [(str(m['read_name']), _projection_identity(m, chemical_strand=chemical))
            for m in members]


def _match_projection_unit(index, read, chrom=None):
    """Return at most one compatible evidence unit, or fail closed.

    Missing fields remain unknown rather than evidence against a candidate.
    Thus one fully specified match cannot hide another compatible candidate
    whose source identity was not retained in an older artifact.
    """
    name = str(read.get('_original_id', read.get('id', '')))
    candidates = index['by_name'].get(name, ())
    if not candidates:
        return None, 'not_in_catalog', 0
    identity = _projection_identity(read)
    matches = set()
    for member in index['projection_members'].get(name, ()):
        if chrom is not None and member.get('chrom') and normalize_chrom_name(member['chrom'])!=normalize_chrom_name(chrom):continue
        source = member['identity']
        if all(source[key] == value for key, value in identity.items() if key in source):
            matches.add(member['unit_id'])
    if len(matches) == 1:
        return next(iter(matches)), 'matched', len(candidates)
    return None, 'ambiguous_identity' if matches else 'identity_mismatch', len(candidates)


def _index(result,classification_reference_percent=None):
    if _cr_mode(result)==NATIVE_CR_MODE:
        indexes,layers=_native_index(result,classification_reference_percent)
        from services.oriented_regions import project_indexes
        return project_indexes(result,indexes),layers
    indexes,layers=_legacy_index(result)
    # Registration is independent of whether any manual groups exist yet.
    for index in indexes.values():
        if 'tf_cr' in index['layers']:
            index['layers']=sorted(set(index['layers'])|{'tf_cr_manual'})
            layers=sorted(set(layers)|{'tf_cr_manual'})
    from services.oriented_regions import project_indexes
    return project_indexes(result,indexes),layers


def _native_call_link(edge,dataset_id,score,source_call_id):
    """Small per-call link; population summaries/geometry are catalog-only."""
    receiving={key:score[key] for key in ('status','predictive_tail','predictive_tail_interval',
        'native_loss','floor_adjusted_loss','physical_geometry_retention','observed_opportunities',
        'mean_core_opportunities','mean_core_native_log_lr') if key in score}
    if 'floor_zeroed_loss' in score:
        receiving['floor_zeroed_loss']=score['floor_zeroed_loss']
    elif 'tolerance_only_compatibility' in score:
        # Historical name overclaimed an unperformed no-floor ablation.
        receiving['floor_zeroed_loss']=score['tolerance_only_compatibility']
    return dict(link_id=edge.get('link_id'),source_call_id=source_call_id,
        receiving_family=edge['families'][dataset_id],
        other_families={ds:f for ds,f in edge['families'].items() if ds!=dataset_id},
        comparable=edge.get('comparable',False),recipient_evidence=receiving)


def _native_index(result,classification_reference_percent=None):
    from fiberhmm.inference.consensus.native_presentation import reclassify_records,classification_counts
    indexes={};all_layers=set()
    edges=result.get('cross',{}).get('edges',[])
    for dsid,ds in result['datasets'].items():
        per_unit=defaultdict(lambda:defaultdict(list));by_name=defaultdict(list)
        projection_members=defaultdict(list);layers={'tf_native_replay'}
        for unit in ds['units']:
            for name,identity in _unit_projection_members(unit):
                if unit['unit_id'] not in by_name[name]:by_name[name].append(unit['unit_id'])
                member=dict(unit_id=unit['unit_id'],identity=identity)
                if member not in projection_members[name]:projection_members[name].append(member)
            replay=result.get('manifest',{}).get('parameters',{}).get('input',{}).get('correct_native',True)
            for interval in unit['native_intervals']:
                per_unit[unit['unit_id']]['tf_native_replay'].append(dict(interval=interval,
                    kind='native_msp_replay' if replay else 'native_source_calls'))
        if ds.get('sr',{}).get('status')=='complete':
            layers.add('tf_sr_lattice')
            for row in ds['sr']['records']:
                for call in row['calls']:
                    per_unit[row['unit_id']]['tf_sr_lattice'].append(dict(interval=call['interval'],
                        source_intervals=[call['raw']],kind=call['action'],sr_decision=call))
        cr=ds.get('cr',{})
        reference=classification_reference_percent if classification_reference_percent is not None else cr.get('reference_percent',99.9)
        call_map={};projected=[]
        if cr.get('status') in ('complete','empty'):
            layers.update(('tf_cr','tf_cr_manual'))
            projected=reclassify_records(cr,reference)
            for row in projected:
                for call in row['proposals']:
                    record=dict(call,kind='cr',strand=row['strand'],cr_mode=NATIVE_CR_MODE,
                        unclassified=call.get('classification_status')=='provisional_unresolved',
                        native_cross_tests=[])
                    record.pop('candidate_evidence',None)
                    record['full_candidate_evidence_on_demand']=True
                    if record['unclassified']:record['display_color']='#94a3b8'
                    key=call['source_call_id']
                    if key in call_map:raise ValueError('Duplicate native source_call_id in the frozen record ledger')
                    call_map[key]=(row['unit_id'],record)
                    per_unit[row['unit_id']]['tf_cr'].append(record)
        cross_errors=[]
        for edge in edges:
            if dsid not in edge.get('families',{}):continue
            for score in edge.get('call_evidence',{}).get(dsid,[]):
                key=score.get('source_call_id') or f"{dsid}:{score['unit_id']}:{score['source_ordinal']}"
                item=call_map.get(key)
                if item is None or item[0]!=score['unit_id'] or item[1]['interval']!=score['interval']:
                    cross_errors.append(dict(link_id=edge.get('link_id'),source_call_id=key,
                        reason='Cross test does not exactly identify one frozen original call'))
                    continue
                item[1]['native_cross_tests'].append(_native_call_link(edge,dsid,score,key))
        for uid,record in call_map.values():
            tests=record.pop('native_cross_tests')
            accepted=[test for test in tests
                if test['recipient_evidence'].get('status')=='scored'
                and test['recipient_evidence'].get('predictive_tail_interval',[0.,0.])[1]>=1-reference/100.]
            record['cross_test_summary']=dict(tested_links=len(tests),compatible_links=len(accepted),
                statuses=dict(Counter(test['recipient_evidence'].get('status') for test in tests)))
            record['full_cross_evidence_on_demand']=bool(tests)
            if accepted:
                per_unit[uid]['tf_xcr'].append(dict(record,kind='xcr',links=accepted,
                    cross_comparable=any(test.get('comparable',False) for test in accepted),
                    cross_label_semantics='Foreign-model-compatible outline; the native automatic label and original span are unchanged. Atomic alternatives remain separate.'))
        if result.get('cross',{}).get('status')=='complete':layers.add('tf_xcr')
        auxiliary_errors=[]
        rescue=ds.get('rescue',{})
        if rescue.get('status') in ('complete','no_supported_auxiliary_candidates'):
            layers.update(('tf_recall','tf_cr_recalled'))
            for uid,records in per_unit.items():
                records['tf_cr_recalled']=list(records.get('tf_cr',[]))
            for row in rescue.get('records',[]):
                for call in row.get('calls',[]):
                    validation=call.get('native_family_validation',{})
                    if validation.get('accepted') is not True:
                        auxiliary_errors.append(dict(stage='rescue',unit_id=row['unit_id'],
                            reason='Completed native auxiliary addition lacks independent native-family validation'))
                        continue
                    record=dict(call,kind='new_recall',cr_mode=NATIVE_CR_MODE,strand=row.get('strand'),
                        auxiliary_model=rescue.get('auxiliary_model'),new_call=True,
                        source_provenance='Independent strict auxiliary detection; not an existing native CR call',
                        auxiliary_quality_quantity='geometry_inclusion_mass from the strict auxiliary detection model; not native CR classification confidence')
                    per_unit[row['unit_id']]['tf_recall'].append(record)
                    per_unit[row['unit_id']]['tf_cr_recalled'].append(record)
        split=ds.get('split',{})
        if split.get('status')=='complete':
            layers.update(('nuc_cr_split','cr_split_gap'))
            for row in split.get('records',[]):
                tests=row.get('tests',[])
                if not tests:continue
                test=next((t for t in tests if t.get('model')=='native_TF'),tests[0])
                validations=row.get('independent_native_piece_validations',[])
                for piece in test.get('pieces',[]):
                    supported=[v for v in validations if v.get('accepted') and v.get('piece')==piece]
                    record=dict(interval=piece,kind='alternative_protected_piece',cr_mode=NATIVE_CR_MODE,
                        family=supported[0]['family'] if supported else None,
                        independent_native_piece_validations=supported,
                        original_nuc=row.get('original_nuc'),raw_nucleosome_unchanged=True,
                        unclassified=not bool(supported),split_evidence=row)
                    if not supported:record.update(display_color='#94a3b8',classification_status='provisional_unresolved')
                    per_unit[row['unit_id']]['nuc_cr_split'].append(record)
                for gap in test.get('gaps',[]):
                    per_unit[row['unit_id']]['cr_split_gap'].append(dict(gap,kind='internal_accessible_separator',
                        cr_mode=NATIVE_CR_MODE,original_nuc=row.get('original_nuc'),split_evidence=row))
        indexes[dsid]=dict(by_name=dict(by_name),projection_members=dict(projection_members),
            per_unit={u:dict(v) for u,v in per_unit.items()},layers=sorted(layers),cr_mode=NATIVE_CR_MODE,
            classification_reference_percent=reference,
            display_classification_counts=classification_counts(projected,cr.get('catalog',[])),
            cross_projection_errors=cross_errors,auxiliary_projection_errors=auxiliary_errors)
        all_layers.update(layers)
    return indexes,sorted(all_layers)


def _legacy_index(result):
    indexes={}; layers=set();cross_by_family=defaultdict(list)
    for edge in result['cross'].get('edges',[]):
        for side in ('left','right'):
            key=(edge.get(side+'_dataset'),edge[side+'_family'])
            if edge not in cross_by_family[key]:cross_by_family[key].append(edge)
    for dsid,ds in result['datasets'].items():
        dataset_layers={'tf_native_replay'}
        per_unit=defaultdict(lambda:defaultdict(list));by_name=defaultdict(list)
        projection_members=defaultdict(list)
        cq={r['family']:r for r in ds.get('comparability',{}).get('records',[])}
        for unit in ds['units']:
            for name,identity in _unit_projection_members(unit):
                if unit['unit_id'] not in by_name[name]:
                    by_name[name].append(unit['unit_id'])
                member=dict(unit_id=unit['unit_id'],identity=identity)
                if member not in projection_members[name]:
                    projection_members[name].append(member)
            replay=result.get('manifest',{}).get('parameters',{}).get('input',{}).get('correct_native',True)
            for interval in unit['native_intervals']:per_unit[unit['unit_id']]['tf_native_replay'].append(dict(interval=interval,kind='native_msp_replay' if replay else 'native_source_calls'))
            for layer,key in [('nuc_native_replay','recalled_nuc_intervals'),('msp_native_replay','recalled_msp_intervals')]:
                if key in unit:
                    dataset_layers.add(layer);layers.add(layer)
                    for interval in unit[key]:
                        per_unit[unit['unit_id']][layer].append(dict(interval=interval,kind='upstream_recalled_scaffold'))
        layers.add('tf_native_replay')
        if ds['sr']['status']=='complete':
            dataset_layers.add('tf_sr_lattice')
            layers.add('tf_sr_lattice')
            for row in ds['sr']['records']:
                for call in row['calls']:per_unit[row['unit_id']]['tf_sr_lattice'].append(dict(interval=call['interval'],source_intervals=[call['raw']],kind=call['action'],sr_decision=call))
        # The lattice recaller's own calls: class members at their own edges (consensus edges kept alongside). The
        # wider-protection stretches (molecules best explained by e.g. a nucleosome over a class) are not footprints
        # of any class and stay in the run's broader table, not the display.
        if any(row.get('recaller_calls') for row in ds.get('cr',{}).get('records',[])):
            dataset_layers.add('tf_rc');layers.add('tf_rc')
            for row in ds['cr']['records']:
                for call in row.get('recaller_calls',[]):
                    if call['kind']!='class':continue
                    per_unit[row['unit_id']]['tf_rc'].append(dict(call,interval=list(call['interval']),kind='recaller_'+call['kind'],
                        strand=row['strand'],cr_mode=result.get('cr_mode'),
                        classification_status='recaller_member'))
        if ds.get('cr',{}).get('status') in ('complete','empty'):
            dataset_layers.add('tf_cr')
            layers.add('tf_cr')
            for row in ds['cr']['records']:
                for call in row['proposals']:
                    record=dict(call,kind='cr',strand=row['strand'],comparability=cq.get(call['family']))
                    if result.get('cr_mode') in STAGED_LIKE:
                        record.pop('family_evidence',None)
                        record['full_candidate_evidence_on_demand']=True
                    per_unit[row['unit_id']]['tf_cr'].append(record)
                    families=[call['family']]+[a if isinstance(a,str) else a.get('family') for a in call.get('compatible_alternatives',[])]
                    links=[]
                    for fid in families:
                        for edge in cross_by_family.get((dsid,fid),[])+cross_by_family.get((None,fid),[]):
                            if edge not in links:links.append(edge)
                    if links:per_unit[row['unit_id']]['tf_xcr'].append(dict(record,kind='xcr',links=links,
                        cross_comparable=any(e['comparability_mask'] for e in links),
                        shared_hypothesis=any(e.get('shared_hypothesis',False) for e in links)))
        if ds.get('rescue',{}).get('status')=='complete':
            dataset_layers.update(('tf_recall','tf_cr_recalled'))
            layers.update(('tf_recall','tf_cr_recalled'))
            for row in ds['rescue']['records']:
                for call in row['calls']:per_unit[row['unit_id']]['tf_recall'].append(dict(call,kind='new_recall',strand=row['strand'],model_membership=call['geometry_validation']['updated_family_inclusion_mass'],comparability=cq.get(call['family'])))
            for row in ds['rescue']['cr_records']:
                for call in row['proposals']:per_unit[row['unit_id']]['tf_cr_recalled'].append(dict(call,kind='cr_after_recall',strand=row['strand'],comparability=cq.get(call['family'])))
        if ds.get('split',{}).get('status')=='complete':
            dataset_layers.update(('nuc_cr_split','cr_split_gap'))
            layers.update(('nuc_cr_split','cr_split_gap'))
            for row in ds['split']['records']:
                test=row['tests'][0]
                for piece in test['pieces']:
                    matches=[v for v in test['matching_CR_pieces'] if v['piece']==piece and v['family'] in row['matching_robust_families']]
                    per_unit[row['unit_id']]['nuc_cr_split'].append(dict(interval=piece,kind='alternative_protected_piece',
                        family=matches[0]['family'] if matches else None,split_evidence=row))
                for gap in test['gaps']:per_unit[row['unit_id']]['cr_split_gap'].append(dict(gap,kind='internal_accessible_separator',split_evidence=row))
        if result['cross']['status']=='complete':
            layers.add('tf_xcr');dataset_layers.add('tf_xcr')
        indexes[dsid]=dict(by_name=dict(by_name),projection_members=dict(projection_members),
            per_unit={u:dict(v) for u,v in per_unit.items()},layers=sorted(dataset_layers))
    return indexes,sorted(layers)


def _visible(record,filters,strand):
    if record.get('cr_mode')==NATIVE_CR_MODE and record.get('kind')=='new_recall':
        # This is a different, explicitly named strict-detection model. Do not
        # relabel its mass as a native-family CR posterior or manufacture Q.
        if record.get('native_family_validation',{}).get('accepted') is not True:return False
        threshold=filters.get('minimum_rescue_model_q',0.)
        mass=record.get('geometry_inclusion_mass')
        if threshold>0 and (mass is None or mass<1-10**(-threshold/10)):return False
        return True
    if record.get('cr_mode') in (NATIVE_CR_MODE,HARMONIZATION_MODE,*STAGED_LIKE) and record.get('kind') in ('cr','xcr'):
        # Reclassification controls labels, not whether an original call exists.
        # Legacy Q/CQ fields have no statistical meaning for this model.
        return not (record.get('kind')=='xcr' and filters.get('require_cross_comparable',False)
                    and not record.get('cross_comparable',False))
    if record.get('kind') not in ('cr','cr_after_recall','new_recall','xcr'):
        return True
    strand=record.get('strand',strand)
    mass=record.get('model_membership')
    threshold=filters['minimum_model_q']
    if record.get('kind')=='new_recall' or record.get('provenance')=='population_assisted_new_call':
        threshold=filters.get('minimum_rescue_model_q',threshold)
    if mass is not None and mass < 1-10**(-threshold/10):return False
    cq=record.get('comparability') or {};value=cq.get('comparative_Q_model')
    if filters['minimum_comparability_q']>0 and (value is None or value<filters['minimum_comparability_q']):return False
    if filters['require_population_comparable'] and not all(cq.get('population_quantification_mask',{}).get(s,False) for s in ('CT','GA')):return False
    if filters['require_molecule_comparable'] and not cq.get('molecule_quantification_mask',{}).get(strand,False):return False
    if filters['require_cross_comparable'] and record.get('kind')=='xcr' and not record.get('cross_comparable'):return False
    return True


def projected_subset_is_current(state,dataset_id,chrom,start,end,source,reads):
    """Reuse only exact rows from this request's already projected working set.

    This is not a cross-request cache. The receipt is private Python metadata,
    never serialized, and a changed job/index/filter/manual revision fails closed.
    Callers must pass unmodified row objects, not reconstructed or cropped rows.
    """
    receipt=getattr(source,'_consensus_overlay_receipt',None)
    if not receipt or receipt['region']!=(dataset_id,chrom,start,end):return False
    if any(id(read) not in receipt['read_objects'] for read in reads):return False
    jobs,lock=_session(state)
    with lock:
        job=jobs.get(getattr(state,'consensus_workflow_active',None))
        return bool(job and job.get('status')=='complete'
            and job['job_id']==receipt['job_id']
            and job.get('result') is receipt['result']
            and job.get('index',{}).get(dataset_id) is receipt['index']
            and job['filters']==receipt['filters']
            and job.get('_curation',{}).get('revision',0)==receipt['curation_revision'])


def _projection_memo_is_current(memo,job,index,filters,region,working_set):
    """A working set's saved projection still answers for this job state (the receipt's invariants)."""
    return bool(memo and memo['job_id']==job['job_id'] and memo['result'] is job['result']
        and memo['index'] is index and memo['filters']==filters and memo['region']==region
        and memo['curation_revision']==job.get('_curation',{}).get('revision',0)
        and memo['reads'] is working_set.reads and memo['count']==len(working_set.reads))


def _view_placement(state,chrom,start,end):
    """Where a reference interval shows in the view ``start..end``: a function
    ``(a, b) -> [((ua, ub), (va, vb)), ...]``, one entry per copy of it the view
    shows, with the copy's whole span and its visible part, in the view's own
    coordinates.

    On a linear contig that is the interval itself (clipped). On a circular one
    the view's coordinates are logical: a wrapped view (below 0 or past the
    contig length) shows reference positions shifted by multiples of the length,
    and a window at the start of the contig shows the wrapped part of an
    interval past the contig end (an origin-spanning record's tail), where the
    reads show them."""
    from services.circular_genome import circular_chrom_size,circular_region_wraps,circular_view_segments
    size=circular_chrom_size(state,chrom)
    if not size:
        def linear(a,b):
            return [((a,b),(max(a,start),min(b,end)))] if a<end and b>start else []
        return linear
    if circular_region_wraps(start,end,size):
        windows=[(seg.logical_start,seg.logical_end,seg.logical_start-seg.ref_start)
            for seg in circular_view_segments(start,end,size)]
    else:
        windows=[(start,end,0)]
    def circular(a,b):
        copies={}
        for lo,hi,shift in windows:
            for k in range(math.floor(a/size)-1,math.floor((b-1)/size)+1):
                ua,ub=a-k*size+shift,b-k*size+shift
                va,vb=max(ua,lo),min(ub,hi)
                if va<vb:copies.setdefault((ua,ub),[]).append([va,vb])
        out=[]
        for copy,parts in sorted(copies.items()):
            parts.sort()
            merged=[parts[0]]
            for va,vb in parts[1:]:
                if va<=merged[-1][1]:merged[-1][1]=max(merged[-1][1],vb)
                else:merged.append([va,vb])
            out.extend((copy,(va,vb)) for va,vb in merged)
        return out
    return circular


def _shift_record(record,shift):
    """A consensus record moved by ``shift`` bp into a view's coordinates (its
    reference interval kept as ``reference_interval``)."""
    if not shift:return record
    moved=dict(record,interval=[int(record['interval'][0])+shift,int(record['interval'][1])+shift],
        reference_interval=list(record.get('reference_interval') or record['interval']))
    if record.get('edge_range'):
        moved['edge_range']=[[int(v)+shift for v in edge] for edge in record['edge_range']]
    return moved


def _outside(pieces,lo,hi):
    """``pieces`` (half-open) minus ``[lo, hi)``."""
    out=[]
    for a,b in pieces:
        for x,y in ((a,min(b,lo)),(max(a,hi),b)):
            if x<y:out.append((x,y))
    return out


def apply_overlays(state,dataset_id,chrom,start,end,working_set):
    """``working_set`` with the active run's calls projected onto its reads.

    Projection walks every read and its records, so it is done once per working
    set and job state: rows this request already projected are returned as they
    are, and a working set projected before (the working-set cache hands the same
    object to every request and analysis within its lifetime) gets its saved
    projection back while the job, result, index, display filters and curation
    revision are the same ones (the receipt's invariants). Any change reprojects.
    """
    if projected_subset_is_current(state,dataset_id,chrom,start,end,working_set,working_set.reads):
        return working_set
    from services.consensus_curation import annotate_record,curated_records_for_unit
    jobs,lock=_session(state)
    with lock:
        job=jobs.get(state.consensus_workflow_active)
        if not job or job['status']!='complete' or dataset_id not in job['index']:return working_set
        from services.oriented_regions import display_regions
        regions=display_regions(job['result'],dataset_id,chrom)
        if not regions:return working_set
        region=dict(chrom=chrom,start=min(r['start'] for r in regions),end=max(r['end'] for r in regions))
        # Reference intervals as this view shows them (a circular view's own coordinates).
        place=_view_placement(state,chrom,start,end)
        if (normalize_chrom_name(region['chrom'])!=normalize_chrom_name(chrom)
                or not place(region['start'],region['end'])):return working_set
        index=job['index'][dataset_id];filters=dict(job['filters'])
        memo=getattr(working_set,'_consensus_projection_memo',None)
        if _projection_memo_is_current(memo,job,index,filters,(dataset_id,chrom,start,end),working_set):
            return memo['projected']
        # Freeze one identity/curation revision for the whole displayed payload.
        # This lock is never held while native inference is executed.
        projections=[_match_projection_unit(index,read,chrom) if index.get('unit_windows') else _match_projection_unit(index,read) for read in working_set.reads]
        rendered={}
        for read,(uid,_,_) in zip(working_set.reads,projections):
            render_key=(uid,str(read.get('strand','')))
            if uid is None or render_key in rendered:continue
            rendered[render_key]=defaultdict(list)
            automatic_cr=[]
            source_dataset=index.get('unit_sources',{}).get(uid,dataset_id)
            for layer,records in index['per_unit'].get(uid,{}).items():
                for record in records:
                    if record.get('_chrom') and normalize_chrom_name(record['_chrom'])!=normalize_chrom_name(chrom):continue
                    if not place(record['interval'][0],record['interval'][1]):continue
                    if not _visible(record,filters,str(read.get('strand',''))):continue
                    if layer=='tf_cr':automatic_cr.append(record)
                    if layer=='tf_rc' and record.get('kind')=='recaller_class':
                        # The class's tier decides which calls are drawn; the edges mode which edges.
                        if not within_tier(record,recaller_tier(job,record.get('family'))):continue
                        mode=filters.get('recaller_edges','native')
                        if mode=='class' and record.get('consensus_interval'):
                            record=dict(record,interval=list(record['consensus_interval']),edge_range=None)
                        elif mode=='lattice' and record.get('lattice_interval'):
                            record=dict(record,interval=list(record['lattice_interval']))
                        elif record.get('edge_source')=='native':
                            record=dict(record,edge_range=None)   # the native call's own edges
                        else:
                            record=dict(record,recaller_added=True)   # no native call for it: the recaller's own
                    if layer in ('tf_cr','tf_xcr') and viewing_final(job):
                        record=annotate_record(job,source_dataset,uid,record)
                    rendered[render_key][layer].append(record)
            for record in (curated_records_for_unit(job,source_dataset,uid,automatic_cr) if viewing_final(job) else []):
                if place(record['interval'][0],record['interval'][1]):
                    rendered[render_key]['tf_cr_manual'].append(record)
        receipt=dict(job_id=job['job_id'],result=job['result'],index=index,
            region=(dataset_id,chrom,start,end),filters=filters,
            curation_revision=job.get('_curation',{}).get('revision',0))
    copied=[];width=end-start
    for read,(uid,projection_status,candidate_units) in zip(working_set.reads,projections):
        layer_records=rendered.get((uid,str(read.get('strand',''))),{})
        result=dict(read);result['layers']={k:v for k,v in (read.get('layers') or {}).items() if not v.get('consensus_workflow')}
        result['consensus_projection']=dict(status=projection_status,unit_id=uid,
            candidate_units=candidate_units,job_id=job['job_id'])
        # A matched molecule must display the same TF baseline used by inference,
        # not the saved BAM calls underneath a different recalled call set.
        # Preserve the original layer and all geometry outside the analysis span.
        if uid is not None and _cr_mode(job['result']) in STAGED_LIKE and 'tf_native_replay' in index.get('layers', []):
            # The analysis span as this view shows it (several pieces in a circular view).
            unit_regions=[index['unit_windows'][uid]] if uid in index.get('unit_windows',{}) else regions
            spans=[(va-start,vb-start) for r in unit_regions for _,(va,vb) in place(r['start'],r['end'])]
            original=result['layers'].get('tf_bam_original', result['layers'].get('tf', {}))
            # (display interval, unclipped source interval) pairs: analyses match
            # saved rules against a call's own bounds, not its viewport-clipped part.
            baseline=[]
            original_sources=original.get('source_intervals') or []
            for idx,(a,b,size) in enumerate(original.get('intervals', [])):
                source=list(original_sources[idx]) if idx<len(original_sources) else [a,b,size]
                pieces=[(a,b)]
                for span_lo,span_hi in spans:pieces=_outside(pieces,span_lo,span_hi)
                baseline.extend(([lo,hi,size],source) for lo,hi in pieces)
            for record in index['per_unit'].get(uid,{}).get('tf_native_replay',[]):
                a,b=record['interval']
                for (ua,ub),(va,vb) in place(a,b):
                    for span_lo,span_hi in spans:
                        lo=max(span_lo,va-start);hi=min(span_hi,vb-start)
                        if lo<hi:baseline.append(([lo,hi,b-a],[ua-start,ub-start,b-a]))
            baseline.sort(key=lambda pair:pair[0])
            result['layers']['tf_bam_original']=original
            result['layers']['tf']=dict(intervals=[d for d,_ in baseline],source_intervals=[src for _,src in baseline],
                quality_names=[],qualities=[],
                analysis_baseline=True,job_id=job['job_id'],source_layer='tf_native_replay')
        for name,records in layer_records.items():
            records.sort(key=lambda r:(r['interval'],r.get('family') or ''))
            # Each copy of a call the view shows (one, but for a circular view's
            # wrapped copies), moved into the view's coordinates.
            shown=[]
            for record in records:
                a,b=int(record['interval'][0]),int(record['interval'][1])
                for (ua,ub),(va,vb) in place(a,b):
                    shown.append((_shift_record(record,ua-a),[va-start,vb-start,b-a],[ua-start,ub-start,b-a]))
            shown.sort(key=lambda item:(item[0]['interval'],item[1],item[0].get('family') or ''))
            records=[r for r,_,_ in shown]
            # Class support (q0) once FiberHMM's classification provides it.
            has_q0=bool(records) and all(isinstance(r.get('q0'),(int,float)) for r in records)
            result['layers'][name]=dict(intervals=[shown_iv for _,shown_iv,_ in shown],
                source_intervals=[source_iv for _,_,source_iv in shown],consensus_workflow=True,
                annotation_names=[str(r.get('family') or r['kind']) for r in records],
                quality_names=['q0'] if has_q0 else [],qualities=[[int(r['q0']) for r in records]] if has_q0 else [],
                consensus_records=records,show_quality_outlines=filters['show_quality_outlines'],
                source_layer='nuc' if name in ('nuc_cr_split','cr_split_gap') else 'tf',
                draw_style='outline' if name=='tf_xcr' else 'fill',job_id=job['job_id'])
        copied.append(result)
    from models.domain import WorkingSet
    projected=WorkingSet(copied,working_set.total_overlapping,working_set.total_spanning,
        working_set.chrom,working_set.start,working_set.end,
        profile_metaprofile=working_set.profile_metaprofile,profile_read_count=working_set.profile_read_count)
    receipt['read_objects']=frozenset(map(id,copied))
    projected._consensus_overlay_receipt=receipt
    try:
        working_set._consensus_projection_memo=dict(job_id=receipt['job_id'],result=receipt['result'],
            index=receipt['index'],filters=receipt['filters'],region=receipt['region'],
            curation_revision=receipt['curation_revision'],reads=working_set.reads,
            count=len(working_set.reads),projected=projected)
    except AttributeError:
        pass   # a working set that takes no attributes is projected again next time
    return projected


def _bam_export_groups(state,job):
    """The run's source BAMs, grouped as the open datasets group them now.

    Each source BAM is in exactly one group: open datasets holding run BAMs
    (other BAMs they hold, and unrelated datasets, are left out), then the
    run's own datasets for BAMs no open dataset holds (closed since the run).
    """
    sources=job.get('_snapshot') or job['result'].get('manifest',{}).get('browser_sources') or {}
    inputs={str(p) for row in sources.values() for p in row.get('paths',[])}
    groups=[];claimed=set()
    for dsid,ds in getattr(state,'datasets',{}).items():
        if getattr(ds,'data_type',None)!='bam':continue
        paths=getattr(ds,'paths',None) or [ds.path]
        if isinstance(paths,str):paths=[paths]
        # (Without a record of the run's sources, every open BAM dataset, as before.)
        own=[str(p) for p in paths if (not inputs or str(p) in inputs) and str(p) not in claimed]
        if own:
            groups.append(dict(dataset_id=dsid,paths=own));claimed.update(own)
    for dsid,row in sources.items():
        rest=[str(p) for p in row.get('paths',[]) if str(p) not in claimed]
        if not rest:continue
        same=next((g for g in groups if g['dataset_id']==dsid),None)
        if same:same['paths'].extend(rest)
        else:groups.append(dict(dataset_id=dsid,paths=rest))
        claimed.update(rest)
    return groups


def export_family_bams(state, job_id, output_dir, grouping='datasets', scope='regions'):
    """Export frozen automatic memberships, grouped as the view is grouped now."""
    if not isinstance(output_dir,str) or not output_dir.strip():
        raise ValueError('Choose an output folder')
    from services.lab.paths import confine
    confine(output_dir,write=True)  # a lab server: only in a writable data root
    jobs,lock=_session(state)
    with lock:
        job=jobs[job_id]
        if job['status']!='complete': raise ValueError('Complete the CR run before exporting BAMs')
        if job.get('_bam_export_busy'): raise ValueError('A BAM export for this run is already in progress')
        evidence=Path(job['artifact_dir'])/'evidence.json.gz'
        if not evidence.is_file(): raise ValueError('This imported result lacks BAM evidence; rerun from its source BAMs')
        result=assignment_export_result(job)
        groups=_bam_export_groups(state,job)
        job['_bam_export_busy']=True
    try:
        from fiberhmm.inference.consensus.artifacts import read_json
        from fiberhmm.inference.consensus.bam_export import export_bams
        outputs=export_bams([(result,read_json(evidence))],output_dir,grouping=grouping,dataset_groups=groups,scope=scope)
        return dict(outputs=outputs,grouping=grouping,export_scope=scope,scope='frozen_automatic_final_memberships')
    finally:
        with lock: job['_bam_export_busy']=False
