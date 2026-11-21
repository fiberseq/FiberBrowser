"""A loaded genome without its annotation, and "Reset to <genome> genes" (owner report, 3.1.0 RC, 20 Nov).

`--fasta dm6.fa` on a fresh ~/.fiberhmm has no dm6 genes (nothing cached to pair with it). Loading dm6 from the genome
list then answered "Genome already loaded" and did nothing, so the genes came only after loading another genome
first (yeast, then dm6 again). Now the user's FASTA stays and only dm6's annotation is loaded; another genome's
annotation under it is replaced; and the annotation can be reset to the reference's own in one call.
"""
import pysam
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from state.browser_state import BrowserState

DM6_INFO_KEYS = ("name", "gtf_url")


def _fasta(path, contigs):
    with open(path, "w") as fh:
        for name in contigs:
            fh.write(f">{name}\n" + "ACGT" * 50 + "\n")
    pysam.faidx(str(path))
    return path


def _gtf(path, chroms, prefix):
    with open(path, "w") as fh:
        for i, chrom in enumerate(chroms):
            attrs = f'gene_id "{prefix}{i}"; gene_name "{prefix}{i}"; transcript_id "{prefix}T{i}";'
            fh.write(f"{chrom}\tt\tgene\t10\t100\t.\t+\t.\t{attrs}\n")
            fh.write(f"{chrom}\tt\ttranscript\t10\t100\t.\t+\t.\t{attrs}\n")
            fh.write(f"{chrom}\tt\texon\t10\t100\t.\t+\t.\t{attrs}\n")
    return path


FLY = ["chr2L", "chr2R", "chr3L", "chr3R", "chr4", "chrX", "chrM"]
YEAST = ["chrI", "chrII", "chrIII", "chrIV", "chrV", "chrVI", "chrVII", "chrVIII", "chrIX", "chrX", "chrM"]


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    cache = tmp_path / "home" / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True)
    return cache


@pytest.fixture
def no_downloads(monkeypatch):
    calls = []

    def refuse(url, *a, **k):
        calls.append(url)
        raise OSError(f"offline: {url}")
    monkeypatch.setattr("services.http_download.fetch", refuse)
    return calls


def _dm6_state(tmp_path):
    """--fasta dm6.fa at start-up: the genome id inferred from the name, no annotation cached to pair with it."""
    state = BrowserState(None)
    fa = _fasta(tmp_path / "dm6.fa", FLY)
    assert state._load_fasta(str(fa)) is None
    assert state.current_genome == "dm6" and state.gtf_data is None
    return state, fa


def _client(state):
    from routers.genome import router
    from state.dependencies import get_state
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    return TestClient(app)


def test_loading_the_startup_genome_loads_its_missing_annotation_and_keeps_the_fasta(tmp_path, home, no_downloads, monkeypatch):
    state, fa = _dm6_state(tmp_path)
    handle = state.fasta
    _gtf(home / "dm6.gtf", ["chr2L", "chr3R"], "fly")   # cached since (another tab, a download)
    monkeypatch.setattr(state, "_load_fasta", lambda *a, **k: pytest.fail("the user's FASTA was replaced"))

    body = _client(state).post("/api/load_genome", params={"genome_id": "dm6"}).json()

    assert body["success"] and body["already_loaded"] and body["gtf_loaded"] is True
    assert state.fasta is handle and state.fasta_path == str(fa)
    assert state.gtf_path == str(home / "dm6.gtf") and len(state.gtf_data["transcripts"]) == 2
    assert no_downloads == []
    # Asked again: nothing to do.
    again = _client(state).post("/api/load_genome", params={"genome_id": "dm6"}).json()
    assert again["already_loaded"] and again["message"] == "Genome already loaded"


def test_the_missing_annotation_is_downloaded_not_the_fasta(tmp_path, home, monkeypatch):
    state, fa = _dm6_state(tmp_path)
    fetched = []

    def fetch(url, dest, *a, **k):
        fetched.append(url)
        _gtf(dest, ["chr2L"], "fly")
    monkeypatch.setattr("services.http_download.fetch", fetch)
    from services.genome_registry import GENOME_REGISTRY
    info = dict(GENOME_REGISTRY["dm6"], gtf_url="https://example.invalid/dm6.gtf")
    from services.genome_loading import load_genome_blocking

    res = load_genome_blocking(state, "dm6", info)

    assert fetched == ["https://example.invalid/dm6.gtf"]
    assert res["gtf_loaded"] and state.fasta_path == str(fa)


