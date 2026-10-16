import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import type { AnalysisTheme } from './AnalysisTabBar';

type ControlValue = string | number;
/** `quiet`: a white button with a thin ring in the panel colour, for secondary actions
 * that sit next to one filled primary; disabled it turns plainly grey (not a pale fill). */
type ActionVariant = 'primary' | 'soft' | 'outline' | 'quiet' | 'neutral' | 'success' | 'warning' | 'danger' | 'dangerOutline';
type ActionSize = 'xs' | 'sm';

const TOGGLE_THEME_CLASSES: Record<AnalysisTheme, { active: string; inactive: string }> = {
  blue: {
    active: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  emerald: {
    active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  cyan: {
    active: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  amber: {
    active: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  violet: {
    active: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  rose: {
    active: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  slate: {
    active: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  red: {
    active: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  teal: {
    active: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  indigo: {
    active: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
  fuchsia: {
    active: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
    inactive: 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
  },
};

const HEADER_ACCENT_CLASSES: Record<AnalysisTheme, string> = {
  blue: 'text-blue-700 dark:text-blue-300',
  emerald: 'text-emerald-700 dark:text-emerald-300',
  cyan: 'text-cyan-700 dark:text-cyan-300',
  amber: 'text-amber-700 dark:text-amber-300',
  violet: 'text-violet-700 dark:text-violet-300',
  rose: 'text-rose-700 dark:text-rose-300',
  slate: 'text-slate-700 dark:text-slate-300',
  red: 'text-red-700 dark:text-red-300',
  teal: 'text-teal-700 dark:text-teal-300',
  indigo: 'text-indigo-700 dark:text-indigo-300',
  fuchsia: 'text-fuchsia-700 dark:text-fuchsia-300',
};

const ACTION_THEME_CLASSES: Record<AnalysisTheme, { primary: string; soft: string; outline: string }> = {
  blue: {
    primary: 'bg-blue-500 text-white hover:bg-blue-600',
    soft: 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/40',
    outline: 'border border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-800/50 dark:text-blue-300 dark:hover:bg-blue-900/20',
  },
  emerald: {
    primary: 'bg-emerald-500 text-white hover:bg-emerald-600',
    soft: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/40',
    outline: 'border border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800/50 dark:text-emerald-300 dark:hover:bg-emerald-900/20',
  },
  cyan: {
    primary: 'bg-cyan-500 text-white hover:bg-cyan-600',
    soft: 'bg-cyan-50 text-cyan-700 hover:bg-cyan-100 dark:bg-cyan-900/20 dark:text-cyan-300 dark:hover:bg-cyan-900/40',
    outline: 'border border-cyan-200 text-cyan-700 hover:bg-cyan-50 dark:border-cyan-800/50 dark:text-cyan-300 dark:hover:bg-cyan-900/20',
  },
  amber: {
    primary: 'bg-amber-500 text-white hover:bg-amber-600',
    soft: 'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-300 dark:hover:bg-amber-900/40',
    outline: 'border border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-800/50 dark:text-amber-300 dark:hover:bg-amber-900/20',
  },
  violet: {
    primary: 'bg-violet-500 text-white hover:bg-violet-600',
    soft: 'bg-violet-50 text-violet-700 hover:bg-violet-100 dark:bg-violet-900/20 dark:text-violet-300 dark:hover:bg-violet-900/40',
    outline: 'border border-violet-200 text-violet-700 hover:bg-violet-50 dark:border-violet-800/50 dark:text-violet-300 dark:hover:bg-violet-900/20',
  },
  rose: {
    primary: 'bg-rose-500 text-white hover:bg-rose-600',
    soft: 'bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-900/20 dark:text-rose-300 dark:hover:bg-rose-900/40',
    outline: 'border border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-800/50 dark:text-rose-300 dark:hover:bg-rose-900/20',
  },
  slate: {
    primary: 'bg-slate-600 text-white hover:bg-slate-700',
    soft: 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
    outline: 'border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
  },
  red: {
    primary: 'bg-red-500 text-white hover:bg-red-600',
    soft: 'bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/40',
    outline: 'border border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800/50 dark:text-red-300 dark:hover:bg-red-900/20',
  },
  teal: {
    primary: 'bg-teal-500 text-white hover:bg-teal-600',
    soft: 'bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-teal-900/20 dark:text-teal-300 dark:hover:bg-teal-900/40',
    outline: 'border border-teal-200 text-teal-700 hover:bg-teal-50 dark:border-teal-800/50 dark:text-teal-300 dark:hover:bg-teal-900/20',
  },
  indigo: {
    primary: 'bg-indigo-500 text-white hover:bg-indigo-600',
    soft: 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40',
    outline: 'border border-indigo-200 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800/50 dark:text-indigo-300 dark:hover:bg-indigo-900/20',
  },
  fuchsia: {
    primary: 'bg-fuchsia-500 text-white hover:bg-fuchsia-600',
    soft: 'bg-fuchsia-50 text-fuchsia-700 hover:bg-fuchsia-100 dark:bg-fuchsia-900/20 dark:text-fuchsia-300 dark:hover:bg-fuchsia-900/40',
    outline: 'border border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-50 dark:border-fuchsia-800/50 dark:text-fuchsia-300 dark:hover:bg-fuchsia-900/20',
  },
};

const ACTION_QUIET_CLASSES: Record<AnalysisTheme, string> = {
  blue: 'bg-white text-blue-700 ring-1 ring-inset ring-blue-300 hover:bg-blue-50 hover:ring-blue-400 dark:bg-white/[0.04] dark:text-blue-300 dark:ring-blue-500/40 dark:hover:bg-blue-900/20',
  emerald: 'bg-white text-emerald-700 ring-1 ring-inset ring-emerald-300 hover:bg-emerald-50 hover:ring-emerald-400 dark:bg-white/[0.04] dark:text-emerald-300 dark:ring-emerald-500/40 dark:hover:bg-emerald-900/20',
  cyan: 'bg-white text-cyan-700 ring-1 ring-inset ring-cyan-300 hover:bg-cyan-50 hover:ring-cyan-400 dark:bg-white/[0.04] dark:text-cyan-300 dark:ring-cyan-500/40 dark:hover:bg-cyan-900/20',
  amber: 'bg-white text-amber-700 ring-1 ring-inset ring-amber-300 hover:bg-amber-50 hover:ring-amber-400 dark:bg-white/[0.04] dark:text-amber-300 dark:ring-amber-500/40 dark:hover:bg-amber-900/20',
  violet: 'bg-white text-violet-700 ring-1 ring-inset ring-violet-300 hover:bg-violet-50 hover:ring-violet-400 dark:bg-white/[0.04] dark:text-violet-300 dark:ring-violet-500/40 dark:hover:bg-violet-900/20',
  rose: 'bg-white text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50 hover:ring-rose-400 dark:bg-white/[0.04] dark:text-rose-300 dark:ring-rose-500/40 dark:hover:bg-rose-900/20',
  slate: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 hover:ring-slate-400 dark:bg-white/[0.04] dark:text-slate-300 dark:ring-slate-500/40 dark:hover:bg-slate-900/20',
  red: 'bg-white text-red-700 ring-1 ring-inset ring-red-300 hover:bg-red-50 hover:ring-red-400 dark:bg-white/[0.04] dark:text-red-300 dark:ring-red-500/40 dark:hover:bg-red-900/20',
  teal: 'bg-white text-teal-700 ring-1 ring-inset ring-teal-300 hover:bg-teal-50 hover:ring-teal-400 dark:bg-white/[0.04] dark:text-teal-300 dark:ring-teal-500/40 dark:hover:bg-teal-900/20',
  indigo: 'bg-white text-indigo-700 ring-1 ring-inset ring-indigo-300 hover:bg-indigo-50 hover:ring-indigo-400 dark:bg-white/[0.04] dark:text-indigo-300 dark:ring-indigo-500/40 dark:hover:bg-indigo-900/20',
  fuchsia: 'bg-white text-fuchsia-700 ring-1 ring-inset ring-fuchsia-300 hover:bg-fuchsia-50 hover:ring-fuchsia-400 dark:bg-white/[0.04] dark:text-fuchsia-300 dark:ring-fuchsia-500/40 dark:hover:bg-fuchsia-900/20',
};
const ACTION_QUIET_DISABLED = 'disabled:opacity-100 disabled:bg-white disabled:text-gray-400 disabled:ring-gray-200 disabled:hover:bg-white dark:disabled:bg-transparent dark:disabled:text-gray-500 dark:disabled:ring-white/10';

const ACTION_NEUTRAL_CLASS = 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/15';
const ACTION_SUCCESS_CLASS = 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50';
const ACTION_WARNING_CLASS = 'bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-900/20 dark:text-orange-400 dark:hover:bg-orange-900/40';
const ACTION_DANGER_CLASS = 'bg-red-500 text-white hover:bg-red-600';
const ACTION_DANGER_OUTLINE_CLASS = 'border border-red-200 text-red-500 hover:bg-red-50 dark:border-red-800/50 dark:hover:bg-red-900/20';
const ACTION_SIZE_CLASSES: Record<ActionSize, string> = {
  xs: 'px-2 py-[3px] text-[11px]',
  sm: 'px-2.5 py-1 text-xs',
};

interface AnalysisButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionVariant;
  theme?: AnalysisTheme;
  size?: ActionSize;
}

function actionVariantClass(variant: ActionVariant, theme: AnalysisTheme): string {
  if (variant === 'neutral') return ACTION_NEUTRAL_CLASS;
  if (variant === 'success') return ACTION_SUCCESS_CLASS;
  if (variant === 'warning') return ACTION_WARNING_CLASS;
  if (variant === 'danger') return ACTION_DANGER_CLASS;
  if (variant === 'dangerOutline') return ACTION_DANGER_OUTLINE_CLASS;
  if (variant === 'quiet') return `${ACTION_QUIET_CLASSES[theme]} ${ACTION_QUIET_DISABLED}`;
  return ACTION_THEME_CLASSES[theme][variant];
}

export function AnalysisButton({
  variant = 'neutral',
  theme = 'slate',
  size = 'xs',
  className = '',
  type = 'button',
  ...props
}: AnalysisButtonProps) {
  return (
    <button
      type={type}
      className={`rounded-fb font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:shadow-focus ${variant === 'primary' || variant === 'danger' ? 'shadow-chip' : ''} ${ACTION_SIZE_CLASSES[size]} ${actionVariantClass(variant, theme)} ${className}`}
      {...props}
    />
  );
}

export function AnalysisActionGroup({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-end gap-1 shrink-0 flex-wrap ${className}`}>
      {children}
    </div>
  );
}

interface AnalysisControlRowProps {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
  labelClassName?: string;
  contentClassName?: string;
}

export function AnalysisControlRow({
  label,
  children,
  hint,
  className = '',
  labelClassName = '',
  contentClassName = '',
}: AnalysisControlRowProps) {
  return (
    <label className={`flex items-center justify-between gap-2 ${className}`}>
      <span className={`text-gray-500 dark:text-gray-400 ${labelClassName}`}>{label}</span>
      <span className={`flex items-center gap-1 min-w-0 ${contentClassName}`}>{children}</span>
      {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

export interface AnalysisSelectOption<T extends ControlValue = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

interface AnalysisSelectProps<T extends ControlValue = string> {
  label?: ReactNode;
  value: T;
  onChange: (value: T) => void;
  options: AnalysisSelectOption<T>[];
  className?: string;
  selectClassName?: string;
  disabled?: boolean;
  title?: string;
}

export function AnalysisSelect<T extends ControlValue = string>({
  label,
  value,
  onChange,
  options,
  className = '',
  selectClassName = '',
  disabled = false,
  title,
}: AnalysisSelectProps<T>) {
  const select = (
    <select
      value={String(value)}
      onChange={e => {
        const option = options.find(o => String(o.value) === e.target.value);
        if (option) onChange(option.value);
      }}
      disabled={disabled}
      title={title}
      className={`input-tool text-[11px] py-0.5 min-h-0 rounded px-1.5 ${selectClassName}`}
    >
      {options.map(option => (
        <option key={String(option.value)} value={String(option.value)} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );

  if (!label) return select;
  return (
    <AnalysisControlRow label={label} className={className}>
      {select}
    </AnalysisControlRow>
  );
}

interface AnalysisToggleOption<T extends string = string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

interface AnalysisToggleGroupProps<T extends string = string> {
  label?: ReactNode;
  value: T | null;
  onChange: (value: T | null) => void;
  options: AnalysisToggleOption<T>[];
  theme?: AnalysisTheme;
  allowDeselect?: boolean;
  className?: string;
  buttonClassName?: string;
}

export function AnalysisToggleGroup<T extends string = string>({
  label,
  value,
  onChange,
  options,
  theme = 'slate',
  allowDeselect = false,
  className = '',
  buttonClassName = '',
}: AnalysisToggleGroupProps<T>) {
  const classes = TOGGLE_THEME_CLASSES[theme];
  const group = (
    <div className={`flex items-center gap-0.5 flex-wrap ${className}`}>
      {options.map(option => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            onClick={() => onChange(active && allowDeselect ? null : option.value)}
            title={option.title}
            className={`px-1.5 py-0.5 rounded-[5px] text-[11px] font-medium transition-colors disabled:opacity-40 ${
              active ? classes.active : classes.inactive
            } ${buttonClassName}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );

  if (!label) return group;
  return (
    <AnalysisControlRow label={label} className="items-start">
      {group}
    </AnalysisControlRow>
  );
}

interface AnalysisPanelHeaderProps {
  /** Optional: the panel's coloured header bar already names it. Use a title
   *  for live status ("10 clusters"), not to repeat the panel's name. */
  title?: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  theme?: AnalysisTheme;
  className?: string;
}

/**
 * The top of an analysis panel's body. With a title: a coloured status line
 * (wrapping), a muted detail line under it, actions at the right. Without one:
 * the detail is the panel's one-sentence intro (the Footprints pattern). The
 * actions wrap and drop under the text on a narrow panel; nothing truncates.
 */
export function AnalysisPanelHeader({
  title,
  detail,
  meta,
  actions,
  theme = 'slate',
  className = '',
}: AnalysisPanelHeaderProps) {
  const hasTitle = title !== undefined && title !== null && title !== false && title !== '';
  return (
    <div className={`flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5 ${className}`}>
      <div className="min-w-[min(12rem,100%)] flex-1">
        {(hasTitle || meta) && (
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            {hasTitle && <span className={`text-[13px] font-semibold tracking-[-0.005em] ${HEADER_ACCENT_CLASSES[theme]}`}>{title}</span>}
            {meta && <span className="max-w-full break-words rounded-full bg-gray-100 px-1.5 py-px text-[11px] font-medium text-gray-500 dark:bg-white/10 dark:text-gray-400">{meta}</span>}
          </div>
        )}
        {detail && (hasTitle
          ? <div className="break-words text-[11px] leading-4 text-gray-500 dark:text-gray-400">{detail}</div>
          : <p className="break-words text-[12px] leading-[18px] text-ink-muted">{detail}</p>)}
      </div>
      {actions && <AnalysisActionGroup className="max-w-full">{actions}</AnalysisActionGroup>}
    </div>
  );
}

/** A panel's export buttons (JSON, TSV, Python…), together and labelled, at the
 *  end of its action row. */
export function AnalysisExportGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span role="group" aria-label="Export" className={`ml-auto flex flex-wrap items-center gap-1 ${className}`}>
      <span className="text-[11px] text-ink-muted">Export</span>
      {children}
    </span>
  );
}

/**
 * A section of an analysis panel (the Footprints "Footprint classes" card):
 * icon and title on the left, the section's main button on the right, then
 * the section's content.
 */
export function AnalysisCard({
  title,
  icon,
  actions,
  children,
  className = '',
  ...rest
}: {
  title: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, 'title'> & Record<`data-${string}`, string | undefined>) {
  return (
    <section className={`fb-panel-card text-[12px] ${className}`} {...rest}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {icon && <span className="flex flex-shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true">{icon}</span>}
        <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {actions && <div className="flex flex-wrap items-center justify-end gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
