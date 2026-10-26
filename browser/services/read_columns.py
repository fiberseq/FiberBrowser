"""Integer columns in compact read rows (read row format 2).

A compact read row is a dict whose evidence fields are lists: ``intervals``,
``fire`` and each layer's ``intervals`` are lists of ``[start, end, size]``,
the point marks (``methyl``, ``methyl_m6a``, ``methyl_m5c``,
``possible_deam_ct``, ``possible_deam_ga``) lists of positions. The live-lift
composer computes these for a whole window at once in NumPy; turning every
row's share back into Python lists was most of what was left of its cost.

Row format 2 lets those fields hold an ``IntColumn`` instead: an immutable
int64 array (1-D for marks, ``(n, k)`` for intervals) that reads like the list
it stands for. Every reader gets list behaviour (``len``, truth, iteration and
indexing yield Python ints and fresh lists, slicing returns a list, ``==``
and ``+`` compare and concatenate as lists, pickling and deep copies work);
readers that know the type use ``.array`` and skip the per-element Python
work (the binary wire encoder, the cache sizer). It never compares equal to a
tuple and is never hashable, as a list.

What is different from a list, by design:

- It cannot be changed in place (no ``append``, ``sort``, item assignment).
  The rows are shared by caches; code that needs a changed copy builds a list.
- Values read from it are fresh objects each time: changing an inner list
  read from it never changes the row.
- ``isinstance(x, list)`` is false: code that type-checks evidence fields
  accepts ``LIST_TYPES`` (or calls ``as_list``).
- JSON encoders need ``json_default`` (``utils.responses.ORJSONResponse``
  has it).

The wire to the browser is unchanged (``read_binary.encode_reads`` packs an
``IntColumn`` exactly as the list it stands for), so a browser can't tell the
two apart.
"""
from __future__ import annotations

import numpy as np

# The row format of compact reads that may carry ``IntColumn`` fields.
READ_ROW_FORMAT = 2


class IntColumn:
    """An immutable int64 column read as a list of ints (1-D) or of
    equal-length int lists (2-D)."""
    __slots__ = ("_a",)

    def __init__(self, array):
        a = np.asarray(array)
        if a.dtype != np.int64:
            raise TypeError(f"IntColumn holds int64, not {a.dtype}")
        if a.ndim not in (1, 2):
            raise ValueError("IntColumn is 1-D or 2-D")
        if a.flags.writeable:
            a = a.view()
            a.flags.writeable = False
        self._a = a

    # ── fast paths ──────────────────────────────────────────────────────────
    @property
    def array(self) -> np.ndarray:
        """The read-only int64 array."""
        return self._a

    @property
    def width(self):
        """Values per item (2-D), or None (1-D)."""
        return self._a.shape[1] if self._a.ndim == 2 else None

    def tolist(self) -> list:
        """A new list of Python ints (or of lists of them)."""
        return self._a.tolist()

    @property
    def retained_bytes(self) -> int:
        # byte_cache.retained_size: the array (or its share of a window array).
        return int(self._a.nbytes) + 112

    def __array__(self, dtype=None, copy=None):
        a = self._a
        if dtype is not None and np.dtype(dtype) != a.dtype:
            return a.astype(dtype)
        return a.copy() if copy else a

    # ── list behaviour ──────────────────────────────────────────────────────
    def __len__(self):
        return self._a.shape[0]

    def __bool__(self):
        return self._a.shape[0] > 0

    def __iter__(self):
        return iter(self._a.tolist())

    def __reversed__(self):
        return reversed(self._a.tolist())

    def __getitem__(self, index):
        if isinstance(index, slice):
            return self._a[index].tolist()
        if isinstance(index, (int, np.integer)):
            return self._a[index].tolist()
        raise TypeError(f"list indices must be integers or slices, not {type(index).__name__}")

    def __contains__(self, value):
        return value in self._a.tolist()

    def index(self, value, *args):
        return self._a.tolist().index(value, *args)

    def count(self, value):
        return self._a.tolist().count(value)

    def copy(self) -> list:
        return self._a.tolist()

    def __eq__(self, other):
        if isinstance(other, IntColumn):
            return self._a.shape == other._a.shape and bool(np.array_equal(self._a, other._a)) \
                or (len(self) == 0 and len(other) == 0)
        if isinstance(other, list):
            return self._a.tolist() == other
        return NotImplemented if not isinstance(other, (tuple, str, bytes, dict, set, frozenset)) else False

    def __ne__(self, other):
        eq = self.__eq__(other)
        return eq if eq is NotImplemented else not eq

    def _cmp_list(self, other):
        if isinstance(other, IntColumn):
            return other._a.tolist()
        if isinstance(other, list):
            return other
        return None

    def __lt__(self, other):
        o = self._cmp_list(other)
        return NotImplemented if o is None else self._a.tolist() < o

    def __le__(self, other):
        o = self._cmp_list(other)
        return NotImplemented if o is None else self._a.tolist() <= o

    def __gt__(self, other):
        o = self._cmp_list(other)
        return NotImplemented if o is None else self._a.tolist() > o

    def __ge__(self, other):
        o = self._cmp_list(other)
        return NotImplemented if o is None else self._a.tolist() >= o

    __hash__ = None

    def __add__(self, other):
        if isinstance(other, IntColumn):
            return self._a.tolist() + other._a.tolist()
        if isinstance(other, list):
            return self._a.tolist() + other
        return NotImplemented

    def __radd__(self, other):
        if isinstance(other, list):
            return other + self._a.tolist()
        return NotImplemented

    def __mul__(self, n):
        if isinstance(n, int) and not isinstance(n, bool):
            return self._a.tolist() * n
        return NotImplemented

    __rmul__ = __mul__

    def __repr__(self):
        return repr(self._a.tolist())

    # ── copies and pickling ─────────────────────────────────────────────────
    def __reduce__(self):
        return (_rebuild, (np.ascontiguousarray(self._a),))

    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        return self  # immutable


