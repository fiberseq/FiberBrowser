import {useBrowserStore} from '../../../../stores/browserStore';
import {useEffect,useState} from 'react';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';

export const UI_SCALE_SETTINGS = defineSettings({
  uiScale: {
    id: 'view.ui-size',
    label: 'UI size',
    keywords: ['zoom interface', 'text size', 'font size', 'scale', 'bigger', 'smaller', 'hidpi'],
    location: inSidebar('view.display'),
  },
});

export function UiScaleSettings(){
  const scale=useBrowserStore(s=>s.uiScale);
  const setScale=useBrowserStore(s=>s.setUiScale);
  const [draft,setDraft]=useState(String(Math.round(scale*100)));
  useEffect(()=>setDraft(String(Math.round(scale*100))),[scale]);
  const commit=()=>{
    if(draft.trim()!==''&&Number.isFinite(Number(draft)))setScale(Number(draft)/100);
    setDraft(String(Math.round(useBrowserStore.getState().uiScale*100)));
  };
  return <div className="space-y-1 text-xs" data-testid="ui-scale-settings" {...settingAnchor(UI_SCALE_SETTINGS.uiScale)}>
    <label className="flex items-center justify-between gap-2">
      <span>{UI_SCALE_SETTINGS.uiScale.label}</span>
      <span className="flex items-center gap-1"><input aria-label="UI size percent" type="number" min="50" max="400" step="10"
        className="w-16 rounded border px-1 bg-transparent" value={draft}
        onChange={e=>setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e=>{if(e.key==='Enter')commit();}}/>%</span>
    </label>
    <div className="flex items-center gap-2"><input aria-label="UI size" className="min-w-0 flex-1 h-4" type="range" min="50" max="400" step="10"
      value={Math.round(scale*100)} onChange={e=>setScale(Number(e.target.value)/100)}/>
    <button type="button" className="text-[11px] underline whitespace-nowrap" onClick={()=>setScale(1)}>Reset (100%)</button></div>
    <p className="text-[11px] text-gray-500">50–400%. Export resolution is separate.</p>
  </div>;
}
