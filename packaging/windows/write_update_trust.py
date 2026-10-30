"""Embed the release's FiberBrowser Authenticode identity in its build file."""
import json
import os
from pathlib import Path
import re
import sys


def write_trust(path):
    subject = os.environ.get('FB_WINDOWS_PUBLISHER_SUBJECT', '').strip()
    thumbprint = os.environ.get('FB_WINDOWS_PUBLISHER_THUMBPRINT', '').strip().upper()
    if (subject or thumbprint) and (not subject or not re.fullmatch(r'[A-F0-9]{40}', thumbprint)):
        raise ValueError('Set both the FiberBrowser publisher subject and its 40-hex certificate thumbprint')
    path = Path(path)
    build = json.loads(path.read_text())
    build['windows_update_signer'] = dict(subject=subject, thumbprint=thumbprint)
    path.write_text(json.dumps(build, indent=2) + '\n')


if __name__ == '__main__':
    write_trust(sys.argv[1])
