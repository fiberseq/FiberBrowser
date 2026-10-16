"""The lab pack's routes: each one classified for a public server and for remote viewers, like core's
(tests/test_public_mode_guard.py, tests/test_remote_access.py leave pack routes to this file)."""
from __future__ import annotations

# Lab routes a public server refuses on purpose (host processes, host files, experimental jobs).
LAB_PUBLIC_DENIED = {
    ("POST", "/api/lab/region-classes"),
    ("POST", "/api/lab/cluster-regions"),
    # the Accessibility preview (experimental FiberHMM NFR-variant jobs; refused on public servers)
    ("GET", "/api/accessibility/schema"), ("GET", "/api/accessibility/jobs"), ("POST", "/api/accessibility/jobs"),
    ("GET", "/api/accessibility/jobs/{job_id}"), ("DELETE", "/api/accessibility/jobs/{job_id}"),
    ("GET", "/api/accessibility/jobs/{job_id}/groups"), ("GET", "/api/accessibility/jobs/{job_id}/reads"),
    ("GET", "/api/accessibility/jobs/{job_id}/export/{name}"),
    ("GET", "/api/accessibility/jobs/{job_id}/overview"), ("POST", "/api/accessibility/jobs/{job_id}/split"),
    ("GET", "/api/accessibility/jobs/{job_id}/variants/{variant_id}/members.tsv"),
    ("GET", "/api/accessibility/jobs/{job_id}/variants/{variant_id}/sequence"),
    ("POST", "/api/accessibility/jobs/{job_id}/variants/{variant_id}/prevalence"),
    ("POST", "/api/accessibility/jobs/{job_id}/variants/{variant_id}/motifs"),
    ("GET", "/api/accessibility/jobs/{job_id}/variants/{variant_id}/{view}"),
    ("GET", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/members.tsv"),
    ("GET", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/sequence"),
    ("POST", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/prevalence"),
    ("POST", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/motifs"),
    ("POST", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/motifs/profile"),
    ("POST", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/motifs/sizes"),
    ("POST", "/api/accessibility/jobs/{job_id}/classes"), ("GET", "/api/accessibility/jobs/{job_id}/class-status"),
    ("GET", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/classes"), ("GET", "/api/accessibility/jobs/{job_id}/classes/{class_id}"),
    ("GET", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/cooccupancy"),
    ("GET", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/conservation"),
    ("POST", "/api/accessibility/pooled"), ("POST", "/api/accessibility/jobs/{job_id}/batch"),
    ("POST", "/api/accessibility/kmers"),
    ("GET", "/api/accessibility/batches/{batch_id}"),
    # Synchronise regions (minimap2 and read-loading jobs; refused on public servers)
    ("POST", "/api/lab/region-sync/jobs"), ("GET", "/api/lab/region-sync/jobs/{job_id}"),
    ("DELETE", "/api/lab/region-sync/jobs/{job_id}"), ("POST", "/api/lab/region-sync/cluster"),
    ("POST", "/api/lab/region-sync/locate"),
    ("POST", "/api/accessibility/jobs/{job_id}/chipatlas"), ("GET", "/api/accessibility/chipatlas/{task_id}"),
    ("GET", "/api/accessibility/jobs/{job_id}/chipatlas_experiments"),
    ("GET", "/api/accessibility/chipatlas_metadata"), ("POST", "/api/accessibility/chipatlas_metadata"),
    ("GET", "/api/accessibility/jobs/{job_id}/nfrs/{nfr_id}/{view}"),
    ("POST", "/api/accessibility/jobs/{job_id}/transfer"), ("GET", "/api/accessibility/transfers/{transfer_id}"),
    ("DELETE", "/api/accessibility/transfers/{transfer_id}"),
}

# Prefixes a remote viewer never reaches.
LAB_NEVER_REMOTE_PREFIXES = ("/api/accessibility",)


def _pack_routes():
    from plugins.packs import pack_router_routes
    return pack_router_routes()


def test_the_lab_pack_is_loaded():
    from plugins.packs import build_flavor, loaded_packs
    assert [p.name for p in loaded_packs()] == ["lab"]
    assert build_flavor() == "public"


def test_every_lab_route_is_classified(standalone_app):
    from services.public_mode_guard import PUBLIC_ALLOWED
    routes = _pack_routes()
    assert routes, "the lab pack serves no routes"
    unclassified = sorted(r for r in routes if r not in PUBLIC_ALLOWED and r not in LAB_PUBLIC_DENIED)
    assert not unclassified, f"Lab routes not classified for --public mode: {unclassified}"
    assert not (PUBLIC_ALLOWED & LAB_PUBLIC_DENIED)
    stale = sorted(r for r in LAB_PUBLIC_DENIED if r not in routes)
    assert not stale


def test_lab_routes_are_mounted(standalone_app):
    from utils.routes import app_routes        # FastAPI >= 0.142 nests included routers
    mounted = {(m, getattr(r, "path", "")) for r in app_routes(standalone_app) for m in (getattr(r, "methods", None) or ())}
    assert _pack_routes() <= mounted


def test_lab_remote_routes(standalone_app):
    from services.remote_access import REMOTE_ALLOWED
    leaked = sorted(r for r in REMOTE_ALLOWED if r[1].startswith(LAB_NEVER_REMOTE_PREFIXES))
    assert not leaked
    for route in _pack_routes():
        if route[1].startswith(LAB_NEVER_REMOTE_PREFIXES):
            assert route not in REMOTE_ALLOWED, route
