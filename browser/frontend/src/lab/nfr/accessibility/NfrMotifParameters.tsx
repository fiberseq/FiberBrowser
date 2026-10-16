/**
 * Accessibility (preview): the motif view's Parameters (collapsible; kept in the session and per viewer), each with a
 * one-line explanation, and the user's own motifs (pasted or loaded; scored like JASPAR matrices; pinnable).
 */
import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { parseMotifs } from '../api';
import { useBrowserStore } from '../../../stores/browserStore';
import { useAccessibilityStore } from '../accessibilityStore';
import { DEFAULT_NFR_MOTIF_SETTINGS, type NfrMotifSettings } from '../nfrMotifSettings';
import { DisclosureChevron } from '../../../components/ui/Disclosure';
import { MotifScoringControl } from '../../../components/controls/shared';

const inputCls = 'rounded border border-gray-200 bg-white px-1 py-px dark:border-gray-700 dark:bg-gray-900';

function Row({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-center gap-x-2 gap-y-0.5" title={help}>
      <span className="text-gray-600 dark:text-gray-300">{label}</span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}

function NumberField({ value, min, max, step = 1, onChange, label, testId }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; testId?: string;
}) {
  return <input type="number" value={value} min={min} max={max} step={step} aria-label={label} data-testid={testId}
    onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v))); }}
    className={`${inputCls} w-16 tabular-nums`} />;
}

/** Pin a motif name in the species' pinned list (the motif view's list; null: the species' defaults first). */
export function pinMotifName(name: string) {
  const sp = useAccessibilityStore.getState().motifSpecies ?? 'other';
  const { pinnedMotifs, setPinnedMotifs } = useBrowserStore.getState();
  const list = pinnedMotifs[sp] ?? useAccessibilityStore.getState().defaultPins ?? [];
  if (!list.some(x => x.toLowerCase() === name.toLowerCase())) setPinnedMotifs(sp, [...list, name]);
}

