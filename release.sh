#!/usr/bin/env bash
set -euo pipefail

# release.sh
# Usage: ./release.sh v1.2.2
# Requirements: git, gh (GitHub CLI), zip, unzip, curl, jq (optional but recommended)

# CONFIG
REPO="junglej1m/jimflix"
ZIP_NAME="tflix-engine.zip"
ASSET_NAME="$ZIP_NAME"
TMP_DL="/tmp/${ZIP_NAME}"
MANIFEST="manifest.json"
FILES_TO_ZIP=("manifest.json" "TFlixEngine.js" "icon.png")

# Helpers
err() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "INFO: $*"; }

if [ $# -ne 1 ]; then
  err "Usage: $0 <tag>  e.g. $0 v1.2.2"
fi

TAG="$1"

# Check tools
for cmd in git gh zip unzip curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "Required command not found: $cmd. Install it and retry."
  fi
done

# Optional: jq for nicer JSON parsing (not strictly required)
if ! command -v jq >/dev/null 2>&1; then
  info "Warning jq not found. Script will still run but output parsing is less pretty."
fi

# Ensure we are in repo root and files exist
if [ ! -f "$MANIFEST" ]; then
  err "manifest.json not found in current directory. Run from project root."
fi

for f in "${FILES_TO_ZIP[@]}"; do
  if [ ! -f "$f" ]; then
    err "Required file missing: $f"
  fi
done

# Ensure git working tree is clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Uncommitted changes detected. Staging and committing them now."
  git add .
  git commit -m "Prepare release $TAG"
else
  info "Git working tree clean."
fi

# Push branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
info "Pushing branch $CURRENT_BRANCH to origin"
git push origin "$CURRENT_BRANCH"

# Create tag if it doesn't exist, then push tag
if git rev-parse "$TAG" >/dev/null 2>&1; then
  info "Tag $TAG already exists locally."
else
  info "Creating tag $TAG"
  git tag -a "$TAG" -m "Release $TAG"
fi
info "Pushing tag $TAG to origin"
git push origin "$TAG"

# Build flat zip
info "Building flat ZIP $ZIP_NAME with top-level files: ${FILES_TO_ZIP[*]}"
rm -f "$ZIP_NAME" "$TMP_DL"
zip -r "$ZIP_NAME" "${FILES_TO_ZIP[@]}" >/dev/null

# Quick sanity: list zip contents
info "Local ZIP contents:"
unzip -l "$ZIP_NAME" | sed -n '4,12p'

# Create or update GitHub release and upload asset
# Check if release exists
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  info "Release $TAG exists. Uploading asset and clobbering if necessary."
  gh release upload "$TAG" "$ZIP_NAME" --repo "$REPO" --clobber
else
  info "Creating release $TAG and uploading asset."
  gh release create "$TAG" "$ZIP_NAME" --repo "$REPO" --title "$TAG" --notes "Release $TAG - flat zip asset for TizenBrew"
fi

# Construct asset URL (explicit tag)
ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}"
info "Asset URL: $ASSET_URL"

# Download the asset exactly as TizenBrew would and verify it's flat
info "Downloading asset to $TMP_DL for verification"
curl -L -o "$TMP_DL" "$ASSET_URL"

if [ ! -f "$TMP_DL" ]; then
  err "Failed to download asset from $ASSET_URL"
fi

info "Listing downloaded ZIP contents:"
unzip -l "$TMP_DL"

# Check for parent folder by searching for pattern like somefolder/manifest.json
if unzip -l "$TMP_DL" | awk '{print $4}' | grep -E '^[^/]+/manifest.json$' >/dev/null 2>&1; then
  err "Verification failed: downloaded ZIP contains a parent folder. Rebuild the ZIP so manifest.json is at the top level and reupload."
fi

# Confirm manifest exists at top level
if unzip -l "$TMP_DL" | awk '{print $4}' | grep -E '^manifest.json$' >/dev/null 2>&1; then
  info "Verification passed: manifest.json is at the top level of the release asset."
else
  err "Verification failed: manifest.json not found at top level of the release asset."
fi

# Optional: show manifest name and version for quick confirmation
if command -v jq >/dev/null 2>&1; then
  MAN_NAME=$(unzip -p "$TMP_DL" manifest.json | jq -r '.name // "N/A"')
  MAN_VER=$(unzip -p "$TMP_DL" manifest.json | jq -r '.version // "N/A"')
  info "Manifest name: $MAN_NAME"
  info "Manifest version: $MAN_VER"
fi

info "Release $TAG uploaded and verified successfully."

cat <<EOF

NEXT STEPS (on your TV)
1) Remove the old module in TizenBrew:
   TizenBrew -> Extensions -> select the installed module (if shown as TFlix Engine) -> Delete / Remove

2) Restart TizenBrew or reboot the TV to clear caches.

3) Install the module from GitHub:
   In TizenBrew choose Install from GitHub and enter:
     ${REPO}

4) Confirm in TizenBrew that the module shows the manifest name (e.g., JimFlix) and the correct version.

If anything still shows the old name, re-run this script, double-check the asset URL:
  ${ASSET_URL}
and re-run the verification step:
  curl -L -o /tmp/download.zip "${ASSET_URL}"
  unzip -l /tmp/download.zip

EOF

exit 0
