# -----------------------------------------------------------------------------
# Stage 1: Build the Rust server binary
# -----------------------------------------------------------------------------
FROM rust:1-bookworm AS server-builder

WORKDIR /build

# Copy manifests and source
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Build release binary (cache-friendly: copy src after building deps if needed)
RUN cargo build --release

# -----------------------------------------------------------------------------
# Stage 2: Prepare the Node agent (dependencies + Chromium runtime)
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS agent-builder

WORKDIR /app/agent

# Skip Chromium download in npm; we use system Chromium in the final image
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install Chromium dependencies for Puppeteer (headless in Docker)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Agent depends on Puppeteer and ws
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --omit=dev

COPY agent ./

# -----------------------------------------------------------------------------
# Stage 3: Final image — server binary + agent + web UI
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim

# Chromium runtime dependencies + Xvfb for real (headed) Chrome + WireGuard for VPN output
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    wireguard-tools \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Use system Chromium with Puppeteer (skip download, smaller image)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy server binary from Rust build
COPY --from=server-builder /build/target/release/carabistouille /usr/local/bin/carabistouille

# Copy agent (with node_modules from agent-builder)
COPY --from=agent-builder /app/agent /app/agent

# Copy web UI
COPY web /app/web

# Server and agent run in same container; agent connects to localhost
ENV PORT=3000
ENV SERVER_URL=ws://127.0.0.1:3000/ws/agent
ENV DATABASE_PATH=/data/carabistouille.db

# Persist SQLite DB and optional TLS certs
VOLUME ["/data"]

# Entrypoint: start server in background, then agent; exit when either exits
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
