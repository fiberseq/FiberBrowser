import { useEffect, useState } from 'react';
import type { ColorRule } from '../../../types';
import { NUC_COARSE_CLASSES, NUC_NAMED_CLASSES, nucCoarseName, nucNamedName } from '../../../utils/nucLayers';
import { Trash } from '../../ui/Icons';

type NucRuleFields = Pick<ColorRule, 'nucCoarse' | 'nucNamed' | 'zMin' | 'zMax' | 'nucTf'>;

/** Clears every nucleosome condition of a rule. */
export const CLEARED_NUC_CONDITIONS: NucRuleFields = {
  nucCoarse: undefined,
  nucNamed: undefined,
  zMin: undefined,
  zMax: undefined,
  nucTf: undefined,
};

/** One-line reading of a rule's nucleosome conditions, e.g. "mono/long · z −2 to 2 · nucleosome calls". */
export function describeNucConditions(rule: NucRuleFields): string {
  const parts: string[] = [];
  if (rule.nucCoarse?.length) parts.push(rule.nucCoarse.map(nucCoarseName).join('/'));
  if (rule.nucNamed?.length) parts.push(rule.nucNamed.map(code => nucNamedName(code) ?? String(code)).join('/'));
  const zMin = rule.zMin != null && Number.isFinite(rule.zMin) ? rule.zMin : null;
  const zMax = rule.zMax != null && Number.isFinite(rule.zMax) ? rule.zMax : null;
  if (zMin !== null && zMax !== null) parts.push(`z ${zMin} to ${zMax}`);
  else if (zMin !== null) parts.push(`z ≥ ${zMin}`);
  else if (zMax !== null) parts.push(`z ≤ ${zMax}`);
  if (rule.nucTf === true) parts.push('TF calls');
  if (rule.nucTf === false) parts.push('nucleosome calls');
  return parts.join(' · ');
}

function toggleCode(codes: number[] | undefined, code: number): number[] | undefined {
  const current = codes ?? [];
  const next = current.includes(code) ? current.filter(c => c !== code) : [...current, code].sort((a, b) => a - b);
  return next.length ? next : undefined;
}

/** A z bound typed as text, so a leading minus or an empty box can be typed freely. */
function ZBoundInput({ value, onChange, label }: { value: number | null | undefined; onChange: (value: number | null) => void; label: string }) {
  const shown = value != null && Number.isFinite(value) ? String(value) : '';
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label={label}
      placeholder={label === 'z min' ? 'min' : 'max'}
      onChange={event => {
        const text = event.target.value;
        setDraft(text);
        if (text.trim() === '') onChange(null);
        else {
          const next = Number(text.replace('−', '-'));
          if (Number.isFinite(next)) onChange(next);
        }
      }}
      onBlur={() => setDraft(shown)}
      className="input-tool text-[11px] w-12 tabular-nums"
    />
  );
}

interface NucConditionEditorProps {
  rule: ColorRule;
  onUpdate: (updates: Partial<ColorRule>) => void;
  onRemove: () => void;
}

/**
 * Nucleosome conditions of a colour rule (nucleosome panel DESIGN §5.4): coarse size classes, the density-matched
 * z range, TF or nucleosome calls, and named classes. They read each nuc/tf call's size mark from a nucleosome
 * scan (the Size classes layer); calls without a mark never match.
 */
export function NucConditionEditor({ rule, onUpdate, onRemove }: NucConditionEditorProps) {
  const callsValue = rule.nucTf === true ? 'tf' : rule.nucTf === false ? 'nuc' : 'any';
  const callOptions: Array<{ value: 'any' | 'nuc' | 'tf'; label: string; nucTf: boolean | undefined }> = [
    { value: 'any', label: 'Either', nucTf: undefined },
    { value: 'nuc', label: 'Nucleosome only', nucTf: false },
    { value: 'tf', label: 'TF only', nucTf: true },
  ];
  return (
    <div
      className="space-y-1 rounded border border-green-200 bg-green-50/50 p-1.5 text-[11px] dark:border-green-900/60 dark:bg-green-950/20"
      data-testid="nuc-condition-editor"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-green-800 dark:text-green-300">Nucleosome class</span>
        <span className="text-gray-500">from a nucleosome scan's size marks</span>
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto rounded p-0.5 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300"
          title="Remove the nucleosome conditions"
          aria-label="Remove nucleosome conditions"
        >
          <Trash size={11} aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-12 shrink-0 text-gray-500">Size</span>
        {NUC_COARSE_CLASSES.map(cls => (
          <label key={cls.code} className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={rule.nucCoarse?.includes(cls.code) ?? false}
              onChange={() => onUpdate({ nucCoarse: toggleCode(rule.nucCoarse, cls.code) })}
              className="rounded border-gray-300 dark:border-white/20"
              data-testid={`nuc-coarse-${cls.code}`}
            />
            {cls.label}
          </label>
        ))}
        {!rule.nucCoarse?.length && <span className="text-gray-400">(none: any)</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-12 shrink-0 text-gray-500">z</span>
        <ZBoundInput label="z min" value={rule.zMin} onChange={zMin => onUpdate({ zMin })} />
        <span className="text-gray-400">to</span>
        <ZBoundInput label="z max" value={rule.zMax} onChange={zMax => onUpdate({ zMax })} />
        <span className="text-gray-400">density-matched size deviation; calls without a z never match</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-12 shrink-0 text-gray-500">Calls</span>
        <div className="inline-flex overflow-hidden rounded border border-gray-200 dark:border-white/10" role="group" aria-label="Calls">
          {callOptions.map((option, i) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onUpdate({ nucTf: option.nucTf })}
              aria-pressed={callsValue === option.value}
              data-testid={`nuc-calls-${option.value}`}
              className={`px-2 py-0.5 ${i > 0 ? 'border-l border-gray-200 dark:border-white/10' : ''} ${callsValue === option.value ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
              title={option.value === 'tf' ? 'TF calls and footprints overlapping one' : option.value === 'nuc' ? 'Nucleosome calls that overlap no TF call' : 'Any call with a size mark'}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-12 shrink-0 text-gray-500">Named</span>
        {NUC_NAMED_CLASSES.map(cls => (
          <label key={cls.code} className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={rule.nucNamed?.includes(cls.code) ?? false}
              onChange={() => onUpdate({ nucNamed: toggleCode(rule.nucNamed, cls.code) })}
              className="rounded border-gray-300 dark:border-white/20"
            />
            {cls.label}
          </label>
        ))}
        <span className="text-amber-700 dark:text-amber-300" data-testid="nuc-named-note">
          Needs an absolute calibration (a control): without one no call is named.
        </span>
      </div>
    </div>
  );
}
