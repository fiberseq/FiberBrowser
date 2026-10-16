import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadBookmarksFromStorage,
  saveBookmarksToStorage,
  loadSidebarWidth,
  loadActiveSection,
  coerceSidebarSection,
  migrateColormap,
  generatePanelId,
  createDefaultSubTracks,
  BOOKMARKS_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  SIDEBAR_SECTIONS_STORAGE_KEY,
  SIDEBAR_ACTIVE_SECTION_STORAGE_KEY,
} from '../utils';

// ============================================================================
// localStorage helpers
// ============================================================================

describe('loadBookmarksFromStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no data stored', () => {
    expect(loadBookmarksFromStorage()).toEqual([]);
  });

  it('returns parsed bookmarks from valid JSON', () => {
    const bookmarks = [
      { id: 'b1', name: 'Test', chrom: 'chr1', start: 0, end: 1000, created: '2024-01-01' },
    ];
    localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
    const result = loadBookmarksFromStorage();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Test');
  });

  it('returns empty array on invalid JSON', () => {
    localStorage.setItem(BOOKMARKS_STORAGE_KEY, '{invalid');
    expect(loadBookmarksFromStorage()).toEqual([]);
  });
});

describe('saveBookmarksToStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves bookmarks to localStorage', () => {
    const bookmarks = [{ id: 'b1', name: 'Test', chrom: 'chr1', start: 0, end: 1000, created: '2024-01-01' }];
    saveBookmarksToStorage(bookmarks);
    const stored = JSON.parse(localStorage.getItem(BOOKMARKS_STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
  });
});

describe('migrateColormap', () => {
  it('fills quality defaults on legacy labeling presets', () => {
    const migrated = migrateColormap({
      name: 'Legacy',
      rules: [{
        id: 'legacy-rule',
        name: 'Legacy rule',
        color: '#888888',
        sizeMin: 1,
        sizeMax: null,
        enabled: true,
      } as any],
    });

    expect(migrated.name).toBe('Legacy');
    expect(migrated.backgroundColor).toBe('#ffffff');
    expect(migrated.readBackgroundColor).toBe('#f1f5f9');
    expect(migrated.noReadBackgroundColor).toBe('#ffffff');
    expect(migrated.qualityShading).toBeDefined();
    expect(migrated.tfOverlay).toBeDefined();
    expect(migrated.layerOpacities).toEqual({
      nuc: 1,
      tf: 0.9,
      nuc_sr: 0.9,
      tf_sr: 0.9,
      fire: 0.55,
    });
    expect(migrated.layerBackgroundOpacities).toEqual({
      nuc: 1,
      tf: 1,
      nuc_sr: 1,
      tf_sr: 1,
      fire: 1,
    });
    expect(migrated.displaySmoothing).toEqual({ enabled: false, sigmaX: 0, sigmaY: 0 });
    expect(migrated.qualityFilters).toBeDefined();
    expect(migrated.rules[0].opacity).toBe(1);
    expect(migrated.rules[0].targetLayers).toEqual([]);
    expect(migrated.rules[0].conditions).toEqual([]);
    expect(migrated.rules[0].qualityGates).toEqual([]);
  });

  it('normalizes persisted layer opacity controls', () => {
    const migrated = migrateColormap({
      name: 'Opacity aliases',
      rules: [],
      layerOpacities: {
        msp: 0.2,
        tf_layer: '0.75',
        custom: 2,
      } as any,
      layerBackgroundOpacities: {
        msp: 0,
        tf_layer: '0.25',
        custom: -1,
      } as any,
    });

    expect(migrated.layerOpacities.fire).toBe(0.2);
    expect(migrated.layerOpacities.tf).toBe(0.75);
    expect(migrated.layerOpacities.custom).toBe(1);
    expect(migrated.layerBackgroundOpacities.fire).toBe(0);
    expect(migrated.layerBackgroundOpacities.tf).toBe(0.25);
    expect(migrated.layerBackgroundOpacities.custom).toBe(0);
  });

  it('normalizes persisted rule opacity and read background controls', () => {
    const migrated = migrateColormap({
      name: 'Visual controls',
      backgroundColor: '#000000',
      readBackgroundColor: '#123456',
      noReadBackgroundColor: 'bad-color',
      rules: [
        { id: 'hidden', name: 'Hidden', color: '#111111', opacity: 0, sizeMin: 1, sizeMax: null, enabled: true },
        { id: 'clamped', name: 'Clamped', color: '#222222', opacity: 2, sizeMin: 1, sizeMax: null, enabled: true },
        { id: 'legacy', name: 'Legacy', color: '#333333', sizeMin: 1, sizeMax: null, enabled: true },
      ] as any,
    });

    expect(migrated.backgroundColor).toBe('#000000');
    expect(migrated.noReadBackgroundColor).toBe('#000000');
    expect(migrated.readBackgroundColor).toBe('#123456');
    expect(migrated.rules.map(rule => rule.opacity)).toEqual([0, 1, 1]);
  });

  it('preserves persisted size-gradient rule controls', () => {
    const migrated = migrateColormap({
      name: 'Gradient rules',
      rules: [{
        id: 'gradient-rule',
        name: 'Gradient rule',
        color: '#ABCDEF',
        colorMode: 'size_gradient',
        gradient: { startColor: '#000000', endColor: '#FFFFFF', sizeMin: 20, sizeMax: 1000, scale: 'sqrt' },
        sizeMin: 10,
        sizeMax: null,
        enabled: true,
      } as any],
    });

    expect(migrated.rules[0]).toMatchObject({
      color: '#abcdef',
      colorMode: 'size_gradient',
      gradient: { startColor: '#000000', endColor: '#ffffff', sizeMin: 20, sizeMax: 1000, scale: 'sqrt' },
      sizeMin: 10,
      sizeMax: null,
    });
  });

  it('normalizes persisted display smoothing controls', () => {
    const migrated = migrateColormap({
      name: 'Smoothing',
      rules: [],
      displaySmoothing: { enabled: true, sigmaX: '2.5', sigmaY: 50 } as any,
    });

    expect(migrated.displaySmoothing).toEqual({ enabled: true, sigmaX: 2.5, sigmaY: 10 });
  });

  it('fills edge-ambiguity defaults and round-trips a saved zero gap', () => {
    const defaulted = migrateColormap({ name: 'Edge', rules: [] });
    expect(defaulted.edgeAmbiguity).toEqual({ mode: 'strict', applyNuc: true, applyTf: true, maxGapBp: 30 });

    const persisted = migrateColormap({
      name: 'Edge',
      rules: [],
      edgeAmbiguity: { mode: 'loose', applyNuc: false, applyTf: true, maxGapBp: 0 } as any,
    });
    // A valid 0 must survive (not snap back to the 30 default).
    expect(persisted.edgeAmbiguity).toEqual({ mode: 'loose', applyNuc: false, applyTf: true, maxGapBp: 0 });

    // Garbage gap falls back to the default; unknown mode falls back to soft.
    const bad = migrateColormap({
      name: 'Edge',
      rules: [],
      edgeAmbiguity: { mode: 'wat', maxGapBp: 'nope' } as any,
    });
    expect(bad.edgeAmbiguity.mode).toBe('strict');
    expect(bad.edgeAmbiguity.maxGapBp).toBe(30);
  });
});

