// Re-export from the refactored read-track module
// This file maintains backward compatibility for existing imports
export {
  ReadTrack,
  CLUSTER_COLORS,
  UNASSIGNED_CLUSTER_ID,
  UNASSIGNED_CLUSTER_COLOR,
  getClusterColor,
  getClusterLabel,
} from './read-track';
export type { CompactRead, ReadsResponse, CigarEvent, ReadTrackProps } from './read-track';
