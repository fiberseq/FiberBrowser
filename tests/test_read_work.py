"""Leaving a cold view must release its readers for the view that replaced it."""
import asyncio
import inspect
import threading
import time

import pytest
from fastapi.params import Param

from services import background_work as background
from services.read_work import run_read_work


class Request:
    def __init__(self):
        self.scope = {}
        self.headers = {}
        self.gone = asyncio.Event()

    async def is_disconnected(self):
        return self.gone.is_set()


async def wait_for(event):
    async def poll():
        while not event.is_set():
            await asyncio.sleep(.001)
    await asyncio.wait_for(poll(), 3)


def test_even_a_single_dataset_keeps_the_event_loop_responsive():
    loop_thread = threading.get_ident()
    started, release = threading.Event(), threading.Event()

    def build():
        assert threading.get_ident() != loop_thread
        assert background.is_interactive_read()
        started.set()
        assert release.wait(3)
        return 'complete'

    async def main():
        work = asyncio.create_task(run_read_work(None, [build]))
        try:
            await wait_for(started)
        finally:
            release.set()
        assert await work == ['complete']

    asyncio.run(main())


@pytest.mark.parametrize('route_name,dataset_count', [('get_reads_compact', 1),
    ('get_reads_compact_all', 1), ('get_reads_compact_all', 3)])
def test_disconnected_read_route_stops_all_dataset_workers(monkeypatch, route_name, dataset_count):
    from pathlib import Path
    from routers import reads
    from state.browser_state import BrowserState
    state = BrowserState(None, reference_only=True)
    fixture = Path(__file__).parent / 'fixtures/fibertools_frame/fiberhmm3.0.0_call.bam'
    ids = [f'd{i}' for i in range(dataset_count)]
    for did in ids:
        state.add_dataset(did, str(fixture))
    started = [threading.Event() for _ in ids]
    stopped = [threading.Event() for _ in ids]
    completed = []

    def build(**kwargs):
        i = ids.index(kwargs['dataset_id'])
        started[i].set()
        try:
            for _ in range(300):
                background.checkpoint()
                time.sleep(.005)
            completed.append(i)
            raise AssertionError('An abandoned display load ran to completion')
        finally:
            stopped[i].set()

    monkeypatch.setattr(reads, 'compact_reads_payload_for_request', build)
    monkeypatch.setattr(reads, 'compact_all_dataset_result', build)
    route = getattr(reads, route_name)
    defaults = {name: p.default.default for name, p in inspect.signature(route).parameters.items()
                if isinstance(p.default, Param)}

    async def main():
        request = Request()
        options = dict(defaults, chrom='chrT', start=100, end=500, request=request, state=state)
        options['dataset_id' if dataset_count == 1 else 'dataset_ids'] = ','.join(ids)
        task = asyncio.create_task(route(**options))
        for event in started:
            await wait_for(event)
        request.gone.set()
        response = await asyncio.wait_for(task, 2)
        assert response.status_code == 499
        for event in stopped:
            await wait_for(event)
        assert not completed

    asyncio.run(main())
    assert background.reads_in_flight() == 0


def test_cancelling_one_request_does_not_cancel_a_different_live_view():
    stopped, started, release = threading.Event(), threading.Event(), threading.Event()

    def obsolete():
        started.set()
        try:
            while True:
                background.checkpoint()
                time.sleep(.005)
        finally:
            stopped.set()

    def current():
        assert release.wait(3)
        background.checkpoint()
        return 'current reads'

    async def main():
        request = Request()
        old = asyncio.create_task(run_read_work(request, [obsolete]))
        new = asyncio.create_task(run_read_work(None, [current]))
        await wait_for(started)
        request.gone.set()
        with pytest.raises(background.Cancelled):
            await old
        await wait_for(stopped)
        release.set()
        assert await new == ['current reads']

    asyncio.run(main())
