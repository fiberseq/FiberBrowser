"""Machine performance settings and runtime retention budgets."""
from __future__ import annotations

import os
import threading
import weakref

from services.byte_cache import ByteCache

MIB = 1024 ** 2
GIB = 1024 ** 3
MODES = ('auto', 'low', 'standard', 'high')
CACHE_NAMES = {
    '_broad_cache': 'broad', '_working_set_cache': 'working',
    '_methylation_cache': 'direct', '_meta_profile_cache': 'profiles',
    '_track_data_cache': 'tracks', '_track_region_cache': 'track_regions',
    '_broad_read_index_cache': 'indexes', '_coverage_payload_cache': 'coverage',
}
_lock = threading.RLock()
_states = weakref.WeakValueDictionary()


def machine_hardware() -> dict:
    memory = 0
    try:
        import psutil
        memory = int(psutil.virtual_memory().total)
    except (ImportError, OSError, AttributeError, ValueError):
        pass
    if memory <= 0:
        try:
            memory = int(os.sysconf('SC_PHYS_PAGES')) * int(os.sysconf('SC_PAGE_SIZE'))
        except (AttributeError, OSError, ValueError):
            pass
    if memory <= 0 and os.name == 'nt':
        # Native fallback: psutil is optional in source and packaged installs.
        import ctypes
        class MemoryStatus(ctypes.Structure):
            _fields_ = [('length', ctypes.c_uint32), ('load', ctypes.c_uint32)] + [
                (name, ctypes.c_uint64) for name in ('total_physical', 'available_physical',
                    'total_page_file', 'available_page_file', 'total_virtual', 'available_virtual', 'extended')]
        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        try:
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                memory = int(status.total_physical)
        except (AttributeError, OSError):
            pass
    memory = max(0, memory)
    return {'total_memory_bytes': memory, 'cores': os.cpu_count() or 1}


def effective_mode(mode: str, hardware: dict, browser_tier=None) -> str:
    if mode not in MODES:
        raise ValueError('Choose Auto, Low memory, Standard, or High performance.')
    if mode != 'auto':
        return mode
    ram, cores = hardware['total_memory_bytes'], hardware['cores']
    if browser_tier == 'low' or cores <= 4 or (0 < ram <= 8 * GIB):
        return 'low'
    if ram >= 32 * GIB and cores >= 12:
        return 'high'
    return 'standard'


def mode_limits(mode: str, hardware: dict) -> dict:
    if mode == 'low':
        budgets = (128, 64, 128, 16, 8, 8, 16, 16)
        return dict(cache_bytes={key: value * MIB for key, value in zip(CACHE_NAMES.values(), budgets)},
                    max_working_reads=2000, sample_target=1000, prefetch_multiplier=1,
                    margin_fraction=0, workers=1, decode_workers=1, numeric_threads=1,
                    reader_handles=32, bam_threads=1,
                    client_cohort_bytes=128 * MIB, client_expansion_bytes=16 * MIB)
    if mode == 'high':
        # At 64 GiB, retain at most 12 GiB across the main server caches.
        scale = max(1, min(4, hardware['total_memory_bytes'] / (16 * GIB)))
        budgets = (1024, 512, 1024, 128, 64, 64, 128, 128)
        return dict(cache_bytes={key: int(value * MIB * scale) for key, value in zip(CACHE_NAMES.values(), budgets)},
                    max_working_reads=0, sample_target=4000, prefetch_multiplier=20,
                    margin_fraction=1, workers=min(4, hardware['cores']),
                    decode_workers=min(8 if hardware['total_memory_bytes'] >= 64 * GIB else 4, hardware['cores']),
                    numeric_threads=min(8, hardware['cores']),
                    reader_handles=min(256, int(64 * scale)), bam_threads=4,
                    client_cohort_bytes=int(1.5 * GIB * scale), client_expansion_bytes=256 * MIB)
    budgets = (1024, 512, 2048, 128, 64, 64, 128, 128)
    return dict(cache_bytes={key: value * MIB for key, value in zip(CACHE_NAMES.values(), budgets)},
                max_working_reads=0, sample_target=4000, prefetch_multiplier=10,
                margin_fraction=0.5, workers=2, decode_workers=1, numeric_threads=2,
                reader_handles=128, bam_threads=4,
                client_cohort_bytes=3 * GIB, client_expansion_bytes=128 * MIB)