def _rebuild(array):
    return IntColumn(array)


# Types an evidence field may have in format 2 (lists in rows decoded or built
# anywhere else, tuples where older code made them).
LIST_TYPES = (list, tuple, IntColumn)


def is_column(value) -> bool:
    return type(value) is IntColumn


def as_list(value):
    """``value`` as a list when it is an ``IntColumn``, else unchanged."""
    return value._a.tolist() if type(value) is IntColumn else value


def json_default(value):
    """``default=`` for orjson / json: an ``IntColumn`` as its list."""
    if type(value) is IntColumn:
        return value._a.tolist()
    raise TypeError(f"Type is not JSON serializable: {type(value).__name__}")


def plain(value):
    """A deep copy of ``value`` with every ``IntColumn`` turned into its list
    (dicts, lists and tuples walked; tuples stay tuples)."""
    t = type(value)
    if t is IntColumn:
        return value._a.tolist()
    if t is dict:
        return {k: plain(v) for k, v in value.items()}
    if t is list:
        return [plain(v) for v in value]
    if t is tuple:
        return tuple(plain(v) for v in value)
    return value


def has_columns(value) -> bool:
    """Whether ``value`` (a row, list of rows or payload) holds an ``IntColumn``."""
    t = type(value)
    if t is IntColumn:
        return True
    if t is dict:
        return any(has_columns(v) for v in value.values())
    if t in (list, tuple):
        return any(has_columns(v) for v in value if type(v) in (dict, list, tuple, IntColumn))
    return False


def wrap(array) -> IntColumn:
    """An ``IntColumn`` of a read-only int64 1-D or 2-D array, unchecked (the
    composer's window arrays; ``IntColumn(array)`` checks)."""
    c = object.__new__(IntColumn)
    c._a = array
    return c


def read_only(array):
    """``array`` made read-only (its slices are too)."""
    array.flags.writeable = False
    return array


try:  # FastAPI's encoder (dict responses): an IntColumn is its list.
    from fastapi.encoders import ENCODERS_BY_TYPE as _ENCODERS
    _ENCODERS.setdefault(IntColumn, IntColumn.tolist)
except ImportError:  # pragma: no cover - the package without its server
    pass

