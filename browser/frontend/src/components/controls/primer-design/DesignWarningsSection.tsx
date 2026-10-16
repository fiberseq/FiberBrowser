import type { FirePeak, PrimerState, Region } from '../../../types';
import { AnalysisStatus } from '../shared';

function peakSpan(peaks: FirePeak[], region: Region | null): number {
  if (!region) return 0;
  const overlapping = peaks.filter(p => p.end > region.start && p.start < region.end);
  if (overlapping.length <= 1) return 0;
  return Math.max(...overlapping.map(p => p.end)) - Math.min(...overlapping.map(p => p.start));
}

export function DesignWarningsSection({
  mode,
  selectedPeaksList,
  locusX,
  locusY,
  targetTooLarge,
  targetSize,
  maxProduct,
}: {
  mode: PrimerState['mode'];
  selectedPeaksList: FirePeak[];
  locusX: Region | null;
  locusY: Region | null;
  targetTooLarge: boolean;
  targetSize: number;
  maxProduct: number;
}) {
  if (targetTooLarge) {
    return (
      <AnalysisStatus kind="warning" title="Target region too large">
        Selected peaks span {targetSize.toLocaleString()}bp but max product size is {maxProduct.toLocaleString()}bp.
        Increase max product size in Parameters, or select fewer/closer peaks.
      </AnalysisStatus>
    );
  }

  if (mode !== 'dafc' || !locusX || !locusY) return null;

  const xSpan = peakSpan(selectedPeaksList, locusX);
  const ySpan = peakSpan(selectedPeaksList, locusY);
  const xTooLarge = xSpan > maxProduct;
  const yTooLarge = ySpan > maxProduct;
  if (!xTooLarge && !yTooLarge) return null;

  return (
    <AnalysisStatus kind="warning" title="Locus target too large">
      {xTooLarge && <div className="mt-0.5">Locus X peaks span {xSpan.toLocaleString()}bp (max product: {maxProduct.toLocaleString()}bp)</div>}
      {yTooLarge && <div className="mt-0.5">Locus Y peaks span {ySpan.toLocaleString()}bp (max product: {maxProduct.toLocaleString()}bp)</div>}
    </AnalysisStatus>
  );
}
