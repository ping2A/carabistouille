#!/usr/bin/env node
/**
 * Baliverne runtime: connects to the server WebSocket and drives the browser.
 * Speaks the Carabistouille-compatible agent protocol (commands in, events out).
 * Env: BALIVERNE_WS_URL, BALIVERNE_SESSION_ID, BALIVERNE_BROWSER (chrome|firefox).
 * Chrome: full browser on X11 (like Neko), capture via GStreamer ximagesrc, input via xdotool.
 * Firefox: full browser on X11 (Neko-style), same GStreamer + xdotool; no Playwright.
 *
 * Options: --debug, -d  Enable debug logging (GStreamer capture size, screenshot stats, etc.)
 */

const WebSocket = require('ws');
const fs = require('fs');
const net = require('net');
const { execSync, spawn } = require('child_process');

const DEBUG = process.argv.includes('--debug') || process.argv.includes('-d') || process.env.BALIVERNE_DEBUG === '1' || process.env.BALIVERNE_DEBUG === 'true';
if (DEBUG) process.env.BALIVERNE_DEBUG = '1';

function debugLog(...args) {
  if (DEBUG) console.error('[baliverne-runtime]', ...args);
}

const WS_URL = process.env.BALIVERNE_WS_URL || 'ws://host.docker.internal:8080/ws/session/default';
const SESSION_ID = process.env.BALIVERNE_SESSION_ID || 'default';
const BROWSER = (process.env.BALIVERNE_BROWSER || 'chrome').toLowerCase();
const CONNECT_RETRIES = parseInt(process.env.BALIVERNE_CONNECT_RETRIES || '10', 10) || 10;
const CONNECT_RETRY_DELAY_MS = parseInt(process.env.BALIVERNE_CONNECT_RETRY_DELAY_MS || '2000', 10) || 2000;
const CONNECT_TIMEOUT_MS = parseInt(process.env.BALIVERNE_CONNECT_TIMEOUT_MS || '15000', 10) || 15000;

const VIEWPORT = { width: 1920, height: 1080 };
const GST_CAPTURE_PATH = process.env.BALIVERNE_GST_CAPTURE_PATH || '/tmp/baliverne_frame.jpg';
const RTP_HOST = process.env.BALIVERNE_RTP_HOST;
const RTP_PORT = process.env.BALIVERNE_RTP_PORT;
const USE_RTP = !!(RTP_HOST && RTP_PORT);
// Optional: Neko xf86-input-neko socket for pointer (touch) input. If set and connectable, mouse uses it; else xtest-injector or xdotool. Set to empty to disable.
// Neko uses XTest directly (Go + X11 libs) or this socket; xdotool spawns a process per event and is too slow for real-time input (see README).
const NEKO_INPUT_SOCKET = process.env.BALIVERNE_NEKO_INPUT_SOCKET !== undefined ? process.env.BALIVERNE_NEKO_INPUT_SOCKET : '/tmp/xf86-input-neko.sock';
// Optional: path to xtest-injector binary (Rust XTest-based injector, one process / one X connection). Used when Neko socket is unavailable. Set to empty to skip and use xdotool.
const XTEST_INJECTOR_PATH = process.env.BALIVERNE_XTEST_INJECTOR_PATH !== undefined ? process.env.BALIVERNE_XTEST_INJECTOR_PATH : 'xtest-injector';
// XI2 touch event types (same as xf86-input-neko)
const XI_TouchBegin = 18;
const XI_TouchUpdate = 19;
const XI_TouchEnd = 20;

let ws;
let browser;
let page;
let firefoxProcess = null;
let screenshotIntervalId = null; // child process when BROWSER=firefox (Neko-style full app on X11)
const isChromeFullBrowser = BROWSER === 'chrome'; // Chrome on X11, GStreamer + xdotool
const isFirefoxFullBrowser = BROWSER === 'firefox'; // Firefox on X11 (Neko-style), same capture/input

// Mouse coalescing: store only latest mousemove and apply at fixed rate. Avoids blocking the message
// handler on slow paths (xdotool ~20ms per call) and prevents cursor lag from processing a long queue.
const MOUSEMOVE_APPLY_MS = 8; // apply latest position at ~125 Hz when backend is fast (Neko); xdotool will effectively run at ~50 Hz due to blocking
let latestMousemove = null;
function applyMousemove() {
  if (!latestMousemove) return;
  const { x, y } = latestMousemove;
  latestMousemove = null;
  if (isChromeFullBrowser || isFirefoxFullBrowser) {
    injectMousemove(x, y);
  } else if (page) {
    void page.mouse.move(x, y);
  }
}
setInterval(applyMousemove, MOUSEMOVE_APPLY_MS);

function send(event) {
  const payload = JSON.stringify(event);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
    debugLog('sent event type=%s size=%s', event.type, payload.length);
  } else {
    debugLog('send skipped (ws=%s readyState=%s)', !!ws, ws?.readyState);
  }
}

function toBase64(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('base64');
  return Buffer.from(raw).toString('base64');
}

/** Activate Chrome/Chromium window so input goes to it (Chrome full-browser mode). */
function xdoFocusChrome() {
  try {
    execSync('xdotool search --class "google-chrome" windowactivate 2>/dev/null || xdotool search --class "Chromium" windowactivate 2>/dev/null || xdotool search --name "Chrome" windowactivate 2>/dev/null || true', { timeout: 500, stdio: 'pipe', shell: true });
  } catch (err) {
    console.error('[baliverne-runtime] xdotool focus Chrome failed:', err.message);
  }
}

