#!/usr/bin/env bash
# Rebuild the Chrome Docker image from scratch: stop/remove Chrome containers,
# remove the Chrome (and base) images, then rebuild base and Chrome for linux/amd64.
# Run from repo root.

set -e
cd "$(dirname "$0")/.."

IMAGE_CHROME="${BALIVERNE_CHROME_IMAGE:-baliverne-chrome:latest}"
IMAGE_BASE="${BALIVERNE_BASE_IMAGE:-baliverne-base:latest}"

echo "Stopping and removing containers using ${IMAGE_CHROME}…"
ids=$(docker ps -a -q --filter "ancestor=${IMAGE_CHROME}" 2>/dev/null) || true
if [ -n "$ids" ]; then
  echo "$ids" | xargs docker rm -f
fi

echo "Removing Chrome image ${IMAGE_CHROME}…"
docker rmi -f "${IMAGE_CHROME}" 2>/dev/null || true

echo "Removing base image ${IMAGE_BASE}…"
docker rmi -f "${IMAGE_BASE}" 2>/dev/null || true

echo "Building base (linux/amd64)…"
docker build --platform=linux/amd64 -f docker/base/Dockerfile -t "${IMAGE_BASE}" .

echo "Building Chrome (linux/amd64)…"
docker build --platform=linux/amd64 -f docker/chrome/Dockerfile -t "${IMAGE_CHROME}" .

echo "Done. Chrome image: ${IMAGE_CHROME}"
