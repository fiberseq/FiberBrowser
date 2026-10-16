"""Live work counters for polling, independent of inference/results.

Only completed jobs reach overall completion. Each known-total stage has its own
bar; unknown-total stages remain indeterminate. No elapsed-time extrapolation.
"""
import time


def update_progress(job, stage, message, **work):
    now = time.time()
    job['updated_at'] = now
    # Existing kernels use message=None as a cancellation checkpoint. Do not
    # erase the actual stage/counters when a nested solver merely checks in.
    if message is None:
        return
    dataset = work.get('dataset_id')
    task = work.get('task', stage)
    key = (stage, dataset, task)
    previous = job.get('progress', {})
    same = tuple(previous.get('key', ())) == key
    completed, total = work.get('completed'), work.get('total')
    if total is not None:
        if not isinstance(total, int) or total < 0:
            raise ValueError('Nonnegative integer progress total required')
        if not isinstance(completed, int) or not 0 <= completed <= total:
            raise ValueError('Completed work must be within its total')
    else:
        completed = None
    monotonic=time.monotonic()
    # Detailed optimizer messages can arrive hundreds of times per second.
    # Keep cancellation/heartbeat checks live, but cap same-count text updates.
    if (same and completed==previous.get('completed') and total==previous.get('total')
            and monotonic-job.get('_progress_published_monotonic',-float('inf'))<.1):
        return
    job['_progress_published_monotonic']=monotonic
    fraction = completed / total if total else None
    if stage == 'complete':
        # The caller is finished, but indexing/atomic installation still runs.
        stage, message = 'finalizing', 'Inference finished; preparing browser layers'
        key = (stage, None, stage)
        same = False
        completed = total = fraction = None
    job.update(stage=stage, message=message)
    job['progress'] = dict(key=list(key), stage=stage, dataset_id=dataset,
        task=task, completed=completed, total=total, fraction=fraction,
        unit=work.get('unit'), detail=work.get('detail'),
        stage_started_at=previous['stage_started_at'] if same else now,
        semantics='completed items in the current stage; not a time estimate')


def finish_progress(job):
    job['progress'] = dict(stage='complete', task='complete', completed=1,
        total=1, fraction=1., unit='run', stage_started_at=time.time(),
        semantics='results installed successfully')
