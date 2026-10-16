/**
 * Accessibility (preview): slow requests that outlive the view that asked for them.
 *
 * A request (motif scan, NFR sizes, ChIP-Atlas, conservation, prevalence, quantify in another dataset) is keyed and
 * held here, not in a component: switching tabs, entries or panels leaves it running and its result cached by key, so
 * coming back shows it at once. A request that finishes while nothing shows it (and took more than a moment) marks its
 * owner (a tab, an NFR card) and raises a small notice. Cancelling stays explicit: ``cancelJob`` aborts the loop and
 * calls the job's own cancel (the server's DELETE where there is one).
 */
import { useEffect, useSyncExternalStore } from 'react';

export type JobStatus = 'loading' | 'done' | 'error' | 'cancelled';

export interface JobOwner {
  /** Where the result belongs: the panel tab ('nfrs', 'coaccess') and, for an NFR card, its key ('<run>|<NFR>'). */
  tab?: string;
  entry?: string;
  /** Short name for the notice ("Motifs of N5"). */
  label: string;
}

export interface JobState<T = unknown> {
  key: string;
  status: JobStatus;
  data: T | null;
  error: string;
  /** Interim state of a polled task (e.g. ChIP-Atlas done / total). */
  progress: unknown;
  started: number;
  finished: number | null;
  owner: JobOwner | null;
}

export interface JobContext {
  signal: { cancelled: boolean };
  /** Report interim state (shown by watchers). */
  progress: (value: unknown) => void;
}

interface Entry extends JobState {
  watchers: number;
  cancel?: () => Promise<unknown> | void;
  signal: { cancelled: boolean };
}

export interface JobNotice { id: number; label: string; ok: boolean; owner: JobOwner | null }

const MAX_ENTRIES = 200;
/** A result that arrives within this long of its start was not "slow": no notice. */
export const NOTICE_AFTER_MS = 1500;

const jobs = new Map<string, Entry>();
const listeners = new Set<() => void>();
let badges: Record<string, number> = {};
let notices: JobNotice[] = [];
let noticeId = 0;
let version = 0;
/** Bumped by resetJobs: views that survive a reset load again. */
let generation = 0;

function emit() {
  version += 1;
  for (const l of [...listeners]) l();
}

export function subscribeJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot(e: Entry): JobState {
  return { key: e.key, status: e.status, data: e.data, error: e.error, progress: e.progress, started: e.started, finished: e.finished, owner: e.owner };
}

function trim() {
  if (jobs.size <= MAX_ENTRIES) return;
  for (const [k, e] of jobs) {
    if (jobs.size <= MAX_ENTRIES) break;
    if (e.status !== 'loading' && e.watchers === 0) jobs.delete(k);
  }
}

function badgeKeys(owner: JobOwner | null): string[] {
  if (!owner) return [];
  return [owner.tab ? `tab:${owner.tab}` : '', owner.entry ? `entry:${owner.entry}` : ''].filter(Boolean);
}

function finish(e: Entry, patch: Partial<Entry>) {
  if (jobs.get(e.key) !== e) return;            // forgotten or replaced meanwhile
  Object.assign(e, patch, { finished: Date.now() });
  if (e.watchers === 0 && e.status !== 'cancelled' && Date.now() - e.started >= NOTICE_AFTER_MS && e.owner) {
    for (const k of badgeKeys(e.owner)) badges = { ...badges, [k]: (badges[k] ?? 0) + 1 };
    notices = [...notices.slice(-3), { id: ++noticeId, label: e.owner.label, ok: e.status === 'done', owner: e.owner }];
  }
  emit();
}

/**
 * Start (or join) the job ``key``. A finished job with data is reused; an errored or cancelled one is retried.
 * ``load`` gets a context with a cancel signal and a progress reporter.
 */
