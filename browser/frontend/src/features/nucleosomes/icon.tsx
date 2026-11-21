/** The nucleosome panel's icon (drawn like components/ui/Icons.tsx): a nucleosome array on a DNA line. */
import { iconDefaults, type IconProps } from '../../components/ui/iconBase';

export const NucleosomeIcon = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 12h20" />
    <circle cx="6" cy="12" r="2.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="2.6" />
  </svg>
);
