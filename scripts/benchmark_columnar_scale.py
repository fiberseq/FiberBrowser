"""Engineering scale validation on generated BAMs, separate from paper data."""
from pathlib import Path
import argparse, collections, csv, gc, hashlib, json, os, platform, resource, threading, time
import pysam, psutil

P=argparse.ArgumentParser()
P.add_argument('action', choices=['prepare','run'])
P.add_argument('--count',type=int,required=True)
P.add_argument('--root',type=Path,required=True)
P.add_argument('--pilot',action='store_true')
a=P.parse_args();a.root.mkdir(parents=True,exist_ok=True)
bam=a.root/f'pattern_{a.count}.bam'
peaks=[[100+300*i,180+300*i] for i in range(8)]
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1048576),b''):h.update(block)
    return h.hexdigest()
if a.action=='prepare':
    assert not bam.exists()
    with pysam.AlignmentFile(bam,'wb',header={'HD':{'SO':'coordinate'},'SQ':[{'SN':'chr1','LN':100000}]}) as out:
        for i in range(a.count):
            r=pysam.AlignedSegment(out.header)
            r.query_name=f'm{i:07d}';r.query_sequence='ACGT'*750
            r.query_qualities=pysam.qualitystring_to_array('I'*3000)
            r.reference_id=0;r.reference_start=10000;r.flag=0;r.mapping_quality=60;r.cigarstring='3000M'
            middle=[]
            for bit,(left,right) in enumerate(peaks):
                if (i%256)&(1<<bit):
                    mix=(i*2654435761+bit*2246822519)&0xffffffff
                    middle.append((left+mix%31-10,100+(mix>>8)%61,160+(mix>>16)%96))
            calls=[(0,50,200)]+middle+[(2900,100,200)]
            r.set_tag('ns',[c[0] for c in calls]);r.set_tag('nl',[c[1] for c in calls]);r.set_tag('nq',[c[2] for c in calls])
            out.write(r)
    pysam.index(str(bam))
    with pysam.AlignmentFile(bam) as f:assert f.count('chr1',10000,13000)==a.count
    (a.root/f'input_{a.count}.json').write_text(json.dumps(dict(count=a.count,bam=str(bam),sha256=sha(bam),
        algorithm='All records start at 10000 with 3000M; unique mNNNNNNN names; eight nucleosome occupancy bits encoded by i modulo 256 at fixed peak windows; per-molecule deterministic coordinate, length and quality variation preserves the programmed pattern. Deterministic synthetic engineering data, no biological inference.',
        peaks_relative=peaks,reference_start=10000,reference_end=13000),indent=2))
    print('PREPARED',a.count,flush=True)
