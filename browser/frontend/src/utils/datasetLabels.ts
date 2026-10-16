import type { Dataset } from '../types/dataset';

type DatasetLabelSource = Pick<Partial<Dataset>, 'id' | 'label' | 'path' | 'paths' | 'sample'>;

const DATASET_EXTENSIONS = [
  '.recalled.bam',
  '.bam',
  '.cram',
  '.bigbed',
  '.bb',
  '.bed.gz',
  '.bed',
  '.bw',
  '.bigwig',
];

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function stripDatasetExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of DATASET_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return name.slice(0, -ext.length);
    }
  }
  return name.replace(/\.[^.]+$/, '');
}

function truncateLabel(label: string, maxLength: number): string {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, Math.max(1, maxLength - 3))}...`;
}

function labelParts(label: string): string[] {
  return label.split(/\s+\+\s+/).map(part => part.trim()).filter(Boolean);
}

function pathParts(dataset: DatasetLabelSource): string[] {
  const paths = dataset.paths?.length ? dataset.paths : dataset.path ? [dataset.path] : [];
  return paths.map(path => stripDatasetExtension(basename(path))).filter(Boolean);
}

export function getDatasetSourceNames(
  dataset: DatasetLabelSource | undefined,
): string[] {
  if (!dataset) return [];
  const paths = pathParts(dataset);
  if (paths.length > 0) return paths;
  const label = dataset.label || dataset.id || '';
  return labelParts(label || String(dataset.id || 'Dataset'));
}

export function getDatasetDisplayLabel(
  dataset: DatasetLabelSource | undefined,
  maxLength = 36,
): string {
  if (!dataset) return 'Dataset';

  const label = dataset.label || dataset.id || 'Dataset';
  const parts = labelParts(label);
  if (parts.length > 2) {
    const first = truncateLabel(parts[0], Math.min(22, Math.max(10, maxLength - 12)));
    return `${first} + ${parts.length - 1} more`;
  }

  const paths = pathParts(dataset);
  if (paths.length > 2 && label.length > maxLength) {
    const first = truncateLabel(paths[0], Math.min(22, Math.max(10, maxLength - 12)));
    return `${first} + ${paths.length - 1} more`;
  }

  return truncateLabel(label, maxLength);
}

export function getDatasetHoverLabel(
  dataset: DatasetLabelSource | undefined,
): string {
  if (!dataset) return 'Dataset';
  const label = dataset.label || dataset.id || 'Dataset';
  const paths = dataset.paths?.length ? dataset.paths : dataset.path ? [dataset.path] : [];
  if (paths.length === 0) return dataset.sample && dataset.sample !== label ? `${label}\nSample: ${dataset.sample}` : label;

  // The name, then the sample name when it says something else (N9: the file stem is the name everywhere, the
  // sample second), then the source file(s) unless the name is just the one file's stem.
  const sample = dataset.sample?.trim();
  const head = sample && sample !== label ? `${label}\nSample: ${sample}` : label;
  const stems = paths.map(path => stripDatasetExtension(basename(path)));
  if (stems.length === 1 && stems[0] === label) return head;
  return `${head}\n\n${paths.length === 1 ? 'Source' : `${paths.length} sources`}:\n${stems.join('\n')}`;
}

/** A dataset with its sample name kept for display (N9), when there is one that says more than its name. */
export function withSample<T extends DatasetLabelSource>(dataset: T, sample: string | null | undefined): T {
  const name = sample?.trim();
  return name && name !== dataset.label ? { ...dataset, sample: name } : dataset;
}
