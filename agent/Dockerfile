FROM --platform=linux/amd64 node:20-slim

# Chrome dependencies + Xvfb for real Chrome (headed mode) + WireGuard for VPN output
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
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
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    wireguard-tools \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Set cache dir BEFORE npm ci so Puppeteer downloads Chrome to the right place
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN chmod +x /app/entrypoint.sh

# Default: connect to the host machine's server
ENV SERVER_URL=ws://host.docker.internal:3000/ws/agent

# Entrypoint starts Xvfb (virtual display) then runs CMD. Required for real Chrome (HEADLESS=false).
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "src/index.js"]
