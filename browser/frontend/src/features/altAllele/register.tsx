/**
 * Alt-allele (insert-expanded) panels: an insertion's carriers re-aligned onto its alternate allele (reference flank +
 * insert consensus + reference flank). Their header chips and menu items, the ruler's readouts on the alt contig, the
 * link to the main view through the breakpoint, the SV menu item, and the split hooks (an insertion's SV split opens
 * its Carriers expanded; closing a split takes the alt datasets it built).
 */
import { registerBrowserHost } from '../../plugins/browserHosts';
import { declareContribution } from '../../plugins/packRegistry';
import { item, registerReadMenuContribution } from '../../components/tracks/read-track/readMenuModel';
import { registerPanelHeaderExtension, type PanelHeaderContext } from '../../components/tracks/panelHeaderExtensions';
import { registerContigCoordinates } from '../../components/tracks/axisCoordinates';
import { MenuItem } from '../../components/tracks/PanelHeader';
import { Check, Dna, Link, Unlink } from '../../components/ui/Icons';
import { registerPanelTraits, registerSplitHooks, registerViewLink } from '../../utils/panelExtensions';
import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { altAlleleName, altLayoutForContig, altPositionLabel, describeAltPosition, mapSpanToAlt, mapSpanToRef } from './altAlleleCoords';
import {
  cancelAltAlleleBuild, expandSvSplitCarriers, svSplitExpands, openAltAllelePanel, releaseAltDatasets, setAltIncludeReference, setAltLinked, showPanelOnAltAllele,
  showPanelOnReference, toggleInsertExpanded, useAltAlleleBuildStore,
} from './altAllelePanel';
import { useAltAllelePanels } from './useAltAllelePanels';
import { ALT_ALLELE_PREVIEW } from './preview';
import { usePreviewsEnabled } from '../../utils/previewFeatures';
import { PreviewBadge } from '../../components/ui/PreviewBadge';
import { AltAlleleProvenancePill, buildingText, useElapsedSeconds } from './AltAlleleProvenance';
import { JobStatus } from '../../components/controls/shared/JobStatus';
import { getDatasetDisplayLabel } from '../../utils/datasetLabels';
import { formatShare } from '../../utils/denominators';

/** Keeps alt-allele panels in step (rebuilt after a session or undo). */
function AltAllelePanelsHost() {
  useAltAllelePanels();
  return null;
}

const CLUSTER_SCOPE_HINT = 'An insert-expanded Carriers panel is on its insertion’s alternate allele, in its own coordinates: '
  + 'peaks there (inside or around the insert) cluster it on its own; to cluster it together with the Reference panel, show it on the reference '
  + '(its header’s “Pinned to insertion ⓘ” → Show on reference) and pick peaks on the reference (the insert itself has no reference coordinates).';

