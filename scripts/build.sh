#!/usr/bin/env bash
# Build the HA Voice IPK for installation via ares-install or Homebrew Channel.
#
# Usage:
#   bash scripts/build.sh
#
# Output:
#   com.homebrew.havoice_<version>_all.ipk (in project root)
#
# Requires:
#   ares-cli   →  npm install -g @webos-tools/cli
#   esbuild    →  npm install -g esbuild
#   ImageMagick (for icon generation if assets/ is empty)

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"

APP_ID="com.homebrew.havoice"
DIST="dist"

# The release workflow writes VERSION to GITHUB_ENV for later steps, but its
# same-step Node process cannot see that value. Stamp it again here before
# packaging so tagged builds carry the tag version instead of defaulting to
# 1.0.0.
if [ -n "${GITHUB_REF_NAME:-}" ]; then
  VERSION="${GITHUB_REF_NAME#v}"
  VERSION="$VERSION" node -e "
    const fs = require('fs');
    const info = JSON.parse(fs.readFileSync('appinfo.json', 'utf8'));
    info.version = process.env.VERSION;
    fs.writeFileSync('appinfo.json', JSON.stringify(info, null, 2) + '\n');
  "
fi

# ── Icons ─────────────────────────────────────────────────────────────────────
if [ ! -f assets/icon.png ] || [ ! -f assets/icon-large.png ]; then
  echo "==> Generating placeholder icons (replace assets/*.png with real artwork)"
  bash scripts/generate-icons.sh
fi

if [ ! -f assets/splash.png ]; then
  echo "==> Generating splash screen"
  convert -size 1920x1080 xc:'#1a1a2e' assets/splash.png
fi

# ── Assemble dist/ ────────────────────────────────────────────────────────────
echo "==> Assembling $DIST/"
rm -rf "$DIST"
mkdir -p "$DIST/services"

# Bundle frontend JS (esbuild handles private class fields and tree-shakes)
# Target: es2019 = Chromium 76+, supported by webOS 4+ (Chromium 79)
echo "==> Bundling JS..."
npx --yes esbuild src/main.js \
  --bundle \
  --minify \
  --target=chrome58 \
  --outfile="$DIST/bundle.js"

# App files (src/ is replaced by bundle.js)
cp appinfo.json index.html "$DIST/"
cp -r styles assets "$DIST/"

# Service files – become /services/ inside the IPK
# Bundle service JS: webos-service is external (TV provides it at runtime)
# webOS 4 ships Node.js 0.12.2 – target ES5 to avoid template literals and ES6
npx --yes esbuild service/index.js \
  --bundle \
  --minify \
  --platform=node \
  --target=es5 \
  --external:webos-service \
  --outfile="$DIST/services/index.js"

cp service/package.json  "$DIST/services/"
cp service/services.json "$DIST/services/"
cp service/run-js-service "$DIST/services/"
cp service/setup.sh      "$DIST/services/"

# ── Package ───────────────────────────────────────────────────────────────────
echo "==> Running ares-package..."
npx ares-package "$DIST" --outdir .

IPK=$(find . -maxdepth 1 -name "${APP_ID}_*.ipk" 2>/dev/null | sort -V | tail -1)
echo ""
echo "==> Built: $IPK"
echo ""
echo "Install on TV:"
echo "  ares-install --device <your-tv> $IPK"
echo ""
echo "After install, run setup once via SSH (as root):"
echo "  sh /media/developer/apps/usr/palm/applications/${APP_ID}/services/setup.sh"
