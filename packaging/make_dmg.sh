#!/usr/bin/env bash
# Wrap dist/Texture Map Maker.app into a drag-to-Applications .dmg
set -euo pipefail
VERSION="${1:?version}"
ARCH="${2:-$(uname -m)}"
case "$ARCH" in arm64) LABEL="AppleSilicon";; x86_64) LABEL="Intel";; *) LABEL="$ARCH";; esac
APP="dist/Texture Map Maker.app"
OUT="dist/TextureMapMaker-${VERSION}-macOS-${LABEL}.dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/READ ME FIRST.txt" <<TXT
Texture Map Maker ${VERSION}

1. Drag "Texture Map Maker" onto the Applications folder.
2. Open it from Applications.

If macOS says it "cannot verify" the app the first time:
  System Settings > Privacy & Security > scroll down > "Open Anyway".
(Only needed once.)
TXT
rm -f "$OUT"
hdiutil create -volname "Texture Map Maker" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"
echo "$OUT"
