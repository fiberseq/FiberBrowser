/** Window event for tutorial milestones that leave no trace in the store (saving a session). */
export const TUTORIAL_EVENT = 'fiberbrowser:tutorial-event';

export function emitTutorialEvent(id: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TUTORIAL_EVENT, { detail: id }));
}
