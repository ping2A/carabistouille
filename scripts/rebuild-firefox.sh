#!/usr/bin/env bash
# Rebuild the Firefox Docker image from scratch: stop/remove Firefox containers,
# remove the Firefox (and base) images, then rebuild base and Firefox.
# Run from repo root.
# Firefox supports linux/amd64 and linux/arm64 (and armhf with firefox-esr); default build uses linux/amd64 like Chrome.

set -e
cd "$(dirname "$0")/.."

IMAGE_FIREFOX="${BALIVERNE_FIREFOX_IMAGE:-baliverne-firefox:latest}"
IMAGE_BASE="${BALIVERNE_BASE_IMAGE:-baliverne-base:latest}"

echo "Stopping and removing containers using ${IMAGE_FIREFOX}…"
ids=$(docker ps -a -q --filter "ancestor=${IMAGE_FIREFOX}" 2>/dev/null) || true
if [ -n "$ids" ]; then
  echo "$ids" | xargs docker rm -f
fi

echo "Removing Firefox image ${IMAGE_FIREFOX}…"
docker rmi -f "${IMAGE_FIREFOX}" 2>/dev/null || true

echo "Removing base image ${IMAGE_BASE}…"
docker rmi -f "${IMAGE_BASE}" 2>/dev/null || true

echo "Building base (linux/amd64)…"
docker build --platform=linux/amd64 -f docker/base/Dockerfile -t "${IMAGE_BASE}" .

echo "Building Firefox (linux/amd64)…"
docker build --platform=linux/amd64 -f docker/firefox/Dockerfile -t "${IMAGE_FIREFOX}" .

echo "Done. Firefox image: ${IMAGE_FIREFOX}"
