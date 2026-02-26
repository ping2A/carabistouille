/**
 * BrowserManager: one headless Chromium per analysis (session map), viewport, screenshots, input, clipboard hooks.
 */
import puppeteer from 'puppeteer';
import config from '../config.js';

/** Manages Puppeteer browser sessions keyed by analysisId; each session has its own Chromium + page. */
export class BrowserManager {
  constructor() {
    this.sessions = new Map();
    this.viewportWidth = config.browser.viewportWidth;
    this.viewportHeight = config.browser.viewportHeight;
  }

  /** Start a new Chromium for this analysis (closing any existing one). Optional proxy and userAgent. Returns the page. */
  async createSession(analysisId, proxy = null, userAgent = null) {
    await this.closeSession(analysisId);

    const args = [
      ...config.browser.args,
      `--window-size=${this.viewportWidth},${this.viewportHeight}`,
    ];

    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
    }

    const browser = await puppeteer.launch({
      headless: config.browser.headless,
      args,
      ignoreHTTPSErrors: config.browser.ignoreHTTPSErrors,
    });
    const page = await browser.newPage();

    if (userAgent) {
      await page.setUserAgent(userAgent);
      const uaPreview = userAgent.length > 50 ? userAgent.substring(0, 50) + '...' : userAgent;
      console.log(`[browser] User-Agent set for ${analysisId}: ${uaPreview}`);
    }

    await page.setViewport({
      width: this.viewportWidth,
      height: this.viewportHeight,
      deviceScaleFactor: 1,
    });

