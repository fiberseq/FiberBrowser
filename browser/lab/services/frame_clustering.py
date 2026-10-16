"""Compatibility import for shared correspondence clustering."""
import sys
from services import correspondence_clustering
sys.modules[__name__] = correspondence_clustering
