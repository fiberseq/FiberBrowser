import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConsensusBamExport} from './ConsensusBamExport';

describe('family BAM export',()=>{
  it('offers current dataset grouping by default and original files as an alternative',()=>{
    const html=renderToStaticMarkup(<ConsensusBamExport jobId="run1"/>);
    expect(html).toContain('MA/AQ/AN');
    expect(html).toContain('value="regions" selected=""');
    expect(html).toContain('Full source BAMs');
    expect(html).toContain('value="datasets" selected=""');
    expect(html).toContain('One BAM per original source file');
    expect(html).toContain('Save tagged BAMs');
    expect(html).toContain('Output folder');
    expect(html).toContain('source BAMs are unchanged');
    expect(html).not.toContain('disabled=""');
  });
});
