# Baliverne Firefox runtime: real Firefox on X11 (Neko-style).
# See https://github.com/m1k1o/neko/tree/master/apps/firefox
# Build from repo root: docker build -f docker/firefox/Dockerfile -t baliverne-firefox .
# Build base first: docker build -f docker/base/Dockerfile -t baliverne-base .
ARG BASE_IMAGE=baliverne-base:latest
FROM $BASE_IMAGE

# Install Firefox (Mozilla tarball for amd64/arm64, firefox-esr for armhf), GStreamer (capture), xdotool (input).
# Build xf86-input-neko from local docker/xorg-deps (Neko-style touch/pointer input over socket).
COPY docker/firefox/policies.json /tmp/policies.json
COPY docker/xorg-deps/xf86-input-neko /tmp/xf86-input-neko
RUN set -eux; apt-get update; \
    apt-get install -y --no-install-recommends \
        wget xz-utils libgtk-3-0 libdbus-glib-1-2 \
        xdotool build-essential autoconf automake libtool pkg-config xserver-xorg-dev xutils-dev \
        gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly; \
    ARCH=$(dpkg --print-architecture); \
    if [ "${ARCH}" = "armhf" ]; then \
        apt-get install -y --no-install-recommends firefox-esr; \
        ln -sf /usr/lib/firefox-esr /usr/lib/firefox 2>/dev/null || true; \
    else \
        if [ "${ARCH}" = "amd64" ]; then SRC_URL="https://download.mozilla.org/?product=firefox-latest&os=linux64&lang=en-US"; \
        elif [ "${ARCH}" = "arm64" ]; then SRC_URL="https://download.mozilla.org/?product=firefox-latest&os=linux64-aarch64&lang=en-US"; \
        else echo "Unsupported architecture: ${ARCH}"; exit 1; fi; \
        wget -q -O /tmp/firefox.tar.xz "${SRC_URL}"; \
        tar -xf /tmp/firefox.tar.xz -C /usr/lib; \
        rm -f /tmp/firefox.tar.xz; \
        ln -sf /usr/lib/firefox/firefox /usr/bin/firefox; \
        apt-get purge -y xz-utils 2>/dev/null || true; \
    fi; \
    mkdir -p /usr/lib/firefox/distribution; \
    cp /tmp/policies.json /usr/lib/firefox/distribution/; \
    rm -f /tmp/policies.json; \
    mkdir -p /app/.mozilla/firefox/profile.default; \
    (cd /tmp/xf86-input-neko && ./autogen.sh && ./configure --prefix=/usr && make -j$(nproc) && make install); \
    rm -rf /tmp/xf86-input-neko; \
    apt-get purge -y build-essential autoconf automake libtool pkg-config xserver-xorg-dev xutils-dev 2>/dev/null || true; \
    apt-get autoremove -y; \
    apt-get clean -y; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*

COPY docker/firefox/profiles.ini /app/.mozilla/firefox/profiles.ini

ENV HOME=/app
WORKDIR /app

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

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
