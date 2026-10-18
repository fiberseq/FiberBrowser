/**
 * Live lift in the browser (DESIGN_LIVE_LIFT.md P2a): the header chip and "…" items of a lifted dataset's panels
 * (one panel per haplotype by default, pooled one click away; its settings), and the dialogs. Behind the server's
 * flag: with it off nothing here is offered (a session's lifted dataset is refused by the server with a notice).
 */
import './types';
import { registerPanelHeaderExtension, type PanelHeaderContext } from '../../components/tracks/panelHeaderExtensions';
import { MenuItem } from '../../components/tracks/PanelHeader';
import { useBrowserStore } from '../../stores/browserStore';
import { isLiveLift } from '../../utils/datasetKinds';
import { useLiftSettingsDialog } from './LiveLiftSettingsDialog';
import { useLiveLiftStore } from './store';
import { liftHapLabels } from './types';

export function liveLiftChipText(ctx: Pick<PanelHeaderContext, 'panel' | 'dataset'>): string | null {
  if (!isLiveLift(ctx.dataset)) return null;
  const labels = liftHapLabels(ctx.dataset?.live_lift);
  const which = ctx.panel.liftHap ?? labels.join('+');
  return `Live lift · ${which} → this genome`;
}

function useLiveLiftHeader(ctx: PanelHeaderContext) {
  const { panel, dataset } = ctx;
  const labels = liftHapLabels(dataset?.live_lift);
  if (!isLiveLift(dataset) || !panel.datasetId) return null;
  const text = liveLiftChipText(ctx)!;
  const split = Boolean(panel.liftHap);
  const title = `Live lift: ${dataset?.label} drawn on this genome through ${dataset?.live_lift?.map_label ?? 'its map'}`
    + ` (no realignment). ${split ? `This panel shows haplotype ${panel.liftHap}.` : 'Haplotypes pooled.'}`;
  const chips = (
    <span className="fb-header-pill flex-shrink-0 truncate" title={title} data-testid="live-lift-chip">{text}</span>
  );
  const menu = (
    <>
      {labels.length > 1 && (split ? (
        <MenuItem tour="panel-live-lift-pool" icon={<span>⇄</span>} title="One panel with every haplotype's rows"
          onSelect={() => useBrowserStore.getState().poolLiftHapPanels(panel.datasetId!)}>
          <span data-testid="live-lift-pool">Pool haplotypes</span>
        </MenuItem>
      ) : (
        <MenuItem tour="panel-live-lift-split" icon={<span>⇵</span>} title="One panel per haplotype (MAT, PAT)"
          onSelect={() => useBrowserStore.getState().splitPanelByLiftHap(panel.id, labels)}>
          <span data-testid="live-lift-split">Split by haplotype</span>
        </MenuItem>
      ))}
      <MenuItem tour="panel-live-lift-settings" icon={<span>⚙</span>} title="Gap split, window merge, alternatives, supplementaries, hatching"
        onSelect={() => useLiftSettingsDialog.getState().open(panel.datasetId)}>
        <span data-testid="live-lift-settings-item">Live-lift settings…</span>
      </MenuItem>
    </>
  );
  return { chipTexts: [text], chips, menu, wantsMenu: true, menuTitle: 'live lift' };
}

let done = false;

export function registerLiveLift(): void {
  if (done) return;
  done = true;
  registerPanelHeaderExtension(useLiveLiftHeader);
  void useLiveLiftStore.getState().check();
}
