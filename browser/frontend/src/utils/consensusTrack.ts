import type { ConsensusCatalog } from '../api/consensusWorkflow';
export type CatalogFamily=ConsensusCatalog['datasets'][string]['catalog'][number];
/** Display adapter only: use curated metadata, retaining native inference nodes.
 * Manual glyph extents are explicitly display-only member envelopes, never call
 * geometry. They are not written to the catalog or any per-read record.
 */
export function displayFamilies(dataset:ConsensusCatalog['datasets'][string]|undefined):CatalogFamily[]{
  const rows=new Map((dataset?.catalog??[]).map(f=>[f.family,f]));
  for(const f of dataset?.curated_display_families??[]){
    const start=f.manual?f.display_start:f.consensus_start,end=f.manual?f.display_end:f.consensus_end;
    if(start==null||end==null||!Number.isFinite(start)||!Number.isFinite(end))continue;
    rows.set(f.family,{...f,consensus_start:start,consensus_end:end});
  }return [...rows.values()].filter(f=>!f.superseded_by_manual);
}
export function familyCount(f:CatalogFamily){return f.manual?(f.effective_call_ids?.length??0):f.classification_counts
  ?Object.values(f.classification_counts).reduce((n,r)=>n+(f.stage?r.compatible_calls:r.primary_calls),0)
  :Object.values(f.rates_by_strand??{}).reduce((n,r)=>n+r.after_sr_assignments,0);}
/** Short, deterministic display names. Internal model IDs remain available in
 * technical details and data attributes, but are not used as primary labels. */
// Class numbers per run and dataset, fixed the first time the classes are
// shown: assignment stringency changes which calls a class holds (and so its
// span), which must not renumber the classes.
const CLASS_NUMBERS_KEY='fiberbrowser_class_numbers';
// Kept across reloads (Saved entries keep the names they were saved with).
const frozenClassNumbers=new Map<string,Map<string,number>>((()=>{
  try{return Object.entries(JSON.parse(localStorage.getItem(CLASS_NUMBERS_KEY)??'{}') as Record<string,Record<string,number>>)
    .map(([key,value])=>[key,new Map(Object.entries(value))] as [string,Map<string,number>]);}catch{return [];}
})());
function persistClassNumbers(){
  try{
    // The 50 most recent runs.
    const entries=[...frozenClassNumbers.entries()].slice(-50);
    localStorage.setItem(CLASS_NUMBERS_KEY,JSON.stringify(Object.fromEntries(entries.map(([key,value])=>[key,Object.fromEntries(value)]))));
  }catch{/* storage unavailable: numbers still hold for this page */}
}
export function stateDisplayName(dataset:ConsensusCatalog['datasets'][string]|undefined,family:string,run?:{jobId:string;datasetId:string}):string{
  const rows=displayFamilies(dataset).sort((a,b)=>a.consensus_start-b.consensus_start||a.consensus_end-b.consensus_end||a.family.localeCompare(b.family));
  const row=rows.find(value=>value.family===family);
  if(row?.label)return row.label;
  if(run){
    const key=`${run.jobId}\t${run.datasetId}`;
    let numbers=frozenClassNumbers.get(key);
    if(!numbers){numbers=new Map();frozenClassNumbers.set(key,numbers);}
    // Classes not numbered yet (first view, or new manual groups) follow the existing ones.
    let added=false;
    for(const value of rows)if(!numbers.has(value.family)){numbers.set(value.family,numbers.size+1);added=true;}
    if(added)persistClassNumbers();
    const number=numbers.get(family);
    return number!=null?`Class ${number}`:'Class';
  }
  const index=rows.findIndex(value=>value.family===family);
  return index>=0?`Class ${index+1}`:'Class';
}
export interface FamilyRef {jobId:string;datasetId:string;family:string}
export const familyRefKey=(value:Pick<FamilyRef,'datasetId'|'family'>)=>JSON.stringify([value.datasetId,value.family]);
function familyDataset(catalog:ConsensusCatalog|null,family:string,explicit?:string):string|null{
  if(explicit)return explicit;
  const ids=Object.keys(catalog?.datasets??{}).filter(id=>catalog!.datasets[id].catalog.some(f=>f.family===family));
  return ids.length===1?ids[0]:null;
}
export function comparableFamilyRefs(catalog:ConsensusCatalog|null):Set<string>{
  const keys=new Set<string>();
  for(const edge of catalog?.edges??[]){
    if(!edge.comparability_mask&&!(catalog?.cr_mode==='staged_native_families'&&edge.shared_hypothesis))continue;
    const left=familyDataset(catalog,edge.left_family,edge.left_dataset),right=familyDataset(catalog,edge.right_family,edge.right_dataset);
    if(!left||!right)continue;
    keys.add(familyRefKey({datasetId:left,family:edge.left_family}));keys.add(familyRefKey({datasetId:right,family:edge.right_family}));
  }return keys;
}
/** Dataset-qualified direct edges only. Ambiguous legacy IDs fail closed. */
export function relatedFamilyRefs(selections:FamilyRef[],catalog:ConsensusCatalog|null,jobId:string|null):Set<string>{
  const own=selections.filter(s=>s.jobId===jobId);const keys=new Set(own.map(familyRefKey));
  for(const edge of catalog?.edges??[]){
    if(!edge.comparability_mask&&!(catalog?.cr_mode==='staged_native_families'&&edge.shared_hypothesis))continue;
    const left=familyDataset(catalog,edge.left_family,edge.left_dataset),right=familyDataset(catalog,edge.right_family,edge.right_dataset);
    if(!left||!right)continue;
    const a={datasetId:left,family:edge.left_family},b={datasetId:right,family:edge.right_family};
    if(own.some(s=>familyRefKey(s)===familyRefKey(a)))keys.add(familyRefKey(b));
    if(own.some(s=>familyRefKey(s)===familyRefKey(b)))keys.add(familyRefKey(a));
  }return keys;
}
/** Pack the frozen full catalog, not just the viewport: lanes do not jump on pan.
 * Nothing is merged or capped; all overlapping/nested glyphs get a clickable lane.
 */
export function packFamilies(families:CatalogFamily[]){
  const ends:number[]=[];
  return [...families].sort((a,b)=>a.consensus_start-b.consensus_start||b.consensus_end-a.consensus_end||a.family.localeCompare(b.family))
    .map(f=>{let lane=ends.findIndex(end=>end<=f.consensus_start);if(lane<0)lane=ends.length;
      ends[lane]=f.consensus_end;return {...f,lane};});
}
export function relatedFamilies(family:string|null,catalog:ConsensusCatalog|null):Set<string>{
  const ids=new Set<string>();if(!family)return ids;ids.add(family);
  for(const e of catalog?.edges??[])if(e.comparability_mask||(catalog?.cr_mode==='staged_native_families'&&e.shared_hypothesis)){
    if(e.left_family===family)ids.add(e.right_family);if(e.right_family===family)ids.add(e.left_family);
  }return ids;
}
export function trackX(position:number,start:number,end:number,width:number,sidebar=0,reversed=false){
  const fraction=(position-start)/(end-start);return sidebar+(reversed?1-fraction:fraction)*Math.max(0,width-sidebar);
}
