import { describe, it, expect } from 'vitest';
import { classLabel, classNumber, runLabel, runTitle, savedClassLabel } from './classIdentity';

describe('class identity', () => {
  it('names a class by its own id, padded', () => {
    expect(classNumber('025')).toBe(25);
    expect(classNumber('cr_25')).toBe(25);
    expect(classNumber('F0004')).toBe(4);
    expect(classNumber('none')).toBeNull();
    expect(classLabel('025')).toBe('Class 025');
    expect(classLabel(7)).toBe('Class 007');
    expect(classLabel({ family: 'cr_25' })).toBe('Class 025');
    expect(classLabel({ label: 'class 025' })).toBe('Class 025');
    expect(classLabel('A')).toBe('Class A');
    expect(classLabel(1234)).toBe('Class 1234');
  });
  it('labels saved classes and runs with their provenance', () => {
    expect(savedClassLabel(1, '025')).toBe('S1 · Class 025');
    expect(runLabel('footprint', '26a17840-aaaa')).toBe('Footprint run 26a1…');
    expect(runLabel('source-nfr', '58404ac9')).toBe('Source NFR run 5840…');
    expect(runLabel('nfr', 'ab')).toBe('NFR run ab');
    expect(runLabel('footprint', null)).toBe('Footprint run');
    expect(runTitle('footprint', '26a17840')).toBe('Footprint run 26a17840');
  });
});
