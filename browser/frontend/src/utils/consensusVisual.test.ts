import { describe,it,expect } from 'vitest';
import { setConsensusPalette,consensusFamilyColor,consensusOutline,consensusPrimaryFamily,consensusRecordColor,consensusRecordSummary,consensusRecordFamilies,type ConsensusRecord } from './consensusVisual';
import { annotationLayerRenderRank } from './strandRescue';

const record:ConsensusRecord={interval:[110,150],kind:'cr',family:'d:F0001'};
describe('dedicated consensus visual language',()=>{
  it('allocates unique colors across the consolidated catalog, independent of input order',()=>{
    const ids=Array.from({length:60},(_,i)=>`state-${i}`);
    setConsensusPalette(ids);const colors=ids.map(consensusFamilyColor);
    expect(new Set(colors).size).toBe(ids.length);
    setConsensusPalette([...ids].reverse());expect(ids.map(consensusFamilyColor)).toEqual(colors);
    setConsensusPalette([]);
  });
  it('colors and highlights every compatible label without changing call geometry',()=>{
    const r={...record,compatible_alternatives:['B',{family:'C'},'B']};const before=JSON.stringify(r);
    expect(consensusRecordFamilies(r)).toEqual(['d:F0001','B','C']);
    expect(consensusRecordFamilies({...r,manual_group_id:'M'})).toEqual(['M','B','C']);
    expect(consensusRecordFamilies({...r,manual_ignored:true})).toEqual([]);
    expect(JSON.stringify(r)).toBe(before);
  });
  it('uses only the best-fit assignment as the molecular-call color',()=>{
    const r={...record,compatible_alternatives:['B',{family:'C'}]};
    expect(consensusPrimaryFamily(r)).toBe('d:F0001');
    expect(consensusRecordColor(r)).toBe(consensusFamilyColor('d:F0001'));
    expect(consensusRecordColor({...r,kind:'new_recall'})).toBe(consensusFamilyColor('d:F0001'));
    expect(consensusPrimaryFamily({...r,manual_group_id:'M'})).toBe('M');
    expect(consensusPrimaryFamily({...r,classification_status:'provisional_unresolved'})).toBeNull();
  });
  it('keeps unresolved native calls gray even though their source IDs are retained',()=>{
    const r={...record,cr_mode:'native_family_distribution' as const,classification_status:'provisional_unresolved'};
    expect(consensusRecordColor(r)).toBe('#9ba6ae');expect(consensusRecordSummary(r)).toContain('not a supported family');
    expect(consensusRecordColor({...r,manual:true,manual_group_id:'M'})).toBe(consensusFamilyColor('M'));
  });
  it('marks manual groups without mutating original spans or native evidence',()=>{
    const r={...record,manual:true,manual_group_id:'M1',automatic_family:record.family!};const before=JSON.stringify(r);
    expect(consensusOutline(r)).toEqual({color:'#7c3aed',dashed:true});
    expect(consensusRecordColor(r)).toBe(consensusFamilyColor('M1'));
    expect(consensusRecordSummary(r)).toContain('MANUAL');expect(JSON.stringify(r)).toBe(before);
    expect(consensusRecordColor({...r,manual_ignored:true})).toBe('#94a3b8');
    expect(consensusRecordSummary({...r,manual_ignored:true})).toContain('not evidence of accessibility');
  });
  it('labels native predictive tails and alternatives, never posterior Q',()=>{
    const summary=consensusRecordSummary({...record,source_call_id:'source-7',primary_evidence:{native_loss:2,floor_adjusted_loss:1,predictive_tail:.12,predictive_tail_interval:[.1,.15],fit_converged:false},compatible_alternatives:['B',{family:'C'}]});
    expect(summary).toContain('predictive tail=0.120');expect(summary).toContain('MC');expect(summary).toContain('B, C');
    expect(summary).toContain('NOT converged');expect(summary).not.toContain(' P=');expect(summary).not.toContain('CQ=');
  });
  it('keeps class color fixed when quality changes',()=>{
    expect(consensusRecordColor({...record,model_membership:.1})).toEqual(consensusRecordColor({...record,model_membership:.99}));
    expect(consensusFamilyColor('d:F0001')).toEqual(consensusFamilyColor('d:F0001'));
  });
  it('does not paint unchanged SR as rescued',()=>{
    expect(consensusRecordColor({...record,family:null,kind:'unchanged'})).not.toEqual(consensusRecordColor({...record,kind:'new_recall'}));
  });
  it('separates unknown comparison from disagreement and strong support',()=>{
    expect(consensusOutline({...record,comparability:{comparative_Q_model:null,status:'CT_population_only'}})?.dashed).toBe(true);
    expect(consensusOutline({...record,comparability:{comparative_Q_model:.01,status:'strand_model_discrepancy'}})?.color).toBe('#d04b43');
    expect(consensusOutline({...record,comparability:{comparative_Q_model:25,status:'two_strand_supported'}})?.color).toBe('#175c43');
    expect(consensusOutline({...record,kind:'xcr',links:[{link_id:'X1',recipient_evidence:{status:'core_contradicted'}}]})?.color).toBe('#d04b43');
  });
  it('renders new derived classes after native TFs and XCR last',()=>{
    expect(annotationLayerRenderRank('tf_cr')).toBeGreaterThan(annotationLayerRenderRank('tf'));
    expect(annotationLayerRenderRank('tf_xcr')).toBeGreaterThan(annotationLayerRenderRank('tf_cr_recalled'));
    expect(annotationLayerRenderRank('tf_cr_manual')).toBeGreaterThan(annotationLayerRenderRank('tf_cr'));
    expect(annotationLayerRenderRank('tf_cr_manual')).toBeLessThan(annotationLayerRenderRank('tf_xcr'));
  });
  it('marks weak population-assisted and numerically provisional additions explicitly',()=>{
    const addition={...record,provenance:'population_assisted_new_call',information_status:'weak_population_assisted'};
    expect(consensusOutline(addition)).toEqual({color:'#b47a23',dashed:true});
    expect(consensusOutline({...addition,numerical_provisional:true})).toEqual({color:'#8d6b95',dashed:true});
    expect(consensusRecordColor(addition)).toEqual(consensusRecordColor(record));
  });
});
