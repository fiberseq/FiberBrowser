import type { AnalysisFilterMetric, AnalysisFilterOperator, AnalysisFilterRule, AnalysisFilterRuleSet, AnalysisSortMetric, AnalysisSortRule, AnalysisSortRuleSet, Bookmark, ClusterFeatureRule, ClusterFeatureRuleSet, ClusterFeatureRuleTerm, Colormap, ColorRule, FirePeak, FootprintGroup, Gene, PeakMode, QualityGate, ReadStateInfo, SelectedFootprint, SubTrackConfig, SubTrackType, TranscriptionStateFilters } from '../types';
import { buildAnalysisFilterRuleAutoName, buildAnalysisSortRuleAutoName, buildClusterFeatureRuleAutoName, isRemovedTranscriptionStateTerm, normalizeAnalysisRuleScope, normalizeTranscriptionStateRuleKind } from '../utils/analysisRules';
import type { ReadFilterSource } from './clusterSlice';
import { DEFAULT_COLORMAP } from '../types';
import { FRONTEND_DIAGNOSTICS } from '../utils/diagnostics';
import { normalizeAnnotationLayer, normalizeLayerList, normalizeQualityFilterLayers } from '../utils/layerAliases';
import { normalizeRuleColorVisuals } from '../utils/ruleColors';
import { isKnownTrackType, placedTrackKinds } from '../components/tracks/trackRegistry';

// Debug flag — opt-in only, even in local dev builds.
export const DEBUG = FRONTEND_DIAGNOSTICS;

// ============================================================
// LocalStorage Keys
// ============================================================

export const BOOKMARKS_STORAGE_KEY = 'fiberhmm_bookmarks';
export const COLORMAPS_STORAGE_KEY = 'fiberhmm_colormaps';
export const DEFAULT_COLORMAP_STORAGE_KEY = 'fiberhmm_default_colormap';
export const CLUSTER_FEATURE_RULESETS_STORAGE_KEY = 'fiberhmm_cluster_feature_rule_sets';
export const DEFAULT_CLUSTER_FEATURE_RULESET_STORAGE_KEY = 'fiberhmm_default_cluster_feature_rule_set';
export const ANALYSIS_SORT_RULESETS_STORAGE_KEY = 'fiberhmm_analysis_sort_rule_sets';
export const DEFAULT_ANALYSIS_SORT_RULESET_STORAGE_KEY = 'fiberhmm_default_analysis_sort_rule_set';
export const ANALYSIS_FILTER_RULESETS_STORAGE_KEY = 'fiberhmm_analysis_filter_rule_sets';
export const DEFAULT_ANALYSIS_FILTER_RULESET_STORAGE_KEY = 'fiberhmm_default_analysis_filter_rule_set';
export const LAST_GENOME_STORAGE_KEY = 'fiberhmm_last_genome';
/** Path of the most-recently-loaded local FASTA. Persisted so the App can
 *  restore a user's manually-loaded reference on next page load instead of
 *  falling back to the hg38 default. */
export const LAST_FASTA_PATH_STORAGE_KEY = 'fiberhmm_last_fasta_path';
export const SIDEBAR_WIDTH_STORAGE_KEY = 'fiberhmm_sidebar_width';
/** Settings sidebar width: wide enough that every control fits on its row (or wraps), never clips. */
export const SIDEBAR_MIN_WIDTH = 300;
export const SIDEBAR_DEFAULT_WIDTH = 340;
export const SIDEBAR_MAX_WIDTH = 560;
/** Older builds: the accordion's open sections (migrated by loadActiveSection). */
export const SIDEBAR_SECTIONS_STORAGE_KEY = 'fiberhmm_sidebar_sections';
export const FOOTPRINT_GROUPS_STORAGE_KEY = 'fiberhmm_footprint_groups';

/** The settings sidebar's pages, in rail order (utils/settingsCatalog SIDEBAR_SECTIONS). */
export const SIDEBAR_SECTION_IDS = ['file', 'genome', 'view', 'analysis'] as const;
export const DEFAULT_SIDEBAR_SECTION = 'file';
/** The settings page shown last (the sidebar shows one section at a time). */
export const SIDEBAR_ACTIVE_SECTION_STORAGE_KEY = 'fiberhmm_sidebar_active_section';

// ============================================================
// Bookmark helpers
// ============================================================

