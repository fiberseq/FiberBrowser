"""Tests of the analysis pack (browser/lab/), included in the complete release suite."""
import os
import sys

# The lab tests import each other's fixtures and helpers by module name (test_accessibility_workflow).
# Appended, not prepended: this directory has a conftest.py too, and at the front of sys.path it would shadow
# tests/conftest.py for every later ``from conftest import ...`` (auth_headers) in the rest of the suite.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.append(_HERE)