def ensure_caches(state, limits):
    for attr, name in CACHE_NAMES.items():
        cache = getattr(state, attr, None)
        if isinstance(cache, ByteCache):
            cache.resize(limits['cache_bytes'][name])
        else:
            from services.byte_cache import shared_cache
            replacement = shared_cache(name, limits['cache_bytes'][name])
            if cache:
                replacement.update(cache)
            setattr(state, attr, replacement)


def apply_mode(state, mode='auto', browser_tier=None, *, invalidate=True) -> dict:
    """Apply immediately; old in-flight decodes cannot repopulate retained caches."""
    with _lock:
        try:
            _states[id(state)] = state
        except TypeError:  # Lightweight state doubles need not support weak references.
            pass
        hardware = machine_hardware()
        effective = effective_mode(mode, hardware, browser_tier)
        limits = mode_limits(effective, hardware)
        if not hasattr(state, '_configured_max_working_reads'):
            state._configured_max_working_reads = int(getattr(state, 'max_working_reads', 0) or 0)
        configured = state._configured_max_working_reads
        cap = limits['max_working_reads']
        state.max_working_reads = min(configured, cap) if configured and cap else configured or cap
        limits['max_working_reads'] = state.max_working_reads
        previous = getattr(state, 'performance', None)
        state.performance = dict(mode=mode, effective=effective, hardware=hardware, **limits)
        state.config['prefetch_multiplier'] = limits['prefetch_multiplier']
        if invalidate and previous != state.performance:
            from services.dataset_generation import bump_dataset_generation
            from services.read_stream import cancel_prefetches
            cancel_prefetches()
            for dataset_id in getattr(state, 'datasets', {}):
                bump_dataset_generation(state, dataset_id)
            for attr in CACHE_NAMES:
                cache = getattr(state, attr, None)
                if cache is not None:
                    cache.clear()
        ensure_caches(state, limits)
        from services.byte_cache import configure_shared_caches
        configure_shared_caches(limits['cache_bytes'])
        from services.background_work import configure_workers
        configure_workers(limits['workers'], limits['numeric_threads'])
        from services.file_handles import handles
        from services.bam_handles import configure_bam_threads
        handles.resize(limits['reader_handles'])
        configure_bam_threads(limits['bam_threads'])
        return diagnostics(state)


def apply_machine_mode(state, mode='auto', browser_tier=None):
    """A machine preference also updates workspaces that are already open."""
    with _lock:
        effective_mode(mode, machine_hardware(), browser_tier)
        states = {id(current): current for current in list(_states.values())}
        states[id(state)] = state
        for current in states.values():
            apply_mode(current, mode, browser_tier)
        return diagnostics(state)


def initialize(state):
    from services.app_settings import load
    mode = load().get('performance', {}).get('mode', 'auto')
    apply_mode(state, mode if mode in MODES else 'auto', invalidate=False)


def release_caches(state):
    """Discard reproducible views while retaining the user's analysis results."""
    from services.working_sets import _broad_cache_sync
    from services.dataset_generation import bump_dataset_generation
    lock, _inflight = _broad_cache_sync(state)
    with lock:
        for dataset_id in getattr(state, 'datasets', {}):
            bump_dataset_generation(state, dataset_id)
        for attr in CACHE_NAMES:
            cache = getattr(state, attr, None)
            if cache is not None:
                cache.clear()


def diagnostics(state) -> dict:
    result = dict(state.performance)
    from services.file_handles import handles
    result['readers'] = handles.diagnostics()
    from services.byte_cache import shared_cache_diagnostics
    result['shared_caches'] = shared_cache_diagnostics()
    result['caches'] = {name: {'budget_bytes': cache.max_bytes, 'retained_bytes': cache.retained_bytes,
                             'entries': len(cache)}
                        for attr, name in CACHE_NAMES.items()
                        if isinstance(cache := getattr(state, attr, None), ByteCache)}
    return result
