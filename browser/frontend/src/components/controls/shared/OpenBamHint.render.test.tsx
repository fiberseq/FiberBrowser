import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const available = { library: true, open: true };
vi.mock('../../../utils/appCommands', () => ({
  APP_COMMAND_INFO: { library: { available: () => available.library }, 'open-file': { available: () => available.open } },
  runAppCommand: vi.fn(() => true),
}));
import { runAppCommand } from '../../../utils/appCommands';
import { OpenBamHint } from './OpenBamHint';

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<OpenBamHint />));
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}

describe('OpenBamHint (round 3 integration)', () => {
  afterEach(() => { available.library = true; available.open = true; vi.mocked(runAppCommand).mockClear(); });

  it('reads the same everywhere; its Library link runs the Library command', () => {
    const { container, done } = render();
    expect(container.textContent).toBe('Open a BAM or choose one in the Library');
    act(() => (container.querySelector('[data-testid="open-bam-hint-library"]') as HTMLButtonElement).click());
    expect(runAppCommand).toHaveBeenCalledWith('library');
    done();
  });

  it('no dead links where the commands are unavailable (public server, sandbox)', () => {
    available.library = false; available.open = false;
    const { container, done } = render();
    expect(container.textContent).toBe('Open a BAM or choose one in the Library');
    expect(container.querySelector('button')).toBeNull();
    done();
  });
});