else:
    from services import columnar_clustering
    if a.pilot:
        assert a.count <= 10_000
        columnar_clustering.COLUMNAR_MIN_READS = 0
    from state.browser_state import BrowserState
    from models.domain import Dataset
    from models.requests import ClusterAllRequest,PeakRegion
    from services.clustering_endpoint import run_cluster_all_endpoint
    from services.packed_reads import PackedReads
    from fastapi.encoders import jsonable_encoder
    from utils.responses import ORJSONResponse
    from services.byte_cache import ByteCache
    output=a.root/f'scale_{a.count}.json';assert not output.exists()
    service_root=Path(columnar_clustering.__file__).resolve().parent
    source_hashes={name:sha(service_root/(name+'.py')) for name in ['columnar_clustering','clustering_features','clustering_endpoint','working_sets','compact_read_loader','packed_reads','read_metrics','read_route_helpers','read_edge_cache','direct_read_projection']}
    source_hashes['validation_script']=sha(Path(__file__))
    state=BrowserState(None,reference_only=True)
    state.performance={'effective':'standard','decode_workers':1}
    state.config['prefetch_multiplier']=1
    state.short_terminal_footprint_bp=0;state.drop_short_terminal_footprints=False
    state.datasets={'d':Dataset('d',str(bam),data_type='bam')};state.dataset_order=['d']
    state.datasets['d'].available_layers={'footprint':True,'nuc':True}
    state._broad_cache=ByteCache(512*1024*1024)
    state._working_set_cache=ByteCache(512*1024*1024)
    req=ClusterAllRequest(method='combinatorial',max_reads=0,dataset_ids=['d'],
        peak_regions=[PeakRegion(start=10000+l,end=10000+r,mode='nuc') for l,r in peaks])
    memory=[];stop=threading.Event();proc=psutil.Process()
    def monitor():
        while not stop.wait(.1):
            memory.append(dict(time=time.time(),rss=proc.memory_info().rss,available=psutil.virtual_memory().available))
    thread=threading.Thread(target=monitor,daemon=True);thread.start()
    results=[];failure=None
    try:
        for visit in ['first','revisit']:
            t=time.perf_counter()
            response=run_cluster_all_endpoint(state=state,req=req,chrom='chr1',start=10000,end=13000,spanning=True)
            elapsed=time.perf_counter()-t
            serialize_start=time.perf_counter()
            encoded=jsonable_encoder(response)
            wire=ORJSONResponse(encoded).body
            serialize_s=time.perf_counter()-serialize_start
            wire_bytes=len(wire);wire_sha256=hashlib.sha256(wire).hexdigest()
            del encoded,wire
            result=response['results']['d'];assignments=result['assignments']
            assert response['analysis_storage']['engine']=='columnar'
            assert response['analysis_storage']['input_rows']==a.count
            assert result['eligible_read_count']==result['peak_covering_read_count']==result['analysis_read_count']==len(assignments)==a.count
            patterns={int(k):tuple(v) for k,v in response['cluster_patterns'].items()}
            truth_order=sorted(range(256),key=lambda i:(-(a.count//256 + int(i<a.count%256)),i))[:50]
            truth_patterns=[tuple(int(bool(i&(1<<bit))) for bit in range(8)) for i in truth_order]
            assert [patterns[label] for label in sorted(patterns)]==truth_patterns
            counts=collections.Counter()
            digest=hashlib.sha256()
            expected_by_pattern={}
            for pattern in range(256):
                bits=tuple(int(bool(pattern&(1<<bit))) for bit in range(8))
                exact=next((label for label,p in patterns.items() if p==bits),None)
                expected_by_pattern[pattern]=(exact if exact is not None else min(patterns,key=lambda label:sum(x!=y for x,y in zip(bits,patterns[label]))))
            for i in range(a.count):
                read_id=f'm{i:07d}';label=assignments[read_id]
                assert label==expected_by_pattern[i%256], (i,label,expected_by_pattern[i%256])
                counts[label]+=1;digest.update(f'{read_id}\t{label}\n'.encode())
            assert dict(counts)==result['cluster_counts']
            assert all(isinstance(value[0],PackedReads) for value in state._broad_cache.values())
            assert all(isinstance(value[0].reads,PackedReads) for value in state._working_set_cache.values())
            results.append(dict(visit=visit,elapsed_s=elapsed,serialize_s=serialize_s,wire_bytes=wire_bytes,wire_sha256=wire_sha256,storage=response['analysis_storage'],timings=response['timings'],
                assignment_sha256=digest.hexdigest(),assignment_count=len(assignments),cluster_counts=dict(counts),
                broad_retained_bytes=state._broad_cache.retained_bytes,working_retained_bytes=state._working_set_cache.retained_bytes))
            print('PASS',a.count,visit,round(elapsed,3),flush=True)
            del response,result,assignments;gc.collect()
    except BaseException as exc:
        failure=dict(type=type(exc).__name__,message=str(exc))
        raise
    finally:
        stop.set();thread.join()
        with (a.root/f'scale_{a.count}_memory.csv').open('w') as f:
            w=csv.DictWriter(f,fieldnames=['time','rss','available']);w.writeheader();w.writerows(memory)
        if failure:
            (a.root/f'scale_{a.count}_FAILED.json').write_text(json.dumps(dict(count=a.count,failure=failure,
                completed_visits=results,source_hashes=source_hashes,maxrss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss),indent=2))
    output.write_text(json.dumps(dict(count=a.count,platform=platform.platform(),peak_rss_bytes=max(row['rss'] for row in memory),
        maxrss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,visits=results,all_assignment_checks_passed=True,
        pilot=a.pilot,source_hashes=source_hashes,input_manifest=str(a.root/f'input_{a.count}.json')),indent=2))
