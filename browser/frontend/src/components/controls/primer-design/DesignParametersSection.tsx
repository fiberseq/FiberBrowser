import type { Dispatch, SetStateAction } from 'react';
import type { PrimerDesignOptions } from '../../../api/primers';
import { AnalysisButton, AnalysisSettingsSection } from '../shared';

const TM_METHOD_OPTIONS: Array<{ value: NonNullable<PrimerDesignOptions['tm_method']>; label: string; title: string }> = [
  { value: 'primer3', label: 'Primer3 default NN', title: 'Primer3 default SantaLucia nearest-neighbor settings (default)' },
  { value: 'snapgene', label: 'SnapGene-like NN', title: 'Nearest-neighbor Tm using 50 mM Na+ and 0.25 uM primer concentration' },
  { value: 'owczarzy', label: 'SantaLucia/Owczarzy', title: 'SantaLucia nearest-neighbor Tm with Owczarzy salt correction' },
  { value: 'breslauer', label: 'Breslauer legacy NN', title: 'Legacy Breslauer nearest-neighbor parameters' },
  { value: 'wallace', label: 'Wallace 2/4 rule', title: 'Simple 2 x AT + 4 x GC estimate' },
];

export function DesignParametersSection({
  open,
  onOpenChange,
  params,
  updateParam,
  parameterSummary,
  excludeCartPrimers,
  setExcludeCartPrimers,
  excludePadBp,
  setExcludePadBp,
  excludedRegionCount,
  chrom,
  onResetDefaults,
}: {
  open: boolean;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
  params: PrimerDesignOptions;
  updateParam: <K extends keyof PrimerDesignOptions>(key: K, value: PrimerDesignOptions[K]) => void;
  parameterSummary: string;
  excludeCartPrimers: boolean;
  setExcludeCartPrimers: Dispatch<SetStateAction<boolean>>;
  excludePadBp: number;
  setExcludePadBp: Dispatch<SetStateAction<number>>;
  excludedRegionCount: number;
  chrom: string;
  onResetDefaults: () => void;
}) {
  return (
    <AnalysisSettingsSection
      open={open}
      onOpenChange={onOpenChange}
      theme="rose"
      title="Design parameters"
      summary={parameterSummary}
      contentClassName="space-y-2"
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-gray-500 mb-0.5">Optimize:</label>
          <select value={params.optimize_for} onChange={e => updateParam('optimize_for', e.target.value as 'closest' | 'balanced')} className="input-tool w-full text-xs">
            <option value="closest">Closest to target</option>
            <option value="balanced">Balanced</option>
          </select>
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5">Tm method:</label>
          <select
            value={params.tm_method ?? 'primer3'}
            onChange={e => updateParam('tm_method', e.target.value as PrimerDesignOptions['tm_method'])}
            className="input-tool w-full text-xs"
            title="Melting temperature calculation method used for candidate filtering and reported Tm"
          >
            {TM_METHOD_OPTIONS.map(option => (
              <option key={option.value} value={option.value} title={option.title}>{option.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5">Max G's/primer:</label>
          <input type="number" value={params.max_g_count} onChange={e => updateParam('max_g_count', Number(e.target.value))} className="input-tool w-full text-xs" min={0} max={10} />
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5">Tm range (C):</label>
          <div className="flex gap-1">
            <input type="number" value={params.min_tm} onChange={e => updateParam('min_tm', Number(e.target.value))} className="input-tool w-1/2 text-xs" />
            <input type="number" value={params.max_tm} onChange={e => updateParam('max_tm', Number(e.target.value))} className="input-tool w-1/2 text-xs" />
          </div>
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5">Max delta-Tm (C):</label>
          <input type="number" value={params.max_tm_diff} onChange={e => updateParam('max_tm_diff', Number(e.target.value))} className="input-tool w-full text-xs" step={0.5} />
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5">Primer length:</label>
          <div className="flex gap-1">
            <input type="number" value={params.min_len} onChange={e => updateParam('min_len', Number(e.target.value))} className="input-tool w-1/2 text-xs" />
            <input type="number" value={params.max_len} onChange={e => updateParam('max_len', Number(e.target.value))} className="input-tool w-1/2 text-xs" />
          </div>
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5">Product size:</label>
          <div className="flex gap-1">
            <input type="number" value={params.min_product} onChange={e => updateParam('min_product', Number(e.target.value))} className="input-tool w-1/2 text-xs" step={500} />
            <input type="number" value={params.max_product} onChange={e => updateParam('max_product', Number(e.target.value))} className="input-tool w-1/2 text-xs" step={500} />
          </div>
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5" title="Reject primers containing any run of identical bases at or above this length. DAF primers skew C-rich so long C/A/T runs are the usual concern. Set to >max primer length to disable.">
            Max homopolymer run:
          </label>
          <input type="number" value={params.max_run_length} onChange={e => updateParam('max_run_length', Number(e.target.value))} className="input-tool w-full text-xs" min={2} max={20} />
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5" title="Reject primers whose GC% exceeds this value. With Gs capped by 'Max Gs/primer', this effectively caps C content. Set to 100 to disable.">
            Max GC %:
          </label>
          <input type="number" value={params.max_gc_pct} onChange={e => updateParam('max_gc_pct', Number(e.target.value))} className="input-tool w-full text-xs" min={0} max={100} step={5} />
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5" title="Number of primer pairs to return. Only pairs satisfying all filters (Tm, length, GC, BLAST specificity) are returned, ranked by distance-to-target (or balanced score).">
            Max results:
          </label>
          <input type="number" value={params.max_results} onChange={e => updateParam('max_results', Number(e.target.value))} className="input-tool w-full text-xs" min={1} max={100} />
        </div>
        <div>
          <label className="block text-gray-500 mb-0.5" title="Minimum bp between two accepted pairs. Diversity filter: if a candidate's fwd AND rev primer are both within this distance of an already-accepted pair, the candidate is dropped. Set to 0 to disable (any distinct pair counts).">
            Min spacing (bp):
          </label>
          <input type="number" value={params.min_spacing} onChange={e => updateParam('min_spacing', Number(e.target.value))} className="input-tool w-full text-xs" min={0} step={10} />
        </div>
        <div className="col-span-2">
          <label className="flex items-center gap-1.5 cursor-pointer" title="Reject short-period tandem repeats such as ACACACACACAC that are not strict homopolymers.">
            <input
              type="checkbox"
              checked={params.check_tandem_repeats ?? true}
              onChange={e => updateParam('check_tandem_repeats', e.target.checked)}
            />
            <span>Reject tandem repeats</span>
          </label>
        </div>
        <div className="col-span-2">
          <label className="flex items-center gap-1.5 cursor-pointer" title="Reject primers whose 3' end (last ~12bp) matches an off-target site in the genome with >=90% identity. This catches primers that would prime at unintended loci even when the rest of the primer mismatches. Uncheck to design primers at tough sites where the strict 3'-end check over-rejects.">
            <input
              type="checkbox"
              checked={params.check_three_prime_specificity ?? true}
              onChange={e => updateParam('check_three_prime_specificity', e.target.checked)}
            />
            <span>Strict 3'-end specificity check</span>
          </label>
        </div>
        <div className="col-span-2">
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            title="Before BLAST, drop any candidate primer whose genomic footprint (+/-pad bp) overlaps a cart primer on the same chromosome. Keeps redesign results from re-proposing primers you already have. Disable if you want to see the same primers recomputed, for example to re-check BLAST."
          >
            <input
              type="checkbox"
              checked={excludeCartPrimers}
              onChange={e => setExcludeCartPrimers(e.target.checked)}
            />
            <span>Exclude cart primer footprints</span>
          </label>
          {excludeCartPrimers && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500 pl-5">
              <span>Pad</span>
              <input
                type="number"
                value={excludePadBp}
                onChange={e => setExcludePadBp(Math.max(0, Number(e.target.value) || 0))}
                className="input-tool w-14 text-[11px]"
                min={0}
                max={100}
              />
              <span>bp · excluding {excludedRegionCount} region(s) on {chrom}</span>
            </div>
          )}
        </div>
      </div>
      <AnalysisButton onClick={onResetDefaults} theme="rose" variant="outline">
        Reset defaults
      </AnalysisButton>
    </AnalysisSettingsSection>
  );
}
