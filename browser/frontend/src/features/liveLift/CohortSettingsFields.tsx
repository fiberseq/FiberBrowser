import type { LiftSettings } from './api';

interface Props { settings: LiftSettings; onChange: (settings: LiftSettings) => void; paths: string[]; showHaplotypeMode?: boolean }
const input = 'w-full rounded border border-line px-2 py-1 dark:bg-white/5';

export function CohortSettingsFields({ settings: s, onChange, paths, showHaplotypeMode }: Props) {
  const change = (patch: Partial<LiftSettings>) => onChange({ ...s, ...patch });
  return <fieldset className="mt-3 space-y-2" data-testid="live-lift-cohort-settings">
    <legend className="font-semibold">Analysis cohort</legend>
    {showHaplotypeMode && <label className="block">Haplotype panels
      <select className={input} value={s.haplotype_mode ?? 'split'} onChange={e => change({ haplotype_mode: e.target.value as 'split' | 'pooled' })}>
        <option value="split">Split by haplotype</option><option value="pooled">Pooled</option>
      </select>
    </label>}
    <p>Display options and analysis options are independent. Counts include the selected records and placements.</p>
    <label className="block">Supplementary records in analyses
      <select className={input} value={s.cohort_supplementaries ?? 'all_records'} onChange={e => change({ cohort_supplementaries: e.target.value as LiftSettings['cohort_supplementaries'] })}>
        <option value="all_records">All records (including hidden supplementaries)</option>
        <option value="follow_display">Follow display</option><option value="primary_only">Primary records only</option>
      </select>
    </label>
    <label className="block">Alternative placements in analyses
      <select className={input} value={s.cohort_alternatives ?? 'exclude'} onChange={e => change({ cohort_alternatives: e.target.value as LiftSettings['cohort_alternatives'] })}>
        <option value="exclude">Exclude</option><option value="include">Include (even when hidden)</option>
      </select>
    </label>
    <label className="block"><input type="checkbox" checked={s.fold_orientation_rows ?? false} onChange={e => change({ fold_orientation_rows: e.target.checked })} /> Fold a record's orientation rows for analysis</label>
    <label className="block"><input type="checkbox" checked={s.fold_molecule ?? false} onChange={e => change({ fold_molecule: e.target.checked })} /> Fold a molecule's records for analysis</label>
    <p>Folding keeps one cohort row per placement. Display rows share its cluster colour.</p>
    <label className="block">Rejoin call parts across gaps (bp)
      <input className={input} type="number" min={0} max={50} value={s.rejoin_bp ?? 5} onChange={e => change({ rejoin_bp: Number(e.target.value) })} />
    </label>
    <label className="block"><input type="checkbox" checked={s.primary_lookup ?? true} onChange={e => change({ primary_lookup: e.target.checked })} /> Look up the primary record for molecule haplotype and strand</label>
    <label className="block">Pooled coverage
      <select className={input} value={s.pooled_depth ?? 'raw'} onChange={e => change({ pooled_depth: e.target.value as LiftSettings['pooled_depth'] })}>
        <option value="raw">Raw molecule depth</option><option value="correspondence_normalised">Normalise by haplotypes with correspondence</option>
      </select>
    </label>
    <MoleculeProvenanceFields paths={paths} groups={s.molecule_groups ?? []} policy={s.joint_dedup ?? 'off'}
      onChange={(molecule_groups, joint_dedup) => change({ molecule_groups, joint_dedup })} />
  </fieldset>;
}

export function MoleculeProvenanceFields({ paths, groups, policy, onChange }: {
  paths: string[]; groups: [string, string][]; policy: 'off' | 'by_molecule';
  onChange: (groups: [string, string][], policy: 'off' | 'by_molecule') => void;
}) {
  return <fieldset className="space-y-2"><legend className="font-semibold">Shared molecule provenance</legend>
    <p>Give BAMs containing the same molecules the same group. Blank keeps each library separate. Matching read names alone never imply sharing.</p>
    {paths.map((path, i) => <label key={path} className="block" title={path}>Library {i + 1} provenance group
      <input className={input} value={new Map(groups).get(path) ?? ''} onChange={e => onChange([
        ...groups.filter(([p]) => p !== path), ...e.target.value ? [[path, e.target.value] as [string, string]] : [],
      ], policy)} />
    </label>)}
    <label className="block"><input type="checkbox" checked={policy === 'by_molecule'} onChange={e => onChange(groups, e.target.checked ? 'by_molecule' : 'off')} /> Deduplicate shared molecules in joint clustering</label>
    <p>Both copies are kept by default and overlap is reported. Deduplication applies only when all datasets sharing a group enable it; native rows take priority.</p>
  </fieldset>;
}
