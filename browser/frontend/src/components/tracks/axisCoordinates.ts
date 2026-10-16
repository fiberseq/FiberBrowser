/**
 * Coordinates of a contig a plugin pack built (e.g. reference flanks around an inserted sequence), for the ruler
 * (AxisTrack.tsx): its readouts, tick labels and a decoration. A provider is a hook returning the coordinates of
 * a contig it knows, or null; the ruler calls every one in registration order.
 */
export interface ContigCoordinates {
  /** The crosshair's readout at a position. */
  positionLabel: (pos: number) => string;
  /** The ruler's region text for a view. */
  regionText: (start: number, end: number) => string;
  /** Where ticks are aligned. */
  tickBase: number;
  /** A tick's label (`format` writes a position at the view's scale). */
  tickLabel: (pos: number, format: (pos: number) => string) => string;
  /** Draw over the ruler (an insert shaded and named), after the region text is known. */
  decorate?: (ctx: CanvasRenderingContext2D, args: { genomeToScreen: (pos: number) => number; width: number; height: number; regionText: string }) => void;
}

export type ContigCoordinatesProvider = (chrom: string | null | undefined) => ContigCoordinates | null;

const providers: ContigCoordinatesProvider[] = [];

export function registerContigCoordinates(useProvider: ContigCoordinatesProvider): void {
  providers.push(useProvider);
}

/** The coordinates of a contig, if a plugin pack knows it (a hook: the same calls in the same order each render). */
export function useContigCoordinates(chrom: string | null | undefined): ContigCoordinates | null {
  let found: ContigCoordinates | null = null;
  for (const useProvider of providers) {
    const c = useProvider(chrom);
    if (!found && c) found = c;
  }
  return found;
}
