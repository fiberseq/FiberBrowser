import { useEffect, useRef } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { getAnalysisPanel } from '../plugins/registry';

/**
 * `?panel=<type>` (e.g. `?panel=graph-view`): open that analysis panel once the page has its reference and its
 * first panel, so a link (a demo, a bug report) shows it. Nothing happens for an unknown type, a panel the page
 * cannot offer (host-only on a public server, a Preview feature while previews are off), or a type already open.
 */
export function urlPanelType(search: string): string | null {
  const type = new URLSearchParams(search).get('panel');
  return type && /^[a-z][a-z0-9-]{0,40}$/.test(type) ? type : null;
}

export function useUrlPanel(): void {
  const done = useRef(false);
  const ready = useBrowserStore(s => s.chroms.length > 0 && s.panels.some(p => p.contentType === 'dataset'));
  useEffect(() => {
    if (done.current || !ready) return;
    done.current = true;
    const type = urlPanelType(window.location.search);
    if (!type || !getAnalysisPanel(type)) return;
    const state = useBrowserStore.getState();
    if (state.panels.some(p => p.contentType === type)) return;
    state.openAnalysisPanel(type as never);
  }, [ready]);
}