export function loadBookmarksFromStorage(): Bookmark[] {
  try {
    const stored = localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function saveBookmarksToStorage(bookmarks: Bookmark[]): void {
  try {
    localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
  } catch (e) {
    console.error('Failed to save bookmarks:', e);
  }
}

// ============================================================
// Colormap helpers
// ============================================================

/** Fill in defaults for labeling presets saved before the quality/TF integration.
 *  Strips obsolete fields from legacy saved colormaps. */
export function migrateColormap(c: Partial<Colormap> | null | undefined): Colormap {
  if (!c || !Array.isArray(c.rules)) return DEFAULT_COLORMAP;
  const { mqGradient: _obsolete, ...rest } = c as Partial<Colormap> & { mqGradient?: unknown };
  const rules = c.rules;
  const normalizeOpacity = (value: unknown): number => {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 1));
  };
  const normalizeHexColor = (value: unknown, fallback: string): string => (
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
  );
  const smoothing = {
    ...DEFAULT_COLORMAP.displaySmoothing,
    ...(rest.displaySmoothing ?? {}),
  };
  const displaySmoothing = {
    enabled: smoothing.enabled === true,
    sigmaX: Math.max(0, Math.min(10, Number(smoothing.sigmaX) || 0)),
    sigmaY: Math.max(0, Math.min(10, Number(smoothing.sigmaY) || 0)),
  };
  const edgeRaw = {
    ...DEFAULT_COLORMAP.edgeAmbiguity,
    ...(rest.edgeAmbiguity ?? {}),
  };
  const edgeAmbiguity = {
    mode: (['soft', 'strict', 'loose'] as const).includes(edgeRaw.mode as 'soft' | 'strict' | 'loose')
      ? (edgeRaw.mode as 'soft' | 'strict' | 'loose')
      : DEFAULT_COLORMAP.edgeAmbiguity.mode,
    applyNuc: edgeRaw.applyNuc !== false,
    applyTf: edgeRaw.applyTf !== false,
    // Finite check (not `|| default`) so a saved 0 round-trips instead of snapping to 30.
    maxGapBp: Number.isFinite(Number(edgeRaw.maxGapBp))
      ? Math.max(0, Math.min(500, Number(edgeRaw.maxGapBp)))
      : DEFAULT_COLORMAP.edgeAmbiguity.maxGapBp,
  };
  const normalizeOpacityMap = (
    defaults: Record<string, number>,
    raw: unknown,
  ): Record<string, number> => Object.entries({
    ...defaults,
    ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}),
  }).reduce<Record<string, number>>((acc, [layer, value]) => {
    const key = normalizeAnnotationLayer(layer) ?? layer;
    const numeric = typeof value === 'number' ? value : Number(value);
    acc[key] = Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 1));
    return acc;
  }, {});
  const layerOpacities = normalizeOpacityMap(DEFAULT_COLORMAP.layerOpacities, rest.layerOpacities);
  const layerBackgroundOpacities = normalizeOpacityMap(
    DEFAULT_COLORMAP.layerBackgroundOpacities,
    (rest as Partial<Colormap> & { layerBackgroundOpacities?: unknown }).layerBackgroundOpacities,
  );
  const noReadBackgroundColor = normalizeHexColor(
    rest.noReadBackgroundColor,
    normalizeHexColor(
      rest.backgroundColor,
      DEFAULT_COLORMAP.noReadBackgroundColor ?? DEFAULT_COLORMAP.backgroundColor ?? '#ffffff'
    )
  );
  const readBackgroundColor = normalizeHexColor(
    rest.readBackgroundColor,
    DEFAULT_COLORMAP.readBackgroundColor ?? '#f1f5f9'
  );
  return {
    ...rest,
    name: rest.name ?? DEFAULT_COLORMAP.name,
    backgroundColor: noReadBackgroundColor,
    readBackgroundColor,
    noReadBackgroundColor,
    qualityShading: rest.qualityShading ?? DEFAULT_COLORMAP.qualityShading,
    tfOverlay: rest.tfOverlay ?? DEFAULT_COLORMAP.tfOverlay,
    layerOpacities,
    layerBackgroundOpacities,
    displaySmoothing,
    edgeAmbiguity,
    qualityFilters: normalizeQualityFilterLayers(rest.qualityFilters ?? DEFAULT_COLORMAP.qualityFilters),
    rules: rules.map(r => ({
      ...r,
      ...normalizeRuleColorVisuals(r as Partial<ColorRule> & Record<string, unknown>),
      opacity: normalizeOpacity(r.opacity),
      targetLayers: normalizeLayerList(r.targetLayers ?? []),
      conditions: r.conditions ?? [],
      qualityGates: r.qualityGates ?? [],
    })),
  };
}

export function loadColormapsFromStorage(): Colormap[] {
  try {
    const stored = localStorage.getItem(COLORMAPS_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Colormap[]).map(migrateColormap) : [];
  } catch {
    return [];
  }
}

export function saveColormapsToStorage(colormaps: Colormap[]): void {
  try {
    localStorage.setItem(COLORMAPS_STORAGE_KEY, JSON.stringify(colormaps));
  } catch (e) {
    console.error('Failed to save colormaps:', e);
  }
}

// ============================================================
// Footprint cart helpers
// ============================================================

/** Persistent cart of FootprintGroup entries — survives navigation, reload,
 *  and exports/imports with the session. Each entry drives read coloring,
 *  occupancy filtering, and per-entry analytics. */
