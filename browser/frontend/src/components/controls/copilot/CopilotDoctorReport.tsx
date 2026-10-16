import type { CopilotDoctorReport as Report } from '../../../api/naturalLanguage';
import { AlertTriangle, CheckCircle, Info, X, XCircle } from '../../ui/Icons';

const MARK: Record<string, { Icon: typeof CheckCircle; label: string; cls: string }> = {
  ok: { Icon: CheckCircle, label: 'OK', cls: 'text-emerald-600 dark:text-emerald-400' },
  warn: { Icon: AlertTriangle, label: 'Warning', cls: 'text-amber-600 dark:text-amber-400' },
  fail: { Icon: XCircle, label: 'Failed', cls: 'text-rose-600 dark:text-rose-400' },
  info: { Icon: Info, label: 'Info', cls: 'text-slate-500 dark:text-slate-400' },
};

/** The setup check (`python browser.py --copilot-doctor`): what was found, and
 *  the exact command that fixes each problem. */
export function CopilotDoctorReport({ report, onClose }: { report: Report; onClose?: () => void }) {
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-white/80 p-2 text-[11px] dark:border-white/10 dark:bg-black/20"
      data-testid="copilot-doctor-report">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-slate-800 dark:text-slate-100">{report.summary}</div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close setup check"
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-200"><X size={13} /></button>
        )}
      </div>
      <ul className="mt-1.5 space-y-1">
        {report.checks.map(check => {
          const mark = MARK[check.status] ?? MARK.info;
          const showFix = check.fix && check.status !== 'ok';
          return (
            <li key={check.id} className="leading-snug">
              <mark.Icon size={12} className={`mr-1 inline-block align-[-2px] ${mark.cls}`} aria-label={mark.label} role="img" />
              <span className="font-medium text-slate-700 dark:text-slate-200">{check.title}</span>
              {check.detail && (
                <div className="ml-4 whitespace-pre-wrap break-words text-slate-500 dark:text-slate-400">{check.detail}</div>
              )}
              {showFix && (
                <pre className="ml-4 mt-0.5 whitespace-pre-wrap break-all rounded bg-slate-100 px-1.5 py-1 font-mono text-[11px] text-slate-800 dark:bg-white/5 dark:text-slate-200">{check.fix}</pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
