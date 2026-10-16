import { useId } from 'react';
import { iconDefaults, type IconProps } from './iconBase';

export const Camera = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

export const Settings = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);

export const FolderOpen = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    <path d="M2 10h20" />
  </svg>
);

export const Globe = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
  </svg>
);

export const Eye = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const EyeOff = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M17.9 17.9A10 10 0 0112 20c-7 0-11-8-11-8a18.5 18.5 0 015.1-5.9M9.9 4.2A9 9 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.2 3.2M14.1 14.1a3 3 0 01-4.2-4.2" />
    <path d="M1 1l22 22" />
  </svg>
);

export const BarChart = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M18 20V10M12 20V4M6 20v-6" />
  </svg>
);

export const ChevronLeft = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

export const ChevronRight = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M9 18l6-6-6-6" />
  </svg>
);

export const ChevronDown = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const ArrowLeft = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

export const ArrowRight = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

export const Plus = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const Minus = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M5 12h14" />
  </svg>
);

export const Pencil = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
  </svg>
);

export const Trash = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
);

/** Two overlapping sheets: duplicate an item. */
export const Copy = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
);

export const X = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export const Check = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export const Link = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
  </svg>
);

export const Unlink = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M18.84 12.25l1.72-1.71a5 5 0 00-7.07-7.07l-1.72 1.71" />
    <path d="M5.16 11.75l-1.72 1.71a5 5 0 007.07 7.07l1.72-1.71" />
    <path d="M8 2v3M2 8h3M16 22v-3M22 16h-3" />
  </svg>
);

export const Refresh = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M23 4v6h-6" />
    <path d="M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
  </svg>
);

export const UndoIcon = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
  </svg>
);

export const RedoIcon = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 000 11H13" />
  </svg>
);

export const Wrench = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
  </svg>
);

export const Crosshair = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" />
  </svg>
);

/** Match other panels to this location: two arrows meeting at one line (fb-r3-nav). */
export const MatchLocus = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M12 3v18" />
    <path d="M2 12h6M5.5 9l3 3-3 3" />
    <path d="M22 12h-6M18.5 9l-3 3 3 3" />
  </svg>
);

export const Download = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </svg>
);

export const Sun = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="5" />
    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
  </svg>
);

export const Moon = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
  </svg>
);

export const GripVertical = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p} fill="currentColor" stroke="none">
    <circle cx="9" cy="5" r="1.5" />
    <circle cx="15" cy="5" r="1.5" />
    <circle cx="9" cy="12" r="1.5" />
    <circle cx="15" cy="12" r="1.5" />
    <circle cx="9" cy="19" r="1.5" />
    <circle cx="15" cy="19" r="1.5" />
  </svg>
);

export const Maximize = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3" />
  </svg>
);

export const Minimize = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </svg>
);

export const MoreVertical = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p} fill="currentColor" stroke="none">
    <circle cx="12" cy="5" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="12" cy="19" r="1.5" />
  </svg>
);

/** A menu of more actions, laid out in a row (the dataset header's menu). */
export const MoreHorizontal = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p} fill="currentColor" stroke="none">
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="19" cy="12" r="1.5" />
  </svg>
);

export const Merge = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M6 3v6l6 3 6-3V3" />
    <path d="M12 12v9" />
  </svg>
);

export const Split = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M12 3v9" />
    <path d="M6 21v-6l6-3 6 3v6" />
  </svg>
);

export const ExternalLink = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

export const Clock = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

export const GridIcon = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M3 7h7M14 7h7M3 12h7M14 12h7M3 17h7M14 17h7" />
  </svg>
);

export const Pointer = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
    <path d="M13 13l6 6" />
  </svg>
);

export const ListIcon = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);

export const Power = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M18.36 6.64a9 9 0 11-12.73 0" />
    <path d="M12 2v10" />
  </svg>
);

export const Info = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

export const MapPinPlus = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M19 10c0 6-7 12-7 12s-7-6-7-12a7 7 0 0114 0z" />
    <path d="M12 7v6M9 10h6" />
  </svg>
);

export const Lock = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 018 0v4" />
  </svg>
);

export const LockOpen = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 017.75-1.4" />
  </svg>
);

/* ---------------------------------------------------------------------------
 * General-purpose icons (replace emoji and text glyphs used as buttons or
 * status markers). Same grid as above: 24x24, 2px round stroke, currentColor.
 * ------------------------------------------------------------------------- */

export const Target = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" />
  </svg>
);

export const Pin = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M12 16v6" />
    <path d="M8 3h8M9 3v6l-3 4v3h12v-3l-3-4V3" />
  </svg>
);

