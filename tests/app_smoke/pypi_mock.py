"""A loopback HTTPS proxy that answers ``https://pypi.org/pypi/fiberhmm/json`` itself (packaged-app smoke only).

The packaged app's FiberHMM update check reads a fixed URL (services/fiberhmm_update.PYPI_JSON_URL). To check that
code in the built app without letting the app reach the network, the app is opened with HTTPS_PROXY pointing here and
SSL_CERT_FILE naming a throwaway CA made for this run: a CONNECT to pypi.org:443 is answered with a certificate for
pypi.org signed by that CA, and GET /pypi/fiberhmm/json returns the index given to the proxy. Every other host and
path is refused, so the app downloads nothing (every request is recorded in ``requests``).
"""
from __future__ import annotations

import datetime
import json
import socket
import ssl
import threading
from pathlib import Path

PYPI_HOST = "pypi.org"
INDEX_PATH = "/pypi/fiberhmm/json"


def make_ca_and_leaf(folder: Path, host: str = PYPI_HOST) -> tuple[Path, Path, Path]:
    """A CA certificate and a leaf for ``host`` signed by it; returns (ca.pem, leaf.pem, leaf.key)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "FiberBrowser app smoke test CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
          .not_valid_after(now + datetime.timedelta(days=1))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                       data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                                       encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    key = ec.generate_private_key(ec.SECP256R1())
    leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
            .issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    folder.mkdir(parents=True, exist_ok=True)
    ca_pem, leaf_pem, leaf_key = folder / "ca.pem", folder / "leaf.pem", folder / "leaf.key"
    ca_pem.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    leaf_pem.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    leaf_key.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return ca_pem, leaf_pem, leaf_key


class PypiMockProxy:
    """``with PypiMockProxy(index, folder, port) as proxy:`` -> proxy.url, proxy.ca_file, proxy.requests."""

    def __init__(self, index: dict, folder: Path, port: int = 0):
        self.index = json.dumps(index).encode()
        self.ca_file, leaf, key = make_ca_and_leaf(folder)
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(leaf, key)
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", port))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.requests: list[dict] = []
        self._lock = threading.Lock()
        self._stop = False

    def _log(self, **entry):
        with self._lock:
            self.requests.append(entry)

    def __enter__(self):
        threading.Thread(target=self._serve, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self._stop = True
        try:
            self.sock.close()
        except OSError:
            pass

    def _serve(self):
        while not self._stop:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    @staticmethod
    def _read_head(conn) -> bytes:
        data = b""
        while b"\r\n\r\n" not in data and len(data) < 65536:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
        return data

    def _handle(self, conn):
        conn.settimeout(20)
        try:
            head = self._read_head(conn)
            line = head.split(b"\r\n", 1)[0].decode(errors="replace")
            parts = line.split()
            if len(parts) < 2:
                return
            method, target = parts[0], parts[1]
            if method != "CONNECT" or target.lower() != f"{PYPI_HOST}:443":
                self._log(method=method, target=target, answered=False)
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                return
            conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            try:
                tls = self.tls.wrap_socket(conn, server_side=True)
            except (ssl.SSLError, OSError) as error:
                self._log(method=method, target=target, answered=False, tls_error=str(error))
                return
            with tls:
                request = self._read_head(tls).split(b"\r\n", 1)[0].decode(errors="replace").split()
                path = request[1] if len(request) > 1 else ""
                ok = len(request) > 1 and request[0] == "GET" and path.split("?")[0] == INDEX_PATH
                self._log(method="GET", target=f"https://{PYPI_HOST}{path}", answered=ok)
                if ok:
                    tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                                + str(len(self.index)).encode() + b"\r\nConnection: close\r\n\r\n" + self.index)
                else:
                    tls.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        except (OSError, ssl.SSLError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass
