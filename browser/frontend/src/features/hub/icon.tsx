/** The feature hub's icon (drawn like components/ui/Icons.tsx): rows of features with columns per dataset. */
import { iconDefaults, type IconProps } from '../../components/ui/iconBase';

export const FeatureHubIcon = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M3 6h7M3 12h7M3 18h7" />
    <rect x="13" y="4" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
    <rect x="18" y="4" width="3" height="4" rx="1" />
    <rect x="13" y="10" width="3" height="4" rx="1" />
    <rect x="18" y="10" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
    <rect x="13" y="16" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
    <rect x="18" y="16" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
  </svg>
);
