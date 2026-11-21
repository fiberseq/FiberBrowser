"""Find classes, then NFRs on the same window, through the real routes: the class join.

The combined path ran only in the e2e spec under FIBERBROWSER_E2E_NFR_CLASSES=1, and most
accessibility service tests fake consensus_workflow.load_payload. Here a 300-read DddA BAM
(the tracked demo's reads, renamed) goes through POST /api/footprint/consensus/jobs, then
POST /api/accessibility/jobs on the same window, which reuses the class run's evidence and
joins its classes by molecule. The test checks the joined molecule identities against both
runs and the denominators the NFR classes route reports, including molecules a class did
not label (they count as open but not as labelled).
"""
from __future__ import annotations

import time

import pysam
import pytest

from realpath_helpers import DEMO_BAM, state_client

pytestmark = pytest.mark.skipif(not DEMO_BAM.exists(), reason="tracked demo BAM browser/data/demo/napa_ddda.bam missing")
START, END = 47515000, 47515300


def _subset(path, n=300):
    names = set()
    with pysam.AlignmentFile(str(DEMO_BAM)) as src, pysam.AlignmentFile(str(path), "wb", template=src) as out:
        for read in src.fetch("chr19", START, START + 1):
            if read.reference_end >= END and len(names) < n:
                read.query_name = f"synthetic-{len(names):04d}"
                names.add(read.query_name)
                out.write(read)
    pysam.index(str(path))
    assert len(names) == n
    return str(path), names


def _wait(client, url, timeout_s=240):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        job = client.get(url).json()
        if job["status"] in ("complete", "failed", "cancelled", "error"):
            return job
        time.sleep(0.3)
    raise AssertionError(f"{url} did not finish in {timeout_s} s")


def test_find_classes_then_nfrs_join_by_molecule_with_consistent_denominators(standalone_app, tmp_path):
    from fiberhmm.inference.accessibility import analysis as A
    from lab.services.accessibility_workflow import _session as nfr_session

    bam, names = _subset(tmp_path / "subset.bam")
    with state_client(standalone_app, {"d": bam}) as (client, state):
        submitted = client.post("/api/footprint/consensus/jobs", json=dict(
            dataset_ids=["d"], chrom="chr19", start=START, end=END,
            parameters=dict(compute=dict(cores=2), recaller=dict(learned_spots=False))))
        assert submitted.status_code == 200, submitted.text
        cjob = _wait(client, f"/api/footprint/consensus/jobs/{submitted.json()['job_id']}")
        assert cjob["status"] == "complete", cjob.get("message")
        families = [c["family"] for c in client.get(f"/api/footprint/consensus/jobs/{cjob['job_id']}/catalog").json()
                    ["datasets"]["d"]["catalog"]]
        assert families and cjob["summary"]["d"]["classes"] == len(families)
        units = cjob["summary"]["d"]["units"]

        submitted = client.post("/api/accessibility/jobs", json=dict(
            dataset_ids=["d"], chrom="chr19", start=START, end=END, parameters=dict(bootstrap=20)))
        assert submitted.status_code == 200, submitted.text
        ajob = _wait(client, f"/api/accessibility/jobs/{submitted.json()['job_id']}")
        assert ajob["status"] == "complete", ajob.get("message")
        assert ajob["class_job_id"] == cjob["job_id"] and ajob["payload_source"].startswith("reused from Find classes run")
        join = ajob["result"]["class_join"]
        assert join["classes"] == len(families)
        assert join["molecules"] == join["class_molecules"] == join["joined_molecules"] == units

        full = nfr_session(state)[0][ajob["job_id"]]["result"]
        molecules = full["molecules"]
        assert len(molecules) == units
        assert {m["read_name"] for m in molecules.values()} <= names  # the BAM's reads, by name
        elements = A.elements(full)
        tf = {k: e for k, e in elements.items() if e.get("kind") == "tf"}
        assert set(tf) == set(families)
        for e in tf.values():
            assert set(e["state"]) <= set(molecules)  # joined by the run's own molecule ids
            assert set(e["state"].values()) <= {0, 1}

        nfrs = ajob["result"]["nfrs"]
        assert nfrs
        saw_unlabelled = False
        for nfr in nfrs:
            body = client.get(f"/api/accessibility/jobs/{ajob['job_id']}/nfrs/{nfr['id']}/classes").json()
            assert body["joined"] == "run" and body["class_job"] == cjob["job_id"], body
            assert body["classes"], body.get("reason")
            for cls in body["classes"]:
                assert cls["class_id"] in families
                state_of = tf[cls["id"]]["state"]
                for variant, layer in cls["layers"].items():
                    members = A.member_uids(full, f"{nfr['id']}:{variant}")
                    assert layer["labelled"] <= layer["open"] <= layer["reads"] <= len(members)
                    assert layer["labelled"] + layer["unlabelled_open"] == layer["open"]
                    labelled_members = members & set(state_of)
                    assert layer["footprinted"] <= sum(state_of[u] for u in labelled_members)
                    if layer["labelled"]:
                        assert layer["p_fp_given_open"] == round(layer["footprinted"] / layer["labelled"], 4)
                    if layer["reads"]:
                        assert layer["p_open"] == round(layer["open"] / layer["reads"], 4)
                    if members - set(state_of) and layer["unlabelled_open"]:
                        saw_unlabelled = True  # molecules the class did not label: open, not in its denominator
        assert saw_unlabelled
