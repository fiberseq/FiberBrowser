/**
 * The FiberHMM variant layers of the Variants panel's dataset: turn the SV events and allele marks on for its read
 * rows (off by default: nothing is read until then), the SV record filters, the split-read link, and an optional UCSC
 * chain to draw the layers on another assembly.
 */
import { useState } from 'react';
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { ALLELE_COLORS, datasetVariantLayers } from './model';
import { setLayerSettings, useLayerSettings } from './state';

const post = { method: 'POST', headers: { 'Content-Type': 'application/json' } } as const;

function Swatch({ color, outline, label }: { color: string; outline?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-2.5 w-2" style={outline ? { border: `1px solid ${color}` } : { background: color }} />
      {label}
    </span>
  );
}

export function FiberhmmLayerControls({ datasetId }: { datasetId: string }) {
  const dataset = useBrowserStore(s => s.datasets.find(d => d.id === datasetId));
  const layers = datasetVariantLayers(dataset);
  const s = useLayerSettings(datasetId);
  const [chain, setChain] = useState('');
  const [liftNote, setLiftNote] = useState<string | null>(null);
  if (!layers.var && !layers.sv) return null;
  const set = (patch: Parameters<typeof setLayerSettings>[1]) => setLayerSettings(datasetId, patch);
  const applyLift = async (path: string | null) => {
    try {
      const r = await fetchJson<{ lift: string | null }>('/api/fiberhmm_layers/lift', { ...post, body: JSON.stringify({ dataset_id: datasetId, chain: path }) });
      setLiftNote(r.lift ? `Variant layers drawn through ${r.lift.split('/').pop()}` : 'Variant layers drawn as stored');
      // (Part of the overlay request's identity: responses cached for the old coordinates are not reused.)
      setLayerSettings(datasetId, { lift: r.lift });
    } catch (err) {
      setLiftNote(String((err as Error)?.message ?? err).replace(/^API error \d+: /, ''));
    }
  };
  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded border border-slate-200 px-2 py-1 text-[11px] dark:border-slate-700"
      data-testid="fiberhmm-layer-controls">
      <span className="text-ink-muted" title="fiberhmm-extract's per-read variant-allele and structural-event bigBeds for this sample. Read only while shown.">
        FiberHMM layers:
      </span>
      {layers.sv && (
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={s.sv} onChange={e => set({ sv: e.target.checked })} data-testid="fiberhmm-layer-sv" />
          SV events on reads
        </label>
      )}
      {layers.var && (
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={s.var} onChange={e => set({ var: e.target.checked })} data-testid="fiberhmm-layer-var" />
          Allele marks on reads
        </label>
      )}
      {layers.sv && s.sv && (
        <>
          <label className="flex items-center gap-1" title="Leave out SV records below this mapping quality">
            MapQ ≥
            <input type="number" min={0} max={255} value={s.minMapq} data-testid="fiberhmm-layer-mapq"
              onChange={e => set({ minMapq: Math.max(0, Math.min(255, Math.round(Number(e.target.value) || 0))) })}
              className="w-12 rounded border border-slate-300 bg-white px-1 py-0.5 tabular-nums dark:border-slate-600 dark:bg-slate-900" />
          </label>
          <label className="flex cursor-pointer items-center gap-1" title="Supplementary alignments (split reads' other pieces) as their own rows, or not at all">
            <input type="checkbox" checked={s.hideSupplementary} onChange={e => set({ hideSupplementary: e.target.checked })} data-testid="fiberhmm-layer-hide-supp" />
            Hide supplementary
          </label>
          <label className="flex cursor-pointer items-center gap-1" title="Use the SA tag: a read's pieces are joined by a dashed line (pieces elsewhere: an arrow with where they go), and a clip with a matching piece supports a deletion">
            <input type="checkbox" checked={s.linkSplit} onChange={e => set({ linkSplit: e.target.checked })} data-testid="fiberhmm-layer-link" />
            Link split reads
          </label>
        </>
      )}
      {layers.var && s.var && (
        <span className="flex items-center gap-2 text-ink-muted" data-testid="fiberhmm-layer-legend">
          <Swatch color={ALLELE_COLORS.ref} label="REF" />
          <Swatch color={ALLELE_COLORS.alt} label="ALT" />
          <Swatch color={ALLELE_COLORS.other} label="other" />
          <Swatch color={ALLELE_COLORS.ambiguous} outline label="ambiguous (DAF)" />
        </span>
      )}
      <details className="w-full">
        <summary className="cursor-pointer text-ink-muted">Draw on another assembly (UCSC chain)</summary>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <input type="text" value={chain} onChange={e => setChain(e.target.value)} placeholder="/path/to/source-to-view.chain(.gz)"
            className="min-w-[16rem] flex-1 rounded border border-slate-300 bg-white px-1 py-0.5 dark:border-slate-600 dark:bg-slate-900"
            data-testid="fiberhmm-layer-chain" />
          <button type="button" className="rounded border border-slate-300 px-1.5 py-0.5 dark:border-slate-600" disabled={!chain.trim()}
            onClick={() => void applyLift(chain.trim())}>Lift</button>
          <button type="button" className="rounded border border-slate-300 px-1.5 py-0.5 dark:border-slate-600"
            onClick={() => void applyLift(null)}>As stored</button>
          {liftNote && <span className="text-ink-muted">{liftNote}</span>}
        </div>
      </details>
    </div>
  );
}