export function NfrMotifParameters() {
  const { settings, set, custom, setCustom } = useBrowserStore(useShallow(s => ({
    settings: s.nfrMotifSettings, set: s.setNfrMotifSettings, custom: s.customMotifs, setCustom: s.setCustomMotifs,
  })));
  const species = useAccessibilityStore(s => s.motifSpecies) ?? 'this species';
  const onPin = pinMotifName;
  const [open, setOpen] = useState(false);
  const patch = (p: Partial<NfrMotifSettings>) => set(p);
  return (
    <div className="rounded-md border border-gray-200 text-[11px] dark:border-gray-700" data-testid="nfr-motif-parameters">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} data-testid="nfr-motif-parameters-toggle"
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left font-medium text-gray-700 dark:text-gray-200">
        <DisclosureChevron open={open} /> Motif parameters
        <span className="font-normal text-ink-secondary" title="Scoring, background, families, site evidence and your own motifs">your motifs: {custom.length}</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-gray-100 px-2 py-1.5 dark:border-white/5">
          <Row label="Motif scoring" help="Shared with the Footprints panel.">
            <MotifScoringControl compact testIdPrefix="nfr-motif-scoring" />
          </Row>
          <Row label="Background" help="Base composition for the log-odds and the p-values: around the NFR (±5 kb), the genome FASTA (sampled), or 25% each.">
            <select value={settings.background} onChange={e => patch({ background: e.target.value as NfrMotifSettings['background'] })}
              className={inputCls} data-testid="nfr-motif-background" aria-label="Background">
              <option value="local">local</option><option value="genome">genome</option><option value="uniform">uniform</option>
            </select>
          </Row>
          <Row label="Strand" help="Keep motif sites on both strands, or one (reference orientation).">
            <select value={settings.strand} onChange={e => patch({ strand: e.target.value as NfrMotifSettings['strand'] })} className={inputCls} aria-label="Strand">
              <option value="both">both</option><option value="+">+ only</option><option value="-">− only</option>
            </select>
          </Row>
          <Row label="Family merge" help="Matrices at least this similar (that also hit the same bases here) collapse into one row.">
            <NumberField value={settings.familySimilarity} min={0.5} max={1} step={0.05} onChange={v => patch({ familySimilarity: v })} label="Family similarity" />
          </Row>
          <Row label="Flank (bp)" help="Window scanned and mapped around the NFR's variants.">
            <NumberField value={settings.flank} min={0} max={5000} step={50} onChange={v => patch({ flank: v })} label="Flank" />
          </Row>
          <Row label="Site core (bp)" help="A footprint class must cover at least half of this window around the motif centre.">
            <NumberField value={settings.coreBp} min={1} max={60} onChange={v => patch({ coreBp: v })} label="Site core" testId="nfr-motif-core" />
          </Row>
          <Row label="Min reads" help="A variant enters the coverage test of a site with at least this many reads.">
            <NumberField value={settings.minReads} min={1} max={1000} onChange={v => patch({ minReads: v })} label="Minimum reads" />
          </Row>
          <CustomMotifs custom={custom} setCustom={setCustom} onPin={onPin} species={species} />
          <div className="flex justify-end">
            <button type="button" className="text-[10px] text-fuchsia-700 hover:underline dark:text-fuchsia-300" data-testid="nfr-motif-parameters-reset"
              onClick={() => set(null)} disabled={JSON.stringify(settings) === JSON.stringify(DEFAULT_NFR_MOTIF_SETTINGS)}>Reset to defaults</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomMotifs({ custom, setCustom, onPin, species }: {
  custom: { name: string; counts: Record<'A' | 'C' | 'G' | 'T', number[]> }[];
  setCustom: (m: typeof custom) => void; onPin: (name: string) => void; species: string;
}) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const add = async (t: string) => {
    setError('');
    try {
      const { motifs } = await parseMotifs(t, name.trim() || undefined);
      const merged = [...custom.filter(c => !motifs.some(m => m.name.toLowerCase() === c.name.toLowerCase())), ...motifs];
      setCustom(merged);
      setText(''); setName('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  return (
    <div className="space-y-1 rounded border border-dashed border-gray-200 p-1.5 dark:border-gray-700" data-testid="nfr-custom-motifs">
      <div className="text-gray-600 dark:text-gray-300">Your motifs <span className="text-[10px] text-ink-secondary">scored like JASPAR matrices; shared with the Footprints panel and saved with the session. Pin one to always show it ({species}).</span></div>
      {custom.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {custom.map(c => (
            <li key={c.name} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-px dark:bg-white/10" data-testid="nfr-custom-motif">
              {c.name} <span className="text-[10px] text-ink-secondary">{c.counts.A.length} bp</span>
              <button type="button" onClick={() => onPin(c.name)} className="text-[10px] text-fuchsia-700 dark:text-fuchsia-300" aria-label={`Pin ${c.name}`}>pin</button>
              <button type="button" onClick={() => setCustom(custom.filter(x => x !== c))} className="text-[10px] opacity-60 hover:opacity-100" aria-label={`Remove ${c.name}`}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-start gap-1">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="IUPAC (e.g. CAGGTAR), a PFM (4 rows A C G T or 4 columns), or JASPAR / MEME / HOMER text"
          aria-label="Motif text" data-testid="nfr-custom-motif-text" className={`${inputCls} min-w-[14rem] flex-1 font-mono text-[10px]`} />
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="name" aria-label="Motif name" className={`${inputCls} w-20`} />
        <button type="button" disabled={!text.trim()} onClick={() => add(text)} data-testid="nfr-custom-motif-add"
          className="rounded bg-fuchsia-50 px-1.5 py-px text-fuchsia-700 disabled:opacity-40 dark:bg-fuchsia-900/20 dark:text-fuchsia-300">Add</button>
        <button type="button" onClick={() => file.current?.click()} className="rounded px-1.5 py-px text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10">Load file…</button>
        <input ref={file} type="file" accept=".txt,.meme,.jaspar,.motif,.pfm,.transfac" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void f.text().then(add); e.target.value = ''; }} />
      </div>
      {error && <p className="text-[10px] text-red-600 dark:text-red-400" data-testid="nfr-custom-motif-error">{error}</p>}
    </div>
  );
}
