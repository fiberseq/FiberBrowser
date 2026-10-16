import { describe, expect, it } from 'vitest';
import {
  classifyStrandRescueAnnotation,
  classifyStrandRescueAction,
  annotationLayerRenderRank,
  expandStrandRescueLayerRequest,
  isStrandRescueLayer,
  strandRescueActionColor,
} from './strandRescue';

describe('strand-rescue presentation semantics', () => {
  it('recognizes the two first-class shadow layers without capturing arbitrary suffixes', () => {
    expect(isStrandRescueLayer('nuc_sr')).toBe(true);
    expect(isStrandRescueLayer('tf_sr')).toBe(true);
    expect(isStrandRescueLayer('caller_sr')).toBe(false);
  });

  it('classifies FiberHMM action names and unnamed baseline shadows', () => {
    expect(classifyStrandRescueAnnotation('')).toBe('unchanged');
    expect(classifyStrandRescueAnnotation('.')).toBe('unchanged');
    expect(classifyStrandRescueAnnotation('fhsr_deadbeef_R0')).toBe('rescued');
    expect(classifyStrandRescueAnnotation('fhsr_deadbeef_O2_H')).toBe('harmonized');
    expect(classifyStrandRescueAnnotation('fhlt_deadbeefdeadbeef_R0')).toBe('configuration');
    expect(classifyStrandRescueAnnotation('fhlt_deadbeefdeadbeef_N0_H')).toBe('configuration');
    expect(classifyStrandRescueAnnotation('fhlt_deadbeefdeadbeef_P_R0')).toBe('configuration');
    expect(classifyStrandRescueAnnotation('fhlt_deadbeefdeadbeef_P_N0_H')).toBe('configuration');
    expect(classifyStrandRescueAnnotation('manual_review')).toBe('annotated');
  });

  it('keeps unchanged shadows in baseline color and gives actions fixed colors', () => {
    expect(strandRescueActionColor('tf_sr', 'unchanged', '#e040fb')).toBe('#e040fb');
    expect(strandRescueActionColor('tf_sr', 'rescued', '#e040fb')).toBe('#7c3aed');
    expect(strandRescueActionColor('nuc_sr', 'harmonized', '#16a34a')).toBe('#0891b2');
    expect(strandRescueActionColor('tf_sr', 'configuration', '#e040fb')).toBe('#c026d3');
  });

  it('renders targeted SR from structured actions when annotation names are empty', () => {
    const actions = ['baseline', 'rescued', 'edge_refined', 'configuration']
      .map(kind => classifyStrandRescueAction(kind, ''));
    expect(actions).toEqual(['unchanged', 'rescued', 'harmonized', 'configuration']);
    expect(actions.map(action => strandRescueActionColor('tf_sr', action, '#999999')))
      .toEqual(['#999999', '#7c3aed', '#4f46e5', '#c026d3']);
  });

  it('prefers structured provenance while preserving legacy BAM annotation semantics', () => {
    expect(classifyStrandRescueAction('baseline', 'fhsr_deadbeef_R0')).toBe('unchanged');
    expect(classifyStrandRescueAction('rescued', 'fhsr_deadbeef_O2_H')).toBe('rescued');
    expect(classifyStrandRescueAction(undefined, 'fhsr_deadbeef_R0')).toBe('rescued');
    expect(classifyStrandRescueAction(null, 'fhsr_deadbeef_O2_H')).toBe('harmonized');
    expect(classifyStrandRescueAction('', '')).toBe('unchanged');
    expect(classifyStrandRescueAction('future_action', 'fhsr_deadbeef_R0')).toBe('annotated');
  });

  it('loads paired structural shadows together once either is active', () => {
    expect(expandStrandRescueLayerRequest(
      ['tf_sr'],
      ['nuc', 'tf', 'nuc_sr', 'tf_sr'],
    )).toEqual(['nuc_sr', 'tf_sr']);
    expect(expandStrandRescueLayerRequest(
      ['tf'],
      ['nuc_sr', 'tf_sr'],
    )).toEqual(['tf']);
    expect(expandStrandRescueLayerRequest(
      ['tf_sr'],
      ['tf_sr'],
    )).toEqual(['tf_sr']);
  });

  it('paints consensus shadows after their baseline layers', () => {
    const ordered = ['tf_sr', 'caller_custom', 'tf', 'msp', 'nuc_sr']
      .sort((a, b) => annotationLayerRenderRank(a) - annotationLayerRenderRank(b));
    expect(ordered).toEqual(['msp', 'caller_custom', 'tf', 'tf_sr', 'nuc_sr']);
  });
});
