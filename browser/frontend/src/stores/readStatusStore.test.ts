import { beforeEach, describe, expect, it } from 'vitest';
import { useReadStatusStore } from './readStatusStore';

describe('readStatusStore (the read count shown in each panel header)', () => {
  beforeEach(() => useReadStatusStore.setState({ byStateKey: {} }));

  it('keeps one status per panel state key and clears it when the track goes', () => {
    const { setStatus } = useReadStatusStore.getState();
    setStatus('primary', { text: '584/3,170 visible', title: 't' });
    setStatus('primary::copy', { text: '12 reads', title: 't2' });
    expect(useReadStatusStore.getState().byStateKey.primary.text).toBe('584/3,170 visible');
    setStatus('primary', null);
    expect(useReadStatusStore.getState().byStateKey).toEqual({ 'primary::copy': { text: '12 reads', title: 't2' } });
  });

  it('does not notify subscribers when the status is unchanged', () => {
    const { setStatus } = useReadStatusStore.getState();
    setStatus('primary', { text: '10 reads', title: 't' });
    const before = useReadStatusStore.getState().byStateKey;
    setStatus('primary', { text: '10 reads', title: 't' });
    expect(useReadStatusStore.getState().byStateKey).toBe(before);
  });
});
