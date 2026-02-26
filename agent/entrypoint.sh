#!/bin/sh
# Start Xvfb so Chrome can run in headed mode (real Chrome) when HEADLESS=false.
# Harmless when headless: Chrome simply doesn't use the display.
set -e
Xvfb :99 -screen 0 1280x800x24 -ac &
export DISPLAY=:99
exec "$@"