/** Activate Firefox window (Neko-style full-browser mode). */
function xdoFocusFirefox() {
  try {
    execSync('xdotool search --class "Firefox" windowactivate 2>/dev/null || xdotool search --class "firefox" windowactivate 2>/dev/null || xdotool search --name "Mozilla Firefox" windowactivate 2>/dev/null || true', { timeout: 500, stdio: 'pipe', shell: true });
  } catch (err) {
    console.error('[baliverne-runtime] xdotool focus Firefox failed:', err.message);
  }
}

function focusBrowser() {
  if (isChromeFullBrowser) xdoFocusChrome();
  else if (isFirefoxFullBrowser) xdoFocusFirefox();
}

/** Pack one 12-byte message for xf86-input-neko: type, touchId, x, y, pressure (LE). */
function packNekoMessage(type, touchId, x, y, pressure) {
  const b = Buffer.allocUnsafe(12);
  b[0] = type & 0xff;
  b[1] = touchId & 0xff;
  b[2] = (touchId >> 8) & 0xff;
  b.writeInt32LE(Math.round(x), 3);
  b.writeInt32LE(Math.round(y), 7);
  b[11] = (pressure !== undefined ? pressure : 255) & 0xff;
  return b;
}

let nekoSocket = null;
let nekoConnectPending = false;
let nekoConnectFailed = false;
let xtestInjectorProcess = null;
let xtestInjectorFailed = false;
let inputBackendLogged = false;

function logInputBackend(backend) {
  if (inputBackendLogged) return;
  inputBackendLogged = true;
  if (backend === 'neko') {
    console.error('[baliverne-runtime] pointer input: Neko socket (xf86-input-neko)');
  } else if (backend === 'xtest') {
    console.error('[baliverne-runtime] pointer input: XTest (xtest-injector)');
  } else {
    console.error('[baliverne-runtime] pointer input: xdotool (Neko socket and xtest-injector unavailable or disabled)');
  }
}

