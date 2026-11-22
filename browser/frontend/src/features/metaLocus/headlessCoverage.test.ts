/**
 * Drift test: every meta-locus and Quantify setting the browser saves is handled by the headless path (figures,
 * re-clustering, quantify; browser/services/figure/meta_locus.py, browser/services/meta_locus_numbers.py,
 * browser/services/window_quant.py) or listed there as not drawn / not computed, with a reason. A new field in the
 * browser's session payload fails this test until the Python side says what it does with it. The rows hidden on the
 * meta contig are compared too (metaHiddenTrack vs meta_hidden_track).
 *
 * The Python side checks the other direction (tests/test_headless_meta_locus_drift.py): every field it says it
 * handles is actually read by its code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { metaLocusSessionPayload, useMetaLocusStore } from './metaLocusStore';
import { metaHiddenTrack } from './metaChrom';
import { DEFAULT_QUANT_SPEC } from '../windowQuant/spec';
import { emptyWindowQuant } from '../windowQuant/store';

const BROWSER = path.resolve(__dirname, '../../../..');
const py = (rel: string) => fs.readFileSync(path.join(BROWSER, rel), 'utf8');

/** The keys of a top-level Python dict literal `NAME = { "key": ..., ... }`. */
function pyDictKeys(source: string, name: string): Record<string, string> {
  const start = source.indexOf(`${name} = {`);
  expect(start, `${name} in the Python source`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*"([^"]+)":\s*(?:\(\s*)?"([^"]*)"/gm)) out[m[1]] = m[2];
  return out;
}

function covered(fields: string[], handled: Record<string, string>, skipped: Record<string, string>, what: string) {
  const missing = fields.filter(f => !(f in handled) && !(f in skipped));
  expect(missing, `${what}: handle these in the headless path or list them as not drawn, with a reason`).toEqual([]);
  for (const [f, reason] of Object.entries(skipped)) expect(reason.trim().length, `${what}: ${f} needs a reason`).toBeGreaterThan(8);
  const stale = [...Object.keys(handled), ...Object.keys(skipped)].filter(f => !fields.includes(f));
  expect(stale, `${what}: the browser no longer saves these; drop them from the Python tables`).toEqual([]);
}

describe('headless meta-locus and Quantify coverage', () => {
  it('handles or lists every field of the meta-locus session payload', () => {
    useMetaLocusStore.setState({
      spec: { bed_path: '/data/sites.bed', name: 'sites', anchor: 'start', flank_bp: 2000, dataset_ids: ['a'], policy: 'per_site', count_unit: 'observation' },
      seed: 3, count: 500, lastRealLocus: { chrom: 'chr1', start: 1, end: 2 },
      status: { pool_id: 'p1', name: 'sites', status: 'ready' },
      view: { extra_entries: [] } as never,
    });
    const payload = metaLocusSessionPayload();
    expect(payload).not.toBeNull();
    const src = py('services/figure/meta_locus.py');
    covered(Object.keys(payload!), pyDictKeys(src, 'SESSION_FIELDS_HANDLED'), pyDictKeys(src, 'SESSION_FIELDS_NOT_DRAWN'), 'frontend.metaLocus');
  });

  it('handles or lists every field of the session Quantify block and of the QuantSpec', () => {
    const numbers = py('services/meta_locus_numbers.py');
    covered(Object.keys(emptyWindowQuant()), pyDictKeys(numbers, 'WINDOW_QUANT_SESSION_HANDLED'),
      pyDictKeys(numbers, 'WINDOW_QUANT_SESSION_NOT_COMPUTED'), 'frontend.windowQuant');
    const twinSrc = py('services/window_quant.py');
    const block = twinSrc.slice(twinSrc.indexOf('DEFAULT_SPEC = {'), twinSrc.indexOf('}', twinSrc.indexOf('DEFAULT_SPEC = {')));
    const twin = Object.fromEntries([...block.matchAll(/"([A-Za-z]+)":/g)].map(m => [m[1], '']));
    const display = pyDictKeys(numbers, 'QUANT_SPEC_NOT_COMPUTED');
    const fields = Object.keys(DEFAULT_QUANT_SPEC);
    // Every QuantSpec field has a twin default (normalize_spec); the display-only ones say so.
    expect(fields.filter(f => !(f in twin)), 'QuantSpec fields missing from window_quant.DEFAULT_SPEC').toEqual([]);
    expect(Object.keys(twin).filter(f => !fields.includes(f)), 'window_quant.DEFAULT_SPEC fields the browser dropped').toEqual([]);
    for (const f of Object.keys(display)) expect(fields).toContain(f);
  });

  it('leaves out the same rows on the meta contig as the browser', () => {
    const src = py('services/figure/meta_locus.py');
    const tuple = /if kind in \(([^)]*)\):\n\s*return True/.exec(src);
    expect(tuple, 'meta_hidden_track type tuple').not.toBeNull();
    const pyHidden = new Set([...tuple![1].matchAll(/"([^"]+)"/g)].map(m => m[1]));
    const types = ['axis', 'fire', 'consensus', 'microc', 'coacc', 'capture', 'primer', 'sv', 'coverage', 'reads', 'sequence', 'gene', 'header', 'annotation'];
    for (const t of types) expect(pyHidden.has(t), `${t}`).toBe(metaHiddenTrack(t));
    expect(metaHiddenTrack('ortho-x')).toBe(true);
    expect(src).toContain('if kind.startswith("ortho-"):');
    expect(metaHiddenTrack('composite-x', false)).toBe(true);
    expect(metaHiddenTrack('composite-x', true)).toBe(false);
  });
});
