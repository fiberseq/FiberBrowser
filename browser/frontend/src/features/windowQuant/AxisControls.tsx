/**
 * The metaprofiles' axis frame in the UI: the anchor resolved for a view (useAxisAnchor), the Genome / Relative toggle
 * with the anchor choice and "Flip to gene direction" (AxisFrameControl), the tick strip under a plot (AxisStrip), and
 * the "Select window" button with its first-use hint.
 */
import { useEffect, useMemo, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useMetaLocusStore } from '../metaLocus/metaLocusStore';
import { anchorWord, isMetaChrom } from '../metaLocus/metaChrom';
import { axisTicks, DEFAULT_AXIS_FRAME, geneAnchorPos, genesInView, isResolved, resolveAnchor, type AxisFrame, type ResolvedAnchor } from './axisFrame';

export function useAxisAnchor(view: { chrom: string; start: number; end: number } | null): { frame: AxisFrame; anchor: ResolvedAnchor | null; reason: string | null } {
  const frame = useBrowserStore(s => s.windowQuant?.axis ?? DEFAULT_AXIS_FRAME);
  const genes = useBrowserStore(s => s.genes);
  const status = useMetaLocusStore(s => s.status);
  return useMemo(() => {
    if (!view) return { frame, anchor: null, reason: 'No view.' };
    const flank = Number(status?.flank_bp ?? status?.spec?.flank_bp ?? 0);
    const meta = isMetaChrom(view.chrom) && flank > 0 ? { site: flank, word: anchorWord(status?.spec?.anchor) } : null;
    const r = resolveAnchor(frame, { chrom: view.chrom, start: view.start, end: view.end, genes, meta });
    return isResolved(r) ? { frame, anchor: r, reason: null } : { frame, anchor: null, reason: r.reason };
  }, [frame, genes, status, view?.chrom, view?.start, view?.end]);   // eslint-disable-line react-hooks/exhaustive-deps
}

const sel = 'input-tool min-h-0 py-0.5 text-[11px]';

