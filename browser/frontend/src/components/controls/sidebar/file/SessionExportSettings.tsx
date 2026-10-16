import { SidebarSubSection } from '../../SidebarSubSection';
import { SessionPersistenceControls } from './SessionPersistenceControls';

interface SessionExportSettingsProps {
  onCopyLink: () => void;
  linkCopied: boolean;
  setError: (message: string) => void;
}

export function SessionExportSettings({
  onCopyLink,
  linkCopied,
  setError,
}: SessionExportSettingsProps) {
  return (
    <SidebarSubSection
      id="file.session"
      label="Session"
      helpText="Name and save the session, copy a link or reproducibility summary, open a new window. Screenshots: the camera button in the top bar."
      defaultOpen
      persist
    >
      <div className="space-y-0.5">
        <button
          onClick={onCopyLink}
          className="w-full text-left px-2 py-1 text-[13px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded"
        >
          {linkCopied ? 'Link Copied!' : 'Copy Link'}
        </button>
        <SessionPersistenceControls setError={setError} />
      </div>
    </SidebarSubSection>
  );
}
