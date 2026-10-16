import {useState} from 'react';
import {exportConsensusBams,type ConsensusBamExport as ExportResult} from '../../../api/consensusWorkflow';
import {pickFolder} from '../../../api/files';

export function ConsensusBamExport({jobId}:{jobId:string}){
  const [folder,setFolder]=useState('');
  const [grouping,setGrouping]=useState<'datasets'|'files'>('datasets');
  const [scope,setScope]=useState<'regions'|'full'>('regions');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [result,setResult]=useState<ExportResult|null>(null);
  const run=async()=>{
    setBusy(true);setError('');setResult(null);
    try{
      let output=folder.trim();
      if(!output){
        const picked=await pickFolder('Select an empty folder for tagged BAMs');
        if(!picked.success||!picked.path)return;
        output=picked.path;setFolder(output);
      }
      setResult(await exportConsensusBams(jobId,output,grouping,scope));
    }
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  return <div className="space-y-1">
    <button className="rounded border border-emerald-700 bg-emerald-700 px-3 py-1 font-medium text-white disabled:opacity-40" disabled={busy} onClick={()=>void run()}>{busy?'Saving and indexing…':'Save tagged BAMs'}</button>
    <span className="ml-2 text-[11px] text-gray-500">Writes new files; source BAMs are unchanged.</span>
    <details className="text-[11px]"><summary className="cursor-pointer">Save options</summary><div className="mt-1 space-y-1 border rounded p-2 dark:border-gray-700">
    <label className="block">Output folder
      <div className="flex gap-1"><input aria-label="Class BAM output folder" className="block border rounded p-1 flex-1 dark:bg-gray-900" value={folder} disabled={busy} onChange={e=>setFolder(e.target.value)} placeholder="Choose when you save"/>
        <button className="border rounded px-2" disabled={busy} onClick={async()=>{const picked=await pickFolder('Select an empty folder for tagged BAMs');if(picked.success&&picked.path)setFolder(picked.path);}}>Choose…</button></div>
    </label>
    <label className="block">Contents
      <select aria-label="Family BAM contents" className="block border rounded p-1 w-full dark:bg-gray-900" value={scope} disabled={busy} onChange={e=>setScope(e.target.value as 'regions'|'full')}>
        <option value="regions">Analyzed regions only (default)</option>
        <option value="full">Full source BAMs</option>
      </select>
    </label>
    <label className="block">Grouping
      <select aria-label="Family BAM grouping" className="block border rounded p-1 w-full dark:bg-gray-900" value={grouping} disabled={busy} onChange={e=>setGrouping(e.target.value as 'datasets'|'files')}>
        <option value="datasets">One BAM per dataset as currently grouped</option>
        <option value="files">One BAM per original source file</option>
      </select>
    </label>
    <p className="text-gray-500">Automatic class assignments are saved in MA/AQ/AN tags with CSI indexes and run metadata. Manual display edits are not written. Use a new or empty output folder.</p>
    </div></details>
    {error&&<p role="alert" className="text-red-700">{error}</p>}
    {result&&<div role="status" className="text-[11px] text-emerald-700">Saved {result.outputs.length} BAM{result.outputs.length===1?'':'s'}.{result.outputs.map(row=><p key={row.bam} className="break-all">{row.bam} · {row.annotations} class memberships</p>)}</div>}
  </div>;
}
