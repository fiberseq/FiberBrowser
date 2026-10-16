import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../api/pipeline';
import {
  DEFAULT_BASECALL, DEFAULT_OPTIONS, basecallSummary, buildRunRequest, changedOptionLabels, defaultOutputRoot,
  enzymesFor, initialWizardState,
  parseRegionsText, sampleNameError, sampleOutdir, samplesFromScan, stepErrors, stepIssues, type WizardState,
} from './dafRun';

const scan: ScanResult = {
  success: true,
  warnings: [],
  samples: [
    { key: 'ps:ABC123:1', name: 'sample_a', order: 'ABC123', barcode: '1', kinds: ['fastq'], size: 100,
      files: [{ path: 'ABC/ABC123_1_sample_a.fastq', kind: 'fastq', size: 100, zip: '/d/ABC123.zip', member: 'ABC/ABC123_1_sample_a.fastq' }] },
    { key: 'ps:ABC123:2', name: 'yw', order: 'ABC123', barcode: '2', kinds: ['fastq'], size: 50,
      files: [{ path: '/d/ABC123_2_yw.fastq', kind: 'fastq', size: 50 }] },
  ],
};

const status = {
  default_cores: 4, cores: 8, current_genome: 'dm6',
  genomes: [
    { id: 'dm6', name: 'D. melanogaster (dm6)', downloaded: true, fasta: '/g/dm6.fa', loaded: true },
    { id: 'hg38', name: 'Human (hg38)', downloaded: false, fasta: null, loaded: false },
  ],
};

function withSamples(): WizardState {
  return { ...initialWizardState(status), samples: samplesFromScan(scan) };
}

describe('New DAF-seq run wizard state', () => {
  it('starts on the loaded genome with fiberhmm-call defaults', () => {
    const state = initialWizardState(status);
    expect(state.referenceMode).toBe('genome');
    expect(state.genomeId).toBe('dm6');
    expect(state.options).toEqual(DEFAULT_OPTIONS);
    expect(state.cores).toBe(4);
    expect(initialWizardState(null).referenceMode).toBe('file');
  });

  it('keeps renamed and excluded samples across a rescan', () => {
    const renamed = samplesFromScan(scan).map(s => (s.key === 'ps:ABC123:2' ? { ...s, name: 'wildtype', include: false } : s));
    const again = samplesFromScan(scan, renamed);
    expect(again.map(s => [s.name, s.include])).toEqual([['sample_a', true], ['wildtype', false]]);
  });

  it('checks sample names', () => {
    expect(sampleNameError('ok_name-1.2', [])).toBeNull();
    expect(sampleNameError('', [])).toMatch(/name/);
    expect(sampleNameError('has space', [])).toMatch(/Letters/);
    expect(sampleNameError('Dup', ['dup'])).toMatch(/Another/);
  });

  it('parses amplicon regions with thousands separators', () => {
    expect(parseRegionsText('chr2L:1,000-5,000\nchr3R:10-20, chrX:5-6')).toEqual({
      regions: ['chr2L:1000-5000', 'chr3R:10-20', 'chrX:5-6'], errors: [],
    });
    expect(parseRegionsText('chr2L:500-100 nonsense').errors).toHaveLength(2);
  });

  it('derives the output folder from the date and sample (or order id)', () => {
    const date = new Date(2026, 8, 29);
    const samples = samplesFromScan(scan);
    expect(defaultOutputRoot('/Users/me/FiberHMM runs', samples, date)).toBe('/Users/me/FiberHMM runs/2026-09-29_ABC123');
    expect(defaultOutputRoot('/Users/me/FiberHMM runs/', [samples[0]], date)).toBe('/Users/me/FiberHMM runs/2026-09-29_sample_a');
    expect(sampleOutdir('/r', 'a', 1)).toBe('/r');
    expect(sampleOutdir('/r', 'a', 2)).toBe('/r/a');
  });

  it('validates each step', () => {
    const empty = initialWizardState(status);
    expect(stepErrors(empty, 0, status)).toEqual(['Add reads: FASTQ files, a folder or a Plasmidsaurus .zip.']);
    const state = withSamples();
    expect(stepErrors(state, 0, status)).toEqual([]);
    expect(stepErrors({ ...state, samples: state.samples.map(s => ({ ...s, name: 'same' })) }, 0, status)).toHaveLength(2);
    expect(stepErrors({ ...state, genomeId: 'hg38' }, 1, status)[0]).toMatch(/not downloaded/);
    expect(stepErrors({ ...state, referenceMode: 'file', referencePath: '/x/map.txt' }, 1, status)[0]).toMatch(/FASTA/);
    expect(stepErrors({ ...state, referenceMode: 'file', referencePath: '/x/pUC19.dna' }, 1, status)).toEqual([]);
    expect(stepErrors({ ...state, regionsText: 'bad' }, 1, status)).toHaveLength(1);
    expect(stepErrors(state, 2, status)).toEqual(['Choose the enzyme.', 'Choose an output folder.']);
    const ready = { ...state, enzyme: 'dddb' as const, outputRoot: '/out' };
    expect(stepErrors(ready, 2, status)).toEqual([]);
    expect(stepErrors({ ...ready, cores: 9 }, 2, status)[0]).toMatch(/Cores: 1 to 8/);
    expect(stepErrors({ ...ready, options: { ...ready.options, prob_threshold: 300 } }, 2, status)[0]).toMatch(/ML/);
  });

  it('tells missing inputs (help until the user tries Next) from wrong ones (L15)', () => {
    const empty = initialWizardState(status);
    expect(stepIssues(empty, 0, status)).toEqual([{ message: 'Add reads: FASTQ files, a folder or a Plasmidsaurus .zip.', missing: true }]);
    const state = withSamples();
    expect(stepIssues({ ...state, samples: state.samples.map(s => ({ ...s, name: 'same' })) }, 0, status).every(i => !i.missing)).toBe(true);
    expect(stepIssues({ ...state, regionsText: 'bad' }, 1, status)).toEqual([expect.objectContaining({ missing: false })]);
    expect(stepIssues(state, 2, status).map(i => i.missing)).toEqual([true, true]);
    expect(stepIssues({ ...state, enzyme: 'dddb', outputRoot: '/out', cores: 9 }, 2, status)).toEqual([expect.objectContaining({ missing: false })]);
  });

  it('builds the run request the server expects', () => {
    const state: WizardState = {
      ...withSamples(), enzyme: 'dddb', outputRoot: ' /out ', regionsText: 'chr2L:1-100',
      samples: samplesFromScan(scan).map((s, i) => ({ ...s, include: i === 0 })),
    };
    const req = buildRunRequest(state);
    expect(req.samples).toEqual([{ name: 'sample_a', files: scan.samples[0].files }]);
    expect(req.reference).toEqual({ kind: 'genome', genome_id: 'dm6' });
    expect(req.regions).toEqual(['chr2L:1-100']);
    expect(req.output_root).toBe('/out');
    expect(buildRunRequest({ ...state, referenceMode: 'file', referencePath: '' }).reference).toEqual({});
  });

  it('lists the options changed from the defaults', () => {
    expect(changedOptionLabels(DEFAULT_OPTIONS, 'dddb')).toEqual([]);
    const options = { ...DEFAULT_OPTIONS, dedup: 'off' as const, dedup_mode: 'collapse' as const, use_m5c: 'off' as const };
    expect(changedOptionLabels(options, 'dddb')).toEqual(['duplicates off']);
    expect(changedOptionLabels(options, 'ddda')).toEqual(['duplicates off', 'CpG-aware recall off']);
  });
});

