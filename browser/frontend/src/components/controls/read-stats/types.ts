import type { PerReadStats } from '../../../api/readStats';

export type ReadStatsDisplayRow = PerReadStats & { viewer_order?: number };
