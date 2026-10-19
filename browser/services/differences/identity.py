"""Content namespaces and a session-persistable identity/lineage ledger.

Callers supply verified immutable content/provenance identities, never paths,
timestamps, medians, support counts or previews. No implicit source relinking.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
import threading
import uuid
from collections import OrderedDict

from .model import SCHEMA_VERSION

_digests = OrderedDict()
_digest_lock = threading.Lock()


def digest_file(locator):
    """Verify full bytes lazily; paths/stat stamps are only cache revisions.

    Byte-identical relocation/touch keeps the content namespace. A file changed
    during hashing is refused rather than assigning it an unstable identity.
    """
    def stamp():
        stat = os.stat(locator)
        return (os.fspath(locator), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    before = stamp()
    with _digest_lock:
        if before in _digests:
            _digests.move_to_end(before)
            return _digests[before]
    digest = hashlib.sha256()
    with open(locator, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            from services.background_work import checkpoint
            checkpoint()
            digest.update(chunk)
    if before != stamp():
        raise ValueError('source changed while verifying immutable identity')
    result = 'sha256:' + digest.hexdigest()
    with _digest_lock:
        _digests[before] = result
        while len(_digests) > 128:
            _digests.popitem(last=False)
    return result


def content_id(namespace: str, value) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return namespace + ":" + hashlib.sha256(raw).hexdigest()


def observation_id(content_namespace: str, record_identity: str, operation_identity: str, occurrence: int = 0):
    if not content_namespace or not record_identity or not operation_identity or occurrence < 0:
        raise ValueError("immutable observation provenance required")
    return content_id("observation:v1", [content_namespace, record_identity, operation_identity, occurrence])


def exact_local_allele_id(reference_id: str, contig: str, start: int, ref: str, alt: str, *, normalization: str):
    """Hash complete, already repeat-normalized strings, trimming common flanks.

    This is the local namespace, not a replacement/repeat canonicalizer. Missing
    bases (including N) must remain provisional; the empty deletion is valid.
    """
    if not reference_id or not contig or start < 0 or not normalization:
        raise ValueError("canonical reference and normalization version required")
    ref, alt = ref.upper(), alt.upper()
    if any(base not in "ACGT" for base in ref + alt):
        raise ValueError("full unambiguous haplotypes required")
    while ref and alt and ref[-1] == alt[-1]:
        ref, alt = ref[:-1], alt[:-1]
    offset = 0
    while offset < min(len(ref), len(alt)) and ref[offset] == alt[offset]:
        offset += 1
    start += offset
    ref, alt = ref[offset:], alt[offset:]
    return content_id("allele:norm:" + normalization,
                      [reference_id, contig, start, start + len(ref),
                       hashlib.sha256(ref.encode()).hexdigest(), hashlib.sha256(alt.encode()).hexdigest()])


class IdentityLedger:
    def __init__(self, saved=None):
        self.data = deepcopy(saved) if saved is not None else {
            "schema_version": SCHEMA_VERSION, "records": {}, "seeds": {}, "lineage": {}, "snapshots": {}}
        if self.data.get("schema_version") != SCHEMA_VERSION:
            raise ValueError("unsupported identity ledger")

    def register(self, namespace: str, observation_ids, snapshot: dict) -> str:
        members = sorted(set(observation_ids))
        if not namespace or not members:
            raise ValueError("provisional identity needs a namespace and observations")
        key = content_id("seed:v1", [namespace, members])
        existing = self.data["seeds"].get(key)
        if existing:
            return existing
        identity = "difference:v1:" + uuid.uuid4().hex
        self.data["seeds"][key] = identity
        self.data["records"][identity] = {"identity_state": "provisional", "revision": 1,
                                           "exact_allele_id": None, "namespace": namespace,
                                           "observation_ids": members}
        self.data["snapshots"][identity] = deepcopy(snapshot)
        return identity

    def resolve_exact(self, identity, exact_id):
        record = self.data["records"][identity]
        if record["identity_state"] == "retired" or not exact_id.startswith("allele:norm:"):
            raise ValueError("cannot resolve this record")
        old = record.get("exact_allele_id")
        if old is not None and old != exact_id:
            raise ValueError("normalization changes require new identity and lineage")
        record.update(identity_state="exact", exact_allele_id=exact_id, revision=record["revision"] + 1)

    def retire(self, parents, descendants, *, reason, proof=None):
        parents, descendants = tuple(parents), tuple(descendants)
        if not parents or not descendants or set(parents) & set(descendants):
            raise ValueError("lineage needs disjoint existing endpoints")
        for identity in (*parents, *descendants):
            if identity not in self.data["records"] or self.data["records"][identity]["identity_state"] == "retired":
                raise ValueError("lineage endpoints must be active")
        for identity in parents:
            self.data["records"][identity]["identity_state"] = "retired"
            self.data["lineage"][identity] = {"descendants": list(descendants), "reason": reason,
                                               "proof": deepcopy(proof)}

    def lookup(self, identity, *, frozen=True):
        # Frozen selections never acquire a different target or membership.
        snapshot = self.data["snapshots"].get(identity)
        if snapshot is None:
            return {"status": "unresolved", "difference_id": identity}
        descendants = self.data["lineage"].get(identity, {}).get("descendants", [])
        return {"status": "frozen" if frozen else "unresolved_split" if len(descendants) > 1 else "retired" if descendants else "resolved",
                "difference_id": identity, "snapshot": deepcopy(snapshot), "descendants": list(descendants)}

    def payload(self):
        return deepcopy(self.data)
