import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReadDepthControls } from './ReadDepthControls';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('shows off defaults, updates integer caps and hides unsupported controls', () => {
  const host=document.createElement('div'); const root=createRoot(host); const change=vi.fn();
  act(()=>root.render(<ReadDepthControls prefix="test" values={{}} supported onChange={change}/>));
  const inputs=host.querySelectorAll('input');
  expect([...inputs].map(i=>i.value)).toEqual(['0','0','1']);
  expect(host.textContent).toContain('2000 is a good cap');
  act(()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(inputs[0],'2000');
    inputs[0].dispatchEvent(new Event('input',{bubbles:true}));
  });
  expect(change).toHaveBeenCalledWith('max_discovery_molecules',2000);
  act(()=>root.render(<ReadDepthControls prefix="test" values={{max_discovery_molecules:2000}} supported={false} onChange={change}/>));
  expect(host.querySelector('input')).toBeNull(); expect(host.textContent).toContain('Update FiberHMM');
  act(()=>root.unmount());
});
