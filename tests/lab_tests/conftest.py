"""Tests of the analysis pack (browser/lab/), included in the complete release suite."""
import os
import sys

# The lab tests import each other's fixtures and helpers by module name (test_accessibility_workflow).
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
