"""Lossless CIGAR replacements and reference-aware canonical indel anchors."""
from __future__ import annotations

from functools import lru_cache


def cigar_replacements(pieces, *, piece_min=10, merge_gap=10):
    groups, group, bridge = [], [], []
    for op, ref, length, q in pieces:
        if op in (1, 2):
            group.extend(bridge)
            bridge = []
            group.append((op, ref, length, q))
        elif op in (0, 7, 8) and group and sum(p[2] for p in bridge) + length <= merge_gap:
            bridge.append((op, ref, length, q))
        else:
            if group:
                groups.append(group)
            group, bridge = [], []
    if group:
        groups.append(group)
    out = []
    for group in groups:
        indels = [p for p in group if p[0] in (1, 2)]
        if not any(p[2] >= piece_min for p in indels):
            continue
        first, last = group[0], group[-1]
        ins = sum(p[2] for p in indels if p[0] == 1)
        deleted = sum(p[2] for p in indels if p[0] == 2)
        t = 'I' if ins >= deleted else 'D'
        event = dict(t=t, ref=first[1], len=max(ins, deleted), q=first[3])
        if len(group) > 1:
            ref_end = last[1] + (last[2] if last[0] == 2 else 0)
            q_end = last[3] + (last[2] if last[0] == 1 else 0)
            event.update(ref_end=ref_end, ref_len=ref_end - first[1], q_end=q_end,
                         alt_len=q_end - first[3], inserted_len=ins, deleted_len=deleted,
                         net_len=ins - deleted, raw_ref=first[1], raw_ref_end=ref_end,
                         raw_pieces=[dict(t={0: 'M', 1: 'I', 2: 'D', 7: '=', 8: 'X'}[op],
                                          ref=r, len=n, q=q) for op, r, n, q in group])
        out.append(event)
    return out


def reference_handle(reference):
    if reference is None or hasattr(reference, 'fetch'):
        return reference
    from services.fasta_handles import get_fasta_handle
    return get_fasta_handle(str(reference))


def reference_identity(state):
    """A cache/worker-safe reference identity; no open handles cross processes."""
    fasta = getattr(state, 'fasta', None)
    return reference_key(fasta or getattr(state, 'fasta_path', None))


def reference_key(reference):
    import os
    path = getattr(reference, 'filename', None) or (reference if isinstance(reference, (str, bytes)) else None)
    if isinstance(path, bytes):
        path = os.fsdecode(path)
    try:
        stat = os.stat(path)
        return (path, stat.st_mtime_ns, stat.st_size)
    except (OSError, TypeError):
        return (path, id(reference) if reference is not None else None)


def normalize_allele(event, read, reference):
    """Canonical pure indels, exact replacement sequence, raw anchors and placement bounds.

    q/raw_pieces always refer to the source SEQ/CIGAR; shifting an allele never
    shifts chromatin query coordinates. Complex replacements retain their exact
    ref/alt strings, rather than guessing equivalence through mismatches.
    """
    fasta = reference_handle(reference)
    if fasta is None:
        return event
    chrom = read.reference_name
    refs = set(fasta.references)
    if chrom not in refs:
        alias = chrom[3:] if chrom.startswith('chr') else 'chr' + chrom
        if alias not in refs:
            return event
        chrom = alias
    raw_ref = int(event['ref'])
    raw_end = int(event.get('ref_end', raw_ref + (event['len'] if event['t'] == 'D' else 0)))
    q_end = int(event.get('q_end', event['q'] + (event['len'] if event['t'] == 'I' else 0)))
    seq = read.query_sequence or ''
    if q_end > len(seq):
        return event
    alt = seq[event['q']:q_end].upper()
    deleted = fasta.fetch(chrom, raw_ref, raw_end).upper()
    if len(deleted) != raw_end - raw_ref:
        return event
    pos = raw_ref
    # Minimise the exact replacement before rotating a resulting pure indel.
    while deleted and alt and deleted[-1] == alt[-1]:
        deleted, alt = deleted[:-1], alt[:-1]
    while deleted and alt and deleted[0] == alt[0]:
        deleted, alt, pos = deleted[1:], alt[1:], pos + 1
    if not deleted and not alt:
        return None  # the CIGAR replacement reconstructs reference exactly
    ref_len, alt_len = len(deleted), len(alt)
    prefix = pos - raw_ref
    suffix = raw_end - raw_ref - ref_len - prefix
    # Retain only bridge bases surviving on BOTH axes. Trimming can remove
    # query bridge bases while leaving their reference bases (or conversely),
    # turning that part of the bridge into an indel in the minimized allele.
    bridge = 0
    for piece in event.get('raw_pieces') or []:
        if piece['t'] in ('M', '=', 'X'):
            lo = max(0, event['q'] + prefix - piece['q'], raw_ref + prefix - piece['ref'])
            hi = min(piece['len'], q_end - suffix - piece['q'], raw_end - suffix - piece['ref'])
            bridge += max(0, hi - lo)
    inserted, removed = alt_len - bridge, ref_len - bridge
    lo = hi = pos
    normalized_alt = alt
    normalized_ref = deleted
    if (not deleted) != (not alt):
        allele = alt or deleted
        @lru_cache(maxsize=64)
        def chunk(block):
            return fasta.fetch(chrom, block * 4096, (block + 1) * 4096).upper()
        def base(p):
            if p < 0:
                return ''
            text = chunk(p // 4096)
            return text[p % 4096:p % 4096 + 1]
        while pos > 0 and base(pos - 1) in {'A', 'C', 'G', 'T'} and base(pos - 1) == allele[-1]:
            allele = base(pos - 1) + allele[:-1]
            pos -= 1
        lo = hi = pos
        rotated = allele
        while base(hi + ref_len) in {'A', 'C', 'G', 'T'} and base(hi + ref_len) == rotated[0]:
            rotated = rotated[1:] + base(hi + ref_len)
            hi += 1
        if alt:
            normalized_alt = allele
        else:
            normalized_ref = allele
    return {**event, 't': 'I' if alt_len >= ref_len else 'D', 'len': max(inserted, removed),
            'inserted_len': inserted, 'deleted_len': removed, 'net_len': alt_len - ref_len,
            'ref': pos, 'ref_end': pos + ref_len, 'ref_len': ref_len, 'alt_len': alt_len,
            'raw_ref': raw_ref, 'raw_ref_end': raw_end, 'q_end': q_end,
            'raw_pieces': event.get('raw_pieces') or [dict(t=event['t'], ref=raw_ref, len=event['len'], q=event['q'])],
            'alt_seq': normalized_alt, 'ref_seq': normalized_ref,
            'uncertainty': [lo, hi], 'normalized': True}
