/** Layer measures take the user's layer colours (getLayerColor), resolved when drawn, so a colour change reaches them. */
import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { registerLayerColours } from '../layerColours/state';
import { getDefaultLayerColor } from '../../utils/layerColors';
import { measureColor } from './labels';

registerLayerColours();

describe('measureColor', () => {
  it('a layer measure follows the session colour; other measures keep their own', () => {
    useBrowserStore.setState({ layerColorOverrides: {}, userLayerColors: {} } as never);
    expect(measureColor({ id: 'layer:nuc', color: '#000000' })).toBe(getDefaultLayerColor('nuc'));
    useBrowserStore.setState({ layerColorOverrides: { nuc: '#ff0000' } } as never);
    expect(measureColor({ id: 'layer:nuc', color: '#000000' })).toBe('#ff0000');
    expect(measureColor({ id: 'size:band', color: '#7c3aed' })).toBe('#7c3aed');
    expect(measureColor({ id: 'fam:x|y' })).toBeUndefined();
    useBrowserStore.setState({ layerColorOverrides: {} } as never);
  });
});