export function AxisFrameControl({ view, testId = 'quant-axis-frame' }: { view: { chrom: string; start: number; end: number }; testId?: string }) {
  const { frame, anchor, reason } = useAxisAnchor(view);
  const setAxis = useBrowserStore(s => s.setQuantAxis);
  const genes = useBrowserStore(s => s.genes);
  const isReversed = useBrowserStore(s => s.isReversed);
  const toggleReversed = useBrowserStore(s => s.toggleReversed);
  const inView = useMemo(() => genesInView({ ...view, genes }), [view, genes]);
  const meta = isMetaChrom(view.chrom);
  const [pos, setPos] = useState('');
  const seg = (on: boolean) => `rounded border px-1.5 py-0.5 text-[11px] ${on ? 'border-cyan-500 bg-cyan-50 text-cyan-900 dark:bg-cyan-950/50 dark:text-cyan-100' : 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200'}`;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]" data-testid={testId} data-mode={frame.mode} data-anchor={anchor ? `${anchor.pos}${anchor.strand}` : ''}>
      <span className="font-medium">x-axis</span>
      <button type="button" className={seg(frame.mode === 'genome')} data-testid={`${testId}-genome`} onClick={() => setAxis({ mode: 'genome' })}>Genome</button>
      <button type="button" className={seg(frame.mode === 'relative')} data-testid={`${testId}-relative`} onClick={() => setAxis({ mode: 'relative', ...(meta ? { anchor: 'site' as const } : {}) })}
        title="Distance from an anchor (signed by its direction: upstream negative)">Relative</button>
      {frame.mode === 'relative' && (<>
        {meta ? <span className="text-ink-muted" data-testid={`${testId}-site`}>to the {anchor?.name ?? 'site'} (as the meta-locus pool is anchored)</span> : (<>
          <select className={sel} aria-label="Anchor" data-testid={`${testId}-anchor`} value={frame.anchor} onChange={e => setAxis({ anchor: e.target.value as AxisFrame['anchor'] })}>
            <option value="tss">gene start (TSS)</option><option value="gene-end">gene end</option><option value="centre">view centre</option><option value="position">a position</option>
          </select>
          {(frame.anchor === 'tss' || frame.anchor === 'gene-end') && (inView.length ? (
            <select className={sel} aria-label="Gene" data-testid={`${testId}-gene`} value={frame.gene ?? ''} onChange={e => setAxis({ gene: e.target.value || null })}
              title="The genes in view, nearest the view centre first">
              <option value="">nearest gene: {inView[0].name || inView[0].id}</option>
              {inView.map(g => <option key={g.id} value={g.id}>{g.name || g.id} ({g.strand === '-' ? '−' : '+'}) · {frame.anchor === 'tss' ? 'TSS' : 'end'} {geneAnchorPos(g, frame.anchor === 'tss' ? 'tss' : 'gene-end').toLocaleString('en-US')}</option>)}
            </select>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1" data-testid={`${testId}-no-genes`}>
              <span className="text-amber-800 dark:text-amber-200">No gene in view (no gene annotation loaded here).</span>
              <button type="button" className={seg(false)} data-testid={`${testId}-use-centre`} onClick={() => setAxis({ anchor: 'centre' })}>Use the view centre</button>
              <button type="button" className={seg(false)} data-testid={`${testId}-use-position`} onClick={() => setAxis({ anchor: 'position', position: Math.round((view.start + view.end) / 2) })}>Type a position</button>
            </span>
          ))}
          {frame.anchor === 'position' && (
            <input className={`${sel} w-28`} aria-label="Anchor position" data-testid={`${testId}-position`} placeholder={frame.position?.toLocaleString('en-US') ?? 'position'}
              value={pos} onChange={e => setPos(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { const v = Number(pos.replace(/,/g, '')); if (Number.isFinite(v)) setAxis({ position: v }); setPos(''); } }} />
          )}
        </>)}
        {anchor ? <span className="text-ink-muted" data-testid={`${testId}-label`}>{anchor.axisLabel}</span>
          : !(frame.anchor === 'tss' || frame.anchor === 'gene-end') || inView.length ? <span className="text-amber-800 dark:text-amber-200" role="status">{reason}</span> : null}
        {anchor?.strand === '-' && !isReversed && (
          <button type="button" className="rounded border border-amber-400 px-1.5 py-0.5 text-[11px] text-amber-900 hover:bg-amber-50 dark:text-amber-100" data-testid={`${testId}-flip`}
            title="Turn on Reverse view: the reads and the plots flip together, so downstream reads left to right" onClick={toggleReversed}>Flip to gene direction</button>
        )}
      </>)}
    </div>
  );
}

/** Ticks under a plot spanning the view (screen order follows the reads: Reverse view), relative to the anchor or genome. */
export function AxisStrip({ left, width, view, reversed, anchor, testId = 'quant-axis-strip', compact = false }: {
  left: number; width: number; view: { start: number; end: number }; reversed: boolean; anchor: ResolvedAnchor | null; testId?: string;
  /** On a short track: tick marks and labels only (the anchor is named by the x-axis chip). */
  compact?: boolean;
}) {
  const ticks = axisTicks(view, reversed, anchor, width);
  return (
    <div className={`relative ${compact ? 'h-4' : anchor ? 'h-8' : 'h-5'} select-none text-[9px] text-ink-muted`} data-testid={testId} data-ticks={JSON.stringify(ticks.map(t => [+t.t.toFixed(4), t.label]))}>
      {ticks.map(t => (
        <span key={`${t.t}-${t.label}`} className="absolute top-0" style={{ left: left + t.t * width }}>
          <span className={`absolute left-0 top-0 h-1.5 border-l ${t.value === 0 && anchor ? 'border-gray-700 dark:border-gray-200' : 'border-gray-400'}`} />
          <span className={`absolute top-1.5 -translate-x-1/2 whitespace-nowrap leading-3 ${t.value === 0 && anchor ? 'font-semibold' : ''}`}>{t.label}</span>
        </span>
      ))}
      {anchor && !compact && <span className="absolute bottom-0 whitespace-nowrap" style={{ left }}>{anchor.axisLabel}</span>}
    </div>
  );
}

