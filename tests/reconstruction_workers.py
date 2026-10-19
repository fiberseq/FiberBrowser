"""Importable numerical worker for real process-reclamation tests (no server)."""
from pathlib import Path


def compiled_work(marker):
    from numba import njit

    @njit(nogil=True, cache=False)
    def spin(n):
        result = 0.0
        for i in range(n):
            result = (result + i % 1237) ** .5
        return result

    spin(1)  # compilation completes before reporting that the kernel is ready
    Path(marker).write_text('ready')
    return spin(100_000_000_000)
