import { useEffect, useRef, useState } from 'react';
import {
  editLibraryEntry, getLibraryEntry, getLibraryEntryQc, locateLibraryEntry, recallLibraryEntry,
  removeLibraryEntries, rescanLibraryEntry, revealLibraryEntry, type LibraryEntry, type LibraryGroup, type RecallPlan,
  type RecallDefaultChange, type RecallNeedsInput, type RecallOptions, type RecallRewrite,
} from '../../../api/library';
import type { QcPayload } from '../../../api/pipeline';
import { pickAnyFile } from '../../../api/files';
import { KIND_LABELS, chemistryLabel, formatBytes, qcVerdict, referenceLabel, rerunConsequence } from '../../../utils/library';
import { openDafRunDialog } from '../daf-run/dafRunStore';
import { QcReport, VerdictChip } from '../daf-run/QcReport';
import { stateSummary, verdictItems } from '../../../utils/qcView';
import { basecallerLabel, basecallerTitle } from '../../../utils/basecaller';
import { Badge, EntryBadges } from './LibraryTable';
import { LibraryQcRun } from './LibraryQcRun';

const BUTTON = 'px-2 py-1 rounded border border-gray-300 dark:border-white/15 text-[11.5px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-40';
const PRIMARY = 'px-2.5 py-1 rounded bg-blue-500 text-white text-[11.5px] hover:bg-blue-600 disabled:opacity-40';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="flex gap-2 text-[11.5px] leading-5">
      <div className="w-28 shrink-0 text-gray-500 dark:text-gray-400">{label}</div>
      <div className="min-w-0 break-words whitespace-pre-line text-gray-800 dark:text-gray-100">{children}</div>
    </div>
  );
}

const CODE = 'block break-all whitespace-pre-wrap rounded bg-white/60 dark:bg-black/20 px-1 py-0.5';

