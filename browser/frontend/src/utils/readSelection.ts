/**
 * Read ID lists in and out (fb-r4-clicks): the names of the selected reads
 * (copy, export, downstream t-SNE or other analysis), and a pasted list
 * of names to select and highlight.
 *
 * For fb-r4-export's "Export data" menu: `selectedReadNamesByPanel()` /
 * `selectedReadNames()` give the selection; `formatReadNameList()` (utils/readNames)
 * writes it one name per line; `importReadNames()` takes a list back.
 */
import { useBrowserStore } from '../stores/browserStore';
import { goToReads, type GoToReadsResult } from './readLocate';
import { parseReadNames } from './readNames';

export interface PanelReadNames {
  /** The panel's per-panel state key (selection, filters). */
  stateKey: string;
  datasetId: string | null;
  /** The dataset's name as shown. */
  label: string;
  /** Read names as the panel has them (the files' query names), in selection order. */
  names: string[];
}

type SelectionState = Pick<ReturnType<typeof useBrowserStore.getState>, 'selectedReadIds' | 'panels' | 'datasets'>;

/** The selected reads of each panel that has any. */
export function selectedReadNamesByPanel(state: SelectionState = useBrowserStore.getState()): PanelReadNames[] {
  const out: PanelReadNames[] = [];
  for (const [stateKey, ids] of Object.entries(state.selectedReadIds ?? {})) {
    if (!ids || ids.size === 0) continue;
    const panel = state.panels.find(p => (p.stateKey ?? p.datasetId ?? p.id) === stateKey);
    const datasetId = panel?.datasetId ?? (state.datasets.some(d => d.id === stateKey) ? stateKey : null);
    const dataset = state.datasets.find(d => d.id === datasetId);
    out.push({
      stateKey,
      datasetId,
      label: dataset?.label ?? datasetId ?? stateKey,
      names: [...new Set(ids)],
    });
  }
  return out;
}

/** Every selected read's name, once. */
export function selectedReadNames(state: SelectionState = useBrowserStore.getState()): string[] {
  return [...new Set(selectedReadNamesByPanel(state).flatMap(p => p.names))];
}

/** Names from pasted text: one per line, or separated by commas, semicolons or spaces. */
export function readNamesFromText(text: string): string[] {
  return parseReadNames(`read: ${text}`) ?? [];
}

/**
 * Select and highlight the reads of a list of names (found in the open
 * datasets), going to them unless `navigate` is false.
 */
export async function importReadNames(
  names: string[] | string,
  options: { navigate?: boolean; signal?: AbortSignal; onProgress?: (label: string) => void } = {},
): Promise<GoToReadsResult> {
  const list = typeof names === 'string' ? readNamesFromText(names) : [...new Set(names.map(n => n.trim()).filter(Boolean))];
  if (list.length === 0) {
    return { ok: false, found: [], notFound: [], cancelled: false, message: 'No read names in the text.' };
  }
  return goToReads(list, { select: true, navigateTo: options.navigate ?? true, signal: options.signal, onProgress: options.onProgress });
}