/** The header's alt-allele chips and "…" items. */
function useAltAlleleHeader({ panel, dataset, showLayoutChrome }: PanelHeaderContext) {
  const altBuilding = useAltAlleleBuildStore(s => s.pending[panel.id]);
  const altStarted = useAltAlleleBuildStore(s => s.started[panel.id]);
  // A Preview feature: with previews off, no way in ("Show insert expanded", "Expand <insertion>"); a panel a session
  // brought keeps its chip (the way back) and its items.
  const previews = usePreviewsEnabled();
  const elapsed = useElapsedSeconds(Boolean(altBuilding));
  const alt = panel.altAllele;
  // Its counts with their scope (audit SV-3): the carriers placed of every carrier at the site (all reads, not the loaded ones).
  const carriers = dataset?.alt_allele?.meta?.carriers;
  const placed = carriers ? `${formatShare(carriers.written, carriers.total, 'carriers at the site')} (all reads) placed here; the header's count is of the reads drawn` : '';
  const source = useBrowserStore(s => (alt ? s.datasets.find(d => d.id === alt.cluster.datasetId) : undefined));
  const subset = panel.readSubset;
  // The alt-allele items live only in "…": room for it is kept when they are offered.
  const offered = Boolean(panel.datasetId && ((previews && dataset?.data_type === 'bam') || alt));
  if (!offered && !altBuilding && !(previews && subset?.rule.carriedInsertions?.length)) return null;
  const chipTexts = [
    altBuilding ? 'Building alt allele… 00 s' : null,
    // One pill (round 3, R14a): the coordinate mode, its Preview mark, what the panel shows and the way back in its ⓘ.
    alt && !altBuilding ? (showLayoutChrome ? 'Pinned to insertion ⓘ' : `Alt allele ${altAlleleName(alt.layout)}`) : null,
  ].filter((t): t is string => Boolean(t));
  // A combined-SV genotype panel whose reads all carry an insertion: show it expanded (one insertion at a time). The
  // panel keeps its own reads there (this genotype's, not every carrier of the insertion). In the bar while the pills
  // fit whole, and always in "…" (round 2, N3: in a two-SV split's 480-px headers they shrank to empty circles).
  const splitInsertions = previews && subset && !alt && showLayoutChrome ? (subset.rule.carriedInsertions ?? []).slice(0, 2) : [];
  const expandInsertion = (ins: (typeof splitInsertions)[number]) => {
    const reads = useSplitPanelStore.getState().reads[panel.stateKey ?? panel.datasetId ?? panel.id];
    void showPanelOnAltAllele(panel.id, { datasetId: ins.datasetId, chrom: ins.chrom, ref: ins.ref, len: ins.len }).then(id => {
      const now = useBrowserStore.getState().panels.find(p => p.id === panel.id);
      if (id && reads && now?.stateKey) useSplitPanelStore.getState().setReads(now.stateKey, reads);
    });
  };
  const expandTitle = (ins: (typeof splitInsertions)[number]) => `Every read of this panel carries ${ins.name} (+${ins.len.toLocaleString()} bp at ${ins.chrom}:${(ins.ref + 1).toLocaleString()}): show it expanded, the reads on its alternate allele. One insertion at a time; “Pinned to insertion ⓘ” → Show on reference goes back.`;
  const headerPills = splitInsertions.map(ins => ({
    key: `expand-${ins.ref}-${ins.len}`, text: `Expand ${ins.name}`, title: expandTitle(ins), testId: 'split-panel-expand-insert',
    icon: <Dna size={11} aria-hidden="true" />, onSelect: () => expandInsertion(ins),
  }));
  const chips = (
    <>
      {altBuilding && (
        <span className="fb-header-pill flex-shrink-0 truncate animate-pulse" data-testid="alt-allele-building" title={buildingText(altBuilding, elapsed)}>
          Building alt allele… {elapsed > 0 ? `${elapsed} s` : ''}
        </span>
      )}
      {alt && !altBuilding && (showLayoutChrome ? (
        // Persistent (audit SV-2): this panel is pinned to the insertion, in its own coordinates; its ⓘ says what it
        // shows (a Preview feature) and takes it back to the reference.
        <AltAlleleProvenancePill layout={alt.layout} info={dataset?.alt_allele} sourceLabel={source ? getDatasetDisplayLabel(source) : undefined}
          placed={placed || undefined} onShowReference={() => { void showPanelOnReference(panel.id); }} />
      ) : (
        <span className="fb-header-pill min-w-0 max-w-[50%] shrink" title={`Alt allele ${altAlleleName(alt.layout)}`}>
          <span className="min-w-0 truncate">Alt allele {altAlleleName(alt.layout)}</span>
        </span>
      ))}
    </>
  );
  const menu = offered ? (
    <>
      {splitInsertions.map(ins => (
        <MenuItem key={`expand-${ins.ref}-${ins.len}`} tour="panel-split-expand-insert" icon={<Dna size={13} />} title={expandTitle(ins)}
          onSelect={() => expandInsertion(ins)}>
          <span data-testid="split-panel-expand-insert-item">Expand {ins.name} (this panel’s reads)</span>
        </MenuItem>
      ))}
      <MenuItem tour="panel-insert-expanded" icon={alt ? <Check size={13} /> : <Dna size={13} />} role="menuitemcheckbox" checked={Boolean(alt)}
        title={alt
          ? 'Back to the reference: this panel shows what it showed before'
          : 'The insertion in view (the one most reads carry) with its insert expanded: this panel shows only its carriers, re-aligned onto reference flank + insert consensus + reference flank, so the reads inside the insert can be clustered, sorted, filtered and analysed like any region'}
        onSelect={() => { void toggleInsertExpanded(panel.id); }}>
        Show insert expanded (carriers only) <PreviewBadge feature={ALT_ALLELE_PREVIEW} className="ml-1" />
      </MenuItem>
      {alt && (
        <MenuItem tour="panel-alt-reference-reads" icon={alt.includeReference ? <Check size={13} /> : <span className="w-[13px]" />} role="menuitemcheckbox" checked={Boolean(alt.includeReference)}
          title="Reference reads too (the reads without the insert), drawn with the insert as a gap across them"
          onSelect={() => { void setAltIncludeReference(panel.id, !alt.includeReference); }}>
          Include reference reads (insert as a gap)
        </MenuItem>
      )}
      {alt && !alt.sourceGenome && (
        <MenuItem tour="panel-alt-linked" icon={alt.linked ? <Link size={13} /> : <Unlink size={13} />} role="menuitemcheckbox" checked={alt.linked}
          title="Move with the main view through the breakpoint (positions after the insert are offset by its length; inside it, the main view stays at the breakpoint)"
          onSelect={() => setAltLinked(panel.id, !alt.linked)}>
          Move with the main view
        </MenuItem>
      )}
    </>
  ) : null;
  return {
    chipTexts, chips, headerPills, menu, wantsMenu: offered, menuTitle: offered ? 'the insert expanded' : undefined,
    // An alt-allele panel's title says which reads it shows (the insertion's carriers): room for it.
    labelChars: alt ? 96 : undefined,
    // The build in the panel body: stage and time so far (SV-4: a small chip was all it said for ~36 s).
    body: altBuilding && showLayoutChrome ? (
      <JobStatus compact title="Building insertion reference" state="running" stage={altBuilding.replace(/…$/, '')}
        startedAt={altStarted ?? null} testId="alt-allele-build-status" onCancel={() => cancelAltAlleleBuild(panel.id)} />
    ) : undefined,
  };
}

