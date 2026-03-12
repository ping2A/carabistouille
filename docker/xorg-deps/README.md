# Xorg drivers (vendored from Neko)

This directory contains Neko’s Xorg driver sources, copied locally so Docker builds do not fetch from the network.

- **xf86-input-neko** – [Neko’s custom input driver](https://github.com/m1k1o/neko/tree/master/utils/xorg-deps/xf86-input-neko) (touch/pointer over Unix socket). Built in the Chrome and Firefox images.
- **xf86-video-dummy** – [Neko’s patched dummy video driver](https://github.com/m1k1o/neko/tree/master/utils/xorg-deps/xf86-video-dummy) (v0.3.8 + RandR patch). Built in the base image.

To refresh from Neko’s repo:

```bash
git clone --depth 1 https://github.com/m1k1o/neko.git /tmp/neko
cp -r /tmp/neko/utils/xorg-deps/xf86-input-neko docker/xorg-deps/
cp -r /tmp/neko/utils/xorg-deps/xf86-video-dummy docker/xorg-deps/
rm -rf /tmp/neko
```