export function startJob<T>(key: string, load: (ctx: JobContext) => Promise<T>, owner: JobOwner | null = null,
  cancel?: () => Promise<unknown> | void): JobState<T> {
  const existing = jobs.get(key);
  if (existing && (existing.status === 'loading' || existing.status === 'done')) {
    if (owner && !existing.owner) existing.owner = owner;
    return snapshot(existing) as JobState<T>;
  }
  const signal = { cancelled: false };
  const e: Entry = {
    key, status: 'loading', data: null, error: '', progress: null, started: Date.now(), finished: null, owner,
    // watchers move from a replaced entry to this one through their subscriptions (useJob)
    watchers: 0, cancel, signal,
  };
  jobs.set(key, e);
  trim();
  const ctx: JobContext = {
    signal,
    progress: value => { if (jobs.get(key) === e && !signal.cancelled) { e.progress = value; emit(); } },
  };
  Promise.resolve().then(() => load(ctx)).then(
    data => { if (!signal.cancelled) finish(e, { status: 'done', data, error: '' }); },
    err => { if (!signal.cancelled) finish(e, { status: 'error', data: null, error: String((err as Error)?.message ?? err) }); },
  );
  emit();
  return snapshot(e) as JobState<T>;
}

/** Explicit cancel: stop following the job and ask the server to stop it (where the job knows how). */
export async function cancelJob(key: string): Promise<void> {
  const e = jobs.get(key);
  if (!e || e.status !== 'loading') return;
  e.signal.cancelled = true;
  finish(e, { status: 'cancelled', error: 'Cancelled' });
  try { await e.cancel?.(); } catch { /* the server may have finished meanwhile */ }
}

export function getJob<T>(key: string): JobState<T> | null {
  const e = jobs.get(key);
  return e ? (snapshot(e) as JobState<T>) : null;
}

/** Forget every job (a new session). */
export function resetJobs() {
  for (const e of jobs.values()) e.signal.cancelled = true;
  jobs.clear();
  generation += 1;
  badges = {};
  notices = [];
  emit();
}

// ------------------------------------------------------------------ badges and notices
export function getBadges(): Record<string, number> { return badges; }
export function clearBadge(key: string) {
  if (!badges[key]) return;
  const next = { ...badges };
  delete next[key];
  badges = next;
  emit();
}
export function getNotices(): JobNotice[] { return notices; }
export function dismissNotice(id: number) {
  notices = notices.filter(n => n.id !== id);
  emit();
}

// ------------------------------------------------------------------ hooks
const getVersion = () => version;

function useJobsVersion() {
  return useSyncExternalStore(subscribeJobs, getVersion, getVersion);
}

/** The job ``key`` as a view watches it: while mounted, its completion is not "off-screen". */
export function useJob<T>(key: string | null): JobState<T> | null {
  useJobsVersion();
  useEffect(() => {
    if (!key) return;
    const e = jobs.get(key);
    if (e) e.watchers += 1;
    let counted = e;
    // a job started after this view mounted: count it once it exists
    const unsub = subscribeJobs(() => {
      const now = jobs.get(key);
      if (now && now !== counted) { if (counted) counted.watchers = Math.max(0, counted.watchers - 1); now.watchers += 1; counted = now; }
    });
    return () => { unsub(); if (counted) counted.watchers = Math.max(0, counted.watchers - 1); };
  }, [key]);
  return key ? getJob<T>(key) : null;
}

/** Load once per key and keep it: the view's data, whether or not the view stays open while it loads. */
export function useBackgroundView<T>(load: ((ctx: JobContext) => Promise<T>) | null, key: string, owner: JobOwner | null = null):
  { data: T | null; error: string; loading: boolean; progress: unknown } {
  const state = useJob<T>(load ? key : null);
  const gen = generation;
  useEffect(() => {
    if (!load) return;
    const e = jobs.get(key);
    if (!e || e.status === 'error' || e.status === 'cancelled') startJob(key, load, owner);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!load, gen]);
  if (!load) return { data: null, error: '', loading: false, progress: null };
  if (!state) return { data: null, error: '', loading: true, progress: null };
  return { data: state.data, error: state.status === 'error' ? state.error : '', loading: state.status === 'loading', progress: state.progress };
}

export function useJobBadges(): Record<string, number> {
  useJobsVersion();
  return badges;
}

export function useJobNotices(): JobNotice[] {
  useJobsVersion();
  return notices;
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
