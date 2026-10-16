import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { hasPanelIcon, PanelIcon } from './panelIcons';
import { getAllAnalysisPanels } from '../../plugins/registry';
import '../../plugins/builtinPanels';
import * as Icons from './Icons';

// fb-n6-icons: every built-in panel has its own icon, no two alike, drawn at the panel-icon size.
describe('PanelIcon', () => {
  const types = getAllAnalysisPanels().map(p => p.contentType);
  const markup = (contentType: string, size?: number) => renderToStaticMarkup(<PanelIcon contentType={contentType} size={size} />);

  it('gives every built-in panel an icon, each one different', () => {
    expect(types.length).toBeGreaterThanOrEqual(16);
    for (const t of types) expect(hasPanelIcon(t), t).toBe(true);
    // (A plugin pack's panel may reuse a built-in icon on purpose: built-in panels only here.)
    const shapes = types.map(t => markup(t));
    expect(new Set(shapes).size).toBe(types.length);
  });

  it('is decorative (the chip or header names the panel) and 16 px by default', () => {
    const html = markup('footprint-analysis');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width="16"');
    expect(markup('footprint-analysis', 14)).toContain('width="14"');
  });

  it('draws Footprints as a footprint, Clusters as clumps, Tracks as a signal track and Co-accessibility as an open gap', () => {
    const same = (t: string, Icon: (p: { size?: number }) => JSX.Element) =>
      expect(markup(t, 20)).toBe(renderToStaticMarkup(<Icon size={20} aria-hidden="true" focusable="false" />));
    same('footprint-analysis', Icons.Footprint);
    same('cluster-detail', Icons.ReadClusters);
    same('track-browser', Icons.SignalTrack);
    same('co-accessibility', Icons.NucleosomeFree);
  });

  it('draws nothing for an unknown panel type', () => {
    expect(hasPanelIcon('nope')).toBe(false);
    expect(markup('nope')).toBe('');
  });
});
