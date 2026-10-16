"""Files for the session-link end-to-end spec (browser/frontend/tests/e2e/session-links.spec.ts).

    python tests/make_link_fixture.py <folder>

writes into <folder>: the demo BAM as ``s1.bam`` with its index as ``s1.index``
(a separately signed index), a bigWig ``cov.bw``, a session document
``session.json`` whose track URLs are relative and pre-signed (``?sig=``),
and the file server's ``config.json`` (which files need which signature).
The spec adds the page that links to FiberBrowser. Prints the folder.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.link_fixtures import write_bigwig  # noqa: E402

DEMO_BAM = ROOT / "browser" / "data" / "demo" / "napa_ddda.bam"


def main(folder: str) -> None:
    out = Path(folder)
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(DEMO_BAM, out / "s1.bam")
    shutil.copy(str(DEMO_BAM) + ".bai", out / "s1.index")
    write_bigwig(str(out / "cov.bw"))
    session = {
        "schema": "fiberbrowser.session-link.v1",
        "title": "Demo donor",
        "locus": "chr19:47,514,000-47,518,000",
        "tracks": [
            {"url": "s1.bam?X-Amz-Expires=3600&sig=BAMSIG", "index_url": "s1.index?sig=IDXSIG", "type": "bam",
             "name": "Demo reads", "sample": "S1", "group": "Donor A", "color": "#d62728", "size": (out / "s1.bam").stat().st_size},
            {"url": "cov.bw?sig=BWSIG", "name": "Demo coverage", "color": "#1f77b4"},
        ],
    }
    (out / "session.json").write_text(json.dumps(session, indent=1))
    (out / "config.json").write_text(json.dumps({"signed": {"s1.bam": "BAMSIG", "s1.index": "IDXSIG", "cov.bw": "BWSIG"},
                                                 "redirects": {}, "chunked": {}}))
    print(out)


if __name__ == "__main__":
    main(sys.argv[1])