/** The ruler on an alt-allele contig: reference or insert coordinates, the insert shaded and named. */
function useAltContig(chrom: string | null | undefined) {
  const layout = useBrowserStore(s => altLayoutForContig(s.datasets, chrom));
  if (!layout) return null;
  return {
    positionLabel: (pos: number) => `${altPositionLabel(layout, pos)} · alt ${(pos + 1).toLocaleString()}`,
    // Where the view starts and ends, in reference or insert coordinates.
    regionText: (start: number, end: number) => `${altPositionLabel(layout, start)} – ${altPositionLabel(layout, Math.max(start, end - 1))}`,
    tickBase: layout.insert_start,
    tickLabel: (pos: number, format: (pos: number) => string) => {
      const tick = describeAltPosition(layout, pos);
      return tick.segment === 'insert' ? `ins ${format(tick.insert)}` : format(tick.ref + 1);
    },
    decorate: (ctx: CanvasRenderingContext2D, { genomeToScreen, width, height, regionText }: { genomeToScreen: (pos: number) => number; width: number; height: number; regionText: string }) => {
      // The insert, shaded.
      const xa = genomeToScreen(layout.insert_start);
      const xb = genomeToScreen(layout.insert_end);
      const [x1, x2] = [Math.max(0, Math.min(xa, xb)), Math.min(width, Math.max(xa, xb))];
      if (x2 > x1) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
        ctx.fillRect(x1, 0, x2 - x1, height);
        ctx.fillStyle = 'rgba(180, 83, 9, 0.9)';
        for (const x of [xa, xb]) if (x >= 0 && x <= width) ctx.fillRect(Math.round(x) - 0.5, 0, 1, height);
        // Its name on the top row (the tick labels are on the bottom one), clear of the locus and width.
        const insertText = `INS +${layout.insert_len.toLocaleString()} bp`;
        ctx.font = 'bold 9px sans-serif';
        const tw = ctx.measureText(insertText).width;
        ctx.font = 'bold 10px sans-serif';
        const locusRight = 4 + ctx.measureText(regionText).width;
        const centre = Math.max((x1 + x2) / 2, locusRight + 8 + tw / 2);
        if (x2 - x1 > tw + 12 && centre + tw / 2 < Math.min(x2, width - 50)) {
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(insertText, centre, 12);
        }
      }
    },
  };
}

