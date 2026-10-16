// Jupyter integration types

export interface JupyterHighlight {
  id: string;
  type: 'read' | 'footprint';
  color: string;
  label?: string;
  dataset_id: string;
  read_ids?: string[];
  footprints?: Array<{ read_id: string; footprint_idx?: number; start?: number; end?: number }>;
}

export interface JupyterMarker {
  id: string;
  group: string;
  markers: Array<{ position: number; color: string; label?: string }>;
}

export interface JupyterFootprintColor {
  id: string;
  group: string;
  footprint_colors: Record<string, Array<{ start: number; end: number; color: string }>>;
}
