import { AnalysisButton, CheckboxRow } from '../../components/controls/shared';
import { formatNumber, WindowBadge, type WindowIdentity } from './presentation';
import { selectionForMembers, type SelectableBlock } from './blockSelection';
import type { SyncResult } from './model';

/** One row per block, with the same member checkboxes as the map. */
export function BlockList({ result, blocks, selected, identities, onChange, onRefine }: {
  result: SyncResult; blocks: SelectableBlock[]; selected: string[]; identities: Record<string, WindowIdentity>;
  onChange: (keys: string[]) => void; onRefine: (block: SelectableBlock) => void;
}) {
  return <div data-testid="sync-blocks" className="max-h-80 space-y-1 overflow-y-auto" onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); onChange([]); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const inputs = [...e.currentTarget.querySelectorAll<HTMLInputElement>('input')];
    const index = inputs.indexOf(e.target as HTMLInputElement);
    if (index < 0) return;
    e.preventDefault(); inputs[(index + (e.key === 'ArrowDown' ? 1 : inputs.length - 1)) % inputs.length]?.focus();
  }}>
    {blocks.map((block, i) => {
      const keys = block.choices.map(c => c.key), checked = keys.filter(k => selected.includes(k));
      const error = checked.length >= 2 ? selectionForMembers(result, block, selected).error : block.inconsistent.length ? 'These matches place the same bases in different positions. Choose members to keep.' : null;
      return <div key={block.id} data-testid={`sync-block-row-${block.id}`} className="rounded-fb border border-line p-1 text-[11px]">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <CheckboxRow testId={`sync-block-${block.id}`} checked={checked.length === keys.length} indeterminate={checked.length > 0 && checked.length < keys.length}
            onChange={value => onChange(value ? [...new Set([...selected, ...keys])] : selected.filter(k => !keys.includes(k)))}
            label={`Block ${i + 1} · ${checked.length} of ${keys.length} members · ${block.coverage} of ${block.total} windows`} />
          <AnalysisButton data-testid={`sync-block-refine-${block.id}`} disabled={checked.length < 2 || !!error} onClick={() => onRefine(block)}>Refine</AnalysisButton>
        </div>
        <div className="flex flex-wrap gap-x-2">
          {block.choices.map(c => <CheckboxRow key={c.key} testId={`sync-member-${c.key}`} checked={selected.includes(c.key)}
            onChange={value => onChange(value ? [...selected, c.key] : selected.filter(k => k !== c.key))}
            label={<><WindowBadge identity={identities[c.panelId]} />{c.copy ?? ''} · {formatNumber(c.interval[0])}–{formatNumber(c.interval[1])}</>} />)}
        </div>
        {error && <p role="status" data-testid={`sync-block-note-${block.id}`} className="text-amber-700 dark:text-amber-300">{error}</p>}
      </div>;
    })}
  </div>;
}
