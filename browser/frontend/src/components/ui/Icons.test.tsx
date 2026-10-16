import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Icons from './Icons';

// Every icon is drawn on one grid (24x24, round 2px stroke, currentColor) so they
// sit together in toolbars and panel headers. BrandMark is the one multi-colour mark.
const MULTI_COLOUR = new Set(['BrandMark']);

describe('Icons', () => {
  const entries = Object.entries(Icons) as [string, (p: { size?: number }) => JSX.Element][];

  it('exports the domain icons the UI uses', () => {
    for (const name of ['Fiber', 'Reads', 'Nucleosome', 'TfFootprint', 'AccessibleColumn', 'FootprintClasses',
      'CoOccupancy', 'CoAccess', 'ReadClusters', 'Plasmid', 'Server', 'Dna', 'Chromosome', 'BrandMark',
      'Footprint', 'NucleosomeFree', 'SignalTrack']) {
      expect(Icons).toHaveProperty(name);
    }
  });

  it.each(entries.filter(([name]) => !MULTI_COLOUR.has(name)))('%s follows the shared grid', (_name, Icon) => {
    const html = renderToStaticMarkup(<Icon size={20} />);
    expect(html).toMatch(/^<svg /);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('width="20"');
    // Colour only through currentColor: no hard-coded hex or rgb fills/strokes.
    expect(html).not.toMatch(/(fill|stroke)="(#|rgb)/);
    expect(html).toMatch(/(stroke|fill)="currentColor"/);
    const strokeWidth = html.match(/stroke-width="([\d.]+)"/);
    if (strokeWidth) expect(strokeWidth[1]).toBe('2');
  });

  it('BrandMark keeps the app icon colours and unique gradient ids', () => {
    const html = renderToStaticMarkup(<><Icons.BrandMark size={24} /><Icons.BrandMark size={24} /></>);
    // The tile, nucleosome, TF and accessible-column colours of public/assets/icons/favicon.svg.
    for (const colour of ['#2a4fb5', '#0f1a3d', '#6fd67b', '#fb8bff', '#9fdcf5']) expect(html).toContain(colour);
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });
});
