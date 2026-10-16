/**
 * The insertion and variant features' additions to core types (TypeScript module augmentation): the SV feature kind,
 * the SNP row and the fields they keep on panels, read subsets and datasets.
 */
import type { InsertionLensState } from './insertion/insertionLensTarget';
import type { SavedIdentify } from './insertion/identifyModel';
import type { VariantsPanelState } from './variants/variantsState';
import type { AltAlleleInfo, AltAllelePanelState } from './altAllele/types';

/** A SNP a split was made by (variants/variantSplit.ts): where, and its alleles ("chr6:122,471,928 C>A"). */
export interface SplitSnp {
  datasetId: string;
  chrom: string;
  /** The SNP id ("<pos0>:<kind>:<a1>/<a2>"). */
  id: string;
  /** 0-based. */
  pos: number;
  kind: 'snv' | 'ins' | 'del';
  ref: string | null;
  alt: string;
  label: string;
}

declare module '../stores/featureStore' {
  interface PackFeatureKinds {
    /** A structural variant of a dataset (variants/svFeatures.ts), id "<t>:<ref>:<len>", source its dataset. */
    sv: true;
  }
}

declare module '../types' {
  interface PackSubTrackTypes {
    /** The Variants panel's SNP channel (variants/SnpChannelTrack.tsx). */
    snps: true;
  }

  interface PanelConfig {
    /** The insertion lens's cluster and view options (insertion/). */
    insertionLens?: InsertionLensState;
    /** The Variants panel's tab, scan settings, selected SNPs and last results (variants/). */
    variants?: VariantsPanelState;
    /** "Identify this insertion" results, per insertion cluster (insertion/identifyStore.ts). */
    insertionIdentify?: Record<string, SavedIdentify>;
    /** Showing an insertion's carriers on its alternate allele, insert expanded (altAllele/altAllelePanel.ts). */
    altAllele?: AltAllelePanelState;
  }

  interface ReadSubsetRule {
    /** A combined-SV split's group: the insertions every read of it carries (each can be shown expanded in it). */
    carriedInsertions?: { datasetId: string; chrom: string; ref: number; len: number; name: string }[];
    /** A combined-SV split: the SVs it was made by ("<t>:<ref>:<len>" on its dataset and chromosome). */
    splitSvs?: { datasetId: string; chrom: string; id: string }[];
    /** A split by SNP allele (or combination): the SNPs it was made by (0-based `pos`; `ref` null when unknown). */
    splitSnps?: SplitSnp[];
    /** That panel's group: its allele at each of `splitSnps` (index-aligned; null: not called in the group). */
    splitAlleles?: (string | null)[];
    /** The dashed guide through the reads at each split SNP (on unless false). */
    splitSnpGuide?: boolean;
  }
}

declare module '../types/dataset' {
  interface Dataset {
    /** An insertion's carriers re-aligned onto its alternate allele (an alt-allele panel's dataset). */
    alt_allele?: AltAlleleInfo;
  }
}

/** The PanelConfig fields above (declared, so sessions from builds that kept them elsewhere restore them). */
export const FEATURE_PANEL_FIELDS = ['insertionLens', 'variants', 'insertionIdentify', 'altAllele'] as const;
