import { describe, expect, it } from 'vitest';
import { urlPanelType } from './useUrlPanel';

describe('?panel= on a link', () => {
  it('takes a panel type name and nothing else', () => {
    expect(urlPanelType('?chr=chr3&start=1&end=2&panel=graph-view')).toBe('graph-view');
    expect(urlPanelType('?panel=')).toBeNull();
    expect(urlPanelType('?panel=../x')).toBeNull();
    expect(urlPanelType('?chr=chr3')).toBeNull();
  });
});
