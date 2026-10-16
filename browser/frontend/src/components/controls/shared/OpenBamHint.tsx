import { APP_COMMAND_INFO, runAppCommand } from '../../../utils/appCommands';
import { OPEN_BAM_HINT } from '../../../utils/openBamHint';

export { OPEN_BAM_HINT };

const link = 'font-medium text-brand-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-brand-300';

/**
 * OPEN_BAM_HINT with its two ways in as links: "Open a BAM" runs the toolbar's Open, "Library" opens the Library
 * (the text reads the same with or without them).
 */
export function OpenBamHint({ className = '', testId = 'open-bam-hint' }: { className?: string; testId?: string }) {
  return (
    <p className={`text-[11px] text-ink-muted ${className}`} data-testid={testId}>
      {/* (Opening files is a desktop action: on a public server the words stay, without the link.) */}
      {APP_COMMAND_INFO['open-file']?.available?.() === false ? 'Open a BAM' : (
        <button type="button" className={link} data-testid={`${testId}-open`} onClick={() => runAppCommand('open-file')}
          title="Open a BAM file (the toolbar's Open)">Open a BAM</button>)}
      {' or choose one in the '}
      {/* (No Library on a public server or in the sandbox: the word stays, without the link.) */}
      {APP_COMMAND_INFO.library?.available?.() === false ? 'Library' : (
        <button type="button" className={link} data-testid={`${testId}-library`} onClick={() => runAppCommand('library')}
          title="Datasets you opened before, and files added to the Library">Library</button>)}
    </p>
  );
}
