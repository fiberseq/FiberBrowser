"""Favicon and web app manifest: Chrome/Edge can install FiberBrowser as an app.

The browser fetches the manifest (and its icons) without cookies, so they must
be served without the access token; the installed app's start_url ("/") then
loads with the cookie the access link set.
"""
import json
import struct
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import local_auth
from services.frontend_mount import mount_frontend

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "browser" / "frontend"
PUBLIC = FRONTEND / "public"


def _png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", data[16:24])


def test_manifest_is_installable():
    manifest = json.loads((PUBLIC / "assets" / "manifest.webmanifest").read_text())
    assert manifest["name"] == "FiberBrowser" and manifest["short_name"]
    # Explicit: a manifest under /assets/ would otherwise scope the app to /assets/.
    assert manifest["start_url"] == "/" and manifest["scope"] == "/" and manifest["id"] == "/"
    assert "token" not in manifest["start_url"]  # never bake a launch's token into the app
    assert manifest["display"] == "standalone"
    sizes = {}
    for icon in manifest["icons"]:
        assert icon["src"].startswith("/assets/icons/"), icon  # served without the token
        path = PUBLIC / icon["src"].lstrip("/")
        assert path.is_file(), path
        if icon["type"] == "image/png":
            width, height = _png_size(path)
            assert icon["sizes"] == f"{width}x{height}"
            sizes.setdefault(icon.get("purpose", "any"), set()).add(width)
    assert {192, 512} <= sizes["any"] and 512 in sizes["maskable"]


def test_index_links_the_manifest_and_icons():
    html = (FRONTEND / "index.html").read_text()
    for href in ('rel="manifest" href="/assets/manifest.webmanifest"', 'href="/assets/icons/favicon.svg"',
                 'href="/assets/icons/favicon.ico"', 'href="/assets/icons/apple-touch-icon.png"'):
        assert href in html
    for name in ("favicon.svg", "favicon.ico", "apple-touch-icon.png"):
        assert (PUBLIC / "assets" / "icons" / name).is_file()


def test_packaged_icons_exist():
    icons = ROOT / "fiberbrowser" / "icons"
    for size in (16, 32, 48, 128, 256, 512):
        assert _png_size(icons / f"fiberbrowser-{size}.png") == (size, size)
    assert (icons / "fiberbrowser.ico").read_bytes()[:4] == b"\x00\x00\x01\x00"
    assert (ROOT / "packaging" / "macos" / "FiberBrowser.icns").read_bytes()[:4] == b"icns"
    assert (ROOT / "packaging" / "macos" / "FiberHMM.icns").read_bytes()[:4] == b"icns"


def _dist(tmp_path):
    script_dir = tmp_path / "browser"
    dist = script_dir / "frontend" / "dist"
    (dist / "assets" / "icons").mkdir(parents=True)
    (dist / "index.html").write_text("<html><head></head><body>app</body></html>")
    (dist / "assets" / "manifest.webmanifest").write_text('{"name": "FiberBrowser"}')
    (dist / "assets" / "icons" / "favicon.ico").write_bytes(b"\x00\x00\x01\x00")
    return script_dir


def test_manifest_favicon_and_icons_need_no_token(tmp_path, monkeypatch):
    monkeypatch.setattr(local_auth, "_enabled", True)
    app = FastAPI()
    local_auth.install_local_auth(app, lambda: False)
    mount_frontend(app, str(_dist(tmp_path)), public_mode=False)
    anonymous = TestClient(app)
    manifest = anonymous.get("/assets/manifest.webmanifest")
    assert manifest.status_code == 200
    assert manifest.headers["content-type"].startswith("application/manifest+json")
    favicon = anonymous.get("/favicon.ico")
    assert favicon.status_code == 200 and favicon.headers["content-type"] == "image/x-icon"
    # The app itself still needs the token (or its cookie).
    assert anonymous.get("/", headers={"Accept": "text/html"}).status_code == 401
    assert anonymous.post("/favicon.ico").status_code == 401  # only GET/HEAD are open
    token = local_auth.get_token()
    assert anonymous.get(f"/?token={token}").status_code == 200
    assert anonymous.get("/").status_code == 200  # start_url with the cookie


def test_the_access_page_explains_the_installed_app(tmp_path, monkeypatch):
    monkeypatch.setattr(local_auth, "_enabled", True)
    app = FastAPI()
    local_auth.install_local_auth(app, lambda: False)
    mount_frontend(app, str(_dist(tmp_path)), public_mode=False)
    page = TestClient(app).get("/", headers={"Accept": "text/html"})
    assert page.status_code == 401
    assert "Installed FiberBrowser as an app" in page.text
    assert local_auth.get_token() not in page.text
