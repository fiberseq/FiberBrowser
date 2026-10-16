import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesignRunControls, designDisabledReason } from './DesignRunControls';
import { primerTargetOverlayVisible } from './primerTargetOverlay';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  mode: 'standard' as const, designing: false, peakCount: 2, hasFastaReady: true,
  hasBlastDb: true, hasSplitView: false, targetTooLarge: false,
};

describe('Design Primers says why it is disabled (M13)', () => {
  it('names the missing step in plain words', () => {
    expect(designDisabledReason({ ...base, hasBlastDb: false })).toBe('Build or choose a BLAST database first (above).');
    expect(designDisabledReason({ ...base, peakCount: 0 })).toMatch(/Select one or more peaks/);
    expect(designDisabledReason({ ...base, hasFastaReady: false })).toMatch(/reference FASTA/);
    expect(designDisabledReason({ ...base, mode: 'dafc' })).toMatch(/split view/);
    expect(designDisabledReason(base)).toBeNull();
  });

  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('the disabled button carries the reason as its tooltip and beside it', () => {
    const noop = () => {};
    act(() => root.render(
      <DesignRunControls
        {...base} hasBlastDb={false} canDesign={false}
        progressMessage="" progressPercent={0} error={null} blastWarning={null}
        onDesignPrimers={noop} onDesign4c={noop} onDesignDafc={noop} onAbort={noop} onClearError={noop} onClearBlastWarning={noop}
      />,
    ));
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Design Primers')!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Build or choose a BLAST database first (above).');
    expect(container.querySelector('[data-testid="primer-design-disabled-reason"]')?.textContent).toBe('Build or choose a BLAST database first (above).');
  });
});

describe('primer target box on the ruler (M13)', () => {
  it('is drawn only while the Primers panel is open', () => {
    expect(primerTargetOverlayVisible([{ contentType: 'dataset', collapsed: false }])).toBe(false);
    expect(primerTargetOverlayVisible([{ contentType: 'primer-design', collapsed: true }])).toBe(false);
    expect(primerTargetOverlayVisible([{ contentType: 'primer-design', collapsed: false }])).toBe(true);
  });
});
