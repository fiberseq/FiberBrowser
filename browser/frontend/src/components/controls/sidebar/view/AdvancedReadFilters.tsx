import { SidebarSubSection } from '../../SidebarSubSection';
import { CigarDisplaySettings } from './CigarDisplaySettings';
import { SvDisplaySettings } from './SvDisplaySettings';
import { FootprintReadFilters } from './FootprintReadFilters';
import { SignalReadFilters } from './SignalReadFilters';
import { GapReadFilters } from './GapReadFilters';

export function AdvancedReadFilters() {
  return (
    <SidebarSubSection
      id="view.advanced"
      label="Read Filters"
      helpText="Gap handling, footprint count filters, structural variants and BAM CIGAR overlays. Layer quality thresholds live in Labeling & Quality."
      persist
    >
      <div className="space-y-1.5">
        <GapReadFilters />
        <FootprintReadFilters />
        <SignalReadFilters />
        <SvDisplaySettings />
        <CigarDisplaySettings />
      </div>
    </SidebarSubSection>
  );
}
