"""The packaged app's HTTPS trusts the bundled certifi CA file, never a path on the build machine (FiberBrowser 3.0.0-
3.1.0 Mac apps: the bundled OpenSSL's default CA file was inside the builder's conda env, so update checks failed with
CERTIFICATE_VERIFY_FAILED on every other Mac)."""
import os

import certifi
import pytest

from fiberbrowser.frozen_entry import configure_tls_trust


@pytest.fixture
def clean_env(monkeypatch):
    for k in ("SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"):
        monkeypatch.delenv(k, raising=False)
    return monkeypatch


def test_the_bundled_certifi_file_is_used(clean_env):
    configure_tls_trust()
    assert os.environ["SSL_CERT_FILE"] == certifi.where() and os.path.isfile(os.environ["SSL_CERT_FILE"])
    assert os.environ["CURL_CA_BUNDLE"] == certifi.where()   # htslib's libcurl (remote BAMs)


def test_a_ca_file_the_user_set_wins(clean_env, tmp_path):
    mine = tmp_path / "corp.pem"
    mine.write_text("")
    clean_env.setenv("SSL_CERT_FILE", str(mine))
    configure_tls_trust()
    assert os.environ["SSL_CERT_FILE"] == str(mine) and os.environ["CURL_CA_BUNDLE"] == str(mine)


def test_a_ca_directory_the_user_set_wins(clean_env, tmp_path):
    clean_env.setenv("SSL_CERT_DIR", str(tmp_path))
    configure_tls_trust()
    assert "SSL_CERT_FILE" not in os.environ


def test_the_frozen_process_sets_it_up_first():
    import inspect
    from fiberbrowser import frozen_entry
    src = inspect.getsource(frozen_entry.configure_frozen_process)
    assert "configure_tls_trust()" in src.split('"""')[2].splitlines()[1]
