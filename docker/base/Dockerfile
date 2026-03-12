# Baliverne base image: Node + full Xorg (Neko's xf86-video-dummy with RandR) + Openbox + PulseAudio.
# Like Neko's runtime: https://github.com/m1k1o/neko/tree/master/runtime
# Video: build Neko's patched xf86-video-dummy from docker/xorg-deps (no distro package).
# Build from repo root: docker build -f docker/base/Dockerfile -t baliverne-base .
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Build and install Neko's xf86-video-dummy (v0.3.8 + RandR patch) from local docker/xorg-deps.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential autoconf automake libtool pkg-config \
        xserver-xorg-dev xutils-dev \
        ca-certificates \
        xserver-xorg-core \
        openbox pulseaudio supervisor; \
    rm -rf /var/lib/apt/lists/*

COPY docker/xorg-deps/xf86-video-dummy /tmp/xf86-video-dummy
RUN set -eux; \
    cd /tmp/xf86-video-dummy/v0.3.8; \
    patch -p1 < ../01_v0.3.8_xdummy-randr.patch; \
    autoreconf -v --install; \
    ./configure --prefix=/usr; \
    make -j$(nproc); \
    make install; \
    rm -rf /tmp/xf86-video-dummy; \
    apt-get purge -y build-essential autoconf automake libtool pkg-config xserver-xorg-dev xutils-dev 2>/dev/null || true; \
    apt-get autoremove -y; \
    apt-get clean -y; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*

RUN set -eux; \
    mkdir -p /etc/baliverne /tmp/.X11-unix /var/lib/openbox; \
    chmod 1777 /tmp/.X11-unix; \
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<openbox_menu xmlns="http://openbox.org/3.4/menu"/>' > /var/lib/openbox/debian-menu.xml

COPY docker/common/xorg.conf /etc/baliverne/xorg.conf
COPY docker/common/default.pa /etc/baliverne/default.pa

ENV DISPLAY=:99
ENV PULSE_SERVER=unix:/tmp/pulseaudio.socket
ENV BALIVERNE_VIDEO_DRIVER=neko-dummy
WORKDIR /app
