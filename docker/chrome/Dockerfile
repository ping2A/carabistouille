# Baliverne Chrome runtime: Google Chrome + Puppeteer, connects to Baliverne server.
# Like Neko's app layer: https://github.com/m1k1o/neko/blob/master/apps/google-chrome/Dockerfile
# Build from repo root. Chrome needs amd64 (Google .deb); build base for that platform first:
#   docker build --platform=linux/amd64 -f docker/base/Dockerfile -t baliverne-base:latest .
#   docker build --platform=linux/amd64 -f docker/chrome/Dockerfile -t baliverne-chrome:latest .
ARG BASE_IMAGE=baliverne-base:latest
ARG TARGETPLATFORM=linux/amd64

# Stage: build xtest-injector (Rust XTest-based input injector; one process / one X connection).
FROM --platform=$TARGETPLATFORM rust:1-bookworm AS xtest-builder
WORKDIR /build
RUN echo '[workspace]\nmembers = ["xtest-injector"]' > Cargo.toml
COPY xtest-injector ./xtest-injector
RUN cargo build -p xtest-injector --release

FROM --platform=$TARGETPLATFORM $BASE_IMAGE

ARG SRC_URL="https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"

# Copy xtest-injector from builder (XTest-based input when Neko socket unavailable).
COPY --from=xtest-builder /build/target/release/xtest-injector /usr/local/bin/xtest-injector

# Install Google Chrome + GStreamer (Neko-style: VP8 + H264 like Neko capture) + xdotool for input.
# Build and install xf86-input-neko from local docker/xorg-deps for Neko-style touch/pointer input.
COPY docker/xorg-deps/xf86-input-neko /tmp/xf86-input-neko
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates wget xdotool build-essential autoconf automake libtool pkg-config \
        xserver-xorg-dev xutils-dev \
        gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly; \
    update-ca-certificates; \
    wget -O /tmp/google-chrome.deb "${SRC_URL}"; \
    apt-get install -y --no-install-recommends /tmp/google-chrome.deb; \
    rm /tmp/google-chrome.deb; \
    (cd /tmp/xf86-input-neko && ./autogen.sh && ./configure --prefix=/usr && make -j$(nproc) && make install); \
    rm -rf /tmp/xf86-input-neko; \
    apt-get purge -y build-essential autoconf automake libtool pkg-config xserver-xorg-dev xutils-dev 2>/dev/null || true; \
    apt-get autoremove -y; \
    apt-get clean -y; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

# Add Neko input device to Xorg config (driver installed above).
COPY docker/common/xorg-neko-input.conf /tmp/xorg-neko-input.conf
RUN sed -i '/Screen "dummy_screen"/a\    InputDevice "dummy_touchscreen" "CorePointer"' /etc/baliverne/xorg.conf && \
    cat /tmp/xorg-neko-input.conf >> /etc/baliverne/xorg.conf && rm /tmp/xorg-neko-input.conf

COPY runtime/package*.json ./
RUN npm ci --omit=dev

COPY runtime/*.js ./
COPY docker/common/entrypoint.sh /entrypoint.sh
COPY docker/common/supervisord.conf /etc/baliverne/supervisord.conf
RUN chmod +x /entrypoint.sh

ENV CHROME_USER_DATA_DIR=/data
VOLUME ["/data"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
