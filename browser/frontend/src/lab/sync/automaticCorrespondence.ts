import type { BrowserState } from '../../stores/browserStore';
import { svCorrespondences } from '../../utils/svCorrespondence';
import { sharedPositionBlocks, framePeak } from '../../utils/equivalentPositions';
import type { Proposal, SyncResult, SyncWindow } from './model';

/** Known SV flanks and identical reference intervals are proposals, including their gaps. */
export function automaticCorrespondences(s: BrowserState, windows: SyncWindow[]): Proposal[] {
  const maps = svCorrespondences(s);
  const proposals: Proposal[] = [];
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
    const a = windows[i], b = windows[j];
    const map = maps.find(g => g.regions.some(m => m.match!.panelId === a.panelId) && g.regions.some(m => m.match!.panelId === b.panelId));
    let blocks: NonNullable<Proposal['blocks']> = [];
    let reversed = false;
    if (map) {
      const ma = map.regions.find(m => m.match!.panelId === a.panelId)!;
      const mb = map.regions.find(m => m.match!.panelId === b.panelId)!;
      reversed = ma.match!.reversed !== mb.match!.reversed;
      blocks = sharedPositionBlocks([ma, mb]).flatMap(([start, end]) => {
        const pa = framePeak(ma, start, end, ma, '')!, pb = framePeak(mb, start, end, mb, '')!;
        // Crop both ends through the common frame, including a reversed member.
        const lo = Math.max(0, a.start-pa.start, reversed ? pb.end-b.end : b.start-pb.start);
        const hi = Math.min(end-start, a.end-pa.start, reversed ? pb.end-b.start : b.end-pb.start);
        if (hi <= lo) return [];
        return [{ template: [pa.start+lo, pa.start+hi] as [number, number], window: (reversed
          ? [pb.end-hi, pb.end-lo] : [pb.start+lo, pb.start+hi]) as [number, number] }];
      });
    } else if (a.genome === b.genome && a.chrom === b.chrom) {
      const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end);
      if (end > start) blocks = [{ template: [start, end], window: [start, end] }];
    }
    if (!blocks.length) continue;
    const aligned = blocks.reduce((sum, block) => sum + block.template[1]-block.template[0], 0);
    proposals.push({ id: `automatic-${a.panelId}-${b.panelId}`, partnerId: a.panelId, panelId: b.panelId,
      rank: 0, template: [Math.min(...blocks.map(v => v.template[0])), Math.max(...blocks.map(v => v.template[1]))],
      window: [Math.min(...blocks.map(v => v.window[0])), Math.max(...blocks.map(v => v.window[1]))],
      strand: reversed ? '-' : '+', blocks, sources: ['sequence'], metrics: { sequence: { verdict: 'supports', score: 1,
        why: map ? 'Known SV correspondence: flanks matched; insertion or deletion is a gap.' : 'Same reference positions.' } },
      status: 'single-metric', confidence: 1, supports: 1, assessed: 1, identity: 1, aligned, flags: [] });
  }
  return proposals;
}

export function includeAutomaticCorrespondences(s: BrowserState, result: SyncResult): SyncResult {
  const automatic = automaticCorrespondences(s, result.windows);
  return { ...result, proposals: [...automatic, ...result.proposals.filter(p => !automatic.some(a => a.id === p.id))] };
}
