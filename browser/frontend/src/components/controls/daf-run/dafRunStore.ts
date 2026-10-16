import { create } from 'zustand';
import { listJobs, type PipelineJob } from '../../../api/pipeline';
import { isActive } from '../../../utils/pipelineProgress';
import type { WizardState } from '../../../utils/dafRun';

export type DafRunTab = 'new' | 'runs' | 'qc';

/** Opens the New DAF-seq run dialog from anywhere (menus, Copilot, the tour). */
export const OPEN_DAF_RUN_EVENT = 'fiberbrowser:open-daf-run';

export function openDafRunDialog(tab: DafRunTab = 'new', jobId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_DAF_RUN_EVENT, { detail: { tab, jobId } }));
}

interface DafRunState {
  jobs: PipelineJob[];
  loaded: boolean;
  error: string | null;
  open: boolean;
  tab: DafRunTab;
  focusJobId: string | null;
  setOpen: (open: boolean, tab?: DafRunTab, focusJobId?: string | null) => void;
  setTab: (tab: DafRunTab) => void;
  refresh: () => Promise<PipelineJob[]>;
  upsert: (jobs: PipelineJob[]) => void;
  remove: (id: string) => void;
  /** The New run wizard's draft. It lives here, not in the wizard, so switching
   * tabs (New → Runs → New) or closing and reopening the dialog keeps it; it
   * is reset after a run starts or when the user starts over. */
  draft: WizardState | null;
  /** The draft has the server's defaults (genome open now, cores, options). */
  draftSeeded: boolean;
  /** Bumped when the draft is started over (Start over, a run started): an
   *  answer for the previous draft (a scan, a submit) must not land in the new one. */
  draftRevision: number;
  updateDraft: (update: (prev: WizardState | null) => WizardState) => void;
  markDraftSeeded: () => void;
  clearDraft: () => void;
}

export const useDafRunStore = create<DafRunState>((set, get) => ({
  jobs: [],
  loaded: false,
  error: null,
  open: false,
  tab: 'new',
  focusJobId: null,
  setOpen: (open, tab, focusJobId) => set(state => ({
    open,
    tab: tab ?? state.tab,
    focusJobId: focusJobId === undefined ? state.focusJobId : focusJobId,
  })),
  setTab: tab => set({ tab }),
  refresh: async () => {
    try {
      const { jobs } = await listJobs();
      set({ jobs, loaded: true, error: null });
      return jobs;
    } catch (err) {
      set({ loaded: true, error: err instanceof Error ? err.message : 'Could not list runs' });
      return get().jobs;
    }
  },
  upsert: jobs => set(state => {
    const byId = new Map(state.jobs.map(j => [j.id, j]));
    for (const job of jobs) byId.set(job.id, job);
    return { jobs: [...byId.values()].sort((a, b) => b.id.localeCompare(a.id)) };
  }),
  remove: id => set(state => ({ jobs: state.jobs.filter(j => j.id !== id) })),
  draft: null,
  draftSeeded: false,
  draftRevision: 0,
  updateDraft: update => set(state => ({ draft: update(state.draft) })),
  markDraftSeeded: () => set({ draftSeeded: true }),
  clearDraft: () => set(state => ({ draft: null, draftSeeded: false, draftRevision: state.draftRevision + 1 })),
}));

export function activeJobs(jobs: PipelineJob[]): PipelineJob[] {
  return jobs.filter(j => isActive(j.status));
}