/** Spawn xtest-injector (Rust XTest-based, one X connection). Returns true if process is running and stdin writable. */
function ensureXtestInjector() {
  if (xtestInjectorProcess && xtestInjectorProcess.stdin && xtestInjectorProcess.stdin.writable) return true;
  if (xtestInjectorFailed || !XTEST_INJECTOR_PATH) return false;
  try {
    const display = process.env.DISPLAY || ':99';
    const child = spawn(XTEST_INJECTOR_PATH, [], {
      env: { ...process.env, DISPLAY: display },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.on('error', (err) => {
      xtestInjectorFailed = true;
      xtestInjectorProcess = null;
      if (DEBUG) console.error('[baliverne-runtime] xtest-injector spawn error:', err.message);
    });
    child.on('exit', (code, signal) => {
      xtestInjectorProcess = null;
      if (code !== 0 && code != null && DEBUG) console.error('[baliverne-runtime] xtest-injector exited code=%s signal=%s', code, signal || 'none');
    });
    child.stderr.on('data', (chunk) => { if (DEBUG) process.stderr.write(chunk); });
    xtestInjectorProcess = child;
    return true;
  } catch (e) {
    xtestInjectorFailed = true;
    return false;
  }
}

/** Send one command to xtest-injector stdin. Returns true if sent. */
function xtestSend(cmd) {
  if (!xtestInjectorProcess || !xtestInjectorProcess.stdin || !xtestInjectorProcess.stdin.writable) return false;
  try {
    return xtestInjectorProcess.stdin.write(cmd + '\n');
  } catch (e) {
    xtestInjectorProcess = null;
    return false;
  }
}

/** Lazy-connect to Neko input socket. Returns true if connected and ready. */
function nekoEnsureConnected() {
  if (nekoSocket && nekoSocket.writable) return true;
  if (nekoConnectPending || nekoConnectFailed || !NEKO_INPUT_SOCKET) return false;
  nekoConnectPending = true;
  try {
    const s = net.connect({ path: NEKO_INPUT_SOCKET }, () => {
      nekoConnectPending = false;
      nekoSocket = s;
      s.on('close', () => { nekoSocket = null; });
      s.on('error', () => { nekoSocket = null; });
      logInputBackend('neko');
      if (DEBUG) console.error('[baliverne-runtime] neko input socket connected:', NEKO_INPUT_SOCKET);
    });
    s.on('error', () => { nekoConnectPending = false; nekoConnectFailed = true; nekoSocket = null; });
    s.setTimeout(2000, () => { s.destroy(); nekoConnectPending = false; nekoConnectFailed = true; });
  } catch (e) {
    nekoConnectPending = false;
    nekoConnectFailed = true;
  }
  return false;
}

/** Send pointer event via Neko socket (touch events). Returns true if sent. */
function nekoSendTouch(type, x, y, touchId, pressure) {
  if (!nekoSocket || !nekoSocket.writable) {
    if (nekoEnsureConnected()) return nekoSendTouch(type, x, y, touchId, pressure);
    return false;
  }
  try {
    nekoSocket.write(packNekoMessage(type, touchId || 0, x, y, pressure));
    return true;
  } catch (e) {
    nekoSocket = null;
    return false;
  }
}

/** Inject mouse into X11 via xdotool. Fallback only: xdotool spawns a process per call (XTest under the hood), so it is slow; prefer Neko socket when available. */
function xdoMousemove(x, y) {
  try {
    execSync('xdotool mousemove --sync ' + Math.round(x) + ' ' + Math.round(y), { timeout: 500, stdio: 'pipe' });
  } catch (err) {
    console.error('[baliverne-runtime] xdotool mousemove failed:', err.message);
  }
}

function xdoClick(x, y) {
  try {
    focusBrowser();
    execSync('xdotool mousemove --sync ' + Math.round(x) + ' ' + Math.round(y) + ' click 1', { timeout: 2000, stdio: 'pipe' });
  } catch (err) {
    console.error('[baliverne-runtime] xdotool click failed:', err.message);
  }
}

/** Mouse move: use Neko socket if available, else xtest-injector (XTest), else xdotool. */
function injectMousemove(x, y) {
  if (nekoSendTouch(XI_TouchUpdate, x, y)) {
    logInputBackend('neko');
    return;
  }
  if (ensureXtestInjector() && xtestSend('m ' + Math.round(x) + ' ' + Math.round(y))) {
    logInputBackend('xtest');
    return;
  }
  logInputBackend('xdotool');
  xdoMousemove(x, y);
}

/** Click: use Neko socket (TouchBegin + TouchEnd) if available, else xtest-injector, else xdotool. */
function injectClick(x, y) {
  if (nekoSendTouch(XI_TouchBegin, x, y) && nekoSendTouch(XI_TouchEnd, x, y)) {
    logInputBackend('neko');
    return;
  }
  if (ensureXtestInjector() && xtestSend('c ' + Math.round(x) + ' ' + Math.round(y))) {
    logInputBackend('xtest');
    return;
  }
  logInputBackend('xdotool');
  focusBrowser();
  xdoClick(x, y);
}
// Map JavaScript KeyboardEvent.key to X11/xdotool keysym (e.g. Backspace -> BackSpace).
// Single printable characters (e.g. ".", ",") are sent via "xdotool type" so they work regardless of keysym names.
const KEY_TO_X11 = {
  Backspace: 'BackSpace',
  Enter: 'Return',
  ' ': 'space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
};
function xdoKey(key) {
  try {
    focusBrowser();
    if (key.length === 1) {
      // Single character (e.g. ".", ",", "/"): use "type" so the actual character is sent (Neko-style; xdotool key expects keysyms like "period"). 
      execSync('xdotool type --clearmodifiers ' + shellEscape(key), { timeout: 2000, stdio: 'pipe' });
    } else {
      const k = KEY_TO_X11[key] != null ? KEY_TO_X11[key] : key;
      execSync('xdotool key --clearmodifiers ' + shellEscape(k), { timeout: 2000, stdio: 'pipe' });
    }
  } catch (err) {
    console.error('[baliverne-runtime] xdotool key failed:', err.message);
  }
}
function xdoScroll(dx, dy) {
  try {
    focusBrowser();
    const count = Math.min(10, Math.max(1, Math.round(Math.abs(dy) / 50))) || 1;
    const btn = (dy > 0) ? '5' : '4';
    for (let i = 0; i < count; i++) {
      execSync('xdotool click ' + btn, { timeout: 1000, stdio: 'pipe' });
    }
  } catch (err) {
    console.error('[baliverne-runtime] xdotool scroll failed:', err.message);
  }
}
function shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Screencast (fallback): single-frame JPEG capture for WebSocket, same pipeline as Neko Screencast.
 * Neko: https://neko.m1k1o.net/docs/v3/configuration/capture#screencast
 * Pipeline: ximagesrc show-pointer=true use-damage=false ! videoconvert ! queue ! jpegenc quality=60.
 * We grab num-buffers=1 on a timer; Neko uses framerate=10/1. Rate controlled by BALIVERNE_SCREENSHOT_INTERVAL_MS (100 = ~10 fps like Neko).
 */
let gstCaptureLogOnce = true;
function captureScreenChrome() {
  const display = process.env.DISPLAY || ':99';
  const pipeline = [
    'gst-launch-1.0', '-q',
    'ximagesrc', 'show-pointer=true', 'use-damage=0', 'num-buffers=1',
    '!', 'videoconvert', '!', 'queue',
    '!', 'jpegenc', 'quality=60',
    '!', 'filesink', 'location=' + GST_CAPTURE_PATH,
  ].join(' ');
  if (gstCaptureLogOnce) {
    console.error('[baliverne-runtime] GStreamer Screencast (fallback): ximagesrc ! videoconvert ! queue ! jpegenc quality=60 (DISPLAY=%s)', display);
    gstCaptureLogOnce = false;
  }
  try {
    execSync(pipeline, { timeout: 5000, stdio: 'pipe', env: { ...process.env, DISPLAY: display } });
    const buf = fs.readFileSync(GST_CAPTURE_PATH);
    const b64 = buf.toString('base64');
    if (DEBUG) console.error('[baliverne-runtime] GStreamer capture OK:', buf.length, 'bytes');
    return b64;
  } catch (err) {
    console.error('[baliverne-runtime] GStreamer capture failed:', err.message || err);
    throw new Error('GStreamer capture failed: ' + (err.message || err));
  }
}

/**
 * WebRTC Video (primary): encode display and send RTP to server for WebRTC. Neko "WebRTC Video" equivalent.
 * Pipeline format follows Neko Gstreamer Pipeline Description:
 *   https://neko.m1k1o.net/docs/v3/configuration/capture#video.gst_pipeline
 * ximagesrc display-name={display} show-pointer=true use-damage=false ! videoconvert ! queue ! <encoder> ! <rtppay> ! udpsink
 * Codecs: vp8, vp9, av1, h264 (vp8 and h264 supported by all WebRTC clients).
 */
function startRtpStream() {
  if (!USE_RTP) {
    debugLog('startRtpStream skipped (USE_RTP=false)');
    return null;
  }
  const display = process.env.DISPLAY || ':99';
  const codec = (process.env.BALIVERNE_VIDEO_CODEC || 'vp8').toLowerCase();
  const fps = process.env.BALIVERNE_RTP_FPS || '30';
  console.error('[baliverne-runtime] starting RTP stream codec=%s fps=%s display=%s -> %s:%s', codec, fps, display, RTP_HOST, RTP_PORT);
  const gstEnv = { ...process.env, DISPLAY: display };
  const ximgPrefix = ['ximagesrc', 'display-name=' + display, 'show-pointer=true', 'use-damage=0'];
  const rawFps = ['!', 'video/x-raw,framerate=' + fps + '/1'];
  const convQueue = ['!', 'videoconvert', '!', 'queue', 'max-size-buffers=3', 'max-size-time=0'];
  let proc;
  if (codec === 'h264') {
    const bitrate = parseInt(process.env.BALIVERNE_H264_BITRATE || '4096', 10) || 4096;
    const args = [
      ...ximgPrefix, ...rawFps, ...convQueue,
      '!', 'x264enc',
      'threads=4', 'bitrate=' + bitrate, 'key-int-max=10', 'bframes=0',
      'byte-stream=true', 'tune=zerolatency', 'speed-preset=veryfast',
      '!', 'video/x-h264,stream-format=byte-stream,profile=baseline',
      '!', 'rtph264pay', 'config-interval=1',
      '!', 'udpsink', 'host=' + RTP_HOST, 'port=' + RTP_PORT,
    ];
    console.error('[baliverne-runtime] GStreamer RTP pipeline (Neko-style H264): ximagesrc display-name=%s show-pointer=true use-damage=false ! videoconvert ! queue ! x264enc ! rtph264pay ! udpsink', display);
    proc = spawn('gst-launch-1.0', args, { env: gstEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    console.error('[baliverne-runtime] H264 RTP stream started to %s:%s', RTP_HOST, RTP_PORT);
  } else if (codec === 'vp9') {
    const targetBitrate = parseInt(process.env.BALIVERNE_VP9_BITRATE || '3072000', 10) || 3072000;
    const args = [
      ...ximgPrefix, ...rawFps, ...convQueue,
      '!', 'vp9enc',
      'target-bitrate=' + targetBitrate, 'cpu-used=4', 'deadline=1', 'keyframe-max-dist=30',
      '!', 'rtpvp9pay',
      '!', 'udpsink', 'host=' + RTP_HOST, 'port=' + RTP_PORT,
    ];
    console.error('[baliverne-runtime] GStreamer RTP pipeline (Neko-style VP9): ximagesrc display-name=%s show-pointer=true use-damage=false ! videoconvert ! queue ! vp9enc ! rtpvp9pay ! udpsink', display);
    proc = spawn('gst-launch-1.0', args, { env: gstEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    console.error('[baliverne-runtime] VP9 RTP stream started to %s:%s', RTP_HOST, RTP_PORT);
  } else if (codec === 'av1') {
    const bitrate = parseInt(process.env.BALIVERNE_AV1_BITRATE || '3072', 10) || 3072;
    const args = [
      ...ximgPrefix, ...rawFps, ...convQueue,
      '!', 'av1enc', 'target-bitrate=' + (bitrate * 1000), 'cpu-used=6', 'keyframe-max-dist=30',
      '!', 'rtpav1pay',
      '!', 'udpsink', 'host=' + RTP_HOST, 'port=' + RTP_PORT,
    ];
    console.error('[baliverne-runtime] GStreamer RTP pipeline (Neko-style AV1): ximagesrc display-name=%s show-pointer=true use-damage=false ! videoconvert ! queue ! av1enc ! rtpav1pay ! udpsink', display);
    proc = spawn('gst-launch-1.0', args, { env: gstEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    console.error('[baliverne-runtime] AV1 RTP stream started to %s:%s', RTP_HOST, RTP_PORT);
  } else {
    // VP8 (default): Neko-style low latency
    const targetBitrate = parseInt(process.env.BALIVERNE_VP8_BITRATE || '3072000', 10) || 3072000;
    const args = [
      ...ximgPrefix, ...rawFps, ...convQueue,
      '!', 'vp8enc',
      'target-bitrate=' + targetBitrate, 'cpu-used=4', 'end-usage=cbr', 'deadline=1', 'threads=4',
      'undershoot=95', 'buffer-size=12288', 'buffer-initial-size=6144', 'buffer-optimal-size=9216',
      'keyframe-max-dist=15', 'min-quantizer=4', 'max-quantizer=20',
      '!', 'rtpvp8pay',
      '!', 'udpsink', 'host=' + RTP_HOST, 'port=' + RTP_PORT,
    ];
    console.error('[baliverne-runtime] GStreamer RTP pipeline (Neko-style VP8): ximagesrc display-name=%s show-pointer=true use-damage=false ! videoconvert ! queue ! vp8enc ! rtpvp8pay ! udpsink', display);
    proc = spawn('gst-launch-1.0', args, { env: gstEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    console.error('[baliverne-runtime] VP8 RTP stream started to %s:%s', RTP_HOST, RTP_PORT);
  }
  let stderrLines = [];
  const maxStderrLines = 30;
  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      stderrLines.push(line);
      if (stderrLines.length <= maxStderrLines) console.error('[baliverne-runtime] gst RTP stderr:', line);
    }
  });
  proc.stdout.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line && DEBUG) console.error('[baliverne-runtime] gst RTP stdout:', line);
  });
  proc.on('error', (err) => {
    console.error('[baliverne-runtime] GStreamer RTP pipeline error: %s', err.message);
    if (err.code) console.error('[baliverne-runtime] RTP pipeline err.code=%s', err.code);
  });
  proc.on('exit', (code, signal) => {
    console.error('[baliverne-runtime] GStreamer RTP pipeline exited code=%s signal=%s (WebRTC video will stop)', code ?? 'null', signal || 'none');
    if (code !== 0 && code != null) {
      console.error('[baliverne-runtime] RTP pipeline failed — check GStreamer/ximagesrc in container. Last stderr:');
      stderrLines.slice(-15).forEach((l) => console.error('[baliverne-runtime]   ', l));
    }
  });
  return proc;
}

async function sendScreenshot() {
  if (USE_RTP) return; // video via RTP only — do not run GStreamer screencast (avoids conflict with RTP pipeline)
  try {
    let data, format = 'jpeg';
    if (isChromeFullBrowser) {
      if (!browser) return; // wait for Chrome to be launched
      data = captureScreenChrome();
    } else if (isFirefoxFullBrowser) {
      if (!firefoxProcess) return; // wait for Firefox to be launched
      data = captureScreenChrome();
    } else if (page) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
      data = toBase64(buf);
      format = 'jpeg';
    } else {
      return;
    }
    const len = (data && data.length) || 0;
    if (DEBUG) {
      console.error('[baliverne-runtime] screenshot sent', len, 'bytes', format);
    }
    if (len < 100) {
      console.error('[baliverne-runtime] screenshot too small (' + len + ' bytes), possible capture failure');
    }
    send({
      type: 'screenshot',
      analysis_id: SESSION_ID,
      data: data || '',
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      format,
    });
  } catch (err) {
    if (DEBUG) {
      console.error('[baliverne-runtime] screenshot failed:', err.message);
    }
    send({ type: 'error', analysis_id: SESSION_ID, message: err.message });
  }
}

async function launchChrome() {
  const exe = process.env.PUPPETEER_EXECUTABLE_PATH || 'default Chromium';
  const display = process.env.DISPLAY || ':99';
  console.error('[baliverne-runtime] launching Chrome (full browser on X11) DISPLAY=%s executable=%s', display, exe);
  const puppeteer = require('puppeteer');
  debugLog('puppeteer.launch headless=false ...');
  browser = await puppeteer.launch({
    headless: false,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  debugLog('Chrome page ready, setting viewport %sx%s', VIEWPORT.width, VIEWPORT.height);
  await page.setViewport(VIEWPORT);
  console.error('[baliverne-runtime] Chrome launched on DISPLAY, capture via GStreamer');
}

/** Launch real Firefox on X11 (Neko-style). Uses GStreamer + xdotool like Chrome. */
async function launchFirefox() {
  const display = process.env.DISPLAY || ':99';
  const args = [
    '--no-remote',
    '-P', 'default',
    '--display=' + display,
    '-width', String(VIEWPORT.width),
    '-height', String(VIEWPORT.height),
  ];
  console.error('[baliverne-runtime] launching Firefox (full browser on X11) DISPLAY=%s args=%s', display, args.join(' '));
  firefoxProcess = spawn('/usr/bin/firefox', args, {
    env: { ...process.env, DISPLAY: display, HOME: process.env.HOME || '/app' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  firefoxProcess.on('error', (err) => console.error('[baliverne-runtime] Firefox process error:', err.message));
  firefoxProcess.on('exit', (code, signal) => {
    if (code != null && code !== 0) console.error('[baliverne-runtime] Firefox exited with code=%s', code);
    if (signal) console.error('[baliverne-runtime] Firefox killed signal=%s', signal);
  });
  console.error('[baliverne-runtime] Firefox launched on DISPLAY, capture via GStreamer');
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.removeAllListeners();
        socket.terminate();
        reject(new Error('Connection timeout after ' + (CONNECT_TIMEOUT_MS / 1000) + 's'));
      }
    }, CONNECT_TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    socket.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('Connection closed before open'));
    });
  });
}

async function run() {
  if (DEBUG) console.error('[baliverne-runtime] DEBUG mode enabled (verbose logging)');
  // Connect to server first (with retries) so the UI shows "runtime connected" even if browser launch is slow.
  console.error('[baliverne-runtime] starting session_id=%s browser=%s ws_url=%s', SESSION_ID, BROWSER, WS_URL);
  debugLog('env DISPLAY=%s RTP=%s RTP_HOST=%s RTP_PORT=%s NEKO_INPUT_SOCKET=%s XTEST_INJECTOR_PATH=%s',
    process.env.DISPLAY ?? '(unset)', USE_RTP, RTP_HOST ?? '(unset)', RTP_PORT ?? '(unset)', NEKO_INPUT_SOCKET || '(unset)', XTEST_INJECTOR_PATH || '(unset)');
  let lastErr;
  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
    console.error('[baliverne-runtime] connect attempt %d/%d to %s', attempt, CONNECT_RETRIES, WS_URL);
    ws = new WebSocket(WS_URL, { handshakeTimeout: CONNECT_TIMEOUT_MS });
    // Attach business handlers before waiting so they run when open fires.
    ws.on('open', async () => {
    console.error('[baliverne-runtime] WebSocket open, connected to %s', WS_URL);
    console.error('[baliverne-runtime] RTP config: BALIVERNE_RTP_HOST=%s BALIVERNE_RTP_PORT=%s USE_RTP=%s', RTP_HOST ?? '(unset)', RTP_PORT ?? '(unset)', USE_RTP);
    debugLog('sending browser_starting');
    if (NEKO_INPUT_SOCKET) setTimeout(() => nekoEnsureConnected(), 500);
    send({ type: 'browser_starting', session_id: SESSION_ID });
    try {
      debugLog('launching browser: %s', BROWSER);
      if (BROWSER === 'firefox') {
        await launchFirefox();
      } else {
        await launchChrome();
      }
      debugLog('browser launched, page=%s', !!page);
      if (page) {
        const networkRequests = [];
        let mainDocumentHost = null;

        const requestHandler = (request) => {
          const reqUrl = request.url();
          if (mainDocumentHost == null && (typeof request.isNavigationRequest === 'function' && request.isNavigationRequest())) {
            try { mainDocumentHost = new URL(reqUrl).hostname; } catch {}
          }
          let isThirdParty = false;
          try { isThirdParty = mainDocumentHost != null && new URL(reqUrl).hostname !== mainDocumentHost; } catch {}

          let reqHeaders = {};
          try { reqHeaders = (typeof request.headers === 'function' ? request.headers() : null) || {}; } catch {}
          let postData = null;
          try { postData = (typeof request.postData === 'function' ? request.postData() : null) || null; } catch {}

          let initiator = null;
          try {
            const init = (typeof request.initiator === 'function' ? request.initiator() : null) || request._initiator;
            if (init) initiator = { type: init.type || null, url: init.url || null, lineNumber: init.lineNumber ?? null };
          } catch {}

          networkRequests.push({
            url: reqUrl,
            method: typeof request.method === 'function' ? request.method() : 'GET',
            resource_type: (typeof request.resourceType === 'function' ? request.resourceType() : null) || 'other',
            is_navigation: typeof request.isNavigationRequest === 'function' ? request.isNavigationRequest() : false,
            status: null,
            status_text: null,
            content_type: null,
            size: null,
            response_size: null,
            remote_ip: null,
            remote_port: null,
            is_third_party: isThirdParty,
            from_cache: false,
            from_service_worker: false,
            timestamp: Date.now(),
            request_headers: Object.keys(reqHeaders).length ? reqHeaders : null,
            request_body: postData,
            response_headers: null,
            timing: null,
            security_details: null,
            initiator,
            failure: null,
          });
        };

        const responseHandler = async (response) => {
          const reqUrl = response.url();
          const status = response.status();
          const request = response.request();
          const existing = networkRequests.find((r) => r.url === reqUrl && r.status === null);
          if (!existing) return;

          existing.status = status;
          try { existing.status_text = (typeof response.statusText === 'function' ? response.statusText() : null) || null; } catch { existing.status_text = null; }

          let respHeaders = {};
          try { respHeaders = (typeof response.headers === 'function' ? response.headers() : null) || {}; } catch {}
          existing.content_type = respHeaders['content-type'] || null;
          existing.response_headers = Object.keys(respHeaders).length ? respHeaders : null;

          const contentLength = parseInt(respHeaders['content-length'], 10);
          if (!isNaN(contentLength)) existing.response_size = contentLength;

          try {
            const remote = typeof response.remoteAddress === 'function' ? response.remoteAddress() : null;
            existing.remote_ip = remote?.ip || null;
            existing.remote_port = remote?.port || null;
          } catch {}
          try { existing.from_cache = (typeof response.fromCache === 'function' ? response.fromCache() : false) || false; } catch {}
          try { existing.from_service_worker = (typeof response.fromServiceWorker === 'function' ? response.fromServiceWorker() : false) || false; } catch {}

          try {
            const timing = typeof response.timing === 'function' ? response.timing() : null;
            if (timing && typeof timing === 'object') {
              existing.timing = {
                requestTime: timing.requestTime ?? null,
                dnsStart: timing.dnsStart ?? null,
                dnsEnd: timing.dnsEnd ?? null,
                connectStart: timing.connectStart ?? null,
                connectEnd: timing.connectEnd ?? null,
                sslStart: timing.sslStart ?? null,
                sslEnd: timing.sslEnd ?? null,
                sendStart: timing.sendStart ?? null,
                sendEnd: timing.sendEnd ?? null,
                receiveHeadersStart: timing.receiveHeadersStart ?? null,
                receiveHeadersEnd: timing.receiveHeadersEnd ?? null,
              };
            }
          } catch {}

          try {
            const sec = typeof response.securityDetails === 'function' ? response.securityDetails() : null;
            if (sec && typeof sec === 'object') {
              const proto = typeof sec.protocol === 'function' ? sec.protocol() : sec.protocol;
              const issuer = typeof sec.issuer === 'function' ? sec.issuer() : sec.issuer;
              const subjectName = typeof sec.subjectName === 'function' ? sec.subjectName() : sec.subjectName;
              const validFrom = typeof sec.validFrom === 'function' ? sec.validFrom() : sec.validFrom;
              const validTo = typeof sec.validTo === 'function' ? sec.validTo() : sec.validTo;
              existing.security_details = { protocol: proto ?? null, issuer: issuer ?? null, subjectName: subjectName ?? null, validFrom: validFrom ?? null, validTo: validTo ?? null };
            }
          } catch {}

          send({ type: 'network_request_captured', analysis_id: SESSION_ID, request: { ...existing } });
        };

        const requestFailedHandler = (request) => {
          const reqUrl = typeof request.url === 'function' ? request.url() : request.url;
          const existing = networkRequests.find((r) => r.url === reqUrl && r.status === null);
          if (existing) {
            try { existing.failure = (typeof request.failure === 'function' ? request.failure() : null)?.errorText || 'unknown'; } catch { existing.failure = 'unknown'; }
            existing.status_text = 'Failed';
            send({ type: 'network_request_captured', analysis_id: SESSION_ID, request: { ...existing } });
          }
        };

        page.on('request', requestHandler);
        page.on('response', responseHandler);
        page.on('requestfailed', requestFailedHandler);
        page.on('console', (msg) => {
          const text = typeof msg.text === 'function' ? msg.text() : String(msg.text);
          const level = (msg.type && typeof msg.type === 'function' ? msg.type() : 'log') || 'log';
          send({
            type: 'console_log_captured',
            analysis_id: SESSION_ID,
            log: { level, text, timestamp: Date.now() },
          });
        });
      }
      if ((isChromeFullBrowser || isFirefoxFullBrowser) && (!NEKO_INPUT_SOCKET || nekoConnectFailed) && XTEST_INJECTOR_PATH && !xtestInjectorFailed) {
        ensureXtestInjector();
      }
      const inputBackend = (nekoSocket && nekoSocket.writable) ? 'neko' : (xtestInjectorProcess && xtestInjectorProcess.stdin && xtestInjectorProcess.stdin.writable) ? 'xtest' : (!NEKO_INPUT_SOCKET || nekoConnectFailed) && (!XTEST_INJECTOR_PATH || xtestInjectorFailed) ? 'xdotool' : 'pending';
      const videoDriver = process.env.BALIVERNE_VIDEO_DRIVER || 'dummy';
      console.error('[baliverne-runtime] sending agent_ready input_backend=%s video_driver=%s', inputBackend, videoDriver);
      send({ type: 'agent_ready', session_id: SESSION_ID, input_backend: inputBackend, video_driver: videoDriver });
      if (isChromeFullBrowser || isFirefoxFullBrowser) {
        debugLog('waiting 2s for browser window on X');
        await new Promise(r => setTimeout(r, 2000)); // let browser window appear on X
        if (USE_RTP) {
          debugLog('starting RTP stream to %s:%s', RTP_HOST, RTP_PORT);
          startRtpStream();
        }
      }
      // When WebRTC/RTP is used, do not send screenshots over WebSocket (video is via RTP only).
      if (!USE_RTP) {
        await sendScreenshot();
        const intervalMs = parseInt(process.env.BALIVERNE_SCREENSHOT_INTERVAL_MS || '500', 10) || 500;
        if (screenshotIntervalId) clearInterval(screenshotIntervalId);
        screenshotIntervalId = setInterval(() => { sendScreenshot().catch(() => {}); }, intervalMs);
      } else {
        if (screenshotIntervalId) clearInterval(screenshotIntervalId);
        screenshotIntervalId = null;
        console.error('[baliverne-runtime] WebRTC RTP active — screencast disabled (video via RTP only)');
      }
    } catch (err) {
      console.error('[baliverne-runtime] browser launch failed:', err.message || err);
      send({ type: 'error', analysis_id: SESSION_ID, message: err.message || String(err) });
    }
  });
  ws.on('message', async (data) => {
    const isBinary = Buffer.isBuffer(data) || data instanceof ArrayBuffer;
    let cmd;
    try {
      cmd = JSON.parse(data.toString());
    } catch (parseErr) {
      console.error('[baliverne-runtime] message parse error: %s first 100 chars: %s', parseErr.message, String(data).slice(0, 100));
      return;
    }
    if (!cmd.type) {
      debugLog('message has no type, ignoring');
      return;
    }
    if (cmd.type !== 'mousemove') {
      debugLog('command type=%s (message size=%s)', cmd.type, typeof data?.length === 'number' ? data.length : (data?.byteLength ?? '?'));
    }
    if (cmd.type === 'set_screenshot_interval') {
      if (USE_RTP) return; // no screencast when WebRTC RTP is active
      const ms = typeof cmd.ms === 'number' && cmd.ms > 0 ? cmd.ms : parseInt(process.env.BALIVERNE_SCREENSHOT_INTERVAL_MS || '500', 10) || 500;
      if (screenshotIntervalId) clearInterval(screenshotIntervalId);
      screenshotIntervalId = setInterval(() => { sendScreenshot().catch(() => {}); }, ms);
      console.error('[baliverne-runtime] screenshot interval set to %d ms (%s)', ms, ms >= 5000 ? 'throttled (viewer on WebRTC)' : 'normal');
      return;
    }
    if (!(isChromeFullBrowser || isFirefoxFullBrowser) && !page) {
      debugLog('command %s ignored: browser not ready (page=%s)', cmd.type, !!page);
      return;
    }
    if (['click', 'mousemove', 'scroll', 'key_press', 'type_text', 'navigate'].includes(cmd.type) && cmd.type !== 'mousemove') {
      console.error('[baliverne-runtime] command received: %s', cmd.type, cmd.type === 'click' ? { x: cmd.x, y: cmd.y } : cmd.type === 'navigate' ? { url: cmd.url } : cmd.type === 'key_press' ? { key: cmd.key } : '');
    }
    try {
      switch (cmd.type) {
        case 'navigate': {
          const url = cmd.url || 'about:blank';
          console.error('[baliverne-runtime] navigate to %s', url);
          if (isFirefoxFullBrowser) {
            focusBrowser();
            try {
              execSync('xdotool key --clearmodifiers ctrl+l', { timeout: 1000, stdio: 'pipe' });
              execSync('xdotool type --clearmodifiers ' + shellEscape(url), { timeout: 3000, stdio: 'pipe' });
              execSync('xdotool key Return', { timeout: 1000, stdio: 'pipe' });
            } catch (e) {
              console.error('[baliverne-runtime] Firefox navigate (xdotool) failed:', e.message);
            }
            send({ type: 'navigation_complete', analysis_id: SESSION_ID, url });
          } else if (page) {
            const opts = { waitUntil: 'networkidle2', timeout: 30000 };
            await page.goto(url, opts);
            const finalUrl = typeof page.url === 'function' ? page.url() : (await page.evaluate(() => window.location.href));
            send({ type: 'navigation_complete', analysis_id: SESSION_ID, url: finalUrl });
          }
          await sendScreenshot();
          break;
        }
        case 'click':
          if (isChromeFullBrowser || isFirefoxFullBrowser) {
            injectClick(cmd.x || 0, cmd.y || 0);
          } else if (page) {
            await page.mouse.click(cmd.x || 0, cmd.y || 0);
          }
          await sendScreenshot();
          break;
        case 'scroll': {
          const dx = cmd.dx || 0, dy = cmd.dy || 0;
          if (isChromeFullBrowser || isFirefoxFullBrowser) {
            xdoScroll(dx, dy);
          } else if (page) {
            await page.mouse.wheel({ deltaX: dx, deltaY: dy });
          }
          await sendScreenshot();
          break;
        }
        case 'mousemove':
          latestMousemove = { x: cmd.x || 0, y: cmd.y || 0 };
          break;
        case 'type_text':
          if (isChromeFullBrowser || isFirefoxFullBrowser) {
            try { focusBrowser(); execSync('xdotool type --clearmodifiers ' + shellEscape(cmd.text || ''), { timeout: 5000, stdio: 'pipe' }); } catch (e) {}
          } else if (page) {
            await page.keyboard.type(cmd.text || '');
          }
          await sendScreenshot();
          break;
        case 'key_press':
          debugLog('key_press key=%s', cmd.key);
          if (isChromeFullBrowser || isFirefoxFullBrowser) {
            xdoKey(cmd.key || '');
          } else if (page) {
            await page.keyboard.press(cmd.key || '');
          }
          await sendScreenshot();
          break;
        case 'inspect_element': {
          if (page) {
            const el = await page.evaluate((x, y) => {
              const e = document.elementFromPoint(x, y);
              return e ? { tagName: e.tagName, id: e.id, className: e.className } : null;
            }, cmd.x || 0, cmd.y || 0);
            send({ type: 'element_info', analysis_id: SESSION_ID, element: el });
          } else {
            send({ type: 'element_info', analysis_id: SESSION_ID, element: null });
          }
          break;
        }
        case 'stop_analysis':
          console.error('[baliverne-runtime] stop_analysis received, sending analysis_complete and exiting');
          send({ type: 'analysis_complete', analysis_id: SESSION_ID, report: {} });
          if (firefoxProcess) { firefoxProcess.kill('SIGTERM'); firefoxProcess = null; }
          if (browser) {
            const closeTimeout = setTimeout(() => {
              console.error('[baliverne-runtime] browser.close() timed out, exiting');
              process.exit(0);
            }, 3000);
            await browser.close().finally(() => clearTimeout(closeTimeout));
          }
          process.exit(0);
        default:
          debugLog('unknown command type: %s', cmd.type);
          break;
      }
    } catch (err) {
      console.error('[baliverne-runtime] command %s error:', cmd?.type, err.message);
      send({ type: 'error', analysis_id: SESSION_ID, message: err.message });
    }
  });
  ws.on('close', (code, reason) => {
    console.error('[baliverne-runtime] WebSocket closed code=%s reason=%s', code ?? '?', reason?.toString?.() || reason || '');
    if (firefoxProcess) { firefoxProcess.kill('SIGTERM'); firefoxProcess = null; }
    if (browser) browser.close();
    process.exit(0);
  });
  ws.on('error', (err) => {
    console.error('[baliverne-runtime] WebSocket error: %s', err.message);
    if (err.code) console.error('[baliverne-runtime] ws error code=%s', err.code);
    if (firefoxProcess) { firefoxProcess.kill('SIGTERM'); firefoxProcess = null; }
    if (browser) browser.close();
    process.exit(1);
  });

    try {
      await waitForConnect(ws);
      console.error('[baliverne-runtime] connected successfully on attempt %d', attempt);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.error('[baliverne-runtime] connect attempt %d failed: %s', attempt, err.message);
      if (err.code) console.error('[baliverne-runtime] connect error code=%s', err.code);
      ws = null;
      if (attempt < CONNECT_RETRIES) {
        console.error('[baliverne-runtime] retrying in %ds...', CONNECT_RETRY_DELAY_MS / 1000);
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
      }
    }
  }
  if (lastErr) {
    console.error('[baliverne-runtime] could not connect after %d attempts: %s', CONNECT_RETRIES, lastErr.message);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('[baliverne-runtime]', err);
  process.exit(1);
});
