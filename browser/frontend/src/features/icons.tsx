/** The insertion and variant features' icons (drawn like components/ui/Icons.tsx). */
import { iconDefaults, type IconProps } from '../components/ui/iconBase';

/** Variants: a sequence bar with one substituted base (the tick) and an inserted block raised out of it (the Variants panel). */
export const Variants = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 18h20" />
    <path d="M6 10.5v7.5" />
    <path d="M12 18l1.5-3.5M20 18l-1.5-3.5" />
    <rect x="12" y="7" width="8" height="7" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
);

/** A read opened at an insertion: the read line with the inserted stretch lifted out of it (the insertion lens). */
export const InsertionLens = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 17h6M16 17h6" />
    <path d="M8 17V8h8v9" />
    <path d="M10.5 12h3" />
  </svg>
);
