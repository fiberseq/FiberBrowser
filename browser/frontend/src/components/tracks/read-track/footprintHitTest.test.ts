import { describe, expect, it } from 'vitest';
import type { CompactRead } from './types';
import { findFootprintHit } from './footprintHitTest';

function read(overrides: Partial<CompactRead> = {}): CompactRead {
  return {
    id: 'read-a',
    intervals: [[100, 220, 120]],
    ...overrides,
  };
}

describe('findFootprintHit', () => {
  it('prefers assigned class copies when requested, but never hidden or unassigned classes', () => {
    const r = read({layers:{
      tf:{intervals:[[145,160,15]]},
      tf_cr:{intervals:[[145,160,15]],consensus_workflow:true,job_id:'j',
        consensus_records:[{interval:[145,160],kind:'cr',family:'A'}]},
    }});
    const options={relPos:150,bpTolerance:0,enabledModTypes:{tf:true,tf_cr:true},assignedClassesOnly:true};
    expect(findFootprintHit(r,options)?.layer).toBe('tf_cr');
    expect(findFootprintHit(r,{...options,enabledModTypes:{tf:true,tf_cr:false}})).toBeNull();
    r.layers!.tf_cr.consensus_records![0].manual_ignored=true;
    expect(findFootprintHit(r,options)).toBeNull();
    expect(findFootprintHit(r,{...options,assignedClassesOnly:false})?.layer).toBe('tf');
  });
  it('prefers the smallest enabled overlay interval over the primary footprint', () => {
    const hit = findFootprintHit(read({
      layers: {
        nuc: { intervals: [[100, 220, 120]] },
        tf: { intervals: [[145, 160, 15]] },
      },
    }), {
      relPos: 150,
      bpTolerance: 0,
      enabledModTypes: { tf: true, nuc: true },
    });

    expect(hit).toMatchObject({ intervalIndex: 0, interval: [145, 160, 15], layer: 'tf' });
  });

  it('supports the FIRE click target for legacy read.fire payloads', () => {
    const hit = findFootprintHit(read({
      fire: [[130, 170, 240]],
    }), {
      relPos: 129,
      bpTolerance: 2,
      clickTargetLayer: 'fire',
      enabledModTypes: { fire: true },
    });

    expect(hit).toMatchObject({ intervalIndex: 0, interval: [130, 170, 40], layer: 'fire' });
  });

  it('does not fall back to primary intervals when a non-primary target misses', () => {
    const hit = findFootprintHit(read(), {
      relPos: 150,
      bpTolerance: 2,
      clickTargetLayer: 'tf',
      enabledModTypes: { tf: true },
    });

    expect(hit).toBeNull();
  });

  it('uses the split nuc layer for primary fallback when present', () => {
    const hit = findFootprintHit(read({
      intervals: [[100, 220, 120]],
      layers: {
        nuc: { intervals: [[100, 140, 40], [180, 220, 40]] },
        tf: { intervals: [[150, 160, 10]] },
      },
    }), {
      relPos: 155,
      bpTolerance: 0,
      clickTargetLayer: 'nuc',
      enabledModTypes: { tf: false, nuc: true },
    });

    expect(hit).toBeNull();
  });

  it('expands the nuc click target to the liberal boundary in soft and loose modes', () => {
    // Conservative nuc spans [100,140); el=0 (left edge fully ambiguous) extends
    // it left by maxGapBp=30 to ~70. A click at relPos 80 misses conservatively
    // but lands inside the extended boundary.
    const nucRead = read({
      intervals: [[100, 140, 40]],
      layers: {
        nuc: {
          intervals: [[100, 140, 40]],
          qualities: [[200], [0], [255]],   // nq, el (left=fuzzy), er (right=crisp)
          quality_names: ['nq', 'el', 'er'],
        },
      },
    });
    const opts = {
      relPos: 80,
      bpTolerance: 0,
      clickTargetLayer: 'nuc',
      enabledModTypes: { nuc: true },
    } as const;

    // Strict / default: no extension, click misses.
    expect(findFootprintHit(nucRead, opts)).toBeNull();
    expect(findFootprintHit(nucRead, {
      ...opts,
      edgeAmbiguity: { mode: 'strict', applyNuc: true, applyTf: true, maxGapBp: 30 },
    })).toBeNull();

    // Soft and loose both draw out to the liberal edge, so both catch the click.
    for (const mode of ['soft', 'loose'] as const) {
      const hit = findFootprintHit(nucRead, {
        ...opts,
        edgeAmbiguity: { mode, applyNuc: true, applyTf: true, maxGapBp: 30 },
      });
      expect(hit).toMatchObject({ intervalIndex: 0, layer: 'nuc' });

      // A click past the crisp right edge (er=255 → no extension) still misses.
      expect(findFootprintHit(nucRead, {
        ...opts,
        relPos: 150,
        edgeAmbiguity: { mode, applyNuc: true, applyTf: true, maxGapBp: 30 },
      })).toBeNull();
    }
  });

  it('aliases msp and fire for target matching', () => {
    const hit = findFootprintHit(read({
      layers: {
        msp: { intervals: [[130, 170, 40]] },
      },
    }), {
      relPos: 150,
      bpTolerance: 0,
      clickTargetLayer: 'fire',
      enabledModTypes: { fire: true },
    });

    expect(hit).toMatchObject({ intervalIndex: 0, interval: [130, 170, 40], layer: 'fire' });
  });

  it('uses renderer-supplied family bounds but returns the raw molecule call', () => {
    const hit = findFootprintHit(read({
      layers: {
        tf_sr: { intervals: [[145, 160, 15]] },
      },
    }), {
      relPos: 168,
      bpTolerance: 0,
      clickTargetLayer: 'tf_sr',
      enabledModTypes: { tf_sr: true },
      displayBounds: (layerName) => layerName === 'tf_sr'
        ? { start: 140, end: 175 }
        : null,
    });

    expect(hit).toMatchObject({
      intervalIndex: 0,
      interval: [145, 160, 15],
      layer: 'tf_sr',
    });
  });
});
