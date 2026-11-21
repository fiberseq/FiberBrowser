import { useBrowserStore } from '../stores/browserStore';

/** The read track's duplicate and QC-fail toggles for requests to paths that read BAM records themselves
 *  (the dense loader's meta profiles, DAF-C selections and linked reads, autozoom, lift difference reads):
 *  ``include_duplicates=true`` / ``include_qcfail=true`` when the toggles show those reads (the server hides
 *  them by default, services/signal_evidence.py). An explicit value already in the params is kept. */
export function readPolicyParams(params: URLSearchParams): URLSearchParams {
  const { showDuplicateReads, showQcFailReads } = useBrowserStore.getState();
  const next = new URLSearchParams(params);
  if (showDuplicateReads && !next.has('include_duplicates')) next.set('include_duplicates', 'true');
  if (showQcFailReads && !next.has('include_qcfail')) next.set('include_qcfail', 'true');
  return next;
}

/** ``url`` with the read policy's parameters appended (unchanged at the default: both hidden). */
export function readPolicyUrl(url: string): string {
  const [path, query = ''] = url.split('?');
  const params = readPolicyParams(new URLSearchParams(query));
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}