    // Anti-detection: request headers consistent with a real browser (Accept-Language matches navigator.languages)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    if (config.browser.bypassCSP) {
      await page.setBypassCSP(true);
    }

    await this.installStealthPatches(page);

    this.sessions.set(analysisId, { browser, page, proxy });
    console.log(`[browser] Session created for ${analysisId} (proxy: ${proxy || 'none'}, UA: ${userAgent ? 'custom' : 'default'}, active: ${this.sessions.size})`);
    return page;
  }

  /** Get session { browser, page, proxy } or undefined. */
  getSession(analysisId) {
    return this.sessions.get(analysisId);
  }

  /** True if a session exists for this analysis. */
  hasSession(analysisId) {
    return this.sessions.has(analysisId);
  }

  /** Get the page for this analysis; if the page was closed, create a new one in the same browser. */
  async getPage(analysisId) {
    const session = this.sessions.get(analysisId);
    if (!session) throw new Error(`No browser session for analysis ${analysisId}`);
    if (session.page.isClosed()) {
      session.page = await session.browser.newPage();
      await session.page.setViewport({ width: this.viewportWidth, height: this.viewportHeight });
    }
    return session.page;
  }

  /** Capture viewport as JPEG (base64); returns { data, width, height } or null on error. */
  async takeScreenshot(analysisId) {
    try {
      const page = await this.getPage(analysisId);
      const raw = await page.screenshot({
        type: config.screenshots.format,
        quality: config.screenshots.quality,
      });
      return {
        data: Buffer.from(raw).toString('base64'),
        width: this.viewportWidth,
        height: this.viewportHeight,
      };
    } catch (err) {
      console.error(`[browser] Screenshot error for ${analysisId}: ${err.message}`);
      return null;
    }
  }

  /** Mouse click at (x, y) in viewport coordinates. */
  async click(analysisId, x, y) {
    const page = await this.getPage(analysisId);
    await page.mouse.click(x, y);
  }

  /** Mouse wheel scroll by (deltaX, deltaY). */
  async scroll(analysisId, deltaX, deltaY) {
    const page = await this.getPage(analysisId);
    await page.mouse.wheel({ deltaX, deltaY });
  }

  /** Move mouse to (x, y). */
  async moveMouse(analysisId, x, y) {
    const page = await this.getPage(analysisId);
    await page.mouse.move(x, y);
  }

  /** Type a string (keyboard.type). */
  async typeText(analysisId, text) {
    const page = await this.getPage(analysisId);
    await page.keyboard.type(text);
  }

  /** Press a single key (e.g. Enter, Backspace). */
  async keyPress(analysisId, key) {
    const page = await this.getPage(analysisId);
    await page.keyboard.press(key);
  }

  /**
   * Inject stealth patches before any page script runs to evade headless Chrome detection.
   * Covers: navigator.webdriver, plugins, languages, chrome runtime, Permissions, WebGL, screen, vendor, document artifacts.
   */
  async installStealthPatches(page) {
    const viewportWidth = this.viewportWidth;
    const viewportHeight = this.viewportHeight;
    await page.evaluateOnNewDocument((vw, vh) => {
      // 1. Remove navigator.webdriver flag (most common detection)
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // 2. Fake navigator.plugins (headless has 0 plugins)
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
          plugins.length = 3;
          return plugins;
        },
      });

      // 3. Fake navigator.languages (headless may have empty array)
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'language', { get: () => 'en-US' });

      // 4. navigator.vendor / pdfViewerEnabled / maxTouchPoints (Chrome desktop)
      Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
      Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

      // 5. navigator.platform (match common Chrome desktop; headless often reports "Linux")
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

      // 6. Realistic screen dimensions (headless can report 0 or odd values)
      const screenOverrides = {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
        pixelDepth: 24,
      };
      Object.keys(screenOverrides).forEach((k) => {
        try {
          if (Object.getOwnPropertyDescriptor(screen, k)?.writable !== false) {
            Object.defineProperty(screen, k, { get: () => screenOverrides[k], configurable: true });
          }
        } catch (_) {}
      });

      // 7. Remove automation artifacts on document (Selenium, CDP, etc.)
      const artifactPrefixes = ['$cdc_', '__webdriver_', '__driver_', '__selenium_', '__fxdriver_', '__nightmare_', '_Selenium_IDE_', '_WEBDRIVER_ELEM_CACHE_', 'callSelenium_', '__$webdriverAsyncExecutor_', '__lastWatirAlert_', '__lastWatirConfirm_', '__lastWatirPrompt_', 'webdriver'];
      artifactPrefixes.forEach((prefix) => {
        Object.keys(document).forEach((key) => {
          if (key.indexOf(prefix) === 0 || key.toLowerCase().indexOf(prefix.toLowerCase()) === 0) {
            try {
              delete document[key];
            } catch (_) {}
          }
        });
      });

      // 8. Ensure window.chrome exists with runtime stub
      if (!window.chrome) {
        window.chrome = {};
      }
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
          PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
          PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
          RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
          OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          connect: function () { return { onDisconnect: { addListener: function () {} }, onMessage: { addListener: function () {} } }; },
          sendMessage: function () {},
        };
      }

      // 9. Fake Permissions.query for "notifications" (headless returns "denied" immediately)
      const origQuery = window.Permissions?.prototype?.query;
      if (origQuery) {
        window.Permissions.prototype.query = function (parameters) {
          if (parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
          }
          return origQuery.call(this, parameters);
        };
      }

      // 10. Fake WebGL vendor and renderer (headless often shows "Google Inc." / "ANGLE")
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, param);
      };
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.call(this, param);
      };

      // 11. Fix missing connection property (headless may have undefined)
      if (navigator.connection === undefined) {
        Object.defineProperty(navigator, 'connection', {
          get: () => ({
            effectiveType: '4g',
            rtt: 50,
            downlink: 10,
            saveData: false,
          }),
        });
      }

      // 12. Ensure navigator.hardwareConcurrency reports a realistic value
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

      // 13. Ensure navigator.deviceMemory reports a realistic value
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

      // 14. Notification.permission (some scripts expect "default" or "denied", not undefined)
      if (typeof Notification !== 'undefined' && (Notification.permission === undefined || Notification.permission === null)) {
        Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
      }

      // 15. Patch iframe contentWindow.chrome for cross-frame detection
      const origCreateElement = document.createElement.bind(document);
      document.createElement = function (...args) {
        const el = origCreateElement(...args);
        if (args[0]?.toLowerCase() === 'iframe') {
          const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
          Object.defineProperty(el, 'contentWindow', {
            get: function () {
              const w = origContentWindow.get.call(this);
              if (w && !w.chrome) w.chrome = window.chrome;
              return w;
            },
          });
        }
        return el;
      };
    }, viewportWidth, viewportHeight);
  }

  /**
   * Inject clipboard write interceptors before any page script runs (evaluateOnNewDocument).
   * Intercepts: navigator.clipboard.writeText/write, document.execCommand('copy'), and 'copy' event.
   * Captured writes are pushed to window.__clipboardCaptures for later drain.
   */
  async installClipboardHooks(analysisId) {
    try {
      const page = await this.getPage(analysisId);
      await page.evaluateOnNewDocument(() => {
        window.__clipboardCaptures = [];

        const _push = (text, method) => {
          window.__clipboardCaptures.push({
            content: text,
            method,
            timestamp: Date.now(),
          });
        };

        // Intercept navigator.clipboard.writeText
        if (navigator.clipboard) {
          const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = function (text) {
            _push(text, 'clipboard.writeText');
            return origWriteText(text);
          };

          // Intercept navigator.clipboard.write (ClipboardItem-based)
          const origWrite = navigator.clipboard.write.bind(navigator.clipboard);
          navigator.clipboard.write = async function (items) {
            try {
              for (const item of items) {
                for (const type of item.types) {
                  if (type.startsWith('text/')) {
                    const blob = await item.getType(type);
                    const text = await blob.text();
                    _push(text, 'clipboard.write');
                  }
                }
              }
            } catch {}
            return origWrite(items);
          };
        }

        // Intercept document.execCommand('copy')
        const origExecCommand = document.execCommand.bind(document);
        document.execCommand = function (cmd, ...args) {
          if (cmd === 'copy') {
            try {
              const sel = window.getSelection();
              if (sel && sel.toString()) {
                _push(sel.toString(), 'execCommand.copy');
              }
            } catch {}
          }
          return origExecCommand(cmd, ...args);
        };

        // Listen for 'copy' DOM events (catches Ctrl+C and programmatic copy)
        document.addEventListener('copy', (e) => {
          try {
            if (e.clipboardData) {
              const text = e.clipboardData.getData('text/plain') ||
                           e.clipboardData.getData('text');
              if (text) {
                _push(text, 'copy_event.clipboardData');
                return;
              }
            }
            const sel = window.getSelection();
            if (sel && sel.toString()) {
              _push(sel.toString(), 'copy_event.selection');
            }
          } catch {}
        }, true);
      });
      console.log(`[browser] Clipboard hooks installed for ${analysisId}`);
    } catch (err) {
      console.warn(`[browser] Clipboard hooks error for ${analysisId}: ${err.message}`);
    }
  }

  /**
   * Drain all clipboard captures collected by the injected hooks.
   * Returns an array of { content, method, timestamp } and clears the buffer.
   */
  async drainClipboardCaptures(analysisId) {
    try {
      const page = await this.getPage(analysisId);
      const captures = await page.evaluate(() => {
        const list = window.__clipboardCaptures || [];
        window.__clipboardCaptures = [];
        return list;
      });
      return captures;
    } catch (err) {
      console.warn(`[browser] Clipboard drain error for ${analysisId}: ${err.message}`);
      return [];
    }
  }

  /** Element at viewport (x, y): tag, id, classes, attributes, text snippet, rect, computed styles. */
  async inspectElement(analysisId, x, y) {
    try {
      const page = await this.getPage(analysisId);
      return await page.evaluate((px, py) => {
        const el = document.elementFromPoint(px, py);
        if (!el) return null;

        const rect = el.getBoundingClientRect();
        const attrs = {};
        for (const attr of el.attributes || []) {
          attrs[attr.name] = attr.value;
        }

        const styles = window.getComputedStyle(el);

        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          classes: Array.from(el.classList),
          attributes: attrs,
          text: (el.innerText || '').substring(0, 500),
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          computed: {
            display: styles.display,
            position: styles.position,
            color: styles.color,
            backgroundColor: styles.backgroundColor,
            fontSize: styles.fontSize,
          },
        };
      }, x, y);
    } catch (err) {
      console.error(`[browser] Inspect error for ${analysisId}: ${err.message}`);
      return null;
    }
  }

  /** Close the browser for this analysis and remove the session. */
  async closeSession(analysisId) {
    const session = this.sessions.get(analysisId);
    if (!session) return;
    this.sessions.delete(analysisId);
    try {
      await session.browser.close();
    } catch (err) {
      console.warn(`[browser] Error closing session ${analysisId}: ${err.message}`);
    }
    console.log(`[browser] Session closed for ${analysisId} (remaining: ${this.sessions.size})`);
  }

  /** Close all browser sessions (e.g. on shutdown). */
  async closeAll() {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.closeSession(id);
    }
  }
}
