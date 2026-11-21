"""An HTTPS download never follows a redirect to plain HTTP (deferred 3.0.3 audit LOW)."""
import io
import urllib.request
from email.message import Message

import pytest

from services import http_download


def _redirect(handler, url, newurl):
    req = urllib.request.Request(url)
    return handler.redirect_request(req, io.BytesIO(), 302, "Found", Message(), newurl)


def test_https_to_http_is_refused_by_default():
    handler = http_download._NoDowngradeRedirect(allow_insecure=False)
    with pytest.raises(http_download.InsecureRedirect):
        _redirect(handler, "https://mirror.example/hg38.fa.gz", "http://mirror.example/hg38.fa.gz")


@pytest.mark.parametrize("url, newurl", [
    ("https://a.example/x", "https://b.example/x"),     # HTTPS -> HTTPS
    ("http://a.example/x", "http://b.example/x"),       # plain HTTP stays as it was
    ("http://a.example/x", "https://b.example/x"),      # upgrade
])
def test_other_redirects_are_followed(url, newurl):
    handler = http_download._NoDowngradeRedirect(allow_insecure=False)
    assert _redirect(handler, url, newurl).full_url == newurl


def test_the_downgrade_can_be_allowed():
    handler = http_download._NoDowngradeRedirect(allow_insecure=True)
    assert _redirect(handler, "https://a.example/x", "http://a.example/x").full_url == "http://a.example/x"


def test_the_opener_uses_the_guard():
    opener = http_download._Watchdog(10).opener()
    assert any(isinstance(h, http_download._NoDowngradeRedirect) for h in opener.handlers)


@pytest.mark.parametrize("allow", [False, True])
@pytest.mark.parametrize("newurl", ["ftp://mirror.example/ref.fa", "FTP://mirror.example/ref.fa",
                                    "file:///etc/passwd"])
def test_https_to_other_non_https_schemes_is_refused(allow, newurl):
    handler = http_download._NoDowngradeRedirect(allow_insecure=allow)
    with pytest.raises(http_download.InsecureRedirect):
        _redirect(handler, "https://mirror.example/ref.fa", newurl)
