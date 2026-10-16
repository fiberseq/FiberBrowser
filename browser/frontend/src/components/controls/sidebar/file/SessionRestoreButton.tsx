import { useRef, useState, type ChangeEvent } from 'react';
import { useBrowserStore } from '../../../../stores/browserStore';
import { requestSessionRestore } from '../../../../utils/sessionRestore';

interface SessionRestoreButtonProps {
  setError: (message: string) => void;
}

export function SessionRestoreButton({ setError }: SessionRestoreButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const publicMode = useBrowserStore(s => s.publicMode);

  if (publicMode) return null;

  const handleSessionFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError('Not a valid session file');
      return;
    }
    setRestoring(true);
    setRestoreMessage(null);
    try {
      const outcome = await requestSessionRestore(parsed);
      if (outcome.message) setRestoreMessage(outcome.message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={restoring}
        className="w-full rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-left text-[13px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-900/40"
        title="Restore a previously saved FiberBrowser session JSON"
        data-testid="restore-session-button"
      >
        {restoring ? 'Restoring Session…' : 'Restore Session'}
      </button>
      {restoreMessage && (
        <div className="px-1 pt-1 text-[11px] text-teal-700 dark:text-teal-300">
          {restoreMessage}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleSessionFileSelected}
        data-testid="restore-session-file-input"
      />
    </div>
  );
}
