"""One reference FASTA read from several threads at once (audit F8).

pysam.FastaFile.fetch releases the GIL and a single handle is not thread-safe:
concurrent fetches silently return another request's sequence. state.fasta
is read from the event loop, request threads and the consensus job thread,
so ThreadLocalFasta serializes fetches on a shared native reader.
"""
from __future__ import annotations

import random
import threading

import pysam
import pytest

from services.fasta_handles import ThreadLocalFasta, get_fasta_handle

LENGTH = 400_000


@pytest.fixture(scope="module")
def reference(tmp_path_factory):
    rng = random.Random(1)
    seqs = {f"c{i}": "".join(rng.choice("ACGT") for _ in range(LENGTH)) for i in range(2)}
    path = tmp_path_factory.mktemp("fa") / "race.fa"
    with open(path, "w") as handle:
        for name, seq in seqs.items():
            handle.write(f">{name}\n")
            for i in range(0, LENGTH, 60):
                handle.write(seq[i:i + 60] + "\n")
    pysam.faidx(str(path))
    return str(path), seqs


def _hammer(fasta, seqs, threads=4, fetches=3000):
    mismatches, errors, done = [0], [], [0]
    lock = threading.Lock()

    def worker(seed):
        rng = random.Random(seed)
        try:
            for _ in range(fetches):
                name = f"c{rng.randint(0, 1)}"
                start = rng.randint(0, LENGTH - 5000)
                end = start + rng.randint(100, 5000)
                got = fasta.fetch(name, start, end)
                with lock:
                    done[0] += 1
                    if got != seqs[name][start:end]:
                        mismatches[0] += 1
        except Exception as exc:  # the shared-handle failure mode
            with lock:
                errors.append(exc)

    pool = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
    for t in pool:
        t.start()
    for t in pool:
        t.join()
    return done[0], mismatches[0], errors


def test_threaded_fetches_return_the_right_sequence(reference):
    path, seqs = reference
    fasta = ThreadLocalFasta(path)
    done, mismatches, errors = _hammer(fasta, seqs)
    assert not errors
    assert done == 4 * 3000
    assert mismatches == 0


def test_the_wrapper_keeps_the_fastafile_interface(reference):
    path, seqs = reference
    fasta = ThreadLocalFasta(path)
    assert fasta.references == ("c0", "c1") and fasta.nreferences == 2
    assert fasta.lengths == (LENGTH, LENGTH) and fasta.get_reference_length("c1") == LENGTH
    assert fasta.filename == path
    assert fasta.fetch("c0", 10, 20) == seqs["c0"][10:20]
    assert fasta.fetch(region="c1:1-5") == seqs["c1"][0:5]
    with pytest.raises(KeyError):
        fasta.get_reference_length("chrX")
    fasta.close()
    with pytest.raises(ValueError):
        fasta.fetch("c0", 0, 5)


def test_threads_reuse_the_same_native_reader(reference):
    path, _ = reference
    mine = get_fasta_handle(path)
    with get_fasta_handle(path).lease() as first, mine.lease() as second:
        assert first is second
    other = []
    t = threading.Thread(target=lambda: other.append(get_fasta_handle(path)))
    t.start()
    t.join()
    with other[0].lease() as first, mine.lease() as second:
        assert first is second


def test_browser_state_and_paired_references_load_thread_local_handles(reference, tmp_path):
    from services.reference_collection import ReferenceCollection
    from state.browser_state import BrowserState
    path, seqs = reference
    state = BrowserState(None, None, None, None)
    assert state._load_fasta(path) is None
    assert isinstance(state.fasta, ThreadLocalFasta)
    done, mismatches, errors = _hammer(state.fasta, seqs, fetches=500)
    assert not errors and mismatches == 0
    collection = ReferenceCollection([ThreadLocalFasta(path)])
    assert collection.fetch("c0", 0, 8) == seqs["c0"][:8]
    sandbox = BrowserState.fork_for_session(state, copy_shared=True, include_data=False)
    assert isinstance(sandbox.fasta, ThreadLocalFasta) and sandbox.fasta is not state.fasta
    sandbox.fasta.close()
    assert state.fasta.fetch("c1", 0, 8) == seqs["c1"][:8]  # the main tab's reference still works
