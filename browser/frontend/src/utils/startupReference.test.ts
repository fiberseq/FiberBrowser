import { describe, expect, it } from 'vitest';
import { decideStartupReference, isRemoteReference, restoredReferenceConflict, type StartupReferenceInput } from './startupReference';

const REGISTRY = ['hg38', 'hg19', 'mm39', 'mm10', 'dm6', 'sacCer3'];
const FLY = ['chr2L', 'chr2R', 'chr3L', 'chr3R', 'chr4', 'chrX'];
const YEAST = ['chrI', 'chrII', 'chrIII', 'chrIV', 'chrV', 'chrXVI'];

function input(over: Partial<StartupReferenceInput> = {}): StartupReferenceInput {
  return {
    server: { hasFasta: false, currentGenome: null },
    remembered: { fastaPath: null, genomeId: null },
    data: { genome: null, chroms: [] },
    registryIds: REGISTRY,
    ...over,
  };
}

describe('decideStartupReference', () => {
  it("the owner's case: --fasta dm6 on the server beats a remembered sacCer3", () => {
    expect(decideStartupReference(input({
      server: { hasFasta: true, currentGenome: 'dm6' },
      remembered: { fastaPath: null, genomeId: 'sacCer3' },
      data: { genome: 'dm6', chroms: FLY },
    }))).toEqual({ action: 'keep-server' });
    // A server reference of no registry genome (a custom FASTA) too.
    expect(decideStartupReference(input({ server: { hasFasta: true, currentGenome: null }, remembered: { fastaPath: '/x/sacCer3.fa', genomeId: 'sacCer3' } })))
      .toEqual({ action: 'keep-server' });
  });

  it('a remembered genome of another assembly than the data is not restored, and says so', () => {
    const d = decideStartupReference(input({ remembered: { fastaPath: null, genomeId: 'sacCer3' }, data: { genome: 'dm6', chroms: FLY } }));
    expect(d).toEqual({ action: 'load-genome', genomeId: 'dm6', notRestored: expect.stringContaining('sacCer3') });
    expect((d as { notRestored: string }).notRestored).toBe('The saved reference (sacCer3) was not restored: the loaded data is dm6.');
  });

  it('a remembered FASTA of another assembly than the data is not restored (by its index, else its name)', () => {
    expect(decideStartupReference(input({
      remembered: { fastaPath: '/genomes/my_yeast.fa', fastaAssembly: 'sacCer3', genomeId: null },
      data: { genome: 'dm6', chroms: FLY },
    }))).toEqual({ action: 'load-genome', genomeId: 'dm6', notRestored: 'The saved reference (my_yeast.fa) was not restored: the loaded data is dm6.' });
    expect(decideStartupReference(input({
      remembered: { fastaPath: '/home/u/.fiberhmm/genomes/sacCer3.fa', genomeId: 'sacCer3' },
      data: { genome: null, chroms: FLY },
    }))).toMatchObject({ action: 'load-genome', genomeId: 'dm6' });
  });

  it("a remembered FASTA of the data's assembly, or of no known assembly, is restored", () => {
    expect(decideStartupReference(input({
      remembered: { fastaPath: '/data/dm6_masked.fa', fastaAssembly: 'dm6', genomeId: null }, data: { genome: 'dm6', chroms: FLY },
    }))).toEqual({ action: 'load-fasta', path: '/data/dm6_masked.fa' });
    expect(decideStartupReference(input({
      remembered: { fastaPath: '/data/custom.fa', fastaAssembly: null, genomeId: null }, data: { genome: 'dm6', chroms: FLY },
    }))).toEqual({ action: 'load-fasta', path: '/data/custom.fa' });
    // No data: the remembered FASTA, whatever it is.
    expect(decideStartupReference(input({ remembered: { fastaPath: '/x/sacCer3.fa', genomeId: 'sacCer3' } })))
      .toEqual({ action: 'load-fasta', path: '/x/sacCer3.fa' });
  });

  it("a remembered registry download's URL is never loaded as a FASTA", () => {
    const url = 'https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/bigZips/sacCer3.fa.gz';
    expect(isRemoteReference(url)).toBe(true);
    expect(decideStartupReference(input({ remembered: { fastaPath: url, genomeId: 'sacCer3' }, data: { genome: 'dm6', chroms: FLY } })))
      .toMatchObject({ action: 'load-genome', genomeId: 'dm6' });
    expect(decideStartupReference(input({ remembered: { fastaPath: url, genomeId: 'sacCer3' } })))
      .toEqual({ action: 'load-genome', genomeId: 'sacCer3' });
  });

  it("the remembered genome when it is the data's, exactly from headers, by species from contig names", () => {
    expect(decideStartupReference(input({ remembered: { fastaPath: null, genomeId: 'dm6' }, data: { genome: 'dm6', chroms: FLY } })))
      .toEqual({ action: 'load-genome', genomeId: 'dm6' });
    // hg19 remembered, headers say hg38: hg38 (and the note).
    expect(decideStartupReference(input({ remembered: { fastaPath: null, genomeId: 'hg19' }, data: { genome: 'hg38', chroms: ['chr1', 'chr21', 'chr22'] } })))
      .toMatchObject({ action: 'load-genome', genomeId: 'hg38', notRestored: expect.any(String) });
    // Only contig names (human): the remembered human assembly stays.
    expect(decideStartupReference(input({ remembered: { fastaPath: null, genomeId: 'hg19' }, data: { genome: null, chroms: ['chr1', 'chr21', 'chr22'] } })))
      .toEqual({ action: 'load-genome', genomeId: 'hg19' });
  });

  it('nothing loaded and nothing known: the remembered genome, else the default', () => {
    expect(decideStartupReference(input({ remembered: { fastaPath: null, genomeId: 'mm10' } }))).toEqual({ action: 'load-genome', genomeId: 'mm10' });
    expect(decideStartupReference(input())).toEqual({ action: 'load-genome', genomeId: 'hg38' });
    expect(decideStartupReference(input({ data: { genome: null, chroms: YEAST } }))).toEqual({ action: 'load-genome', genomeId: 'sacCer3' });
  });

  it('data on a species the registry lacks: nothing (not hg38 under it)', () => {
    expect(decideStartupReference(input({ registryIds: ['hg38'], data: { genome: null, chroms: FLY } }))).toEqual({ action: 'none' });
  });
});

describe('restoredReferenceConflict', () => {
  const server = { startupReference: true, currentGenome: 'dm6', fastaPath: '/data/FIRE/dm6.fa' };
  it("the server's --fasta is kept over a saved reference of another genome, in one line", () => {
    expect(restoredReferenceConflict({ currentGenome: 'sacCer3', fastaPath: null }, server))
      .toBe('The saved reference (sacCer3) was not restored: this server was started with dm6.');
    expect(restoredReferenceConflict({ currentGenome: null, fastaPath: '/x/yeast.fa' }, { ...server, currentGenome: null }))
      .toBe('The saved reference (yeast.fa) was not restored: this server was started with dm6.fa.');
  });
  it('no conflict: the same genome or FASTA, nothing saved, or a server without --fasta', () => {
    expect(restoredReferenceConflict({ currentGenome: 'dm6' }, server)).toBeNull();
    expect(restoredReferenceConflict({ currentGenome: null, fastaPath: '/data/FIRE/dm6.fa' }, { ...server, currentGenome: null })).toBeNull();
    expect(restoredReferenceConflict({ currentGenome: null, fastaPath: null }, server)).toBeNull();
    expect(restoredReferenceConflict({ currentGenome: 'sacCer3' }, { ...server, startupReference: false })).toBeNull();
  });
});
