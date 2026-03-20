#!/bin/sh
# Run Lightpanda CDP server in background, then the Node agent (connects to ws://127.0.0.1:9222).
set -e
/app/lightpanda serve --host 0.0.0.0 --port 9222 &
# Give Lightpanda a moment to bind
sleep 2
exec "$@"