export const ThumbsUp = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M7 10v11" />
    <path d="M14 9V5a3 3 0 00-3-3l-4 8v11h10.3a2 2 0 002-1.7l1.4-8A2 2 0 0018.7 9z" />
    <path d="M7 21H4a1 1 0 01-1-1v-9a1 1 0 011-1h3" />
  </svg>
);

export const ThumbsDown = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M17 14V3" />
    <path d="M10 15v4a3 3 0 003 3l4-8V3H6.7a2 2 0 00-2 1.7l-1.4 8A2 2 0 005.3 15z" />
    <path d="M17 3h3a1 1 0 011 1v9a1 1 0 01-1 1h-3" />
  </svg>
);

export const Sparkles = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8z" />
    <path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z" />
  </svg>
);

export const Lightbulb = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M9 18h6M10 22h4" />
    <path d="M12 2a7 7 0 00-4 12.7c.6.5 1 1.2 1 2V18h6v-1.3c0-.8.4-1.5 1-2A7 7 0 0012 2z" />
  </svg>
);

export const Folder = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
);

/** A file with a down arrow: export data (the toolbar's Export data, beside Export figure's Camera). */
export const FileDown = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M12 11v7M9 15l3 3 3-3" />
  </svg>
);

export const ClipboardList = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
    <path d="M9 12h6M9 16h4" />
  </svg>
);

export const Compass = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z" />
  </svg>
);

export const TrendingUp = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M22 7l-8.5 8.5-5-5L2 17" />
    <path d="M16 7h6v6" />
  </svg>
);

export const Star = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />
  </svg>
);

export const AlertTriangle = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);

export const Play = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M7 4.5v15a1 1 0 001.5.9l12-7.5a1 1 0 000-1.8l-12-7.5A1 1 0 007 4.5z" />
  </svg>
);

export const SkipForward = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M5 4l10 8-10 8z" />
    <path d="M19 5v14" />
  </svg>
);

export const ArrowUp = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const RotateCcw = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M3 4v6h6" />
    <path d="M3.5 15a9 9 0 102.1-9.4L3 10" />
  </svg>
);

export const Sliders = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1 14h6M9 8h6M17 16h6" />
  </svg>
);

export const CheckCircle = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M8 12.5l2.7 2.7L16 9.5" />
  </svg>
);

export const XCircle = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M15 9l-6 6M9 9l6 6" />
  </svg>
);

export const Circle = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="9" />
  </svg>
);

/** A step in progress: an outlined circle, half filled. */
export const CircleHalf = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 010 18z" fill="currentColor" stroke="none" />
  </svg>
);

export const CircleDashed = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="9" strokeDasharray="3 3.5" />
  </svg>
);

export const Search = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-5-5" />
  </svg>
);

export const Keyboard = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M8 16h8" />
  </svg>
);

export const Layers = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M12 2L2 7l10 5 10-5z" />
    <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
  </svg>
);

/** A row's height (Set height…): a bar with arrows up and down. */
export const RowHeight = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M4 12h16" />
    <path d="M12 3v6M9 6l3-3 3 3M12 21v-6M9 18l3 3 3-3" />
  </svg>
);

export const Tag = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8z" />
    <path d="M7 7h.01" />
  </svg>
);

/** A panel pinned to the right edge (a side drawer). */
export const PanelRight = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18" />
    <path d="M18 8v8" strokeWidth="3" />
  </svg>
);

/** Two panels side by side (docked beside the reads). */
export const PanelBeside = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 3v18" />
  </svg>
);

export const LayoutColumns = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </svg>
);


/* ---------------------------------------------------------------------------
 * Domain icons: the objects FiberBrowser shows. Drawn on the same grid so they
 * sit next to the general icons, and modelled on the app icon (single-molecule
 * reads with nucleosome blocks, TF footprints and an accessible column).
 * ------------------------------------------------------------------------- */

/** One single-molecule read (fiber): nucleosomes and a TF footprint, as in the app icon. */
export const Fiber = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 12h20" />
    <rect x="2" y="8" width="7" height="8" rx="2" fill="currentColor" stroke="none" />
    <rect x="11" y="6.5" width="2" height="11" rx="1" fill="currentColor" stroke="none" />
    <rect x="15" y="8" width="7" height="8" rx="2" fill="currentColor" stroke="none" />
  </svg>
);

/** Several reads stacked, as in the read track and the app icon. */
export const Reads = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M3 6h5M12 6h2M18 6h3" />
    <path d="M3 12h3M10 12h5M19 12h2" />
    <path d="M3 18h6M13 18h2M19 18h2" />
  </svg>
);

