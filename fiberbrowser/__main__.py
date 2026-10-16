"""``python -m fiberbrowser [options]``: same as the ``fiberbrowser`` command."""
import sys

from fiberbrowser.cli import main

if __name__ == "__main__":
    sys.exit(main())
