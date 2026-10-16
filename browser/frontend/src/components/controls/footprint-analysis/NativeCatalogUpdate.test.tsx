import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeCatalogUpdateSummary,NativeModelVersion} from './NativeCatalogUpdate';
import {NativeModelProvenance} from './NativeCrossDiagnostics';

describe('native catalog update provenance',()=>{
  it('shows append-only counts without promising primary-label or occupancy invariance',()=>{
    const html=renderToStaticMarkup(<NativeCatalogUpdateSummary update={{policy:'append_frozen',
      original_family_count:1200,added_family_count:7,initial_snapshot_digest:'initial',augmented_snapshot_digest:'augmented'}}/>);
    for(const text of ['append frozen','1,200 original / 7 added','candidate evidence preserved',
      'may change the primary label','not a joint occupancy fit','Initial: initial','Augmented: augmented'])expect(html).toContain(text);
  });
  it('describes the refit policy without asserting a second fit when no families were added',()=>{
    const html=renderToStaticMarkup(<NativeCatalogUpdateSummary update={{policy:'refit_catalog',
      original_family_count:2,added_family_count:0}}/>);
    expect(html).toContain('2 original / 0 added');expect(html).toContain('refits models when proposals are added');
    expect(html).not.toContain('catalog was refitted');
    expect(html).not.toContain('candidate evidence preserved');
  });
  it('does not invent metadata for old or unknown policies',()=>{
    expect(renderToStaticMarkup(<NativeCatalogUpdateSummary/>)).toContain('provenance unavailable');
    expect(renderToStaticMarkup(<NativeModelVersion/>)).toContain('origin / version unavailable');
    const html=renderToStaticMarkup(<NativeCatalogUpdateSummary update={{policy:'future_policy'}}/>);
    expect(html).toContain('No model-preservation guarantee');expect(html).toContain('unrecorded original / unrecorded added');
  });
  it('exposes the full version and producer hashes for initial and new models',()=>{
    for(const [origin,label] of [['initial_frozen','initial model · frozen'],['augmented_new','newly appended model']]){
      const html=renderToStaticMarkup(<NativeModelProvenance family={{family:'F',consensus_start:10,consensus_end:40,
        model_provenance:{origin,model_version_sha256:'1234567890abcdef',producer_snapshot_digest:'producer_sha'}}}/>);
      expect(html).toContain(label);expect(html).toContain('Version 1234567890ab.');
      expect(html).toContain('Model SHA-256: 1234567890abcdef');expect(html).toContain('Producer snapshot: producer_sha');
    }
  });
});
