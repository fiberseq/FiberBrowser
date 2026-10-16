import {describe,it,expect} from 'vitest';
import {normalizeConsensusCatalog,type ConsensusCatalogTransport,type NativeCatalogEdgeTransport} from './consensusWorkflow';
import {relatedFamilyRefs,familyRefKey} from '../utils/consensusTrack';

const native:NativeCatalogEdgeTransport={link_id:'NX1',datasets:['D','H'],families:{D:'D:A',H:'H:B'},
  native_intervals:{D:[100,140],H:[102,138]},status:'provisional_reciprocal_compatible',comparable:true,
  merged_interval:null,native_family_evidence:{}};
const input:ConsensusCatalogTransport={cr_mode:'native_family_distribution',datasets:{
  D:{catalog:[{family:'D:A',consensus_start:100,consensus_end:140}],comparability:[]},
  H:{catalog:[{family:'H:B',consensus_start:102,consensus_end:138}],comparability:[]}},edges:[native]};
describe('native atomic catalog presentation adapter',()=>{
  it('preserves authenticated model provenance without filling in missing policy',()=>{
    const update={policy:'append_frozen',original_family_count:1,added_family_count:2,
      initial_snapshot_digest:'initial',augmented_snapshot_digest:'new'};
    const provenance={origin:'initial_frozen',model_version_sha256:'model',producer_snapshot_digest:'initial'};
    const source={...input,datasets:{...input.datasets,D:{...input.datasets.D,native_catalog_update:update,
      catalog:[{...input.datasets.D.catalog[0],model_provenance:provenance}]}}};
    const before=JSON.stringify(source),output=normalizeConsensusCatalog(source);
    expect(output.datasets.D.native_catalog_update).toEqual(update);
    expect(output.datasets.D.catalog[0].model_provenance).toEqual(provenance);
    expect(output.datasets.H.native_catalog_update).toBeUndefined();expect(JSON.stringify(source)).toBe(before);
  });
  it('derives dataset-qualified display aliases without altering native geometry or evidence',()=>{
    const before=JSON.stringify(input);const output=normalizeConsensusCatalog(input),edge=output.edges[0];
    expect(edge).toMatchObject({edge_id:'NX1',left_dataset:'D',right_dataset:'H',left_family:'D:A',right_family:'H:B',
      left_interval:[100,140],right_interval:[102,138],comparability_mask:true,forward:null,reverse:null,
      merged_interval:null,native_intervals:native.native_intervals,status:native.status});
    expect(edge.native_family_evidence).toBe(native.native_family_evidence);
    expect(edge.left_interval).toBe(native.native_intervals.D);expect(JSON.stringify(input)).toBe(before);
    expect(relatedFamilyRefs([{jobId:'j',datasetId:'D',family:'D:A'}],output,'j'))
      .toContain(familyRefKey({datasetId:'H',family:'H:B'}));
  });
  it('does not upgrade an incompatible native relationship',()=>{
    const output=normalizeConsensusCatalog({...input,edges:[{...native,comparable:false,status:'provisional_unresolved'}]});
    expect(output.edges[0].comparability_mask).toBe(false);expect(output.edges[0].status).toBe('provisional_unresolved');
    expect(relatedFamilyRefs([{jobId:'j',datasetId:'D',family:'D:A'}],output,'j').size).toBe(1);
  });
  it('leaves a legacy catalog edge unchanged and rejects malformed native endpoints',()=>{
    const legacy={edge_id:'old',left_family:'a',right_family:'b',left_interval:[1,2],right_interval:[1,3],status:'old',comparability_mask:false};
    expect(normalizeConsensusCatalog({...input,edges:[legacy]}).edges[0]).toBe(legacy);
    expect(()=>normalizeConsensusCatalog({...input,edges:[{...native,native_intervals:{D:[100,100],H:[102,138]}}]})).toThrow('Invalid native atomic');
  });
});
