import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetRememberedState, useRememberedState } from './useRememberedState';
import { useBrowserStore } from '../stores/browserStore';
import '../plugins/builtinPanels';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let setTab: (tab: string) => void = () => {};
function Probe() {
  const [tab, set] = useRememberedState<string>('cluster-detail:tab', () => 'overview');
  setTab = set;
  return <span data-testid="tab">{tab}</span>;
}

describe('panel UI state across a remount', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); forgetRememberedState('cluster-detail'); });

  it('a panel moved between the row and the side drawer keeps its tab', async () => {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { setTab('composition'); });
    // Moving the panel mounts it again (a different parent in the layout).
    await act(async () => { root.render(<div><Probe /></div>); });
    expect(container.textContent).toBe('composition');
  });

  it('closing the panel forgets it, so it opens as usual next time', async () => {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { setTab('composition'); });
    await act(async () => { root.render(<></>); });
    useBrowserStore.setState({ panels: [{ id: 'panel-cluster-detail', contentType: 'cluster-detail', datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }] } as never);
    useBrowserStore.getState().closeAnalysisPanel('panel-cluster-detail');
    await act(async () => { root.render(<Probe />); });
    expect(container.textContent).toBe('overview');
  });

  it('a pending "open on this tab" request wins over the remembered tab', async () => {
    function Requested() {
      const [tab] = useRememberedState<string>('cluster-detail:tab', () => {
        const requested = sessionStorage.getItem('req-key');
        sessionStorage.removeItem('req-key');
        return requested ?? 'overview';
      }, 'req-key');
      return <span>{tab}</span>;
    }
    await act(async () => { root.render(<Probe />); });
    await act(async () => { setTab('composition'); });
    sessionStorage.setItem('req-key', 'saved');
    await act(async () => { root.render(<div><Requested /></div>); });
    expect(container.textContent).toBe('saved');
  });

  it('a request the open panel already handled does not win again at the next remount', async () => {
    function Requested() {
      const [tab, set] = useRememberedState<string>('cluster-detail:tab', () => 'overview', 'req-key2');
      setTab = set;
      return <span>{tab}</span>;
    }
    await act(async () => { root.render(<Requested />); });
    // A request arrives while the panel is open (it also gets an event and shows that tab)…
    sessionStorage.setItem('req-key2', 'saved');
    await act(async () => { setTab('saved'); });
    // …then the user picks another tab, and the panel is remounted.
    await act(async () => { setTab('composition'); });
    await act(async () => { root.render(<div><Requested /></div>); });
    expect(container.textContent).toBe('composition');
    expect(sessionStorage.getItem('req-key2')).toBeNull();
  });
});
