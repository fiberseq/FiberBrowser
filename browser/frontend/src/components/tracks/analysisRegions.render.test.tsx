import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { HighlightBands } from './HighlightBands';
import { useBrowserStore } from '../../stores/browserStore';
import { useAnalysisRegionStore } from '../../stores/analysisRegionStore';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it('places analysis outlines on their own chromosome, reference and dataset',()=>{
  useBrowserStore.setState({chrom:'chr1',start:0,end:1000,currentGenome:'hg38',fastaPath:null,isReversed:false,highlights:[]} as never);
  useAnalysisRegionStore.getState().set('analysis',[
    {chrom:'chr1',start:100,end:200,genome:null,genomeKey:'hg38',datasetIds:['d'],label:'Find classes',color:'#059669'},
    {chrom:'chr1',start:400,end:500,genome:'other',genomeKey:'other',datasetIds:['e'],label:'Partner',color:'#475569'},
  ]);
  const host=document.createElement('div');const root=createRoot(host);
  act(()=>root.render(<HighlightBands panel={{id:'p',datasetId:'d',contentType:'dataset'} as PanelConfig} width={400} gutter={0} labels />));
  const boxes=host.querySelectorAll<HTMLElement>('[data-testid="analysis-region-outline"]');
  expect(boxes).toHaveLength(1);expect(boxes[0].style.left).toBe('40px');expect(boxes[0].textContent).toBe('Find classes');
  expect(boxes[0].className).toContain('border-dashed');
  act(()=>root.unmount());useAnalysisRegionStore.getState().set('analysis',[]);
});
