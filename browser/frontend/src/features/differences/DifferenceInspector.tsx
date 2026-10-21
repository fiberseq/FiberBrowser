import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react';
import type { Dataset, PanelConfig } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { useDifferenceSelection } from '../liveLift/inspectionStore';
import { AssemblyInspection } from './AssemblyInspection';
import { NativeInspector } from './NativeInspector';
import { SavedDifferences } from './SavedDifferences';
import { GraphInspectorHost } from '../graphPanel/GraphInspector';
import '../graphPanel/selectionStore';

const Hosted=createContext(false);
type Props={panel:PanelConfig;dataset:Dataset;anchor:RefObject<HTMLDivElement|null>};
function InspectorContent(props:Props){
  const selection=useDifferenceSelection(s=>s.selection);
  if(!selection||selection.panelId!==props.panel.id||selection.inspect===false)return null;
  const key=`${selection.datasetId}|${selection.chrom}|${selection.difference.id}|${selection.target?.revision??1}`;
  return props.dataset.data_type==='bam'?<NativeInspector key={key} {...props} selection={selection}/>:<AssemblyInspection key={key} {...props}/>;
}
/** Compatibility mount for independently embedded tracks and component clients. */
export function DifferenceInspector(props:Props){
  const hosted=useContext(Hosted);
  return hosted?null:<InspectorContent {...props}/>;
}
/** One host survives hidden tracks, closed source panels and table-only actions. */
export function DifferenceInspectorRoot({children}:{children:ReactNode}){
  // A graph selection (graph difference or graph locus) is dispatched first: it never needs a dataset.
  const graphSelected=useBrowserStore(s=>Boolean(s.graphSelection));
  const selection=useDifferenceSelection(s=>s.selection);
  const dataset=useBrowserStore(s=>s.datasets.find(d=>d.id===selection?.datasetId));
  const panel=useBrowserStore(s=>s.panels.find(p=>p.id===selection?.panelId));
  const anchor=useRef<HTMLDivElement|null>(null);
  return <Hosted.Provider value={true}>{children}<div ref={anchor}/><SavedDifferences/>
    {graphSelected&&<GraphInspectorHost/>}
    {!graphSelected&&selection&&selection.inspect!==false&&(dataset?<InspectorContent dataset={dataset} panel={panel??{id:selection.panelId,datasetId:dataset.id} as PanelConfig} anchor={anchor}/>
      :<div role="dialog" aria-label="Unresolved difference" className="fixed z-[100] top-16 left-4 p-3 bg-white dark:bg-slate-900 border rounded">
        <p>Source unavailable · cached {selection.difference.kind} {selection.difference.ref_bp}→{selection.difference.alt_bp} bp</p>
        <p>Reopen or relink the saved source to inspect its reads. The frozen target remains selected.</p>
        <button onClick={()=>useDifferenceSelection.getState().select(null)}>Close</button>
      </div>)}
  </Hosted.Provider>;
}
