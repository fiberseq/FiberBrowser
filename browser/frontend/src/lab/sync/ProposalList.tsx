import { useRef, type KeyboardEvent } from 'react';
import { AnalysisButton } from '../../components/controls/shared';
import { scrollIntoViewWithin } from '../../utils/scrollWithin';
import { WindowBadge, windowIdentity, formatNumber, type WindowIdentity } from './presentation';
import { statusColors } from './SyncMap';
import { repeatGroups, statusLabels, type Metric, type Proposal, type SyncResult, type Verdict } from './model';
export const shortLabels: Record<Metric, string> = { sequence: 'Seq', accessibility: 'Acc', nfr: 'NFR', anchor: 'Anchor', shape: 'Shape' };
const marks: Record<Verdict, { mark: string; text: string; className: string }> = {
  supports: { mark: '✓', text: 'supports', className: 'text-teal-700 dark:text-teal-300' },
  disagrees: { mark: '✗', text: 'disagrees', className: 'text-amber-700 dark:text-amber-300' },
  weak: { mark: '–', text: 'does not support', className: 'text-ink-secondary' },
  abstains: { mark: '·', text: 'could not assess', className: 'text-ink-muted' }
};
function metricChip(metric: Metric, a: NonNullable<Proposal['metrics'][Metric]>) {
  const value = a.score == null || (metric === 'sequence' && (a.verdict === 'disagrees' || !a.score)) ? '' : metric === 'sequence' ? ` ${Math.round(a.score * 100)}%${a.share != null && a.share < .95 ? ` over ${Math.round(a.share * 100)}%` : ''}` : metric === 'anchor' ? '' : ` r ${a.score.toFixed(2)}`;
  const m = marks[a.verdict];
  return <span key={metric} className={`whitespace-nowrap ${m.className}`} title={`${metric}: ${m.text}${a.why ? ` (${a.why})` : ''}`}>
    {shortLabels[metric]}{value} <span aria-hidden="true">{m.mark}</span><span className="sr-only">{m.text}</span>
  </span>;
}
/** The largest indels of a chain in words ("+1,429 bp in W3 at 6,832"), with the totals. */
export function indelText(p: Proposal, label: string): string {
  if (!p.indels || !(p.indels.inserted || p.indels.deleted))
    return '';
  const big = [...(p.gaps ?? [])].sort((a, b) => Math.max(b.inserted, b.deleted) - Math.max(a.inserted, a.deleted)).slice(0, 2)
    .filter(g => Math.max(g.inserted, g.deleted) >= 50)
    .map(g => g.inserted >= g.deleted ? `+${formatNumber(g.inserted)} bp in ${label} at ${formatNumber(g.template)}` : `−${formatNumber(g.deleted)} bp in ${label} at ${formatNumber(g.template)}`);
  const total = `${formatNumber(p.indels.count)} indel${p.indels.count === 1 ? '' : 's'}, +${formatNumber(p.indels.inserted)}/−${formatNumber(p.indels.deleted)} bp`;
  return big.length ? `${big.join('; ')} (${total})` : total;
}
/** Proposed correspondences, grouped by window pair; rows select with click, Enter or arrow keys. */
export function ProposalList({ result, proposals, identities = {}, focusedId, onFocus, onUseTemplate, onRotate, hidden = 0 }: {
  result: SyncResult;
  proposals: Proposal[];
  identities?: Record<string, WindowIdentity>;
  focusedId: string | null;
  onFocus: (p: Proposal) => void;
  onUseTemplate?: (panelId: string) => void;
  /** Rotate the template's or the window's circular window so the match sits inside it. */
  onRotate?: (p: Proposal, side: 'template' | 'window') => void;
  /** Proposals left out by the top-per-window limit. */
  hidden?: number;
}) {
  const list = useRef<HTMLDivElement>(null);
  const repeats = repeatGroups(result);
  proposals = proposals.filter(p => {
    const group = repeats.find(g => g.proposalIds.includes(p.id));
    return !group || group.proposalIds.find(id => proposals.some(q => q.id === id)) === p.id;
  });
  const identity = (id: string) => identities[id] ?? windowIdentity(Math.max(0, result.windows.findIndex(w => w.panelId === id)));
  const template = result.windows[0]?.panelId;
  const move = (e: KeyboardEvent, at: number) => {
    if (e.target !== e.currentTarget)
      return;
    const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? proposals.length - 1 : null;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onFocus(proposals[at]);
      return;
    }
    if (next == null || !proposals.length)
      return;
    e.preventDefault();
    const p = proposals[Math.max(0, Math.min(proposals.length - 1, next))];
    onFocus(p);
    const row = list.current?.querySelector<HTMLElement>(`[data-proposal="${p.id}"]`);
    row?.focus();
    scrollIntoViewWithin(row, { block: 'nearest' });
  };
  const focusedGroup = repeats.find(g => focusedId && g.proposalIds.includes(focusedId));
  const activeId = proposals.find(p => p.id === focusedId || focusedGroup?.proposalIds.includes(p.id))?.id;
  const tabbable = activeId ?? proposals[0]?.id;
  let lastGroup = '';
  return <div data-testid="sync-proposals" className="space-y-1">
    <div ref={list} role="listbox" aria-label="Proposed comparable regions" className="max-h-72 overflow-y-auto rounded-fb border border-line">
      {!proposals.length && <p className="p-2 text-ink-secondary">No proposals. Add a metric, widen the windows or lower the minimum block.</p>}
      {proposals.map((p, i) => {
        const repeat = repeats.find(g => g.proposalIds.includes(p.id));
        const group = `${p.partnerId}~${p.panelId}`;
        const header = group !== lastGroup;
        lastGroup = group;
        const isTemplate = p.partnerId === template;
        const window = result.windows.find(w => w.panelId === p.panelId);
        return <div key={p.id}>
          {header && <div role="presentation" className="sticky top-0 bg-gray-50 px-2 py-0.5 text-[11px] text-ink-secondary dark:bg-gray-800">
            <WindowBadge identity={identity(p.partnerId)} />{isTemplate ? ' template' : ''} ↔ <WindowBadge identity={identity(p.panelId)} /> · {window?.label}
            {!isTemplate && onUseTemplate && <AnalysisButton className="ml-2" data-testid={`sync-use-template-${p.partnerId}`} onClick={() => onUseTemplate(p.partnerId)}>Use {identity(p.partnerId).label} as template</AnalysisButton>}
          </div>}
          <div
            role="option"
            data-testid={`sync-proposal-${p.id}`}
            data-proposal={p.id}
            aria-selected={p.id === activeId}
            tabIndex={p.id === tabbable ? 0 : -1}
            onClick={() => onFocus(p)}
            onKeyDown={e => move(e, i)}
            className={`cursor-pointer border-t border-line px-2 py-1 text-[11px] focus:outline-none focus-visible:shadow-focus ${p.id === activeId ? 'bg-teal-50 dark:bg-teal-950' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
            {repeat && <div data-testid={`sync-repeat-group-${p.id}`} className="font-medium text-ink">
              {identity(p.panelId).label} · {repeat.coverage > 2 ? `${repeat.coverage} copies` : 'copy a ↔ copy b'}
              {repeat.inconsistent.length ? ' · inconsistent mappings' : ''}
            </div>}
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="font-mono text-ink">{formatNumber(p.template[0])}–{formatNumber(p.template[1])} ↔ {formatNumber(p.window[0])}–{formatNumber(p.window[1])}</span>
              <span className="text-ink-secondary">{p.strand === '-' ? 'reversed' : 'same strand'} · {formatNumber(p.aligned ?? p.template[1] - p.template[0])} bp</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="inline-flex items-center gap-1 whitespace-nowrap"><span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ backgroundColor: statusColors[p.status] }} />{statusLabels[p.status]}</span>
              <span className="whitespace-nowrap text-ink">confidence {p.confidence.toFixed(2)}</span>
              {(Object.entries(p.metrics) as [Metric, NonNullable<Proposal['metrics'][Metric]>][]).map(([m, a]) => metricChip(m, a))}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 text-ink-secondary">
              {p.flags?.includes('chromatin-only') ? <span data-testid={`sync-chromatin-only-${p.id}`} className="text-violet-700 dark:text-violet-300">chromatin only (no shared sequence){p.landmark ? ' · NFR landmark pair' : p.nfr ? ' · centred on NFRs' : ''}{p.z != null ? ` · z ${p.z.toFixed(1)}` : ''}</span>
                : p.rigid ? <span>rigid (one offset)</span> : (p.blocks?.length ?? 1) > 1 ? <span>chain of {formatNumber(p.blocks!.length)} blocks</span> : null}
              {p.flags?.includes('contradicted-by-sequence') && <span className="text-amber-700 dark:text-amber-300">sequence places this stretch elsewhere</span>}
              {indelText(p, identity(p.panelId).label) && <span>{indelText(p, identity(p.panelId).label)}</span>}
              {p.flags?.includes('repeat') && <span>{(p.alternatives ?? 0) + 1} places in {identity(p.panelId).label} match this stretch</span>}
              {p.flags?.includes('crosses-origin') && <span className="text-amber-700 dark:text-amber-300">crosses {(p.crosses ?? ['window']).map(side => `${identity(side === 'template' ? p.partnerId : p.panelId).label}’s`).join(' and ')} origin</span>}
            </div>
          </div>
          {p.flags?.includes('crosses-origin') && onRotate && isTemplate && <div role="presentation" className="flex flex-wrap gap-1 px-2 pb-1">
            {(p.crosses ?? ['window']).map(side => {
              const id = side === 'template' ? p.partnerId : p.panelId;
              return <AnalysisButton key={side} data-testid={`sync-rotate-${p.id}${side === 'template' ? '-template' : ''}`} onClick={() => onRotate(p, side)}>Rotate {identity(id).label} so this match sits inside it</AnalysisButton>;
            })}
          </div>}
        </div>;
      })}
    </div>
    {hidden > 0 && <p className="text-ink-muted">{formatNumber(hidden)} weaker proposal{hidden === 1 ? '' : 's'} hidden.</p>}
  </div>;
}
