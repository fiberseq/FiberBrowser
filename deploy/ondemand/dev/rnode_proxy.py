#!/usr/bin/env python3
"""A tiny stand-in for Open OnDemand's reverse proxy, to test FiberBrowser under a URL prefix locally.

    python deploy/ondemand/dev/rnode_proxy.py --listen 8950 --backend 127.0.0.1:8951 \\
        --prefix /rnode/localhost/8951 [--keep-prefix]

Requests to ``http://127.0.0.1:8950/rnode/localhost/8951/...`` are forwarded to
the backend. Like OnDemand's ``/rnode/`` the prefix is stripped (``--keep-prefix``
forwards it, like ``/node/``). Anything outside the prefix gets 404, as it would
from the portal (it is not your app), so a request the app forgot to prefix
shows up as a failure. ``X-Forwarded-For`` / ``-Proto`` / ``-Host`` are set, and
responses are streamed. No WebSocket support (FiberBrowser doesn't need it).
Standard library only.
"""
from __future__ import annotations

import argparse
import http.client
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
       "transfer-encoding", "upgrade"}


def make_handler(backend: str, prefix: str, keep_prefix: bool, log: bool):
    host, _, port = backend.partition(":")

    class Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # noqa: N802
            if log:
                sys.stderr.write("[rnode-proxy] " + fmt % args + "\n")

        def _forward(self):
            path = self.path
            if not (path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?")):
                body = b"Not this app (outside the proxy prefix)\n"
                self.send_response(404)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            upstream_path = path if keep_prefix else (path[len(prefix):] or "/")
            if upstream_path.startswith("?"):
                upstream_path = "/" + upstream_path
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and k.lower() != "host"}
            headers["Host"] = backend  # Apache ProxyPass without ProxyPreserveHost
            headers["X-Forwarded-For"] = self.client_address[0]
            headers["X-Forwarded-Proto"] = "http"
            headers["X-Forwarded-Host"] = self.headers.get("Host", "")
            conn = http.client.HTTPConnection(host, int(port), timeout=600)
            try:
                conn.request(self.command, upstream_path, body=body, headers=headers)
                response = conn.getresponse()
                self.send_response(response.status, response.reason)
                for key, value in response.getheaders():
                    if key.lower() in HOP or key.lower() == "content-length":
                        continue
                    self.send_header(key, value)
                if self.command == "HEAD" or response.status in (204, 304):
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    chunk = response.read1(65536) if hasattr(response, "read1") else response.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
            except (ConnectionError, OSError) as exc:
                message = f"Proxy error: {exc}\n".encode()
                try:
                    self.send_response(502)
                    self.send_header("Content-Length", str(len(message)))
                    self.end_headers()
                    self.wfile.write(message)
                except OSError:
                    pass
            finally:
                conn.close()

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _forward

    return Proxy


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--listen", type=int, default=8950)
    parser.add_argument("--backend", default="127.0.0.1:8951")
    parser.add_argument("--prefix", default="/rnode/localhost/8951")
    parser.add_argument("--keep-prefix", action="store_true", help="forward the prefix (OnDemand /node/ style)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    prefix = "/" + args.prefix.strip("/")
    server = ThreadingHTTPServer(("127.0.0.1", args.listen),
                                 make_handler(args.backend, prefix, args.keep_prefix, not args.quiet))
    print(f"rnode proxy: http://127.0.0.1:{args.listen}{prefix}/ -> http://{args.backend}"
          f"{prefix if args.keep_prefix else ''}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
