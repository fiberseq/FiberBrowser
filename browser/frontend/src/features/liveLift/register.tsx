/**
 * Live lift in the browser (DESIGN_LIVE_LIFT.md P2a): the header chip and "…" items of a lifted dataset's panels
 * (one panel per haplotype by default, pooled one click away; its settings), and the dialogs. Behind the server's
 * flag: with it off nothing here is offered (a session's lifted dataset is refused by the server with a notice).
 */
import './types';
import './persistence';
import { registerPanelHeaderExtension, type PanelHeaderContext } from '../../components/tracks/panelHeaderExtensions';
import { MenuItem } from '../../components/tracks/PanelHeader';
import { useBrowserStore } from '../../stores/browserStore';
import { isLiveLift } from '../../utils/datasetKinds';
import { useLiftSettingsDialog } from './LiveLiftSettingsDialog';
import { useLiveLiftStore } from './store';
import { groupLiftPanel, followLiftGroupingRows } from './grouping';
import { liftHapLabels } from './types';
import { liveLiftHaplotypeColor, registerHaplotypeLabels } from './palette';
import { LiftedPanelLinkItems, registerLiftLinkingUi } from './linking/register';
import { liftedOpenView } from '../graphPanel/handoff';
import { notePendingGraphOpen } from '../graphPanel/openAsGraph';
import { offerGraphView } from '../graphPanel/graphOffer';

export function liveLiftChipText(ctx: Pick<PanelHeaderContext, 'panel' | 'dataset'>): string | null {
  if (!isLiveLift(ctx.dataset)) return null;
  const labels = liftHapLabels(ctx.dataset?.live_lift);
  const which = ctx.panel.liftHap ?? labels.join('+');
  return `Live lift · ${which} → this genome`;
}

export function useLiveLiftHeader(ctx: PanelHeaderContext) {
  const dark = useBrowserStore(s => s.darkMode);
  const { panel, dataset } = ctx;
  const labels = liftHapLabels(dataset?.live_lift);
  if (!isLiveLift(dataset) || !panel.datasetId) return null;
  const text = liveLiftChipText(ctx)!;
  const split = Boolean(panel.liftHap);
  const title = `Live lift: ${dataset?.label} drawn on this genome through ${dataset?.live_lift?.map_label ?? 'its map'}`
    + ` (no realignment). ${split ? `This panel shows haplotype ${panel.liftHap}.` : 'Haplotypes pooled.'}`;
  const chips = (
    <span className="fb-header-pill flex-shrink-0 truncate" style={{ color: liveLiftHaplotypeColor(panel.liftHap, dark) }}
      title={title} data-testid="live-lift-chip">{text}</span>
  );
  const menu = (
    <>
      {/* A graph host or member keeps its panels: pool/split would close or remake them (leave graph mode first). */}
      {labels.length > 1 && panel.viewMode !== 'graph' && panel.graphView?.role !== 'host' && !panel.graphMemberOf && (split ? (
        <MenuItem tour="panel-live-lift-pool" icon={<span>⇄</span>} title="One panel with every haplotype's rows"
          onSelect={() => useBrowserStore.getState().poolLiftHapPanels(panel.datasetId!, panel.id)}>
          <span data-testid="live-lift-pool">Pool haplotypes</span>
        </MenuItem>
      ) : (
        <MenuItem tour="panel-live-lift-split" icon={<span>⇵</span>} title="One panel per haplotype (MAT, PAT)"
          onSelect={() => useBrowserStore.getState().splitPanelByLiftHap(panel.id, labels)}>
          <span data-testid="live-lift-split">Split by haplotype</span>
        </MenuItem>
      ))}
      {!split && <MenuItem tour="panel-live-lift-group" icon={<span>≡</span>} title="Group loaded cohort rows by haplotype; follows newly loaded rows" onSelect={() => groupLiftPanel(panel.id)}>
        Group in this panel by haplotype
      </MenuItem>}
      <LiftedPanelLinkItems ctx={ctx} />
      <MenuItem tour="panel-live-lift-settings" icon={<span>⚙</span>} title="Gap split, window merge, alternatives, supplementaries, hatching; the Differences row (sources, size, insertions on reads)"
        onSelect={() => useLiftSettingsDialog.getState().open(panel.datasetId)}>
        <span data-testid="live-lift-settings-item">Live-lift settings…</span>
      </MenuItem>
    </>
  );
  return { chipTexts: [text], chips, menu, wantsMenu: true, menuTitle: 'live lift' };
}

