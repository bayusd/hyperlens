#!/bin/bash
# Assemble dist/ from the repo sources and pack the .ehpk.
# Requires the Even Hub CLI (evenhub) on PATH, or pass its path:
#   EVENHUB=/path/to/evenhub-cli/main.js bash build-dist.sh
# (npm: npm i -g @evenrealities/evenhub-cli — then `evenhub` is on PATH.)
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/sdk
cp index.html app.js app.json icon.png dist/
cp sdk/even_hub_sdk.js sdk/LICENSE dist/sdk/
EH="${EVENHUB:-evenhub}"
if command -v node >/dev/null && [ -f "$EH" ]; then
  node "$EH" pack app.json dist -o hyperlens.ehpk
else
  "$EH" pack app.json dist -o hyperlens.ehpk
fi
echo "built hyperlens.ehpk"
