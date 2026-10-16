import { beforeEach, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { rigidMatchedRegions } from './matchedRegions';
import { selectedAnalysisWindows } from './regionAnalysis';
import { resolveClassRegion } from './classRegion';

beforeEach(()=>{
  useBrowserStore.setState({chrom:'chr1',start:0,end:500,peakRules:[],peaksByRule:{},selectedPeaks:new Set(),panels:[
    {id:'p1',datasetId:'a',contentType:'dataset'},
    {id:'p2',datasetId:'b',contentType:'dataset',genome:'other',viewportOverride:{chrom:'chr2',start:1000,end:2000}},
  ]} as never);
  const s=useBrowserStore.getState();
  const id=s.upsertMatchedGroup({name:'Pair',regions:rigidMatchedRegions([
    {index:0,start:100,end:300,chrom:'chr1',layer:0}, {index:1,start:1200,end:1400,chrom:'chr2',genome:'other',layer:0},
  ],'chr1')});
  s.selectMatchedGroup(id);
});

it('sends equal-width windows with each dataset, reference and orientation',()=>{
  const s=useBrowserStore.getState(); s.reverseMatchedRegion(s.getAllPeaks()[1].index);
  const plan=selectedAnalysisWindows(useBrowserStore.getState(),['a','b']);
  expect(plan.error).toBeNull();
  expect(plan.windows).toMatchObject([{dataset_id:'a',genome:null,start:100,end:300,strand:'+'},{dataset_id:'b',genome:'other',chrom:'chr2',start:1200,end:1400,strand:'-'}]);
});
it('does not silently omit a partner in an untargeted panel',()=>{
  expect(selectedAnalysisWindows(useBrowserStore.getState(),['a']).error).toContain('No targeted panel');
});
it('refuses a gapped frame without a shared-block recovery',()=>{
  const s=useBrowserStore.getState();const p=s.getAllPeaks()[0];
  p.match!.blocks=[{frame:[0,90],genomic:[100,190]},{frame:[100,200],genomic:[200,300]}];
  const plan=selectedAnalysisWindows(s,['a','b']);
  expect(plan.error).toBe('No shared block is long enough. Lower Minimum aligned length or select another group.');
  expect(plan.windows).toEqual([]);
  expect(plan.recovery).toBeUndefined();
});
it('an empty selection never falls back to analysing the view',()=>{
  useBrowserStore.setState({selectedPeaks:new Set()});
  expect(selectedAnalysisWindows(useBrowserStore.getState(),['a']).error).toContain('Select one');
  expect(resolveClassRegion({mode:'matched',view:{chrom:'chr1',start:0,end:100,genome:null},peaks:null,peakCount:0,saved:null,pinned:null})).toBeNull();
});
