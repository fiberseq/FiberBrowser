import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConsensusFitStatus} from './ConsensusFitStatus';

describe('consensus numerical status',()=>{
  it('does not equate finished jobs or an unreported fit with convergence',()=>{
    expect(renderToStaticMarkup(<ConsensusFitStatus/>)).toContain('unreported');
    const text=renderToStaticMarkup(<ConsensusFitStatus fit={{status:'numerically_provisional',selected_converged:false,starts:2,iterations:160}}/>);
    expect(text).toContain('role="alert"');expect(text).toContain('did not converge');
    expect(text).toContain('calls are retained');
  });
  it('reports the measured converged iteration count without claiming calibration',()=>{
    const text=renderToStaticMarkup(<ConsensusFitStatus fit={{status:'converged',selected_converged:true,starts:2,iterations:518}}/>);
    expect(text).toContain('518 iterations');expect(text).not.toContain('role="alert"');
  });
});