/** The axis strip's height in an export. */
export const AXIS_STRIP_EXPORT_H = 24;

/** AxisStrip drawn on a canvas (exports): the same ticks and anchor label, `top` px down, under the plot area. */
export function drawAxisStrip(ctx: CanvasRenderingContext2D, geom: { left: number; width: number }, top: number,
  view: { start: number; end: number }, reversed: boolean, anchor: ResolvedAnchor | null): void {
  ctx.save();
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.strokeStyle = '#9ca3af';
  ctx.fillStyle = '#6b7280';
  ctx.lineWidth = 1;
  for (const t of axisTicks(view, reversed, anchor, geom.width)) {
    const x = Math.round(geom.left + t.t * geom.width) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + 10); ctx.stroke();
    ctx.fillText(t.label, x + 2, top);
  }
  if (anchor) { ctx.textBaseline = 'bottom'; ctx.fillText(anchor.axisLabel, geom.left, top + AXIS_STRIP_EXPORT_H); }
  ctx.restore();
}

const HINT_KEY = 'fiberbrowser.windowQuant.hintSeen';

/** Esc leaves Select window mode (while it is on). */
export function useEscapeLeavesSelecting(): void {
  const selecting = useBrowserStore(s => !!s.quantSelecting);
  const setSelecting = useBrowserStore(s => s.setQuantSelecting);
  useEffect(() => {
    if (!selecting || !setSelecting) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelecting(false); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [selecting, setSelecting]);
}

/** The words of the selecting hint, the same on every plot. */
export const SELECT_HINT = 'Drag across the profile to set a window · Esc to stop';

/** "Select window": a toggle. While on, a drag across a metaprofile sets the window (on the main metaprofile row it
 *  then never zooms or pans); Esc or the toggle leaves. A first-use tip says how. */
export function SelectWindowButton({ testId = 'quant-select-window', cluster = false, compact = false }: { testId?: string; cluster?: boolean; compact?: boolean }) {
  const selecting = useBrowserStore(s => !!s.quantSelecting);
  const setSelecting = useBrowserStore(s => s.setQuantSelecting);
  useEscapeLeavesSelecting();
  const [hint, setHint] = useState(() => { try { return window.localStorage.getItem(HINT_KEY) !== '1'; } catch { return true; } });
  const dismiss = () => { setHint(false); try { window.localStorage.setItem(HINT_KEY, '1'); } catch { /* storage off */ } };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button type="button" data-testid={testId} aria-pressed={selecting}
        className={`rounded border px-1.5 py-0.5 ${compact ? 'text-[10px]' : 'text-[11px]'} font-medium ${selecting ? 'border-amber-500 bg-amber-200 text-amber-950 ring-1 ring-amber-500' : 'border-amber-400 bg-white/90 text-amber-900 hover:bg-amber-50 dark:bg-gray-900/80 dark:text-amber-100'}`}
        title={selecting ? 'Stop selecting (Esc)' : `Select window: then drag across ${cluster ? 'a cluster profile' : 'the metaprofile'} to set the window (Shift + drag works any time)`}
        onClick={() => { setSelecting?.(!selecting); dismiss(); }}>{selecting ? '▭ Selecting… (Esc)' : '▭ Select window'}</button>
      {selecting && !compact && <span className="text-[10px] text-amber-900 dark:text-amber-100" data-testid={`${testId}-active-hint`}>{SELECT_HINT}</span>}
      {hint && !selecting && !compact && (
        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" data-testid={`${testId}-hint`}>
          Tip: press Select window, drag across a profile to set a window, then Quantify. <button type="button" className="underline" onClick={dismiss}>Got it</button>
        </span>
      )}
    </span>
  );
}
