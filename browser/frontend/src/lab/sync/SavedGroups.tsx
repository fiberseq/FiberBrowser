import { openRegionPanels } from '../../utils/regionPanels';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { seedHistoryBaseline } from '../../stores/historySlice';
import { AnalysisButton } from '../../components/controls/shared';
import { matchedGroupLabel, removeMatchedGroups } from '../../utils/matchedGroupActions';
import type { ComparisonFrame } from './model';

/** Saved groups and peak rows share names, visibility and removal. */
export function SavedGroups({ showFrame }: { showFrame: (frame: ComparisonFrame) => void }) {
  const { rules, peaks, frames } = useBrowserStore(useShallow(s => ({ rules: s.peakRules, peaks: s.peaksByRule, frames: s.comparisonFrames })));
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const groups = rules.filter(r => r.source === 'matched');
  if (!groups.length) return null;
  return <div data-testid="sync-saved-groups" className="space-y-1 text-[11px] text-ink">
    <div className="text-ink-secondary">Matched regions</div>
    {groups.map(rule => {
      const regions = peaks[rule.id] ?? [];
      const references = [...new Set(regions.map(p => p.genome ?? 'Default reference'))];
      const label = matchedGroupLabel(rule, rules);
      const saveName = () => {
        if (name.trim() && name.trim() !== rule.name) {
          const s = useBrowserStore.getState();
          seedHistoryBaseline(s, 'Before renaming group', 'analysis');
          s.updatePeakRule(rule.id, { name: name.trim() });
          s.pushSnapshot('Rename group', { kind: 'analysis', explicit: true });
        }
        setEditing(null);
      };
      return <div key={rule.id} data-testid={`sync-group-${rule.id}`} className="rounded-fb border border-line p-2 space-y-1">
        {editing === rule.id ? <form className="flex gap-1" onSubmit={e => { e.preventDefault(); saveName(); }}>
          <input autoFocus aria-label="Group name" data-testid="sync-group-name" className="min-w-0 flex-1 rounded-fb border border-line bg-transparent px-1"
            value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditing(null); }} />
          <AnalysisButton data-testid="sync-group-save-name" onClick={saveName}>Save</AnalysisButton>
          <AnalysisButton data-testid="sync-group-cancel-name" onClick={() => setEditing(null)}>Cancel</AnalysisButton>
        </form> : <div className="truncate" title={label}>{label}</div>}
        <div className="break-words text-ink-muted">{regions.length} regions · {references.length} references · {references.join(', ')}</div>
        <div className="break-words text-ink-muted">{regions.map(p => `${p.match?.label} · ${p.chrom}:${p.start}–${p.end}`).join('; ')}</div>
        <div className="flex flex-wrap gap-1">
          <AnalysisButton data-testid={`sync-group-show-${rule.id}`} onClick={() => {
            const s = useBrowserStore.getState();
            s.updatePeakRule(rule.id, { enabled: true });
            if (!regions.every(p => s.selectedPeaks.has(p.index))) s.selectMatchedGroup(rule.id);
            const frame = frames.find(f => f.id === rule.matchGroup?.frameId);
            if (frame) { s.activateComparisonFrame(frame.id); showFrame(frame); }
          }}>Show</AnalysisButton>
          <AnalysisButton data-testid={`sync-group-open-panels-${rule.id}`} onClick={() => openRegionPanels(rule.id)}>Open as panels</AnalysisButton>
          <AnalysisButton data-testid={`sync-group-rename-${rule.id}`} onClick={() => { setName(rule.name); setEditing(rule.id); }}>Rename</AnalysisButton>
          <AnalysisButton data-testid={`sync-group-remove-${rule.id}`} onClick={() => {
            const s = useBrowserStore.getState();
            if (rule.matchGroup?.frameId) s.removeComparisonFrame(rule.matchGroup.frameId);
            else removeMatchedGroups(rule.id);
          }}>Remove</AnalysisButton>
        </div>
      </div>;
    })}
  </div>;
}