/** Every change made to the original's options (a dropped option has no new value). */
function RecallRewrites({ rewrites }: { rewrites: RecallRewrite[] }) {
  if (!rewrites.length) return null;
  return (
    <div data-testid="library-recall-rewrites">
      <div>Changed from the original:</div>
      <ul className="list-disc pl-4">
        {rewrites.map((r, i) => (
          <li key={i} data-testid={r.to === null ? 'library-recall-dropped' : undefined}>
            <code>{r.flag}</code>: {r.from === null ? <em>not set</em> : <code className="break-all">{r.from}</code>}
            {' → '}{r.to === null ? <em>left out</em> : <code className="break-all">{r.to}</code>} ({r.why})
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Defaults FiberHMM 3.0 changed since the original run, each with a keep-the-original toggle where a flag exists. */
function RecallDefaultChanges({ changes, busy, onKeepOld }: {
  changes: RecallDefaultChange[];
  busy: boolean;
  onKeepOld: (changeId: string, keep: boolean) => void;
}) {
  if (!changes.length) return null;
  return (
    <div data-testid="library-recall-defaults">
      <div>Defaults FiberHMM 3.0 changed since the original run:</div>
      <ul className="list-disc pl-4">
        {changes.map(c => (
          <li key={c.id}>
            {c.text}
            {c.restore && (
              <label className="ml-1 inline-flex items-center gap-1">
                <input type="checkbox" checked={c.kept_old} disabled={busy}
                  onChange={e => onKeepOld(c.id, e.target.checked)} data-testid={`library-recall-keep-${c.id}`} />
                keep the original behaviour (<code>{c.restore.join(' ')}</code>)
              </label>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The basecaller the re-call's reads record, and whether an override is given again. */
function RecallBasecaller({ plan }: { plan: RecallPlan }) {
  const info = plan.settings.basecaller;
  if (info === undefined) return null;
  const overridden = Boolean(info?.overridden);
  return (
    <div data-testid="library-recall-basecaller" title={basecallerTitle(info)}>
      Basecaller: {basecallerLabel(info)}
      {overridden ? ' (an override: given to the re-call again)' : ''}
      {plan.reads.some(r => /\.basecalled\.bam$/i.test(r)) ? '. Starts from the run\'s basecalled reads: no basecalling again.' : ''}
    </div>
  );
}

/** A re-call from the command a BAM header records: the original command, the new one, and every change. */
function RecallHeaderReview({ plan, header, busy, onLocate, onKeepOld }: {
  plan: RecallPlan;
  header: NonNullable<RecallPlan['header']>;
  busy: boolean;
  onLocate: () => void;
  onKeepOld: (changeId: string, keep: boolean) => void;
}) {
  const input = header.input;
  return (
    <div className="space-y-1" data-testid="library-recall-header">
      <RecallBasecaller plan={plan} />
      <div data-testid="library-recall-settings">
        Settings from the BAM header: the {header.program}{header.version ? ` ${header.version}` : ''} command it
        records, re-run with the same tool and FiberHMM {plan.version ?? 'current'}. Every other option is kept as it was.
      </div>
      <div>
        Input ({input.flag}): <code className="break-all">{input.path}</code>
        {input.how !== 'as recorded' && <span> ({input.how === 'you chose it' ? 'you chose it' : `recorded as ${input.recorded}; ${input.how}`})</span>}
        <button type="button" className="ml-2 underline" disabled={busy} onClick={onLocate}
          data-testid="library-recall-locate-input">Choose another file…</button>
      </div>
      {header.warnings.length > 0 && (
        <ul className="list-disc pl-4 text-amber-800 dark:text-amber-200" data-testid="library-recall-warnings">
          {header.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <div>Original command (from the BAM header):</div>
      <code className={CODE} data-testid="library-recall-original">{header.command_line}</code>
      <div>Re-call command:</div>
      <code className={CODE} data-testid="library-recall-command">{plan.display_command}</code>
      <RecallRewrites rewrites={header.rewrites} />
      <RecallDefaultChanges changes={header.changed_defaults} busy={busy} onKeepOld={onKeepOld} />
      {header.not_fixed.length > 0 && (
        <div data-testid="library-recall-not-fixed">
          Does not fix: {header.not_fixed.map(n => `${n.title} (${n.reason})`).join('; ')}.
        </div>
      )}
    </div>
  );
}

interface Props {
  entry: LibraryEntry;
  groups: LibraryGroup[];
  fiberhmmVersion: string | null;
  onOpen: (entries: LibraryEntry[]) => void;
  onChanged: (message?: string) => void;
  onAddToGroup: (entryIds: string[]) => void;
}

/** Everything the Library knows about one file, and what can be done with it. */
export function LibraryDetails({ entry, groups, fiberhmmVersion, onOpen, onChanged, onAddToGroup }: Props) {
  const [full, setFull] = useState<LibraryEntry>(entry);
  const [qc, setQc] = useState<QcPayload | null>(null);
  const [tags, setTags] = useState((entry.tags ?? []).join(', '));
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recallPlan, setRecallPlan] = useState<RecallPlan | null>(null);
  // A dry run that could not find the input the BAM header names (the user can point at it),
  // or that found no way to re-call but a New DAF-seq run; both only for the entry they were for.
  const [recallNeeds, setRecallNeeds] = useState<{ entryId: string; input?: RecallNeedsInput; startNew?: boolean } | null>(null);
  // The entry shown now: an answer that arrives after the user selected another
  // entry belongs to the earlier one and is dropped.
  const shownId = useRef(entry.id);
  shownId.current = entry.id;

  useEffect(() => {
    setFull(entry);
    setTags((entry.tags ?? []).join(', '));
    setNotes(entry.notes ?? '');
    setMessage(null);
    setRecallPlan(null);
    setRecallNeeds(null);
    setQc(null);
    let cancelled = false;
    getLibraryEntry(entry.id).then(res => { if (!cancelled) setFull({ ...entry, ...res.entry }); }).catch(() => {});
    if (entry.qc?.json) {
      getLibraryEntryQc(entry.id).then(res => { if (!cancelled) setQc(res); }).catch(() => {});
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.inspected]);

  const run = async (name: string, action: () => Promise<string | void>) => {
    setBusy(name);
    setMessage(null);
    try {
      const done = await action();
      if (done) setMessage(done);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveNotes = () => run('save', async () => {
    const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
    await editLibraryEntry(entry.id, { tags: tagList, notes });
    onChanged('Saved.');
  });

  const locate = () => run('locate', async () => {
    const picked = await pickAnyFile();
    const path = picked.paths?.[0] ?? picked.path;
    if (!picked.success || !path) return;
    let res = await locateLibraryEntry(entry.id, path);
    if (!res.success && res.needs_confirmation) {
      // No content fingerprint was recorded: only the user can vouch that this is the file.
      if (!window.confirm(res.error || 'The Library cannot verify this file. Relocate the entry anyway?')) return;
      res = await locateLibraryEntry(entry.id, path, true);
    }
    if (!res.success) return res.error || 'Could not use that file.';
    onChanged(`Found at ${path}.`);
  });

  // The plan on screen, only if it is this entry's (never another entry's late answer).
  const plan = recallPlan && recallPlan.entry_id === entry.id ? recallPlan : null;

  // The choices a re-call was planned with (an input the user located, original behaviours kept);
  // Start sends them again so the server re-plans exactly what was reviewed.
  const keptOf = (reviewed: RecallPlan | null): string[] =>
    reviewed?.header?.keep_old ?? reviewed?.settings.keep_old ?? [];
  const choicesOf = (reviewed: RecallPlan | null): Pick<RecallOptions, 'input' | 'keep_old'> => {
    const out: Pick<RecallOptions, 'input' | 'keep_old'> = {};
    const header = reviewed?.header;
    if (header?.input.how === 'you chose it') out.input = header.input.path;
    const kept = keptOf(reviewed);
    if (kept.length) out.keep_old = kept;
    return out;
  };

  /** Ask for the plan (a dry run); nothing starts. Returns the message to show, if any. */
  const askPlan = async (choices: Pick<RecallOptions, 'input' | 'keep_old'> = {}): Promise<string | void> => {
    const id = entry.id;
    let res;
    try {
      res = await recallLibraryEntry(id, { dry_run: true, ...choices });
    } catch (err) {
      if (shownId.current !== id) return;
      throw err;
    }
    if (shownId.current !== id) return;
    if (!res.success || !res.plan) {
      setRecallPlan(null);
      setRecallNeeds(res.needs_input || res.start_new_run
        ? { entryId: id, input: res.needs_input, startNew: res.start_new_run } : null);
      return res.error || 'Cannot re-call this file.';
    }
    if (res.plan.entry_id !== id) return 'The re-call plan was for another file; try again.';
    setRecallNeeds(null);
    setRecallPlan(res.plan);
  };
  const planRecall = (choices: Pick<RecallOptions, 'input' | 'keep_old'> = {}) => run('recall', () => askPlan(choices));

  const recall = () => {
    const reviewed = plan;
    if (!reviewed) return planRecall();
    return run('recall', async () => {
      const id = entry.id;
      let res;
      try {
        // Start exactly the plan that was reviewed; the server refuses if it changed since.
        res = await recallLibraryEntry(id, {
          outdir: reviewed.outdir, cores: reviewed.cores, plan_id: reviewed.plan_id, ...choicesOf(reviewed),
        });
      } catch (err) {
        if (shownId.current !== id) return;
        throw err;
      }
      if (shownId.current !== id) return;
      setRecallPlan(null);
      if (!res.success || !res.job) return res.error || 'Could not start the run.';
      openDafRunDialog('runs', res.job.id);
      return 'Re-call started: follow it in Runs. The result joins the Library when it finishes.';
    });
  };

  /** Point at the input the BAM header names, then plan again with it. */
  const locateInput = () => run('recall', async () => {
    const id = entry.id;
    const picked = await pickAnyFile();
    const path = picked.paths?.[0] ?? picked.path;
    if (!picked.success || !path || shownId.current !== id) return;
    return askPlan({ ...choicesOf(plan), input: path });
  });

  /** Keep (or drop) the original behaviour for a default FiberHMM 3.0 changed, then plan again. */
  const toggleKeepOld = (changeId: string, keep: boolean) => {
    const current = keptOf(plan);
    const keepOld = keep ? [...new Set([...current, changeId])] : current.filter(k => k !== changeId);
    return planRecall({ ...choicesOf(plan), keep_old: keepOld });
  };

  const needs = recallNeeds && recallNeeds.entryId === entry.id ? recallNeeds : null;
  const header = plan?.header ?? null;

  const verdicts = entry.qc?.verdicts ?? {};
  const advisories = full.advisories?.items ?? [];
  const canRecall = entry.kind === 'bam' && ['dddb', 'ddda'].includes(entry.chemistry?.key ?? '');
  const inGroups = groups.filter(g => g.entry_ids.includes(entry.id));
  const ref = full.reference;

  return (
    <div className="space-y-3" data-testid="library-details">
      <div>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-gray-900 dark:text-gray-50 break-words">{entry.label}</div>
            <div className="text-[11px] text-gray-500 break-all">{entry.path}</div>
          </div>
        </div>
        <div className="mt-1 flex flex-wrap gap-1"><EntryBadges entry={entry} /></div>
        {/* What the advisories mean, in one line; their text is folded below (round 3, R15). */}
        {entry.rerun && (
          <div className="mt-1 text-[11.5px] text-amber-900 dark:text-amber-100" data-testid="library-rerun-consequence">{rerunConsequence(entry)}</div>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        <button type="button" className={PRIMARY} disabled={!entry.available || entry.cloud_only || busy !== null}
          onClick={() => onOpen([entry])} data-testid="library-open">Open</button>
        {!entry.available && <button type="button" className={BUTTON} onClick={locate} disabled={busy !== null} data-testid="library-locate">Locate…</button>}
        <button type="button" className={BUTTON} onClick={() => onAddToGroup([entry.id])}>Add to group…</button>
        <button type="button" className={BUTTON} disabled={busy !== null}
          onClick={() => run('rescan', async () => {
            const res = await rescanLibraryEntry(entry.id);
            if (!res.success) return res.error || 'Could not re-read the file.';
            onChanged('Re-read.');
          })} data-testid="library-rescan">Re-scan</button>
        <button type="button" className={BUTTON} disabled={busy !== null}
          onClick={() => run('reveal', async () => {
            const res = await revealLibraryEntry(entry.id);
            if (!res.success) return res.error || 'Could not show the file.';
          })} data-testid="library-reveal">Reveal in {navigatorFileManager()}</button>
        <button type="button" className={`${BUTTON} text-red-600 dark:text-red-300`} disabled={busy !== null}
          title="Forget this entry (the file is not deleted)"
          onClick={() => run('remove', async () => {
            await removeLibraryEntries([entry.id]);
            onChanged('Removed from the Library (the file was not touched).');
          })} data-testid="library-remove">Remove from Library</button>
      </div>
      {message && <div className="text-[11.5px] text-gray-700 dark:text-gray-200 whitespace-pre-line" data-testid="library-details-message">{message}</div>}

      {(entry.rerun || advisories.length > 0) && (
        <div className="rounded border border-amber-300 dark:border-amber-600/50 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-1" data-testid="library-advisories">
          {advisories.length > 0 ? (
            <details data-testid="library-advisories-details">
              <summary className="cursor-pointer text-[12px] font-semibold text-amber-900 dark:text-amber-100">
                FiberHMM advisories ({advisories.length}) <span className="font-normal opacity-80">· why, and how to fix</span>
              </summary>
              <div className="mt-1 space-y-1">
                {advisories.map((a, i) => (
                  <div key={a.id ?? i} className="text-[11.5px] text-amber-900 dark:text-amber-100">
                    <span className="font-medium">{a.title || a.id}</span>
                    {a.severity && <span className="opacity-75"> ({a.severity})</span>}
                    {a.reason && <div className="opacity-90">{a.reason}</div>}
                    {(a.fix || a.fix_action) && <div className="opacity-75">Fix: {String(a.fix || a.fix_action)}</div>}
                  </div>
                ))}
              </div>
            </details>
          ) : (
            <div className="text-[12px] font-semibold text-amber-900 dark:text-amber-100">FiberHMM advisories</div>
          )}
          {canRecall && (
            <div className="pt-1 space-y-1">
              <button type="button" className={PRIMARY} disabled={busy !== null} onClick={recall} data-testid="library-recall">
                {plan ? 'Start the re-call' : `Re-call with FiberHMM ${fiberhmmVersion ?? 'current'}`}
              </button>
              {plan && (
                <div className="text-[11px] text-gray-700 dark:text-gray-200 space-y-0.5" data-testid="library-recall-plan">
                  <div>
                    Runs <code>{plan.tool}</code> on {plan.reads.join(', ')} into <code>{plan.outdir}</code>.
                    <button type="button" className="ml-2 underline" onClick={() => setRecallPlan(null)}>Cancel</button>
                  </div>
                  {header ? (
                    <RecallHeaderReview plan={plan} header={header} busy={busy !== null}
                      onLocate={locateInput} onKeepOld={toggleKeepOld} />
                  ) : (
                    <>
                      <div data-testid="library-recall-settings">
                        Keeps the original run's settings ({plan.settings.source === 'outputs.json' ? "from the run's outputs.json" : 'from the run record'}):{' '}
                        {plan.settings.labels.length ? plan.settings.labels.join(', ') : 'all at their defaults'}.
                      </div>
                      <RecallBasecaller plan={plan} />
                      <div>
                        {plan.regions.length ? `Regions: ${plan.regions.join(', ')}.`
                          : plan.settings.regions_recorded ? 'Regions: the whole run.'
                            : "Regions: not recorded by the run; the re-call reads only the reads the run kept."}
                      </div>
                      <RecallRewrites rewrites={plan.settings.rewrites ?? []} />
                      <RecallDefaultChanges changes={plan.settings.changed_defaults ?? []} busy={busy !== null}
                        onKeepOld={toggleKeepOld} />
                    </>
                  )}
                  {plan.advisories_fixed.length > 0 && <div>Fixes: {plan.advisories_fixed.join(', ')}.</div>}
                  {!header && <code className="block break-all rounded bg-white/60 dark:bg-black/20 px-1 py-0.5">{plan.display_command}</code>}
                </div>
              )}
              {!plan && needs?.input && (
                <div className="text-[11px] text-gray-700 dark:text-gray-200" data-testid="library-recall-needs-input">
                  The header names <code className="break-all">{needs.input.recorded}</code> as the input ({needs.input.flag}).{' '}
                  <button type="button" className={BUTTON} disabled={busy !== null} onClick={locateInput}
                    data-testid="library-recall-locate-input">Locate the input…</button>
                </div>
              )}
              {!plan && needs?.startNew && (
                <button type="button" className={BUTTON} onClick={() => openDafRunDialog('new')}
                  data-testid="library-recall-new-run">New DAF-seq run…</button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-0.5">
        <Row label="Kind">{KIND_LABELS[entry.kind]}{entry.role ? ` (${entry.role})` : ''}</Row>
        <Row label="Sample">{entry.sample}</Row>
        <Row label="Chemistry">
          {chemistryLabel(entry)}
          {entry.chemistry?.platform ? ` · ${entry.chemistry.platform}` : ''}
          {entry.chemistry?.declared ? ' (declared in the header)' : ''}
        </Row>
        {entry.kind === 'bam' && (
          <div className="flex gap-2 text-[11.5px] leading-5" data-testid="library-basecaller" title={basecallerTitle(full.basecaller ?? entry.basecaller)}>
            <div className="w-28 shrink-0 text-gray-500 dark:text-gray-400">Basecaller</div>
            <div className={`min-w-0 break-words ${(full.basecaller ?? entry.basecaller)?.available ? 'text-gray-800 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
              {basecallerLabel(full.basecaller ?? entry.basecaller)}
              {(full.basecaller ?? entry.basecaller)?.overridden ? ' (given with --basecaller-info)' : ''}
            </div>
          </div>
        )}
        <Row label="FiberHMM">
          {full.fiberhmm?.fiberhmm_version ? `${full.fiberhmm.fiberhmm_version}${full.fiberhmm.fiberhmm_commit ? ` (${full.fiberhmm.fiberhmm_commit})` : ''}` : ''}
        </Row>
        <Row label="Tables">
          {[full.fiberhmm?.apply_sha256 && `apply ${full.fiberhmm.apply_sha256.slice(0, 12)}`, full.fiberhmm?.recall_sha256 && `recall ${full.fiberhmm.recall_sha256.slice(0, 12)}`].filter(Boolean).join(' · ')}
        </Row>
        <Row label="Reference">
          {referenceLabel(entry)}
          {ref?.n_contigs ? ` · ${ref.n_contigs.toLocaleString()} contig${ref.n_contigs === 1 ? '' : 's'}` : ''}
        </Row>
        <Row label="Graph lift">{full.graph_lift?.text}</Row>
        <Row label="Reads">{entry.reads != null ? entry.reads.toLocaleString() : ''}</Row>
        <Row label="Size">{formatBytes(entry.identity?.size)}</Row>
        <Row label="Date">{entry.date ? `${entry.date.replace('T', ' ')}${entry.date_source ? ` (${entry.date_source})` : ''}` : ''}</Row>
        <Row label="Run">{entry.job ? `New DAF-seq run ${entry.job.id}` : entry.pipeline ? entry.pipeline.outdir : ''}</Row>
        <Row label="Groups">{inGroups.map(g => g.name).join(', ')}</Row>
        <Row label="Files beside it">
          {[...(full.sidecar_errors ?? []), ...(full.sidecars_online_only ?? []).map(p => `${p.split('/').pop()}: online-only, not read`)].join('\n')}
        </Row>
        <Row label="Found by">{(entry.sources ?? []).map(s => s.replace(/^watched:.*/, 'watched folder').replace(/^job:.*/, 'DAF-seq run')).filter((s, i, all) => all.indexOf(s) === i).join(', ')}</Row>
      </div>

      <div className="space-y-1">
        <div className="text-[12px] font-semibold text-gray-700 dark:text-gray-200">QC</div>
        {qc?.available ? (
          <QcReport payload={qc} />
        ) : qcVerdict(entry) ? (
          <div className="flex flex-wrap gap-1">
            {verdictItems({ ...(verdicts.verdict_basis ? { signal_label: entry.qc?.numbers?.signal_label } : {}), ...verdicts }, true).filter(v => v.status).map(v => (
              <VerdictChip key={v.key} label={v.label} status={v.status} score={v.score} title={v.title} muted={!v.inVerdict} />
            ))}
            {stateSummary({ ...(entry.qc?.numbers ?? {}), ...verdicts }, false).map(item => (
              <span key={item.label} title={item.title} className="text-[11px] text-gray-500 dark:text-gray-400" data-testid={`library-qc-${item.label.toLowerCase()}`}>
                {item.label} <span className="font-medium text-gray-800 dark:text-gray-100">{item.value}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[11.5px] text-gray-500">No fiberhmm-qc results for this file yet.</div>
        )}
        <div className="flex flex-wrap gap-1">
          {entry.job && <button type="button" className={BUTTON} onClick={() => openDafRunDialog('runs', entry.job!.id)} data-testid="library-open-run">Open in Runs</button>}
        </div>
        {entry.kind === 'bam' && <LibraryQcRun entry={entry} result={qc} onResult={setQc} onChanged={() => onChanged()} />}
      </div>

      <div className="space-y-1">
        <label className="block text-[11.5px] text-gray-500">Tags (comma-separated)
          <input className="mt-0.5 w-full px-2 py-1 text-[12px] border rounded dark:bg-gray-900 dark:border-gray-600" value={tags}
            onChange={e => setTags(e.target.value)} data-testid="library-tags-input" />
        </label>
        <label className="block text-[11.5px] text-gray-500">Notes
          <textarea className="mt-0.5 w-full px-2 py-1 text-[12px] border rounded dark:bg-gray-900 dark:border-gray-600" rows={3} value={notes}
            onChange={e => setNotes(e.target.value)} data-testid="library-notes-input" />
        </label>
        <button type="button" className={BUTTON} disabled={busy !== null} onClick={saveNotes} data-testid="library-save-notes">Save tags and notes</button>
        {entry.tags?.length ? <div className="flex flex-wrap gap-1">{entry.tags.map(t => <Badge key={t}>#{t}</Badge>)}</div> : null}
      </div>
    </div>
  );
}

function navigatorFileManager(): string {
  const platform = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '';
  if (/Mac/i.test(platform)) return 'Finder';
  if (/Win/i.test(platform)) return 'Explorer';
  return 'file manager';
}
