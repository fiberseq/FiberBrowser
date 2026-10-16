"""Read-budget compatibility at the installed engine boundary."""
NAMES = ('max_discovery_molecules', 'max_quantification_molecules', 'sample_seed')


def machine_depth_parameters(state, params):
    """Apply the machine's analysis cap without relaxing an explicit smaller cap."""
    out = dict(params or {})
    cap = int(getattr(state, 'performance', {}).get('max_working_reads', 0) or 0)
    if cap:
        for name in NAMES[:2]:
            current = out.get(name, 0)
            out[name] = min(current, cap) if isinstance(current, int) and current > 0 else cap
    return out


def depth_parameters(params, supported):
    """Keep the uncapped call unchanged; refuse active budgets an engine cannot honor."""
    out = dict(params or {})
    for name in NAMES:
        value = out.get(name, 1 if name == 'sample_seed' else 0)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f'{name} must be a non-negative integer')
    active = any(out.get(n, 0) for n in NAMES[:2])
    if active and not supported:
        raise ValueError('Update FiberHMM (Settings > FiberHMM) to use read caps.')
    if not active:
        for name in NAMES:
            out.pop(name, None)
    return out
