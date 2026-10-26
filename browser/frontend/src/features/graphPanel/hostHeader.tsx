/**
 * Graph mode in a dataset panel's header (DESIGN_GRAPH_PRIMARY §1.2, §4, §7.3; graph primary G1/G6):
 * - "View as: Linear / Graph" in "…" and a two-state header toggle when a registered package binds the dataset;
 *   otherwise the menu item says why;
 * - a host: pop out one, some or all haplotypes, fold them back, add panels; while linear (zoomed out past the
 *   hand-off, or "Stay linear") a bar says so with "Stay linear" / "Resume graph";
 * - a member: the chip "In graph · MAT", "Fold into graph", "Remove from graph";
 * - any other bound panel: "Join <host> graph".
 */
import { lazy, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { fadeIn, panelBodyParts } from './crossfade';
import { featureText, notDrawnInLinear } from './linearNotices';
import { useShallow } from 'zustand/react/shallow';
import { MenuItem } from '../../components/tracks/PanelHeader';
import type { PanelHeaderContext } from '../../components/tracks/panelHeaderExtensions';
import { useBrowserStore } from '../../stores/browserStore';
import { graphBindingFor, useGraphBindingsStore, watchGraphBindings } from './bindingsStore';
import { formatBp } from './coordinates';
import { HANDOFF_OUT_BP, setPinnedLinear, useGraphSettings } from './handoff';
import { foldIn, graphUnavailable, hostOf, isHost, joinCandidates, joinGraph, membersOf, poppable, removeFromGraph, setPanelViewMode, viewSelectionAsGraph } from './hostMode';
import { PopOutPicker, usePopOutPicker } from './PopOutPicker';
import { acceptGraphOffer, dismissGraphOffer, graphOfferPanel, useGraphOffers, withdrawGraphOffer } from './graphOffer';
import { POP_OUT_KINDS, popOutKindOf, popOutPaths, setPopOutKind, type PopOutKind } from './popOutKind';
import { useGraphStatusStore } from './statusStore';
import { memberLabel, singleHapPathName } from './labels';
import type { DatasetBodyProps } from '../../components/tracks/datasetBodyExtensions';
import type { PanelConfig } from '../../types';

const LazyGraphPanel = lazy(() => import('./GraphPanel'));

/** A host's body while it draws its graph (the hand-off has it graph). */
export function GraphHostBody({ panel, width, height }: DatasetBodyProps) {
  // The graph comes back with a 150 ms fade (§7.3; mounted when the host's body switches to its graph).
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { fadeIn([ref.current]); }, []);
  return (
    <div ref={ref} data-testid="graph-host-body" data-panel-id={panel.id} data-crosshair-exclude="true" style={{ height, overflow: 'hidden' }}>
      <LazyGraphPanel panelId={panel.id} width={width} height={height} />
    </div>
  );
}

/** Whether the host's body is its graph now (else its linear tracks: hand-off, pinned, no graph on this contig). */
export function hostShowsGraph(panel: PanelConfig): boolean {
  return isHost(panel) && panel.graphView?.handoff?.shown !== 'linear';
}


/** The hand-off bar of a host drawn linear: mounted when its body switches to its linear tracks, which then fade in
 * over 150 ms (§7.3). */
function HandoffBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { fadeIn(panelBodyParts(ref.current)); }, []);
  return <div ref={ref} data-testid="graph-handoff">{children}</div>;
}

const POP_OUT_KIND_LABELS: Record<PopOutKind, string> = { lifted: 'lifted panel', source: 'source view', both: 'lifted and source' };
const POP_OUT_KIND_TITLES: Record<PopOutKind, string> = {
  lifted: 'A popped-out path is its lifted panel, on this genome',
  source: 'A popped-out path opens its source BAM on that haplotype\'s own assembly, linked through the map',
  both: 'A popped-out path shows its lifted panel and its linked source view',
};

