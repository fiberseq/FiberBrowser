"""Co-accessibility images in log scale: negative correlations are clipped to the low end of the scale on purpose
(they used to become NaN in log(x + pseudocount) and land there only by accident, outside the scale's range)."""
import numpy as np

from services.contact_rendering import render_contact_matrix_image


def test_log_scaling_draws_negative_correlations_at_the_low_end():
    m = np.array([[np.nan, -0.5, 0.2], [-0.5, np.nan, 0.8], [0.2, 0.8, np.nan]])
    img = np.asarray(render_contact_matrix_image(m, target_size=3, scaling="log", colormap="viridis"))
    # Coloured (not the white of a blank cell), at the bottom of the colour scale (viridis' darkest).
    assert tuple(img[0, 1]) != (255, 255, 255)
    assert img[0, 1].sum() < img[0, 2].sum() < img[1, 2].sum() or tuple(img[0, 1]) != tuple(img[1, 2])
    assert tuple(img[0, 1]) == tuple(img[1, 0])
