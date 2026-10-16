import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {describe,it,expect} from 'vitest';
import {useBrowserStore} from '../../../../stores/browserStore';
import {UiScaleSettings} from './UiScaleSettings';

describe('figure UI size',()=>{
  it('supports large scale values and a compact reset',()=>{
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
    const div=document.createElement('div'),root=createRoot(div);
    const before=useBrowserStore.getState().uiScale;
    try{
      act(()=>root.render(<UiScaleSettings/>));
      expect(div.querySelector('input[type="range"]')?.getAttribute('max')).toBe('400');
      expect(div.querySelectorAll('button')).toHaveLength(1);
      act(()=>useBrowserStore.getState().setUiScale(4));
      expect(useBrowserStore.getState().uiScale).toBe(4);
      expect(div.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('400');
      act(()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='Reset (100%)')!.click());
      expect(useBrowserStore.getState().uiScale).toBe(1);
    }finally{act(()=>root.unmount());useBrowserStore.getState().setUiScale(before);}
  });
  it('clamps extremes and rejects non-finite scale values',()=>{
    const {setUiScale}=useBrowserStore.getState();
    setUiScale(10);expect(useBrowserStore.getState().uiScale).toBe(4);
    setUiScale(.1);expect(useBrowserStore.getState().uiScale).toBe(.5);
    setUiScale(NaN);expect(useBrowserStore.getState().uiScale).toBe(1);
  });
});
