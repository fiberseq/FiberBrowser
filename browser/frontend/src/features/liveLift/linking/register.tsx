/**
 * Linked source views in the browser (DESIGN_LIVE_LIFT.md P3): the ribbon row of a linked source panel, its header
 * (chip, orientation, correspondence picker), the lifted panel's "Open source view", and the jump of the source panel
 * to an insertion clicked in the lifted panel.
 */
import { MenuItem } from '../../../components/tracks/PanelHeader';
import { registerPanelHeaderExtension, type PanelHeaderContext } from '../../../components/tracks/panelHeaderExtensions';
import { registerTrackKind } from '../../../components/tracks/trackRegistry';
import { registerTrackRenderer } from '../../../components/tracks/trackRenderers';
import { declareContribution } from '../../../plugins/packRegistry';
import { useBrowserStore } from '../../../stores/browserStore';
import { useDifferenceSelection } from '../../differences/selectionStore';
import { liveLiftHaplotypeColor } from '../palette';
import { liftHapLabels } from '../types';
import { useLiveLiftStore } from '../store';
import { LIFT_RIBBON_HEIGHT, LiftRibbonStrip } from './LiftRibbonStrip';
import {
  LIFT_RIBBON_TRACK, chooseLinkChain, jumpLinkedSource, linkedSourcePanels, openLinkedSourceView, registerLiftLinking,
  toggleLinkFlip, useLiftLinkCandidates,
} from './liftLink';
import { loadedSummary } from './navigation';

/** The "…" items of a lifted panel: open (or show) its haplotype's linked source view. */
export function LiftedPanelLinkItems({ ctx }: { ctx: PanelHeaderContext }) {
  const { panel, dataset } = ctx;
  const labels = liftHapLabels(dataset?.live_lift);
  const haps = panel.liftHap ? [panel.liftHap] : labels;
  return (
    <>
      {haps.map(hap => (
        <MenuItem key={hap} tour="panel-live-lift-source-view" icon={<span>⇣</span>}
          title={`Open the source BAM on HG002 ${hap} coordinates under this panel, linked through the map`}
          onSelect={() => { void openLinkedSourceView(panel.id, hap); }}>
          <span data-testid={`live-lift-open-source-${hap}`}>{haps.length > 1 ? `Open ${hap} source view` : 'Open source view'}</span>
        </MenuItem>
      ))}
    </>
  );
}

function useLinkedSourceHeader(ctx: PanelHeaderContext) {
  const dark = useBrowserStore(s => s.darkMode);
  const link = ctx.panel.liftLink;
  const candidates = useLiftLinkCandidates(s => (link ? s.byPanel[ctx.panel.id] : undefined));
  const liftKey = useBrowserStore(s => (link ? s.datasets.find(d => d.id === link.datasetId)?.live_lift?.key : undefined));
  const enabled = useLiveLiftStore(s => s.enabled);
  if (!link || !enabled) return null;
  const summary = liftKey ? loadedSummary(link.datasetId, liftKey) : null;
  const text = `Linked · HG002 ${link.hapLabel}${link.flip ? ' · reversed' : ''}`;
  const chainLabel = (chain: number) => {
    const row = summary?.chains[chain];
    return row ? `${row[3]} ${row[6]} (${row[0]}:${row[1].toLocaleString()}–${row[2].toLocaleString()})` : `chain ${chain}`;
  };
  const chips = (
    <>
      <span className="fb-header-pill flex-shrink-0 truncate" style={{ color: liveLiftHaplotypeColor(link.hapLabel, dark) }}
        data-testid="lift-link-chip" title={`Follows the live-lift ${link.hapLabel} panel through the map; the ribbon shows what corresponds.`}>
        {text}
      </span>
      {candidates && candidates.candidates.length > 0 && (
        <span className="fb-header-pill flex-shrink-0" data-testid="lift-link-candidates"
          title={`This view also corresponds to ${candidates.candidates.map(c => chainLabel(c.chain)).join('; ')}. Pick one in "…".`}>
          {candidates.candidates.length + 1} correspondences
        </span>
      )}
    </>
  );
  const menu = (
    <>
      <MenuItem tour="panel-lift-link-flip" icon={<span>⇆</span>} title="Draw this view the other way round relative to the lifted panel"
        onSelect={() => toggleLinkFlip(ctx.panel.id)}>
        <span data-testid="lift-link-flip">{link.flip ? 'Same orientation as the lifted panel' : 'Reverse relative to the lifted panel'}</span>
      </MenuItem>
      {candidates && candidates.candidates.length > 0 && (
        <>
          <MenuItem tour="panel-lift-link-choose" icon={<span>◎</span>} title="Follow the correspondence most of the view maps through"
            onSelect={() => chooseLinkChain(ctx.panel.id, null)} role="menuitemcheckbox" checked={link.chain == null}>
            Dominant: {chainLabel(candidates.chosen)}
          </MenuItem>
          {candidates.candidates.map(c => (
            <MenuItem key={c.chain} tour="panel-lift-link-choose" icon={<span>◎</span>} role="menuitemcheckbox" checked={link.chain === c.chain}
              title={`${Math.round(c.share * 100)}% of the view${c.minus ? ', reverse strand' : ''}`} onSelect={() => chooseLinkChain(ctx.panel.id, c.chain)}>
              <span data-testid="lift-link-candidate">Follow {chainLabel(c.chain)}</span>
            </MenuItem>
          ))}
        </>
      )}
    </>
  );
  return { chipTexts: [text], chips, menu, wantsMenu: true, menuTitle: 'linked source view' };
}

/** Clicking an insertion in a lifted panel shows its inserted bases in that haplotype's linked source panel. */
function followInsertionClicks() {
  let last: unknown = null;
  useDifferenceSelection.subscribe(({ selection }) => {
    if (selection === last) return;
    last = selection;
    const d = selection?.difference;
    if (!selection || !d || !useLiveLiftStore.getState().enabled) return;
    if (d.kind !== 'insertion' && d.kind !== 'replacement') return;
    if (!d.src?.contig || d.src.start == null || d.src.end == null) return;
    for (const panel of linkedSourcePanels(selection.datasetId, d.hap_label)) {
      jumpLinkedSource(panel.id, { contig: d.src.contig, start: d.src.start, end: d.src.end });
    }
  });
}

let done = false;
export function registerLiftLinkingUi(): void {
  if (done) return;
  done = true;
  registerLiftLinking();
  declareContribution('panelFields', 'liftLink');
  registerTrackKind({ type: LIFT_RIBBON_TRACK, label: 'Lift ribbon', defaultHeight: LIFT_RIBBON_HEIGHT, minHeight: 24, maxHeight: 160,
    deletable: false, shownWhen: 'in a linked source view' });
  registerTrackRenderer({
    type: LIFT_RIBBON_TRACK,
    useHeight: () => {
      const enabled = useLiveLiftStore(s => s.enabled);
      return ({ panel, track }) => (enabled && panel.liftLink ? track.heightOverride ?? LIFT_RIBBON_HEIGHT : null);
    },
    render: ({ panel, width, height, sidebarWidth }) => <LiftRibbonStrip panel={panel} width={width} height={height} sidebarWidth={sidebarWidth} />,
  });
  registerPanelHeaderExtension(useLinkedSourceHeader);
  followInsertionClicks();
}
