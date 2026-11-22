/** Quantify a window (WINDOW_QUANT.md): its saved state and the built-in measure sources. Called from features/plots/register.ts. */
import { registerWindowQuantState } from './store';
import './sources';

let done = false;

export function registerWindowQuant(): void {
  if (done) return;
  done = true;
  registerWindowQuantState();
}
