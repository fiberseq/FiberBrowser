import { describe, expect, it } from 'vitest';
import type { LibraryEntry, LibraryGroup } from '../api/library';
import {
  DEFAULT_FILTERS, chemistryLabel, facetValues, filterEntries, openBlocker, referenceKey, referenceLabel,
  sortEntries, suggestedGroups, toggleSort,
} from './library';
import { planOpen } from './libraryOpen';

function entry(id: string, extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id, kind: 'bam', path: `/data/exp1/${id}.bam`, folder: '/data/exp1', label: `${id}.bam`, sample: id,
    available: true, tags: [], notes: '', chemistry: { key: 'dddb', declared: true },
    reference: { genome: 'dm6', n_contigs: 7, plasmid: false }, ...extra,
  };
}

const entries: LibraryEntry[] = [
  entry('a', { tags: ['embryo'], qc: { verdicts: { overall: 'PASS' } }, date: '2026-08-06T10:00:00', reads: 5000,
    identity: { size: 100 } }),
  entry('b', { qc: { verdicts: { overall: 'WARN' } }, date: '2026-09-01T10:00:00', reads: 200, notes: 'weak periodicity',
    identity: { size: 300 } }),
  entry('c', { chemistry: { key: 'unknown', declared: false }, reference: { genome: 'hg38', n_contigs: 25 },
    folder: '/data/exp2', path: '/data/exp2/c.bam', date: '2026-07-01T00:00:00' }),
  entry('c-aligned', { role: 'aligned', folder: '/data/exp2', path: '/data/exp2/c.aligned.bam' }),
  entry('p', { reference: { plasmid: true, n_contigs: 1, contigs: [{ name: 'pTest', length: 5000, circular: true }], plasmid_maps: [{ name: 'pTest.gb', path: '/data/maps/pTest.gb' }] },
    linked_maps: ['map'], folder: '/data/plasmid', path: '/data/plasmid/p.bam', rerun: 'rerun-required',
    advisories: { key: 'x|3.0.1', items: [{ id: 'gt', severity: 'rerun-required', title: 'DddB table' }] } }),
  entry('map', { kind: 'plasmid_map', path: '/data/maps/pTest.gb', folder: '/data/maps', label: 'pTest.gb', chemistry: null,
    reference: { plasmid: true, n_contigs: 1, contigs: [{ name: 'pTest', length: 5000, md5: 'abc', circular: true }] } }),
  entry('gone', { available: false, folder: '/data/old', path: '/data/old/gone.bam' }),
  entry('r1', { job: { id: 'j1', group: 'run7', finished_at: 1790000000 }, pipeline: { outputs_json: '/runs/r1/outputs.json', outdir: '/runs/r1', role: 'called', region: 'chr2L:100-900' }, folder: '/runs/r1', path: '/runs/r1/r1.bam' }),
  entry('r2', { job: { id: 'j2', group: 'run7', finished_at: 1790000100 }, pipeline: { outputs_json: '/runs/r2/outputs.json', outdir: '/runs/r2', role: 'called' }, folder: '/runs/r2', path: '/runs/r2/r2.bam' }),
];

const ids = (list: LibraryEntry[]) => list.map(e => e.id);

describe('Library filters', () => {
  it('hides aligned intermediates by default and shows missing files', () => {
    expect(ids(filterEntries(entries, DEFAULT_FILTERS))).not.toContain('c-aligned');
    expect(ids(filterEntries(entries, DEFAULT_FILTERS))).toContain('gone');
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, showAligned: true }))).toContain('c-aligned');
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, showUnavailable: false }))).not.toContain('gone');
  });

  it('filters by sample text, tag, note, chemistry, genome/plasmid, QC and folder', () => {
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, text: 'embryo' }))).toEqual(['a']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, text: 'weak PERIODICITY' }))).toEqual(['b']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, chemistry: 'unknown' }))).toEqual(['c']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, reference: 'genome:hg38' }))).toEqual(['c']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, reference: 'plasmid' }))).toEqual(['p', 'map']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, qc: 'WARN' }))).toEqual(['b']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, qc: 'none', kind: 'bam' }))).toEqual(['c', 'p', 'gone', 'r1', 'r2']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, tag: 'embryo' }))).toEqual(['a']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, folder: '/data/exp2', showAligned: true }))).toEqual(['c', 'c-aligned']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, folder: '/data' }))).toEqual(['a', 'b', 'c', 'p', 'map', 'gone']);
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, folder: '/dat' }))).toEqual([]);  // a folder, not a prefix
  });

  it('filters the files that need re-running on the current FiberHMM', () => {
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, rerunOnly: true }))).toEqual(['p']);
  });

  it('filters a group', () => {
    const groups: LibraryGroup[] = [{ id: 'g', name: 'G', entry_ids: ['b', 'c'] }];
    expect(ids(filterEntries(entries, { ...DEFAULT_FILTERS, group: 'g' }, groups))).toEqual(['b', 'c']);
  });
});

