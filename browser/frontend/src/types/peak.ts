// Peak Rule types for rule-based peak detection system

export interface PeakRule {
  id: string;
  name: string;
  matchGroup?: { origin: 'sync' | 'manual' | 'sv'; frameId?: string; frameVersion?: number };
  source: string;           // 'accessibility' | 'fire' | 'tf_density' | 'track:{idx}' | 'annot:{name}' | 'profile:{id}' | 'custom'
  enabled: boolean;
  color: string;             // Base hex color
  opacity: number;           // 0-1 fill opacity
  useGradient: boolean;      // Shade by layer (dark→light)
  smoothWidth: number;       // default 100
  thresholds: [number, number, number, number];  // [strong, medium, weak, rare]
  minPeakWidth: number;      // default 80bp
  minReads: number;          // default 5
}

export interface PeakRulePreset {
  name: string;
  rules: PeakRule[];
}

export const DEFAULT_PEAK_RULES: PeakRule[] = [
  {
    id: 'default-accessibility',
    name: 'Accessibility',
    source: 'accessibility',
    enabled: true,
    color: '#1d4ed8',
    opacity: 0.7,
    useGradient: true,
    smoothWidth: 100,
    thresholds: [0.50, 0.30, 0.15, 0.08],
    minPeakWidth: 80,
    minReads: 5,
  },
  {
    id: 'default-custom',
    name: 'Custom',
    source: 'custom',
    enabled: true,
    color: '#f59e0b',
    opacity: 0.65,
    useGradient: false,
    smoothWidth: 100,
    thresholds: [0.50, 0.30, 0.15, 0.08],
    minPeakWidth: 1,
    minReads: 1,
  },
];
