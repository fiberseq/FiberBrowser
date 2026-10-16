export function messageFromError(error: unknown, fallback = 'Failed to load file'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export function formatFileLoadError(error: unknown, fallback = 'Failed to load file'): string {
  const message = messageFromError(error, fallback).trim();
  const hints: string[] = [];
  const lower = message.toLowerCase();
  const mentionsWindowsPath = /[a-z]:\\/i.test(message) || /\\\\[^\\/\s]+\\[^\\/\s]+/.test(message);
  const mentionsWslMount = /\/mnt\/[a-z](\/|$)/i.test(message);

  if (
    (mentionsWindowsPath || mentionsWslMount || lower.includes('mapped network drive') || lower.includes('wsl')) &&
    !lower.includes('mount the share')
  ) {
    hints.push(
      "If this is a Windows mapped lab drive, FiberBrowser's Python backend must be able to read the same path. In WSL, mount the share and load the /mnt/... path; in native Windows, launch FiberBrowser from the same user session that mounted the drive.",
    );
  }

  // Not for an index chosen on its own: that message already says what to open.
  if ((lower.includes('index') || lower.includes('.bai')) && !lower.includes('samtools index')
      && !lower.includes('not a file to open on its own')) {
    hints.push('For BAM files, make sure the .bai index is next to the BAM and readable.');
  }

  return [message, ...hints].join('\n\n');
}