def test_a_confirmed_annotation_download_keeps_the_users_fasta(tmp_path, home, monkeypatch):
    """Audit (final 3.1.0, HIGH): after the annotation download asked for confirmation (pending), the confirmed
    retry loads only the annotation; the registry FASTA never replaces the user's --fasta."""
    state, fa = _dm6_state(tmp_path)
    handle = state.fasta
    from services.genome_loading import load_genome_blocking, pending_annotation, set_pending_annotation
    set_pending_annotation(state, "dm6")   # the first attempt was over the download warning size
    fetched = []

    def fetch(url, dest, *a, **k):
        fetched.append(url)
        _gtf(dest, ["chr2L"], "fly")
    monkeypatch.setattr("services.http_download.fetch", fetch)
    monkeypatch.setattr(state, "_load_fasta", lambda *a, **k: pytest.fail("the user's FASTA was replaced"))
    from services.genome_registry import GENOME_REGISTRY
    info = dict(GENOME_REGISTRY["dm6"], gtf_url="https://example.invalid/dm6.gtf")

    res = load_genome_blocking(state, "dm6", info)

    assert fetched == ["https://example.invalid/dm6.gtf"]
    assert res["gtf_loaded"] and state.fasta is handle and state.fasta_path == str(fa)
    assert pending_annotation(state) is None


def test_another_genomes_annotation_under_the_startup_fasta_is_replaced(tmp_path, home, no_downloads):
    """Yeast genes (another registry genome's cached annotation) over the dm6 FASTA: loading dm6 puts dm6's in."""
    from services.gene_annotations import load_gtf
    state, fa = _dm6_state(tmp_path)
    _gtf(home / "sacCer3.gtf", YEAST, "yeast")
    state.gtf_data = load_gtf(str(home / "sacCer3.gtf"))
    state.gtf_path = str(home / "sacCer3.gtf")
    _gtf(home / "dm6.gtf", ["chr2L"], "fly")

    body = _client(state).post("/api/load_genome", params={"genome_id": "dm6"}).json()

    assert body["success"] and body["gtf_loaded"]
    assert state.gtf_path == str(home / "dm6.gtf") and state.fasta_path == str(fa)
    assert no_downloads == []


def test_a_foreign_annotation_goes_when_the_right_one_cannot_be_had(tmp_path, home, no_downloads):
    from services.gene_annotations import load_gtf
    state, _ = _dm6_state(tmp_path)
    yeast = _gtf(tmp_path / "my_yeast.gtf", YEAST, "yeast")      # the user's own file, not the cache's
    state.gtf_data = load_gtf(str(yeast))
    state.gtf_path = str(yeast)

    body = _client(state).post("/api/load_genome", params={"genome_id": "dm6"}).json()

    assert body["success"] and body["gtf_loaded"] is False and "offline" in body["gtf_error"]
    assert state.gtf_data is None and state.gtf_path is None


def test_the_users_own_annotation_that_fits_is_kept(tmp_path, home, no_downloads):
    from services.gene_annotations import load_gtf
    state, _ = _dm6_state(tmp_path)
    mine = _gtf(tmp_path / "my_fly.gtf", ["chr2L", "chr3R", "chrX"], "mine")
    state.gtf_data = load_gtf(str(mine))
    state.gtf_path = str(mine)

    body = _client(state).post("/api/load_genome", params={"genome_id": "dm6"}).json()

    assert body["already_loaded"] and body["message"] == "Genome already loaded"
    assert state.gtf_path == str(mine) and no_downloads == []


