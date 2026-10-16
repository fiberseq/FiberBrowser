import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useDatasetActions } from '../../hooks/useDatasetActions';
import { startTutorialTour } from '../../utils/tourLauncher';
import { Compass, FolderOpen, Library, RotateCcw } from '../ui/Icons';
import { useLaunchUiStore } from '../../utils/launchSession';
import { formatTimeAgo } from '../../utils/time';
import { useLibraryAvailable } from './library/LibraryHost';
import { openLibrary } from './library/libraryStore';

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

/**
 * One call-to-action tile on the welcome screen. The tiles take the app icon's
 * three molecule colours: accessible light blue (opening data: a file or the
 * Library), TF fuchsia, nucleosome green.
 */
export function WelcomeTile({
  icon: Icon, accent, title, detail, testId, onClick, disabled, busy,
}: {
  icon: IconType;
  accent: 'blue' | 'fuchsia' | 'green';
  title: ReactNode;
  detail: ReactNode;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const tint = {
    blue: 'bg-sky-100 text-brand-700 ring-sky-200 dark:bg-sky-400/15 dark:text-sky-200 dark:ring-sky-400/25',
    fuchsia: 'bg-fuchsia-100 text-fuchsia-700 ring-fuchsia-200 dark:bg-fuchsia-400/15 dark:text-fuchsia-200 dark:ring-fuchsia-400/25',
    green: 'bg-green-100 text-green-700 ring-green-200 dark:bg-green-400/15 dark:text-green-200 dark:ring-green-400/25',
  }[accent];
  const hover = {
    blue: 'hover:border-sky-300 dark:hover:border-sky-400/40',
    fuchsia: 'hover:border-fuchsia-300 dark:hover:border-fuchsia-400/40',
    green: 'hover:border-green-300 dark:hover:border-green-400/40',
  }[accent];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`
        group inline-flex w-full min-w-0 flex-col items-center justify-start gap-1.5
        rounded-fb-lg border border-line bg-white px-3 pb-4 pt-4
        text-sm font-medium text-gray-900 shadow-panel transition
        hover:-translate-y-px hover:shadow-md ${hover}
        dark:border-white/10 dark:bg-dark-surface dark:text-gray-100
        disabled:opacity-60 disabled:cursor-wait
        focus:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-500/30
      `}
      data-testid={testId}
      aria-busy={busy || undefined}
    >
      <span className={`mb-1 flex h-10 w-10 items-center justify-center rounded-fb-lg ring-1 ${tint}`} aria-hidden="true">
        <Icon size={20} />
      </span>
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="text-[11px] font-normal leading-4 text-ink-muted">{detail}</span>
    </button>
  );
}

/** Big "Load a file" call to action on the empty welcome screen. */
export function WelcomeLoadFileButton() {
  const { handleLoadFile, loading } = useDatasetActions();
  return (
    <WelcomeTile
      icon={FolderOpen}
      accent="blue"
      title={loading ? 'Loading…' : 'Load a file'}
      detail="BAM, BigBed, BigWig, GTF, …"
      testId="welcome-load-file-cta"
      onClick={handleLoadFile}
      disabled={loading}
      busy={loading}
    />
  );
}

/** Welcome screen: open data from the Library, beside "Load a file" (owner, 1 Oct). Local only. */
export function WelcomeLibraryButton() {
  const available = useLibraryAvailable();
  if (!available) return null;
  return (
    <WelcomeTile
      icon={Library}
      accent="blue"
      title="Open from Library"
      detail="Datasets you opened or watch"
      testId="welcome-library-cta"
      onClick={() => openLibrary()}
    />
  );
}

/** Welcome screen: start the guided tour (it loads the demo dataset). */
export function WelcomeTourButton() {
  return (
    <WelcomeTile
      icon={Compass}
      accent="green"
      title="Take the tour"
      detail="A demo dataset, step by step"
      testId="welcome-tour-cta"
      onClick={() => startTutorialTour()}
    />
  );
}

/**
 * Welcome screen: reopen the session of the last launch (saved when the app was quit normally), the first and
 * widest button when there is one (owner, 15 Oct: the Welcome card always shows; reopening is one of its choices).
 */
export function WelcomeReopenLastSessionButton() {
  const last = useLaunchUiStore(s => s.lastSession);
  if (!last) return null;
  return (
    <button
      type="button"
      onClick={last.reopen}
      data-testid="welcome-reopen-last-session"
      className="group col-span-full flex w-full min-w-0 items-center gap-3 rounded-fb-lg border border-brand-200 bg-brand-50 px-4 py-3 text-left
        shadow-panel transition hover:-translate-y-px hover:border-brand-300 hover:shadow-md
        dark:border-brand-400/30 dark:bg-brand-400/10 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-500/30"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-fb-lg bg-brand-600 text-white" aria-hidden="true">
        <RotateCcw size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-gray-900 dark:text-gray-100">Reopen last session</span>
        <span className="block truncate text-[11px] leading-4 text-ink-muted" data-testid="welcome-reopen-last-session-detail">
          {last.summary ? `${last.summary} · ` : ''}saved {formatTimeAgo(last.savedAt)}
        </span>
      </span>
    </button>
  );
}
