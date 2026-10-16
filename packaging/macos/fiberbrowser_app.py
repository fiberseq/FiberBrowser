"""The Mac app's executable (PyInstaller entry script); see fiberbrowser/frozen_entry.py."""
import sys

from fiberbrowser.frozen_entry import run

if __name__ == "__main__":
    sys.exit(run())
