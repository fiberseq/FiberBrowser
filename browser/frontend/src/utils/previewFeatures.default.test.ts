import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_STORAGE_KEY, previewDefault, previewsEnabled, resetPreviewsForTests, setPreviewDefault, setPreviewsEnabled } from './previewFeatures';

describe('preview switch preference', () => {
  afterEach(() => {
    localStorage.removeItem(PREVIEW_STORAGE_KEY);
    resetPreviewsForTests(false);
  });

  it('is off before the release pack sets its default', () => {
    localStorage.removeItem(PREVIEW_STORAGE_KEY);
    resetPreviewsForTests(false);
    expect(previewDefault()).toBe(false);
    expect(previewsEnabled()).toBe(false);
  });

  it('the release default turns it on when the user chose nothing', () => {
    localStorage.removeItem(PREVIEW_STORAGE_KEY);
    resetPreviewsForTests(false);
    setPreviewDefault(true);
    expect(previewDefault()).toBe(true);
    expect(previewsEnabled()).toBe(true);
  });

  it("the user's own choice wins over the release default", () => {
    resetPreviewsForTests(false);
    setPreviewsEnabled(true);
    setPreviewsEnabled(false);       // stored: 'false'
    setPreviewDefault(true);
    expect(previewsEnabled()).toBe(false);
  });
});
