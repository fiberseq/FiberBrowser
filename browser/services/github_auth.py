"""GitHub access for the update check: tokens for a private release channel, and GETs that keep them safe.

A channel whose releases are private (a lab channel; services/app_update.py) needs a GitHub token that can read
that repository. Tokens are tried in this order, moving on when GitHub refuses one:

1. **GitHub CLI**: ``gh auth token`` when ``gh`` is installed and signed in (no setup for people who use gh).
2. **A personal access token** pasted once in Settings (a fine-grained, read-only token for that repository),
   kept in the OS keychain: the macOS Keychain (``security``), the Windows Credential Manager (from the WSL
   distribution, through PowerShell), or a ``keyring`` backend elsewhere. Never in a settings file, a log or a
   session.
3. **GitHub sign-in (OAuth device flow)**: only when the organisation registers an OAuth App and its client ID is
   configured (``FIBERBROWSER_GITHUB_OAUTH_CLIENT_ID`` or the build's ``github_oauth_client_id``); not built in
   (``device_flow_client_id`` is the hook).

``http_get`` sends a token to ``api.github.com`` only, over https, and follows redirects itself: a hop to any
other host (a release asset's signed download URL) goes without the Authorization header.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_]{20,255}$")
AUTH_HOSTS = frozenset({"api.github.com"})
KEYCHAIN_SERVICE = "FiberBrowser GitHub token"
KEYCHAIN_ACCOUNT = "github.com"
WINDOWS_TARGET = "FiberBrowser/github.com"
MAX_REDIRECTS = 5


class GitHubError(Exception):
    """A GitHub (or update host) answer other than success. ``status``: the HTTP status (0: no answer)."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def valid_token(token: str) -> bool:
    return bool(TOKEN_PATTERN.match(token or ""))


# --- token stores (the OS keychain) ---------------------------------------------------------------------------------

class TokenStore:
    name = "none"

    def available(self) -> tuple[bool, str]:
        return False, "No OS keychain is available here; sign in with the GitHub CLI (gh auth login) instead."

    def get(self) -> Optional[str]:
        return None

    def set(self, token: str) -> None:
        raise GitHubError(self.available()[1])

    def delete(self) -> None:
        return None


