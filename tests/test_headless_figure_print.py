"""Print output of headless figures: page size, fit, minimum text size, raster resolution, embedded TrueType text."""
from __future__ import annotations

import io
import re
import zlib

import pytest

import headless_figure_data as hfd
from test_headless_figure_options import by_dataset, paths, render, state  # noqa: F401  (fixtures)

pypdf = pytest.importorskip("pypdf")
MM = 72 / 25.4


def _truetype_available():
    from services.figure.page import truetype_font
    try:
        truetype_font("regular")
        return True
    except ValueError:
        return False


def _content(data: bytes) -> str:
    reader = pypdf.PdfReader(io.BytesIO(data))
    return reader.pages[0].get_contents().get_data().decode("latin-1")


def test_page_size_is_exact_and_the_drawing_fits_it(state, paths):
    data, manifest = render(state, hfd.session(paths), page_size="180x120mm")
    page = pypdf.PdfReader(io.BytesIO(data)).pages[0]
    assert float(page.mediabox.width) == pytest.approx(180 * MM, abs=0.01)
    assert float(page.mediabox.height) == pytest.approx(120 * MM, abs=0.01)
    info = manifest["page"]
    assert info["fit"] == "contain" and info["scale_x"] == info["scale_y"]
    natural_w, natural_h = info["width_px"] * 0.75, info["height_px"] * 0.75
    k = min(180 * MM / natural_w, 120 * MM / natural_h)
    assert info["scale_x"] == pytest.approx(k)
    assert _content(data).startswith(f"q {k:.6f} 0 0 {k:.6f} 0 ")


@pytest.mark.parametrize("fit", ["width", "height", "stretch"])
def test_other_fits(state, paths, fit):
    data, manifest = render(state, hfd.session(paths), page_size=[180, 120, "mm"], page_fit=fit)
    box = pypdf.PdfReader(io.BytesIO(data)).pages[0].mediabox
    w0, h0 = manifest["page"]["width_px"] * 0.75, manifest["page"]["height_px"] * 0.75
    if fit == "width":
        assert float(box.width) == pytest.approx(180 * MM, abs=0.01)
        assert float(box.height) == pytest.approx(h0 * 180 * MM / w0, abs=0.01)
    elif fit == "height":
        assert float(box.height) == pytest.approx(120 * MM, abs=0.01)
    else:
        assert (float(box.width), float(box.height)) == (pytest.approx(180 * MM, abs=0.01), pytest.approx(120 * MM, abs=0.01))


def test_minimum_font_size_is_in_final_points(state, paths):
    data, manifest = render(state, hfd.session(paths), page_size="90mm", min_font_pt=6)
    k = manifest["page"]["scale_y"]
    sizes = [float(x) for x in re.findall(r" ([\d.]+) Tf", _content(data))]
    assert sizes and min(sizes) * k >= 6 - 0.01
    plain, m2 = render(state, hfd.session(paths), page_size="90mm")
    assert min(float(x) for x in re.findall(r" ([\d.]+) Tf", _content(plain))) * k < 6


def test_raster_dpi_sets_the_read_raster_resolution(state, paths):
    def image_widths(data):
        reader = pypdf.PdfReader(io.BytesIO(data))
        xobjects = reader.pages[0]["/Resources"]["/XObject"]
        return sorted(int(xobjects[name].get_object()["/Width"]) for name in xobjects)
    default, _m = render(state, hfd.session(paths))
    fine, manifest = render(state, hfd.session(paths), raster_dpi=288)
    # 1400 px wide panels: 2 px per CSS px by default; 288 dpi at natural size = 3 px per CSS px.
    assert max(image_widths(default)) == 2800
    assert max(image_widths(fine)) == 4200
    assert manifest["page"]["raster_dpi"] == 288


def test_png_follows_the_page_size_and_dpi(state, paths):
    from PIL import Image
    data, _m = render(state, hfd.session(paths), fmt="png", page_size="100x60mm", raster_dpi=200)
    img = Image.open(io.BytesIO(data))
    assert img.size == (round(100 / 25.4 * 200), round(60 / 25.4 * 200))
    assert img.info["dpi"][0] == pytest.approx(200, abs=0.5)


@pytest.mark.skipif(not _truetype_available(), reason="no TrueType font on this machine")
def test_truetype_text_is_embedded_and_extractable(state, paths):
    data, _m = render(state, hfd.session(paths), pdf_fonts="truetype", page_size="180x120mm")
    reader = pypdf.PdfReader(io.BytesIO(data))
    fonts = reader.pages[0]["/Resources"]["/Font"]
    assert fonts
    for name in fonts:
        font = fonts[name].get_object()
        assert font["/Subtype"] == "/TrueType"
        descriptor = font["/FontDescriptor"].get_object()
        assert "/FontFile2" in descriptor
        assert int(descriptor["/FontFile2"].get_object()["/Length1"]) > 10_000
    text = reader.pages[0].extract_text()
    assert "Sample A" in text and "Sample B" in text and "8,000" in text
    # Standard output keeps the base-14 fonts, unembedded.
    standard, _m2 = render(state, hfd.session(paths))
    fonts = pypdf.PdfReader(io.BytesIO(standard)).pages[0]["/Resources"]["/Font"]
    assert {fonts[n].get_object()["/Subtype"] for n in fonts} == {"/Type1"}


def test_svg_page_size(state, paths):
    data, _m = render(state, hfd.session(paths), fmt="svg", page_size="180x120mm")
    head = data[:400].decode()
    assert f'width="{180 * MM:.2f}pt"' in head and f'height="{120 * MM:.2f}pt"' in head


def test_bad_page_sizes_are_refused(state, paths):
    from test_headless_figure_options import render_error
    assert "page_size" in render_error(state, hfd.session(paths), page_size="big")
    assert "unit" in render_error(state, hfd.session(paths), page_size=[1, 2, "furlong"])


def test_a_png_page_canvas_is_held_to_the_pixel_limit(state, paths):
    """Release audit 3.1.1: page_size × raster_dpi made a PNG page canvas far past the pixel limit (200 x 1 in at
    2400 dpi: 480,000 x 2,400 px) after the drawing itself passed it; refused before anything is allocated."""
    import json
    from models.requests import RenderRequest
    from services.figure import api
    resp = api.render_request(RenderRequest(session=hfd.session(paths), load_session=True, source="session", format="png",
                                            engine="headless", page_size="200x1in", raster_dpi=2400), state, None)
    assert resp.status_code == 400
    assert "page too large" in json.loads(resp.body)["error"]
