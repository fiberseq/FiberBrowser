import { useMemo, useState, useEffect } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { getAnnotationProfile } from '../../../api/annotations';
import { AnalysisButton, AnalysisStatus } from '../shared';
import { downloadTextFile, exportTimestamp, formatTsv, safeFilenamePart } from '../../../utils/analysisExport';

export function ProfileTab() {
  const {
    annotationFiles,
    annotationColors,
    chrom, start, end,
    datasets,
  } = useBrowserStore(useShallow(s => ({
    annotationFiles: s.annotationFiles,
    annotationColors: s.annotationColors,
    chrom: s.chrom, start: s.start, end: s.end,
    datasets: s.datasets,
  })));

  const [profiles, setProfiles] = useState<Record<string, number[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uniqueTypes = useMemo(() => {
    const allTypes = annotationFiles
      .filter(f => f.active)
      .flatMap(f => f.annotationTypes ?? []);
    return [...new Map(allTypes.map(t => [t.name, t])).values()];
  }, [annotationFiles]);
  const typeNames = useMemo(() => uniqueTypes.map(t => t.name), [uniqueTypes]);
  const typeKey = typeNames.join('\0');
  const datasetId = datasets[0]?.id ?? null;

  useEffect(() => {
    if (typeNames.length === 0 || !chrom || end <= start || !datasetId) {
      setProfiles({});
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    getAnnotationProfile(chrom, start, end, datasetId, typeNames, undefined, { signal: controller.signal })
      .then(res => {
        if (!controller.signal.aborted) setProfiles(res.profiles);
      })
      .catch(err => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        console.error(err);
        setError('Failed to load annotation profile');
        setProfiles({});
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [chrom, start, end, datasetId, typeKey]);

  if (loading) {
    return (
      <AnalysisStatus kind="loading" compact>
        Loading profile...
      </AnalysisStatus>
    );
  }

  if (error) {
    return (
      <AnalysisStatus kind="error" compact title="Profile failed">
        {error}
      </AnalysisStatus>
    );
  }

  const profiledTypeNames = Object.keys(profiles);
  if (profiledTypeNames.length === 0) {
    return (
      <AnalysisStatus kind="empty" compact title="No profile data">
        Activate annotation files first.
      </AnalysisStatus>
    );
  }

  // Find max value for Y-axis scaling
  const maxVal = Math.max(1, ...profiledTypeNames.flatMap(t => profiles[t]));

  const exportProfileTsv = () => {
    const rows: unknown[][] = [[
      'annotation_type', 'dataset_id', 'chrom', 'bin_index',
      'bin_start', 'bin_end', 'value', 'color',
    ]];
    for (const typeName of profiledTypeNames) {
      const data = profiles[typeName] ?? [];
      const binWidth = data.length > 0 ? (end - start) / data.length : 0;
      data.forEach((value, index) => {
        rows.push([
          typeName, datasetId, chrom, index,
          start + index * binWidth, start + (index + 1) * binWidth,
          value, annotationColors[typeName] || '#6366f1',
        ]);
      });
    }
    downloadTextFile(
      formatTsv(rows),
      `annotation_profile_${safeFilenamePart(chrom)}_${start}-${end}_${exportTimestamp()}.tsv`,
      'text/tab-separated-values',
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-gray-500">Annotation density across viewport.</div>
        <AnalysisButton onClick={exportProfileTsv} variant="neutral" size="xs">
          Export TSV
        </AnalysisButton>
      </div>

      <svg width="100%" viewBox="0 0 500 120" className="border border-gray-200 dark:border-white/10 rounded bg-white dark:bg-gray-900">
        {profiledTypeNames.map(typeName => {
          const data = profiles[typeName];
          if (!data || data.length === 0) return null;
          const color = annotationColors[typeName] || '#6366f1';
          const points = data.map((v, i) =>
            `${(i / data.length) * 500},${120 - (v / maxVal) * 110}`
          ).join(' ');
          return (
            <polyline
              key={typeName}
              points={points}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              opacity={0.8}
            />
          );
        })}
      </svg>

      <div className="flex flex-wrap gap-2">
        {profiledTypeNames.map(typeName => (
          <div key={typeName} className="flex items-center gap-1 text-[11px]">
            <span
              className="w-3 h-0.5 inline-block rounded"
              style={{ backgroundColor: annotationColors[typeName] || '#6366f1' }}
            />
            {typeName}
          </div>
        ))}
      </div>
    </div>
  );
}