describe('Library table', () => {
  it('sorts by each column and toggles direction', () => {
    const byDate = sortEntries(entries.slice(0, 3), { key: 'date', dir: 'desc' });
    expect(ids(byDate)).toEqual(['b', 'a', 'c']);
    expect(ids(sortEntries(entries.slice(0, 3), { key: 'reads', dir: 'desc' }))).toEqual(['a', 'b', 'c']);
    expect(ids(sortEntries(entries.slice(0, 3), { key: 'qc', dir: 'asc' }))).toEqual(['c', 'b', 'a']);
    expect(ids(sortEntries(entries.slice(0, 3), { key: 'size', dir: 'asc' }))).toEqual(['c', 'a', 'b']);
    expect(toggleSort({ key: 'label', dir: 'asc' }, 'label')).toEqual({ key: 'label', dir: 'desc' });
    expect(toggleSort({ key: 'label', dir: 'asc' }, 'date')).toEqual({ key: 'date', dir: 'desc' });
  });

  it('labels chemistry and references', () => {
    expect(chemistryLabel(entries[0])).toBe('DddB');
    expect(chemistryLabel(entry('x', { chemistry: { key: 'ddda', declared: false, inferred: true } }))).toBe('DddA (inferred)');
    expect(chemistryLabel(entries[5])).toBe('');
    expect(referenceLabel(entries[4])).toBe('plasmid pTest.gb');
    expect(referenceLabel(entries[5])).toBe('pTest (5.0 kb)');
    expect(referenceKey(entries[2])).toBe('genome:hg38');
  });

  it('collects facet values', () => {
    const facets = facetValues(entries);
    expect(facets.chemistries).toEqual(['dddb', 'unknown']);
    expect(facets.references).toEqual(['genome:dm6', 'genome:hg38', 'plasmid']);
    expect(facets.verdicts).toEqual(['PASS', 'WARN']);
    expect(facets.tags).toEqual(['embryo']);
    expect(facets.kinds).toEqual(['bam', 'plasmid_map']);
  });
});

describe('Suggested experiments', () => {
  it('groups BAMs by folder and runs by their batch', () => {
    const suggestions = suggestedGroups(entries);
    expect(suggestions[0]).toMatchObject({ key: 'run:run7', source: 'run', entryIds: ['r1', 'r2'] });
    expect(suggestions[0].name).toMatch(/^DAF-seq run 2026-\d\d-\d\d \(2 samples\)$/);
    const folders = suggestions.filter(s => s.source === 'folder');
    expect(folders[0]).toMatchObject({ key: 'folder:/data/exp1', name: 'data/exp1', entryIds: ['a', 'b'] });
    expect(folders.map(s => s.key)).not.toContain('folder:/runs/r1');  // runs are grouped by batch
    expect(folders.find(s => s.key === 'folder:/data/exp2')!.entryIds).toEqual(['c']);  // not the aligned BAM
  });

  it('leaves out suggestions already saved as groups', () => {
    const suggestions = suggestedGroups(entries, [{ id: 'g', name: 'mine', entry_ids: ['b', 'a'] }]);
    expect(suggestions.map(s => s.key)).not.toContain('folder:/data/exp1');
  });
});

describe('Opening entries', () => {
  it('plans plasmid BAMs with their map, genome BAMs with their genome, and skips missing files', () => {
    const plan = planOpen([entries[0], entries[4], entries[5], entries[6], entries[7]], entries);
    expect(plan.plasmid).toHaveLength(1);
    expect(plan.plasmid[0].map.id).toBe('map');
    expect(ids(plan.plasmid[0].bams)).toEqual(['p']);
    expect(plan.maps).toEqual([]);  // opened with its BAM
    expect(plan.genome).toBe('dm6');
    expect(ids(plan.datasets)).toEqual(['a', 'r1']);
    expect(plan.region).toBe('chr2L:100-900');
    expect(plan.skipped.map(s => s.entry.id)).toEqual(['gone']);
  });

  it('never loads a recognised genome that is not downloaded', () => {
    const notHere = planOpen([entries[0]], entries, ['hg38']);
    expect(notHere.genome).toBeNull();
    expect(notHere.genomeNotDownloaded).toBe('dm6');
    expect(planOpen([entries[0]], entries, ['dm6']).genome).toBe('dm6');
    // The genome a DAF-seq run used is the user's own choice.
    const run = planOpen([entry('j', { job: { id: 'j', reference: { genome_id: 'mm39' } } })], entries, []);
    expect(run.genome).toBe('mm39');
  });

  it('opens a map alone beside the view', () => {
    const plan = planOpen([entries[5]], entries);
    expect(ids(plan.maps)).toEqual(['map']);
    expect(plan.datasets).toEqual([]);
  });

  it('says why an entry cannot be opened', () => {
    expect(openBlocker(entries[6])).toBe('unavailable');
    expect(openBlocker(entry('cloud', { cloud_only: true }))).toBe('cloud');
    expect(openBlocker(entries[0])).toBeNull();
  });
});
