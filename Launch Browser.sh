#!/usr/bin/env sh

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Picks a Python 3.10+ that has FiberBrowser's packages (native arm64 first on
# Apple Silicon); FIBERBROWSER_PYTHON=/path/to/python overrides.
. "$SCRIPT_DIR/scripts/pick_python.sh"

if ! pick_python; then
  no_python_help
  exit 1
fi

echo "Starting FiberBrowser with:"
describe_python
echo "FiberBrowser opens its access link (http://localhost:<port>/?token=...) in your web browser;"
echo "to open it again, use the link printed below."
exec "$PYTHON_BIN" browser.py "$@"
