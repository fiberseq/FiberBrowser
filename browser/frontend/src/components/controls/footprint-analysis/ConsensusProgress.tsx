import {JobStatus,type JobState} from '../shared/JobStatus';
import type {ConsensusJob} from '../../../api/consensusWorkflow';
import {consensusPhase,engineMessage,stagePlan,stepIndex,tileProgress} from './consensusStagePlan';

const LABELS:Record<string,string>={queued:'Waiting for worker',loading:'Loading native observations',
  native:'Preparing native evidence',saving_input:'Saving input snapshot',sr:'Normalizing cross-strand boundaries',
  cr:'Fitting population classes',cr_nomination:'Discovering population classes',
  cr_classification:'Fitting and testing population classes',saving_models:'Saving native models',
  rescue:'Testing new-footprint rescue',comparability:'Measuring strand comparability',
  splitting:'Testing protected-span splits',xcr:'Testing cross-dataset relationships',
  finalizing:'Saving and installing layers',complete:'Consensus layers ready',
  native_cache:'Checking saved fits',native_fit:'Fitting footprint classes in each dataset',
  foreign_scoring:'Scoring classes across strands and datasets',parent_fit:'Fitting shared parent classes',
  resolution:'Choosing representative classes',
  recaller_discovery:'Finding classes',recaller_quantify:'Counting each class on the molecules',
  recaller_robustness:'Checking the classes with the reads in other orders',
  load:'Loading reads',saving:'Saving results',parent_cache:'Checking saved fits',
  consolidation:'Merging compatible classes',native_provenance:'Saving native models',cr_fit:'Fitting population classes',
  cr_assign:'Assigning footprints to classes',clustering:'Grouping footprints',models:'Saving models',
  population_rescue:'Testing new-footprint rescue',transfer:'Transferring classes'};

/** A plain name for the stage the run is in: never the worker's internal stage id (L9). */
export function stageLabel(job:ConsensusJob):string{
  if(LABELS[job.stage])return LABELS[job.stage];
  const plan=stagePlan(job),at=stepIndex(plan,job.stage);
  return at>=0?plan[at].label:'Working';
}

/** A consensus run's progress: the shared job-status pattern (shared/JobStatus.tsx) with this run's plan and words. */
export function ConsensusProgress({job,onCancel}:{job:ConsensusJob;onCancel?:()=>void}){
  const plan=stagePlan(job);
  const progress=job.progress;
  const unit=progress?.unit==='families'?'classes':progress?.unit??'items';
  return <JobStatus title="Consensus" state={job.status as JobState} stage={stageLabel(job)} doneTitle={stageLabel(job)}
    errorTitle="Consensus failed" cancelledTitle="Consensus cancelled"
    steps={plan} stepIndex={stepIndex(plan,job.stage)} runKey={job.job_id}
    startedAt={job.started_at??job.created_at} finishedAt={job.finished_at??null}
    progress={progress?{fraction:progress.fraction,completed:progress.completed,total:progress.total,unit}:null} stageProgress={tileProgress(job)} phase={consensusPhase(job)}
    message={engineMessage(job.message)} onCancel={onCancel} doneText="Results installed" progressLabel="Consensus current-stage progress"
    note={job.status==='cancelling'
      ?'Waiting for the current numerical operation to reach a cancellation checkpoint. Previous layers remain available.'
      :'The bar counts completed work in the current stage, not estimated time. It restarts for each dataset/stage; long fits continue between updates.'}
    stoppedNote="No new result was installed. Previous successful layers are retained."
    testId="consensus-progress" fillTestId="consensus-progress-fill" stepsTestId="consensus-stage-steps"/>;
}