export function loadFootprintGroupsFromStorage(): FootprintGroup[] {
  try {
    const stored = localStorage.getItem(FOOTPRINT_GROUPS_STORAGE_KEY);
    return stored ? normalizeFootprintGroups(JSON.parse(stored)) : [];
  } catch {
    return [];
  }
}

export function normalizeFootprintGroups(groups: unknown): FootprintGroup[] {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((group): group is FootprintGroup => !!group && typeof group === 'object')
    // Frozen catalogs from the retired targeted scanner were scoped by fields
    // that no longer exist; kept, they would color other datasets/chromosomes.
    .filter(group => {
      const legacy = group as unknown as Record<string, unknown>;
      return legacy.familyCatalogFrozen !== true && !String(legacy.sourceViewKey ?? '').startsWith('targeted-scan:');
    })
    .map(group => {
      const rawFamilyId = group.familyId == null ? null : Number(group.familyId);
      return {
        ...group,
        layer: normalizeAnnotationLayer(group.layer),
        familyId: rawFamilyId == null || !Number.isFinite(rawFamilyId)
          ? null
          : Math.max(0, Math.min(255, Math.trunc(rawFamilyId))),
        ...(group.consensusStateId == null ? {} : { consensusStateId: String(group.consensusStateId) }),
        ...(group.consensusJobId == null ? {} : { consensusJobId: String(group.consensusJobId) }),
        ...(group.consensusStrand === 'CT' || group.consensusStrand === 'GA' ? { consensusStrand: group.consensusStrand } : {}),
        // A saved class counts what it was saved to count; a missing tier is strict ('core'), stored explicitly.
        ...(typeof group.consensusTier === 'string' && group.consensusTier
          ? { consensusTier: group.consensusTier }
          : group.savedClass ? { consensusTier: 'core' } : {}),
        minFamilyConfidence: Math.max(
          0,
          Math.min(1, Number(group.minFamilyConfidence ?? 0) || 0),
        ),
        familyBoundaryMode: (
          group.familyBoundaryMode === 'molecule' || group.familyBoundaryMode === 'family'
            ? group.familyBoundaryMode
            : 'both'
        ),
        familyModelAbsStart: group.familyModelAbsStart == null
          ? null
          : Number(group.familyModelAbsStart),
        familyModelAbsEnd: group.familyModelAbsEnd == null
          ? null
          : Number(group.familyModelAbsEnd),
        autoGeneratedFamily: group.autoGeneratedFamily === true,
        sourceDatasetId: group.sourceDatasetId == null
          ? null
          : String(group.sourceDatasetId),
        sourceViewKey: group.sourceViewKey == null
          ? null
          : String(group.sourceViewKey),
      };
    });
}

export function saveFootprintGroupsToStorage(groups: FootprintGroup[]): void {
  try {
    // BAM-derived groups describe only the currently fetched viewport. Keep
    // them live in the store, but persist only user-created/pinned rules.
    const persistentGroups = groups.filter(group => !group.autoGeneratedFamily);
    localStorage.setItem(FOOTPRINT_GROUPS_STORAGE_KEY, JSON.stringify(persistentGroups));
  } catch (e) {
    console.error('Failed to save footprint groups:', e);
  }
}

// ============================================================
// Cluster feature rule helpers
// ============================================================

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeQualityGates(value: unknown): QualityGate[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((gate): gate is Record<string, unknown> => !!gate && typeof gate === 'object')
    .map(gate => ({
      qualityName: String(gate.qualityName ?? gate.quality_name ?? 'aq'),
      minValue: Math.max(0, Math.min(255, Number(gate.minValue ?? gate.min_value ?? 0) || 0)),
      ...((gate.maxValue ?? gate.max_value) != null
        ? { maxValue: Math.max(0, Math.min(255, Number(gate.maxValue ?? gate.max_value) || 0)) }
        : {}),
    }));
}

function normalizeColorRuleSnapshot(rule: unknown): ColorRule | undefined {
  if (!rule || typeof rule !== 'object') return undefined;
  const raw = rule as Partial<ColorRule> & Record<string, unknown>;
  const visual = normalizeRuleColorVisuals(raw);
  return {
    id: String(raw.id ?? uid('label')),
    name: String(raw.name ?? 'Label rule'),
    ...visual,
    opacity: Math.max(0, Math.min(1, Number(raw.opacity ?? 1) || 1)),
    sizeMin: Math.max(0, Number(raw.sizeMin ?? raw.size_min ?? 0) || 0),
    sizeMax: (raw.sizeMax ?? raw.size_max) == null ? null : Math.max(0, Number(raw.sizeMax ?? raw.size_max) || 0),
    targetLayers: normalizeLayerList(raw.targetLayers ?? raw.target_layers ?? []),
    conditions: Array.isArray(raw.conditions) ? raw.conditions as any : [],
    qualityGates: normalizeQualityGates(raw.qualityGates ?? raw.quality_gates),
    requireAnnotationName: raw.requireAnnotationName === true || raw.require_annotation_name === true,
    enabled: raw.enabled !== false,
  };
}

