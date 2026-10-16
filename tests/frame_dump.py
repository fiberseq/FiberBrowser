"""Frames as the loaders see them: ``python tests/frame_dump.py <repo> <bam>...`` prints JSON
{bam: {"compact": {read: [intervals, tf]}, "dense": {read: footprints}, "dafc": {read: segments}}} using the
loaders of <repo> (used to compare this tree with the pre-7bb69ed8 loaders)."""
import json
import sys


def dump(paths, region=("chr19", 47514000, 47520000)):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.reads import router
    from services.dafc_reads import query_bam_for_dafc
    from services.dense_bam_loader import load_reads_from_bam
    from state.browser_state import BrowserState
    from state.dependencies import get_state
    out = {}
    for path in paths:
        state = BrowserState(None)
        state.add_dataset("d", path)
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_state] = lambda: state
        body = TestClient(app).get("/api/reads/compact", params=dict(
            dataset_id="d", chrom=region[0], start=region[1], end=region[2], include_layers="true",
            max_reads=1000)).json()
        compact = {r["id"]: [r["intervals"], (r.get("layers") or {}).get("tf", {}).get("intervals")] for r in body["reads"]}
        frame = load_reads_from_bam(path, *region, spanning_only=False)
        dense = {} if frame is None or frame.empty else {
            str(rid): [int(v) for v in values]
            for rid, values in zip(frame["read_id"], frame.drop(columns=["read_id"]).to_numpy())}
        dafc = {}
        for entry in query_bam_for_dafc(path, *region):
            dafc.setdefault(str(entry.get("name") or entry.get("read_id")), []).append(
                json.loads(json.dumps({k: v for k, v in entry.items() if k not in ("chrom",)}, default=str)))
        out[path] = {"compact": compact, "dense": dense, "dafc": dafc}
    return out


if __name__ == "__main__":
    repo = sys.argv[1]
    sys.path[:0] = [f"{repo}/browser", f"{repo}/tests"]
    print(json.dumps(dump(sys.argv[2:])))
