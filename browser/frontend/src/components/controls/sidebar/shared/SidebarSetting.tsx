import type { ReactNode } from 'react';
import { HelpIcon } from '../../../ui/Tooltip';
import { settingAnchor, type SettingDef } from '../../../../utils/settingsCatalog';

type SettingTone = 'teal' | 'blue' | 'emerald' | 'amber' | 'rose' | 'slate' | 'gray';

const TOGGLE_TONE_CLASSES: Record<SettingTone, string> = {
  teal: 'text-teal-700 dark:text-teal-400',
  blue: 'text-blue-700 dark:text-blue-400',
  emerald: 'text-emerald-700 dark:text-emerald-400',
  amber: 'text-amber-700 dark:text-amber-400',
  rose: 'text-rose-700 dark:text-rose-400',
  slate: 'text-slate-700 dark:text-slate-300',
  gray: 'text-gray-700 dark:text-gray-300',
};

const NOTE_TONE_CLASSES: Record<SettingTone, string> = {
  teal: 'bg-teal-50 text-teal-800 border-teal-100 dark:bg-teal-950/20 dark:text-teal-300 dark:border-teal-900/40',
  blue: 'bg-blue-50 text-blue-800 border-blue-100 dark:bg-blue-950/20 dark:text-blue-300 dark:border-blue-900/40',
  emerald: 'bg-emerald-50 text-emerald-800 border-emerald-100 dark:bg-emerald-950/20 dark:text-emerald-300 dark:border-emerald-900/40',
  amber: 'bg-amber-50 text-amber-800 border-amber-100 dark:bg-amber-950/20 dark:text-amber-300 dark:border-amber-900/40',
  rose: 'bg-rose-50 text-rose-800 border-rose-100 dark:bg-rose-950/20 dark:text-rose-300 dark:border-rose-900/40',
  slate: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-white/5 dark:text-slate-300 dark:border-white/10',
  gray: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-white/5 dark:text-gray-300 dark:border-white/10',
};

interface SidebarSettingRowProps {
  /** The setting it shows (utils/settingsCatalog): its label (unless `label` is given) and search anchor. */
  setting?: SettingDef;
  label?: ReactNode;
  helpText?: string;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
}

export function SidebarSettingRow({
  setting,
  label = setting?.label,
  helpText,
  children,
  className = '',
  labelClassName = 'min-w-[82px]',
}: SidebarSettingRowProps) {
  return (
    // Label and control on one line when they fit; the control drops under the label when not.
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`} {...(setting ? settingAnchor(setting) : {})}>
      <span className="flex shrink-0 items-center gap-1">
        <span className={`text-[12px] text-gray-700 dark:text-gray-300 ${labelClassName}`}>{label}</span>
        {helpText && <HelpIcon text={helpText} position="left" />}
      </span>
      <div className="flex min-w-[9rem] flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

interface SidebarSettingToggleProps {
  /** The setting it shows (utils/settingsCatalog): its label (unless `label` is given) and search anchor. */
  setting?: SettingDef;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  helpText?: string;
  title?: string;
  tone?: SettingTone;
  disabled?: boolean;
  className?: string;
}

export function SidebarSettingToggle({
  setting,
  checked,
  onChange,
  label = setting?.label,
  helpText,
  title,
  tone = 'teal',
  disabled = false,
  className = '',
}: SidebarSettingToggleProps) {
  return (
    <label
      className={`flex items-center gap-1.5 text-[12px] ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}
      title={title}
      {...(setting ? settingAnchor(setting) : {})}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="rounded border-gray-300 dark:border-white/20"
      />
      {/* Neutral ink: a coloured label reads as a status, not a setting. */}
      <span className={tone === 'gray' ? TOGGLE_TONE_CLASSES.gray : 'text-gray-700 dark:text-gray-300'}>{label}</span>
      {helpText && <HelpIcon text={helpText} position="left" />}
    </label>
  );
}

interface SidebarSettingNoteProps {
  children: ReactNode;
  tone?: SettingTone;
  className?: string;
}

export function SidebarSettingNote({
  children,
  tone = 'slate',
  className = '',
}: SidebarSettingNoteProps) {
  return (
    <div className={`rounded-md border px-2 py-1.5 text-[11.5px] leading-[16px] ${NOTE_TONE_CLASSES[tone]} ${className}`}>
      {children}
    </div>
  );
}
