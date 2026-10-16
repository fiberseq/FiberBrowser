import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getAllAnalysisPanels } from '../../plugins/registry';
import '../../plugins/builtinPanels';
import { hasPanelIcon, PanelIcon } from '../../components/ui/panelIcons';
import { registerSync } from './register';

// The rail drew Synchronise regions as an empty teal tile: it registered no icon.
describe('Synchronise regions icon', () => {
  registerSync();
  const markup = (contentType: string) => renderToStaticMarkup(<PanelIcon contentType={contentType} size={16} />);

  it('is registered with the panel and drawn on the shared grid and stroke', () => {
    expect(hasPanelIcon('sync-regions')).toBe(true);
    const html = markup('sync-regions');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('looks like no other panel', () => {
    const others = getAllAnalysisPanels().map(p => p.contentType).filter(t => t !== 'sync-regions' && hasPanelIcon(t));
    expect(others.map(markup)).not.toContain(markup('sync-regions'));
  });
});