export function useGraphModeHeader(ctx: PanelHeaderContext) {
  const { panel, dataset } = ctx;
  const helper = useGraphStatusStore(s => Boolean(s.status?.helper.available && s.status.registrations.length));
  const bound = useGraphBindingsStore(s => Boolean(panel.datasetId && s.byDataset[panel.datasetId]?.length));
  const bindingsKey = useGraphBindingsStore(s => s.key);
  // The host and member panels this header needs (by id; a member's host, a host's members).
  const related = useBrowserStore(useShallow(s => s.panels.filter(p => p.id === panel.graphMemberOf || p.graphMemberOf === panel.id
    || (isHost(p) && p.id !== panel.id))));
  const outBp = useGraphSettings(s => s.outBp);
  const pickerOpen = usePopOutPicker(s => s.hostId === panel.id);
  const graphRun = useBrowserStore(s => (s.clusterMatchedRun?.graph?.hostPanelId === panel.id ? s.clusterMatchedRun : null));
  const offered = useGraphOffers(s => Boolean(panel.datasetId && s.offered[panel.datasetId] && !s.done[panel.datasetId]));
  // (Which panel shows the offer depends on the dataset's other panels.)
  const offerHere = useBrowserStore(s => offered && graphOfferPanel(s.panels, panel.datasetId, useGraphOffers.getState()) === panel.id);
  void bindingsKey;
  useEffect(() => { watchGraphBindings(); }, []);
  // Viewed as a graph some other way (the header toggle, a selection): the offer is used.
  const inGraph = isHost(panel) || Boolean(panel.graphMemberOf);
  // (Judged on the store's panels now, not this render's: a header of a panel a session restore just replaced may
  // still be mounted when the restored split panels are offered.)
  useEffect(() => {
    if (!offered || !inGraph || !panel.datasetId) return;
    const now = useBrowserStore.getState().panels;
    if (now.some(p => p.datasetId === panel.datasetId && (isHost(p) || p.graphMemberOf))) withdrawGraphOffer(panel.datasetId);
  }, [offered, inGraph, panel.datasetId]);
  if (panel.contentType !== 'dataset' || !panel.datasetId) return null;
  const host = isHost(panel);
  const panels = [panel, ...related];
  const member = !host && panel.graphMemberOf ? hostOf(panels, panel) : null;
  if (!host && !member && !(helper && bound)) {
    // Not bound (or no package): the menu item says why, only when a package is registered at all.
    if (!helper) return null;
    const why = graphUnavailable(panel);
    return {
      menu: (
        <MenuItem tour="panel-graph-view" icon={<span>⌥</span>} title={why ?? ''} onSelect={() => undefined}>
          <span className="opacity-50" data-testid="graph-view-as-unavailable">View as graph</span>
        </MenuItem>
      ),
      wantsMenu: false,
    };
  }
  const datasetLabel = dataset?.label ?? panel.datasetId;
  const datasetLabels = (p: PanelConfig) => (p.datasetId === panel.datasetId ? datasetLabel
    : useBrowserStore.getState().datasets.find(d => d.id === p.datasetId)?.label ?? p.datasetId ?? '');
  if (host) {
    const shown = panel.graphView?.handoff?.shown ?? 'graph';
    const pinned = Boolean(panel.graphView?.handoff?.pinnedLinear);
    const members = membersOf(panels, panel);
    const { folded, missing } = poppable(panels, panel);
    const revealed = members.filter(m => m.panel.id !== panel.id && !m.panel.collapsedByGraphGroup);
    const joinable = joinCandidates(useBrowserStore.getState().panels, panel);
    const popOutKind = popOutKindOf(panel);
    // One haplotype (G8): the host is labelled by its path's PanSN name, as split members are by MAT / PAT.
    const pathName = singleHapPathName(graphBindingFor(panel.datasetId), panel.liftHap, panel.graphView?.targetBinding ?? null);
    const chipText = `${shown === 'graph' ? 'Graph' : 'Graph · linear'}${pathName ? ` · ${pathName}` : ''}`;
    const chips = (
      <button type="button" className="fb-header-pill flex-shrink-0" data-testid="graph-mode-toggle" data-mode="graph" data-shown={shown} data-path-name={pathName ?? undefined}
        title={shown === 'graph' ? 'Graph mode: this panel and its members on the package\'s paths (click: view as linear)'
          : `Graph mode, drawn linear here (${pinned ? 'Stay linear is on' : panel.graphView?.handoff?.reason === 'complexity'
            ? 'most of the window is unresolved in the graph' : `wider than ${formatBp(outBp)}`}); click: view as linear`}
        onClick={e => { e.stopPropagation(); setPanelViewMode(panel.id, 'linear'); }}>{chipText}</button>
    );
    const menu = (
      <>
        <MenuItem tour="panel-graph-linear" icon={<span>≡</span>} title="This panel's read tracks; its folded members open beside it"
          onSelect={() => setPanelViewMode(panel.id, 'linear')}><span data-testid="graph-view-as-linear">View as linear</span></MenuItem>
        {folded.map(p => (
          <MenuItem key={p.id} tour="panel-graph-popout" icon={<span>⇱</span>} title="Shown as its own panel, with its own tools and state"
            onSelect={() => popOutPaths(panel.id, [p.id])}><span data-testid="graph-pop-out" data-member={p.id}>Pop out {memberLabel(p, datasetLabels(p), panel.graphView?.targetBinding ?? null)}</span></MenuItem>
        ))}
        {missing.map(m => (
          <MenuItem key={m.binding} tour="panel-graph-popout" icon={<span>⇱</span>} title="A new panel of this dataset for that haplotype, starting with this panel's state"
            onSelect={() => popOutPaths(panel.id, [], [m])}><span data-testid="graph-pop-out-new" data-binding={m.binding}>Pop out {m.hap} (a new panel)</span></MenuItem>
        ))}
        {folded.length + missing.length > 1 && (
          <MenuItem tour="panel-graph-popout-some" icon={<span>⇱</span>} title="Choose which paths in view to pop out as panels"
            onSelect={() => usePopOutPicker.getState().open(panel.id)}><span data-testid="graph-pop-out-some">Pop out paths…</span></MenuItem>
        )}
        {folded.length + missing.length > 1 && (
          <MenuItem tour="panel-graph-popout-all" icon={<span>⇱</span>} title="Every folded member and haplotype in view, as panels"
            onSelect={() => popOutPaths(panel.id, folded.map(p => p.id), missing)}><span data-testid="graph-pop-out-all">Pop out all haplotypes in view</span></MenuItem>
        )}
        {POP_OUT_KINDS.map(k => (
          <MenuItem key={`kind-${k}`} tour="panel-graph-popout-kind" icon={<span>{popOutKind === k ? '●' : '○'}</span>}
            title={POP_OUT_KIND_TITLES[k]} onSelect={() => setPopOutKind(panel.id, k)}>
            <span data-testid="graph-pop-out-kind" data-kind={k} data-checked={popOutKind === k ? 'true' : 'false'}>Pop out as: {POP_OUT_KIND_LABELS[k]}</span>
          </MenuItem>
        ))}
        {revealed.length > 0 && (
          <MenuItem tour="panel-graph-fold-all" icon={<span>⇲</span>} title="Hide the popped-out members again (their state stays)"
            onSelect={() => foldIn(panel.id, revealed.map(m => m.panel.id))}><span data-testid="graph-fold-all">Fold all pop-outs</span></MenuItem>
        )}
        {joinable.map(c => (
          <MenuItem key={c.panel.id} tour="panel-graph-add" icon={<span>+</span>} title="Its reads join this graph on the path they bind; the panel folds into it"
            onSelect={() => joinGraph(panel.id, [c.panel.id])}>
            <span data-testid="graph-add-panel" data-member={c.panel.id}>Add {c.panel.title || [datasetLabels(c.panel), c.panel.liftHap].filter(Boolean).join(' · ')} to this graph</span>
          </MenuItem>
        ))}
      </>
    );
    const picker = pickerOpen && folded.length + missing.length > 0 ? (
      <PopOutPicker key={[...folded.map(p => p.id), ...missing.map(m => m.binding)].join('|')} hostId={panel.id} folded={folded} missing={missing}
        labelOf={p => memberLabel(p, datasetLabels(p), panel.graphView?.targetBinding ?? null)} />
    ) : null;
    // The graph run's carrier-only regions (§7.4): listed while linear, which has no coordinate for them.
    const notDrawn = shown === 'linear' ? notDrawnInLinear(graphRun, panel.id) : [];
    const handoffBar = shown === 'linear' ? (
      <HandoffBar>
        <div data-testid="graph-handoff-bar" className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
          <span>{pinned ? 'Linear · graph mode paused'
            : panel.graphView?.handoff?.reason === 'complexity' ? 'Linear · most of this window is unresolved in the graph'
              : `Linear · graph resumes below ${formatBp(useGraphSettings.getState().inBp)}`}</span>
          <button type="button" className="underline" data-testid={pinned ? 'graph-resume' : 'graph-stay-linear'}
            onClick={() => setPinnedLinear(panel.id, !pinned)}>{pinned ? 'Resume graph' : 'Stay linear'}</button>
        </div>
        {notDrawn.length > 0 && (
          <div data-testid="graph-handoff-carrier-only" className="px-2 py-0.5 text-[11px] text-stone-600 dark:text-stone-300"
            title="Sequence the target does not have: the graph run used it, linear tracks have no coordinate for it">
            Not drawn in linear view: {notDrawn.map(featureText).join('; ')}
          </div>
        )}
      </HandoffBar>
    ) : null;
    const body = picker || handoffBar ? <>{picker}{handoffBar}</> : null;
    return { chipTexts: [chipText], chips, menu, wantsMenu: true, menuTitle: 'graph mode', ...(body ? { body } : {}) };
  }
  if (member) {
    const folded = panel.collapsedByGraphGroup === member.id;
    const text = `In graph · ${memberLabel(panel, datasetLabel, member.graphView?.targetBinding ?? null)}`;
    const chips = <span className="fb-header-pill flex-shrink-0" data-testid="graph-member-chip" title={`Drawn in ${member.title || 'its host'}'s graph; its own tools and state`}>{text}</span>;
    const menu = (
      <>
        {!folded && <MenuItem tour="panel-graph-fold" icon={<span>⇲</span>} title="Hidden again inside the graph (its state stays)"
          onSelect={() => foldIn(member.id, [panel.id])}><span data-testid="graph-fold-in">Fold into graph</span></MenuItem>}
        <MenuItem tour="panel-graph-remove" icon={<span>×</span>} title="An ordinary panel again, out of the graph (its state stays)"
          onSelect={() => removeFromGraph(panel.id)}><span data-testid="graph-remove">Remove from graph</span></MenuItem>
      </>
    );
    return { chipTexts: [text], chips, menu, wantsMenu: true, menuTitle: 'graph mode' };
  }
  // A bound linear panel: view it as a graph, or join a host already open.
  const hosts = related.filter(p => isHost(p) && joinCandidates(useBrowserStore.getState().panels, p).some(c => c.panel.id === panel.id));
  const text = 'Linear';
  const chips = (
    <button type="button" className="fb-header-pill flex-shrink-0" data-testid="graph-mode-toggle" data-mode="linear"
      title={`View as graph (the package's paths${panel.liftHap ? '; this panel\'s other haplotypes join it' : ''})`}
      onClick={e => { e.stopPropagation(); viewSelectionAsGraph(panel.id); }}>{text} ⇄ Graph</button>
  );
  const menu = (
    <>
      <MenuItem tour="panel-graph-view" icon={<span>⌥</span>} title="This panel on the graph package's paths, with its haplotypes and read tools"
        onSelect={() => viewSelectionAsGraph(panel.id)}><span data-testid="graph-view-as-graph">View as graph</span></MenuItem>
      {hosts.map(h => (
        <MenuItem key={h.id} tour="panel-graph-join" icon={<span>+</span>} title="This panel's reads join that graph; this panel folds into it"
          onSelect={() => joinGraph(h.id, [panel.id])}><span data-testid="graph-join" data-host={h.id}>Join {h.title || [datasetLabels(h), h.liftHap].filter(Boolean).join(' · ') || 'that'} graph</span></MenuItem>
      ))}
    </>
  );
  // A restored split session, or a binding that came after the user acted on these panels: offered once (§5.2, §5.4).
  const offer = offerHere && !graphUnavailable(panel) ? (
    <div data-testid="graph-offer-bar" data-dataset={panel.datasetId}
      className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
      <span>A graph package binds this dataset{panel.liftHap ? '; its haplotype panels can be viewed together on its paths' : ''}.</span>
      <button type="button" className="underline" data-testid="graph-offer-view" onClick={() => acceptGraphOffer(panel.id, panel.datasetId!)}>View as graph</button>
      <button type="button" className="ml-auto" aria-label="Dismiss" title="Dismiss" data-testid="graph-offer-dismiss"
        onClick={() => dismissGraphOffer(panel.datasetId!)}>×</button>
    </div>
  ) : null;
  return { chipTexts: [`${text} ⇄ Graph`], chips, menu, wantsMenu: true, menuTitle: 'graph mode', ...(offer ? { body: offer } : {}) };
}

export { HANDOFF_OUT_BP };
