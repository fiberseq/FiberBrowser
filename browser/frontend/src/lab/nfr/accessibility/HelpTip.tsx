/**
 * Accessibility (preview): a focusable "?" that explains a term: hovering or focusing it (Tab, or a click) shows the
 * text, which is also the button's description for screen readers. Used for the panel's terms (callable, closed %,
 * the interval brackets, the variant type names) and the class cells.
 */
import { useId } from 'react';
import { Tooltip } from '../../../components/ui/Tooltip';

export function HelpTip({ term, text, testId, question }: {
  term: string; text: string; testId?: string;
  /** The button's accessible name when "What is <term>?" doesn't read right (a plural: "What are the variant types?"). */
  question?: string;
}) {
  const id = useId();
  return (
    <Tooltip content={text} position="bottom" delay={120}>
      <button type="button" aria-label={question ?? `What is ${term}?`} aria-describedby={id} data-testid={testId ?? 'nfr-help'} data-term={term}
        className="ml-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 align-middle text-[10px] font-semibold leading-none text-gray-600 hover:border-fuchsia-400 hover:text-fuchsia-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-500 dark:border-gray-600 dark:text-gray-300">
        ?
        <span id={id} className="sr-only">{text}</span>
      </button>
    </Tooltip>
  );
}
