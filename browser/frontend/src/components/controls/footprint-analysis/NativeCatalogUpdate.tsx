import type {NativeCatalogUpdate as CatalogUpdate,NativeModelOrigin} from '../../../api/consensusWorkflow';

/** Provenance only: never infer a preservation guarantee from family IDs or a request. */
export function NativeCatalogUpdateSummary({update}:{update?:CatalogUpdate|null}) {
  if(!update)return <p className="text-[11px] text-gray-500">Catalog update provenance unavailable for this run.</p>;
  const original=update.original_family_count?.toLocaleString()??'unrecorded';
  const added=update.added_family_count?.toLocaleString()??'unrecorded';
  const append=update.policy==='append_frozen';
  return <div data-testid="native-catalog-update" className="text-[11px] space-y-0.5">
    <p>Catalog update: {append?'append frozen':update.policy.replace(/_/g,' ')} · {original} original / {added} added classes.</p>
    <p className="text-gray-500">{append
      ?'Original models and candidate evidence preserved; added alternatives may change the primary label. This is not a joint occupancy fit or an accuracy guarantee.'
      :update.policy==='refit_catalog'
        ?'This policy refits models when proposals are added; original class IDs alone do not guarantee preserved models or candidate evidence.'
        :'No model-preservation guarantee is inferred from this policy label.'}</p>
    <details><summary>Catalog snapshot digests</summary>
      <p className="break-all">Initial: {update.initial_snapshot_digest??'unavailable'}</p>
      <p className="break-all">Augmented: {update.augmented_snapshot_digest??'unavailable'}</p>
    </details>
  </div>;
}

export function NativeModelVersion({provenance}:{provenance?:NativeModelOrigin|null}) {
  if(!provenance)return <p className="text-gray-500">Model origin / version unavailable for this run.</p>;
  const label=provenance.origin==='initial_frozen'?'initial model · frozen'
    :provenance.origin==='augmented_new'?'newly appended model':provenance.origin.replace(/_/g,' ');
  return <div data-testid="native-model-version">
    <p>Model origin: {label}. Version {provenance.model_version_sha256?.slice(0,12)??'unavailable'}.</p>
    <details><summary>Model version / producer snapshot</summary>
      <p className="break-all">Model SHA-256: {provenance.model_version_sha256??'unavailable'}</p>
      <p className="break-all">Producer snapshot: {provenance.producer_snapshot_digest??'unavailable'}</p>
    </details>
  </div>;
}