/** A nucleosome footprint on a read (DNA crossing the histone core). */
export const Nucleosome = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 12h4M18 12h4" />
    <rect x="6" y="7" width="12" height="10" rx="3.5" />
    <path d="M9 7.5l6 9" />
  </svg>
);

/** A transcription-factor footprint: a short protected block on a read. */
export const TfFootprint = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 14h7M15 14h7" />
    <rect x="9.5" y="7" width="5" height="11" rx="1.5" />
    <path d="M12 3v1" />
  </svg>
);

/** An accessible column: an open window crossing several reads. */
export const AccessibleColumn = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="9" y="3" width="6" height="18" rx="2" />
    <path d="M2 7h4M18 7h4M2 12h4M18 12h4M2 17h4M18 17h4" />
  </svg>
);

/** Footprint classes: recurrent footprint shapes, listed by size. */
export const FootprintClasses = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="3" y="3.5" width="5" height="4" rx="1" />
    <rect x="3" y="10" width="9" height="4" rx="1" />
    <rect x="3" y="16.5" width="3" height="4" rx="1" />
    <path d="M12 5.5h9M16 12h5M10 18.5h11" />
  </svg>
);

/** Co-occupancy: two footprints bound on the same read, linked. */
export const CoOccupancy = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 15h20" />
    <rect x="6" y="10.5" width="3" height="9" rx="1" fill="currentColor" stroke="none" />
    <rect x="15" y="10.5" width="3" height="9" rx="1" fill="currentColor" stroke="none" />
    <path d="M7.5 7V4h9v3" />
  </svg>
);

/** Co-accessibility: two accessible sites that open together. */
export const CoAccess = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="16" y="4" width="5" height="16" rx="1.5" />
    <path d="M8 12h8" strokeDasharray="2 2.5" />
  </svg>
);

/** Read clusters: two clumps of points and two strays (the Cluster action and the Clusters panel). */
export const ReadClusters = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <g fill="currentColor" stroke="none">
      <circle cx="4.1" cy="5.62" r="2.3" /><circle cx="8.7" cy="5.62" r="2.3" /><circle cx="6.4" cy="9.41" r="2.3" />
      <circle cx="14.3" cy="15.02" r="2.3" /><circle cx="18.9" cy="15.02" r="2.3" /><circle cx="16.6" cy="18.81" r="2.3" />
      <circle cx="18.6" cy="5.2" r="1.7" /><circle cx="4.8" cy="18.6" r="1.7" />
    </g>
  </svg>
);

/** A protected block on a read: the Footprints panel. TfFootprint is the footprint as a data object. */
export const Footprint = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 12h6.5M15.5 12h6.5" />
    <rect x="8.5" y="7" width="7" height="10" rx="2.2" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * A nucleosome-free region: two nucleosomes on a read, the accessibility peak rising
 * over the open gap between them (the Co-accessibility panel).
 */
export const NucleosomeFree = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M8 18h8M5 11c3.5 0 4.5-8 7-8s3.5 8 7 8" />
    <rect x="2" y="15" width="6" height="6" rx="1.8" fill="currentColor" stroke="none" />
    <rect x="16" y="15" width="6" height="6" rx="1.8" fill="currentColor" stroke="none" />
  </svg>
);

/** A genome-browser signal track: a long, low coverage lane on its baseline (the Tracks panel). */
export const SignalTrack = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 20h20" />
    <path d="M2 20v-2h1.5v-3H5v1h1.5v-4H8v-3h1.5v5H11V7h1.5v6H14v2h1.5v-5H17v3h1.5v3H20v-2h2v5z" fill="currentColor" stroke="none" />
  </svg>
);

/** A circular molecule (plasmid) with an origin mark. */
export const Plasmid = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M15.4 2.2l1.5 3.4-3.7.4" />
    <rect x="10" y="17.5" width="4" height="2" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

/** Transcription: a read with a transcription start (TSS) arrow. */
export const Transcription = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 18h20" />
    <path d="M7 18v-9h9" />
    <path d="M13 6l3 3-3 3" />
  </svg>
);

/** Primers: a forward and a reverse primer on a template. */
export const Primers = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 12h20" />
    <path d="M4 7h8M10 5l2 2-2 2" />
    <path d="M20 17h-8M14 15l-2 2 2 2" />
  </svg>
);

/** A contact map (the upper triangle of a matrix). */
export const ContactMap = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 20h20L12 4z" />
    <path d="M7 12l5 8 5-8" />
  </svg>
);

