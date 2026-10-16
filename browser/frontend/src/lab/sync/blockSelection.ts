import {
  multiwayBlocks, repeatProposals, proposalBlocks, swapSides, clipBlock, frameWindows,
  type Block, type MultiBlock, type Proposal, type SyncResult, type Selection, type Interval, type ComparisonFrame,
} from './model';

export interface MemberChoice { key: string; panelId: string; interval: Interval; copy?: string }
export interface SelectableBlock extends MultiBlock { choices: MemberChoice[] }
const cache = new WeakMap<SyncResult, { virtual: SyncResult; choices: MemberChoice[]; blocks: SelectableBlock[] }>();

/** Copies and cross-window matches use the same graph, with one node per physical stretch. */
function graph(result: SyncResult) {
  const cached = cache.get(result);
  if (cached) return cached;
  const proposals = [...result.proposals.filter(p => p.panelId !== p.partnerId), ...repeatProposals(result)]
    .map(p => p.metrics.sequence?.verdict === 'supports' && !p.flags?.includes('contradicted-by-sequence') ? { ...p, status: 'single-metric' as const } : p)
    .filter(p => p.status !== 'weak' && p.status !== 'disagreement' && !p.flags?.includes('contradicted-by-sequence'));
  const sides = proposals.flatMap(p => [
    { panelId: p.partnerId, interval: p.template, aligned: proposalBlocks(p).map(b => b.template) },
    { panelId: p.panelId, interval: p.window, aligned: proposalBlocks(p).map(b => b.window) },
  ]);
  const parents = sides.map((_, i) => i);
  const root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]));
  const length = (ivs: Interval[]) => ivs.reduce((n, [a, b]) => n + b - a, 0);
  for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) {
    if (sides[i].panelId !== sides[j].panelId) continue;
    const shared = sides[i].aligned.reduce((n, [a, b]) => n + sides[j].aligned.reduce((m, [c, d]) => m + Math.max(0, Math.min(b, d) - Math.max(a, c)), 0), 0);
    if (shared > 0 && shared >= .5 * Math.min(length(sides[i].aligned), length(sides[j].aligned))) parents[root(j)] = root(i);
  }
  const choices: MemberChoice[] = [...new Set(sides.map((_, i) => root(i)))].map(i => {
    const intervals = sides.filter((_, k) => root(k) === i).map(s => s.interval);
    return { key: `m${i}`, panelId: sides[i].panelId, interval: [Math.min(...intervals.map(v => v[0])), Math.max(...intervals.map(v => v[1]))] };
  });
  const virtual: SyncResult = { ...result,
    windows: choices.map(c => ({ ...result.windows.find(w => w.panelId === c.panelId)!, panelId: c.key })),
    proposals: proposals.map((p, i) => ({ ...p, partnerId: `m${root(i * 2)}`, panelId: `m${root(i * 2 + 1)}` })),
  };
  const blocks = multiwayBlocks(virtual).map(block => {
    const members = choices.filter(c => block.members.some(m => m.panelId === c.key));
    const panelIds = [...new Set(members.map(c => c.panelId))];
    const labelled = panelIds.flatMap(panelId => members.filter(c => c.panelId === panelId).sort((a, b) => a.interval[0] - b.interval[0])
      .map((c, i, all) => ({ ...c, ...(all.length > 1 ? { copy: String.fromCharCode(97 + i) } : {}) })));
    return { ...block, choices: labelled, coverage: panelIds.length, total: result.windows.length,
      members: panelIds.map(panelId => ({ panelId, intervals: labelled.filter(c => c.panelId === panelId).map(c => c.interval) })) };
  });
  const value = { virtual, choices, blocks };
  cache.set(result, value);
  return value;
}

/** Multi-way blocks including within-window copies, without a template requirement. */
export const selectableBlocks = (result: SyncResult): SelectableBlock[] => graph(result).blocks;
export const defaultMembers = (blocks: SelectableBlock[]): string[] => blocks.filter(b => !b.inconsistent.length).flatMap(b => b.choices.map(c => c.key));

