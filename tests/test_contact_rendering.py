import numpy as np

from services.contact_rendering import (
    apply_colormap,
    render_contact_matrix_image,
    render_matrix_strip_image,
)


def test_apply_colormap_returns_rgb_uint8():
    normalized = np.array([[0.0, 0.5, 1.0]], dtype=float)

    rgb = apply_colormap(normalized, "fall")

    assert rgb.shape == (1, 3, 3)
    assert rgb.dtype == np.uint8


def test_render_contact_matrix_image_resizes_to_target_size():
    matrix = np.eye(4, dtype=float)

    img = render_contact_matrix_image(matrix, target_size=8, scaling="linear", colormap="red")

    assert img.size == (8, 8)


def test_render_matrix_strip_image_uses_requested_dimensions():
    strip = np.ones((5, 10), dtype=float)

    img = render_matrix_strip_image(strip, width=20, height=6, scaling="linear", colormap="blues")

    assert img.size == (20, 6)
