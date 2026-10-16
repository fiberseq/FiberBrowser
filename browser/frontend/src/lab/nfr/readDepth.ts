import { readDepthNotes, type MoleculeSampling, type LoaderSampling } from '../../utils/readDepth';

export interface NfrMoleculeSampling extends MoleculeSampling { purpose?: string; nfr?: string }

/** Describe detection and variant sampling in the context of the saved run. */
export function nfrReadDepthNotes(records: NfrMoleculeSampling[] = [], labels: Record<string, string> = {}, loader: LoaderSampling[] = []): string[] {
  return readDepthNotes(records, labels, loader, r => ({
    discoveryPurpose: r.purpose === 'region_detection' ? 'finding regions' : r.purpose === 'opportunity_diagnostic' ? 'measuring coverage' : 'finding classes',
    detail: r.nfr,
  }));
}
