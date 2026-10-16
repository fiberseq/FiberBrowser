/** Synchronise regions' icon (drawn like components/ui/Icons.tsx): two regions, a subregion of one mapped onto the other. */
import { iconDefaults, type IconProps } from '../../components/ui/iconBase';

export const SyncRegions = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 5h20M2 19h20" />
    <rect x="5" y="2.5" width="6" height="5" rx="1.5" fill="currentColor" stroke="none" />
    <rect x="13" y="16.5" width="6" height="5" rx="1.5" fill="currentColor" stroke="none" />
    <path d="M8 9.5l8 5" />
  </svg>
);