def test_another_assemblys_annotation_with_the_same_contig_names_does_not_fit(tmp_path, home, monkeypatch):
    """Audit (final 3.1.0, MED): mouse chr1-19, X, Y are all hg38 names. Over a reference whose contig lengths are a
    known whole assembly, transcripts running past the contig ends show another assembly's annotation; one that fits
    stays fitting; a circular contig's origin-wrapping genes are not counted; and a partial reference (not a known
    assembly) is never judged so, as features beyond it are only out of view."""
    from services import genome_loading as GL
    from services.gene_annotations import load_gtf
    contigs = [f"chr{i}" for i in range(1, 20)] + ["chrX", "chrY"]
    state = BrowserState(None)
    assert state._load_fasta(str(_fasta(tmp_path / "ref.fa", contigs))) is None   # contigs of 200 bp
    state.circular_chroms = {}

    def gtf(name, rows):
        path = tmp_path / name
        with open(path, "w") as fh:
            for i, (chrom, start, end) in enumerate(rows):
                attrs = f'gene_id "g{i}"; gene_name "g{i}"; transcript_id "t{i}";'
                for feature in ("gene", "transcript", "exon"):
                    fh.write(f"{chrom}\tt\t{feature}\t{start}\t{end}\t.\t+\t.\t{attrs}\n")
        return load_gtf(str(path))

    overrunning = gtf("other_assembly.gtf", [(c, 150, 900) for c in contigs])
    fitting = gtf("fits.gtf", [(c, 10, 100) for c in contigs])
    wrapping = gtf("wrap.gtf", [("chr4", 150, 250), ("chr4", 170, 260)] + [(c, 10, 100) for c in contigs])

    from services.genome_loading import _alias_keys
    every = set().union(*(_alias_keys(c) for c in contigs))
    monkeypatch.setattr(GL, "_complete_contigs", lambda fasta: every)
    state.gtf_data = overrunning
    assert GL.annotation_fits(state) is False
    state.gtf_data = fitting
    assert GL.annotation_fits(state) is True
    state.gtf_data = wrapping
    assert GL.annotation_fits(state) is False            # two genes past a linear contig's end
    state.circular_chroms = {"chr4": {"size": 200}}
    assert GL.annotation_fits(state) is True             # the same contig circular: they wrap its origin
    state.circular_chroms = {}
    # A partial reference (not a known whole assembly): never judged by overruns.
    monkeypatch.setattr(GL, "_complete_contigs", lambda fasta: set())
    state.gtf_data = overrunning
    assert GL.annotation_fits(state) is True


def test_only_contigs_of_their_assemblys_exact_length_count_as_complete():
    """Re-check (final 3.1.0, N1): whole hg38 chr1 beside a cropped chr2 certifies chr1 only."""
    from services.assembly_fingerprint import canonical_contigs
    from services.genome_loading import _complete_contigs
    hg38 = canonical_contigs("hg38")

    class Fasta:
        def __init__(self, lengths):
            self.lengths, self.references = lengths, list(lengths)

        def get_reference_length(self, name):
            return self.lengths[name]

    complete = _complete_contigs(Fasta({"chr1": hg38["chr1"], "chr2": 1_000_000}))
    assert "chr2" not in complete and ("chr1" in complete or complete == set())
    assert "chr2" in _complete_contigs(Fasta(dict(hg38)))
    assert _complete_contigs(Fasta({"chr1": 1_000_000})) == set()


def test_annotation_fit_by_contig_names(tmp_path, home):
    from services.gene_annotations import load_gtf
    from services.genome_loading import annotation_fits
    state, _ = _dm6_state(tmp_path)
    assert annotation_fits(state) is None
    state.gtf_data = load_gtf(str(_gtf(tmp_path / "y.gtf", YEAST, "y")))     # shares only chrX and chrM
    assert annotation_fits(state) is False
    state.gtf_data = load_gtf(str(_gtf(tmp_path / "f.gtf", ["chr2L", "2R", "chrUn_x"], "f")))  # Ensembl names too
    assert annotation_fits(state) is True


