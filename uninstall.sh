#!/usr/bin/env bash
#
# Removes everything run.sh creates on this machine, for a clean-slate test.
# Does NOT touch node_modules unless --all is passed. Safe to re-run - a
# missing target is just reported and skipped.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$REPO_ROOT/.runtime"
APP_USER_DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/windows-eloquent"

TARGETS=("$RUNTIME_DIR" "$APP_USER_DATA_DIR")
if [ "${1:-}" = "--all" ]; then
  TARGETS+=("$REPO_ROOT/node_modules")
fi

echo "Windows Eloquent uninstall (WSL/Linux)"
echo "This will delete:"
for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then
    echo "  $t"
  else
    echo "  $t (not found - skipping)"
  fi
done
echo
read -rp "Press Enter to continue, Ctrl+C to abort..."

for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then
    rm -rf "$t"
    echo "Removed $t"
  fi
done

echo
echo "Done. Run ./run.sh for a fresh bootstrap."
