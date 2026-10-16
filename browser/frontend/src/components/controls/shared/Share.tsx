/** "737 of 810 loaded reads (91%)" with the numbers in tabular figures and the denominator in the secondary token. */
import { formatCountPct, type PctOptions } from '../../../utils/denominators';

export function Share({ n, of, population, pct = false, digits, className = '' }: {
  n: number; of: number; population: string; pct?: boolean; className?: string;
} & Pick<PctOptions, 'digits'>) {
  return (
    <span className={`tabular-nums ${className}`} data-testid="share">
      <span className="font-medium">{n.toLocaleString()}</span>
      <span className="text-ink-secondary"> of {of.toLocaleString()}{population ? ` ${population}` : ''}</span>
      {pct && <span className="text-ink-secondary"> ({formatCountPct(n, of, { digits })})</span>}
    </span>
  );
}