class MacKeychainStore(TokenStore):
    """The login keychain, through ``security``. The token is written through ``security -i`` on stdin, never as
    a command-line argument (which other processes could read)."""
    name = "macOS Keychain"

    def _security(self) -> Optional[str]:
        return shutil.which("security") or ("/usr/bin/security" if os.path.exists("/usr/bin/security") else None)

    def available(self) -> tuple[bool, str]:
        return (True, "") if self._security() else (False, "The macOS security tool is missing.")

    def get(self) -> Optional[str]:
        tool = self._security()
        if not tool:
            return None
        try:
            done = subprocess.run([tool, "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
                                  capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            return None
        token = done.stdout.strip() if done.returncode == 0 else ""
        return token if valid_token(token) else None

    def set(self, token: str) -> None:
        if not valid_token(token):
            raise GitHubError("That doesn't look like a GitHub token.")
        tool = self._security()
        if not tool:
            raise GitHubError(self.available()[1])
        command = f'add-generic-password -U -s "{KEYCHAIN_SERVICE}" -a "{KEYCHAIN_ACCOUNT}" -w "{token}"\n'
        try:
            done = subprocess.run([tool, "-i"], input=command, capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError) as error:
            raise GitHubError(f"Could not save the token in the Keychain ({type(error).__name__}).") from None
        if done.returncode != 0 or self.get() != token:
            raise GitHubError("Could not save the token in the Keychain.")

    def delete(self) -> None:
        tool = self._security()
        if tool:
            subprocess.run([tool, "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
                           capture_output=True, timeout=10, stdin=subprocess.DEVNULL)


_WINDOWS_CRED = r"""
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class FbCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize;
    public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) return "";
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
          return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); } finally { CredFree(p); } }
  public static bool Write(string target, string secret) {
    var bytes = Encoding.Unicode.GetBytes(secret); var c = new CREDENTIAL(); c.Type = 1; c.TargetName = target;
    c.UserName = "github.com"; c.Persist = 2; c.CredentialBlobSize = bytes.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
    try { Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length); return CredWriteW(ref c, 0); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
  public static bool Delete(string target) { return CredDeleteW(target, 1, 0); }
}
'@
$target = '__TARGET__'
switch ('__ACTION__') {
  'read'   { [Console]::Out.Write([FbCred]::Read($target)) }
  'write'  { $secret = [Console]::In.ReadLine(); if (-not [FbCred]::Write($target, $secret)) { exit 1 } }
  'delete' { [void][FbCred]::Delete($target) }
}
"""


class WindowsCredentialStore(TokenStore):
    """The Windows Credential Manager, from the WSL distribution (PowerShell; the token goes through stdin)."""
    name = "Windows Credential Manager"

    def _powershell(self) -> Optional[str]:
        try:
            from services.wsl_interop import windows_program
            return windows_program("powershell.exe")
        except Exception:
            return None

    def available(self) -> tuple[bool, str]:
        return (True, "") if self._powershell() else (False, "Windows PowerShell can't be reached from WSL.")

    def _run(self, action: str, stdin: str = "") -> subprocess.CompletedProcess:
        """The script goes as -EncodedCommand (no secret in it); the token, when writing, through stdin."""
        import base64
        ps = self._powershell()
        if not ps:
            raise GitHubError(self.available()[1])
        script = _WINDOWS_CRED.replace("__TARGET__", WINDOWS_TARGET).replace("__ACTION__", action)
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        return subprocess.run([ps, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                              input=(stdin + "\n") if stdin else "", capture_output=True, text=True, timeout=30)

    def get(self) -> Optional[str]:
        try:
            done = self._run("read")
        except (GitHubError, OSError, subprocess.SubprocessError):
            return None
        token = done.stdout.strip()
        return token if done.returncode == 0 and valid_token(token) else None

    def set(self, token: str) -> None:
        if not valid_token(token):
            raise GitHubError("That doesn't look like a GitHub token.")
        try:
            done = self._run("write", token)
        except (OSError, subprocess.SubprocessError) as error:
            raise GitHubError(f"Could not save the token in the Credential Manager ({type(error).__name__}).") from None
        if done.returncode != 0 or self.get() != token:
            raise GitHubError("Could not save the token in the Windows Credential Manager.")

    def delete(self) -> None:
        try:
            self._run("delete")
        except (GitHubError, OSError, subprocess.SubprocessError):
            pass


class KeyringStore(TokenStore):
    """A ``keyring`` backend (Linux Secret Service, ...), when one is installed and usable."""
    name = "system keyring"

    def _keyring(self):
        try:
            import keyring
            from keyring.backends import fail
            if isinstance(keyring.get_keyring(), fail.Keyring):
                return None
            return keyring
        except Exception:
            return None

    def available(self) -> tuple[bool, str]:
        return (True, "") if self._keyring() else TokenStore.available(self)

    def get(self) -> Optional[str]:
        kr = self._keyring()
        try:
            token = kr.get_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) if kr else None
        except Exception:
            return None
        return token if token and valid_token(token) else None

    def set(self, token: str) -> None:
        if not valid_token(token):
            raise GitHubError("That doesn't look like a GitHub token.")
        kr = self._keyring()
        if not kr:
            raise GitHubError(self.available()[1])
        try:
            kr.set_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token)
        except Exception as error:
            raise GitHubError(f"Could not save the token in the keyring ({type(error).__name__}).") from None

    def delete(self) -> None:
        kr = self._keyring()
        try:
            if kr:
                kr.delete_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        except Exception:
            pass


_store: Optional[TokenStore] = None


def token_store() -> TokenStore:
    global _store
    if _store is None:
        if sys.platform == "darwin":
            _store = MacKeychainStore()
        else:
            try:
                from services.wsl_interop import is_wsl
                wsl = is_wsl()
            except Exception:
                wsl = False
            _store = WindowsCredentialStore() if wsl else KeyringStore()
    return _store


def set_token_store(store: Optional[TokenStore]) -> None:
    """Replace the keychain (tests: an in-memory store; None: pick again)."""
    global _store
    _store = store


# --- the GitHub CLI -------------------------------------------------------------------------------------------------

_gh_cache: Optional[tuple[float, Optional[str]]] = None
_gh_lock = threading.Lock()
GH_CACHE_S = 60.0


def find_gh() -> Optional[str]:
    """``gh`` on PATH, or where Homebrew puts it (an app started by launchd has a minimal PATH), or ``gh.exe``
    through the Windows interop PATH in WSL."""
    for name in ("gh", "gh.exe"):
        found = shutil.which(name)
        if found:
            return found
    for path in ("/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def gh_token() -> Optional[str]:
    """The GitHub CLI's token for github.com, when gh is installed and signed in (cached a minute)."""
    global _gh_cache
    with _gh_lock:
        if _gh_cache is not None and time.monotonic() - _gh_cache[0] < GH_CACHE_S:
            return _gh_cache[1]
        token = None
        gh = find_gh()
        if gh:
            try:
                done = subprocess.run([gh, "auth", "token", "--hostname", "github.com"], capture_output=True,
                                      text=True, timeout=10, stdin=subprocess.DEVNULL,
                                      env={**os.environ, "GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1"})
                candidate = done.stdout.strip() if done.returncode == 0 else ""
                token = candidate if valid_token(candidate) else None
            except (OSError, subprocess.SubprocessError):
                token = None
        _gh_cache = (time.monotonic(), token)
        return token


def reset_gh_cache() -> None:
    global _gh_cache
    _gh_cache = None


def token_candidates() -> list[tuple[str, str]]:
    """(source, token) in the order they are tried: the GitHub CLI, then the keychain."""
    out: list[tuple[str, str]] = []
    token = gh_token()
    if token:
        out.append(("GitHub CLI", token))
    stored = token_store().get()
    if stored and all(stored != t for _, t in out):
        out.append((token_store().name, stored))
    return out


def auth_status() -> dict:
    """What can authenticate, without revealing any token."""
    store = token_store()
    ok, reason = store.available()
    return {
        "gh": {"installed": find_gh() is not None, "signed_in": gh_token() is not None},
        "keychain": {"name": store.name, "available": ok, "reason": reason or None,
                     "has_token": bool(ok and store.get())},
        "device_flow": {"configured": device_flow_client_id() is not None},
    }


def device_flow_client_id() -> Optional[str]:
    """The hook for GitHub sign-in (OAuth device flow): the client ID of an OAuth App the organisation registered.
    Not built in, and no other project's client ID may be used; see docs/updates.md."""
    value = os.environ.get("FIBERBROWSER_GITHUB_OAUTH_CLIENT_ID", "").strip()
    if not value:
        try:
            from services.app_build import build_info
            value = str((build_info() or {}).get("github_oauth_client_id") or "").strip()
        except Exception:
            value = ""
    return value or None


# --- GETs that keep the token on GitHub's API host ------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # followed by http_get, host by host
        return None


def _default_opener():
    return urllib.request.build_opener(_NoRedirect())


opener_factory = _default_opener


def _user_agent() -> str:
    try:
        from version import __version__
    except Exception:
        __version__ = "unknown"
    return f"FiberBrowser/{__version__}"


def sends_token_to(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    return parsed.scheme == "https" and (parsed.hostname or "").lower() in AUTH_HOSTS


def http_get(url: str, *, token: Optional[str] = None, accept: Optional[str] = None, timeout: float = 20.0):
    """GET ``url`` over https, following up to ``MAX_REDIRECTS`` redirects itself. The token goes in the
    Authorization header only on hops to ``api.github.com``; nothing but the standard headers goes elsewhere.
    Returns the open response. Raises GitHubError (with the HTTP status) otherwise."""
    opener = opener_factory()
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        if urllib.parse.urlparse(current).scheme != "https":
            raise GitHubError(f"Refused a non-https address for the update check: {_safe(current)}")
        headers = {"User-Agent": _user_agent()}
        if accept:
            headers["Accept"] = accept
        if token and sends_token_to(current):
            headers["Authorization"] = f"Bearer {token}"
            headers.setdefault("X-GitHub-Api-Version", "2022-11-28")
        request = urllib.request.Request(current, headers=headers, method="GET")
        try:
            return opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308):
                location = error.headers.get("Location") if error.headers else None
                error.close()
                if not location:
                    raise GitHubError("A redirect without a location", error.code) from None
                current = urllib.parse.urljoin(current, location)
                continue
            message = _github_message(error)
            error.close()
            raise GitHubError(message, error.code) from None
        except (urllib.error.URLError, OSError, ValueError) as error:
            reason = getattr(error, "reason", error)
            raise GitHubError(f"Could not reach {urllib.parse.urlparse(current).hostname}: {reason}") from None
    raise GitHubError("Too many redirects")


def _safe(url: str) -> str:
    """A URL without its query (signed download URLs carry credentials there)."""
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse(parsed._replace(query="", fragment=""))


def _github_message(error: urllib.error.HTTPError) -> str:
    try:
        import json
        body = json.loads(error.read(65536).decode("utf-8", "replace"))
        text = body.get("message") if isinstance(body, dict) else None
    except Exception:
        text = None
    return f"HTTP {error.code}" + (f": {text}" if text else "")
