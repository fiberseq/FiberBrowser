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
