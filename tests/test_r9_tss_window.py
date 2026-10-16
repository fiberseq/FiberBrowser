"""Round 9: TSS-relative windows are exactly width_bp bases, odd widths included."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))

from services import natural_language_commands as nlc


def _resolve(monkeypatch, strand="+", tss=1000):
    monkeypatch.setattr(nlc, "_resolve_gene", lambda state, q: {"chrom": "chr2R", "tss": tss, "strand": strand})


def test_odd_and_even_widths(monkeypatch):
    _resolve(monkeypatch)
    for width, (start, end) in {1: (1000, 1001), 81: (960, 1041), 80: (960, 1040)}.items():
        out, warnings = nlc._resolve_tss_relative(None, {"relative_to_gene": "eve", "offset_bp": 0, "width_bp": width})
        assert warnings == []
        assert (out["start"], out["end"]) == (start, end)
        assert out["end"] - out["start"] == width


def test_minus_strand_offset_and_contig_start(monkeypatch):
    _resolve(monkeypatch, strand="-", tss=1000)
    out, _ = nlc._resolve_tss_relative(None, {"relative_to_gene": "eve", "offset_bp": -100, "width_bp": 21})
    assert out["position"] == 1100
    assert (out["start"], out["end"]) == (1090, 1111)
    _resolve(monkeypatch, tss=5)
    out, _ = nlc._resolve_tss_relative(None, {"relative_to_gene": "eve", "offset_bp": 0, "width_bp": 81})
    assert (out["start"], out["end"]) == (0, 46)
