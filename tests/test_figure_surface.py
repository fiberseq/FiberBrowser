import re
import zlib

import numpy as np

from services.figure.surface import make_surface, measure_text, parse_color


def _draw(fmt):
    s = make_surface(fmt, 200, 100)
    s.rect(10, 10, 50, 20, fill="#1d4ed8", opacity=0.5)
    s.save()
    s.clip_rect(0, 0, 100, 100)
    s.rect(80, 40, 60, 20, fill="#f59e0b", stroke="#000000")  # cut at x=100
    s.text(90, 80, "cut label", 10)
    s.restore()
    s.line(0, 90, 200, 90, "hsl(120 70% 50%)" if False else "#94a3b8", 1, dash=[3, 2])
    s.text(195, 20, "chr1 → 3'", 10, anchor="end")
    s.image(0, 95, 50, 5, np.full((1, 10, 4), 200, np.uint8))
    return s.to_bytes()


def test_svg_clips_geometry_instead_of_clip_paths():
    svg = _draw("svg").decode()
    assert "<clipPath" not in svg
    assert '<rect x="80" y="40" width="20" height="20" fill="#f59e0b"/>' in svg
    assert svg.count("<line") >= 4  # dashed line + three visible sides of the cut box


def test_pdf_is_a_valid_single_page_document():
    pdf = _draw("pdf")
    assert pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF")
    assert b"/MediaBox [0 0 150.00 75.00]" in pdf  # 1 px = 0.75 pt, like the browser's Export
    stream = re.search(rb"<< /Filter /FlateDecode /Length \d+ >>\nstream\n(.*?)\nendstream", pdf, re.S)
    assert b"(chr1 -> 3'" in zlib.decompress(stream.group(1))  # symbols spelled out for Helvetica


def test_png_scales_and_colors():
    png = make_surface("png", 20, 10, scale=2)
    png.rect(0, 0, 20, 10, fill="#ff0000")
    img = png.to_image()
    assert img.size == (40, 20) and img.getpixel((5, 5)) == (255, 0, 0)


def test_helpers():
    assert parse_color("rgba(1,2,3,0.5)") == (1, 2, 3, 0.5)
    assert parse_color("#abc")[:3] == (0xaa, 0xbb, 0xcc)
    assert parse_color("hsl(0 100% 50%)") == (255, 0, 0, 1.0)
    assert round(measure_text("Hi", 10), 2) == round((722 + 222) / 100, 2)
