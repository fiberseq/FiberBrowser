"""Downloads of a file that was opened (and checked) by descriptor.

Lab servers open artifact files by a confined descriptor walk
(services/lab/paths.py:open_confined); the download must serve that
descriptor, not reopen the path. Starlette's FileResponse gives Range requests
(206/416), ETag and Last-Modified; it is pointed at the descriptor itself
(``/dev/fd/N`` names the already-open file on Linux and macOS, never the path
again) and the descriptor is closed when the response ends. Where ``/dev/fd``
does not exist the file is streamed whole from the descriptor.
"""
from __future__ import annotations

import mimetypes
import os
from urllib.parse import quote

_DEV_FD = os.path.isdir("/dev/fd")


def opened_file_response(opened, filename: str):
    """A download response for ``(file object, real path, size)`` from open_confined."""
    from fastapi.responses import FileResponse, StreamingResponse
    from starlette.background import BackgroundTask
    handle, _real, size = opened
    if _DEV_FD:
        fd = handle.fileno()
        return FileResponse(f"/dev/fd/{fd}", filename=filename, stat_result=os.fstat(fd),
                            background=BackgroundTask(handle.close))

    def chunks():  # pragma: no cover - platforms without /dev/fd
        with handle:
            while True:
                block = handle.read(1 << 16)
                if not block:
                    return
                yield block

    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return StreamingResponse(chunks(), media_type=media_type, headers={  # pragma: no cover
        "Content-Disposition": f"attachment; filename*=utf-8''{quote(filename)}", "Content-Length": str(size)})
