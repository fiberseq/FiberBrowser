import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { useBrowserStore } from '../stores/browserStore';
import { PanelDisplayContext, usePanelDisplayStore } from './usePanelDisplayStore';

it('each track sees its own direction and follows global Reverse in linked mode', () => {
  useBrowserStore.setState({ isReversed: false, navigationMode: 'perPanel', panels: [
    { id: 'a', reversed: false }, { id: 'b', reversed: true },
  ] as never });
  function Track() { const reverse = usePanelDisplayStore(s => s.isReversed); return <span>{reverse ? 'reverse' : 'forward'}</span>; }
  const div = document.createElement('div'), root = createRoot(div);
  act(() => root.render(<><PanelDisplayContext.Provider value="a"><Track /></PanelDisplayContext.Provider>
    <PanelDisplayContext.Provider value="b"><Track /></PanelDisplayContext.Provider></>));
  expect(div.textContent).toBe('forwardreverse');
  act(() => useBrowserStore.getState().setPanelReversed('a', true));
  expect(div.textContent).toBe('reversereverse');
  act(() => useBrowserStore.setState({ navigationMode: 'linked' }));
  expect(div.textContent).toBe('forwardforward');
  act(() => root.unmount());
});
