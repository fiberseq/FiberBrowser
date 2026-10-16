from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.frontend_mount import find_frontend_dist, mount_frontend


def test_find_frontend_dist_supports_browser_layout(tmp_path):
    script_dir = tmp_path / "browser"
    dist = script_dir / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body></body></html>")

    assert find_frontend_dist(str(script_dir)) == str(dist)


def test_mount_frontend_injects_public_flag_and_dafc_fallback(tmp_path):
    script_dir = tmp_path / "browser"
    dist = script_dir / "frontend" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body>app</body></html>")

    app = FastAPI()
    mounted = mount_frontend(app, str(script_dir), public_mode=True)

    assert mounted == str(dist)
    client = TestClient(app)
    root = client.get("/")
    dafc = client.get("/dafc")

    assert root.status_code == 200
    assert "window.__FIBERHMM_PUBLIC__ = true" in root.text
    assert dafc.status_code == 200
    # Each response has its own CSP nonce (public pages); otherwise identical.
    import re
    nonce = re.search(r'<script nonce="([^"]+)">', root.text).group(1)
    assert f"'nonce-{nonce}'" in root.headers["content-security-policy"]
    assert "script-src 'self' 'nonce-" in root.headers["content-security-policy"]
    strip = lambda text: re.sub(r' nonce="[^"]+"', "", text)
    assert strip(dafc.text) == strip(root.text)

    (dist / "index.html").write_text("<html><head></head><body>rebuilt</body></html>")
    refreshed = client.get("/")
    assert "rebuilt" in refreshed.text
    assert refreshed.headers["cache-control"] == "no-cache"
