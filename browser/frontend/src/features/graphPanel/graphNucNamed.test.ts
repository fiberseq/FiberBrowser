/**
 * Codex D2-2: graph mode reads the named class byte (`nb`, wire version 10) as the linear renderer does. A mono
 * footprint with nucsz bytes [2, 3, 200, 128] (octasome) matches a nucNamed [3] rule and not a nucNamed [0] one;
 * a call without named evidence (an older payload) matches no named rule, never "unnamed" (0).
 */
import { describe, expect, it } from 'vitest';
import alu10k from './__fixtures__/gateC/alu_10k.topology.json';
import { buildLayout } from './layout';
import { buildScene } from './scene';
import { placeRead, placementIndex } from './readGeometry';
import { callPieceStyle } from './readCanvas';
import { chromatinStyle, graphNucMark } from './chromatinStyle';
import { NUC_NAMED_MISSING } from '../../utils/nucLayers';
import { DEFAULT_COLORMAP, type ColorRule } from '../../types';
import type { GraphBinding, GraphRead, GraphTopology } from './types';

const topology = alu10k.topology as unknown as GraphTopology;
const model = buildLayout(topology, alu10k.bindings as unknown as GraphBinding[]);
const COLORS = { target: '#334155', ref: '#334155', mat: '#c2410c', pat: '#1d4ed8' };
const scene = () => buildScene(model, {
  width: 1400, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression: 'log',
  reversed: false, colors: COLORS, smallBp: 0,
});
const NUC_DEFAULT = '#33a040';
const OCTA = '#ff00ff';
const UNNAMED = '#00ffff';
const rule = (id: string, color: string, nucNamed: number[]): ColorRule => ({
  id, name: id, color, opacity: 1, sizeMin: 1, sizeMax: null, targetLayers: [], conditions: [], nucNamed, enabled: true,
});
const namedColormap = { ...DEFAULT_COLORMAP, rules: [rule('octa', OCTA, [3]), ...DEFAULT_COLORMAP.rules] } as typeof DEFAULT_COLORMAP;
const unnamedColormap = { ...DEFAULT_COLORMAP, rules: [rule('none', UNNAMED, [0]), ...DEFAULT_COLORMAP.rules] } as typeof DEFAULT_COLORMAP;

/** A read on the target path with one nucleosome call [93100, 93250) and its class bytes (nb omitted: none). */
function read(nb?: (number | null)[]): GraphRead {
  return {
    k: 'ds|0|named|r', d: 'ds', lib: 0, q: 'named', rec: 'r', b: 'target', c: 'target', st: '+', sup: false,
    s: 93_000, e: 94_000, cov: [[93_000, 94_000, 0, 1]], ins: [], dl: [],
    nuc: { iv: [[93_100, 93_250, 150]], id: ['MA0:0'], part: [[100, 0]], cls: [2], zb: [128], ...(nb ? { nb } : {}) },
  };
}

describe('graph mode: named nucleosome classes (Codex D2-2)', () => {
  it('graphNucMark carries the named byte; missing named evidence is not "unnamed"', () => {
    expect(graphNucMark(2, 128, 3)!.named).toBe(3);
    expect(graphNucMark(2, 128, 0)!.named).toBe(0);
    expect(graphNucMark(2, 128)!.named).toBe(NUC_NAMED_MISSING);
    expect(graphNucMark(2, 128, null)!.named).toBe(NUC_NAMED_MISSING);
    expect(NUC_NAMED_MISSING).not.toBe(0);
    const mark = graphNucMark(2, 128, 3, 10, 20)!;
    expect([mark.start, mark.end]).toEqual([10, 20]);
  });

  it('an octasome matches a nucNamed [3] rule and not a nucNamed [0] rule', () => {
    expect(chromatinStyle(namedColormap).call('nuc', 150, {}, graphNucMark(2, 128, 3))!.color.toLowerCase()).toBe(OCTA);
    expect(chromatinStyle(unnamedColormap).call('nuc', 150, {}, graphNucMark(2, 128, 3))!.color.toLowerCase()).toBe(NUC_DEFAULT);
    // An unnamed footprint (byte 0) matches the [0] rule.
    expect(chromatinStyle(unnamedColormap).call('nuc', 150, {}, graphNucMark(2, 128, 0))!.color.toLowerCase()).toBe(UNNAMED);
    // No named byte: neither rule matches.
    expect(chromatinStyle(namedColormap).call('nuc', 150, {}, graphNucMark(2, 128))!.color.toLowerCase()).toBe(NUC_DEFAULT);
    expect(chromatinStyle(unnamedColormap).call('nuc', 150, {}, graphNucMark(2, 128))!.color.toLowerCase()).toBe(NUC_DEFAULT);
  });

  it('call pieces carry the wire\'s named byte into the renderer\'s style', () => {
    const pieces = placeRead(read([3]), placementIndex(scene(), topology)).calls.filter(c => c.layer === 'nuc');
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.every(c => c.cls === 2 && c.nb === 3 && c.zb === 128)).toBe(true);
    expect(callPieceStyle(chromatinStyle(namedColormap), pieces[0], true)!.color.toLowerCase()).toBe(OCTA);
    expect(callPieceStyle(chromatinStyle(unnamedColormap), pieces[0], true)!.color.toLowerCase()).toBe(NUC_DEFAULT);
    // A wire-9 payload (no nb): no named evidence, so a nucNamed [0] rule does not match it.
    const old = placeRead(read(), placementIndex(scene(), topology)).calls.filter(c => c.layer === 'nuc');
    expect(old.every(c => c.cls === 2 && c.nb == null)).toBe(true);
    expect(callPieceStyle(chromatinStyle(unnamedColormap), old[0], true)!.color.toLowerCase()).toBe(NUC_DEFAULT);
    expect(callPieceStyle(chromatinStyle(namedColormap), old[0], true)!.color.toLowerCase()).toBe(NUC_DEFAULT);
  });
});
