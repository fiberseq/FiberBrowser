import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { setDatasetChemistry } from '../../../api/datasets';
import { useBrowserStore } from '../../../stores/browserStore';
import type { Dataset } from '../../../types';
import { consensusChemistry } from '../../../utils/datasetChemistry';
import { AnalysisButton, AnalysisStatus } from '../shared';

type Chemistry = NonNullable<Dataset['consensus_chemistry']>;

const CHOICES: Array<{ value: Chemistry; label: string; detail: string }> = [
  { value: 'ddda', label: 'DAF-seq · DddA', detail: 'Strand-resolved C→T / G→A deamination' },
  { value: 'dddb', label: 'DAF-seq · DddB', detail: 'Strand-resolved DddB deamination' },
  { value: 'hia5-pacbio', label: 'Fiber-seq · PacBio', detail: 'Hia5 m6A; alignment directions are pooled' },
  { value: 'hia5-nanopore', label: 'Fiber-seq · ONT', detail: 'Hia5 m6A on ONT; current family caller pools directions' },
];

export function DatasetSetupTab({ datasetIds }: { datasetIds: string[] }) {
  const { datasets, setDatasets } = useBrowserStore(useShallow(state => ({
    datasets: state.datasets,
    setDatasets: state.setDatasets,
  })));
  const selected = useMemo(() => {
    const ids = new Set(datasetIds);
    return datasets.filter(dataset => ids.has(dataset.id));
  }, [datasets, datasetIds]);
  const [drafts, setDrafts] = useState<Record<string, Chemistry | ''>>({});
  const [platforms, setPlatforms] = useState<Record<string, 'pacbio' | 'nanopore' | 'illumina' | ''>>({});
  const [persist, setPersist] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const save = async (dataset: Dataset) => {
    const chemistry = drafts[dataset.id] || consensusChemistry(dataset);
    if (!chemistry) {
      setMessage(`Choose the assay type for ${dataset.label || dataset.id}.`);
      return;
    }
    setBusy(dataset.id);
    setMessage(null);
    try {
      const response = await setDatasetChemistry(dataset.id, chemistry, !!persist[dataset.id], platforms[dataset.id] || undefined);
      if (!response.success || !response.dataset) {
        throw new Error(response.error || 'The Browser did not save the dataset metadata.');
      }
      setDatasets(useBrowserStore.getState().datasets.map(current => (
        current.id === response.dataset!.id ? response.dataset! : current
      )));
      setMessage(`${response.dataset.label || response.dataset.id}: ${CHOICES.find(choice => choice.value === chemistry)?.label} saved${persist[dataset.id] ? " in the BAM file" : ""}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return <div data-testid="footprint-dataset-setup" className="space-y-3">
    <div>
      <h3 className="font-semibold text-emerald-800 dark:text-emerald-200">Which assay made this data?</h3>
      <p className="text-xs text-gray-500">Footprint classes are found differently for DAF-seq (DddA/DddB) and Fiber-seq (Hia5). Your choice is saved with the session.</p>
    </div>
    {selected.map(dataset => {
      const current = consensusChemistry(dataset) ?? '';
      const value = drafts[dataset.id] ?? current;
      const choice = CHOICES.find(row => row.value === value);
      const missing = !consensusChemistry(dataset);
      return <section key={dataset.id} className={`rounded border p-2 space-y-1.5 ${missing ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/20' : 'border-gray-200 dark:border-gray-700'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0"><div className="font-medium truncate" title={dataset.label}>{dataset.label || dataset.id}</div>
            <div className="text-[11px] text-gray-500">{missing ? 'Not recorded in the file.' : `From ${dataset.chemistry_metadata?.source || 'dataset metadata'}`}</div></div>
          <span className={`text-[11px] rounded px-1.5 py-0.5 ${missing ? 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100'}`}>{missing ? 'choose assay' : 'ready'}</span>
        </div>
        <label className="block text-xs">Assay
          <select aria-label={`Dataset assay ${dataset.label}`} className="mt-0.5 w-full border rounded px-2 py-1 bg-white dark:bg-gray-900 dark:border-gray-600" value={value}
            onChange={event => setDrafts(previous => ({ ...previous, [dataset.id]: event.target.value as Chemistry }))}>
            <option value="">Choose assay…</option>
            {CHOICES.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}
          </select>
        </label>
        {choice && <p className="text-[11px] text-gray-500">{choice.detail}</p>}
        {dataset.data_type === 'bam' && <details className="text-xs">
          <summary className="cursor-pointer text-gray-500">Advanced: save into the BAM file</summary>
          <label className="mt-1 flex items-start gap-2"><input type="checkbox" checked={!!persist[dataset.id]} onChange={event=>setPersist(previous=>({...previous,[dataset.id]:event.target.checked}))}/>
            Also record the assay in the BAM header (FIBERHMM-CHEMISTRY:v1) so it is detected next time. This rewrites the BAM and its index.
          </label>
          {persist[dataset.id] && (value === 'ddda' || value === 'dddb') && <label className="mt-1 block">Sequencing platform
            <select aria-label={`Sequencing platform ${dataset.label}`} value={platforms[dataset.id] || ''} onChange={event=>setPlatforms(previous=>({...previous,[dataset.id]:event.target.value as 'pacbio' | 'nanopore' | 'illumina'}))} className="ml-2 rounded border bg-white dark:bg-gray-900">
              <option value="">Use existing BAM metadata</option><option value="pacbio">PacBio</option><option value="nanopore">ONT</option><option value="illumina">Illumina</option>
            </select>
          </label>}
        </details>}
        <AnalysisButton onClick={() => void save(dataset)} disabled={!value || busy !== null} theme="emerald" variant="primary" size="sm">
          {busy === dataset.id ? 'Saving…' : missing ? 'Save' : 'Update'}
        </AnalysisButton>
      </section>;
    })}
    {selected.length === 0 && <AnalysisStatus kind="empty" compact>No datasets are selected for footprint analysis.</AnalysisStatus>}
    {message && <AnalysisStatus kind="info" compact>{message}</AnalysisStatus>}
  </div>;
}