def test_genome_check_reports_the_annotation_and_its_reset_target(tmp_path, home):
    from services.gene_annotations import load_gtf
    from services.genome_check import annotation_check, loaded_reference
    state, _ = _dm6_state(tmp_path)
    reference = dict(loaded_reference(state), assembly="dm6")     # a tiny test FASTA: say what it fingerprints as
    out = annotation_check(state, reference, suggestion=None, can_load=True)
    assert out["loaded"] is False and out["target"]["genome_id"] == "dm6" and out["can_reset"] and not out["current"]
    _gtf(home / "sacCer3.gtf", YEAST, "yeast")
    state.gtf_data = load_gtf(str(home / "sacCer3.gtf"))
    state.gtf_path = str(home / "sacCer3.gtf")
    out = annotation_check(state, reference, suggestion=None, can_load=True)
    assert out["genome_id"] == "sacCer3" and out["fits"] is False and out["gene_count"] == len(YEAST)
    assert out["target"]["genome_id"] == "dm6" and out["target"]["cached"] is False and not out["current"]
    # No reference at all: the genome the data points to.
    empty = BrowserState(None)
    out = annotation_check(empty, loaded_reference(empty), suggestion="dm6", can_load=True)
    assert out["target"]["genome_id"] == "dm6"
    assert annotation_check(empty, loaded_reference(empty), suggestion="dm6", can_load=False)["can_reset"] is False


def test_reset_annotation_replaces_it_with_the_references_own(tmp_path, home, no_downloads, monkeypatch):
    from services.gene_annotations import load_gtf
    import services.genome_check as gc
    state, fa = _dm6_state(tmp_path)
    mine = _gtf(tmp_path / "old.gtf", ["chr2L"], "old")
    state.gtf_data = load_gtf(str(mine))
    state.gtf_path = str(mine)
    _gtf(home / "dm6.gtf", ["chr2L", "chr3L"], "fly")

    res = _client(state).post("/api/genome/reset_annotation", params={"genome_id": "dm6"}).json()

    assert res["success"] and res["gtf_loaded"] and res["gene_count"] == 2
    assert state.gtf_path == str(home / "dm6.gtf") and state.fasta_path == str(fa)
    # Another assembly's annotation on this reference is refused.
    real = gc.loaded_reference
    monkeypatch.setattr(gc, "loaded_reference", lambda s: dict(real(s), assembly="dm6"))
    refused = _client(state).post("/api/genome/reset_annotation", params={"genome_id": "sacCer3"}).json()
    assert refused["success"] is False and "switch the genome" in refused["gtf_error"]
    assert state.gtf_path == str(home / "dm6.gtf")


def test_reset_annotation_is_refused_on_a_public_server(tmp_path, home, monkeypatch):
    state, _ = _dm6_state(tmp_path)
    monkeypatch.setattr("services.runtime.get_public_mode", lambda: True)
    assert _client(state).post("/api/genome/reset_annotation", params={"genome_id": "dm6"}).status_code == 403


def test_fasta_assembly_reads_the_index(tmp_path, home):
    """A remembered FASTA's assembly, from its .fai (a page restoring it checks it against the loaded data)."""
    from services.assembly_fingerprint import canonical_contigs
    fa = tmp_path / "anything.fa"
    fa.write_text(">chr2L\nACGT\n")
    with open(str(fa) + ".fai", "w") as fh:
        for name, length in canonical_contigs("sacCer3").items():
            fh.write(f"{name}\t{length}\t0\t60\t61\n")
    client = _client(BrowserState(None))
    assert client.get("/api/genome/fasta_assembly", params={"path": str(fa)}).json() == {"exists": True, "assembly": "sacCer3"}
    assert client.get("/api/genome/fasta_assembly", params={"path": str(tmp_path / "gone.fa")}).json()["exists"] is False
    url = client.get("/api/genome/fasta_assembly", params={"path": "https://example.invalid/sacCer3.fa.gz"}).json()
    assert url == {"exists": False, "assembly": None}


def test_status_says_whether_the_reference_is_the_command_lines(tmp_path, home):
    from routers.genome import router
    from state.dependencies import get_state
    state, fa = _dm6_state(tmp_path)
    state.startup_fasta = str(fa)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    assert client.get("/api/status").json()["startup_reference"] is True
    other = _fasta(tmp_path / "other.fa", ["chrZ"])
    state._load_fasta(str(other))
    assert client.get("/api/status").json()["startup_reference"] is False


def test_member_and_workspace_forks_keep_the_command_line_reference(tmp_path, home):
    """Audit (final 3.1.0, MED): a lab member's or workspace's fork inherits --fasta and says so in /api/status, so a
    restore there never replaces it."""
    from routers.genome import router
    from state.dependencies import get_state
    template, fa = _dm6_state(tmp_path)
    template.startup_fasta = str(fa)
    def provider(fork):
        return lambda: fork
    for fork in (BrowserState.fork_for_session(template), BrowserState.fork_for_session(template, copy_shared=True)):
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_state] = provider(fork)
        assert TestClient(app).get("/api/status").json()["startup_reference"] is True


