"""Bounded exact weighted wavefront with a remaining-length potential.

For fixed lengths, +1/-1/-1 scoring minimizes 4*mismatches+3*gaps. Subtract
the initial unavoidable gap cost from a remaining-length A* priority: unavoidable
length-changing gaps cost zero, excess gaps cost six, mismatches cost four.
This avoids quadratic exploration of a long unmatched clip tail. States and
trace allocation remain bounded; exhaustion never returns a partial path.
"""
import numpy as np
from services.insertion_consensus import _njit


@_njit(cache=True, nogil=True)
def weighted_wavefront(a, b, max_score, state_limit, band=-1):  # pragma: no cover - compiled
    n, m = len(a), len(b)
    delta = n - m
    radius = max_score // 6
    left = min(0, delta) - radius
    width = abs(delta) + 2 * radius + 1
    offsets = np.empty((max_score + 1, width), dtype=np.int32)
    trace = np.empty((max_score + 1, width), dtype=np.uint8)
    used, final_score = 0, -1
    for score in range(max_score + 1):
        lo = min(0, delta) - score // 6
        hi = max(0, delta) + score // 6
        # Zero-cost incoming gaps point toward delta. Fill both sides toward
        # it, then delta last; same-score dependencies are already available.
        for index in range(hi - lo + 1):
            before = delta - lo
            after = hi - delta
            diagonal = lo + index if index < before else hi - (index - before) if index < before + after else delta
            if used >= state_limit:
                return np.empty(0, dtype=np.uint8), 1, used
            used += 1
            best = 0 if score == 0 and diagonal == 0 else -1
            move = 3  # seed sentinel
            for operation in (0, 2, 1):
                previous_diagonal = diagonal if operation == 0 else diagonal - 1 if operation == 2 else diagonal + 1
                cost = 4 if operation == 0 else 3 + 3 * abs(delta - diagonal) - 3 * abs(delta - previous_diagonal)
                previous_score = score - cost
                if previous_score < 0:
                    continue
                previous_lo = min(0, delta) - previous_score // 6
                previous_hi = max(0, delta) + previous_score // 6
                if not previous_lo <= previous_diagonal <= previous_hi:
                    continue
                previous = offsets[previous_score, previous_diagonal - left]
                if previous < 0:
                    continue
                candidate = previous + (0 if operation == 1 else 1)
                target = candidate - diagonal
                inside = band < 0 or n == 0 or abs(target - candidate * m // n) <= band
                if 0 <= candidate <= n and 0 <= target <= m and inside and candidate > best:
                    best, move = candidate, operation
            if best >= 0:
                target = best - diagonal
                while (best < n and target < m and a[best] == b[target] and a[best] < 4
                       and (band < 0 or abs((target + 1) - ((best + 1) * m // n)) <= band)):
                    best += 1
                    target += 1
            offsets[score, diagonal - left] = best
            trace[score, diagonal - left] = move
        if offsets[score, delta - left] == n:
            final_score = score
            break
    if final_score < 0:
        return np.empty(0, dtype=np.uint8), 1, used
    reverse = np.empty(n + m, dtype=np.uint8)
    x, y, score, count = n, m, final_score, 0
    while True:
        diagonal = x - y
        move = trace[score, diagonal - left]
        if move == 3:
            for _ in range(x):
                reverse[count] = 0
                count += 1
            break
        previous_diagonal = diagonal if move == 0 else diagonal - 1 if move == 2 else diagonal + 1
        cost = 4 if move == 0 else 3 + 3 * abs(delta - diagonal) - 3 * abs(delta - previous_diagonal)
        previous_score = score - cost
        previous_x = offsets[previous_score, previous_diagonal - left]
        after_edit = previous_x + (0 if move == 1 else 1)
        for _ in range(x - after_edit):
            reverse[count] = 0
            count += 1
        reverse[count] = move
        count += 1
        x, y, score = previous_x, previous_x - previous_diagonal, previous_score
    return reverse[:count][::-1].copy(), 0, used
