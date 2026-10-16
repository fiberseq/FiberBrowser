import {describe, it, expect} from 'vitest';
import {familyWorkflowMode} from './familyWorkflowMode';
describe('automatic staged family mode', () => {
  it('requires metadata for every selected dataset', () => {
    expect(familyWorkflowMode([])).toBeNull();
    expect(familyWorkflowMode(['ddda', null])).toBeNull();
    expect(familyWorkflowMode(['unknown'])).toBeNull();
  });
  it('selects source scope from chemistry and dataset count', () => {
    expect(familyWorkflowMode(['hia5-pacbio'])).toBe('CR');
    expect(familyWorkflowMode(['ddda'])).toBe('SR');
    expect(familyWorkflowMode(['dddb'])).toBe('SR');
    expect(familyWorkflowMode(['hia5-pacbio','hia5-pacbio'])).toBe('XCR');
    expect(familyWorkflowMode(['ddda','hia5-pacbio'])).toBe('SR/XCR');
  });
  it('reports the current ONT pooling behavior honestly', () => {
    expect(familyWorkflowMode(['hia5-nanopore'])).toBe('CR');
    expect(familyWorkflowMode(['hia5-nanopore','hia5-pacbio'])).toBe('XCR');
  });
});