function compose(first: Proposal, next: Proposal): Proposal | null {
  const blocks: Block[] = [];
  for (const a of proposalBlocks(first)) for (const b of proposalBlocks(next)) {
    const lo = Math.max(a.window[0], b.template[0]), hi = Math.min(a.window[1], b.template[1]);
    if (hi <= lo) continue;
    const left = clipBlock(a, first.strand, lo, hi, 'window'), right = clipBlock(b, next.strand, lo, hi, 'template');
    if (left && right) blocks.push({ template: left.template, window: right.window });
  }
  if (!blocks.length) return null;
  blocks.sort((a, b) => a.template[0] - b.template[0]);
  return { ...next, partnerId: first.partnerId, blocks, strand: first.strand === next.strand ? '+' : '-',
    template: [blocks[0].template[0], blocks[blocks.length - 1].template[1]],
    window: [Math.min(...blocks.map(b => b.window[0])), Math.max(...blocks.map(b => b.window[1]))],
    confidence: Math.min(first.confidence, next.confidence), flags: [...(next.flags ?? []), 'through-member'] };
}

/** Compose selected members through aligned bases only; gaps are never filled. */
export function selectionForMembers(result: SyncResult, block: SelectableBlock, keys: string[]): { selection?: Selection; error?: string } {
  const selected = block.choices.filter(c => keys.includes(c.key));
  if (selected.length < 2) return { error: 'Choose at least two members.' };
  const { virtual, choices } = graph(result);
  const proposals = virtual.proposals.filter(p => block.proposalIds.includes(p.id)
    && (!block.inconsistent.length || (keys.includes(p.panelId) && keys.includes(p.partnerId))));
  if (block.inconsistent.length && multiwayBlocks({ ...virtual, proposals }).some(b => b.inconsistent.length))
    return { error: 'These matches place the same bases in different positions. Untick a member.' };
  const first = selected[0];
  const paths = new Map<string, Proposal | null>([[first.key, null]]);
  const queue = [first.key];
  const edges = [...proposals].sort((a, b) => b.confidence - a.confidence).flatMap(p => [p, swapSides(p)]);
  for (const at of queue) for (const edge of edges) {
    if (edge.partnerId !== at || paths.has(edge.panelId)) continue;
    const previous = paths.get(at);
    const mapped = previous ? compose(previous, edge) : edge;
    if (!mapped) continue;
    paths.set(edge.panelId, mapped); queue.push(edge.panelId);
  }
  if (selected.some(c => !paths.has(c.key))) return { error: 'These members have no aligned bases connecting them. Choose another match.' };
  const matches = selected.slice(1).map(c => paths.get(c.key)!).map(p => ({ ...p,
    partnerId: first.panelId, panelId: choices.find(c => c.key === p.panelId)!.panelId }));
  const start = Math.min(...matches.map(p => p.template[0])), end = Math.max(...matches.map(p => p.template[1]));
  const selection: Selection = { templateId: first.panelId, matches, start, end,
    excluded: result.windows.filter(w => !selected.some(c => c.panelId === w.panelId)).map(w => w.panelId) };
  if (frameWindows(result, selection).length !== selected.length) return { error: 'A member has no aligned bases in this region. Choose another match.' };
  return { selection };
}

/** Concatenate selected blocks in one frame; each member retains its gaps and direction. */
export function mergeBlockFrames(frames: ComparisonFrame[]): ComparisonFrame {
  if (!frames.length) throw new Error('Choose a block first.');
  const ordered = [...frames].sort((a, b) => a.windows[0].start - b.windows[0].start);
  const windows = new Map<string, ComparisonFrame['windows'][number]>();
  let offset = 0;
  for (const f of ordered) {
    for (const w of f.windows) {
      const key = `${w.panelId}#${w.copy ?? ''}`;
      const old = windows.get(key);
      if (old && old.strand !== w.strand) throw new Error('These blocks run in different directions. Accept them as separate groups.');
      const blocks = [...(old?.blocks ?? []), ...w.blocks.map(b => ({ ...b, frame: [b.frame[0] + offset, b.frame[1] + offset] as Interval }))];
      windows.set(key, { ...w, provenance: old?.provenance ?? w.provenance, blocks,
        start: Math.min(old?.start ?? w.start, w.start), end: Math.max(old?.end ?? w.end, w.end) });
    }
    offset += f.length;
  }
  return { ...ordered[0], windows: [...windows.values()], length: offset };
}
