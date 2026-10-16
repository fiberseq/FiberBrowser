"""Reverse-strand coordinate frame of fibertools-rs and FiberHMM footprint tags.

The fixtures in ``tests/fixtures/fibertools_frame`` were written by the real
tools (see ``make_fixtures.py``): fibertools-rs 0.13.0 (``Ma``/``Aq``),
fibertools-rs 0.6.2 (legacy ``ns/nl/as/al/aq``) and FiberHMM 3.0.0
(``MA/AQ`` + legacy tags, ``coord=molecular``). All of them store intervals in
molecular (original-read) orientation, so a reverse read's offsets count from
the genomic right end. ``expected.json`` holds fibertools' own conversion to
reference coordinates (``ft extract -r``), which FiberBrowser must reproduce on
both strands.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pysam
import pytest

from services import bam_tags
from services.compact_read_loader import build_compact_reads_from_bam
from services.dense_bam_loader import load_reads_from_bam

FIXTURES = Path(__file__).parent / "fixtures" / "fibertools_frame"
EXPECTED = json.loads((FIXTURES / "expected.json").read_text())
L = EXPECTED["truth"]["L"]
GAPS = EXPECTED["truth"]["gaps"]
ALL = sorted(EXPECTED["fixtures"])
FROM_MM_INPUT = [n for n in ALL if "predict" not in n]   # nucleosomes follow the planted m6A-free gaps
READS = ("read_fwd", "read_rev")


def _render(path) -> dict:
    reads = build_compact_reads_from_bam(str(path), "chrT", 0, L, spanning_only=False, hide_terminal_gaps=False)
    return {r["id"]: r for r in reads}


def _intervals(read, layer):
    return sorted([iv[0], iv[1]] for iv in read["layers"][layer]["intervals"])


def _gap_coverage(intervals):
    covered = set()
    for a, b in intervals:
        covered.update(range(a, b))
    return sum(len(covered & set(range(a, b))) / (b - a) for a, b in GAPS) / len(GAPS)


def _copy_with_header(src: Path, dst: Path, edit_header=None, edit_read=None) -> Path:
    with pysam.AlignmentFile(str(src)) as bam:
        header = bam.header.to_dict()
        if edit_header:
            edit_header(header)
        with pysam.AlignmentFile(str(dst), "wb", header=header) as out:
            for read in bam:
                if edit_read:
                    edit_read(read)
                out.write(read)
    pysam.index(str(dst))
    return dst


@pytest.mark.parametrize("name", ALL)
def test_nucleosomes_and_msps_match_fibertools_reference_on_both_strands(name):
    reads = _render(FIXTURES / name)
    expected = EXPECTED["fixtures"][name]
    for rid in READS:
        assert _intervals(reads[rid], "nuc") == expected["nuc"][rid], (name, rid)
        assert _intervals(reads[rid], "msp") == expected["msp"][rid], (name, rid)
    # The reverse read's layout is asymmetric, so a mirrored (SEQ-frame) reading could not pass the check above.
    rev = expected["nuc"]["read_rev"]
    assert sorted([L - b, L - a] for a, b in rev) != rev


@pytest.mark.parametrize("name", FROM_MM_INPUT)
def test_reverse_read_nucleosomes_sit_on_the_m6a_free_gaps(name):
    reads = _render(FIXTURES / name)
    for rid in READS:
        assert _gap_coverage(_intervals(reads[rid], "nuc")) > 0.97, (name, rid)


@pytest.mark.parametrize("name", ["ft0.13_addnuc_fire.bam", "ft0.6.2_addnuc_fire.bam"])
def test_fire_elements_keep_their_quality_on_reverse_reads(name):
    # ft 0.13 writes FIRE as an Ma `fire.Q` layer + Aq; ft 0.6.2 writes aq parallel to as/al, both in molecular
    # order (fire.rs reverses the precisions for reverse reads). Each element must keep its own score.
    reads = _render(FIXTURES / name)
    layer = "fire" if "0.13" in name else "msp"
    for rid in READS:
        lay = reads[rid]["layers"][layer]
        quals = lay["qualities"][0]
        got = sorted([iv[0], iv[1], q] for iv, q in zip(lay["intervals"], quals) if q not in (0, 128))
        assert got == EXPECTED["fixtures"][name]["fire"][rid], (name, rid)


@pytest.mark.parametrize("name", ALL)
def test_dense_loader_places_reverse_read_nucleosomes_like_fibertools(name):
    frame = load_reads_from_bam(str(FIXTURES / name), "chrT", 0, L, spanning_only=False).set_index("read_id")
    for rid in READS:
        row = frame.loc[rid]
        got = {int(c) for c, v in row.items() if str(c).isdigit() and v > 0}
        want = set()
        for a, b in EXPECTED["fixtures"][name]["nuc"][rid]:
            want.update(range(a, b))
        assert got == want, (name, rid)


def test_fixture_headers_declare_the_molecular_frame():
    with pysam.AlignmentFile(str(FIXTURES / "ft0.6.2_addnuc_fire.bam")) as bam:
        assert bam_tags.bam_legacy_tags_are_molecular(bam.header) is True       # fibertools @PG
    with pysam.AlignmentFile(str(FIXTURES / "fiberhmm3.0.0_call.bam")) as bam:
        assert bam_tags.bam_legacy_tags_are_molecular(bam.header) is True       # coord=molecular in @PG DS
        assert bam_tags.bam_ma_aq_tags_are_molecular(bam.header) is True


def _set_ft_command(cl, version):
    def edit(header):
        header["PG"] = [{"ID": "ft.1", "PN": "fibertools-rs", "VN": version, "CL": cl}]
    return edit


@pytest.mark.parametrize("cl,version", [
    # Real @PG lines from older fibertools-rs BAMs (a GM12878 sample; fibertools-rs' own test data).
    ("ft predict -m 254 -v -t 16 data/in.bam data/GM12878.m6a.bam", "0.1.4"),
    ("ft predict -k all.bam all2.bam", "0.3.8"),
    ("target/debug/ft add .test/all.bam .test/all.2.bam", "0.2.4"),
])
def test_older_fibertools_subcommand_spellings_are_molecular(tmp_path, cl, version):
    # `ft predict`/`ft add` were the names of predict-m6a/add-nucleosomes in early fibertools-rs (0.13 still accepts
    # them as prefixes). They were not recognised, so these BAMs' reverse reads were mirrored. On the user's
    # GM12878.sample.bam (ft 0.1.4 `ft predict`), reverse reads have 1.07 m6A/kb inside ns/nl nucleosomes read in
    # molecular frame vs 44.85 in SEQ frame.
    path = _copy_with_header(FIXTURES / "ft0.6.2_addnuc_fire.bam", tmp_path / "old_ft.bam",
                             edit_header=_set_ft_command(cl, version))
    with pysam.AlignmentFile(str(path)) as bam:
        assert bam_tags.bam_legacy_tags_are_molecular(bam.header) is True
    reads = _render(path)
    assert _intervals(reads["read_rev"], "nuc") == EXPECTED["fixtures"]["ft0.6.2_addnuc_fire.bam"]["nuc"]["read_rev"]


def test_a_path_mentioning_fiberhmm_is_not_fiberhmm_provenance(tmp_path):
    def edit(header):
        header["PG"].append({"ID": "samtools", "PN": "samtools", "PP": header["PG"][-1]["ID"], "VN": "1.21",
                             "CL": "samtools sort -o /home/u/work/ft_calls.sorted.bam ft_calls.bam"})
    path = _copy_with_header(FIXTURES / "ft0.6.2_addnuc_fire.bam", tmp_path / "sorted.bam", edit_header=edit)
    with pysam.AlignmentFile(str(path)) as bam:
        assert bam_tags.bam_legacy_tags_are_molecular(bam.header) is True
    reads = _render(path)
    assert _intervals(reads["read_rev"], "nuc") == EXPECTED["fixtures"]["ft0.6.2_addnuc_fire.bam"]["nuc"]["read_rev"]


def test_a_later_fiberhmm_program_record_still_wins():
    header = {"PG": [
        {"ID": "ft.1", "PN": "fibertools-rs", "CL": "ft predict -m 254 in.bam out.bam"},
        {"ID": "fiberhmm-apply", "PN": "fiberhmm-apply", "PP": "ft.1", "CL": "fiberhmm-apply -i in.bam -o out.bam"},
    ]}
    assert bam_tags.bam_legacy_tags_are_molecular(header) is False


def test_fiberhmm_legacy_only_and_ma_only_views_render_identically(tmp_path):
    src = FIXTURES / "fiberhmm3.0.0_call.bam"

    def strip(tags):
        def edit(read):
            for tag in tags:
                if read.has_tag(tag):
                    read.set_tag(tag, None)
        return edit

    full = _render(src)
    legacy_only = _render(_copy_with_header(src, tmp_path / "legacy.bam", edit_read=strip(("MA", "AQ", "AN"))))
    ma_only = _render(_copy_with_header(src, tmp_path / "ma.bam", edit_read=strip(("ns", "nl", "as", "al", "nq", "aq"))))
    for rid in READS:
        for layer in ("nuc", "msp"):
            want = EXPECTED["fixtures"]["fiberhmm3.0.0_call.bam"][layer][rid]
            assert _intervals(full[rid], layer) == want
            assert _intervals(legacy_only[rid], layer) == want
            assert _intervals(ma_only[rid], layer) == want


def _installed_ft_reads_ma() -> bool:
    """fibertools-rs >= 0.13 (reads both Ma and legacy ns/nl) is on PATH."""
    if shutil.which("ft") is None:
        return False
    try:
        version = subprocess.run(["ft", "--version"], capture_output=True, text=True, timeout=30).stdout.split()[1]
        return tuple(int(x) for x in version.lstrip("v").split(".")[:2]) >= (0, 13)
    except Exception:
        return False


@pytest.mark.skipif(not _installed_ft_reads_ma(), reason="fibertools-rs >= 0.13 (ft) not installed")
@pytest.mark.parametrize("name", ALL)
def test_expected_reference_coordinates_match_installed_fibertools(name):
    for kind in ("nuc", "msp"):
        out = subprocess.run(["ft", "extract", "-r", f"--{kind}", "-", str(FIXTURES / name)],
                             capture_output=True, text=True, check=True).stdout
        got = {}
        for line in out.splitlines():
            f = line.split("\t")
            sizes = [int(x) for x in f[10].strip(",").split(",")]
            starts = [int(x) for x in f[11].strip(",").split(",")]
            got[f[3]] = sorted([int(f[1]) + s, int(f[1]) + s + z] for s, z in list(zip(starts, sizes))[1:-1])
        assert got == EXPECTED["fixtures"][name][kind]


def test_diagnose_does_not_tell_current_fibertools_users_to_add_nucleosomes(tmp_path):
    # ft 0.13 writes nucleosomes only as Ma:Z:<len>;nuc.:...;msp.:... (no ns/nl). The BAM diagnosis used to
    # recommend "Run 'ft add-nucleosomes'" on exactly the output of ft add-nucleosomes.
    from services.files_endpoint import diagnose_bam_payload

    def advice(path):
        result = diagnose_bam_payload(None, bam_path=str(path), chrom="chrT", limit=5)
        return " ".join(result["recommendations"])

    for name in ("ft0.13_addnuc_fire.bam", "ft0.13_predict_m6a.bam", "fiberhmm3.0.0_call.bam",
                 "ft0.6.2_addnuc_fire.bam"):
        assert "add-nucleosomes" not in advice(FIXTURES / name), name

    def strip_ma(read):
        for tag in ("Ma", "Aq"):
            read.set_tag(tag, None)
    m6a_only = _copy_with_header(FIXTURES / "ft0.13_addnuc_fire.bam", tmp_path / "m6a_only.bam", edit_read=strip_ma)
    assert "add-nucleosomes" in advice(m6a_only)
