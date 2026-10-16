import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDemo = vi.fn();
vi.mock('../../api/demo', () => ({ getDemo: () => getDemo(), loadDemo: vi.fn() }));

import { TutorialTourTab } from './TutorialTourTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const welcomeText = (container: HTMLElement) =>
  container.querySelector('[data-step-id="welcome"]')?.getAttribute('title') ?? '';

describe('TutorialTourTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    getDemo.mockReset();
  });

  it('lists the texts the tour shows on the demo when the server has it', async () => {
    getDemo.mockResolvedValue({
      available: true, label: 'NAPA', genome: 'hg38', dataset_id: 'napa_ddda',
      region: { chrom: 'chr19', start: 47_514_000, end: 47_518_000 },
    });
    await act(async () => { root.render(<TutorialTourTab />); });
    await act(async () => { await Promise.resolve(); });
    expect(welcomeText(container)).toContain('loads a small demo dataset');
    expect(welcomeText(container)).not.toContain('on the data you have loaded');
  });

  it('lists the loaded-data texts when there is no demo', async () => {
    getDemo.mockRejectedValue(new Error('403'));
    await act(async () => { root.render(<TutorialTourTab />); });
    await act(async () => { await Promise.resolve(); });
    expect(welcomeText(container)).toContain('on the data you have loaded');
  });
});