/** Drop saved rules that use a removed Pol II state (legacy `hyperburst`)
 *  rather than silently remapping them to a different state. */
function withoutRemovedTranscriptionStateRules(
  rules: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rules.filter(rule => !(
    Array.isArray(rule.terms) && rule.terms.some(isRemovedTranscriptionStateTerm)
  ));
}

/** Keep only the current transcription-state filter keys; drops legacy keys
 *  such as `hyperburst` from old sessions, autosaves and Jupyter updates. */
export function normalizeTranscriptionStateFilters(filters: unknown): TranscriptionStateFilters {
  const raw = filters && typeof filters === 'object' ? filters as Record<string, unknown> : {};
  const count = (value: unknown): number | null => {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  return {
    pause: raw.pause === true,
    pic: raw.pic === true,
    elongating: count(raw.elongating),
    elongating_max: count(raw.elongating_max),
  };
}

function normalizeClusterFeatureTerm(term: unknown, idx: number): ClusterFeatureRuleTerm | null {
  if (!term || typeof term !== 'object') return null;
  const raw = term as Partial<ClusterFeatureRuleTerm> & Record<string, unknown>;
  const source = raw.source === 'label_rule' || raw.source === 'footprint_group' || raw.source === 'footprint_class' || raw.source === 'transcription_state'
    ? raw.source
    : 'layer';
  const rawLayer = raw.layer ?? raw.source_layer;
  const layer = rawLayer == null || rawLayer === 'primary' || rawLayer === 'footprint'
    ? null
    : normalizeAnnotationLayer(rawLayer) ?? String(rawLayer);
  const sizeMin = Math.max(0, Number(raw.sizeMin ?? raw.size_min ?? 0) || 0);
  const rawSizeMax = raw.sizeMax ?? raw.size_max;
  const sizeMax = rawSizeMax == null || rawSizeMax === '' ? null : Math.max(0, Number(rawSizeMax) || 0);
  const rule = normalizeColorRuleSnapshot(raw.rule);
  const group = raw.group && typeof raw.group === 'object'
    ? normalizeFootprintGroups([raw.group])[0]
    : undefined;

  return {
    id: String(raw.id ?? uid(`term${idx + 1}`)),
    source,
    layer,
    sizeMin,
    sizeMax,
    qualityGates: normalizeQualityGates(raw.qualityGates ?? raw.quality_gates),
    ...(raw.labelRuleId || raw.label_rule_id ? { labelRuleId: String(raw.labelRuleId ?? raw.label_rule_id) } : {}),
    ...(raw.labelRuleName || raw.label_rule_name ? { labelRuleName: String(raw.labelRuleName ?? raw.label_rule_name) } : {}),
    ...(rule ? { rule } : {}),
    ...(raw.footprintGroupId || raw.footprint_group_id ? { footprintGroupId: String(raw.footprintGroupId ?? raw.footprint_group_id) } : {}),
    ...(raw.footprintGroupName || raw.footprint_group_name ? { footprintGroupName: String(raw.footprintGroupName ?? raw.footprint_group_name) } : {}),
    ...(group ? { group } : {}),
    ...(source === 'transcription_state' ? { transcriptionState: normalizeTranscriptionStateRuleKind(raw.transcriptionState ?? raw.transcription_state) } : {}),
  };
}

export function normalizeClusterFeatureRules(rules: unknown): ClusterFeatureRule[] {
  if (!Array.isArray(rules)) return [];
  return withoutRemovedTranscriptionStateRules(rules
    .filter((rule): rule is Record<string, unknown> => !!rule && typeof rule === 'object'))
    .map((rule, idx) => {
      const terms = Array.isArray(rule.terms)
        ? rule.terms.map((term, termIdx) => normalizeClusterFeatureTerm(term, termIdx)).filter(Boolean) as ClusterFeatureRuleTerm[]
        : [];
      const scope = normalizeAnalysisRuleScope(rule.scope);
      const autoName = String(rule.autoName ?? buildClusterFeatureRuleAutoName({ terms, scope }));
      const rawName = typeof rule.name === 'string' ? rule.name : '';
      const nameEdited = typeof rule.nameEdited === 'boolean'
        ? rule.nameEdited
        : rawName.trim().length > 0 && rawName !== autoName;
      return {
        id: String(rule.id ?? uid(`cluster_rule${idx + 1}`)),
        name: rawName.trim() || autoName || `Cluster rule ${idx + 1}`,
        autoName,
        nameEdited,
        enabled: rule.enabled !== false,
        scope,
        terms,
      };
    });
}

export function loadClusterFeatureRuleSetsFromStorage(): ClusterFeatureRuleSet[] {
  try {
    const stored = localStorage.getItem(CLUSTER_FEATURE_RULESETS_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map(entry => ({
        name: String(entry.name ?? 'Cluster feature rules'),
        savedAt: typeof entry.savedAt === 'number' ? entry.savedAt : Date.now(),
        rules: normalizeClusterFeatureRules(entry.rules),
      }));
  } catch {
    return [];
  }
}

export function saveClusterFeatureRuleSetsToStorage(ruleSets: ClusterFeatureRuleSet[]): void {
  try {
    localStorage.setItem(CLUSTER_FEATURE_RULESETS_STORAGE_KEY, JSON.stringify(ruleSets));
  } catch (e) {
    console.error('Failed to save cluster feature rule sets:', e);
  }
}

export function loadDefaultClusterFeatureRuleSetName(): string | null {
  try {
    return localStorage.getItem(DEFAULT_CLUSTER_FEATURE_RULESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getInitialClusterFeatureRules(): ClusterFeatureRule[] {
  const defaultName = loadDefaultClusterFeatureRuleSetName();
  if (!defaultName) return [];
  const saved = loadClusterFeatureRuleSetsFromStorage();
  return saved.find(set => set.name === defaultName)?.rules ?? [];
}

function normalizeAnalysisSortMetric(metric: unknown): AnalysisSortMetric {
  return metric === 'occupancy' || metric === 'rate' || metric === 'accessibility' ? metric : 'count';
}

export function normalizeAnalysisSortRules(rules: unknown): AnalysisSortRule[] {
  if (!Array.isArray(rules)) return [];
  return withoutRemovedTranscriptionStateRules(rules
    .filter((rule): rule is Record<string, unknown> => !!rule && typeof rule === 'object'))
    .map((rule, idx) => {
      const terms = Array.isArray(rule.terms)
        ? rule.terms.map((term, termIdx) => normalizeClusterFeatureTerm(term, termIdx)).filter(Boolean) as ClusterFeatureRuleTerm[]
        : [];
      const scope = normalizeAnalysisRuleScope(rule.scope);
      const metric = normalizeAnalysisSortMetric(rule.metric);
      const descending = rule.descending !== false;
      const autoName = String(rule.autoName ?? buildAnalysisSortRuleAutoName({ terms, scope, metric, descending }));
      const rawName = typeof rule.name === 'string' ? rule.name : '';
      const nameEdited = typeof rule.nameEdited === 'boolean'
        ? rule.nameEdited
        : rawName.trim().length > 0 && rawName !== autoName;
      return {
        id: String(rule.id ?? uid(`sort_rule${idx + 1}`)),
        name: rawName.trim() || autoName || `Sort rule ${idx + 1}`,
        autoName,
        nameEdited,
        enabled: rule.enabled !== false,
        scope,
        terms,
        metric,
        descending,
      };
    });
}

export function loadAnalysisSortRuleSetsFromStorage(): AnalysisSortRuleSet[] {
  try {
    const stored = localStorage.getItem(ANALYSIS_SORT_RULESETS_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map(entry => ({
        name: String(entry.name ?? 'Sort rules'),
        savedAt: typeof entry.savedAt === 'number' ? entry.savedAt : Date.now(),
        rules: normalizeAnalysisSortRules(entry.rules),
      }));
  } catch {
    return [];
  }
}

export function saveAnalysisSortRuleSetsToStorage(ruleSets: AnalysisSortRuleSet[]): void {
  try {
    localStorage.setItem(ANALYSIS_SORT_RULESETS_STORAGE_KEY, JSON.stringify(ruleSets));
  } catch (e) {
    console.error('Failed to save analysis sort rule sets:', e);
  }
}

export function loadDefaultAnalysisSortRuleSetName(): string | null {
  try {
    return localStorage.getItem(DEFAULT_ANALYSIS_SORT_RULESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getInitialAnalysisSortRules(): AnalysisSortRule[] {
  const defaultName = loadDefaultAnalysisSortRuleSetName();
  if (!defaultName) return [];
  const saved = loadAnalysisSortRuleSetsFromStorage();
  return saved.find(set => set.name === defaultName)?.rules ?? [];
}

function normalizeAnalysisFilterMetric(metric: unknown): AnalysisFilterMetric {
  return metric === 'occupancy' || metric === 'rate' || metric === 'accessibility' ? metric : 'count';
}

function normalizeAnalysisFilterOperator(operator: unknown): AnalysisFilterOperator {
  if (operator === 'gt' || operator === 'lt' || operator === 'lte' || operator === 'eq') return operator;
  return 'gte';
}

export function normalizeAnalysisFilterRules(rules: unknown): AnalysisFilterRule[] {
  if (!Array.isArray(rules)) return [];
  return withoutRemovedTranscriptionStateRules(rules
    .filter((rule): rule is Record<string, unknown> => !!rule && typeof rule === 'object'))
    .map((rule, idx) => {
      const terms = Array.isArray(rule.terms)
        ? rule.terms.map((term, termIdx) => normalizeClusterFeatureTerm(term, termIdx)).filter(Boolean) as ClusterFeatureRuleTerm[]
        : [];
      const scope = normalizeAnalysisRuleScope(rule.scope);
      const metric = normalizeAnalysisFilterMetric(rule.metric);
      const operator = normalizeAnalysisFilterOperator(rule.operator);
      const threshold = Number.isFinite(Number(rule.threshold)) ? Number(rule.threshold) : 1;
      const autoName = String(rule.autoName ?? buildAnalysisFilterRuleAutoName({ terms, scope, metric, operator, threshold }));
      const rawName = typeof rule.name === 'string' ? rule.name : '';
      const nameEdited = typeof rule.nameEdited === 'boolean'
        ? rule.nameEdited
        : rawName.trim().length > 0 && rawName !== autoName;
      return {
        id: String(rule.id ?? uid(`filter_rule${idx + 1}`)),
        name: rawName.trim() || autoName || `Filter rule ${idx + 1}`,
        autoName,
        nameEdited,
        enabled: rule.enabled !== false,
        scope,
        terms,
        metric,
        operator,
        threshold,
      };
    });
}

export function loadAnalysisFilterRuleSetsFromStorage(): AnalysisFilterRuleSet[] {
  try {
    const stored = localStorage.getItem(ANALYSIS_FILTER_RULESETS_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map(entry => ({
        name: String(entry.name ?? 'Filter rules'),
        savedAt: typeof entry.savedAt === 'number' ? entry.savedAt : Date.now(),
        rules: normalizeAnalysisFilterRules(entry.rules),
      }));
  } catch {
    return [];
  }
}

export function saveAnalysisFilterRuleSetsToStorage(ruleSets: AnalysisFilterRuleSet[]): void {
  try {
    localStorage.setItem(ANALYSIS_FILTER_RULESETS_STORAGE_KEY, JSON.stringify(ruleSets));
  } catch (e) {
    console.error('Failed to save analysis filter rule sets:', e);
  }
}

export function loadDefaultAnalysisFilterRuleSetName(): string | null {
  try {
    return localStorage.getItem(DEFAULT_ANALYSIS_FILTER_RULESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getInitialAnalysisFilterRules(): AnalysisFilterRule[] {
  const defaultName = loadDefaultAnalysisFilterRuleSetName();
  if (!defaultName) return [];
  const saved = loadAnalysisFilterRuleSetsFromStorage();
  return saved.find(set => set.name === defaultName)?.rules ?? [];
}

export function loadDefaultColormapName(): string | null {
  try {
    return localStorage.getItem(DEFAULT_COLORMAP_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getInitialColormap(): Colormap {
  const defaultName = loadDefaultColormapName();
  if (defaultName) {
    const saved = loadColormapsFromStorage();  // already migrated
    const found = saved.find(c => c.name === defaultName);
    if (found) return found;
  }
  return DEFAULT_COLORMAP;
}

// ============================================================
// Sidebar helpers
// ============================================================

export function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored) {
      const w = parseInt(stored, 10);
      if (!isNaN(w) && w >= SIDEBAR_MIN_WIDTH && w <= SIDEBAR_MAX_WIDTH) return w;
    }
  } catch {}
  return SIDEBAR_DEFAULT_WIDTH;
}

/**
 * A settings page id from anything older state may hold: the id itself, an
 * older id ('datasets', 'data'), or the accordion's list of open sections
 * (its first page). Null when there is none.
 */
export function coerceSidebarSection(value: unknown): string | null {
  const OLD_TO_NEW: Record<string, string> = { datasets: 'file', data: 'file' };
  const list = Array.isArray(value) ? value : value instanceof Set ? [...value] : [value];
  for (const id of list) {
    if (typeof id !== 'string') continue;
    const next = OLD_TO_NEW[id] ?? id;
    if ((SIDEBAR_SECTION_IDS as readonly string[]).includes(next)) return next;
  }
  return null;
}

/** The settings page shown last; older storage (the accordion's open sections) is migrated. */
export function loadActiveSection(): string {
  try {
    const stored = localStorage.getItem(SIDEBAR_ACTIVE_SECTION_STORAGE_KEY);
    const current = coerceSidebarSection(stored);
    if (current) return current;
    const legacy = localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY);
    if (legacy) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(legacy); } catch { /* garbage: the default */ }
      const migrated = coerceSidebarSection(parsed) ?? DEFAULT_SIDEBAR_SECTION;
      try {
        localStorage.setItem(SIDEBAR_ACTIVE_SECTION_STORAGE_KEY, migrated);
        localStorage.removeItem(SIDEBAR_SECTIONS_STORAGE_KEY);
      } catch {}
      return migrated;
    }
  } catch {}
  return DEFAULT_SIDEBAR_SECTION;
}

// ============================================================
// Transient state clearing — canonical set of fields to reset on navigation
// ============================================================

/**
 * Returns the full set of transient fields that should be cleared on viewport
 * navigation (goBack/goForward/bookmark/chromosome change). This is the single
 * source of truth so every reset path stays consistent.
 */
export function makeCleanTransientState() {
  return {
    selectedPeaks: new Set<number>(),
    peakModes: {} as Record<number, PeakMode>,
    peakDrawMode: false,
    peakDrawStart: null as number | null,
    peaksByRule: {} as Record<string, FirePeak[]>,
    peakSignalCache: {} as Record<string, number[]>,
    correspondenceScans: {},
    peaksLocked: false,
    clusterAssignments: {} as Record<string, Record<string, number>>,
    clusterOrder: {} as Record<string, number[]>,
    selectedClusters: {} as Record<string, Set<number>>,
    clusterPatterns: {} as Record<number, number[]>,
    clusterPeakRegions: [] as Array<{ start: number; end: number; mode?: string }>,
    dynamicClustering: false,
    clusterTreeNodes: {},
    clusterTreeRootIds: [] as string[],
    activeClusterTreeNodeId: null as string | null,
    readSortOrder: {} as Record<string, string[]>,
    clusterProfiles: {} as Record<string, Record<number, Record<string, number[]>>>,
    filteredReadIds: {} as Record<string, Set<string> | null>,
    readFilterSources: {} as Record<string, ReadFilterSource | null>,
    clusterFocus: {} as Record<string, Set<number> | null>,
    selectedGenes: [] as Gene[],
    readStateDetails: {} as Record<string, Record<string, ReadStateInfo>>,
    selectedFootprints: [] as SelectedFootprint[],
    footprintGroups: [] as FootprintGroup[],
    selectedReadIds: {} as Record<string, Set<string>>,
    transcriptionStateFilters: {
      pause: false,
      pic: false,
      elongating: null as number | null,
      elongating_max: null as number | null,
    },
    showRelativeCoords: false,
    relativeTSS: null as number | null,
    relativeGene: null as Gene | null,
  };
}

// ============================================================
// Panel helpers
// ============================================================

let panelIdCounter = 0;
export function generatePanelId(): string {
  return `panel-${Date.now()}-${panelIdCounter++}`;
}

export function createDefaultSubTracks(
  _orthogonalTracks: { index: number }[] = [],
  compositeTracks: { id: string }[] = [],
): SubTrackConfig[] {
  // The legacy `meta` slot is gone — the seeded default metaprofile lives in
  // the cart as a CompositeTrack and projects itself into panel subTracks
  // via syncPanelsForComposites. Keeping a `meta` slot here would
  // double-render alongside the composite.
  return placePluginTracks([
    { type: 'axis', visible: true },
    { type: 'fire', visible: true },
    { type: 'consensus', visible: true },
    { type: 'microc', visible: true },
    { type: 'coacc', visible: true },
    ...compositeTracks.map(c => ({ type: `composite-${c.id}` as SubTrackType, visible: true })),
    { type: 'capture', visible: true },
    { type: 'primer', visible: true },
    { type: 'sv', visible: true },
    { type: 'coverage', visible: true },
    { type: 'reads', visible: true },
    { type: 'sequence', visible: true },
    { type: 'gene', visible: true },
  ]);
}

/**
 * The rows plugin packs add (trackRegistry `defaultPlacement`), each where its rule puts it, in a panel that lacks
 * them (a new panel, or one from a session saved before the row, or without the pack).
 */
export function placePluginTracks(subTracks: SubTrackConfig[]): SubTrackConfig[] {
  const result = [...subTracks];
  for (const def of placedTrackKinds()) {
    const place = def.defaultPlacement!;
    if (result.some(st => st.type === def.type)) continue;
    if (place.requires && !result.some(st => st.type === place.requires)) continue;
    const track = { type: def.type as SubTrackType, visible: true };
    const after = (place.after ?? []).map(a => result.findIndex(st => st.type === a)).find(i => i >= 0);
    if (after !== undefined) { result.splice(after + 1, 0, track); continue; }
    insertBefore(result, track, (place.before ?? []) as SubTrackType[]);
  }
  return result;
}

/** A panel's rows without those of plugin packs this build doesn't have (a session from a build with them). */
export function dropUnknownTracks(subTracks: SubTrackConfig[]): SubTrackConfig[] {
  return subTracks.filter(st => !st || typeof st.type !== 'string' || isKnownTrackType(st.type));
}

/** Sub-tracks for genome-only mode (no dataset loaded). */
export function createGenomeSubTracks(
  _orthogonalTracks: { index: number }[] = [],
  compositeTracks: { id: string }[] = [],
): SubTrackConfig[] {
  return [
    { type: 'axis', visible: true },
    { type: 'fire', visible: true },
    ...compositeTracks.map(c => ({ type: `composite-${c.id}` as SubTrackType, visible: true })),
    { type: 'capture', visible: true },
    { type: 'primer', visible: true },
    { type: 'sequence', visible: true },
    { type: 'gene', visible: true },
  ];
}

/** Ensure all built-in sub-track types exist in a panel's subTracks array. */
export function ensureBuiltinSubTracks(subTracks: SubTrackConfig[]): SubTrackConfig[] {
  const existing = new Set(subTracks.map(st => st.type));
  let result = [...subTracks];
  if (!existing.has('consensus') && existing.has('reads')) {
    const fireIdx = result.findIndex(st => st.type === 'fire');
    result.splice(fireIdx >= 0 ? fireIdx + 1 : result.findIndex(st => st.type === 'reads'), 0,
      { type: 'consensus', visible: true });
  }
  // microc goes after fire
  if (!existing.has('microc')) {
    const fireIdx = result.findIndex(st => st.type === 'fire');
    const insertAt = fireIdx >= 0 ? fireIdx + 1 : result.findIndex(st => st.type === 'reads');
    if (insertAt >= 0) {
      result.splice(insertAt, 0, { type: 'microc', visible: true });
    } else {
      result.push({ type: 'microc', visible: true });
    }
  }
  // coacc goes after microc
  if (!existing.has('coacc')) {
    const microcIdx = result.findIndex(st => st.type === 'microc');
    const insertAt = microcIdx >= 0 ? microcIdx + 1 : result.findIndex(st => st.type === 'reads');
    if (insertAt >= 0) {
      result.splice(insertAt, 0, { type: 'coacc', visible: true });
    } else {
      result.push({ type: 'coacc', visible: true });
    }
  }
  // capture goes before primer
  if (!existing.has('capture')) {
    const primerIdx = result.findIndex(st => st.type === 'primer');
    const readsIdx = result.findIndex(st => st.type === 'reads');
    const insertAt = primerIdx >= 0 ? primerIdx : (readsIdx >= 0 ? readsIdx : -1);
    if (insertAt >= 0) {
      result.splice(insertAt, 0, { type: 'capture', visible: true });
    } else {
      result.push({ type: 'capture', visible: true });
    }
  }
  // primer goes before reads
  if (!existing.has('primer')) {
    const readsIdx = result.findIndex(st => st.type === 'reads');
    if (readsIdx >= 0) {
      result.splice(readsIdx, 0, { type: 'primer', visible: true });
    } else {
      result.push({ type: 'primer', visible: true });
    }
  }
  // The SV summary and coverage rows sit right above the reads (fb-n11-tracks; a dataset panel only).
  if (existing.has('reads')) {
    if (!existing.has('sv')) insertBefore(result, { type: 'sv', visible: true }, ['coverage', 'reads']);
    if (!existing.has('coverage')) insertBefore(result, { type: 'coverage', visible: true }, ['reads']);
  }
  // Rows of plugin packs, where each one's rule puts it.
  return placePluginTracks(result);
}

/**
 * Panels from a saved session or snapshot (fb-n11-tracks): dataset panels get
 * the built-in rows they lack (the SV and coverage rows of older saves), and the
 * retired "SV summary track" collapse becomes the SV row at its smallest height
 * (still showing the SVs, as the collapsed strip did).
 */
export function migratePanelTracks<T extends { subTracks?: SubTrackConfig[]; contentType?: string }>(panels: T[], svTrackCollapsed = false): T[] {
  return panels.map(panel => {
    if (!panel || !Array.isArray(panel.subTracks)) return panel;
    if (!panel.subTracks.some(t => t?.type === 'reads')) {
      // Rows of a plugin pack this build doesn't have go (their kind isn't known here).
      const known = dropUnknownTracks(panel.subTracks);
      return known.length === panel.subTracks.length ? panel : { ...panel, subTracks: known };
    }
    let subTracks = ensureBuiltinSubTracks(dropUnknownTracks(panel.subTracks));
    if (svTrackCollapsed) {
      subTracks = subTracks.map(t => (t.type === 'sv' && t.heightOverride == null ? { ...t, heightOverride: SV_COLLAPSED_MIGRATION_HEIGHT } : t));
    }
    return subTracks.length === panel.subTracks.length && subTracks.every((t, i) => t === panel.subTracks![i]) ? panel : { ...panel, subTracks };
  });
}
/** The SV row's height for a save that had the SV summary collapsed (the kind's minimum). */
export const SV_COLLAPSED_MIGRATION_HEIGHT = 24;

/** Put `track` before the first of `anchors` found (else at the end). */
export function insertBefore(result: SubTrackConfig[], track: SubTrackConfig, anchors: SubTrackType[]): void {
  for (const anchor of anchors) {
    const at = result.findIndex(st => st.type === anchor);
    if (at >= 0) { result.splice(at, 0, track); return; }
  }
  result.push(track);
}

/** Where a built-in missing from a panel goes back: before the first default that follows it and is present. */
export function restoreBuiltinAt(subTracks: SubTrackConfig[], type: SubTrackType): SubTrackConfig[] {
  const order = createDefaultSubTracks().map(t => t.type);
  const at = order.indexOf(type);
  const result = [...subTracks];
  insertBefore(result, { type, visible: true }, at >= 0 ? order.slice(at + 1) : []);
  return result;
}
