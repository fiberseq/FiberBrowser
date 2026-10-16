import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSubSection } from '../../SidebarSubSection';
import { SidebarSettingNote, SidebarSettingRow } from '../shared/SidebarSetting';
import { defineSettings, inSidebar } from '../../../../utils/settingsCatalog';

export const REPRODUCIBILITY_SETTINGS = defineSettings({
  analysisCap: {
    id: 'analysis.sample-cap',
    label: 'Analysis cap',
    keywords: ['downsample', 'subsample', 'read cap', 'sampling', 'reproducible'],
    location: inSidebar('analysis.reproducibility'),
  },
  seed: {
    id: 'analysis.seed',
    label: 'Seed',
    keywords: ['random seed', 'reproducibility', 'sampling seed'],
    location: inSidebar('analysis.reproducibility'),
  },
});

const DEFAULT_ANALYSIS_SAMPLE_SEED = 'fiberbrowser-analysis';
const ANALYSIS_SAMPLE_OPTIONS = [5000, 10000, 20000, 50000, 100000];

export function ReproducibilitySettings() {
  const {
    analysisSampleCount, setAnalysisSampleCount,
    analysisSampleSeed, setAnalysisSampleSeed,
  } = useBrowserStore(useShallow(s => ({
    analysisSampleCount: s.analysisSampleCount, setAnalysisSampleCount: s.setAnalysisSampleCount,
    analysisSampleSeed: s.analysisSampleSeed, setAnalysisSampleSeed: s.setAnalysisSampleSeed,
  })));

  return (
    <SidebarSubSection
      id="analysis.reproducibility"
      label="Reproducibility"
      helpText="Shared seed and optional analysis downsampling for high-coverage data"
      defaultOpen
      persist
    >
      <div className="space-y-1.5">
        <SidebarSettingNote tone="teal">
          Analysis cap is off by default. When enabled, clustering and footprint analytics use a stable read-ID sample after span/peak eligibility.
        </SidebarSettingNote>

        <SidebarSettingRow
          setting={REPRODUCIBILITY_SETTINGS.analysisCap}
          helpText="Optional reproducible read cap for clustering and footprint analytics. Off uses all eligible reads; sampling is stable by read ID and runs after peak/filter eligibility."
        >
          <select
            value={analysisSampleCount ?? ''}
            onChange={e => setAnalysisSampleCount(e.target.value ? parseInt(e.target.value) : null)}
            className="input-tool flex-1 text-xs"
          >
            <option value="">Off</option>
            {ANALYSIS_SAMPLE_OPTIONS.map(n => (
              <option key={n} value={n}>{n.toLocaleString()} reads</option>
            ))}
          </select>
        </SidebarSettingRow>

        <SidebarSettingRow
          setting={REPRODUCIBILITY_SETTINGS.seed}
          helpText="Seed used for reproducible sampling across display reads, linked reads, backend working-set caps, clustering, and footprint analytics."
        >
          <input
            type="text"
            value={analysisSampleSeed}
            onChange={e => setAnalysisSampleSeed(e.target.value)}
            placeholder={DEFAULT_ANALYSIS_SAMPLE_SEED}
            className="input-tool flex-1 text-xs font-mono"
          />
          <button
            onClick={() => setAnalysisSampleSeed(DEFAULT_ANALYSIS_SAMPLE_SEED)}
            disabled={analysisSampleSeed === DEFAULT_ANALYSIS_SAMPLE_SEED}
            className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-[11px] text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Reset reproducibility seed"
          >
            Reset
          </button>
        </SidebarSettingRow>

        <SidebarSettingNote>
          Display cap controls drawn rows only. Analysis cap controls clustering and backend analytics. Peak locking and peak rules are below.
        </SidebarSettingNote>
      </div>
    </SidebarSubSection>
  );
}
