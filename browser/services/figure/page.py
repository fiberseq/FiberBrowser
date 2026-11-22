"""Print output for scripted figures: physical page size, fit, minimum text size, raster resolution, PDF fonts.

The figure is laid out in CSS pixels as always (1 px = 0.75 pt at natural size). With ``page_size`` the
finished drawing is scaled onto a page of exactly that size:

    contain  uniform scale so the whole figure fits; top-left aligned; the rest of the page stays white
    width    uniform scale to the page width; the page height becomes the figure's height at that scale
    height   uniform scale to the page height; the page width follows
    stretch  separate horizontal and vertical scales: the figure fills the page exactly (distorts text)

A page side given as 0 (``"180mm"`` or ``"180x0mm"``) follows the figure's aspect ratio.

``min_font_pt`` raises every text label smaller than that many points *on the final page* (after the
scaling above) to that size. ``raster_dpi`` rasterises reads at that many pixels per inch of the final
page in PDF and SVG, and sets the PNG resolution (PNG default with a page size: 300 dpi). Without these
options, output is exactly as before.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

PX_TO_PT = 0.75
DEFAULT_PNG_DPI = 300.0


@dataclass
class PageGeometry:
    width_pt: float         # page size
    height_pt: float
    sx: float               # page pt per natural pt (CSS px * 0.75), horizontal / vertical
    sy: float
    fit: str

    @property
    def k(self) -> float:
        """The smaller of the two scales: what text sizes and raster resolution follow."""
        return min(self.sx, self.sy)


def page_geometry(width_px: float, height_px: float, size_pt: Optional[tuple], fit: str = "contain") -> PageGeometry:
    w0, h0 = width_px * PX_TO_PT, height_px * PX_TO_PT
    if not size_pt:
        return PageGeometry(w0, h0, 1.0, 1.0, "natural")
    W, H = size_pt
    if not W:
        fit = "height"
    elif not H:
        fit = "width"
    if fit == "width":
        k = W / w0
        return PageGeometry(W, h0 * k, k, k, fit)
    if fit == "height":
        k = H / h0
        return PageGeometry(w0 * k, H, k, k, fit)
    if fit == "stretch":
        return PageGeometry(W, H, W / w0, H / h0, fit)
    k = min(W / w0, H / h0)
    return PageGeometry(W, H, k, k, "contain")


def raster_scale(geom: PageGeometry, dpi: Optional[float]) -> Optional[float]:
    """Raster pixels per CSS px for ``dpi`` on the final page (None: unchanged)."""
    if not dpi:
        return None
    return PX_TO_PT * geom.k * float(dpi) / 72.0


def min_text_px(geom: PageGeometry, min_pt: Optional[float]) -> Optional[float]:
    if not min_pt:
        return None
    return float(min_pt) / (PX_TO_PT * geom.k)


# ---------------------------------------------------------------------------
# TrueType fonts to embed (pdf_fonts="truetype")
# ---------------------------------------------------------------------------

# Helvetica-metric fonts first (Arial, Liberation Sans): text keeps the widths the layout measured.
# FIBERBROWSER_FIGURE_FONT[_BOLD|_ITALIC|_BOLDITALIC|_MONO] name a .ttf to use instead.
_TTF_CANDIDATES = {
    "regular": ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
                "C:/Windows/Fonts/arial.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
                "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
                "/usr/share/fonts/truetype/msttcorefonts/Arial.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
                "/usr/share/fonts/dejavu/DejaVuSans.ttf", "mpl:DejaVuSans.ttf"],
    "bold": ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
             "C:/Windows/Fonts/arialbd.ttf",
             "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
             "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
             "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
             "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
             "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf", "mpl:DejaVuSans-Bold.ttf"],
    "italic": ["/System/Library/Fonts/Supplemental/Arial Italic.ttf", "/Library/Fonts/Arial Italic.ttf",
               "C:/Windows/Fonts/ariali.ttf",
               "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
               "/usr/share/fonts/truetype/liberation2/LiberationSans-Italic.ttf",
               "/usr/share/fonts/liberation-sans/LiberationSans-Italic.ttf",
               "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
               "/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf", "mpl:DejaVuSans-Oblique.ttf"],
    "bolditalic": ["/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf", "/Library/Fonts/Arial Bold Italic.ttf",
                   "C:/Windows/Fonts/arialbi.ttf",
                   "/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf",
                   "/usr/share/fonts/truetype/liberation2/LiberationSans-BoldItalic.ttf",
                   "/usr/share/fonts/liberation-sans/LiberationSans-BoldItalic.ttf",
                   "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf",
                   "/usr/share/fonts/TTF/DejaVuSans-BoldOblique.ttf", "mpl:DejaVuSans-BoldOblique.ttf"],
    "mono": ["/System/Library/Fonts/Supplemental/Courier New.ttf", "/Library/Fonts/Courier New.ttf",
             "C:/Windows/Fonts/cour.ttf",
             "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
             "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
             "/usr/share/fonts/liberation-mono/LiberationMono-Regular.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
             "mpl:DejaVuSansMono.ttf"],
}
_ENV = {"regular": "FIBERBROWSER_FIGURE_FONT", "bold": "FIBERBROWSER_FIGURE_FONT_BOLD",
        "italic": "FIBERBROWSER_FIGURE_FONT_ITALIC", "bolditalic": "FIBERBROWSER_FIGURE_FONT_BOLDITALIC",
        "mono": "FIBERBROWSER_FIGURE_FONT_MONO"}


def _resolve(candidate: str) -> Optional[str]:
    if candidate.startswith("mpl:"):
        try:
            import matplotlib
        except ImportError:
            return None
        candidate = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf", candidate[4:])
    return candidate if os.path.isfile(candidate) and candidate.lower().endswith(".ttf") else None


def truetype_font(kind: str) -> str:
    """Path of the .ttf to embed for ``kind`` (regular, bold, italic, bolditalic, mono)."""
    env = os.environ.get(_ENV[kind], "").strip()
    if env:
        if not _resolve(env):
            raise ValueError(f"{_ENV[kind]}={env!r} is not a .ttf file")
        return env
    for candidate in _TTF_CANDIDATES[kind]:
        found = _resolve(candidate)
        if found:
            return found
    if kind != "regular":
        return truetype_font("regular")
    raise ValueError("pdf_fonts='truetype': no TrueType (.ttf) font found. Install Liberation Sans or DejaVu Sans "
                     "(or matplotlib), or set FIBERBROWSER_FIGURE_FONT to a .ttf file")
