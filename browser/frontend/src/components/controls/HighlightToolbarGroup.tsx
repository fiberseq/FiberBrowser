import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { HIGHLIGHT_COLORS } from '../../stores/highlightSlice';
import type { Highlight } from '../../types/regions';
import { highlightSelectedPeaks, highlightView } from '../../utils/highlightActions';
import { regionAnalysisExtension } from '../../utils/regionAnalysis';
import { goToRegion, mainGenomeKey } from '../../utils/regionNavigation';
import { shownPanelViews, visibleDatasetPanels } from '../../utils/panelScope';
import { ActionButton } from '../ui/ActionButton';
import { Crosshair, Highlighter, Trash, X } from '../ui/Icons';
import { AnalysisButton } from './shared/AnalysisControls';
import { ToolbarGroup } from './ToolbarGroups';

const SMALL = 'fb-btn-ghost h-[22px] gap-1 px-1.5 text-[11px]';

function locus(h: Pick<Highlight, 'chrom' | 'start' | 'end'>): string {
  return `${h.chrom}:${h.start.toLocaleString()}-${h.end.toLocaleString()}`;
}

/** The colour choices, as small swatches. */
function Swatches({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  return (
    <div className="flex items-center gap-0.5" role="radiogroup" aria-label={label}>
      {HIGHLIGHT_COLORS.map(c => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={value === c.color}
          aria-label={c.name}
          title={c.name}
          onClick={() => onChange(c.color)}
          className={`h-4 w-4 rounded-sm border ${value === c.color ? 'border-gray-800 ring-1 ring-gray-800 dark:border-white dark:ring-white' : 'border-black/15 dark:border-white/20'}`}
          style={{ backgroundColor: c.color }}
          data-testid={`highlight-color-${c.id}`}
        />
      ))}
    </div>
  );
}

/**
 * A highlight's name, edited in place. The draft follows the stored name
 * (an Undo of a rename shows at once) and only a change the user typed is saved.
 */
function HighlightNameInput({ highlight, onCommit }: { highlight: Highlight; onCommit: (label: string | undefined) => void }) {
  const stored = highlight.label ?? '';
  const [draft, setDraft] = useState(stored);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(stored); }, [stored, editing]);
  const commit = () => {
    setEditing(false);
    const value = draft.trim();
    if (value !== stored) onCommit(value || undefined);
  };
  return (
    <input
      className="input-tool h-[22px] min-w-0 flex-1 text-[11px]"
      value={draft}
      placeholder={locus(highlight)}
      aria-label={`Name of the highlight at ${locus(highlight)}`}
      onFocus={() => setEditing(true)}
      onChange={e => { setEditing(true); setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); setDraft(stored); }
      }}
      data-testid="highlight-label-input"
    />
  );
}