/** Peaks along a coverage track. */
export const Peaks = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M2 20h20" />
    <path d="M3 20c3 0 3.5-13 6-13s3 13 5.5 13 2.5-6 4-6 1.5 6 2.5 6" />
  </svg>
);

/** A chromosome (reference genome): two chromatids joined at the centromere. */
export const Chromosome = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M8 3c2 3 2 6 0 9s-2 6 0 9" />
    <path d="M16 3c-2 3-2 6 0 9s2 6 0 9" />
    <path d="M9.5 12h5" />
  </svg>
);

/** A DNA double helix (sequencing reads; a new DAF-seq run). */
export const Dna = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M7 2c0 5 10 5 10 10S7 17 7 22" />
    <path d="M17 2c0 5-10 5-10 10s10 5 10 10" />
    <path d="M8.5 5.5h7M8.5 18.5h7" />
  </svg>
);

/** A compute cluster (server rack) reached over SSH. */
export const Server = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <rect x="3" y="3" width="18" height="7" rx="2" />
    <rect x="3" y="14" width="18" height="7" rx="2" />
    <path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" />
  </svg>
);

/** A library of datasets. */
export const Library = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M4 4v16M8 4v16" />
    <path d="M12 5.5l3.9-1 4.1 15.5-3.9 1z" />
  </svg>
);

/**
 * The FiberBrowser mark, drawn from the app icon (public/assets/icons/favicon.svg):
 * the tile (#2a4fb5 -> #0f1a3d) with three reads, green nucleosomes, a fuchsia
 * TF footprint and the light-blue accessible column. The one multi-colour icon;
 * it does not follow currentColor.
 */
export const BrandMark = ({ size = 24, ...p }: IconProps) => {
  const uid = useId().replace(/:/g, '');
  const id = (name: string) => `fb-mark-${name}-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...p}>
      <defs>
        <linearGradient id={id('tile')} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#2a4fb5" />
          <stop offset="1" stopColor="#0f1a3d" />
        </linearGradient>
        <radialGradient id={id('sheen')} cx="0.28" cy="0.08" r="0.9">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('nuc')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6fd67b" />
          <stop offset="1" stopColor="#2b8f3d" />
        </linearGradient>
        <linearGradient id={id('tf')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fb8bff" />
          <stop offset="1" stopColor="#c026d3" />
        </linearGradient>
        <linearGradient id={id('beam')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9fdcf5" stopOpacity="0.2" />
          <stop offset="0.5" stopColor="#9fdcf5" stopOpacity="0.45" />
          <stop offset="1" stopColor="#9fdcf5" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill={`url(#${id('tile')})`} />
      <rect width="32" height="32" rx="7" fill={`url(#${id('sheen')})`} />
      <rect x="13" y="3" width="6" height="25" rx="3" fill={`url(#${id('beam')})`} />
      <g fill="#cbd5e1" opacity="0.22">
        <rect x="5" y="5" width="25" height="5" rx="2.5" />
        <rect x="2" y="13" width="25" height="5" rx="2.5" />
        <rect x="2" y="21" width="27" height="5" rx="2.5" />
      </g>
      <g fill={`url(#${id('nuc')})`}>
        <rect x="7" y="5" width="5" height="5" rx="1.5" />
        <rect x="20" y="5" width="5" height="5" rx="1.5" />
        <rect x="26" y="5" width="3" height="5" rx="1.5" />
        <rect x="3" y="13" width="3" height="5" rx="1.5" />
        <rect x="7" y="13" width="5" height="5" rx="1.5" />
        <rect x="20" y="13" width="5" height="5" rx="1.5" />
        <rect x="3" y="21" width="3" height="5" rx="1.5" />
        <rect x="7" y="21" width="5" height="5" rx="1.5" />
        <rect x="20" y="21" width="5" height="5" rx="1.5" />
        <rect x="26" y="21" width="2" height="5" rx="1" />
      </g>
      <rect x="15" y="5" width="2" height="5" rx="1" fill={`url(#${id('tf')})`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="6.5" fill="none" stroke="#ffffff" strokeOpacity="0.08" />
    </svg>
  );
};

/** Highlight a region: a band across the track with its two edges (the Highlight action). */
export const Highlighter = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M3 20h18" />
    <path d="M8 4v13M16 4v13" />
    <path d="M8 8h8M8 12.5h8" strokeOpacity="0.55" />
  </svg>
);

/** A saved region (Regions panel bookmarks). */
export const Bookmark = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
  </svg>
);

/** Bring a file in (import). */
export const Upload = ({ size, ...p }: IconProps) => (
  <svg {...iconDefaults(size)} {...p}>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <path d="M17 8l-5-5-5 5M12 3v12" />
  </svg>
);