// ============================================================================
// loadSidebarWidth
// ============================================================================

describe('loadSidebarWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns 340 when no data stored', () => {
    expect(loadSidebarWidth()).toBe(340);
  });

  it('returns stored valid width', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '320');
    expect(loadSidebarWidth()).toBe(320);
  });

  it('rejects width below 300', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '280');
    expect(loadSidebarWidth()).toBe(340);
  });

  it('rejects width above 560', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '600');
    expect(loadSidebarWidth()).toBe(340);
  });

  it('rejects non-numeric value', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'abc');
    expect(loadSidebarWidth()).toBe(340);
  });

  it('accepts boundary value 300', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '300');
    expect(loadSidebarWidth()).toBe(300);
  });

  it('accepts boundary value 560', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '560');
    expect(loadSidebarWidth()).toBe(560);
  });
});

// ============================================================================
// loadActiveSection (the settings page shown; older builds kept open sections)
// ============================================================================

describe('loadActiveSection', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the first page', () => {
    expect(loadActiveSection()).toBe('file');
  });

  it('loads the stored page', () => {
    localStorage.setItem(SIDEBAR_ACTIVE_SECTION_STORAGE_KEY, 'view');
    expect(loadActiveSection()).toBe('view');
  });

  it('migrates the accordion\'s open sections to their first page, once', () => {
    localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(['view', 'analysis']));
    expect(loadActiveSection()).toBe('view');
    expect(localStorage.getItem(SIDEBAR_ACTIVE_SECTION_STORAGE_KEY)).toBe('view');
    expect(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY)).toBeNull();
  });

  it('migrates old "datasets" and "data" ids to "file"', () => {
    localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(['datasets', 'view']));
    expect(loadActiveSection()).toBe('file');
    localStorage.clear();
    localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(['data']));
    expect(loadActiveSection()).toBe('file');
  });

  it('skips subsection ids and retired sections', () => {
    localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(['history', 'file.panels', 'genome']));
    expect(loadActiveSection()).toBe('genome');
  });

  it('falls back to the default on invalid JSON, an empty list or an unknown page', () => {
    localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, '{bad');
    expect(loadActiveSection()).toBe('file');
    localStorage.clear();
    localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, '[]');
    expect(loadActiveSection()).toBe('file');
    localStorage.clear();
    localStorage.setItem(SIDEBAR_ACTIVE_SECTION_STORAGE_KEY, 'history');
    expect(loadActiveSection()).toBe('file');
  });

  it('coerces strings, lists and Sets', () => {
    expect(coerceSidebarSection('analysis')).toBe('analysis');
    expect(coerceSidebarSection(new Set(['genome']))).toBe('genome');
    expect(coerceSidebarSection([3, null, 'view'])).toBe('view');
    expect(coerceSidebarSection(undefined)).toBeNull();
    expect(coerceSidebarSection({})).toBeNull();
  });
});

// ============================================================================
// generatePanelId
// ============================================================================

describe('generatePanelId', () => {
  it('returns string starting with "panel-"', () => {
    const id = generatePanelId();
    expect(id).toMatch(/^panel-/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generatePanelId()));
    expect(ids.size).toBe(100);
  });
});

// ============================================================================
// createDefaultSubTracks
// ============================================================================

describe('createDefaultSubTracks', () => {
  it('returns default sub-tracks with no orthogonal tracks', () => {
    const tracks = createDefaultSubTracks();
    expect(tracks.some(t => t.type === 'axis')).toBe(true);
    expect(tracks.some(t => t.type === 'meta')).toBe(false);
    expect(tracks.some(t => t.type === 'fire')).toBe(true);
    expect(tracks.some(t => t.type === 'reads')).toBe(true);
    expect(tracks.some(t => t.type === 'gene')).toBe(true);
    expect(tracks.every(t => t.visible)).toBe(true);
  });

  it('includes composite tracks as composite-<id>', () => {
    const tracks = createDefaultSubTracks([], [{ id: 'a' }, { id: 'b' }]);
    expect(tracks.some(t => t.type === 'composite-a')).toBe(true);
    expect(tracks.some(t => t.type === 'composite-b')).toBe(true);
  });
});
