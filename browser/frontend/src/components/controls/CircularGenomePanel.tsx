import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { getChromosomes, getGenes, setCircularChrom } from '../../api/reference';
import { isPlasmidChrom, loadPlasmidFiles, pickAndOpenPlasmidDataset } from '../../utils/plasmidLoader';
import { PlasmidLinksList } from './PlasmidLinksList';
import { pickAnyFile } from '../../api/files';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell } from './shared';
import { HaplotypeComparisonSettings } from './sidebar/haplotype/HaplotypeComparisonSettings';
import type { Gene } from '../../types';
import { findChromInfo } from '../../utils/chromAliases';
import { X } from '../ui/Icons';
import { ChromosomeMap, ZoomWindowMap } from './regions/RegionMaps';
import { HaplotypePairHint } from './regions/HaplotypePairHint';
import { useHaplotypeCompareRequest } from './haplotype/haplotypeCompareRequest';
import { useRememberedState } from '../../hooks/useRememberedState';
import { RegionCatalog } from './regions/RegionCatalog';

interface Props {
  isFullView?: boolean;
}

type RegionsTab = 'catalog' | 'navigator' | 'haplotype';
const TABS: { key: RegionsTab; label: string }[] = [
  { key: 'catalog', label: 'Regions' },
  { key: 'navigator', label: 'Map' },
  { key: 'haplotype', label: 'Compare haplotypes' },
];
const MANUAL_CIRCULAR_MAX_BP = 10_000_000;
const FULL_CIRCULAR_GENE_MAP_MAX_BP = 2_000_000;
const ZOOM_WINDOW_OPTIONS = [10_000, 50_000, 100_000, 500_000, 1_000_000];

