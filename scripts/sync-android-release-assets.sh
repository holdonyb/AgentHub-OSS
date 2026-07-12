#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="holdonyb/AgentHub-OSS"
TAG="v1.0.0"
DESTINATION="/opt/agenthub/data/downloads"
ASSETS=(
  "agenthub-android-release.apk"
  "agenthub-native-android-release.apk"
  "SHA256SUMS"
)
APKS=(
  "agenthub-android-release.apk"
  "agenthub-native-android-release.apk"
)

usage() {
  cat <<'EOF'
Usage: sync-android-release-assets.sh [options]

Options:
  --repository OWNER/REPOSITORY  GitHub repository (default: holdonyb/AgentHub-OSS)
  --tag TAG                      Release tag (default: v1.0.0)
  --destination PATH             Download directory (default: /opt/agenthub/data/downloads)
  -h, --help                     Show this help
EOF
}

while (($#)); do
  case "$1" in
    --repository)
      REPOSITORY="${2:?missing value for --repository}"
      shift 2
      ;;
    --tag)
      TAG="${2:?missing value for --tag}"
      shift 2
      ;;
    --destination)
      DESTINATION="${2:?missing value for --destination}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command_name in curl sha256sum awk mktemp mv; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 1
  fi
done

mkdir -p "$DESTINATION"
STAGING_DIR="$(mktemp -d "$DESTINATION/.agenthub-android-release.XXXXXX")"

cleanup() {
  if [[ -n "${STAGING_DIR:-}" && -d "$STAGING_DIR" ]]; then
    rm -rf -- "$STAGING_DIR"
  fi
}
trap cleanup EXIT

release_url="https://github.com/${REPOSITORY}/releases/download/${TAG}"
for asset in "${ASSETS[@]}"; do
  curl --fail --location --retry 3 --output "$STAGING_DIR/$asset" "$release_url/$asset"
done

verification_file="$STAGING_DIR/android-apk-SHA256SUMS"
: > "$verification_file"
for apk in "${APKS[@]}"; do
  checksum="$({
    awk -v target="$apk" '
      {
        filename = $2
        sub(/^\*/, "", filename)
        sub(/\r$/, "", filename)
        if (filename == target) {
          print $1
        }
      }
    ' "$STAGING_DIR/SHA256SUMS"
  })"
  checksum_count="$(printf '%s\n' "$checksum" | awk 'NF { count += 1 } END { print count + 0 }')"
  if [[ "$checksum_count" != "1" ]]; then
    printf 'Expected exactly one checksum for %s, found %s\n' "$apk" "$checksum_count" >&2
    exit 1
  fi
  printf '%s  %s\n' "$checksum" "$apk" >> "$verification_file"
done

(
  cd "$STAGING_DIR"
  sha256sum -c "$(basename "$verification_file")"
)
rm -f -- "$verification_file"
chmod 0644 "${ASSETS[@]/#/$STAGING_DIR/}"

for asset in "${ASSETS[@]}"; do
  mv -f -- "$STAGING_DIR/$asset" "$DESTINATION/$asset"
done

printf 'Synced Android release assets from %s@%s to %s\n' "$REPOSITORY" "$TAG" "$DESTINATION"
