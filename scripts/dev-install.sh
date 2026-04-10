#!/usr/bin/env bash
#
# Build and link @akalforge/supaforge globally for local testing.
#
# Usage:
#   ./scripts/dev-install.sh          # Build + link (creates global `supaforge` command)
#   ./scripts/dev-install.sh --unlink # Remove global link
#
# After linking, `supaforge` is available everywhere and points at your local build.
# Re-run after code changes to pick up new changes (rebuilds automatically).
#
set -euo pipefail

CLI_DIR="$(cd "$(dirname "$0")/../packages/cli" && pwd)"

if [[ "${1:-}" == "--unlink" ]]; then
  echo "Unlinking @akalforge/supaforge..."
  cd "$CLI_DIR"
  npm unlink -g 2>/dev/null || true
  echo "✅ Global supaforge link removed."
  exit 0
fi

echo "Building @akalforge/supaforge..."
cd "$CLI_DIR"
npm run build

echo "Linking globally..."
npm link

echo ""
echo "✅ supaforge linked globally."
echo ""
echo "Verify:"
echo "  which supaforge"
echo "  supaforge --version"
echo ""
echo "Test commands:"
echo "  supaforge init"
echo "  supaforge scan --help"
echo "  supaforge snapshot --help"
echo ""
echo "After code changes, re-run this script or:"
echo "  cd packages/cli && npm run build"
