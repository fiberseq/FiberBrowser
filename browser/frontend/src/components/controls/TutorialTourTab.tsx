import { useEffect, useMemo, useState } from 'react';
import { getDemo, type DemoEntry, type DemoRegion } from '../../api/demo';
import { tourOutline } from '../../utils/guidedTour';
import { startTutorialTour } from '../../utils/tourLauncher';
import { Compass, Play, Search } from '../ui/Icons';

/**
 * The Tutorial panel's Guided tour tab: the tour's steps by section, to search
 * and to start at any of them (the tour first sets up what that step needs).
 */
export function TutorialTourTab() {
  // The tour runs on the server's demo when it has one: list the texts it shows then.
  const [demo, setDemo] = useState<DemoRegion | null>(null);
  // (and the structural-variant demo its Variants section loads, when the server has it).
  const [svDemo, setSvDemo] = useState<DemoEntry | null>(null);
  useEffect(() => {
    let live = true;
    getDemo()
      .then(info => {
        if (!live || !info.available) return;
        setDemo(info.region);
        setSvDemo(info.demos?.find(d => d.id === 'sv' && d.available) ?? null);
      })
      .catch(() => { /* a public server or an older backend: the tour tours the loaded data */ });
    return () => { live = false; };
  }, []);
  const steps = useMemo(() => tourOutline(demo, svDemo), [demo, svDemo]);
  const [query, setQuery] = useState('');
  // Each step's number in the whole tour (stays put while searching).
  const stepNumber = useMemo(() => new Map(steps.map((step, i) => [step.id, i + 1])), [steps]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups: { section: string; steps: typeof steps }[] = [];
    for (const step of steps) {
      if (q && !step.title.toLowerCase().includes(q) && !step.text.toLowerCase().includes(q)) continue;
      let group = groups[groups.length - 1];
      if (!group || group.section !== step.section) {
        group = { section: step.section, steps: [] };
        groups.push(group);
      }
      group.steps.push(step);
    }
    return groups;
  }, [steps, query]);

  return (
    <div className="flex h-full flex-col gap-2.5 text-[12px] leading-[18px]" data-testid="tutorial-tour-tab">
      <section className="fb-panel-card" data-testid="tutorial-start-card">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Compass size={16} className="flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-gray-900 dark:text-gray-100">Guided tour</h3>
          <button
            type="button"
            className="fb-btn-primary"
            onClick={() => startTutorialTour()}
            title="The whole guided tour, on a demo dataset"
            data-testid="tutorial-start-tour"
          >
            <Play size={14} aria-hidden="true" />
            Start from the beginning
          </button>
        </div>
        <p className="text-ink-muted">
          Take the guided tour of the main tools on a demo dataset, in a separate tab, so your own work stays as it is.
          Or start it at any step below.
        </p>
      </section>
      <div className="flex items-center">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-fb border border-line bg-white px-2.5 text-ink-faint focus-within:border-brand-400 focus-within:ring-[3px] focus-within:ring-brand-500/20 dark:border-white/10 dark:bg-dark-bg">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search the steps…"
            aria-label="Search the tour's steps"
            className="min-w-0 flex-1 bg-transparent py-1 text-[12px] text-gray-800 placeholder:text-ink-faint focus:outline-none dark:text-gray-100"
            data-testid="tutorial-search"
          />
        </label>
      </div>
      <div className="text-[11px] text-ink-muted" title="The tour first sets up what that step needs (the demo, peaks, clusters, a footprint).">
        Click any step to start the tour there. Hover a step for what it covers.
      </div>
      <div className="flex-1 space-y-2.5 overflow-auto" data-tour="tutorial-tour-list" data-testid="tutorial-tour-list">
        {sections.length === 0 && (
          <div className="px-1 py-2 text-gray-500" data-testid="tutorial-no-match">No steps match “{query.trim()}”.</div>
        )}
        {sections.map(group => (
          <section key={group.section} data-testid="tutorial-section" data-section={group.section}>
            <button
              type="button"
              onClick={() => startTutorialTour(group.steps[0].id)}
              className="flex w-full items-baseline gap-1.5 rounded px-0 pt-1 pb-0.5 text-left text-[12px] font-semibold text-gray-900 hover:text-brand-700 dark:text-gray-100 dark:hover:text-brand-300"
              title={`Start the tour at ${group.steps[0].title}`}
            >
              {group.section}
              <span className="text-[11px] font-normal text-ink-faint">{group.steps.length}</span>
            </button>
            <ul className="mt-0.5 grid grid-cols-1 gap-x-2 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]">
              {group.steps.map(step => (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => startTutorialTour(step.id)}
                    className="group flex w-full items-baseline gap-2 rounded-fb px-1.5 py-[3px] text-left hover:bg-brand-50 dark:hover:bg-brand-400/10"
                    title={step.text}
                    data-testid="tutorial-step"
                    data-step-id={step.id}
                  >
                    <span className="w-4 flex-shrink-0 text-right text-[11px] tabular-nums text-ink-faint">{stepNumber.get(step.id)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-gray-800 dark:text-gray-100">{step.title}</span>
                    <Play size={10} aria-hidden="true" className="flex-shrink-0 text-brand-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-brand-300" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
