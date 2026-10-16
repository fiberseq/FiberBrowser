import { useCallback, useState } from 'react';
import { downloadPeaksBed } from '../../../utils/dataExportActions';
import type { FirePeak, PeakRule } from '../../../types';
import { DEFAULT_PEAK_RULES } from '../../../types';
import { parsePeakBed } from '../../../utils/peakBed';
import { importPeakEntriesToBrowser } from '../../../utils/peakImport';
import { useBrowserStore } from '../../../stores/browserStore';

function downloadTextFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

interface UsePeakImportExportArgs {
  peakRules: PeakRule[];
  setPeakRules: (rules: PeakRule[]) => void;
  chrom: string;
  start: number;
  end: number;
  selectedPeaks: Set<number>;
  getAllPeaks: () => FirePeak[];
}

export function usePeakImportExport({
  peakRules,
  setPeakRules,
  selectedPeaks,
  getAllPeaks,
}: UsePeakImportExportArgs) {
  const [peakBedStatus, setPeakBedStatus] = useState<string | null>(null);

  const handleExportJSON = useCallback(() => {
    downloadTextFile(
      JSON.stringify({ name: 'Peak Rules', rules: peakRules }, null, 2),
      'peak_rules.json',
      'application/json',
    );
  }, [peakRules]);

  const handleImportJSON = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (parsed.rules && Array.isArray(parsed.rules)) {
          setPeakRules(parsed.rules);
        }
      } catch (err) {
        console.error('Failed to import peak rules:', err);
      }
    };
    input.click();
  }, [setPeakRules]);

  // The same BED(s) as Export data > Peaks (utils/dataExportActions.ts): one per reference.
  const handleExportPeakBED = useCallback((selectedOnly: boolean) => {
    const count = selectedOnly ? selectedPeaks.size : getAllPeaks().length;
    if (count === 0) return;
    const saved = downloadPeaksBed(useBrowserStore.getState(), selectedOnly);
    if (saved) setPeakBedStatus(`${saved.replace(/^Saved/, 'Exported')}.`);
  }, [getAllPeaks, selectedPeaks]);

  const handleImportPeakBED = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bed,.tsv,.txt';
    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const parsed = parsePeakBed(await file.text());
        const result = importPeakEntriesToBrowser({ entries: parsed });

        if (result.imported === 0) {
          const skipped = parsed.length > 0 ? ` Found ${parsed.length} peak${parsed.length !== 1 ? 's' : ''} on other chromosome(s).` : '';
          setPeakBedStatus(`No peaks for current chromosome ${result.chrom}.${skipped}`);
          return;
        }

        setPeakBedStatus(
          `Imported ${result.imported} peak${result.imported !== 1 ? 's' : ''} from ${file.name}; peaks locked` +
          (result.skipped > 0 ? ` (${result.skipped} skipped on other chromosome${result.skipped !== 1 ? 's' : ''})` : ''),
        );
      } catch (err) {
        console.error('Failed to import peak BED:', err);
        setPeakBedStatus(err instanceof Error ? `Peak BED import failed: ${err.message}` : 'Peak BED import failed.');
      }
    };
    input.click();
  }, []);

  const handleResetDefaults = useCallback(() => {
    setPeakRules(DEFAULT_PEAK_RULES.map(rule => ({ ...rule })));
  }, [setPeakRules]);

  return {
    peakBedStatus,
    setPeakBedStatus,
    handleExportJSON,
    handleImportJSON,
    handleExportPeakBED,
    handleImportPeakBED,
    handleResetDefaults,
  };
}
