import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindReadsControl } from './FindReadsControl';

const noop = () => {};

describe('FindReadsControl (a read panel with no reads in view)', () => {
  it('offers to go to the reads', () => {
    const html = renderToStaticMarkup(<FindReadsControl datasetId="d" label="NAPA" finding={false} message={null} onFind={noop} onCancel={noop} />);
    expect(html).toContain("Go to NAPA&#x27;s reads");
    expect(html).not.toContain('cancel-find-reads-d');
  });

  it('can be cancelled while it searches', () => {
    const html = renderToStaticMarkup(<FindReadsControl datasetId="d" label="NAPA" finding message={null} onFind={noop} onCancel={noop} />);
    expect(html).toContain('Finding reads…');
    expect(html).toContain('data-testid="cancel-find-reads-d"');
  });

  it('says why nothing was found', () => {
    const message = 'No reads from NAPA map to the loaded genome (dm6).';
    const html = renderToStaticMarkup(<FindReadsControl datasetId="d" label="NAPA" finding={false} message={message} onFind={noop} onCancel={noop} />);
    expect(html).toContain('data-testid="find-reads-message-d"');
    expect(html).toContain(message);
  });
});