describe('raw Nanopore (POD5) runs', () => {
  const pod5State = (changes: Partial<WizardState> = {}): WizardState => ({
    ...initialWizardState(null),
    inputKind: 'pod5',
    samples: [{ key: 'pod5:/d/run1/pod5', name: 'run1', include: true, order: null, barcode: null, size: 9,
      files: [{ path: '/d/run1/pod5', kind: 'pod5', size: 9 }] }],
    referenceMode: 'file', referencePath: '/g/hg38.fa', enzyme: 'hia5', outputRoot: '/runs/run1',
    ...changes,
  });

  it('sends the input kind and the basecalling choices, and no DAF-only options for Hia5', () => {
    const state = pod5State({ options: { ...DEFAULT_OPTIONS, dedup: 'off', snp_screen: 'on', prob_threshold: 200 } });
    const request = buildRunRequest(state);
    expect(request.input_kind).toBe('pod5');
    expect(request.basecall).toEqual(DEFAULT_BASECALL);
    expect(request.options.dedup).toBe('auto');
    expect(request.options.snp_screen).toBe('auto');
    expect(request.options.prob_threshold).toBe(200);  // applies to m6A too
    expect(buildRunRequest({ ...state, enzyme: 'dddb' }).options.dedup).toBe('off');
    expect(buildRunRequest({ ...initialWizardState(null), enzyme: 'dddb' })).not.toHaveProperty('basecall');
    expect(changedOptionLabels(state.options, 'hia5')).toEqual(['ML threshold 200']);
  });

  it('offers Hia5 only for POD5 and checks the Advanced choices', () => {
    expect(enzymesFor('reads')).toEqual(['dddb', 'ddda']);
    expect(enzymesFor('pod5')).toEqual(['dddb', 'ddda', 'hia5']);
    expect(stepErrors(pod5State(), 2)).toEqual([]);
    expect(stepErrors(pod5State({ inputKind: 'reads' }), 2)[0]).toContain('start from raw Nanopore (POD5)');
    expect(stepErrors(pod5State({ basecall: { ...DEFAULT_BASECALL, batchsize: 0 } }), 2)[0]).toContain('Batch size');
    expect(stepErrors(pod5State({ samples: [] }), 0)[0]).toContain('POD5 folder');
  });

  it('says what dorado will call', () => {
    expect(basecallSummary(DEFAULT_BASECALL, 'hia5')).toBe('dorado sup + 6mA');
    expect(basecallSummary(DEFAULT_BASECALL, 'dddb')).toBe('dorado sup (no modification model)');
    expect(basecallSummary(DEFAULT_BASECALL, '')).toBe('dorado sup (+ 6mA for Hia5)');
    expect(basecallSummary({ ...DEFAULT_BASECALL, modified_bases: 'none', device: 'cpu', batchsize: 64 }, 'hia5'))
      .toBe('dorado sup (no modification model) · cpu, batch 64');
    expect(basecallSummary({ ...DEFAULT_BASECALL, model: 'sup,6mA' }, 'dddb')).toBe('dorado sup + 6mA');
  });
});
