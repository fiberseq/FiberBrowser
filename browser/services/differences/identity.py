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

    def reconcile(self, namespace: str, groups, *, max_records=None):
        """Register the current grouping of one discovery scope and write lineage.

        ``groups`` is ``[(observation_ids, snapshot)]``. Active records of the
        same namespace that share observations with a current group are its
        predecessors. One predecessor whose observations went only to this
        group with a different membership is ``membership_revised``; several
        predecessors joining one group are a ``cluster_merge``; one predecessor
        whose observations went to several groups is a one-to-many
        ``cluster_split``; anything else is ``regrouped``. An unchanged member
        set keeps its identity. Records outside the current groups are left
        untouched, so panning never retires a cluster that is merely out of view.
        Returns ``(identities, events)``, identities in group order.
        """
        groups = [(sorted(set(ids)), snapshot) for ids, snapshot in groups]
        active = {identity: set(record["observation_ids"]) for identity, record in self.data["records"].items()
                  if record.get("namespace") == namespace and record["identity_state"] != "retired"}
        owner = {}
        for identity, members in active.items():
            for member in members:
                owner.setdefault(member, set()).add(identity)
        identities, events = [], []
        predecessors = []
        for members, snapshot in groups:
            seed = content_id("seed:v1", [namespace, members])
            if seed in self.data["seeds"] and self.data["seeds"][seed] in active:
                identities.append(self.data["seeds"][seed])
                predecessors.append(set())
                continue
            if max_records is not None and len(self.data["records"]) >= max_records:
                identities.append(None)
                predecessors.append(set())
                continue
            # A member set seen before under a since-retired identity returns
            # as a new record; the retired one keeps its lineage.
            self.data["seeds"].pop(seed, None)
            identities.append(self.register(namespace, members, snapshot))
            predecessors.append({p for m in members for p in owner.get(m, ())})
        # Connected components of the predecessor/descendant bipartite graph.
        root = {}

        def find(node):
            while root.setdefault(node, node) != node:
                root[node] = root[root[node]]
                node = root[node]
            return node
        for identity, parents in zip(identities, predecessors):
            for parent in parents:
                root[find(("p", parent))] = find(("c", identity))
        components = {}
        for node in list(root):
            kind, identity = node
            if identity is not None:
                components.setdefault(find(node), (set(), set()))[0 if kind == "p" else 1].add(identity)
        for component_parents, component_children in sorted(components.values(), key=lambda pc: sorted(pc[0])):
            if not component_parents or not component_children:
                continue
            if len(component_parents) == 1 and len(component_children) == 1:
                reason = "membership_revised"
            elif len(component_children) == 1:
                reason = "cluster_merge"
            elif len(component_parents) == 1:
                reason = "cluster_split"
            else:
                reason = "regrouped"
            parents, children = sorted(component_parents), sorted(component_children)
            self.retire(parents, children, reason=reason,
                        proof={"shared_observations": sorted(set().union(*(active[p] for p in parents))
                                                              & {m for ids, _ in groups for m in ids})[:64]})
            events.append({"reason": reason, "parents": parents, "descendants": children})
        return identities, events

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
