"""The hardware tests see (tests/conftest.py): at least a Standard machine.

Auto performance follows the machine: 4 cores or 8 GiB or less is Low memory
(services/performance.py), e.g. GitHub's 4-core Linux runners, and Low memory
caps working sets and samples a view's reads. Tests about sampling and caching
assume at least a Standard machine, so the hardware they see is raised to 8
cores / 16 GiB (a bigger machine keeps its own, e.g. High on a developer's
Mac). Low memory is tested by choosing it (apply_mode(state, 'low'));
``@pytest.mark.real_hardware`` sees the real probe.

The state lives here, not in conftest: the suite imports conftest both as
``conftest`` and as ``tests.conftest``, and each copy would otherwise install
its own wrapper with its own flag.
"""
from __future__ import annotations

REAL = {"on": False}


def install() -> None:
    """Wrap services.performance.machine_hardware once (idempotent across imports)."""
    from services import performance
    if getattr(performance.machine_hardware, "_fiberbrowser_test_floor", False):
        return
    real = performance.machine_hardware

    def test_machine_hardware():
        hardware = real()
        if REAL["on"]:
            return hardware
        return {**hardware, "total_memory_bytes": max(hardware["total_memory_bytes"], 16 * performance.GIB),
                "cores": max(hardware["cores"], 8)}

    test_machine_hardware.real = real
    test_machine_hardware._fiberbrowser_test_floor = True
    performance.machine_hardware = test_machine_hardware
