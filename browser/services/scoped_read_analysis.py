"""Explicit analysis scopes never need totals for the unrequested population.

Only Scan, Sort and Cluster use this scope. General working-set callers retain
whole-viewport totals. Partial BAM loads never enter an unfiltered cache key.
"""
from contextvars import ContextVar
from functools import wraps

selected_analysis = ContextVar('selected_analysis', default=False)


def scoped_analysis(fn):
    @wraps(fn)
    def run(*args, **kwargs):
        token = selected_analysis.set(True)
        try:
            return fn(*args, **kwargs)
        finally:
            selected_analysis.reset(token)
    return run
