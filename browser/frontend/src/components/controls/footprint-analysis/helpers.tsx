import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { MotifHit } from '../../../api/footprints';
import { BASE_COLORS } from './constants';
import { AnalysisButton } from '../shared';

/**
 * Hits grouped by motif, best-scoring first. A Map, not an object: a motif may
 * be named like an Object property (`constructor`, `toString`, `__proto__`).
 */
export function groupMotifHits(hits: MotifHit[]): Array<{ name: string; best: MotifHit; others: MotifHit[] }> {
  const map = new Map<string, MotifHit[]>();
  for (const h of hits) {
    const list = map.get(h.motif_name);
    if (list) list.push(h); else map.set(h.motif_name, [h]);
  }
  return [...map.entries()]
    .map(([name, list]) => {
      const sorted = [...list].sort(byStrength);
      return { name, best: sorted[0], others: sorted.slice(1) };
    })
    .sort((a, b) => byStrength(a.best, b.best));
}

/** Stronger first: by p-value when the hits carry one (p-value scoring), else by relative score. */
function byStrength(a: MotifHit, b: MotifHit): number {
  if (a.p != null && b.p != null) return a.p - b.p || b.rel_score - a.rel_score;
  return b.rel_score - a.rel_score;
}

/** "p 3e−6" (p-value scoring) or "87%" (relative score). */
export function hitStrength(h: MotifHit): string {
  return h.p != null ? `p ${h.p.toExponential(0).replace('e-', 'e−')}` : `${(h.rel_score * 100).toFixed(0)}%`;
}

// --- Annotated sequence view with motif bars ---

