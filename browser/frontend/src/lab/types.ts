/**
 * The lab pack's additions to core types (TypeScript module augmentation): its feature kinds, row types and the fields
 * it keeps on read subsets and split sources. Core never names them; a build without this folder has none of them.
 */
import type { AccessibilityResult } from './nfr/api';

declare module '../stores/featureStore' {
  interface PackFeatureKinds {
    /** An NFR of an Accessibility (preview) run (its whole-NFR element). */
    nfr: true;
    /** A variant of an NFR ("N1:V2"). */
    'nfr-variant': true;
  }
}

declare module '../types' {
  interface PackSubTrackTypes {
    /** The NFR track: the NFRs of a Find variants run, their variants and the shown run's pair arcs (nfr/NfrFeatureTrack.tsx). */
    'nfr-variants': true;
  }

  interface ReadSubsetRule {
    /** configurations / split (NFR splits, nfr/nfrGrouping.ts): the Accessibility run; configurations: its NFR;
     * split: its elements. */
    jobId?: string;
    nfrId?: string;
    elements?: string[];
  }
}

declare module '../stores/splitPanelStore' {
  interface PackSplitSources {
    /** An NFR's configurations (its variants). */
    configurations: { kind: 'configurations'; jobId: string; nfrId: string; result?: AccessibilityResult | null };
    /** A run's combination patterns of some of its elements. */
    split: { kind: 'split'; jobId: string; elements: string[]; result?: AccessibilityResult | null };
  }
}
