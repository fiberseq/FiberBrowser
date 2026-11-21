/**
 * Named nucleosome classes were removed (owner, 20 Nov 2026). A saved session (or preset, or sort/filter rule snapshot)
 * whose rules set `nucNamed` loads with that condition dropped, the rest of each rule intact, and one short notice
 * with the number of conditions dropped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyImportedState } from './session';
import { useBrowserStore } from '../stores/browserStore';
import { DEFAULT_COLORMAP } from '../types';
import { migrateColormap, normalizeAnalysisSortRules } from '../stores/utils';
import { flushNucNamedNotice, nucNamedRemovedNotice, withoutNucNamed } from '../utils/nucNamedRemoval';

const session = { datasets: [], overlays: [], has_fasta: false, viewport: { chrom: 'chr1', start: 0, end: 500 } };
const savedRule = (id: string, extra: Record<string, unknown>) => ({
  id, name: id, color: '#ff0000', opacity: 1, sizeMin: 1, sizeMax: null, targetLayers: [], conditions: [], enabled: true,
  ...extra,
});
const settle = async () => { flushNucNamedNotice(); await vi.dynamicImportSettled(); await new Promise(r => setTimeout(r, 0)); };

afterEach(async () => {
  await settle();
  useBrowserStore.getState().setError(null);
});

describe('sessions with named nucleosome class rules', () => {
  it('drops nucNamed conditions on load, keeps the rest of each rule, and says so once', async () => {
    await settle();
    useBrowserStore.getState().setError(null);
    const colormap = {
      ...DEFAULT_COLORMAP,
      rules: [
        savedRule('octa', { nucNamed: [3], nucCoarse: [2], zMax: 1 }),
        savedRule('hexa', { nucNamed: [2, 4], nucTf: false }),
        savedRule('empty', { nucNamed: [] }),       // no condition: dropped silently
        savedRule('plain', { sizeMin: 90 }),
      ],
    };
    applyImportedState({ ...session, frontend: { activeColormap: colormap } });
    const rules = useBrowserStore.getState().activeColormap.rules;
    expect(rules.map(r => r.id)).toEqual(['octa', 'hexa', 'empty', 'plain']);
    expect(rules.every(r => !('nucNamed' in r))).toBe(true);
    expect(rules[0]).toMatchObject({ nucCoarse: [2], zMax: 1, color: '#ff0000', enabled: true });
    expect(rules[1]).toMatchObject({ nucTf: false });
    expect(rules[3]).toMatchObject({ sizeMin: 90 });
    await settle();
    expect(useBrowserStore.getState().error).toBe(nucNamedRemovedNotice(2));
    expect(nucNamedRemovedNotice(2)).toBe('Named nucleosome classes were removed; 2 rule conditions were dropped.');
    expect(nucNamedRemovedNotice(1)).toBe('Named nucleosome classes were removed; 1 rule condition was dropped.');
    // Idempotent: loading the migrated state again drops nothing more and raises no new notice.
    useBrowserStore.getState().setError(null);
    expect(migrateColormap(useBrowserStore.getState().activeColormap).rules.map(r => r.id)).toEqual(['octa', 'hexa', 'empty', 'plain']);
    await settle();
    expect(useBrowserStore.getState().error).toBeNull();
  });

  it('drops them from rule snapshots in sort terms too', async () => {
    useBrowserStore.getState().setError(null);
    const [sort] = normalizeAnalysisSortRules([{
      id: 's', name: 'Octasomes', enabled: true, metric: 'count', descending: true, scope: { kind: 'currentWindow' },
      terms: [{ id: 't', source: 'label', rule: savedRule('r', { nucNamed: [3], nucCoarse: [2] }) }],
    }]);
    expect(sort.terms[0].rule).toMatchObject({ nucCoarse: [2] });
    expect(sort.terms[0].rule).not.toHaveProperty('nucNamed');
    await settle();
    expect(useBrowserStore.getState().error).toBe(nucNamedRemovedNotice(1));
  });

  it('withoutNucNamed strips the snake_case spelling and leaves other objects alone', () => {
    const plain = { a: 1 };
    expect(withoutNucNamed(plain)).toBe(plain);
    expect(withoutNucNamed({ nuc_named: [3], nuc_coarse: [2] })).toEqual({ nuc_coarse: [2] });
    expect(withoutNucNamed(null)).toBeNull();
  });
});
