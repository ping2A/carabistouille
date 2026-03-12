#!/bin/sh
# Baliverne container entrypoint: set env and run Supervisord (Xorg → PulseAudio → Openbox → node).
# Full Xorg with xorg.conf (dummy driver, modelines) like Neko: https://github.com/m1k1o/neko/tree/master/runtime

set -e

export DISPLAY="${NEKO_DESKTOP_DISPLAY:-:99}"
export PULSE_SERVER="${PULSE_SERVER:-unix:/tmp/pulseaudio.socket}"

exec /usr/bin/supervisord -c /etc/baliverne/supervisord.conf
