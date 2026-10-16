import { getPreviewFeature } from '../../utils/previewFeatures';
import { HowItWorks } from './HowItWorks';

/** The small "Preview" mark on a Preview feature's launchers, menu items and panels (utils/previewFeatures). */
export function PreviewBadge({ feature, className = '' }: { feature?: string; className?: string }) {
  const def = getPreviewFeature(feature);
  return (
    <span
      data-testid="preview-badge"
      data-preview={feature}
      title={!def ? 'A Preview feature'
        : def.labelOnly ? `${def.label}: a Preview feature. ${def.limitations.join(' ')}`
        : `${def.label}: a Preview feature (Settings → Show preview features). ${def.limitations.length} known limitation${def.limitations.length === 1 ? '' : 's'}.`}
      className={`inline-flex flex-shrink-0 items-center rounded-full border border-amber-500/60 bg-amber-50 px-1 text-[9px] font-semibold uppercase leading-[13px] tracking-wide text-amber-800 dark:border-amber-400/50 dark:bg-amber-950/40 dark:text-amber-200 ${className}`}
    >
      Preview
    </span>
  );
}

/** A Preview feature's "Known limitations" note (folded: one line until opened), with what graduates it. */
export function PreviewLimitations({ feature, className = '' }: { feature: string; className?: string }) {
  const def = getPreviewFeature(feature);
  if (!def) return null;
  return (
    <div className={`flex flex-wrap items-start gap-1.5 ${className}`} data-testid="preview-limitations" data-preview={feature}>
      <PreviewBadge feature={feature} className="mt-px" />
      <HowItWorks summary="Known limitations" testId="preview-limitations-details">
        <ul className="list-disc space-y-0.5 pl-4">
          {def.limitations.map(text => <li key={text}>{text}</li>)}
        </ul>
        <p className="pt-0.5"><span className="font-medium">Leaving Preview:</span> {def.graduation}</p>
      </HowItWorks>
    </div>
  );
}
