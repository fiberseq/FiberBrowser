import type { FootprintGroup } from '../types';
import { sameChrom } from './chromAliases';
import type { CompactRead, AnnotationLayer } from '../components/tracks/read-track/types';

export interface TfFamilyMetadata {
  familyId: number;
  familyConfidence: number;
  confidenceKind: 'assignment' | 'cross-support' | 'latent-support' | 'unavailable';
  annotationName?: string;
}

/** Match the backend Cart contract: a minimum family-confidence threshold is
 * meaningful only for ordinary call-to-family assignments. Latent
 * configuration support uses a different producer-declared calibration and
 * must not pass an assignment threshold merely because its byte is large. */
export function passesFamilyAssignmentConfidence(
  metadata: TfFamilyMetadata | null | undefined,
  minimumConfidence: number,
): boolean {
  if (minimumConfidence <= 0) return true;
  return metadata != null
    && metadata.confidenceKind !== 'latent-support'
    && metadata.confidenceKind !== 'unavailable'
    && metadata.familyConfidence >= minimumConfidence;
}

export function tfFamilyColor(familyId: number, annotationName?: string): string {
  let namedHash: number | undefined;
  if (annotationName) {
    let hash=2166136261;
    for (const char of annotationName) hash=Math.imul(hash^char.charCodeAt(0),16777619);
    namedHash=hash>>>0;
  }
  const normalized = namedHash ?? Math.max(1, Math.min(255, Math.trunc(familyId)));
  // Golden-angle hue spacing keeps adjacent slots far apart and, unlike a
  // short fixed palette, gives every uint8 slot its own stable hex color.
  const hue = ((normalized - 1) * 137.50776405003785) % 360;
  const saturation = 64 + ((normalized * 37) % 3) * 8;
  const lightness = 40 + ((normalized * 53) % 4) * 6;
  const chroma = (1 - Math.abs(2 * lightness / 100 - 1)) * saturation / 100;
  const sector = hue / 60;
  const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
  const [r1, g1, b1] = sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
      : sector < 3 ? [0, chroma, secondary]
        : sector < 4 ? [0, secondary, chroma]
          : sector < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const offset = lightness / 100 - chroma / 2;
  return `#${[r1, g1, b1]
    .map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function tfFamilyMetadata(
  layer: AnnotationLayer | null | undefined,
  intervalIndex: number,
): TfFamilyMetadata | null {
  if (!layer?.quality_names || !layer.qualities) return null;
  const fiIndex = layer.quality_names.indexOf('fi');
  if (fiIndex < 0) return null;
  const familyId = Math.trunc(layer.qualities[fiIndex]?.[intervalIndex] ?? 0);
  if (familyId <= 0) return null;
  const annotationName = layer.annotation_names?.[intervalIndex] ?? '';
  const isCrossConsensus = annotationName.startsWith('fhxcr_');
  const confidenceIndex = isCrossConsensus
    ? layer.quality_names.indexOf('xq')
    : layer.quality_names.indexOf('fq');
  const confidenceQ = confidenceIndex >= 0
    ? (layer.qualities[confidenceIndex]?.[intervalIndex] ?? 0)
    : 0;
  return {
    familyId,
    familyConfidence: Math.max(0, Math.min(1, confidenceQ / 255)),
    ...(annotationName ? {annotationName} : {}),
    confidenceKind: layer.family_confidence_kind === 'unavailable' ? 'unavailable' : annotationName.startsWith('fhlt_')
      ? 'latent-support'
      : isCrossConsensus ? 'cross-support' : 'assignment',
  };
}

type FamilyObservation = {
  familyId: number;
  start: number;
  end: number;
  confidence: number;
  latent: boolean;
  layer: string;
  annotationName: string;
};

export type TfFamilyBoundaryMode = 'molecule' | 'both' | 'family';

export interface TfFamilyDisplayGeometry {
  groupId: string;
  mode: TfFamilyBoundaryMode;
  start: number;
  end: number;
}

export interface TfFamilyRenderGeometry {
  fillStart: number;
  fillEnd: number;
  outlineStart: number | null;
  outlineEnd: number | null;
}

export type TfFamilyDisplayIndex = Map<number, FootprintGroup[]>;

/** Resolve the visual grammar for a family-assigned molecular call.
 *
 * The compact `tf_sr` interval is the adjusted call on this molecule and
 * remains the colored block.  In the default `both` view, the frozen family
 * model is a shared outline around that block.  Consequently every member of
 * one family gets the same outline while its observed/adjusted footprint can
 * retain molecule-specific geometry.
 */
export function tfFamilyRenderGeometry(
  moleculeStart: number,
  moleculeEnd: number,
  family: TfFamilyDisplayGeometry | null,
): TfFamilyRenderGeometry {
  if (!family || family.mode === 'molecule') {
    return {
      fillStart: moleculeStart,
      fillEnd: moleculeEnd,
      outlineStart: null,
      outlineEnd: null,
    };
  }
  if (family.mode === 'family') {
    return {
      fillStart: family.start,
      fillEnd: family.end,
      outlineStart: null,
      outlineEnd: null,
    };
  }
  return {
    fillStart: moleculeStart,
    fillEnd: moleculeEnd,
    outlineStart: family.start,
    outlineEnd: family.end,
  };
}

/** Must match FiberHMM DEFAULT_FAMILY_SEPARATION_BP. */
export const TF_FAMILY_SEPARATION_BP = 24;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Build ephemeral cart entries for every BAM-native family visible in reads. */
export function discoverTfFamilyGroups(
  reads: CompactRead[],
  chrom: string,
  regionStart: number,
  datasetId: string,
  sourceViewKey: string = datasetId,
): FootprintGroup[] {
  const observations: FamilyObservation[] = [];
  for (const read of reads) {
    for (const layerName of ['tf_sr','tf_consensus','tf_cross_consensus']) {
    const layer = read.layers?.[layerName];
    if (!layer) continue;
    for (let index = 0; index < layer.intervals.length; index++) {
      const metadata = tfFamilyMetadata(layer, index);
      if (!metadata) continue;
      const interval = layer.source_intervals?.[index] ?? layer.intervals[index];
      observations.push({
        familyId: metadata.familyId,
        start: regionStart + interval[0],
        end: regionStart + interval[1],
        confidence: metadata.familyConfidence,
        latent: metadata.confidenceKind === 'latent-support',
        layer: layerName,
        annotationName: layerName==='tf_sr' ? '' : layer.annotation_names?.[index] ?? '',
      });
    }
  }

  }
  const byId = new Map<string, FamilyObservation[]>();
  for (const observation of observations) {
    const key=observation.layer+':'+(observation.annotationName || observation.familyId);
    const rows = byId.get(key) ?? [];
    rows.push(observation);
    byId.set(key, rows);
  }

  const groups: FootprintGroup[] = [];
  for (const [identity, familyRows] of [...byId.entries()].sort((a, b) => a[1][0].familyId - b[1][0].familyId)) {
    const familyId=familyRows[0].familyId;
    const layerName=familyRows[0].layer;
    const annotationName=familyRows[0].annotationName;
    const ordered = [...familyRows].sort((a, b) => a.start - b.start || a.end - b.end);
    const components: FamilyObservation[][] = [];
    // Establish locus components from ordinary assignments first. Latent
    // consumers may join a nearby component or form a latent-only component,
    // but cannot bridge two reused-ID loci into one family model.
    for (const row of ordered.filter(value => !value.latent)) {
      const current = components[components.length - 1];
      const currentEnd = current ? Math.max(...current.map(value => value.end)) : -Infinity;
      if (!current || row.start > currentEnd + TF_FAMILY_SEPARATION_BP) components.push([row]);
      else current.push(row);
    }
    for (const row of ordered.filter(value => value.latent)) {
      const candidates = components.filter(component => {
        const left = Math.min(...component.map(value => value.start));
        const right = Math.max(...component.map(value => value.end));
        return row.end >= left - TF_FAMILY_SEPARATION_BP
          && row.start <= right + TF_FAMILY_SEPARATION_BP;
      });
      if (candidates.length === 0) {
        components.push([row]);
        continue;
      }
      const rowCenter = (row.start + row.end) / 2;
      const componentCenter = (component: FamilyObservation[]) => (
        Math.min(...component.map(value => value.start))
        + Math.max(...component.map(value => value.end))
      ) / 2;
      candidates.sort((left, right) => {
        const ordinaryPenalty = (component: FamilyObservation[]) => (
          component.some(value => !value.latent) ? 0 : 1
        );
        return ordinaryPenalty(left) - ordinaryPenalty(right)
          || Math.abs(componentCenter(left) - rowCenter)
            - Math.abs(componentCenter(right) - rowCenter);
      });
      candidates[0].push(row);
    }
    components.sort((left, right) => (
      Math.min(...left.map(value => value.start))
      - Math.min(...right.map(value => value.start))
    ));
    for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
      const component = components[componentIndex];
      // Named latent calls consume an already frozen family model. Use them to
      // discover a cart entry when no ordinary assignment is visible, but
      // never let them move geometry learned from ordinary family calls.
      const ordinaryRows = component.filter(value => !value.latent);
      const geometryRows = ordinaryRows.length > 0 ? ordinaryRows : component;
      const representativeStart = median(geometryRows.map(value => value.start));
      const representativeEnd = median(geometryRows.map(value => value.end));
      const minStart = Math.min(...geometryRows.map(value => value.start));
      const maxEnd = Math.max(...geometryRows.map(value => value.end));
      const locusBin = Math.round((representativeStart + representativeEnd) / 2 / 32);
      const componentSuffix = components.length > 1 ? `.${componentIndex + 1}` : '';
      groups.push({
        id: `bam-family:${sourceViewKey}:${chrom}:${identity}:bin${locusBin}`,
        name: `F${String(familyId).padStart(3, '0')}${componentSuffix}`,
        color: tfFamilyColor(familyId,annotationName),
        layer: layerName,
        familyAnnotationName: annotationName || undefined,
        familyId,
        minFamilyConfidence: 0,
        // A latent-only viewport has no independent family boundary estimate.
        // Keep the molecule geometry until ordinary assignments establish the
        // frozen display model; the family remains available for cart filters.
        familyBoundaryMode: ordinaryRows.length > 0 ? 'both' : 'molecule',
        familyModelAbsStart: representativeStart,
        familyModelAbsEnd: representativeEnd,
        autoGeneratedFamily: true,
        sourceDatasetId: datasetId,
        sourceViewKey,
        referenceChrom: chrom,
        sizeMin: 0,
        sizeMax: null,
        referenceAbsStart: minStart,
        referenceAbsEnd: maxEnd,
        minFpCoverage: 0,
        minTargetCoverage: 0,
        overlapFraction: 0,
        // Discovery should not launch an all-by-all co-occupancy analysis.
        // The BAM-native family color remains visible; users opt families
        // into cart analytics explicitly.
        enabled: false,
        sourceIndex: -1,
        conditions: [],
      });
    }
  }
  return groups;
}

/** Pre-index family display models once per canvas render. A targeted scan can
 * contain hundreds of families and tens of thousands of calls; filtering the
 * entire Cart for every call makes navigation appear to hang. */
export function buildTfFamilyDisplayIndex(
  groups: FootprintGroup[],
  datasetId: string,
  chrom?: string,
  viewKey?: string,
): TfFamilyDisplayIndex {
  const index: TfFamilyDisplayIndex = new Map();
  for (const group of groups) {
    if (!group.autoGeneratedFamily || group.familyId == null) continue;
    if (group.sourceDatasetId && group.sourceDatasetId !== datasetId) continue;
    // Family slots are reused at other loci: a panel on another chromosome, or
    // another panel's own discovery, must not lend this call its geometry.
    if (chrom && group.referenceChrom && !sameChrom(group.referenceChrom, chrom)) continue;
    if (viewKey && group.sourceViewKey && group.sourceViewKey !== viewKey) continue;
    if (group.referenceAbsStart == null || group.referenceAbsEnd == null) continue;
    const candidates = index.get(group.familyId) ?? [];
    candidates.push(group);
    index.set(group.familyId, candidates);
  }
  return index;
}

const annotationBucketsByIndex = new WeakMap<TfFamilyDisplayIndex, Map<string, FootprintGroup[]>>();

function familyGroupsForAnnotation(index: TfFamilyDisplayIndex, annotationName: string): FootprintGroup[] {
  let buckets = annotationBucketsByIndex.get(index);
  if (!buckets) {
    buckets = new Map();
    for (const group of [...index.values()].flat()) {
      if (!group.familyAnnotationName) continue;
      const bucket = buckets.get(group.familyAnnotationName) ?? [];
      bucket.push(group);
      buckets.set(group.familyAnnotationName, bucket);
    }
    annotationBucketsByIndex.set(index, buckets);
  }
  return buckets.get(annotationName) ?? [];
}

export function tfFamilyDisplayGeometryFromIndex(
  index: TfFamilyDisplayIndex,
  familyId: number,
  callAbsStart: number,
  callAbsEnd: number,
  layerName?: string,
  familyConfidence?: number,
  annotationName?: string,
): TfFamilyDisplayGeometry | null {
  const candidates = (annotationName ? familyGroupsForAnnotation(index, annotationName) : index.get(familyId) ?? []).filter(group => {
    if (annotationName && group.familyAnnotationName !== annotationName) return false;
    if (layerName && group.layer && group.layer !== layerName) return false;
    if (
      familyConfidence != null
      && familyConfidence < (group.minFamilyConfidence ?? 0)
    ) return false;
    const hullStart = group.referenceAbsStart;
    const hullEnd = group.referenceAbsEnd;
    if (hullStart == null || hullEnd == null) return false;
    return callAbsEnd >= hullStart - TF_FAMILY_SEPARATION_BP
      && callAbsStart <= hullEnd + TF_FAMILY_SEPARATION_BP;
  });
  if (candidates.length === 0) return null;
  const callCenter = (callAbsStart + callAbsEnd) / 2;
  candidates.sort((a, b) => {
    const aCenter = ((a.familyModelAbsStart ?? a.referenceAbsStart ?? 0)
      + (a.familyModelAbsEnd ?? a.referenceAbsEnd ?? 0)) / 2;
    const bCenter = ((b.familyModelAbsStart ?? b.referenceAbsStart ?? 0)
      + (b.familyModelAbsEnd ?? b.referenceAbsEnd ?? 0)) / 2;
    return Math.abs(aCenter - callCenter) - Math.abs(bCenter - callCenter);
  });
  const match = candidates[0];
  const start = match.familyModelAbsStart ?? match.referenceAbsStart;
  const end = match.familyModelAbsEnd ?? match.referenceAbsEnd;
  if (start == null || end == null || end <= start) return null;
  const rawMode = match.familyBoundaryMode;
  const mode: TfFamilyBoundaryMode = rawMode === 'molecule' || rawMode === 'family'
    ? rawMode
    : 'both';
  return { groupId: match.id, mode, start, end };
}

/** Resolve the viewport-local model for one tagged call. Family IDs are only
 *  uint8 slots and may be reused at distant loci, so the observation hull and
 *  dataset are part of the lookup rather than treating `fi` as a global ID. */
export function tfFamilyDisplayGeometry(
  groups: FootprintGroup[],
  datasetId: string,
  familyId: number,
  callAbsStart: number,
  callAbsEnd: number,
  layerName?: string,
  familyConfidence?: number,
  annotationName?: string,
  chrom?: string,
  viewKey?: string,
): TfFamilyDisplayGeometry | null {
  return tfFamilyDisplayGeometryFromIndex(
    buildTfFamilyDisplayIndex(groups, datasetId, chrom, viewKey),
    familyId,
    callAbsStart,
    callAbsEnd,
    layerName,
    familyConfidence,
    annotationName,
  );
}