/** A loaded native BAM's "…" menu: view it on another assembly through a lift map (behind the flag). */
export function useNativeBamLiftEntry(ctx: PanelHeaderContext) {
  const enabled = useLiveLiftStore(s => s.enabled);
  const { panel, dataset } = ctx;
  if (!enabled || !dataset || dataset.data_type !== 'bam' || panel.liftLink || !panel.datasetId) return null;
  const paths = dataset.paths?.length ? dataset.paths : [dataset.path];
  const menu = (
    <MenuItem tour="panel-live-lift-from-bam" icon={<span>⇄</span>}
      title="Draw this BAM on another genome through a graphlift map (no realignment); maps found next to the BAM or in the Library are offered"
      onSelect={() => useLiveLiftStore.getState().openFor(paths)}>
      <span data-testid="live-lift-from-bam">View on another assembly (live lift)…</span>
    </MenuItem>
  );
  return { menu, wantsMenu: true };
}

/**
 * A lifted dataset opens split into one panel per haplotype when its settings say so (the default), however it was
 * opened (the dialog, the API, a script). Once per dataset: a panel set the user pooled, or a session's panels (which
 * carry their haplotypes), are left as they are.
 */
export function autoSplitNewLiftedDatasets(seen: Set<string>): void {
  const state = useBrowserStore.getState();
  for (const dataset of state.datasets) {
    if (!isLiveLift(dataset) || seen.has(dataset.id)) continue;
    const mine = state.panels.filter(p => p.contentType === 'dataset' && p.datasetId === dataset.id);
    if (!mine.length) continue;   // its panel arrives in a later update
    seen.add(dataset.id);
    const labels = liftHapLabels(dataset.live_lift);
    // Only newly created panels carry an explicit split intent without a haplotype yet. A restored older panel
    // without that intent is already a view the user saved; its dataset's default must not rearrange it.
    if (mine.some(p => p.liftHap) || mine[0].liftHaplotypeMode !== 'split' || !labels.length) {
      // A saved split session: restored as saved, with a one-time "View as graph" offer (§5.4).
      if (mine.some(p => p.liftHap) && liftedOpenView(dataset.id) === 'graph') offerGraphView(dataset.id);
      continue;
    }
    // Graph primary (DESIGN_GRAPH_PRIMARY §5.2): "Open as" (else the browser default). Graph: split as today, then
    // the first haplotype panel becomes the host with its siblings folded in, once a package is known to bind it.
    const view = liftedOpenView(dataset.id);
    // One haplotype (a strain against its reference, G8): nothing to split; graph mode opens on its panel.
    if (labels.length < 2) {
      if (view === 'graph') notePendingGraphOpen(dataset.id);
      continue;
    }
    if (view === 'pooled') continue;
    state.splitPanelByLiftHap(mine[0].id, labels);
    if (view === 'graph') notePendingGraphOpen(dataset.id);
  }
}

let done = false;

export function registerLiveLift(): void {
  if (done) return;
  done = true;
  registerPanelHeaderExtension(useLiveLiftHeader);
  registerPanelHeaderExtension(useNativeBamLiftEntry);
  registerLiftLinkingUi();
  followLiftGroupingRows();
  void useLiveLiftStore.getState().check();
  const seen = new Set<string>();
  useBrowserStore.subscribe((s, previous) => {
    if (s.datasets === previous.datasets && s.panels === previous.panels) return;
    // Haplotypes other than MAT/PAT take their colours in each map's order (palette.ts).
    if (s.datasets !== previous.datasets) for (const d of s.datasets) if (isLiveLift(d)) registerHaplotypeLabels(liftHapLabels(d.live_lift));
    if (!s.datasets.some(d => isLiveLift(d) && !seen.has(d.id))) return;
    queueMicrotask(() => autoSplitNewLiftedDatasets(seen));
  });
}
