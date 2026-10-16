import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { usePanOffsetTransform } from './usePanOffsetTransform';
import { useEphemeralStore } from '../stores/ephemeralStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ scope, testId }: { scope?: string; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  usePanOffsetTransform(ref, scope ? { scope } : {});
  return <div ref={ref} data-testid={testId} />;
}

afterEach(() => {
  act(() => useEphemeralStore.getState().resetPanState());
  document.body.innerHTML = '';
});

describe('usePanOffsetTransform scopes', () => {
  it('slides only the views of the dragged scope', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<><Probe testId="main" /><Probe testId="own" scope="panel:p2" /></>));
    const main = host.querySelector('[data-testid="main"]') as HTMLElement;
    const own = host.querySelector('[data-testid="own"]') as HTMLElement;
    act(() => useEphemeralStore.getState().setPanOffset(-40, 'panel:p2'));
    expect(own.style.transform).toContain('-40px');
    expect(main.style.transform).toBe('');
    act(() => useEphemeralStore.getState().setPanOffset(25));
    expect(main.style.transform).toContain('25px');
    expect(own.style.transform).toBe('');
    act(() => root.unmount());
  });
});
