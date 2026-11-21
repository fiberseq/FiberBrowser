import { expect, it, vi } from 'vitest';
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { enrichNativeRows } from './api';
import type { CompactRead } from '../../components/tracks/read-track/types';
vi.mock('../../api/sharedFetch', () => ({fetchJson: vi.fn()}));

it('enriches every requested row across the server row budget', async () => {
  useBrowserStore.setState({liveLiftExpansions:{}});
  vi.mocked(fetchJson).mockImplementation(async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    return {complete: true, blocks: body.row_ids.map((id: string) => ({
      row_id: id, record_id: id, length: 100, covered: [0,100],
    }))} as any;
  });
  const reads = Array.from({length: 501}, (_, i) => ({id: `row-${i}`, record_sha256: `row-${i}`, intervals: []})) as CompactRead[];
  const result = await enrichNativeRows(reads, {dataset_id:'native',chrom:'chr1',start:0,end:1000},
    [{ins_id:'alternate',chrom:'chr1',pos:500,length:100,label:'',hap_label:''}], [], false);
  expect(vi.mocked(fetchJson).mock.calls.map(c => JSON.parse(c[1]!.body as string).row_ids.length)).toEqual([500,1]);
  expect(result.every(r => r.alternate_blocks?.alternate)).toBe(true);
});


it('keeps identical records in separate declared libraries attached to their own row', async () => {
  vi.mocked(fetchJson).mockResolvedValue({complete:true,blocks:[
    {row_id:'shared',record_id:'same-sam',alignment_id:'library-one',length:100},
    {row_id:'shared',record_id:'same-sam',alignment_id:'library-two',length:100},
  ]});
  const rows=[{id:'shared',record_sha256:'same-sam',analysis_id:'library-one',intervals:[]},
    {id:'shared',record_sha256:'same-sam',analysis_id:'library-two',intervals:[]}] as CompactRead[];
  const result=await enrichNativeRows(rows,{dataset_id:'native',chrom:'chr1',start:0,end:1000},
    [{ins_id:'alternate',chrom:'chr1',pos:500,length:100,label:'',hap_label:''}],[],false);
  expect(result.map(r=>(r.alternate_blocks?.alternate as any)?.alignment_id)).toEqual(['library-one','library-two']);
});
