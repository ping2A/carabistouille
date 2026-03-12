#!/usr/bin/env bash
# Build the Baliverne agent Docker images (base, Chrome, Firefox).
# Use this for first-time build or after code changes. Does not remove existing containers/images.
# For a clean rebuild, use scripts/rebuild-chrome.sh and/or scripts/rebuild-firefox.sh instead.
# Run from repo root.
#
# Usage:
#   ./scripts/build-baliverne.sh           # build base + chrome + firefox (linux/amd64)
#   ./scripts/build-baliverne.sh chrome     # build base + chrome only
#   ./scripts/build-baliverne.sh firefox    # build base + firefox only
#   ./scripts/build-baliverne.sh base       # build base only
#
# Optional: BALIVERNE_BASE_IMAGE, BALIVERNE_CHROME_IMAGE, BALIVERNE_FIREFOX_IMAGE, PLATFORM (e.g. linux/arm64)

set -e
cd "$(dirname "$0")/.."

PLATFORM="${PLATFORM:-linux/amd64}"
IMAGE_BASE="${BALIVERNE_BASE_IMAGE:-baliverne-base:latest}"
IMAGE_CHROME="${BALIVERNE_CHROME_IMAGE:-baliverne-chrome:latest}"
IMAGE_FIREFOX="${BALIVERNE_FIREFOX_IMAGE:-baliverne-firefox:latest}"

build_base() {
  echo "Building base (${PLATFORM})…"
  docker build --platform="${PLATFORM}" -f docker/base/Dockerfile -t "${IMAGE_BASE}" .
}

build_chrome() {
  build_base
  echo "Building Chrome (${PLATFORM})…"
  docker build --platform="${PLATFORM}" -f docker/chrome/Dockerfile -t "${IMAGE_CHROME}" .
  echo "Done. Chrome image: ${IMAGE_CHROME}"
}

build_firefox() {
  build_base
  echo "Building Firefox (${PLATFORM})…"
  docker build --platform="${PLATFORM}" -f docker/firefox/Dockerfile -t "${IMAGE_FIREFOX}" .
  echo "Done. Firefox image: ${IMAGE_FIREFOX}"
}

case "${1:-all}" in
  base)
    build_base
    echo "Done. Base image: ${IMAGE_BASE}"
    ;;
  chrome)
    build_chrome
    ;;
  firefox)
    build_firefox
    ;;
  all)
    build_base
    echo "Building Chrome (${PLATFORM})…"
    docker build --platform="${PLATFORM}" -f docker/chrome/Dockerfile -t "${IMAGE_CHROME}" .
    echo "Building Firefox (${PLATFORM})…"
    docker build --platform="${PLATFORM}" -f docker/firefox/Dockerfile -t "${IMAGE_FIREFOX}" .
    echo "Done. Base: ${IMAGE_BASE}, Chrome: ${IMAGE_CHROME}, Firefox: ${IMAGE_FIREFOX}"
    ;;
  *)
    echo "Usage: $0 [base|chrome|firefox|all]" >&2
    exit 1
    ;;
esac
