import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {ClusterFeatureRulesEditor} from './ClusterFeatureRulesEditor';
import {normalizeClusterFeatureRules} from '../../../stores/utils';

it('offers saved classes and preserves their run identity through rule normalization',()=>{
  const group={id:'g',name:'Promoter class',consensusStateId:'A',consensusJobId:'j',sourceDatasetId:'d',
    enabled:true,color:'#f00',sourceIndex:-1,sizeMin:0,sizeMax:null,overlapFraction:0};
  const rules=normalizeClusterFeatureRules([{id:'r',enabled:true,terms:[{id:'t',source:'footprint_class',
    footprintGroupId:'g',group}]}]);
  expect(rules[0].terms[0].source).toBe('footprint_class');
  expect(rules[0].terms[0].group).toMatchObject({consensusStateId:'A',consensusJobId:'j',sourceDatasetId:'d'});
  const noop=vi.fn();
  const html=renderToStaticMarkup(<ClusterFeatureRulesEditor rules={rules} savedRuleSets={[]} activeLabelRules={[]}
    footprintGroups={[group]} layerOptions={[{value:'tf',label:'TF'}]} onAddRule={noop} onUpdateRule={noop}
    onRemoveRule={noop} onSetRules={noop} onSaveRuleSet={noop} onLoadRuleSet={noop} onDeleteRuleSet={noop} onSetDefaultRuleSet={noop}/>);
  expect(html).toContain('Footprint class');
  expect(html).toContain('Promoter class');
  expect(html).toContain('Exact primary assignment');
});
