"""The app's update check: channels, manifests, version comparison, GitHub sign-in for a private channel, safe
redirects, download + sha256 verification, privacy switches, and the /api/app routes."""
import hashlib
import io
import json
import subprocess
import urllib.error
from email.message import Message

import pytest

from services import app_build, app_settings, app_update, github_auth

_REAL_GH_TOKEN = github_auth.gh_token  # the fixture replaces it
_REAL_PACK_CHANNEL = app_update._pack_channel

DMG = b"pretend this is a disk image" * 100
SHA = hashlib.sha256(DMG).hexdigest()


def manifest(version="3.0.1", build="", **extra):
    data = {"schema": app_update.MANIFEST_SCHEMA, "channel": "lab", "version": version, "build": build,
            "released": "2026-10-05", "notes": "Faster Find classes.", "notes_url": "https://example.org/notes",
            "minimum_macos": "11.0",
            "downloads": {"macos-arm64": [{"kind": "zip", "name": "FiberBrowser-3.0.1-arm64.zip", "sha256": SHA},
                                          {"kind": "dmg", "name": "FiberBrowser-3.0.1-arm64.dmg", "sha256": SHA,
                                           "size": len(DMG)}],
                          "windows-x64": [{"kind": "installer", "name": "FiberBrowser-3.0.1-Setup.exe",
                                           "sha256": SHA}]}}
    data.update(extra)
    return data


class MemoryStore(github_auth.TokenStore):
    name = "test keychain"

    def __init__(self, token=None):
        self.token = token

    def available(self):
        return True, ""

    def get(self):
        return self.token

    def set(self, token):
        self.token = token

    def delete(self):
        self.token = None


class FakeResponse(io.BytesIO):
    pass


class FakeGitHub:
    """An opener that answers by URL and records every request (its headers)."""

    def __init__(self):
        self.routes = {}
        self.requests = []

    def route(self, url, answer):
        self.routes[url] = answer

    def open(self, request, timeout=None):
        headers = {k.lower(): v for k, v in request.header_items()}
        self.requests.append((request.full_url, headers))
        answer = self.routes.get(request.full_url)
        if answer is None:
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", Message(), io.BytesIO(b'{"message":"Not Found"}'))
        if callable(answer):
            answer = answer(headers)
        if isinstance(answer, tuple) and answer[0] == "redirect":
            msg = Message()
            msg["Location"] = answer[1]
            raise urllib.error.HTTPError(request.full_url, 302, "Found", msg, io.BytesIO(b""))
        if isinstance(answer, int):
            raise urllib.error.HTTPError(request.full_url, answer, "err", Message(), io.BytesIO(b'{"message":"Bad credentials"}'))
        if isinstance(answer, io.BytesIO):
            return answer
        return FakeResponse(answer if isinstance(answer, bytes) else json.dumps(answer).encode())


