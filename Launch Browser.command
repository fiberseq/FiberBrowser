#!/bin/zsh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Picks a Python 3.10+ that has FiberBrowser's packages (native arm64 first on
# Apple Silicon); FIBERBROWSER_PYTHON=/path/to/python overrides.
. "$SCRIPT_DIR/scripts/pick_python.sh"

if ! pick_python; then
  no_python_help
  echo
  read -r "?Press Return to close this window..."
  exit 1
fi

echo "Starting FiberBrowser from:"
echo "  $SCRIPT_DIR"
echo "with:"
describe_python
echo
echo "Your web browser opens FiberBrowser's access link (http://localhost:<port>/?token=...)."
echo "To open it again, or in another browser, use the link printed below."
echo
"$PYTHON_BIN" browser.py "$@"
exit_status=$?

if [ "$exit_status" -ne 0 ]; then
  echo
  echo "FiberBrowser exited with status $exit_status."
  echo "To check the install: \"$PYTHON_BIN\" browser.py --copilot-doctor"
  echo "To use another environment, set FIBERBROWSER_PYTHON=/path/to/python."
  echo
  read -r "?Press Return to close this window..."
fi

exit "$exit_status"