export function AnnotatedSequenceView({ sequence, motifHits, highlightedMotif, onMotifClick, motifColors, isFullView }: {
  sequence: string;
  motifHits: MotifHit[];
  highlightedMotif: string | null;
  onMotifClick: (name: string) => void;
  motifColors: Map<string, string>;
  isFullView?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [charWidth, setCharWidth] = useState(6.6);

  // Measure monospace char width
  useEffect(() => {
    if (!containerRef.current) return;
    const probe = document.createElement('span');
    probe.style.fontFamily = 'monospace';
    probe.style.fontSize = isFullView ? '12px' : '10px';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.textContent = 'A';
    containerRef.current.appendChild(probe);
    setCharWidth(probe.getBoundingClientRect().width);
    containerRef.current.removeChild(probe);
  }, [isFullView]);

  // Build highlighted base ranges from motif hits
  const highlightedBases = useMemo(() => {
    if (!highlightedMotif) return new Set<number>();
    const set = new Set<number>();
    for (const h of motifHits) {
      if (h.motif_name === highlightedMotif) {
        for (let i = h.start; i < h.end; i++) set.add(i);
      }
    }
    return set;
  }, [motifHits, highlightedMotif]);

  // Group motif hits by name for lane assignment
  const lanes = useMemo(() => {
    const nameOrder: string[] = [];
    for (const h of motifHits) {
      if (!nameOrder.includes(h.motif_name)) nameOrder.push(h.motif_name);
    }
    return nameOrder;
  }, [motifHits]);

  const highlightColor = highlightedMotif ? motifColors.get(highlightedMotif) ?? '#6366f1' : '#6366f1';
  const seqLen = sequence.length;
  const svgWidth = seqLen * charWidth;
  const laneHeight = 14;
  const lanePad = 2;
  const svgHeight = lanes.length * (laneHeight + lanePad) + 4;
  const fontSize = isFullView ? '12px' : '10px';

  return (
    <div ref={containerRef} className="min-w-0 max-w-full overflow-x-auto" data-testid="annotated-sequence">
      {/* Sequence bases */}
      <div className="font-mono leading-tight break-all select-all whitespace-nowrap" style={{ fontSize }}>
        {sequence.split('').map((base, j) => {
          const isHighlighted = highlightedBases.has(j);
          return (
            <span
              key={j}
              style={{
                color: BASE_COLORS[base] || '#666',
                backgroundColor: isHighlighted ? highlightColor + '30' : undefined,
                borderBottom: isHighlighted ? `2px solid ${highlightColor}80` : undefined,
              }}
            >
              {base}
            </span>
          );
        })}
      </div>

      {/* SVG annotation track */}
      {lanes.length > 0 && (
        <svg width={svgWidth} height={svgHeight} className="mt-0.5" style={{ minWidth: svgWidth }}>
          {lanes.map((laneName, li) => {
            const y = li * (laneHeight + lanePad) + 2;
            const color = motifColors.get(laneName) ?? '#888';
            const isActive = highlightedMotif === laneName;
            const laneHits = motifHits.filter(h => h.motif_name === laneName);

            return (
              <g key={laneName}>
                {/* Lane background highlight */}
                {isActive && (
                  <rect x={0} y={y - 1} width={svgWidth} height={laneHeight + 2}
                    fill={color} opacity={0.08} rx={2} />
                )}
                {/* Motif hit bars */}
                {laneHits.map((h, hi) => {
                  const x = h.start * charWidth;
                  const w = Math.max((h.end - h.start) * charWidth, 4);
                  const arrow = h.strand === '+' ? '\u25B8' : '\u25C2';
                  return (
                    <g key={hi} onClick={() => onMotifClick(laneName)} data-testid="motif-hit-bar" data-motif={laneName}
                       className="cursor-pointer focus:outline-none [&:focus-visible>rect]:stroke-gray-900 [&:focus-visible>rect]:[stroke-width:2px] dark:[&:focus-visible>rect]:stroke-white"
                       role="button" tabIndex={0} aria-pressed={isActive}
                       aria-label={`${laneName} ${h.strand === '+' ? 'forward' : 'reverse'} strand, bases ${h.start + 1}–${h.end}: ${isActive ? 'unhighlight' : 'highlight'} its hits`}
                       onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMotifClick(laneName); } }}>
                      <rect x={x} y={y} width={w} height={laneHeight}
                        fill={color} opacity={isActive ? 0.7 : 0.4} rx={3}
                        stroke={isActive ? color : 'none'} strokeWidth={isActive ? 1 : 0} />
                      {w > 10 && (
                        <text x={x + 3} y={y + laneHeight - 3}
                          fontSize="9" fill="white" fontWeight="bold" pointerEvents="none">
                          {arrow}
                        </text>
                      )}
                    </g>
                  );
                })}
                {/* Lane label on the right */}
                <text
                  x={svgWidth - 2} y={y + laneHeight - 3}
                  fontSize="9" fill={color} textAnchor="end"
                  onClick={() => onMotifClick(laneName)}
                  className="cursor-pointer"
                  fontWeight={isActive ? 'bold' : 'normal'}
                >
                  {laneName}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// --- Grouped motif hit display component ---
export function MotifHitList({ hits, highlightedMotif, onMotifClick, motifColors }: {
  hits: MotifHit[];
  highlightedMotif: string | null;
  onMotifClick: (name: string) => void;
  motifColors: Map<string, string>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((name: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const grouped = useMemo(() => groupMotifHits(hits), [hits]);

  return (
    <div className="space-y-0.5 mt-1">
      <div className="text-[11px] text-emerald-600 font-medium">
        Motif hits ({hits.length} hit{hits.length !== 1 ? 's' : ''}, {grouped.length} motif{grouped.length !== 1 ? 's' : ''}):
      </div>
      {grouped.map(g => {
        const isActive = highlightedMotif === g.name;
        const color = motifColors.get(g.name) ?? '#888';
        const strandArrow = (s: string) => s === '+' ? '\u2192' : '\u2190';
        return (
          <div key={g.name} className={`min-w-0 rounded px-1 py-0.5 transition-colors ${isActive ? 'ring-1 ring-emerald-500 bg-emerald-50 dark:bg-emerald-900/30' : ''}`}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
              <span className="w-2 h-2 rounded-sm inline-block flex-shrink-0" style={{ backgroundColor: color }} />
              <AnalysisButton
                onClick={() => onMotifClick(g.name)}
                theme="emerald"
                variant={isActive ? 'soft' : 'outline'}
                className="px-1 py-0 text-[11px]"
              >
                {g.best.motif_name}
              </AnalysisButton>
              <span className="text-gray-500">{strandArrow(g.best.strand)} {hitStrength(g.best)}</span>
              {g.best.family?.length ? <span className="text-[10px] text-ink-secondary" title="Similar matrices on the same bases">+{g.best.family.join(', ')}</span> : null}
              <span className="break-all font-mono text-[11px] text-gray-500 dark:text-gray-400">{g.best.matched_seq}</span>
              {g.others.length > 0 && (
                <AnalysisButton
                  onClick={() => toggle(g.name)}
                  theme="emerald"
                  variant="outline"
                  className="px-1 py-0 text-[11px]"
                >
                  +{g.others.length} more {expanded.has(g.name) ? '\u25B4' : '\u25BE'}
                </AnalysisButton>
              )}
            </div>
            {expanded.has(g.name) && g.others.map((h, j) => (
              <div key={j} className="pl-5 flex items-center gap-1.5 text-[11px] text-ink-secondary">
                <span>{strandArrow(h.strand)} {hitStrength(h)}</span>
                <span className="font-mono text-[11px]">{h.matched_seq}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