export function registerAltAllele(): void {
  // An insert-expanded panel shows a dataset this pack built: a build without the pack leaves the panel out whole.
  declareContribution('panelOwners', 'altAllele');
  registerBrowserHost('alt-allele-panels', AltAllelePanelsHost);
  registerPanelHeaderExtension(useAltAlleleHeader);
  registerContigCoordinates(useAltContig);

  registerPanelTraits(panel => (panel.altAllele ? {
    // An insert-expanded panel is on its own contig; while its built dataset isn't open yet (a restored session) it
    // stays as long as its source is: it is rebuilt from the insertion it records (healAltAllelePanels).
    ownContig: true,
    keptWithDataset: panel.altAllele.cluster.datasetId,
    clusterScopeHint: CLUSTER_SCOPE_HINT,
    backToReference: { label: 'Show on reference', run: () => { void showPanelOnReference(panel.id); } },
  } : null));

  // Linked alt-allele panels show the main view mapped through the breakpoint (positions after the insert are offset
  // by its length; a view across the breakpoint widens by the insert, so it shows in full), and move the main view
  // back through it (inside the insert: the breakpoint).
  const linked = (panel: { altAllele?: { linked: boolean; sourceGenome?: string } }) => Boolean(panel.altAllele?.linked && !panel.altAllele.sourceGenome);
  registerViewLink({
    toPanel: (panel, main) => (linked(panel) ? mapSpanToAlt(panel.altAllele!.layout, main) : undefined),
    toMain: (panel, next) => (linked(panel) ? mapSpanToRef(panel.altAllele!.layout, next) : undefined),
  });

  registerSplitHooks({
    preview: ALT_ALLELE_PREVIEW,
    // By an insertion's SV allele: the Carriers panel shows the insert expanded (its header toggles back).
    opened: (groupId, source) => (source.kind === 'frozen' && source.panelId ? expandSvSplitCarriers(groupId, source.panelId) : undefined),
    // Said in the split dialog before it opens (audit SV-2): the same rule as expandSvSplitCarriers.
    rowNote: (source, row) => (source.kind === 'frozen' && source.panelId && row.groupKeys.length === 1 && row.groupKeys[0] === '0'
      && svSplitExpands(source.panelId) ? 'expanded insertion, own coordinates' : null),
    // A Carriers panel shown with the insert expanded takes its alt dataset with it (Undo reopens both).
    closing: panels => {
      const alt = panels.map(p => (p.altAllele ? p.datasetId : null)).filter((id): id is string => Boolean(id));
      return alt.length ? releaseAltDatasets(alt, panels.map(p => p.id)) : null;
    },
  });

  // "Open carriers with the insert expanded" on an insertion of the SV row.
  registerReadMenuContribution({
    id: 'alt-allele',
    preview: ALT_ALLELE_PREVIEW,
    svClusterItems: sv => (sv.insertion && sv.bamReads ? [item('ext:alt-allele', 'Open carriers with the insert expanded', 'ext:insertion', {
      preview: ALT_ALLELE_PREVIEW,
      title: 'A panel of this insertion\'s carriers on its alternate allele (reference flank + insert consensus + reference flank): cluster, sort, filter and analyse the reads inside the insert like any region',
    })] : []),
    splitPanelsNote: 'an insertion\'s Carriers open with the insert expanded',
    run: (_action, ctx) => {
      const sv = ctx.svClusters.find(c => c?.t === 'I');
      if (!sv) return;
      ctx.say(`Building the alternate allele of +${sv.len.toLocaleString()} bp…`);
      void openAltAllelePanel({ datasetId: ctx.datasetId, chrom: ctx.chrom, ref: sv.ref, len: sv.len }, { afterPanelId: ctx.panelId });
    },
  });
}
