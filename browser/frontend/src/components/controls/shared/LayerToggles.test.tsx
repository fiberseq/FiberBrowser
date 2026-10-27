import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useBrowserStore} from '../../../stores/browserStore';
import {useConsensusViewStore} from '../../../stores/consensusViewStore';
import {LayerToggles} from './LayerToggles';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;

describe('population-state layer toggles',()=>{
  let container:HTMLDivElement,root:Root;
  beforeEach(()=>{
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
    useBrowserStore.setState({datasets:[{id:'d',label:'D',path:'/tmp/d.bam',data_type:'bam',
      available_layers:{tf_cr:true,tf_cr_manual:true},derived_layers:{
        tf_cr:{label:'Population footprint states'},tf_cr_manual:{label:'Manual footprint groups'}}}],
      enabledModTypes:{tf_cr:true,tf_cr_manual:false}} as any);
    useConsensusViewStore.setState({latticeEnabled:false});
  });
  afterEach(()=>{act(()=>root.unmount());container.remove();});

  it('keeps classes in the main bar and diagnostics collapsed under Advanced layers',()=>{
    act(()=>root.render(<LayerToggles compact/>));
    const lattice=container.querySelector<HTMLInputElement>('[data-testid="layer-checkbox-native-lattice"]')!;
    expect(lattice).toBeTruthy();expect(lattice.checked).toBe(false);
    expect(lattice.closest('details')?.open).toBe(false);
    expect(container.querySelector('[data-testid="layer-checkbox-tf_cr"]')?.closest('details')).toBeNull();
    expect(container.querySelector('[data-testid="layer-checkbox-tf_cr_manual"]')?.closest('details')).toBeTruthy();
    act(()=>lattice.click());
    expect(useConsensusViewStore.getState().latticeEnabled).toBe(true);
  });

  it('keeps automatic and manual state displays mutually exclusive',()=>{
    act(()=>root.render(<LayerToggles compact/>));
    const manual=container.querySelector<HTMLInputElement>('[data-testid="layer-checkbox-tf_cr_manual"]')!;
    act(()=>manual.click());
    expect(useBrowserStore.getState().enabledModTypes.tf_cr_manual).toBe(true);
    expect(useBrowserStore.getState().enabledModTypes.tf_cr).toBe(false);
    const automatic=container.querySelector<HTMLInputElement>('[data-testid="layer-checkbox-tf_cr"]')!;
    act(()=>automatic.click());
    expect(useBrowserStore.getState().enabledModTypes.tf_cr).toBe(true);
    expect(useBrowserStore.getState().enabledModTypes.tf_cr_manual).toBe(false);
  });
});

describe('nucleosome layer toggles',()=>{
  let container:HTMLDivElement,root:Root;
  beforeEach(()=>{
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
    useBrowserStore.setState({datasets:[{id:'d',label:'D',path:'/tmp/d.bam',data_type:'bam',
      available_layers:{nuc:true,tf:true,nucsz:true,nucseg:true,nucmol:true,nfrmol:true},derived_layers:{
        nucsz:{id:'nucsz',label:'Nucleosome size classes',color:'#16a34a',kind:'nuc-live',source_layer:'nuc'},
        nucseg:{id:'nucseg',label:'Nucleosome array segments',color:'#15803d',kind:'nuc-live',source_layer:'nuc'},
        nucmol:{id:'nucmol',label:'Nucleosome scalars',kind:'scan-overlay'}}}],
      enabledModTypes:{nuc:true,tf:true,nucsz:false,nucseg:true}} as any);
    useConsensusViewStore.setState({latticeEnabled:false});
  });
  afterEach(()=>{act(()=>root.unmount());container.remove();});

  it('groups size classes and array segments under one Nucleosomes entry in the main bar',()=>{
    act(()=>root.render(<LayerToggles compact/>));
    const group=container.querySelector('[data-testid="nucleosome-layer-group"]')!;
    expect(group).toBeTruthy();
    expect(group.closest('details')).toBeNull();
    expect(group.textContent).toContain('Nucleosomes');
    const sizes=group.querySelector<HTMLInputElement>('[data-testid="layer-checkbox-nucsz"]')!;
    const segments=group.querySelector<HTMLInputElement>('[data-testid="layer-checkbox-nucseg"]')!;
    expect(sizes.getAttribute('aria-label')).toBe('Size classes layer');
    expect(segments.getAttribute('aria-label')).toBe('Array segments layer');
    expect(sizes.checked).toBe(false);expect(segments.checked).toBe(true);
    // Each appears once: not again as a flat (advanced or derived) checkbox.
    expect(container.querySelectorAll('[data-testid="layer-checkbox-nucsz"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="layer-checkbox-nucseg"]')).toHaveLength(1);
    act(()=>sizes.click());
    expect((useBrowserStore.getState().enabledModTypes as Record<string,boolean>).nucsz).toBe(true);
  });

  it('never offers per-molecule scalar groups as layers',()=>{
    act(()=>root.render(<LayerToggles compact/>));
    expect(container.querySelector('[data-testid="layer-checkbox-nucmol"]')).toBeNull();
    expect(container.querySelector('[data-testid="layer-checkbox-nfrmol"]')).toBeNull();
    expect(container.textContent).not.toContain('scalars');
  });

  it('shows no group for datasets without nucleosome layers',()=>{
    useBrowserStore.setState({datasets:[{id:'d',label:'D',path:'/tmp/d.bam',data_type:'bam',available_layers:{nuc:true,tf:true,nucmol:true}}]} as any);
    act(()=>root.render(<LayerToggles compact/>));
    expect(container.querySelector('[data-testid="nucleosome-layer-group"]')).toBeNull();
    expect(container.querySelector('[data-testid="layer-checkbox-nucmol"]')).toBeNull();
    expect(container.querySelector('[data-testid="layer-checkbox-nuc"]')).toBeTruthy();
  });
});