/** Every highlight: rename, recolour, go there, remove; Clear all. */
function HighlightList({ onClose }: { onClose: () => void }) {
  const { highlights, updateHighlight, removeHighlight, clearHighlights } = useBrowserStore(useShallow(s => ({
    highlights: s.highlights, updateHighlight: s.updateHighlight, removeHighlight: s.removeHighlight, clearHighlights: s.clearHighlights,
  })));
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div
      className="absolute right-0 top-full z-[95] mt-1 flex max-h-[min(24rem,70vh)] w-[22rem] max-w-[calc(100vw-1rem)] flex-col rounded-fb-lg border border-line bg-white p-2 text-[12px] shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:shadow-dropdown-dark"
      data-testid="highlight-list"
      role="dialog"
      aria-label="Highlights"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-ink">Highlights</span>
        <button type="button" className="rounded p-0.5 text-ink-muted hover:bg-gray-100 dark:hover:bg-white/10" onClick={onClose} aria-label="Close"><X size={12} /></button>
      </div>
      {highlights.length === 0 ? (
        <p className="py-2 text-ink-muted">None yet. Turn Highlight on and drag on a ruler, or Shift-drag a ruler any time.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {highlights.map(h => (
            <li key={h.id} className="rounded-fb border border-line/80 p-1.5 dark:border-white/10" data-testid="highlight-item">
              <div className="flex items-center gap-1">
                <span className="h-3 w-3 shrink-0 rounded-sm border border-black/15" style={{ backgroundColor: h.color }} aria-hidden="true" />
                <HighlightNameInput highlight={h} onCommit={label => updateHighlight(h.id, { label })} />
                <button
                  type="button"
                  className="rounded p-0.5 text-ink-muted hover:bg-gray-100 hover:text-ink dark:hover:bg-white/10"
                  title="Go there"
                  aria-label={`Go to ${h.label || locus(h)}`}
                  onClick={() => setMessage(goToRegion(h.genome, { id: h.id, chrom: h.chrom, start: h.start, end: h.end, label: h.label ?? '', category: '', source: 'saved' }))}
                ><Crosshair size={12} /></button>
                <button
                  type="button"
                  className="rounded p-0.5 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                  title="Remove this highlight (Undo brings it back)"
                  aria-label={`Remove the highlight ${h.label || locus(h)}`}
                  onClick={() => removeHighlight(h.id)}
                  data-testid="highlight-remove"
                ><Trash size={12} /></button>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[10.5px] text-ink-muted">{h.genome} · {locus(h)}</span>
                <Swatches value={h.color} onChange={color => updateHighlight(h.id, { color })} label={`Colour of ${h.label || locus(h)}`} />
              </div>
              {regionAnalysisExtension()&&<AnalysisButton data-testid="highlight-link-matched" onClick={()=>{
                const state=useBrowserStore.getState();
                regionAnalysisExtension()!.link({chrom:h.chrom,start:h.start,end:h.end,genome:h.genome===mainGenomeKey(state)?null:h.genome});
              }}>Link as matched</AnalysisButton>}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{message}</p>}
      {highlights.length > 0 && (
        <div className="mt-1.5 flex justify-end">
          <button type="button" className={`${SMALL} text-red-600 hover:!text-red-700`} onClick={clearHighlights} data-testid="highlight-clear">
            <Trash size={11} aria-hidden="true" /> Clear all
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The toolbar's Highlight group (beside Scan, Cluster, Sort and Filter): the
 * action turns ruler-drag highlighting on and off; the controls highlight the
 * view or the selected peaks, choose the next colour, list the highlights and
 * clear them all (also the palette's "Clear highlights").
 */
export function HighlightToolbarGroup() {
  const { drawMode, setDrawMode, color, setColor, count, selectedPeaks, clearHighlights } = useBrowserStore(useShallow(s => ({
    drawMode: s.highlightDrawMode, setDrawMode: s.setHighlightDrawMode, color: s.highlightColor, setColor: s.setHighlightColor,
    count: s.highlights.length, selectedPeaks: s.selectedPeaks.size, clearHighlights: s.clearHighlights,
  })));
  // The loci "View" highlights (each panel's own: the main locus is stale in Per panel mode).
  const viewCount = useBrowserStore(s => shownPanelViews(s).length);
  const anySelected = useBrowserStore(s => visibleDatasetPanels(s).some(p => s.selectedDatasets.has(p.id)));
  const [listOpen, setListOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listOpen) return;
    const onPointer = (e: PointerEvent) => { if (listRef.current && !listRef.current.contains(e.target as Node)) setListOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setListOpen(false); } };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey); };
  }, [listOpen]);
  // Escape leaves the drawing mode too.
  useEffect(() => {
    if (!drawMode) return;
    // (Not when the Escape closed a menu or a field: that handler took it.)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setDrawMode(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawMode, setDrawMode]);

  return (
    <ToolbarGroup
      id="highlight"
      label="Highlight"
      summary={<span className="text-gray-600 dark:text-gray-400">{count === 0 ? 'none' : `${count} highlight${count === 1 ? '' : 's'}`}</span>}
      action={(
        <ActionButton
          tone="highlight"
          icon={<Highlighter size={13} aria-hidden="true" />}
          active={drawMode}
          aria-pressed={drawMode}
          onClick={() => setDrawMode(!drawMode)}
          title={drawMode
            ? 'Highlighting: drag on a ruler to shade a region in every panel on that genome. Click again (or Escape) to stop.'
            : 'Highlight: drag on a ruler to shade a region in every panel on that genome (Shift-drag works any time)'}
          data-testid="highlight-run-button"
        >
          Highlight
        </ActionButton>
      )}
    >
      <Swatches value={color} onChange={setColor} label="Colour of the next highlight" />
      <button
        type="button"
        className={SMALL}
        onClick={() => highlightView()}
        disabled={viewCount === 0}
        title={viewCount === 0 ? 'No dataset panel on screen (an analysis panel is maximized)' : viewCount > 1
          ? `Highlight what the panels show: ${viewCount} loci, one highlight each${anySelected ? ' (the selected panels)' : ''}`
          : `Highlight what the ${anySelected ? 'selected panel shows' : 'view shows'}`}
        data-testid="highlight-view-button"
      >
        View
      </button>
      <button
        type="button"
        className={SMALL}
        onClick={() => highlightSelectedPeaks()}
        disabled={selectedPeaks === 0}
        title={selectedPeaks === 0 ? 'Select peaks first' : `Highlight the ${selectedPeaks} selected peak${selectedPeaks === 1 ? '' : 's'}`}
        data-testid="highlight-peaks-button"
      >
        Peaks
      </button>
      <div ref={listRef} className="relative">
        <button
          type="button"
          className={`${SMALL} ${listOpen ? 'bg-gray-900/[0.06] dark:bg-white/10' : ''}`}
          onClick={() => setListOpen(v => !v)}
          aria-expanded={listOpen}
          aria-haspopup="dialog"
          title="Rename, recolour or remove highlights"
          data-testid="highlight-list-button"
        >
          List ({count})
        </button>
        {listOpen && <HighlightList onClose={() => setListOpen(false)} />}
      </div>
      {/* Clear all, on the group itself like Peaks' and Filter's Clear (owner, 1 Oct: it was only in the List). One undo step. */}
      <AnalysisButton
        data-testid="highlight-clear-button"
        onClick={clearHighlights}
        disabled={count === 0}
        variant="neutral"
        size="sm"
        title={count === 0 ? 'No highlights to clear' : count === 1 ? 'Clear the highlight (Undo brings it back)' : `Clear all ${count} highlights (Undo brings them back)`}
      >
        Clear
      </AnalysisButton>
    </ToolbarGroup>
  );
}
