import { CLASS_REGION_MODES, CLASS_REGION_CHOICE_LABEL, type ClassRegionMode } from '../../../utils/classRegion';

/** Shared region choices for analyses, with an explicit pooled-region option. */
export function ClassRegionChoice({line,source=null,mode,onChoose,disabled=false,peaksAvailable,peaksTitle,savedRegion,short,viewChosen,matchedAvailable=false,prefix='class'}:{
  line:string|null;source?:string|null;mode:ClassRegionMode|null;onChoose:(mode:ClassRegionMode)=>void;disabled?:boolean;
  prefix?:string;matchedAvailable?:boolean;peaksAvailable:boolean;peaksTitle?:string;savedRegion:string|null;short:boolean;viewChosen:boolean}){
  const options=CLASS_REGION_MODES.filter(m=>(m!=='region'||savedRegion||mode==='region')&&(m!=='matched'||matchedAvailable||mode==='matched'));
  return <div data-testid={`${prefix}-region`} data-source={source??undefined} className="space-y-1 text-[12px]">
    <p data-testid={`${prefix}-region-line`} className="text-ink-muted">Analyses: <span className="tabular-nums text-gray-900 dark:text-gray-100">{line??'choose one of the panels’ regions'}</span></p>
    <div role="group" aria-label="Region to analyse" className="inline-flex flex-wrap rounded-fb border border-line text-[11px] dark:border-white/15">
      {options.map(m=>{const on=mode===m;const off=disabled||m==='peaks'&&!peaksAvailable&&!on;
        return <button key={m} type="button" data-testid={`${prefix}-region-${m}`} aria-pressed={on} disabled={off}
          title={m==='peaks'?(peaksTitle??'From the first selected peak to the last'):m==='matched'?'One pooled analysis in the selected regions’ orientation':m==='view'?'What the targeted panels show':`Saved region ${savedRegion??''} (Regions)`}
          onClick={()=>onChoose(m)}
          className={`px-2 py-px disabled:opacity-40 ${on?'bg-gray-900 text-white dark:bg-gray-200 dark:text-gray-900':'text-ink-muted hover:bg-surface-sunken'}`}>{CLASS_REGION_CHOICE_LABEL[m]}</button>;})}
    </div>
    {short&&<p data-testid={`${prefix}-region-short`} role="status" className="text-[11px] text-amber-700 dark:text-amber-400">
      Short region: classes near its edges may be missed{viewChosen?' — zoom out to include more around it.':' — try This view.'}</p>}
  </div>;
}

