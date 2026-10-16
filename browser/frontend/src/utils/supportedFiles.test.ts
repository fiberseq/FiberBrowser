import { describe, expect, it } from 'vitest';
import {
  acceptAttribute, dialogFilters, formatGroupOf, isCoordinateIndex, isSidecar, matchesFilter, planSelection,
  sidecarMainCandidates,
} from './supportedFiles';
import spec from '../data/supportedFiles.json';

describe('supported files (one list for the dialogs, the page and the server)', () => {
  it('knows datasets, tracks and the rest by name, any case, longest suffix first', () => {
    expect(formatGroupOf('/d/Sample.BAM')?.id).toBe('alignments');
    expect(formatGroupOf('/d/s_footprint.bb')?.id).toBe('fiberseq');
    expect(formatGroupOf('/d/s.fiberlayers.bb')?.id).toBe('sessions');
    expect(formatGroupOf('/d/peaks.bed.gz')?.id).toBe('tracks');
    expect(formatGroupOf('https://host/x.bam?sig=1')?.id).toBe('alignments');
    expect(formatGroupOf('/d/notes.txt')).toBeNull();
  });

  it('indexes are never formats of their own, and point at their main file', () => {
    for (const name of ['a.bam.bai', 'a.bai', 'a.bam.csi', 'a.bam.pbi', 'g.fa.fai', 'g.fa.gz.gzi', 'p.bed.gz.tbi']) {
      expect(isSidecar(name)).toBe(true);
      expect(formatGroupOf(name)).toBeNull();
    }
    expect(sidecarMainCandidates('/d/a.bam.bai')[0]).toBe('/d/a.bam');
    expect(sidecarMainCandidates('/d/a.bai')).toContain('/d/a.bam');
    expect(sidecarMainCandidates('/d/g.fa.fai')[0]).toBe('/d/g.fa');
  });

  it('a selection keeps indexes that come with their file and explains the others', () => {
    const plan = planSelection(['/d/a.bam', '/d/a.bam.bai', '/d/b.bai', '/d/b.bam', '/e/c.bam.bai', '/d/x.cram']);
    expect(plan.open).toEqual(['/d/a.bam', '/d/b.bam']);
    expect(plan.indexes).toEqual(['/d/a.bam.bai', '/d/b.bai']);
    expect(plan.errors).toHaveLength(2);
    expect(plan.errors[0]).toMatch(/^c\.bam\.bai: this is a BAM index file.*Open c\.bam instead/);
    expect(plan.errors[1]).toMatch(/^x\.cram: CRAM files can't be opened; convert to BAM/);
    // Dropped files have names only.
    expect(planSelection(['a.bam.bai', 'a.bam'], { byName: true })).toEqual({ open: ['a.bam'], indexes: ['a.bam.bai'], indexFor: { 'a.bam': 'a.bam.bai' }, errors: [] });
  });

  it('dialog filters: Supported files first, each kind, All files last; no indexes', () => {
    const filters = dialogFilters('open');
    expect(filters[0].label).toBe('Supported files');
    expect(filters.at(-1)).toEqual({ label: 'All files', suffixes: [] });
    expect(filters.map(f => f.label)).toContain('Alignments (BAM)');
    const supported = filters[0].suffixes;
    for (const group of spec.groups) for (const suffix of group.suffixes) expect(supported).toContain(suffix);
    for (const rule of spec.sidecars) expect(supported).not.toContain(rule.suffix);
    expect(dialogFilters('dataset').map(f => f.label)).toEqual(['Supported files', 'Alignments (BAM)', 'Fiber-seq BigBed (bb, bigBed)', 'All files']);
    expect(dialogFilters('dataset')[0].suffixes).toEqual(['.bam', '.bb', '.bigbed']);
    expect(matchesFilter('X.BAM', ['.bam'])).toBe(true);
    expect(matchesFilter('x.bam.bai', ['.bam'])).toBe(false);
    expect(matchesFilter('anything', [])).toBe(true);
    expect(acceptAttribute('dataset')).toBe('.bam,.bb,.bigbed');
  });
});

describe('remote selections', () => {
  it('a signed index URL goes with its BAM (signatures differ)', () => {
    const bam = 'https://s3.example.org/lab/x.bam?X-Amz-Signature=aaa';
    const bai = 'https://s3.example.org/lab/x.bam.bai?X-Amz-Signature=bbb';
    expect(planSelection([bam, bai])).toEqual({ open: [bam], indexes: [bai], indexFor: { [bam]: bai }, errors: [] });
  });

  it('a PacBio .pbi is used with its BAM but never as its coordinate index (Codex 31)', () => {
    const bam = 'https://s3.example.org/lab/x.bam';
    const pbi = 'https://s3.example.org/lab/x.bam.pbi';
    const bai = 'https://s3.example.org/lab/x.bam.bai';
    const csi = 'https://s3.example.org/lab/x.bam.csi';
    expect(planSelection([bam, pbi])).toEqual({ open: [bam], indexes: [pbi], indexFor: {}, errors: [] });
    // Chosen before the BAI/CSI in the same batch: the BAI/CSI is the index.
    expect(planSelection([bam, pbi, bai]).indexFor).toEqual({ [bam]: bai });
    expect(planSelection([pbi, csi, bam]).indexFor).toEqual({ [bam]: csi });
    expect(isCoordinateIndex(pbi)).toBe(false);
    expect(isCoordinateIndex(bai) && isCoordinateIndex(csi)).toBe(true);
  });
});

describe('index matching by path', () => {
  it('ignores separator style and ./ segments; keeps URL case', () => {
    expect(planSelection(['Z:\\data\\x.bam', 'Z:/data/x.bam.bai']).errors).toEqual([]);
    expect(planSelection(['/data/x.bam', '/data/./x.bam.bai']).errors).toEqual([]);
    expect(planSelection(['s3://lab/Case.bam', 's3://lab/case.bam.bai']).errors).toHaveLength(1);
  });
});
