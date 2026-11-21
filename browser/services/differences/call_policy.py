"""Shared evidence-policy grouping, independent of presentation state."""


def allowed_level(level, policy):
    return level == 'confirmed' or bool(policy.get('include_' + str(level), False))


def molecule_group(value, target_type, policy):
    call = value['call']
    if target_type == 'geometry':
        geometry = value.get('geometry_evidence') or {}
        if 'assignment' in geometry:
            call = geometry
        elif 'geometry_group' in value:
            group = value['geometry_group']
            return 2 if group == 0 and not allowed_level(geometry.get('level', call.get('level')), policy) else group
    if call['assignment'] == 'target' and allowed_level(call.get('level'), policy):
        return 0
    return 1 if call['assignment'] == 'reference' else 2
