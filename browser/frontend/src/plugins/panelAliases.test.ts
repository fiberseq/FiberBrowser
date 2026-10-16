import { describe, expect, it } from 'vitest';
import { canonicalPanelType, findOpenAnalysisPanel, getAnalysisPanel, isAnalysisPanel, migratePanelAliases, normalizeAnalysisPanelContentTypes, registerAnalysisPanel, registerPanelAlias } from './registry';

describe('panel aliases: an old panel name redirects to the new one', () => {
  registerAnalysisPanel({ contentType: 'alias-test-new', label: 'New name', headerColor: '#000', component: () => null });
  registerPanelAlias('alias-test-old', 'alias-test-new');

  it('the registry answers to the old name', () => {
    expect(getAnalysisPanel('alias-test-old')?.contentType).toBe('alias-test-new');
    expect(isAnalysisPanel('alias-test-old')).toBe(true);
    expect(canonicalPanelType('alias-test-old')).toBe('alias-test-new');
    expect(canonicalPanelType('read-stats')).toBe('read-stats');
    expect(normalizeAnalysisPanelContentTypes(['alias-test-old', 'alias-test-new', 'nope'])).toEqual(['alias-test-new']);
    expect(findOpenAnalysisPanel([{ id: 'p', contentType: 'alias-test-new' }], 'alias-test-old')?.id).toBe('p');
  });

  it('migrates old panels, keeping their ids and fields, leaving others alone', () => {
    const out = migratePanelAliases([
      { id: 'panel-old', contentType: 'alias-test-old', extra: { x: 1 } } as never,
      { id: 'panel-x', contentType: 'dataset' } as never,
    ]);
    expect(out[0]).toEqual({ id: 'panel-old', contentType: 'alias-test-new', extra: { x: 1 } });
    expect(out[1]).toEqual({ id: 'panel-x', contentType: 'dataset' });
  });
});
