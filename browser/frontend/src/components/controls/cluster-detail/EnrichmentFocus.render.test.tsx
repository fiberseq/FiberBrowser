import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColorRule } from '../../../types';
import { EnrichmentTabContent } from './EnrichmentTabContent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Enrichment with a cluster focus', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  it('still plots a rule that tells the focused cluster apart from a hidden one', () => {
    const rules = [{ id: 'r1', name: 'Pol II', enabled: true }] as ColorRule[];
    const data = new Map([['r1', new Map([[0, { matched: 20, total: 20 }], [1, { matched: 0, total: 20 }]])]]);
    const c0 = { cluster: 0, color: '#f00', counts: [20], totalCount: 20 };
    const c1 = { cluster: 1, color: '#0f0', counts: [20], totalCount: 20 };
    act(() => root.render(
      <EnrichmentTabContent enrichmentData={data} enrichmentLoading={false} enabledRules={rules} clusterData={[c0]} allClusterData={[c0, c1]} containerWidth={480} />,
    ));
    expect(container.textContent).not.toContain('No labeling rule tells these clusters apart');
    expect(container.textContent).toContain('Cluster-vs-rest Fisher tests');
  });
});
