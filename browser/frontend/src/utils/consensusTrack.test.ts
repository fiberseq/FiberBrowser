import {describe,it,expect} from 'vitest';
import {packFamilies,relatedFamilies,relatedFamilyRefs,comparableFamilyRefs,familyRefKey,trackX,familyCount,displayFamilies,type CatalogFamily} from './consensusTrack';
const f=(family:string,start:number,end:number):CatalogFamily=>({family,consensus_start:start,consensus_end:end});
describe('overhead frozen family track',()=>{
  it('counts staged multi-memberships and links shared classes without claiming comparability',()=>{
    expect(familyCount({...f('A',1,9),stage:'resolved',classification_counts:{CT:{original_calls:20,primary_calls:0,compatible_calls:20,primary_units:0,eligible_units:90}}})).toBe(20);
    const catalog:any={cr_mode:'staged_native_families',datasets:{d:{catalog:[f('A',1,9)]},h:{catalog:[f('A',1,9)]}},edges:[
      {left_dataset:'d',left_family:'A',right_dataset:'h',right_family:'A',comparability_mask:false,shared_hypothesis:true}]};
    expect(comparableFamilyRefs(catalog).size).toBe(2);
    expect(relatedFamilyRefs([{jobId:'j',datasetId:'d',family:'A'}],catalog,'j').size).toBe(2);
    expect(catalog.edges[0].comparability_mask).toBe(false);
  });
  it('culls superseded manual children from the display, not the frozen catalog',()=>{
    const a=f('A',10,30),b=f('B',11,31);
    const dataset={catalog:[a,b],comparability:[],curated_display_families:[{...a,superseded_by_manual:true},
      {...b,superseded_by_manual:true},{family:'M',manual:true,display_start:10,display_end:31}]};
    expect(displayFamilies(dataset).map(r=>r.family)).toEqual(['M']);
    expect(dataset.catalog).toEqual([a,b]);
  });
  it('adapts manual member envelopes for glyphs without replacing inference intervals',()=>{
    const native=f('A',10,30),dataset={catalog:[native],comparability:[],curated_display_families:[{...native,ignored:true},
      {family:'M',manual:true,display_summary_only:true,display_start:5,display_end:70,source_family_ids:['A']}]};
    const snapshot=JSON.stringify(dataset),display=displayFamilies(dataset);
    expect(display.map(f=>f.family)).toEqual(['A','M']);expect(display[0].ignored).toBe(true);
    expect(display[1].consensus_start).toBe(5);expect(display[1].display_summary_only).toBe(true);
    expect(JSON.stringify(dataset)).toBe(snapshot);expect(native.consensus_end).toBe(30);
  });
  it('scopes selected/linked families by dataset even when IDs collide',()=>{
    const catalog:any={datasets:{d:{catalog:[f('A',1,9)]},h:{catalog:[f('A',1,9),f('B',3,8)]}},edges:[
      {left_dataset:'d',left_family:'A',right_dataset:'h',right_family:'B',comparability_mask:true}]};
    const keys=relatedFamilyRefs([{jobId:'j',datasetId:'d',family:'A'}],catalog,'j');
    expect([...keys]).toEqual([familyRefKey({datasetId:'d',family:'A'}),familyRefKey({datasetId:'h',family:'B'})]);
    expect(keys.has(familyRefKey({datasetId:'h',family:'A'}))).toBe(false);
    expect(comparableFamilyRefs(catalog).has(familyRefKey({datasetId:'h',family:'A'}))).toBe(false);
    delete catalog.edges[0].left_dataset;expect(comparableFamilyRefs(catalog).size).toBe(0);
    expect(relatedFamilyRefs([{jobId:'old',datasetId:'d',family:'A'}],catalog,'j').size).toBe(0);
  });
  it('uses native primary call counts without summing overlapping alternatives',()=>{
    expect(familyCount({...f('A',1,9),classification_counts:{CT:{original_calls:100,primary_calls:7,compatible_calls:20,primary_units:5,eligible_units:90}}})).toBe(7);
  });
  it('keeps broad and nested alternatives clickable without merging or a lane cap',()=>{
    const source=[f('broad',10,90),f('left',10,30),f('right',60,90),f('tiny',15,20),f('next',100,120)];
    const before=JSON.stringify(source);const packed=packFamilies(source);
    expect(packed).toHaveLength(5);expect(JSON.stringify(source)).toBe(before);
    const byId=Object.fromEntries(packed.map(f=>[f.family,f]));
    expect(byId.broad.lane).not.toBe(byId.left.lane);expect(byId.left.lane).toBe(byId.right.lane);
    expect(new Set(packed.filter(f=>f.consensus_start<30).map(f=>f.lane)).size).toBe(3);
    expect(byId.broad.consensus_end).toBe(90);
  });
  it('projects using panel bounds, reversal and the read sidebar',()=>{
    expect(trackX(125,100,200,120,20)).toBe(45);
    expect(trackX(125,100,200,120,20,true)).toBe(95);
    expect(trackX(100,100,200,120,20)).toBe(20);
  });
  it('highlights only directly comparable atomic partners, never graph-transitive merging',()=>{
    const catalog:any={datasets:{},edges:[{left_family:'a',right_family:'b',comparability_mask:true},
      {left_family:'a',right_family:'c',comparability_mask:false},{left_family:'b',right_family:'d',comparability_mask:true}]};
    expect([...relatedFamilies('a',catalog)]).toEqual(['a','b']);
    expect([...relatedFamilies(null,catalog)]).toEqual([]);
  });
  it('uses frozen all-unit counts, not visible row counts or caller reruns',()=>{
    expect(familyCount({...f('a',1,2),rates_by_strand:{CT:{after_sr_assignments:7,eligible_units:10,native_assignments:6},
      GA:{after_sr_assignments:4,eligible_units:20,native_assignments:3}}})).toBe(11);
  });
});

import {stateDisplayName} from './consensusTrack';
describe('class names',()=>{
  it('keep their numbers for a run when stringency moves the spans',()=>{
    const run={jobId:'job-frozen',datasetId:'d'};
    const before:any={catalog:[f('A',100,160),f('B',200,260)]};
    expect(stateDisplayName(before,'A',run)).toBe('Class 1');
    expect(stateDisplayName(before,'B',run)).toBe('Class 2');
    // Stricter assignment: B's span now starts before A's.
    const after:any={catalog:[f('A',150,170),f('B',90,120)]};
    expect(stateDisplayName(after,'A',run)).toBe('Class 1');
    expect(stateDisplayName(after,'B',run)).toBe('Class 2');
    expect(stateDisplayName(after,'B')).toBe('Class 1');  // without a run: genomic order now
  });
});
