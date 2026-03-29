#!/bin/bash
# Run braid-fuzz tests against the VS Code extension.
# Usage:
#   ./run-fuzz.sh                 # run all tests
#   ./run-fuzz.sh simpleton       # run only simpleton tests
#   ./run-fuzz.sh everything      # run all tests (explicit)

set -e
cd "$(dirname "$0")"
npm run compile
node out/test/launch-fuzz.js "${1:-everything}"
