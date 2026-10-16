import { useEffect, useRef } from 'react';
import { registerAppCommand, type AppCommandHandler, type AppCommandName } from '../utils/appCommands';

/**
 * Expose a component's handler as an app command (the desktop menu bar,
 * `window.fiberbrowserCommand`). The latest handler runs; registered while mounted.
 */
export function useAppCommand(name: AppCommandName, handler: AppCommandHandler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => registerAppCommand(name, args => ref.current(args)), [name]);
}
