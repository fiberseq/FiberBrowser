import { READ_DEPTH_NAMES, type ReadDepth } from '../../../utils/readDepth';

/** Read budgets shared by analysis panels; support comes from the installed engine schema. */
export function ReadDepthControls({ values, supported, onChange, prefix }: {
  values: ReadDepth; supported: boolean; onChange: (name: keyof ReadDepth, value: number) => void; prefix: string;
}) {
  return <div className="space-y-1 text-[11px]" data-testid={`${prefix}-read-depth`}>
    {supported ? <>
      {READ_DEPTH_NAMES.map((name, i) => <label key={name} className="grid grid-cols-[1fr_95px] items-center gap-2">
        <span>{['Read cap for finding classes', 'Read cap for scoring', 'Sample seed'][i]}</span>
        <input type="number" min={0} step={1} value={values[name] ?? (i === 2 ? 1 : 0)}
          data-testid={`${prefix}-${name.replace(/_/g, '-')}`}
          className="min-w-0 rounded border px-1.5 py-1 bg-white dark:bg-gray-900 dark:border-gray-600"
          onChange={e => { const v = Number(e.target.value); if (Number.isSafeInteger(v) && v >= 0) onChange(name, v); }} />
      </label>)}
      <p className="text-ink-muted">0 = all reads. 2000 is a good cap for deep data, thousands of reads per site. Caps apply per dataset and chemical channel in each analysis window. The seed makes sampling repeatable.</p>
    </> : <p className="text-ink-muted">Read caps unavailable. Update FiberHMM (Settings &gt; FiberHMM) to use these settings.</p>}
  </div>;
}
