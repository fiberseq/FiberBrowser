/**
 * A dataset panel's title (usability audit Top 1): what sets this panel apart first, the dataset last.
 *
 * - A split panel leads with its group ("Carriers", "Reference", "roo+ · INS5k+", "N2 · V2"); the split's
 *   locus ("INS 9.2 kb @ chr2L:9,467,039") and the dataset follow, and may be cut.
 * - An insert-expanded panel (its dataset is "Carriers of +9,185 bp at chr2L:… · numb") leads with "Carriers".
 * - A panel with a title of its own (a reference copy: "roo copy 2 (chr3L)") leads with it.
 * - Otherwise the dataset's name.
 *
 * The header never cuts `primary` (only `secondary`); the tooltip has all of it.
 */
import type { PanelConfig } from '../types';

export interface PanelTitle {
  /** Never truncated in the header. */
  primary: string;
  /** Context after it (may be cut); '' for none. */
  secondary: string;
  /** Between the two (" · ", or " " when the secondary continues the phrase: "Carriers" "of +9,185 bp …"). */
  sep: string;
  /** Everything, for the tooltip and figures. */
  full: string;
}

/** A label with coordinates in it ("INS 9.2 kb @ chr2L:9,467,039"): long, and the same for every panel of the split. */
const hasCoordinates = (label: string) => /:\d/.test(label);

/** The group part of a split panel's label: without the split's locus prefix, nor a trailing read count "(741)". */
export function splitGroupName(subset: NonNullable<PanelConfig['readSubset']>): { group: string; context: string } {
  let group = subset.label;
  let context = '';
  const locus = subset.locus?.label;
  if (locus && hasCoordinates(locus) && group.startsWith(`${locus} · `)) {
    group = group.slice(locus.length + 3);
    context = locus;
  }
  const count = group.match(/^(.*\S)\s+\((\d[\d,]*)\)$/);
  if (count) group = count[1];
  return { group, context };
}

/** "Carriers of +9,185 bp at chr2L:9,467,038 (3,267) · numb" -> ["Carriers", "of +9,185 bp at …"]. */
function carriersParts(label: string): [string, string] | null {
  const m = label.match(/^(Carriers) (of .+)$/);
  return m ? [m[1], m[2]] : null;
}

/**
 * The title of a dataset panel. `datasetLabel`: the dataset's display name (as the header shows it);
 * `sourceLabel`: an insert-expanded panel's source dataset (its reads came from there).
 */
export function panelTitle(panel: Pick<PanelConfig, 'readSubset' | 'altAllele' | 'title' | 'titleDetail'>, datasetLabel: string,
  sourceLabel?: string): PanelTitle {
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');
  const subset = panel.readSubset;
  if (subset) {
    const { group, context } = splitGroupName(subset);
    // An insert-expanded split panel: its dataset is the alt allele; the source's name says more.
    const dataset = panel.altAllele ? join(sourceLabel ?? datasetLabel, 'insert expanded') : datasetLabel;
    const secondary = join(context, dataset);
    return { primary: group, secondary, sep: ' · ', full: join(group, secondary) };
  }
  if (panel.title) {
    const secondary = join(panel.titleDetail, datasetLabel);
    return { primary: panel.title, secondary, sep: ' · ', full: join(panel.title, secondary) };
  }
  const carriers = panel.altAllele ? carriersParts(datasetLabel) : null;
  if (carriers) return { primary: carriers[0], secondary: carriers[1], sep: ' ', full: datasetLabel };
  return { primary: datasetLabel, secondary: '', sep: '', full: datasetLabel };
}
