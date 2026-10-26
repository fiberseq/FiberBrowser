/**
 * Graph mode in a dataset panel's header (DESIGN_GRAPH_PRIMARY §1.2, §4, §7.3; graph primary G1/G6):
 * - "View as: Linear / Graph" in "…" and a two-state header toggle when a registered package binds the dataset;
 *   otherwise the menu item says why;
 * - a host: pop out one, some or all haplotypes, fold them back, add panels; while linear (zoomed out past the
 *   hand-off, or "Stay linear") a bar says so with "Stay linear" / "Resume graph";
 * - a member: the chip "In graph · MAT", "Fold into graph", "Remove from graph";
 * - any other bound panel: "Join <host> graph".
 */
import { lazy, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { MenuItem } from '../../components/tracks/PanelHeader';
import type { PanelHeaderContext } from '../../components/tracks/panelHeaderExtensions';
import { useBrowserStore } from '../../stores/browserStore';
import { graphBindingFor, useGraphBindingsStore, watchGraphBindings } from './bindingsStore';
import { formatBp } from './coordinates';
import { HANDOFF_OUT_BP, setPinnedLinear, useGraphSettings } from './handoff';
import { foldIn, graphUnavailable, hostOf, isHost, joinCandidates, joinGraph, membersOf, popOut, poppable, removeFromGraph, setPanelViewMode, viewSelectionAsGraph } from './hostMode';
import { useGraphStatusStore } from './statusStore';
import { memberLabel, singleHapPathName } from './labels';
import type { DatasetBodyProps } from '../../components/tracks/datasetBodyExtensions';
import type { PanelConfig } from '../../types';

const LazyGraphPanel = lazy(() => import('./GraphPanel'));

/** A host's body while it draws its graph (the hand-off has it graph). */
export function GraphHostBody({ panel, width, height }: DatasetBodyProps) {
  return (
    <div data-testid="graph-host-body" data-panel-id={panel.id} data-crosshair-exclude="true" style={{ height, overflow: 'hidden' }}>
      <LazyGraphPanel panelId={panel.id} width={width} height={height} />
    </div>
  );
}

/** Whether the host's body is its graph now (else its linear tracks: hand-off, pinned, no graph on this contig). */
export function hostShowsGraph(panel: PanelConfig): boolean {
  return isHost(panel) && panel.graphView?.handoff?.shown !== 'linear';
}


export function useGraphModeHeader(ctx: PanelHeaderContext) {
  const { panel, dataset } = ctx;
  const helper = useGraphStatusStore(s => Boolean(s.status?.helper.available && s.status.registrations.length));
  const bound = useGraphBindingsStore(s => Boolean(panel.datasetId && s.byDataset[panel.datasetId]?.length));
  const bindingsKey = useGraphBindingsStore(s => s.key);
  // The host and member panels this header needs (by id; a member's host, a host's members).
  const related = useBrowserStore(useShallow(s => s.panels.filter(p => p.id === panel.graphMemberOf || p.graphMemberOf === panel.id
    || (isHost(p) && p.id !== panel.id))));
  const outBp = useGraphSettings(s => s.outBp);
  void bindingsKey;
  useEffect(() => { watchGraphBindings(); }, []);
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
            onSelect={() => popOut(panel.id, [p.id])}><span data-testid="graph-pop-out" data-member={p.id}>Pop out {memberLabel(p, datasetLabels(p), panel.graphView?.targetBinding ?? null)}</span></MenuItem>
        ))}
        {missing.map(m => (
          <MenuItem key={m.binding} tour="panel-graph-popout" icon={<span>⇱</span>} title="A new panel of this dataset for that haplotype, starting with this panel's state"
            onSelect={() => popOut(panel.id, [], [m])}><span data-testid="graph-pop-out-new" data-binding={m.binding}>Pop out {m.hap} (a new panel)</span></MenuItem>
        ))}
        {folded.length + missing.length > 1 && (
          <MenuItem tour="panel-graph-popout-all" icon={<span>⇱</span>} title="Every folded member and haplotype in view, as panels"
            onSelect={() => popOut(panel.id, folded.map(p => p.id), missing)}><span data-testid="graph-pop-out-all">Pop out all haplotypes in view</span></MenuItem>
        )}
        {revealed.length > 0 && (
          <MenuItem tour="panel-graph-fold-all" icon={<span>⇲</span>} title="Hide the popped-out members again (their state stays)"
            onSelect={() => foldIn(panel.id, revealed.map(m => m.panel.id))}><span data-testid="graph-fold-all">Fold all pop-outs</span></MenuItem>
        )}
        {joinable.map(c => (
          <MenuItem key={c.panel.id} tour="panel-graph-add" icon={<span>+</span>} title="Its reads join this graph on the path they bind; the panel folds into it"
            onSelect={() => joinGraph(panel.id, [c.panel.id])}>
            <span data-testid="graph-add-panel" data-member={c.panel.id}>Add {c.panel.title || c.panel.liftHap || 'panel'} to this graph</span>
          </MenuItem>
        ))}
      </>
    );
    const body = shown === 'linear' ? (
      <div data-testid="graph-handoff-bar" className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
        <span>{pinned ? 'Linear · graph mode paused'
          : panel.graphView?.handoff?.reason === 'complexity' ? 'Linear · most of this window is unresolved in the graph'
            : `Linear · graph resumes below ${formatBp(useGraphSettings.getState().inBp)}`}</span>
        <button type="button" className="underline" data-testid={pinned ? 'graph-resume' : 'graph-stay-linear'}
          onClick={() => setPinnedLinear(panel.id, !pinned)}>{pinned ? 'Resume graph' : 'Stay linear'}</button>
      </div>
    ) : null;
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
          onSelect={() => joinGraph(h.id, [panel.id])}><span data-testid="graph-join" data-host={h.id}>Join {h.title || h.liftHap || 'that'} graph</span></MenuItem>
      ))}
    </>
  );
  return { chipTexts: [`${text} ⇄ Graph`], chips, menu, wantsMenu: true, menuTitle: 'graph mode' };
}

export { HANDOFF_OUT_BP };