def test_gene_responses_revalidate_against_the_loaded_annotation(tmp_path, home):
    """A max-age kept the previous annotation's genes in the browser's cache for five minutes after another loaded."""
    from fastapi import FastAPI
    from routers.read_auxiliary import router
    from services.gene_annotations import load_gtf
    from state.dependencies import get_state
    state, _ = _dm6_state(tmp_path)
    state.gtf_data = load_gtf(str(_gtf(tmp_path / "a.gtf", ["chr2L"], "first")))
    state.gtf_path = str(tmp_path / "a.gtf")
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    params = {"chrom": "chr2L", "start": 0, "end": 1000}
    first = client.get("/api/genes", params=params)
    assert first.headers["cache-control"] == "no-cache" and first.headers["etag"]
    assert client.get("/api/genes", params=params, headers={"If-None-Match": first.headers["etag"]}).status_code == 304
    state.gtf_data = load_gtf(str(_gtf(tmp_path / "b.gtf", ["chr2L"], "second")))
    state.gtf_path = str(tmp_path / "b.gtf")
    again = client.get("/api/genes", params=params, headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 200 and again.headers["etag"] != first.headers["etag"]
    assert [g.get("gene_name") or g.get("name") for g in again.json()["genes"]] == ["second0"]


def test_gene_responses_revalidate_when_a_contig_becomes_circular(tmp_path, home):
    """Audit (final 3.1.0, MED): a gene across a circular contig's origin is drawn wrapped, so marking the contig
    circular changes the genes response: the ETag changes with it (304 kept the linear answer)."""
    from routers.read_auxiliary import router
    from services.gene_annotations import load_gtf
    from state.dependencies import get_state
    state, _ = _dm6_state(tmp_path)                  # every contig is 200 bp
    state.circular_chroms = {}
    path = tmp_path / "wrap.gtf"
    with open(path, "w") as fh:
        attrs = 'gene_id "w"; gene_name "wrap"; transcript_id "w";'
        for feature in ("gene", "transcript", "exon"):
            fh.write(f"chr4\tt\t{feature}\t150\t250\t.\t+\t.\t{attrs}\n")
    state.gtf_data = load_gtf(str(path))
    state.gtf_path = str(path)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    client = TestClient(app)
    params = {"chrom": "chr4", "start": 0, "end": 30}
    linear = client.get("/api/genes", params=params)
    assert linear.json()["genes"] == []
    state.circular_chroms = {"chr4": {"size": 200}}
    again = client.get("/api/genes", params=params, headers={"If-None-Match": linear.headers["etag"]})
    assert again.status_code == 200 and again.headers["etag"] != linear.headers["etag"]
    assert len(again.json()["genes"]) == 1


def test_a_whole_genome_annotation_fits_a_reference_of_part_of_that_genome(tmp_path, home, no_downloads):
    """chr3 of hg38 (named hg38.fa) under the user's whole-genome GTF: few transcripts on chr3, but the same genome.
    Not flagged, and loading hg38 keeps the user's annotation."""
    from services.gene_annotations import load_gtf
    from services.genome_loading import annotation_fits
    state = BrowserState(None)
    assert state._load_fasta(str(_fasta(tmp_path / "hg38.fa", ["chr3"]))) is None
    assert state.current_genome == "hg38"
    human = [f"chr{i}" for i in range(1, 23)] + ["chrX", "chrY"]
    mine = _gtf(tmp_path / "gencode_mine.gtf", human, "h")
    state.gtf_data = load_gtf(str(mine))
    state.gtf_path = str(mine)
    assert annotation_fits(state) is True
    body = _client(state).post("/api/load_genome", params={"genome_id": "hg38"}).json()
    assert body["already_loaded"] and state.gtf_path == str(mine) and no_downloads == []
    # A mouse annotation on it is another genome's.
    state.gtf_data = load_gtf(str(_gtf(tmp_path / "mouse.gtf", [f"chr{i}" for i in range(1, 20)] + ["chrX"], "m")))
    assert annotation_fits(state) is False
