/** The NFR motif view's parameters (kept in the browser store with the session, and on this computer). */
import { load, num, store } from '../../utils/motifSettings';

export interface NfrMotifSettings {
  /** Background model: the base composition around the NFR, of the genome FASTA (sampled), or 25% each. */
  background: 'local' | 'genome' | 'uniform';
  /** Keep sites on both strands, or one (reference orientation). */
  strand: 'both' | '+' | '-';
  /** Matrices at least this similar (and hitting the same bases) are one family row. */
  familySimilarity: number;
  /** Window around the variants scanned and mapped (bp). */
  flank: number;
  /** Site core (bp around the motif centre) a footprint class must cover. */
  coreBp: number;
  /** Fewest reads a variant needs in a layer to enter that layer's test. */
  minReads: number;
}

export const DEFAULT_NFR_MOTIF_SETTINGS: NfrMotifSettings = {
  background: 'local', strand: 'both', familySimilarity: 0.8, flank: 300, coreBp: 10, minReads: 10,
};

export function normalizeNfrMotifSettings(value: unknown): NfrMotifSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_NFR_MOTIF_SETTINGS;
  return {
    background: v.background === 'genome' || v.background === 'uniform' ? v.background : 'local',
    strand: v.strand === '+' || v.strand === '-' ? v.strand : 'both',
    familySimilarity: num(v.familySimilarity, 0.5, 1, d.familySimilarity),
    flank: Math.round(num(v.flank, 0, 5000, d.flank)),
    coreBp: Math.round(num(v.coreBp, 1, 60, d.coreBp)),
    minReads: Math.round(num(v.minReads, 1, 1000, d.minReads)),
    // (the motif-centred profile settings of earlier versions, profileHalf / profileSmooth / profileNormalise, are
    // dropped: sessions and stored preferences that still carry them load without them)
  };
}

const KEY_SETTINGS = 'fiberhmm_nfr_motif_settings';
export const loadNfrMotifSettings = () => load(KEY_SETTINGS, normalizeNfrMotifSettings);
export const storeNfrMotifSettings = (v: NfrMotifSettings) => store(KEY_SETTINGS, v);
