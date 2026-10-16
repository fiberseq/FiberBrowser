import { PeakDetectionSettings } from './analysis/PeakDetectionSettings';
import { ReproducibilitySettings } from './analysis/ReproducibilitySettings';
import { AppSettings } from './analysis/AppSettings';

export function AnalysisSection() {
  return (
    <div className="space-y-1.5">
      <ReproducibilitySettings />
      <PeakDetectionSettings />
      <AppSettings />
    </div>
  );
}
