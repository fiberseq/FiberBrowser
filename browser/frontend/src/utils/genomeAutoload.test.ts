import { describe, expect, it } from 'vitest';
import { genomeFromChroms, genomeLoadHasFasta, pickAutoloadGenome } from './genomeAutoload';

const REGISTRY = ['hg38', 'hg19', 'mm39', 'mm10', 'dm6', 'sacCer3'];
const FLY = ['chr2L', 'chr2R', 'chr3L', 'chr3R', 'chr4', 'chrX', 'chrY', 'chrM'];
const HUMAN = [...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), 'chrX', 'chrY', 'chrM'];

describe('start-up genome auto-load', () => {
  it('a genome load that only fetched the annotation is not a loaded reference', () => {
    // Was: hasFasta = success, so the sequence track asked for bases → 404 "No FASTA loaded".
    expect(genomeLoadHasFasta({ success: true, fasta_loaded: false })).toBe(false);
    expect(genomeLoadHasFasta({ success: true, fasta_loaded: true })).toBe(true);
    expect(genomeLoadHasFasta({ success: false, fasta_loaded: false })).toBe(false);
  });

  it('infers the species from chromosome names like the server does', () => {
    expect(genomeFromChroms(FLY)).toBe('dm6');
    expect(genomeFromChroms(HUMAN)).toBe('hg38');
    expect(genomeFromChroms(['2L', '3R'])).toBe('dm6');
    expect(genomeFromChroms(['chrI', 'chrXVI'])).toBe('sacCer3');
    expect(genomeFromChroms(['contig_1', 'plasmid'])).toBeNull();
  });

  it('does not load the hg38 default under a fly BAM', () => {
    // Was: hg38 replaced the chrom list and the sequence track asked it for chr2R → 404.
    expect(pickAutoloadGenome('hg38', FLY, REGISTRY)).toBe('dm6');
    expect(pickAutoloadGenome('hg38', FLY, ['hg38'])).toBeNull();
  });

  it('keeps the remembered genome when the data is the same species or unrecognised', () => {
    expect(pickAutoloadGenome('hg38', HUMAN, REGISTRY)).toBe('hg38');
    expect(pickAutoloadGenome('hg19', HUMAN, REGISTRY)).toBe('hg19');
    expect(pickAutoloadGenome('mm39', ['chr1', 'chr19', 'chrX'], REGISTRY)).toBe('mm39');
    expect(pickAutoloadGenome('hg38', [], REGISTRY)).toBe('hg38');
    expect(pickAutoloadGenome('dm6', ['tig00001'], REGISTRY)).toBe('dm6');
  });
});
