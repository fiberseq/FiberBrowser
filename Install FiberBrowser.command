#!/bin/zsh
# Double-click in Finder: one-time setup (scripts/install.sh), then start with
# "Launch Browser.command".

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1
/bin/bash "$SCRIPT_DIR/scripts/install.sh" "$@"
exit_status=$?
echo
read -r "?Press Return to close this window..."
exit "$exit_status"
