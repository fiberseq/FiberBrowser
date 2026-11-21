import { AdvancedReadFilters } from './view/AdvancedReadFilters';
import { DisplaySettings } from './view/DisplaySettings';
import { NavigationSettings } from './view/NavigationSettings';
import { GraphModeSettings } from './view/GraphModeSettings';

interface ViewSectionProps {
  onAutozoom: () => void;
}

export function ViewSection({ onAutozoom }: ViewSectionProps) {
  return (
    <div className="space-y-1.5">
      <DisplaySettings />
      <NavigationSettings onAutozoom={onAutozoom} />
      <GraphModeSettings />
      <AdvancedReadFilters />
    </div>
  );
}
