import { useBrowserStore } from '../../stores/browserStore';
import { READ_BADGE_MODES, readBadgeMode, setReadBadgeMode } from './displayOptions';

/** Toolbar Layers row control for insertion marks on lifted reads (Off by default; also in the
 *  Differences row's right-click menu and the Live-lift settings). Shown only with a lifted dataset open. */
export function InsertionMarksControl({ compact = true }: { compact?: boolean }) {
  const mode = useBrowserStore(s => readBadgeMode(s));
  const lifted = useBrowserStore(s => s.datasets.some(d => d.data_type === 'bam_livelift'));
  if (!lifted) return null;
  const title = 'Insertion marks on lifted reads: where a read has bases with no place on this genome. '
    + 'Off by default; the Differences row always shows insertions, and clicking an arrow there expands one.';
  return <label className={`flex items-center gap-1 ${compact ? 'text-[12px]' : 'text-[13px]'} whitespace-nowrap text-slate-700 dark:text-slate-200`}
    title={title} data-testid="insertion-marks-control">
    <span aria-hidden="true" className="inline-block h-2.5 w-0.5 flex-shrink-0 bg-violet-600 dark:bg-violet-400" />
    Insertions
    <select aria-label="Insertion marks on reads" data-testid="insertion-marks-select" value={mode}
      className="rounded border border-gray-300 bg-white px-0.5 py-0 text-[12px] text-slate-800 dark:border-white/20 dark:bg-dark-surface dark:text-slate-100"
      onChange={e => setReadBadgeMode(e.target.value as typeof mode)}>
      {READ_BADGE_MODES.map(m => <option key={m.mode} value={m.mode} title={m.title}>{m.label}</option>)}
    </select>
  </label>;
}
