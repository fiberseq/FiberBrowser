import importlib.util
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "motif_logo_to_pwm.py"
SPEC = importlib.util.spec_from_file_location("motif_logo_to_pwm", SCRIPT_PATH)
motif_logo_to_pwm = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = motif_logo_to_pwm
SPEC.loader.exec_module(motif_logo_to_pwm)


def test_normalize_pwm_and_jaspar_format():
    pwm = motif_logo_to_pwm.normalize_pwm({
        "A": [2, 0],
        "C": [1, 1],
        "G": [1, 1],
        "T": [0, 2],
    })

    assert pwm["A"] == [0.5, 0.0]
    assert pwm["T"] == [0.0, 0.5]

    text = motif_logo_to_pwm.format_jaspar(
        [motif_logo_to_pwm.Motif(name="Recovered", pwm=pwm)],
        counts_scale=100,
    )
    assert text.startswith(">Recovered\n")
    assert "A [ 50 0 ]" in text
    assert "T [ 0 50 ]" in text


def test_normalize_pwm_rejects_mismatched_lengths():
    with pytest.raises(ValueError, match="identical lengths"):
        motif_logo_to_pwm.normalize_pwm({
            "A": [1, 0],
            "C": [0],
            "G": [0],
            "T": [0],
        })


def test_color_extractor_recovers_synthetic_logo_rectangles():
    image = Image.new("RGB", (72, 70), "white")
    draw = ImageDraw.Draw(image)
    colors = motif_logo_to_pwm.DEFAULT_BASE_COLORS

    # Column 1: A=.6, C=.2, T=.2.
    draw.rectangle((8, 10, 27, 39), fill=colors["A"])
    draw.rectangle((8, 40, 27, 49), fill=colors["C"])
    draw.rectangle((8, 50, 27, 59), fill=colors["T"])

    # Column 2: A=.5, G=.5.
    draw.rectangle((40, 10, 59, 34), fill=colors["A"])
    draw.rectangle((40, 35, 59, 59), fill=colors["G"])

    motif = motif_logo_to_pwm.extract_pwm_color(image, positions=2)

    assert motif.pwm["A"][0] == pytest.approx(0.6, abs=0.03)
    assert motif.pwm["C"][0] == pytest.approx(0.2, abs=0.03)
    assert motif.pwm["T"][0] == pytest.approx(0.2, abs=0.03)
    assert motif.pwm["G"][0] == pytest.approx(0.0, abs=0.02)
    assert motif.pwm["A"][1] == pytest.approx(0.5, abs=0.03)
    assert motif.pwm["G"][1] == pytest.approx(0.5, abs=0.03)


def test_extract_json_object_handles_fenced_llm_response():
    parsed = motif_logo_to_pwm._extract_json_object(
        '```json\n{"motifs":[{"name":"x","pwm":{"A":[1],"C":[0],"G":[0],"T":[0]}}]}\n```'
    )
    assert parsed["motifs"][0]["name"] == "x"
