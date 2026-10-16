#!/usr/bin/env python3
"""Receiver for opt-in Copilot usage data uploaded by testers.

Pattern:
  1. Maintainer runs this on a host with HTTPS-accessible address (cloud VM,
     workstation + Cloudflare Tunnel / ngrok, etc.).
  2. `python scripts/copilot_collect_endpoint.py --generate-token alice`
     prints a token and saves it to the local allow-list. Repeat per tester.
  3. `python scripts/copilot_collect_endpoint.py --serve` starts a small
     FastAPI app on port 8090 that accepts POSTs of anonymized JSONL files
     into `~/.fiberhmm/copilot_collector/<tester>/session_<ts>.jsonl`.
  4. Maintainer gives each tester:
        export FIBERBROWSER_USAGE_UPLOAD_URL="https://<your-url>/upload"
        export FIBERBROWSER_USAGE_UPLOAD_TOKEN="<their-token>"
     Tester restarts the browser, sees a "Send to maintainer" button, clicks it.

This is a deliberately small reference implementation. Replace storage,
add rate limiting beyond the basic per-token-per-minute cap, or swap auth
schemes (mTLS, OIDC, etc.) for production hardening.
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from pathlib import Path
from typing import Optional

DEFAULT_HOME = Path.home() / ".fiberhmm" / "copilot_collector"
TOKENS_FILE_NAME = "tokens.json"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8090
DEFAULT_RATE_PER_MINUTE = 30  # rolling-window cap per token
MAX_PAYLOAD_BYTES = 64 * 1024 * 1024  # 64 MB upper bound per upload


def _tokens_path(home: Path) -> Path:
    return home / TOKENS_FILE_NAME


def _load_tokens(home: Path) -> dict[str, str]:
    path = _tokens_path(home)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_tokens(home: Path, tokens: dict[str, str]) -> None:
    home.mkdir(parents=True, exist_ok=True)
    _tokens_path(home).write_text(json.dumps(tokens, indent=2), encoding="utf-8")


def generate_token(home: Path, tester_name: str) -> str:
    tokens = _load_tokens(home)
    if tester_name in tokens:
        print(f"Tester {tester_name!r} already has a token. Use --rotate to replace it.", file=sys.stderr)
        return tokens[tester_name]
    token = "tk_" + secrets.token_urlsafe(16)
    tokens[tester_name] = token
    _save_tokens(home, tokens)
    print(f"Tester:        {tester_name}")
    print(f"Token:         {token}")
    print(f"Allow-list:    {_tokens_path(home)}")
    print()
    print("Tell the tester to set these env vars before starting the browser:")
    print(f'  export FIBERBROWSER_USAGE_UPLOAD_URL="https://<your-url>/upload"')
    print(f'  export FIBERBROWSER_USAGE_UPLOAD_TOKEN="{token}"')
    return token


def rotate_token(home: Path, tester_name: str) -> str:
    tokens = _load_tokens(home)
    if tester_name not in tokens:
        print(f"No existing token for {tester_name!r}; use --generate-token instead.", file=sys.stderr)
        sys.exit(1)
    new_token = "tk_" + secrets.token_urlsafe(16)
    tokens[tester_name] = new_token
    _save_tokens(home, tokens)
    print(f"Rotated. New token for {tester_name}: {new_token}")
    return new_token


def revoke_token(home: Path, tester_name: str) -> None:
    tokens = _load_tokens(home)
    if tester_name not in tokens:
        print(f"No token for {tester_name!r}.", file=sys.stderr)
        sys.exit(1)
    del tokens[tester_name]
    _save_tokens(home, tokens)
    print(f"Revoked {tester_name}.")


def list_tokens(home: Path) -> None:
    tokens = _load_tokens(home)
    if not tokens:
        print("(no tokens yet — use --generate-token <tester-name>)")
        return
    print(f"{'tester':<30s}  token preview")
    print(f"{'-' * 30}  {'-' * 20}")
    for name, token in sorted(tokens.items()):
        print(f"{name:<30s}  {token[:10]}…")


def serve(home: Path, host: str, port: int, rate_per_minute: int) -> None:
    try:
        from fastapi import FastAPI, Header, HTTPException, Request
        from fastapi.responses import JSONResponse
        import uvicorn
    except ImportError:
        print("Need fastapi + uvicorn:  pip install 'fastapi[standard]' uvicorn", file=sys.stderr)
        sys.exit(1)

    home.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="FiberBrowser Copilot Usage Collector")
    rate_buckets: dict[str, list[float]] = {}

    def _resolve_tester(authorization: Optional[str]) -> str:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing Bearer token")
        token = authorization[len("Bearer "):].strip()
        tokens = _load_tokens(home)
        for tester, expected in tokens.items():
            if secrets.compare_digest(token, expected):
                return tester
        raise HTTPException(status_code=403, detail="Unknown token (revoked or never issued)")

    def _rate_limit_ok(tester: str) -> bool:
        now = time.monotonic()
        window = rate_buckets.setdefault(tester, [])
        window[:] = [t for t in window if now - t < 60.0]
        if len(window) >= rate_per_minute:
            return False
        window.append(now)
        return True

    @app.get("/healthz")
    async def healthz():
        return {"ok": True, "testers": len(_load_tokens(home))}

    @app.post("/upload")
    async def upload(request: Request, authorization: Optional[str] = Header(None)):
        tester = _resolve_tester(authorization)
        if not _rate_limit_ok(tester):
            raise HTTPException(status_code=429, detail="Rate limit (30/min per tester)")
        body = await request.body()
        if len(body) > MAX_PAYLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"Payload too large ({len(body)} bytes)")
        target_dir = home / tester
        target_dir.mkdir(parents=True, exist_ok=True)
        ts = int(time.time())
        path = target_dir / f"session_{ts}.jsonl"
        path.write_bytes(body)
        line_count = body.count(b"\n")
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {tester}: {len(body)} bytes, {line_count} lines -> {path}")
        return JSONResponse({"ok": True, "bytes": len(body), "lines": line_count, "stored_at": str(path)})

    print(f"Listening on {host}:{port}  (collector home: {home})")
    print(f"Allow-list:    {_tokens_path(home)}  ({len(_load_tokens(home))} tester(s))")
    print(f"Rate limit:    {rate_per_minute}/min per tester")
    print()
    print("HTTPS:  Run this behind Caddy / Cloudflare Tunnel / nginx for TLS.")
    print("        Example: `cloudflared tunnel --url http://localhost:8090`")
    uvicorn.run(app, host=host, port=port, log_level="info")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", default=str(DEFAULT_HOME),
                        help="Directory for tokens.json and per-tester upload folders")
    parser.add_argument("--generate-token", metavar="TESTER",
                        help="Mint a new token for the named tester")
    parser.add_argument("--rotate", metavar="TESTER",
                        help="Rotate the token for an existing tester")
    parser.add_argument("--revoke", metavar="TESTER",
                        help="Revoke a tester's token")
    parser.add_argument("--list", action="store_true",
                        help="List active tokens")
    parser.add_argument("--serve", action="store_true",
                        help="Start the receiver HTTP server")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--rate-per-minute", type=int, default=DEFAULT_RATE_PER_MINUTE)
    args = parser.parse_args()

    home = Path(args.home).expanduser()
    if args.generate_token:
        generate_token(home, args.generate_token)
        return 0
    if args.rotate:
        rotate_token(home, args.rotate)
        return 0
    if args.revoke:
        revoke_token(home, args.revoke)
        return 0
    if args.list:
        list_tokens(home)
        return 0
    if args.serve:
        serve(home, args.host, args.port, args.rate_per_minute)
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
