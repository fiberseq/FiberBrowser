import { beforeEach, describe, expect, it } from 'vitest';
import type { ColorRule } from '../types';
import {
  RECENT_RULE_COLORS_STORAGE_KEY,
  buildRuleColorResolver,
  getRuleColorForSize,
  interpolateHexColor,
  loadRecentRuleColors,
  normalizeRuleColorVisuals,
  saveRecentRuleColor,
} from './ruleColors';

function rule(overrides: Partial<ColorRule>): ColorRule {
  return {
    id: 'rule',
    name: 'Rule',
    color: '#888888',
    sizeMin: 10,
    sizeMax: 20,
    targetLayers: [],
    conditions: [],
    enabled: true,
    ...overrides,
  };
}

describe('ruleColors', () => {
  beforeEach(() => {
    localStorage.removeItem(RECENT_RULE_COLORS_STORAGE_KEY);
  });

  it('keeps solid rules on their base color', () => {
    expect(getRuleColorForSize(rule({ color: '#123456' }), 15)).toBe('#123456');
  });

  it('interpolates size-gradient rules across the rule size range', () => {
    const gradientRule = rule({
      colorMode: 'size_gradient',
      color: '#000000',
      gradient: { startColor: '#000000', endColor: '#ffffff', scale: 'linear' },
    });

    expect(getRuleColorForSize(gradientRule, 10)).toBe('#000000');
    expect(getRuleColorForSize(gradientRule, 15)).toBe('#808080');
    expect(getRuleColorForSize(gradientRule, 20)).toBe('#ffffff');
  });

  it('applies nonlinear size scaling before color interpolation', () => {
    const sqrtRule = rule({
      colorMode: 'size_gradient',
      color: '#000000',
      gradient: { startColor: '#000000', endColor: '#ffffff', scale: 'sqrt' },
    });
    const squareRule = rule({
      colorMode: 'size_gradient',
      color: '#000000',
      gradient: { startColor: '#000000', endColor: '#ffffff', scale: 'square' },
    });

    expect(getRuleColorForSize(sqrtRule, 15)).toBe('#b4b4b4');
    expect(getRuleColorForSize(squareRule, 15)).toBe('#404040');
  });

  it('clamps size-gradient colors to an independent gradient domain', () => {
    const gradientRule = rule({
      colorMode: 'size_gradient',
      color: '#00ff00',
      sizeMin: 100,
      sizeMax: null,
      gradient: {
        startColor: '#00ff00',
        endColor: '#ff8000',
        sizeMin: 200,
        sizeMax: 1000,
        scale: 'linear',
      },
    });

    expect(getRuleColorForSize(gradientRule, 150)).toBe('#00ff00');
    expect(getRuleColorForSize(gradientRule, 600)).toBe('#80c000');
    expect(getRuleColorForSize(gradientRule, 1200)).toBe('#ff8000');
  });

  it('uses the start color when a gradient rule has no finite end size', () => {
    const openEndedRule = rule({
      colorMode: 'size_gradient',
      sizeMax: null,
      color: '#111111',
      gradient: { startColor: '#111111', endColor: '#eeeeee', scale: 'linear' },
    });

    expect(getRuleColorForSize(openEndedRule, 100)).toBe('#111111');
  });

  it('builds reusable color resolvers for hot render loops', () => {
    const gradientRule = rule({
      colorMode: 'size_gradient',
      color: '#00ff00',
      sizeMin: 100,
      sizeMax: 300,
      gradient: {
        startColor: '#00ff00',
        endColor: '#ff8000',
        scale: 'linear',
      },
    });
    const resolveColor = buildRuleColorResolver(gradientRule);

    expect(resolveColor(100)).toBe('#00ff00');
    expect(resolveColor(200)).toBe('#80c000');
    expect(resolveColor(300)).toBe('#ff8000');
  });

  it('normalizes persisted gradient color fields', () => {
    expect(normalizeRuleColorVisuals({
      color: '#ABCDEF',
      colorMode: 'size_gradient',
      gradient: { startColor: '#000000', endColor: '#FFFFFF', scale: 'log' },
    })).toEqual({
      color: '#abcdef',
      colorMode: 'size_gradient',
      gradient: { startColor: '#000000', endColor: '#ffffff', sizeMin: null, sizeMax: null, scale: 'log' },
    });
  });

  it('interpolates hex colors directly for previews and tests', () => {
    expect(interpolateHexColor('#ff0000', '#0000ff', 0.5)).toBe('#800080');
  });

  it('stores recent rule colors in most-recent order without duplicates', () => {
    saveRecentRuleColor('#ABCDEF');
    saveRecentRuleColor('#123456');
    saveRecentRuleColor('#abcdef');

    expect(loadRecentRuleColors()).toEqual(['#abcdef', '#123456']);
  });
});
