import { useState } from 'react';
import type { QualityGate } from '../../../types';
import { AnalysisButton } from '../shared';
import { Trash } from '../../ui/Icons';

const KNOWN_QUALITY_DIMENSIONS: Array<{ name: string; label: string; title: string; suggestedMin: number }> = [
  { name: 'aq', label: 'aq — Accessibility (FIRE) precision', title: 'Per-FIRE accessibility precision score. 230 ≈ 0.9 (published FIRE cutoff). Raise for higher specificity.', suggestedMin: 230 },
  { name: 'tq', label: 'tq — TF significance', title: 'Per-TF-footprint quality score. Higher = more significant HMM call.', suggestedMin: 200 },
  { name: 'nq', label: 'nq — Nucleosome call', title: 'Per-nucleosome quality score.', suggestedMin: 128 },
  { name: 'lq', label: 'lq — Nuc left edge confidence', title: 'How confident the LEFT boundary of this nucleosome is. Low on reads terminating mid-footprint. Also drives left-edge opacity ramp when rendered.', suggestedMin: 128 },
  { name: 'rq', label: 'rq — Nuc right edge confidence', title: 'How confident the RIGHT boundary of this nucleosome is. Low on reads terminating mid-footprint. Also drives right-edge opacity ramp when rendered.', suggestedMin: 128 },
  { name: 'el', label: 'el — TF left edge confidence', title: 'TF analog of lq — how confident the LEFT boundary of this TF footprint is. Drives left-edge opacity ramp when rendered.', suggestedMin: 128 },
  { name: 'er', label: 'er — TF right edge confidence', title: 'TF analog of rq — how confident the RIGHT boundary of this TF footprint is. Drives right-edge opacity ramp when rendered.', suggestedMin: 128 },
  { name: 'mq', label: 'mq — Modification probability', title: 'Per-base modification call probability.', suggestedMin: 180 },
];

interface QualityGateEditorProps {
  gate: QualityGate;
  onChange: (gate: QualityGate) => void;
  onRemove: () => void;
}

/** Dropdown + min/max inputs for a per-interval quality gate. */
export function QualityGateEditor({ gate, onChange, onRemove }: QualityGateEditorProps) {
  const knownEntry = KNOWN_QUALITY_DIMENSIONS.find(k => k.name === gate.qualityName);
  // Choosing custom… opens the name box even while the name is still a known one.
  const [customMode, setCustomMode] = useState(!knownEntry);
  const custom = customMode || !knownEntry;

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="text-gray-500">Quality:</span>
      <select
        value={custom ? '__custom__' : gate.qualityName}
        onChange={e => {
          const value = e.target.value;
          if (value === '__custom__') {
            setCustomMode(true);
          } else {
            const next = KNOWN_QUALITY_DIMENSIONS.find(entry => entry.name === value)!;
            setCustomMode(false);
            onChange({ ...gate, qualityName: next.name, minValue: next.suggestedMin });
          }
        }}
        className="input-tool text-[11px]"
        title={custom ? undefined : knownEntry?.title}
      >
        {KNOWN_QUALITY_DIMENSIONS.map(entry => (
          <option key={entry.name} value={entry.name} title={entry.title}>
            {entry.label}
          </option>
        ))}
        <option value="__custom__">custom...</option>
      </select>
      {custom && (
        <input
          type="text"
          value={gate.qualityName}
          onChange={e => onChange({ ...gate, qualityName: e.target.value })}
          className="input-tool text-[11px] w-16 font-mono"
          placeholder="name"
          title="Custom quality dimension name (must match a layer.quality_names entry)"
        />
      )}
      <span className="text-gray-400">≥</span>
      <input
        type="number"
        value={gate.minValue}
        onChange={e => {
          const next = parseInt(e.target.value);
          if (!isNaN(next)) onChange({ ...gate, minValue: Math.max(0, Math.min(255, next)) });
        }}
        className="input-tool text-[11px] w-14"
        min={0}
        max={255}
        title="Byte-scale (0-255). For aq, 230 ≈ 0.9 FIRE precision."
      />
      {gate.maxValue != null && (
        <>
          <span className="text-gray-400">&amp;&amp; ≤</span>
          <input
            type="number"
            value={gate.maxValue}
            onChange={e => {
              const next = parseInt(e.target.value);
              if (!isNaN(next)) onChange({ ...gate, maxValue: Math.max(0, Math.min(255, next)) });
            }}
            className="input-tool text-[11px] w-14"
            min={0}
            max={255}
          />
          <AnalysisButton
            onClick={() => onChange({ ...gate, maxValue: null })}
            variant="outline"
            className="px-1 py-0 text-[11px]"
            title="Remove upper cap"
          >
            (drop max)
          </AnalysisButton>
        </>
      )}
      {gate.maxValue == null && (
        <AnalysisButton
          onClick={() => onChange({ ...gate, maxValue: 255 })}
          theme="slate"
          variant="soft"
          className="px-1 py-0 text-[11px]"
          title="Add an upper bound (band-pass gate, e.g. only medium-confidence calls)"
        >
          + max
        </AnalysisButton>
      )}
      <button type="button" onClick={onRemove} className="ml-1 rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300" title="Remove gate" aria-label="Remove gate"><Trash size={12} aria-hidden="true" /></button>
    </div>
  );
}
