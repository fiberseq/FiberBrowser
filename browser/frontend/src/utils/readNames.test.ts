import { describe, expect, it } from 'vitest';
import { flattenPastedList, formatReadNameList, isReadName, parseReadNames } from './readNames';

/** fb-r4-clicks: read names in the locus box are told apart from loci and genes. */
describe('read names in a locus box', () => {
  it.each([
    'm64011_190830_220126/1234/ccs',
    'm84046_240619_124816_s1/240062573/ccs',
    'm54006_160504_020705/4194372/0_12345',
    'm84046_240619_124816_s1/240062573/ccs/fwd',
    '3c8f6d2a-1b7e-4f0a-9c55-0d2e7a9b1f34',
    '3C8F6D2A-1B7E-4F0A-9C55-0D2E7A9B1F34',
    'A00123:8:H5KJ2DSXY:1:1101:10004:10019',
    'HWUSI-EAS100R:6:73:941:1973#0/1',
    'SRR1234567.1',
    '@m64011_190830_220126/1234/ccs',
    'lab_run7/000123/read',
    'm84046_240619_124816_s1/240062573/ccs_2',
    // L5: the lab's own DAF amplicon BAMs.
    '4741_FP64DJ_3',
    '1968_CS8B4N_4',
  ])('%s is a read name', (name) => {
    expect(isReadName(name)).toBe(true);
    expect(parseReadNames(name)).toEqual([name.replace(/^@/, '')]);
  });

  it.each([
    'chr2L:1,000,000-1,020,000',
    'chr19:47514000-47518000',
    'chr2L',
    'X:100-200',
    'roX1',
    'CG12345',
    'GAPDH',
    'Hsp70Aa',
    'roX1 +/- 5kb',
    'roX1+/-5kb',
    'NAPA TSS',
    'chr1:100',
    'https://example.org/a/1',
    // Not the lab shape: no letter in the barcode, a lower-case name, a region label.
    '12_3456_7',
    '4741_fp64dj_3',
    'eve_stripe2',
    '',
    '   ',
  ])('%s is not', (text) => {
    expect(parseReadNames(text)).toBeNull();
  });

  it('takes a list (commas, semicolons, spaces or lines), once each', () => {
    const a = 'm84046_240619_124816_s1/240062573/ccs';
    const b = '3c8f6d2a-1b7e-4f0a-9c55-0d2e7a9b1f34';
    expect(parseReadNames(`${a}, ${b}`)).toEqual([a, b]);
    expect(parseReadNames(`${a};${b} ${a}`)).toEqual([a, b]);
    expect(parseReadNames(`${a}\n${b}\n`)).toEqual([a, b]);
    // A list with a gene in it is not a read list (the gene search gets it).
    expect(parseReadNames(`${a}, roX1`)).toBeNull();
  });

  it('"read:" takes a name of any shape', () => {
    expect(parseReadNames('read: my_read_7')).toEqual(['my_read_7']);
    expect(parseReadNames('reads: a1, b2')).toEqual(['a1', 'b2']);
  });

  it('a pasted list on several lines becomes one line (a text box drops line breaks)', () => {
    expect(flattenPastedList('a/1/ccs\r\nb/2/ccs\n\n')).toBe('a/1/ccs, b/2/ccs');
    expect(flattenPastedList('chr1:1-100')).toBe('chr1:1-100');
    expect(formatReadNameList(['a', 'b', 'a'])).toBe('a\nb');
  });
});
