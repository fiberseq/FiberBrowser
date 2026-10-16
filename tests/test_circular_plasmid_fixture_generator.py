import importlib.util
import sys
from pathlib import Path

import pysam

from models.domain import Dataset
from services.plasmid_maps import parse_plasmid_map
from services.read_endpoint import compact_reads_payload_for_request
from state.browser_state import BrowserState


def _load_generator_module():
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "generate_circular_plasmid_fixture.py"
    spec = importlib.util.spec_from_file_location("generate_circular_plasmid_fixture", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_circular_plasmid_fixture_generates_phased_bam_and_map(tmp_path):
    generator = _load_generator_module()

    paths = generator.generate_fixture(
        tmp_path / "fixture",
        name="pTiny",
        length=1200,
        read_count=12,
        seed=3,
    )

    assert paths.plasmid_map.exists()
    assert paths.fasta.exists()
    assert paths.bam.exists()
    assert paths.bai.exists()
    assert paths.manifest.exists()

    plasmid = parse_plasmid_map(str(paths.plasmid_map))
    assert plasmid.name == "pTiny"
    assert plasmid.circular is True
    assert len(plasmid.sequence) == 1200
    assert any(feature.name == "origin_spanning_feature" for feature in plasmid.features)

    with pysam.AlignmentFile(str(paths.bam), "rb") as bam:
        assert bam.references == ("pTiny",)
        assert bam.lengths == (1200,)
        reads = list(bam.fetch("pTiny", 0, 1))

    assert len(reads) == 12
    assert {read.get_tag("HP") for read in reads} == {1, 2}
    assert {read.get_tag("RG") for read in reads} == {"phaseA", "phaseB"}
    assert any("origin_nuc" in name for read in reads for name in read.get_tag("AN").split(","))


def test_generated_fixture_wraps_and_merges_origin_spanning_layers(tmp_path):
    generator = _load_generator_module()
    paths = generator.generate_fixture(
        tmp_path / "fixture",
        name="pTiny",
        length=1200,
        read_count=12,
        seed=5,
    )
    plasmid = parse_plasmid_map(str(paths.plasmid_map))

    state = BrowserState(None)
    state.add_supplemental_plasmid_reference(
        plasmid.name,
        plasmid.sequence,
        path=str(paths.plasmid_map),
        circular=True,
    )
    dataset = Dataset("fixture", str(paths.bam), "fixture", data_type="bam")
    dataset.available_layers = {"footprint": True, "nuc": True, "tf": True, "msp": True}
    dataset.has_circular_annotations = True
    state.datasets["fixture"] = dataset

    working_set = state.build_working_set(
        "fixture",
        "pTiny",
        1080,
        1320,
        spanning=False,
        include_layers=True,
        requested_layers=["nuc", "tf", "msp"],
        include_layer_qualities=True,
    )

    assert len(working_set.reads) == 12
    assert working_set.total_overlapping == 12
    assert working_set.total_spanning == 12
    assert len({read["id"] for read in working_set.reads}) == 12

    first_read = working_set.reads[0]
    tf_layer = first_read["layers"]["tf"]
    assert tf_layer["circular_ids"][:2] == ["phase0_origin_tf", "phase0_origin_tf"]
    assert tf_layer["annotation_names"][:2] == ["phase0_origin_tf", "phase0_origin_tf"]
    assert tf_layer["intervals"][:2] == [[86, 112, 26], [128, 154, 26]]

    payload = compact_reads_payload_for_request(
        state=state,
        chrom="pTiny",
        start=1080,
        end=1320,
        max_reads=3,
        dataset_id="fixture",
        include_layers=True,
        layer_names="nuc,tf,msp",
        include_layer_qualities=True,
        include_methylation=False,
        spanning=False,
    )

    assert payload["count"] == 3
    assert payload["total"] == 12
    assert payload["total_overlapping"] == 12
    assert payload["total_spanning"] == 12
    payload_first = payload["reads"][0]
    payload_tf_layer = payload_first["layers"]["tf"]
    assert payload_tf_layer["circular_ids"][:2] == ["phase0_origin_tf", "phase0_origin_tf"]
    assert payload_tf_layer["intervals"][:2] == [[86, 112, 26], [128, 154, 26]]