@pytest.fixture
def updates(tmp_path, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_NO_UPDATE_CHECK", raising=False)
    monkeypatch.delenv("FIBERBROWSER_UPDATE_URL", raising=False)
    monkeypatch.delenv("FIBERBROWSER_UPDATE_REPO", raising=False)
    monkeypatch.setenv("FIBERBROWSER_APP_SETTINGS", str(tmp_path / "app_settings.json"))
    monkeypatch.setattr(app_settings, "_cache", None)
    monkeypatch.setattr(app_build, "build_info", lambda: {"flavor": "lab", "channel": "lab", "version": "3.0.0",
                                                          "build": "20261001.1200", "platform": "macos-arm64"})
    # Legacy-channel fixtures are explicit; they do not depend on the current release manifest.
    lab_pack(monkeypatch)
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    monkeypatch.setattr(app_update, "current_version", lambda: "3.0.0")
    monkeypatch.setattr(app_update, "downloads_dir", lambda: tmp_path / "Downloads")
    monkeypatch.setattr(app_update, "macos_too_old", lambda minimum: None)
    store = MemoryStore()
    github_auth.set_token_store(store)
    monkeypatch.setattr(github_auth, "gh_token", lambda: None)
    fake = FakeGitHub()
    monkeypatch.setattr(github_auth, "opener_factory", lambda: fake)
    app_update.reset()
    yield {"tmp": tmp_path, "store": store, "github": fake, "monkeypatch": monkeypatch}
    app_update.reset()
    github_auth.set_token_store(None)


def lab_pack(monkeypatch, repos=("example-lab/FiberBrowser-private", "example-user/FiberBrowser")):
    monkeypatch.setattr(app_update, "_pack_channel", lambda: ("lab", {"repos": list(repos), "private": True,
                                                                      "manifest_asset": "fiberbrowser-update-lab.json"}))


def publish(fake, repo, data, asset_id=7):
    api = f"https://api.github.com/repos/{repo}"
    fake.route(f"{api}/releases/latest", {"tag_name": "v3.0.1", "html_url": f"https://github.com/{repo}/releases/v3.0.1",
                                          "assets": [{"name": "fiberbrowser-update-lab.json", "url": f"{api}/releases/assets/{asset_id}"},
                                                     {"name": "FiberBrowser-3.0.1-arm64.dmg", "url": f"{api}/releases/assets/{asset_id + 1}"}]})
    fake.route(f"{api}/releases/assets/{asset_id}", ("redirect", f"https://objects.githubusercontent.com/m?sig=abc"))
    fake.route("https://objects.githubusercontent.com/m?sig=abc", json.dumps(data).encode())
    fake.route(f"{api}/releases/assets/{asset_id + 1}", ("redirect", "https://objects.githubusercontent.com/d?sig=def"))
    fake.route("https://objects.githubusercontent.com/d?sig=def", DMG)


# --- manifests and versions -----------------------------------------------------------------------------------------

def test_manifest_parsing_validates_and_normalises():
    parsed = app_update.parse_manifest(json.dumps(manifest(version="v3.0.1")))
    assert parsed["version"] == "3.0.1" and parsed["minimum_macos"] == "11.0"
    assert [d["kind"] for d in parsed["downloads"]["macos-arm64"]] == ["zip", "dmg"]
    assert app_update.pick_download(parsed, "macos-arm64")["kind"] == "dmg"
    assert app_update.pick_download(parsed, "windows-x64")["kind"] == "installer"
    assert app_update.pick_download(parsed, "linux-x86_64") is None
    for bad in (manifest(schema="other"), manifest(version="soon"), "not json", [1],
                manifest(downloads={"macos-arm64": [{"name": "../x.dmg", "sha256": SHA}]}),
                manifest(downloads={"macos-arm64": [{"name": "x.dmg", "sha256": "abc"}]})):
        with pytest.raises(app_update.UpdateError):
            app_update.parse_manifest(bad if isinstance(bad, str) else json.dumps(bad))
    assert app_update.parse_manifest(manifest(notes_url="http://insecure"))["notes_url"] is None


def test_version_comparison():
    assert app_update.is_newer("3.0.1", "3.0.0")
    assert app_update.is_newer("3.1.0", "3.0.10")
    assert not app_update.is_newer("3.0.0", "3.0.0")
    assert not app_update.is_newer("3.0.0", "3.0.1")
    assert app_update.is_newer("3.0.1", "3.0.1rc1")
    assert not app_update.is_newer("3.0.1rc1", "3.0.1")
    # Lab rebuilds keep the version: the build decides.
    assert app_update.is_newer("3.0.0", "3.0.0", "20261005.1432", "20261001.1200")
    assert not app_update.is_newer("3.0.0", "3.0.0", "20261001.1200", "20261005.1432")
    assert not app_update.is_newer("3.0.0", "3.0.0", "20261005.1432", "")


# --- channels -------------------------------------------------------------------------------------------------------

def test_public_channel_is_unauthenticated_github_releases(updates, monkeypatch):
    monkeypatch.setattr(app_update, "_pack_channel", lambda: ("public", {}))
    monkeypatch.setattr(app_build, "build_info", lambda: None)
    config = app_update.channel_config()
    assert config["source"] == "github" and config["repos"] == ["fiberseq/FiberBrowser"]
    assert config["private"] is False and config["manifest_asset"] == "fiberbrowser-update-public.json"


def test_lab_channel_defaults_to_the_lab_repo_then_the_fallback(updates, monkeypatch):
    lab_pack(monkeypatch)
    config = app_update.channel_config()
    assert config["repos"] == ["example-lab/FiberBrowser-private", "example-user/FiberBrowser"] and config["private"]


def test_this_build_uses_the_public_channel(updates, monkeypatch):
    monkeypatch.setattr(app_update, "_pack_channel", _REAL_PACK_CHANNEL)
    monkeypatch.setattr(app_build, "build_info", lambda: None)
    flavor, update = app_update._pack_channel()
    assert flavor == "public" and not update
    config = app_update.channel_config()
    assert config["channel"] == "public" and config["private"] is False
    assert config["manifest_asset"] == "fiberbrowser-update-public.json"


def test_unified_release_accepts_legacy_packaged_channel_metadata(updates, monkeypatch):
    monkeypatch.setattr(app_update, "_pack_channel", _REAL_PACK_CHANNEL)
    monkeypatch.setattr(app_build, "build_info", lambda: {"flavor": "lab", "channel": "lab"})
    config = app_update.channel_config()
    assert config["channel"] == "public"
    assert config["manifest_asset"] == "fiberbrowser-update-public.json"
    assert config["repos"] == ["fiberseq/FiberBrowser"] and config["private"] is False
    folder = shared_folder(updates["tmp"], data=manifest(channel="public"))
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    assert app_update.check(force=True)["status"] == "update_available"


def test_manifest_url_precedence_env_then_settings(updates, monkeypatch):
    lab_pack(monkeypatch)
    app_settings.update("updates", {"manifest_url": "file:///Volumes/lab/fiberbrowser-update-lab.json"})
    config = app_update.channel_config()
    assert config["source"] == "manifest" and config["manifest_from"] == "Settings" and config["private"] is False
    monkeypatch.setenv("FIBERBROWSER_UPDATE_URL", "https://lab.example.org/update.json")
    assert app_update.channel_config()["manifest_url"] == "https://lab.example.org/update.json"


# --- a manifest on a shared drive (file://) -------------------------------------------------------------------------

def shared_folder(tmp_path, data=None, payload=DMG):
    folder = tmp_path / "Dropbox" / "FiberBrowser lab builds"
    folder.mkdir(parents=True)
    (folder / "FiberBrowser-3.0.1-arm64.dmg").write_bytes(payload)
    (folder / "fiberbrowser-update-lab.json").write_text(json.dumps(data or manifest()))
    return folder


def wait_for_download():
    import time
    for _ in range(200):
        status = app_update.download_status()
        if status["state"] not in ("downloading", "verifying"):
            return status
        time.sleep(0.02)
    raise AssertionError("download did not finish")


def test_file_manifest_offers_the_dmg_and_downloads_it_verified(updates, monkeypatch):
    folder = shared_folder(updates["tmp"])
    app_settings.update("updates", {"manifest_url": (folder / "fiberbrowser-update-lab.json").as_uri()})
    result = app_update.check(force=True)
    assert result["status"] == "update_available" and result["latest"] == "3.0.1"
    assert result["download"] == {"name": "FiberBrowser-3.0.1-arm64.dmg", "kind": "dmg", "size": len(DMG), "sha256": SHA}
    assert result["notes"] == "Faster Find classes." and result["notes_url"] == "https://example.org/notes"
    app_update.start_download()
    status = wait_for_download()
    assert status["state"] == "done", status
    target = updates["tmp"] / "Downloads" / "FiberBrowser-3.0.1-arm64.dmg"
    assert status["path"] == str(target) and target.read_bytes() == DMG
    opened = []
    monkeypatch.setattr(app_update.subprocess, "Popen", lambda argv, **kw: opened.append(argv))
    monkeypatch.setattr(app_update, "open_argv", lambda path: ["open", str(path)])
    assert app_update.open_download() == {"opened": str(target)}
    assert opened == [["open", str(target)]]
    # Changed after the check: refused.
    target.write_bytes(b"tampered")
    with pytest.raises(app_update.UpdateError, match="changed since"):
        app_update.open_download()


def test_a_download_with_the_wrong_checksum_is_deleted(updates):
    folder = shared_folder(updates["tmp"], payload=b"something else entirely")
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    assert app_update.check(force=True)["status"] == "update_available"
    app_update.start_download()
    status = wait_for_download()
    assert status["state"] == "error" and "checksum" in status["error"]
    assert not list((updates["tmp"] / "Downloads").iterdir())
    with pytest.raises(app_update.UpdateError):
        app_update.open_download()


def test_up_to_date_and_older_macos(updates, monkeypatch):
    folder = shared_folder(updates["tmp"], data=manifest(version="3.0.0", build="20261001.1200"))
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    assert app_update.check(force=True)["status"] == "up_to_date"
    (folder / "fiberbrowser-update-lab.json").write_text(json.dumps(manifest(minimum_macos="99.0")))
    monkeypatch.setattr(app_update, "macos_too_old", lambda minimum: "14.6")
    result = app_update.check(force=True)
    assert result["status"] == "update_available" and result["download"] is None
    assert "needs macOS 99.0" in result["message"]


def test_source_runs_skip_the_startup_check_by_default_but_check_when_asked(updates, monkeypatch):
    monkeypatch.setattr(app_build, "is_packaged", lambda: False)
    folder = shared_folder(updates["tmp"])
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    quiet = app_update.check(startup=True)
    assert quiet["status"] == "disabled" and quiet["check_at_startup"] is False
    assert app_update.check(force=True)["status"] != "disabled"  # Check for Updates… works in a source run
    # The app (packaged) checks at startup by default.
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    assert app_update.check(startup=True, force=True)["status"] != "disabled"


def test_source_runs_are_told_the_pip_command(updates, monkeypatch):
    monkeypatch.setattr(app_build, "is_packaged", lambda: False)
    folder = shared_folder(updates["tmp"])
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    result = app_update.check(force=True)
    assert result["download"] is None and "pip install -U fiberbrowser" in result["message"]


# --- privacy ----------------------------------------------------------------------------------------------------------

def test_turned_off_checks_fetch_nothing(updates, monkeypatch):
    lab_pack(monkeypatch)
    updates["store"].token = "ghp_" + "a" * 36
    app_settings.update("updates", {"check_at_startup": False})
    assert app_update.check(startup=True)["status"] == "disabled"
    assert updates["github"].requests == []
    monkeypatch.setenv("FIBERBROWSER_NO_UPDATE_CHECK", "1")
    assert app_update.check(force=True)["status"] == "disabled"
    assert updates["github"].requests == []


def test_a_check_sends_only_standard_headers(updates, monkeypatch):
    monkeypatch.setattr(app_update, "_pack_channel", lambda: ("public", {}))
    monkeypatch.setattr(app_build, "build_info", lambda: None)
    data = manifest(channel="public")
    api = "https://api.github.com/repos/fiberseq/FiberBrowser"
    updates["github"].route(f"{api}/releases/latest", {"tag_name": "v3.0.1", "assets": [
        {"name": "fiberbrowser-update-public.json", "url": f"{api}/releases/assets/1"}]})
    updates["github"].route(f"{api}/releases/assets/1", json.dumps(data).encode())
    assert app_update.check(force=True)["status"] == "update_available"
    for url, headers in updates["github"].requests:
        assert set(headers) <= {"user-agent", "accept"}, headers
        assert "?" not in url


# --- GitHub sign-in for the private lab channel -----------------------------------------------------------------------

def test_token_sources_in_order_gh_then_keychain(updates, monkeypatch):
    updates["store"].token = "github_pat_" + "k" * 30
    monkeypatch.setattr(github_auth, "gh_token", lambda: "gho_" + "g" * 36)
    assert [s for s, _ in github_auth.token_candidates()] == ["GitHub CLI", "test keychain"]
    monkeypatch.setattr(github_auth, "gh_token", lambda: None)
    assert [s for s, _ in github_auth.token_candidates()] == ["test keychain"]
    updates["store"].token = None
    assert github_auth.token_candidates() == []


def test_missing_token_says_sign_in(updates, monkeypatch):
    lab_pack(monkeypatch)
    result = app_update.check(force=True)
    assert result["status"] == "auth_required" and result["message"].startswith("Sign in to check for lab updates")
    assert updates["github"].requests == []


def test_invalid_token_is_reported_and_the_next_source_tried(updates, monkeypatch):
    lab_pack(monkeypatch)
    bad, good = "gho_" + "b" * 36, "github_pat_" + "k" * 30
    monkeypatch.setattr(github_auth, "gh_token", lambda: bad)
    api = "https://api.github.com/repos/example-lab/FiberBrowser-private/releases/latest"
    updates["github"].route(api, 401)
    result = app_update.check(force=True)
    assert result["status"] == "auth_invalid" and "GitHub CLI" in result["message"]
    # A stored token that works is used after the refused one.
    updates["store"].token = good
    publish(updates["github"], "example-lab/FiberBrowser-private", manifest())
    updates["github"].route(api, lambda h: 401 if h.get("authorization") == f"Bearer {bad}" else
                            updates["github"].routes["_release"])
    updates["github"].routes["_release"] = {"tag_name": "v3.0.1", "assets": [
        {"name": "fiberbrowser-update-lab.json", "url": "https://api.github.com/repos/example-lab/FiberBrowser-private/releases/assets/7"}]}
    result = app_update.check(force=True)
    assert result["status"] == "update_available" and result["token_source"] == "test keychain"


def test_lab_repo_falls_back_until_the_transfer(updates, monkeypatch):
    lab_pack(monkeypatch)
    updates["store"].token = "github_pat_" + "k" * 30
    publish(updates["github"], "example-user/FiberBrowser", manifest())  # example-lab/FiberBrowser-private: 404
    result = app_update.check(force=True)
    assert result["status"] == "update_available" and result["from"] == "example-user/FiberBrowser (v3.0.1)"


def test_no_access_to_any_lab_repo_says_sign_in(updates, monkeypatch):
    lab_pack(monkeypatch)
    updates["store"].token = "github_pat_" + "k" * 30
    result = app_update.check(force=True)
    assert result["status"] == "auth_required" and "can't see a release" in result["message"]


def test_private_asset_download_uses_the_api_and_drops_the_token_off_github(updates, monkeypatch):
    lab_pack(monkeypatch)
    token = "github_pat_" + "k" * 30
    updates["store"].token = token
    publish(updates["github"], "example-lab/FiberBrowser-private", manifest())
    assert app_update.check(force=True)["status"] == "update_available"
    app_update.start_download()
    assert wait_for_download()["state"] == "done"
    seen = updates["github"].requests
    asset = [h for u, h in seen if u.endswith("/releases/assets/8")][0]
    assert asset["authorization"] == f"Bearer {token}" and asset["accept"] == "application/octet-stream"
    for url, headers in seen:
        if not url.startswith("https://api.github.com/"):
            assert "authorization" not in headers, url
    assert any(u.startswith("https://objects.githubusercontent.com/d") for u, _ in seen)


def test_redirect_to_another_host_never_carries_the_token(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(github_auth, "opener_factory", lambda: fake)
    fake.route("https://api.github.com/a", ("redirect", "https://evil.example.org/b"))
    fake.route("https://evil.example.org/b", ("redirect", "https://api.github.com/c"))
    fake.route("https://api.github.com/c", b"ok")
    assert github_auth.http_get("https://api.github.com/a", token="t" * 40).read() == b"ok"
    auth = [("authorization" in h) for _, h in fake.requests]
    assert auth == [True, False, True]
    fake.route("https://api.github.com/d", ("redirect", "http://api.github.com/e"))
    with pytest.raises(github_auth.GitHubError, match="non-https"):
        github_auth.http_get("https://api.github.com/d", token="t" * 40)
    assert github_auth.sends_token_to("https://api.github.com/x")
    assert not github_auth.sends_token_to("https://objects.githubusercontent.com/x")
    assert not github_auth.sends_token_to("http://api.github.com/x")


def test_mac_keychain_gets_the_token_on_stdin_not_argv(monkeypatch):
    calls = []
    token = "github_pat_" + "z" * 30

    def run(argv, **kwargs):
        calls.append((argv, kwargs.get("input")))
        return subprocess.CompletedProcess(argv, 0, stdout=token if "find-generic-password" in argv else "", stderr="")
    monkeypatch.setattr(github_auth.subprocess, "run", run)
    store = github_auth.MacKeychainStore()
    monkeypatch.setattr(store, "_security", lambda: "/usr/bin/security")
    store.set(token)
    argv, stdin = calls[0]
    assert argv == ["/usr/bin/security", "-i"] and token in stdin and all(token not in a for a in argv)
    with pytest.raises(github_auth.GitHubError):
        store.set("not a token; rm -rf /")


def test_a_forced_check_asks_the_github_cli_again(updates, monkeypatch):
    """Check for Updates... after `gh auth login` uses the new sign-in at once (not gh's cached answer)."""
    lab_pack(monkeypatch)
    monkeypatch.setattr(github_auth, "gh_token", _REAL_GH_TOKEN)
    monkeypatch.setattr(github_auth, "find_gh", lambda: "/opt/homebrew/bin/gh")
    github_auth.reset_gh_cache()
    answer = {"code": 1, "out": ""}
    monkeypatch.setattr(github_auth.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(
        argv, answer["code"], stdout=answer["out"], stderr=""))
    try:
        assert app_update.check(force=True)["status"] == "auth_required"
        answer.update(code=0, out="gho_" + "n" * 36 + "\n")  # gh auth login, then Try again
        publish(updates["github"], "example-lab/FiberBrowser-private", manifest())
        result = app_update.check(force=True)
        assert result["status"] == "update_available" and result["token_source"] == "GitHub CLI"
    finally:
        github_auth.reset_gh_cache()


def test_gh_token_is_read_from_the_cli(monkeypatch):
    github_auth.reset_gh_cache()
    monkeypatch.setattr(github_auth, "find_gh", lambda: "/opt/homebrew/bin/gh")
    monkeypatch.setattr(github_auth.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(
        argv, 0, stdout="gho_" + "x" * 36 + "\n", stderr=""))
    assert github_auth.gh_token() == "gho_" + "x" * 36
    github_auth.reset_gh_cache()
    monkeypatch.setattr(github_auth.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(
        argv, 1, stdout="", stderr="not logged in"))
    assert github_auth.gh_token() is None
    github_auth.reset_gh_cache()


def test_device_flow_is_only_a_hook_without_a_client_id(monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_GITHUB_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.setattr(app_build, "build_info", lambda: None)
    assert github_auth.device_flow_client_id() is None
    monkeypatch.setenv("FIBERBROWSER_GITHUB_OAUTH_CLIENT_ID", "Iv1.labapp")
    assert github_auth.device_flow_client_id() == "Iv1.labapp"


# --- routes -------------------------------------------------------------------------------------------------------------

@pytest.fixture
def client(updates):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.app_info import router
    from routers.version import router as version_router
    app = FastAPI()
    app.include_router(router)
    app.include_router(version_router)
    return TestClient(app)


def test_routes_store_the_token_in_the_keychain_and_never_return_it(client, updates, monkeypatch):
    lab_pack(monkeypatch)
    token = "github_pat_" + "r" * 30
    assert client.post("/api/app/update/token", json={"token": "nope"}).status_code == 422
    response = client.post("/api/app/update/token", json={"token": token})
    assert response.status_code == 200 and token not in response.text
    assert updates["store"].token == token and response.json()["auth"]["keychain"]["has_token"] is True
    info = client.get("/api/app/info")
    assert info.status_code == 200 and token not in info.text
    assert token not in json.dumps(app_settings.load())
    if app_settings.settings_path().exists():
        assert token not in app_settings.settings_path().read_text()
    assert client.delete("/api/app/update/token").json()["auth"]["keychain"]["has_token"] is False


def test_info_route_says_which_fiberhmm_and_the_update_settings(client, updates, monkeypatch):
    lab_pack(monkeypatch)
    data = client.get("/api/app/info").json()
    assert data["packaged"] is True and data["fiberhmm"]["source"] in ("bundled", "env")
    assert data["fiberhmm"]["running"]["available"] in (True, False)
    assert data["updates"]["channel"] == "lab" and data["updates"]["check_at_startup"] is True
    assert data["updates"]["check_at_startup_default"] is True and data["updates"]["check_at_startup_set"] is False
    assert data["auth"]["keychain"]["name"] == "test keychain"
    r = client.post("/api/app/update/settings", json={"check_at_startup": False, "manifest_url": "http://x"})
    assert r.status_code == 422
    r = client.post("/api/app/update/settings", json={"check_at_startup": False})
    assert r.json()["updates"]["check_at_startup"] is False and r.json()["updates"]["check_at_startup_set"] is True


def test_fiberhmm_route_validates_the_custom_tree(client, updates, tmp_path):
    r = client.post("/api/app/fiberhmm", json={"source": "custom", "custom_path": str(tmp_path / "missing")})
    assert r.status_code == 422 and "not a FiberHMM source tree" in r.json()["detail"]
    tree = tmp_path / "FiberHMM"
    (tree / "fiberhmm" / "inference").mkdir(parents=True)
    (tree / "fiberhmm" / "__init__.py").write_text('__version__ = "3.0.0"\n')
    (tree / "fiberhmm" / "inference" / "strand_rescue.py").write_text("")
    r = client.post("/api/app/fiberhmm", json={"source": "custom", "custom_path": str(tree)})
    assert r.status_code == 200 and r.json()["checked"]["version"] == "3.0.0"
    assert "FiberHMM 3.0 core (footprint classes)" in r.json()["checked"]["missing"]
    assert app_settings.load()["fiberhmm"] == {"source": "custom", "custom_path": str(tree)}
    assert client.post("/api/app/fiberhmm", json={"source": "bundled"}).status_code == 200
    assert app_settings.load()["fiberhmm"]["source"] == "bundled"


def test_version_route_follows_the_startup_switch(client, updates):
    folder = shared_folder(updates["tmp"])
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    data = client.get("/api/version").json()
    assert data["update_available"] is True and data["latest"] == "3.0.1"
    app_settings.update("updates", {"check_at_startup": False})
    app_update.reset()
    data = client.get("/api/version").json()
    assert data["update_available"] is False and data["latest"] is None


def test_download_routes(client, updates):
    assert client.post("/api/app/update/download").status_code == 409
    folder = shared_folder(updates["tmp"])
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    assert client.get("/api/app/update", params={"force": 1}).json()["status"] == "update_available"
    assert client.post("/api/app/update/download").json()["state"] in ("downloading", "verifying", "done")
    assert wait_for_download()["state"] == "done"
    assert client.get("/api/app/update/download").json()["state"] == "done"


def test_app_routes_are_the_owners_only():
    """Never a public server's, a lab server member's or another device's (owner-only by default)."""
    from services.lab.auth import LAB_DENIED_PREFIXES
    from services.public_mode_guard import PUBLIC_ALLOWED
    from services.remote_access import REMOTE_ALLOWED
    assert "/api/app/" in LAB_DENIED_PREFIXES
    assert not any(path.startswith("/api/app/") for _, path in PUBLIC_ALLOWED | set(REMOTE_ALLOWED))


# --- review fixes -----------------------------------------------------------------------------------------------------

def test_a_manifest_of_another_channel_is_refused(updates, monkeypatch):
    lab_pack(monkeypatch)
    folder = shared_folder(updates["tmp"], data=manifest(channel="public"))
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    result = app_update.check(force=True)
    assert result["status"] == "error" and "public channel" in result["message"] and not result.get("download")


def test_malformed_downloads_are_a_manifest_error():
    with pytest.raises(app_update.UpdateError, match="downloads"):
        app_update.parse_manifest(json.dumps(manifest(downloads=[{"name": "x.dmg"}])))


def test_a_forbidden_cli_token_moves_on_to_the_keychain_token(updates, monkeypatch):
    lab_pack(monkeypatch)
    cli, stored = "gho_" + "c" * 36, "github_pat_" + "k" * 30
    monkeypatch.setattr(github_auth, "gh_token", lambda: cli)
    updates["store"].token = stored
    publish(updates["github"], "example-lab/FiberBrowser-private", manifest())
    release = updates["github"].routes["https://api.github.com/repos/example-lab/FiberBrowser-private/releases/latest"]
    updates["github"].route("https://api.github.com/repos/example-lab/FiberBrowser-private/releases/latest",
                            lambda h: 403 if h.get("authorization") == f"Bearer {cli}" else release)
    result = app_update.check(force=True)
    assert result["status"] == "update_available" and result["token_source"] == "test keychain"


def test_relative_downloads_resolve_against_the_manifest_after_redirects(updates, monkeypatch):
    fake = updates["github"]
    app_settings.update("updates", {"manifest_url": "https://lab.example.org/latest.json"})
    monkeypatch.setattr(app_update, "_pack_channel", lambda: ("lab", {}))

    class Final(FakeResponse):
        def geturl(self):
            return "https://lab.example.org/releases/v3.0.1/update.json"
    fake.route("https://lab.example.org/latest.json", ("redirect", "https://lab.example.org/releases/v3.0.1/update.json"))
    fake.route("https://lab.example.org/releases/v3.0.1/update.json", lambda h: Final(json.dumps(manifest()).encode()))
    fake.route("https://lab.example.org/releases/v3.0.1/FiberBrowser-3.0.1-arm64.dmg", DMG)
    assert app_update.check(force=True)["status"] == "update_available"
    app_update.start_download()
    assert wait_for_download()["state"] == "done"
    assert all("authorization" not in h for _, h in fake.requests)


def test_changing_settings_keeps_a_download_in_progress(updates, monkeypatch):
    import threading
    folder = shared_folder(updates["tmp"])
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    assert app_update.check(force=True)["status"] == "update_available"
    gate = threading.Event()
    real = app_update._open_source

    class Slow:
        def __init__(self, inner):
            self.inner = inner

        def read(self, n):
            gate.wait(5)
            return self.inner.read(n)

        def close(self):
            self.inner.close()
    monkeypatch.setattr(app_update, "_open_source", lambda e, o: Slow(real(e, o)))
    app_update.start_download()
    app_update.forget_check()  # what the settings and token routes do
    assert app_update.download_status()["state"] == "downloading"
    gate.set()
    status = wait_for_download()
    assert status["state"] == "done" and status["sha256"] == SHA


def test_version_route_answers_others_with_the_local_version_only(client, updates, monkeypatch):
    folder = shared_folder(updates["tmp"])
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    from fastapi.testclient import TestClient
    remote = TestClient(client.app, client=("192.168.1.20", 5000))
    data = remote.get("/api/version").json()
    assert data["latest"] is None and data["update_available"] is False
    from services import runtime
    monkeypatch.setattr(runtime, "get_public_mode", lambda: True)
    assert client.get("/api/version").json()["latest"] is None
    monkeypatch.setattr(runtime, "get_public_mode", lambda: False)
    assert client.get("/api/version").json()["latest"] == "3.0.1"
