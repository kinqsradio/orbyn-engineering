#!/bin/bash
# Fails unless a Developer ID build is really notarized. A ticket can lag behind the
# notary's answer, so stapling is retried. Ad-hoc builds have nothing to check.
# Usage: scripts/verify-macos-release.sh <app-or-dmg>...
set -euo pipefail

case "${APPLE_SIGNING_IDENTITY:-}" in
  "Developer ID"*) ;;
  *)
    echo "Not a Developer ID build: skipped."
    exit 0
    ;;
esac

for name in APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!name:-}" ]; then
    echo "A Developer ID build needs $name to notarize." >&2
    exit 1
  fi
done

for target in "$@"; do
  for attempt in 1 2 3 4 5; do
    if xcrun stapler staple "$target"; then
      break
    fi
    if [ "$attempt" = 5 ]; then
      echo "No ticket for $target." >&2
      exit 1
    fi
    sleep $((attempt * 30))
  done
  xcrun stapler validate "$target"
  case "$target" in
    *.dmg) spctl --assess --type open --context context:primary-signature --verbose "$target" ;;
    *) spctl --assess --type execute --verbose "$target" ;;
  esac
done
