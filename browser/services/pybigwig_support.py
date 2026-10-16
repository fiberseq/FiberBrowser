"""Whether this pyBigWig can read bigWig/bigBed files over the network.

pyBigWig reads URLs through libcurl, and only when it was compiled against
it. The x86_64 Linux wheels on PyPI are built without libcurl
(``pyBigWig.remote == 0``), so a Linux install from wheels (the WSL app's
distro included, before it built pyBigWig from source) could open local
tracks but no http(s), s3:// or ssh:// one: libBigWig only printed
"Couldn't open ... for reading" and the track never appeared.
"""
from __future__ import annotations

from typing import Optional

_URL_PREFIXES = ("http://", "https://", "ftp://")


def reads_urls() -> bool:
    """True when pyBigWig was built with libcurl (or can't say: an old build without the flag)."""
    try:
        import pyBigWig
    except Exception:
        return True  # the import problem is reported elsewhere (copilot_doctor)
    return bool(getattr(pyBigWig, "remote", 1))


def url_support_problem() -> Optional[str]:
    if reads_urls():
        return None
    from services.copilot_doctor import pybigwig_fix
    return ("This pyBigWig was built without libcurl, so it can't read bigWig/bigBed files over the network "
            "(http(s) URLs, s3:// and ssh:// sources, session links). Rebuild it from source: " + pybigwig_fix())


def check_target(target) -> None:
    """Raise RuntimeError with the fix when ``target`` is a URL this pyBigWig can't read."""
    if isinstance(target, str) and target.lower().startswith(_URL_PREFIXES):
        problem = url_support_problem()
        if problem:
            raise RuntimeError(problem)
