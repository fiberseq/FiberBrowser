import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {strandRows,StagedStrandComparison} from './StagedStrandComparison';

const counts=(units:number,eligible:number)=>({original_calls:units,primary_calls:units,compatible_calls:units,primary_units:units,compatible_units:units,eligible_units:eligible});
const catalog:any={cr_mode:'staged_native_families',region:{chrom:'chr2L'},edges:[],datasets:{d:{catalog:[
  {family:'A',consensus_start:100,consensus_end:140,stage:'resolved',classification_counts:{'d::CT':counts(40,100),'d::GA':counts(42,100)}},
  {family:'B',consensus_start:200,consensus_end:260,stage:'resolved',classification_counts:{'d::CT':counts(50,100),'d::GA':counts(10,100)}},
  {family:'C',consensus_start:300,consensus_end:320,stage:'resolved',classification_counts:{'d::CT':counts(2,100),'d::GA':counts(1,100)}},
  {family:'D',consensus_start:400,consensus_end:420,stage:'resolved',classification_counts:{'d::CT':counts(5,50)}},
]}}};

describe('staged strand comparison',()=>{
  it('compares the two strands per class, flags bias and too-few detections',()=>{
    const rows=strandRows(catalog,'job-strands');
    expect(rows.map(r=>[r.left.channel,r.right.channel,r.agreement])).toEqual([
      ['CT','GA','similar'],['CT','GA','discordant'],['CT','GA','low'],['CT','GA','unavailable']]);  // D: one strand only
    expect(rows[1].difference).toBeCloseTo(-.4);
  });
  it('renders a row per class instead of the harmonization placeholder',()=>{
    const html=renderToStaticMarkup(<StagedStrandComparison catalog={catalog} jobId="job-strands"/>);
    expect(html.match(/data-testid="strand-row"/g)).toHaveLength(4);
    expect(html).toContain('No reads on one strand');
    expect(html).toContain('Strand-biased');expect(html).toContain('-40.0 pp');
  });
});
