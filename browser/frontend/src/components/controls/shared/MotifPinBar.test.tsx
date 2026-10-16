import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBrowserStore } from '../../../stores/browserStore';
import { MotifPinBar } from './MotifPinBar';

describe('MotifPinBar: the shared threshold says its scope (N23)', () => {
  it('shows "shared across motif views" and names where Relax goes', () => {
    useBrowserStore.setState({ motifScoreMode: 'p', motifPValue: 1e-4 } as never);
    const html = renderToStaticMarkup(<MotifPinBar pinned={[]} onPin={() => {}} query="" onQuery={() => {}} zeroHits={['Kr']} scoring={false} testIdPrefix="m" />);
    expect(html).toContain('data-testid="m-threshold-scope"');
    expect(html).toContain('shared across motif views');
    expect(html).toMatch(/data-testid="m-relax"[^>]*>· Relax to p ≤ 0\.001</);
    expect(html).not.toContain('Relax threshold');
  });
});