function polar(cx: number, cy: number, radius: number, angleDeg: number) {
  const angle = (angleDeg - 90) * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function intervalParts(start: number, end: number, size: number): Array<[number, number]> {
  if (size <= 0) return [];
  const s = ((start % size) + size) % size;
  const e = ((end % size) + size) % size;
  const width = Math.max(0, end - start);
  if (width >= size) return [[0, size]];
  if (s < e) return [[s, e]];
  if (s === e) return [];
  return [[s, size], [0, e]];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatBp(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mb`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)} kb`;
  return `${value} bp`;
}

function formatRegion(chrom: string, start: number, end: number) {
  return `${chrom}:${Math.round(start).toLocaleString()}-${Math.round(end).toLocaleString()}`;
}

function pt(cx: number, cy: number, radius: number, angleDeg: number) {
  const p = polar(cx, cy, radius, angleDeg);
  return `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
}

// SnapGene-style feature palette keyed by GenBank/SnapGene feature kind (biotype).
const FEATURE_STYLES: Record<string, { fill: string; text: string; label: string }> = {
  cds: { fill: '#f59e0b', text: '#b45309', label: 'CDS' },
  gene: { fill: '#f59e0b', text: '#b45309', label: 'Gene' },
  mrna: { fill: '#f59e0b', text: '#b45309', label: 'mRNA' },
  promoter: { fill: '#22c55e', text: '#15803d', label: 'Promoter' },
  terminator: { fill: '#ef4444', text: '#b91c1c', label: 'Terminator' },
  polya_signal: { fill: '#ec4899', text: '#be185d', label: 'poly(A) signal' },
  protein_bind: { fill: '#a855f7', text: '#7e22ce', label: 'Binding site' },
  primer_bind: { fill: '#06b6d4', text: '#0e7490', label: 'Primer' },
  rep_origin: { fill: '#64748b', text: '#475569', label: 'Origin' },
  rbs: { fill: '#14b8a6', text: '#0f766e', label: 'RBS' },
  ltr: { fill: '#8b5cf6', text: '#6d28d9', label: 'LTR' },
  enhancer: { fill: '#84cc16', text: '#4d7c0f', label: 'Enhancer' },
  misc_feature: { fill: '#94a3b8', text: '#475569', label: 'Feature' },
};

function featureStyle(biotype?: string | null) {
  const key = String(biotype || '').toLowerCase().replace(/[\s()]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return FEATURE_STYLES[key] || FEATURE_STYLES.misc_feature;
}

// Filled directional arrow ribbon along an arc; arrowhead points 5'->3' by strand.
function featureArrowPath(
  cx: number, cy: number, rInner: number, rOuter: number,
  startFrac: number, endFrac: number, strand: string, headFrac: number,
) {
  const span = endFrac - startFrac;
  if (span <= 0) return '';
  const rMid = (rInner + rOuter) / 2;
  const head = Math.min(headFrac, span);
  if (strand === '-') {
    const bodyStart = startFrac + head;
    const large = endFrac - bodyStart > 0.5 ? 1 : 0;
    return [
      `M ${pt(cx, cy, rOuter, bodyStart * 360)}`,
      `A ${rOuter} ${rOuter} 0 ${large} 1 ${pt(cx, cy, rOuter, endFrac * 360)}`,
      `L ${pt(cx, cy, rInner, endFrac * 360)}`,
      `A ${rInner} ${rInner} 0 ${large} 0 ${pt(cx, cy, rInner, bodyStart * 360)}`,
      `L ${pt(cx, cy, rMid, startFrac * 360)}`,
      'Z',
    ].join(' ');
  }
  const bodyEnd = endFrac - head;
  const large = bodyEnd - startFrac > 0.5 ? 1 : 0;
  return [
    `M ${pt(cx, cy, rOuter, startFrac * 360)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${pt(cx, cy, rOuter, bodyEnd * 360)}`,
    `L ${pt(cx, cy, rMid, endFrac * 360)}`,
    `L ${pt(cx, cy, rInner, bodyEnd * 360)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${pt(cx, cy, rInner, startFrac * 360)}`,
    'Z',
  ].join(' ');
}

function niceTickStep(size: number) {
  const raw = size / 8;
  if (raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * pow;
}

function truncateLabel(value: string, max = 26) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sourceLabel(source: string) {
  if (source === 'contact') return 'Hi-C';
  if (source === 'haplotype') return 'Hap';
  if (source === 'navigator') return 'View';
  return 'Manual';
}

function baseGeneId(id: string) {
  return String(id || '').replace(/:wrap-?\d+$/, '');
}

function visibleOverlap(gene: Gene, windowStart?: number, windowEnd?: number) {
  if (windowStart === undefined || windowEnd === undefined) return Math.max(0, gene.end - gene.start);
  return Math.max(0, Math.min(gene.end, windowEnd) - Math.max(gene.start, windowStart));
}

function dedupeWrappedGenes(genes: Gene[], windowStart?: number, windowEnd?: number): Gene[] {
  const byId = new Map<string, Gene>();
  for (const gene of genes) {
    const key = baseGeneId(gene.id || gene.name || '');
    const existing = byId.get(key);
    if (!existing || visibleOverlap(gene, windowStart, windowEnd) > visibleOverlap(existing, windowStart, windowEnd)) {
      byId.set(key, gene);
    }
  }
  return Array.from(byId.values());
}

export function CircularGenomePanel({ isFullView }: Props) {
  // Haplotype comparison lives here too: the Contacts panel (its other home)
  // is only on the strip once a contact map is loaded.
  // The saved-region catalog first (fb-r4-regions); the chromosome map is its own tab.
  const [activeTab, setActiveTab] = useRememberedState<RegionsTab>('circular-genome:tab', () => 'catalog');
  // A dataset's ⋯ menu asked to compare haplotypes: show that tab.
  const compareRequest = useHaplotypeCompareRequest(r => r.request);
  useEffect(() => { if (compareRequest) setActiveTab('haplotype'); }, [compareRequest, setActiveTab]);
  const {
    chrom,
    start,
    end,
    chroms,
    datasets,
    navigatorRegions,
    setChroms,
    setViewport,
    setHasFasta,
    setCurrentGenome,
    removeNavigatorRegion,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom,
    start: s.start,
    end: s.end,
    chroms: s.chroms,
    datasets: s.datasets,
    navigatorRegions: s.navigatorRegions,
    setChroms: s.setChroms,
    setViewport: s.setViewport,
    setHasFasta: s.setHasFasta,
    setCurrentGenome: s.setCurrentGenome,
    removeNavigatorRegion: s.removeNavigatorRegion,
  })));

  const [mapGenes, setMapGenes] = useState<Gene[]>([]);
  const [windowGenes, setWindowGenes] = useState<Gene[]>([]);
  const [loadStatus, setLoadStatus] = useState<string | null>(null);
  const [windowSize, setWindowSize] = useState(100_000);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const chromInfo = findChromInfo(chroms, chrom);
  const chromSize = chromInfo?.size ?? 0;
  const isCircular = Boolean(chromInfo?.circular);
  const viewWidth = Math.max(3, end - start);
  const circularToggleBlocked = !isCircular && chromSize > MANUAL_CIRCULAR_MAX_BP;
  const windowWidth = chromSize > 0 ? Math.min(chromSize, Math.max(3, windowSize)) : windowSize;
  const windowCenter = Math.round((start + end) / 2);
  const windowStart = isCircular
    ? Math.round(windowCenter - windowWidth / 2)
    : clamp(Math.round(windowCenter - windowWidth / 2), 0, Math.max(0, chromSize - windowWidth));
  const windowEnd = windowStart + windowWidth;
  // Bumped when a GTF is loaded, replaced or removed: the genes are fetched again.
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);

  useEffect(() => {
    if (!chrom || !chromSize || !isCircular || chromSize > FULL_CIRCULAR_GENE_MAP_MAX_BP) {
      setMapGenes([]);
      return;
    }
    const controller = new AbortController();
    getGenes(chrom, 0, chromSize, { signal: controller.signal })
      .then(result => setMapGenes(result.genes || []))
      .catch(err => {
        if ((err as { name?: string })?.name !== 'AbortError') setMapGenes([]);
      });
    return () => controller.abort();
  }, [chrom, chromSize, isCircular, refreshGeneration]);

  useEffect(() => {
    if (!chrom || !chromSize) {
      setWindowGenes([]);
      return;
    }
    const controller = new AbortController();
    getGenes(chrom, windowStart, windowEnd, { signal: controller.signal })
      .then(result => setWindowGenes(result.genes || []))
      .catch(err => {
        if ((err as { name?: string })?.name !== 'AbortError') setWindowGenes([]);
      });
    return () => controller.abort();
  }, [chrom, chromSize, windowStart, windowEnd, refreshGeneration]);

  const circularGenes = useMemo(() => {
    const source = dedupeWrappedGenes(mapGenes.length > 0 ? mapGenes : windowGenes);
    const byStableId = new Map<string, Gene>();
    for (const gene of source) {
      const key = baseGeneId(gene.id || gene.name || '');
      const existing = byStableId.get(key);
      if (!existing || gene.end - gene.start > existing.end - existing.start) {
        byStableId.set(key, gene);
      }
    }
    return Array.from(byStableId.values())
      .sort((a, b) => a.start - b.start)
      .slice(0, 80);
  }, [mapGenes, windowGenes]);
  const visibleWindowGenes = useMemo(
    () => dedupeWrappedGenes(windowGenes, windowStart, windowEnd),
    [windowGenes, windowStart, windowEnd],
  );

  const navigateCircularFromPoint = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!chromSize) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    const angle = (Math.atan2(y, x) * 180 / Math.PI + 450) % 360;
    const center = Math.round((angle / 360) * chromSize);
    setViewport(chrom, center - Math.round(viewWidth / 2), center + Math.round(viewWidth / 2));
  };

  const navigateCircularByKeyboard = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (!chromSize) return;
    const step = event.shiftKey ? Math.max(1, Math.round(chromSize / 12)) : Math.max(1, Math.round(viewWidth / 2));
    let center = Math.round((start + end) / 2);
    if (event.key === 'ArrowLeft') center -= step;
    else if (event.key === 'ArrowRight') center += step;
    else if (event.key === 'Home') center = 0;
    else if (event.key === 'End') center = chromSize;
    else return;
    event.preventDefault();
    setViewport(chrom, center - Math.round(viewWidth / 2), center + Math.round(viewWidth / 2));
  };

  // Centre the view at a position, keeping its width.
  const navigateTo = (center: number) => {
    if (!chromSize) return;
    const half = Math.round(viewWidth / 2);
    const c = Math.round(center);
    setViewport(chrom, isCircular ? c - half : Math.max(0, c - half), isCircular ? c + half : Math.min(chromSize, c + half));
  };

  const handleLoadPlasmid = async () => {
    const picked = await pickAnyFile();
    if (!picked.success) {
      if (picked.message && !picked.message.includes('No file selected')) setLoadStatus(picked.message);
      return;
    }
    const paths = picked.paths?.length ? picked.paths : (picked.path ? [picked.path] : []);
    if (paths.length === 0) return;
    setLoadStatus(paths.length === 1 ? 'Loading plasmid map...' : `Loading ${paths.length} plasmid maps...`);

    const result = await loadPlasmidFiles(paths);
    if (!result.success) {
      setLoadStatus(result.error || 'Failed to load plasmid map');
      return;
    }
    const first = result.loaded[0];
    const firstWarning = result.loaded.flatMap(item => item.warnings || [])[0];
    const warning = firstWarning ? ` · ${firstWarning}` : '';
    const failed = result.failed > 0 ? ` · ${result.failed} failed` : '';
    const where = result.shownAs === 'beside' ? ' · opened beside the current view' : '';
    if (result.loaded.length === 1) {
      setLoadStatus(`${first.name}: ${formatBp(first.length!)}, ${first.feature_count || 0} features${where}${failed}${warning}`);
    } else {
      const totalFeatures = result.loaded.reduce((sum, item) => sum + (item.feature_count || 0), 0);
      setLoadStatus(`Loaded ${result.loaded.length} plasmids, ${totalFeatures} features${where}${failed}${warning}`);
    }
  };

  const handleOpenPlasmidDataset = async () => {
    await pickAndOpenPlasmidDataset(setLoadStatus);
  };

  const refreshChroms = async () => {
    const chromResult = await getChromosomes();
    setChroms(chromResult.chroms);
  };

  const handleToggleCircular = async () => {
    if (!chrom || circularToggleBlocked) return;
    const result = await setCircularChrom(chrom, !isCircular);
    if (!result.success) {
      setLoadStatus(result.error || 'Failed to update circular state');
      return;
    }
    await refreshChroms();
    setLoadStatus(`${chrom} ${result.circular ? 'marked circular' : 'marked linear'}`);
  };

  const mapSize = isFullView ? 560 : 300;
  const cx = mapSize / 2;
  const cy = mapSize / 2;
  const radius = mapSize * 0.25;
  const featureInner = radius - 8;
  const featureOuter = radius + 8;
  const labelRadius = radius + 18;

  // SnapGene-style circular map geometry (features, bp ticks, leader-line labels).
  const mapDataSize = chromSize > 0 ? chromSize : 1;
  const tickStep = niceTickStep(mapDataSize);
  const circularTicks = useMemo(() => {
    const out: number[] = [];
    for (let p = 0; p < mapDataSize; p += tickStep) out.push(p);
    return out;
  }, [mapDataSize, tickStep]);
  const arrowHeadFrac = Math.min(0.035, 11 / (2 * Math.PI * Math.max(1, radius)));
  const featureGeom = useMemo(() => circularGenes
    .map(gene => {
      const sFrac = clamp(gene.start, 0, mapDataSize) / mapDataSize;
      const eFrac = clamp(gene.end, 0, mapDataSize) / mapDataSize;
      return { gene, sFrac, eFrac, midFrac: (sFrac + eFrac) / 2, style: featureStyle(gene.biotype) };
    })
    .filter(item => item.eFrac > item.sFrac),
    [circularGenes, mapDataSize]);

  const labelFont = isFullView ? 10 : 9;
  const labelItems = useMemo(() => {
    const items = featureGeom
      .filter(item => item.gene.name)
      .map(item => {
        const angle = item.midFrac * 360;
        const anchor = polar(cx, cy, labelRadius, angle);
        const edge = polar(cx, cy, featureOuter, angle);
        const side: 'left' | 'right' = anchor.x >= cx ? 'right' : 'left';
        return { ...item, angle, anchor, edge, side, labelY: anchor.y };
      });
    const minGap = labelFont + 3;
    (['left', 'right'] as const).forEach(side => {
      const col = items.filter(item => item.side === side).sort((a, b) => a.anchor.y - b.anchor.y);
      for (let i = 1; i < col.length; i++) {
        if (col[i].labelY - col[i - 1].labelY < minGap) col[i].labelY = col[i - 1].labelY + minGap;
      }
      const overflow = col.length ? col[col.length - 1].labelY - (mapSize - 4) : 0;
      if (overflow > 0) col.forEach(item => { item.labelY = Math.max(labelFont, item.labelY - overflow); });
    });
    return items;
  }, [featureGeom, cx, cy, labelRadius, featureOuter, labelFont, mapSize]);

  const selectedFeature = featureGeom.find(item => item.gene.id === selectedFeatureId)?.gene ?? null;

  const focusFeature = (gene: Gene) => {
    setSelectedFeatureId(gene.id);
    if (!chromSize) return;
    const pad = Math.max(40, Math.round((gene.end - gene.start) * 0.3));
    setViewport(chrom, gene.start - pad, gene.end + pad);
  };

  return (
    <AnalysisPanelShell
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      theme="teal"
      isFullView={isFullView}
      layout="standard"
      // The body takes the panel's height (it was capped at 400 px with its own scroll bar).
      className="flex h-full min-h-0 flex-col"
      bodyMode="fill"
      // The catalog's list scrolls inside the panel (it is windowed), so the body is a column.
      bodyClassName={activeTab === 'catalog' ? 'flex min-h-0 flex-col' : undefined}
      showTabs
      header={
        <AnalysisPanelHeader
          detail="Saved regions in categories (a dataset's amplicons, BED files, views you keep), the whole chromosome or plasmid map, and two haplotypes side by side."
          // (Not on the catalog tab: it names its own reference, which may not be the main view's.)
          meta={activeTab === 'catalog' ? undefined : chromInfo ? `${chrom} · ${formatBp(chromInfo.size)}${isCircular ? ' · circular' : ''}` : 'No chromosome active'}
          theme="teal"
        />
      }
    >
      {activeTab === 'catalog' ? (
        <RegionCatalog />
      ) : activeTab === 'haplotype' ? (
        <div className="space-y-2">
          <div className="rounded border border-teal-200 bg-teal-50 px-2.5 py-2 text-[11px] text-teal-900 dark:border-teal-800/50 dark:bg-teal-900/20 dark:text-teal-200">
            Show the same coordinates on two chromosomes (e.g. two haplotypes) side by side. Each view can show its own datasets.
          </div>
          <HaplotypeComparisonSettings embedded acceptRequests />
        </div>
      ) : (
      <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* Secondary: loading a plasmid map is an option here, not the panel's main action (also on a human chromosome). */}
        <AnalysisButton
          size="sm"
          variant="outline"
          theme="teal"
          onClick={handleLoadPlasmid}
          title="Browse for a plasmid map (.dna / .gb / .gbk / .embl / SBOL)"
          data-tour="plasmid-load"
        >
          Load plasmid map…
        </AnalysisButton>
        <AnalysisButton
          size="sm"
          variant="outline"
          theme="teal"
          onClick={handleOpenPlasmidDataset}
          title="Choose a plasmid map and the BAM file(s) aligned to it: the BAM's contig is matched to the map by sequence (any name, rotated origins too)"
          data-tour="plasmid-open-dataset"
        >
          Open plasmid dataset…
        </AnalysisButton>
        <AnalysisButton
          size="sm"
          variant="outline"
          theme="teal"
          onClick={handleToggleCircular}
          disabled={circularToggleBlocked}
          data-tour="regions-circular-toggle"
          title={circularToggleBlocked ? `Manual circular mode is limited to ${formatBp(MANUAL_CIRCULAR_MAX_BP)}` : undefined}
        >
          {isCircular ? 'Linear' : 'Circular'}
        </AnalysisButton>
      </div>
      <HaplotypePairHint chromNames={chroms.map(c => c.name)} onOpen={() => setActiveTab('haplotype')} />
      {loadStatus && <div className="text-[11px] text-ink-muted">{loadStatus}</div>}
      {chromInfo && isPlasmidChrom(chromInfo) && <PlasmidLinksList chrom={chrom} />}

      {isCircular && chromInfo ? (
        <div className="flex flex-col items-center gap-2" data-tour="regions-map">
          <svg
            width={mapSize}
            height={mapSize}
            viewBox={`0 0 ${mapSize} ${mapSize}`}
            className="h-auto max-w-full cursor-crosshair"
            role="button"
            tabIndex={0}
            aria-label={`Navigate ${chrom} circular map`}
            onClick={navigateCircularFromPoint}
            onKeyDown={navigateCircularByKeyboard}
          >
            {/* Current view highlight wedge */}
            {intervalParts(start, end, chromInfo.size).map(([partStart, partEnd], index) => {
              const ps = partStart / chromInfo.size;
              const pe = partEnd / chromInfo.size;
              const large = pe - ps > 0.5 ? 1 : 0;
              return (
                <path
                  key={`viewport-${index}`}
                  d={`M ${cx} ${cy} L ${pt(cx, cy, radius, ps * 360)} A ${radius} ${radius} 0 ${large} 1 ${pt(cx, cy, radius, pe * 360)} Z`}
                  fill="#0ea5e9"
                  fillOpacity="0.1"
                  stroke="none"
                />
              );
            })}

            {/* DNA backbone */}
            <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#9ca3af" strokeWidth="1.5" />

            {/* bp position ticks */}
            {circularTicks.map(p => {
              const angle = (p / chromInfo.size) * 360;
              const a = polar(cx, cy, radius - 3, angle);
              const b = polar(cx, cy, radius - 8, angle);
              const t = polar(cx, cy, radius - 17, angle);
              return (
                <g key={`tick-${p}`}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#cbd5e1" strokeWidth="1" />
                  <text x={t.x} y={t.y} textAnchor="middle" dominantBaseline="middle" fontSize={isFullView ? 8 : 7} fill="#9ca3af">
                    {formatBp(p)}
                  </text>
                </g>
              );
            })}

            {/* Feature arrows (color-coded by type, directional by strand) */}
            {featureGeom.map(({ gene, sFrac, eFrac, style }) => {
              const isSelected = gene.id === selectedFeatureId;
              return (
                <path
                  key={`feat-${gene.id}`}
                  d={featureArrowPath(cx, cy, featureInner, featureOuter, sFrac, eFrac, gene.strand, arrowHeadFrac)}
                  fill={style.fill}
                  fillOpacity={isSelected ? 1 : 0.9}
                  stroke={isSelected ? '#111827' : '#ffffff'}
                  strokeWidth={isSelected ? 1.25 : 0.5}
                  className="cursor-pointer"
                  onClick={event => { event.stopPropagation(); focusFeature(gene); }}
                >
                  <title>{`${gene.name || gene.id} · ${style.label} · ${gene.strand} strand\n${gene.start.toLocaleString()}–${gene.end.toLocaleString()} (${formatBp(gene.end - gene.start)})`}</title>
                </path>
              );
            })}

            {/* Leader-line labels: all in full view; the selected feature is
                always labeled so a click names it even in the docked view. */}
            {labelItems.filter(item => isFullView || item.gene.id === selectedFeatureId).map(({ gene, edge, anchor, side, labelY, style }) => {
              const labelX = side === 'right' ? mapSize - 3 : 3;
              const lineX = side === 'right' ? mapSize - 5 : 5;
              const isSelected = gene.id === selectedFeatureId;
              return (
                <g key={`label-${gene.id}`} className="cursor-pointer" onClick={event => { event.stopPropagation(); focusFeature(gene); }}>
                  <polyline
                    points={`${edge.x.toFixed(1)},${edge.y.toFixed(1)} ${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} ${lineX},${labelY.toFixed(1)}`}
                    fill="none"
                    stroke={isSelected ? '#9ca3af' : '#d1d5db'}
                    strokeWidth={isSelected ? 1 : 0.75}
                  />
                  <text
                    x={labelX}
                    y={labelY}
                    textAnchor={side === 'right' ? 'end' : 'start'}
                    dominantBaseline="middle"
                    fontSize={labelFont}
                    fontWeight={isSelected ? 700 : 400}
                    fill={style.text}
                  >
                    {truncateLabel(gene.name || gene.id)}
                  </text>
                </g>
              );
            })}

            {/* Center label */}
            <text x={cx} y={cy - 4} textAnchor="middle" fontSize={isFullView ? 14 : 11} fontWeight="600" className="fill-ink">
              {chrom}
            </text>
            <text x={cx} y={cy + (isFullView ? 13 : 10)} textAnchor="middle" fontSize={isFullView ? 11 : 9} fill="#6b7280">
              {formatBp(chromInfo.size)}
            </text>
          </svg>
          {selectedFeature && (
            <div className="flex w-full items-center justify-center gap-1.5 px-2 text-[11px]">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: featureStyle(selectedFeature.biotype).fill }}
              />
              <span className="truncate font-semibold text-gray-800">{selectedFeature.name || selectedFeature.id}</span>
              <span className="shrink-0 text-gray-500">
                {featureStyle(selectedFeature.biotype).label} · {selectedFeature.strand} · {selectedFeature.start.toLocaleString()}–{selectedFeature.end.toLocaleString()}
              </span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10"
                onClick={() => setSelectedFeatureId(null)}
                title="Clear selection"
                aria-label="Clear selection"
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2" data-tour="regions-map">
          <ChromosomeMap
            chrom={chrom}
            size={chromSize}
            viewStart={start}
            viewEnd={end}
            windowStart={windowStart}
            windowEnd={windowEnd}
            onNavigate={navigateTo}
          />
        </div>
      )}

      <section className="space-y-2 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-ink">Zoom window</div>
            <div className="text-[11px] text-ink-muted">Genes around the view. Click to move there.</div>
          </div>
          <select
            value={windowSize}
            onChange={event => setWindowSize(Number(event.target.value))}
            className="input-tool h-7 text-xs"
            data-tour="regions-zoom-window"
            aria-label="Zoom window width"
          >
            {ZOOM_WINDOW_OPTIONS.map(option => (
              <option key={option} value={option}>{formatBp(option)}</option>
            ))}
          </select>
        </div>
        {chromSize > 0 ? (
          <ZoomWindowMap
            chrom={chrom}
            windowStart={windowStart}
            windowEnd={windowEnd}
            viewStart={start}
            viewEnd={end}
            genes={visibleWindowGenes}
            maxLanes={isFullView ? 8 : 4}
            onNavigate={navigateTo}
            onFocusGene={gene => {
              const pad = Math.max(200, Math.round((gene.end - gene.start) * 0.1));
              // A circular chromosome keeps wrapped (negative) coordinates.
              setViewport(chrom, isCircular ? gene.start - pad : Math.max(0, gene.start - pad), gene.end + pad);
            }}
          />
        ) : (
          <div className="rounded-fb border border-dashed border-line px-3 py-3 text-xs text-ink-muted">No chromosome active.</div>
        )}
      </section>

      {navigatorRegions.length > 0 && (
        // Regions of open contact-map and haplotype comparisons: they come and go with those
        // views. Saved regions are in the Regions tab.
        <div className="space-y-1 border-t border-line pt-3" data-testid="comparison-regions">
          <div className="text-xs font-semibold text-ink">Comparison views</div>
          {navigatorRegions.map(region => (
            <div key={region.id} className="flex items-center gap-2 rounded-fb border border-line bg-surface px-2 py-1">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-white/10 dark:text-gray-300">{sourceLabel(region.source)}</span>
              <button type="button" className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:underline" onClick={() => setViewport(region.chrom, region.start, region.end)}
                title={formatRegion(region.chrom, region.start, region.end)}>
                {region.label} <span className="font-mono text-[11px] text-ink-muted">{formatRegion(region.chrom, region.start, region.end)}</span>
              </button>
              <button type="button" className="rounded p-0.5 text-ink-muted hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10" onClick={() => removeNavigatorRegion(region.id)} title="Remove this region" aria-label="Remove this region">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </AnalysisPanelShell>
  );
}
