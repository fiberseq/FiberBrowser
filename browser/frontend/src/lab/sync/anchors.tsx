import { create } from 'zustand';
import { registerTrackKind } from '../../components/tracks/trackRegistry';
import { registerTrackRenderer, type PluginTrackRenderArgs } from '../../components/tracks/trackRenderers';
import type { SyncWindow } from './model';
declare module '../../types' {
  interface PackSubTrackTypes {
    'sync-anchor': true;
  }
}
export const useAnchorPick = create<{
  panelId: string | null;
  epoch: number;
  anchors: Record<string, NonNullable<SyncWindow['anchor']>>;
}>(() => ({ panelId: null, epoch: 0, anchors: {} }));
/** Keep an explicit user anchor for this panel and leave pick mode. */
export function setAnchor(panelId: string, anchor: NonNullable<SyncWindow['anchor']>) {
  useAnchorPick.setState(s => ({ panelId: null, anchors: { ...s.anchors, [panelId]: anchor } }));
}
function AnchorRuler({ panel, view, width, sidebarWidth }: PluginTrackRenderArgs) {
  const anchor = useAnchorPick(s => s.anchors[panel.id]);
  const choose = (position: number) => setAnchor(panel.id, { position: Math.max(view.start, Math.min(view.end - 1, Math.round(position))), strand: '+', label: 'Picked in panel' });
  return <div
    data-testid={`sync-pick-ruler-${panel.id}`}
    style={{ paddingLeft: sidebarWidth }}
    className="text-[11px] text-teal-700 dark:text-teal-300">
    <label>
      Pick anchor · click or use arrow keys
      <input
        data-testid={`sync-pick-position-${panel.id}`}
        aria-label="Pick anchor position"
        type="range"
        min={view.start}
        max={view.end - 1}
        value={anchor?.position ?? Math.floor((view.start + view.end) / 2)}
        style={{ width: Math.max(0, width - sidebarWidth - 12) }}
        onChange={e => choose(Number(e.target.value))}
        onKeyDown={e => {
          if (e.key === 'Escape')
            useAnchorPick.setState({ panelId: null });
        }} />
    </label>
  </div>;
}
/** Add the temporary pick ruler through the lab track extension. */
export function registerAnchorPick() {
  registerTrackKind({
    type: 'sync-anchor', label: 'Comparison anchor', defaultHeight: 42, minHeight: 42, maxHeight: 42, builtin: true, shownWhen: 'Picking an anchor in Synchronise regions',
    defaultPlacement: { before: ['reads'], requires: 'reads' }
  });
  registerTrackRenderer({
    type: 'sync-anchor', useHeight: () => {
      const id = useAnchorPick(s => s.panelId);
      return ({ panel }) => panel.id === id ? 42 : null;
    }, render: args => <AnchorRuler {...args} />
  });
}
