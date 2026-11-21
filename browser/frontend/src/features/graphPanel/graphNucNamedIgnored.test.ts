/**
 * Named nucleosome classes were removed (owner, 20 Nov 2026). Graph mode reads a call's class and z bytes only: a
 * payload that still carries the named byte (`nb`, cached from a FiberBrowser before the removal, or decoded from a
 * FiberHMM 3.1 BAM) is drawn exactly like one without it, and `nb` is never taken for a quality channel.
 */
import { describe, expect, it } from 'vitest';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import { buildLayout } from './layout';
import { buildScene } from './scene';
import { placeRead, placementIndex } from './readGeometry';
import { callPieceStyle } from './readCanvas';
import { chromatinStyle, graphNucMark } from './chromatinStyle';
import { DEFAULT_COLORMAP, type ColorRule } from '../../types';
import type { GraphBinding, GraphRead, GraphTopology } from './types';

const topology = alu10k.topology as unknown as GraphTopology;
const model = buildLayout(topology, alu10k.bindings as unknown as GraphBinding[]);
const COLORS = { target: '#334155', ref: '#334155', mat: '#c2410c', pat: '#1d4ed8' };
const scene = () => buildScene(model, {
  width: 1400, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression: 'log',
  reversed: false, colors: COLORS, smallBp: 0,
});
const MONO = '#ff00ff';
const mono: ColorRule = {
  id: 'mono', name: 'mono', color: MONO, opacity: 1, sizeMin: 1, sizeMax: null, targetLayers: [], conditions: [],
  nucCoarse: [2], enabled: true,
};
const colormap = { ...DEFAULT_COLORMAP, rules: [mono, ...DEFAULT_COLORMAP.rules] } as typeof DEFAULT_COLORMAP;

/** A read on the target path with one mono nucleosome call [93100, 93250) (nb: a named byte, as older payloads had). */
function read(nb?: (number | null)[]): GraphRead {
  return {
    k: 'ds|0|named|r', d: 'ds', lib: 0, q: 'named', rec: 'r', b: 'target', c: 'target', st: '+', sup: false,
    s: 93_000, e: 94_000, cov: [[93_000, 94_000, 0, 1]], ins: [], dl: [],
    nuc: { iv: [[93_100, 93_250, 150]], id: ['MA0:0'], part: [[100, 0]], cls: [2], zb: [128], ...(nb ? { nb } : {}) } as never,
  };
}

describe('graph mode: named nucleosome classes are ignored', () => {
  it('graphNucMark carries class and z bytes only', () => {
    const mark = graphNucMark(2, 128, 10, 20)!;
    expect(mark).toEqual({ start: 10, end: 20, coarse: 2, posterior: 0, z: 128 });
    expect('named' in mark).toBe(false);
  });

  it('a payload with a named byte is drawn as one without it, by its coarse class', () => {
    const index = placementIndex(scene(), topology);
    for (const payload of [read([3]), read()]) {
      const pieces = placeRead(payload, index).calls.filter(c => c.layer === 'nuc');
      expect(pieces.length).toBeGreaterThan(0);
      expect(pieces.every(c => c.cls === 2 && c.zb === 128 && !('nb' in c))).toBe(true);
      expect(pieces.every(c => !('nb' in (c.qualities ?? {})))).toBe(true);
      expect(callPieceStyle(chromatinStyle(colormap), pieces[0], true)!.color.toLowerCase()).toBe(MONO);
    }
  });
});
