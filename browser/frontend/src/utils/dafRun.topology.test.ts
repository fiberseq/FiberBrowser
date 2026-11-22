/** The run wizard's "Nucleosome recall: Conservative (default) / Topology" (3.1.1): sent only for Hia5 and DddB. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, NUC_RECALL_ENZYMES, changedOptionLabels, nucRecallFor } from './dafRun';

describe('nucleosome recall option', () => {
  it('defaults to conservative and is topology only when chosen for a chemistry that takes it', () => {
    expect(DEFAULT_OPTIONS.nuc_recall_policy).toBe('conservative');
    expect(NUC_RECALL_ENZYMES).toEqual(['hia5', 'dddb']);
    expect(nucRecallFor({ nuc_recall_policy: 'topology' }, 'hia5')).toBe('topology');
    expect(nucRecallFor({ nuc_recall_policy: 'topology' }, 'dddb')).toBe('topology');
    expect(nucRecallFor({ nuc_recall_policy: 'topology' }, 'ddda')).toBe('conservative');
    expect(nucRecallFor({}, 'hia5')).toBe('conservative');                  // a draft from before 3.1.1
    expect(nucRecallFor({ nuc_recall_policy: 'topology' }, '')).toBe('conservative');
  });
  it('the run plan names topology recall', () => {
    expect(changedOptionLabels({ ...DEFAULT_OPTIONS, nuc_recall_policy: 'topology' }, 'hia5')).toContain('topology nucleosome recall');
    expect(changedOptionLabels({ ...DEFAULT_OPTIONS, nuc_recall_policy: 'topology' }, 'dddb')).toContain('topology nucleosome recall');
    expect(changedOptionLabels({ ...DEFAULT_OPTIONS, nuc_recall_policy: 'topology' }, 'ddda')).not.toContain('topology nucleosome recall');
    expect(changedOptionLabels(DEFAULT_OPTIONS, 'hia5')).not.toContain('topology nucleosome recall');
  });
});
