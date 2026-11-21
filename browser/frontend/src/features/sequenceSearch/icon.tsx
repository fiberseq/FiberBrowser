/** The Find sequence panel's icon (drawn like components/ui/Icons.tsx): a magnifier over a DNA line. */
import { iconDefaults, type IconProps } from '../../components/ui/iconBase';

export const SequenceSearchIcon = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 18h7" />
    <path d="M3.5 15.5v5M6.5 15.5v5" />
    <circle cx="14.5" cy="9.5" r="5" />
    <path d="M18.2 13.2 22 17" />
    <path d="M12.5 9.5h4" />
  </svg>
);
