#!/bin/sh
set -e

# Run the Rust server in the background from /app (serves UI from ./web, DB from DATABASE_PATH)
cd /app && /usr/local/bin/carabistouille &
SERVER_PID=$!

# Give the server a moment to bind
sleep 2

# Run the Node agent (connects to server via SERVER_URL)
cd /app/agent && exec node src/index.js &
AGENT_PID=$!

# Wait for either process to exit (e.g. SIGTERM from docker stop)
wait -n 2>/dev/null || true
EXIT_CODE=$?

# Clean up: kill both so the container exits
kill $SERVER_PID $AGENT_PID 2>/dev/null || true
exit ${EXIT_CODE:-0}
