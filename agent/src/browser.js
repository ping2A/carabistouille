/**
 * BrowserManager: one headless Chromium per analysis (session map), viewport, screenshots, input, clipboard hooks.
 * Supports two engines via config.browser.engine:
 *   - 'puppeteer'       : plain Puppeteer + our manual stealth patches
 *   - 'puppeteer-extra'  : puppeteer-extra with community stealth plugin
 */
import puppeteer from 'puppeteer';
import config from '../config.js';

let launcher = puppeteer;

if (config.browser.engine === 'puppeteer-extra') {
  try {
    const { default: puppeteerExtra } = await import('puppeteer-extra');
    const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    launcher = puppeteerExtra;
    console.log('[browser] Engine: puppeteer-extra + stealth plugin');
  } catch (err) {
    console.warn(`[browser] Failed to load puppeteer-extra, falling back to plain puppeteer: ${err.message}`);
  }
} else {
  console.log('[browser] Engine: plain puppeteer (manual stealth patches)');
}

const useExtraStealth = launcher !== puppeteer;

/** Manages Puppeteer browser sessions keyed by analysisId; each session has its own Chromium + page. */
export class BrowserManager {
  constructor() {
    this.sessions = new Map();
    this.viewportWidth = config.browser.viewportWidth;
    this.viewportHeight = config.browser.viewportHeight;
  }

  /**
   * Start a new Chromium for this analysis (closing any existing one). Applies stealth/detection scripts and optional proxy/UA/viewport/network.
   * @param {string} analysisId - Analysis UUID.
   * @param {string|null} [proxy=null] - Optional proxy URL (e.g. socks5://host:port).
   * @param {string|null} [userAgent=null] - Optional User-Agent string.
   * @param {{ viewportWidth?: number, viewportHeight?: number, deviceScaleFactor?: number, isMobile?: boolean, networkThrottling?: string }} [options=null] - Optional viewport and network overrides.
   * @returns {Promise<import('puppeteer').Page>} The new page.
   */
  async createSession(analysisId, proxy = null, userAgent = null, options = null) {
    await this.closeSession(analysisId);

    const width = options?.viewport_width ?? options?.viewportWidth ?? this.viewportWidth;
    const height = options?.viewport_height ?? options?.viewportHeight ?? this.viewportHeight;

    const args = [
      ...config.browser.args,
      `--window-size=${width},${height}`,
    ];

    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
    }

    const browser = await launcher.launch({
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

    const deviceScaleFactor = options?.device_scale_factor ?? options?.deviceScaleFactor ?? 1;
    const isMobile = options?.is_mobile ?? options?.isMobile ?? false;
    await page.setViewport({
      width,
      height,
      deviceScaleFactor,
      isMobile,
    });

    if (options?.network_throttling && options.network_throttling !== 'none') {
      await this._applyNetworkThrottling(page, options.network_throttling);
    }

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    if (config.browser.bypassCSP) {
      await page.setBypassCSP(true);
    }

    if (useExtraStealth) {
      // puppeteer-extra stealth plugin handles evasions automatically;
      // still install our manual patches for gaps the plugin doesn't cover
      // (artifact cleanup, iframe chrome stub, Notification.permission, etc.)
      await this.installSupplementalPatches(page);
    } else {
      await this.installStealthPatches(page);
    }
    await this.installDetectionMonitors(page);

    const engine = useExtraStealth ? 'puppeteer-extra' : 'puppeteer';
    const headlessLabel = config.browser.headless === false ? 'real Chrome (headed)' : 'headless';
    this.sessions.set(analysisId, {
      browser,
      page,
      proxy,
      viewportWidth: width,
      viewportHeight: height,
      deviceScaleFactor,
      isMobile,
    });
    console.log(`[browser] Session created for ${analysisId} (engine: ${engine}, ${headlessLabel}, proxy: ${proxy || 'none'}, UA: ${userAgent ? 'custom' : 'default'}, viewport: ${width}×${height}@${deviceScaleFactor}x, active: ${this.sessions.size})`);
    return page;
  }

  /**
   * Apply network throttling (Slow 3G, Fast 3G) via CDP.
   * @param {import('puppeteer').Page} page - Puppeteer page.
   * @param {string} profile - "slow3g" or "fast3g".
   */
  async _applyNetworkThrottling(page, profile) {
    const conditions = {
      slow3g: { download: (400 * 1024) / 8, upload: (400 * 1024) / 8, latency: 2000 },
      fast3g: { download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8, latency: 562.5 },
    };
    const c = conditions[profile.toLowerCase()];
    if (!c) return;
    try {
      await page.emulateNetworkConditions({
        offline: false,
        download: c.download,
        upload: c.upload,
        latency: c.latency,
      });
      console.log(`[browser] Network throttling: ${profile} (${c.download} B/s down, ${c.latency}ms latency)`);
    } catch (err) {
      console.warn(`[browser] emulateNetworkConditions failed: ${err.message}`);
    }
  }

  /**
   * Apply geolocation, timezone, and locale to a page (for geo-specific or localized content).
   * @param {import('puppeteer').Page} page - Puppeteer page.
   * @param {{ timezoneId?: string, locale?: string, latitude?: number, longitude?: number, accuracy?: number }} options - Optional overrides.
   */
  async applyGeoAndLocale(page, options = {}) {
    if (!options || (!options.timezoneId && !options.locale && (options.latitude == null || options.longitude == null))) {
      return;
    }
    try {
      if (options.latitude != null && options.longitude != null) {
        await page.setGeolocation({
          latitude: options.latitude,
          longitude: options.longitude,
          accuracy: options.accuracy ?? 10,
        });
        console.log(`[browser] Geolocation set: ${options.latitude}, ${options.longitude}`);
      }
      if (options.timezoneId) {
        await page.emulateTimezone(options.timezoneId);
        console.log(`[browser] Timezone set: ${options.timezoneId}`);
      }
      if (options.locale) {
        await page.setExtraHTTPHeaders({ 'Accept-Language': options.locale.replace('_', '-') + ',en;q=0.9' });
        try {
          const cdp = await page.createCDPSession();
          await cdp.send('Emulation.setLocaleOverride', { locale: options.locale });
        } catch (e) {
          console.warn(`[browser] Locale override skipped: ${e.message}`);
        }
        console.log(`[browser] Locale set: ${options.locale}`);
      }
    } catch (err) {
      console.warn(`[browser] applyGeoAndLocale error: ${err.message}`);
    }
  }

  /**
   * Get the session for an analysis.
   * @param {string} analysisId - Analysis UUID.
   * @returns {{ browser: import('puppeteer').Browser, page: import('puppeteer').Page, proxy: string|null } | undefined}
   */
  getSession(analysisId) {
    return this.sessions.get(analysisId);
  }

  /**
   * Check if a session exists for this analysis.
   * @param {string} analysisId - Analysis UUID.
   * @returns {boolean}
   */
  hasSession(analysisId) {
    return this.sessions.has(analysisId);
  }

  /**
   * Get the page for this analysis; if the page was closed, create a new one in the same browser.
   * @param {string} analysisId - Analysis UUID.
   * @returns {Promise<import('puppeteer').Page>}
   */
  async getPage(analysisId) {
    const session = this.sessions.get(analysisId);
    if (!session) throw new Error(`No browser session for analysis ${analysisId}`);
    if (session.page.isClosed()) {
      session.page = await session.browser.newPage();
      const w = session.viewportWidth ?? this.viewportWidth;
      const h = session.viewportHeight ?? this.viewportHeight;
      const dpr = session.deviceScaleFactor ?? 1;
      const mobile = session.isMobile ?? false;
      await session.page.setViewport({ width: w, height: h, deviceScaleFactor: dpr, isMobile: mobile });
    }
    return session.page;
  }

  /**
   * Capture the viewport as base64 (format/quality from config; optimizeForSpeed for fluid analysis).
   * @param {string} analysisId - Analysis UUID.
   * @returns {Promise<{ data: string, width: number, height: number } | null>}
   */
  async takeScreenshot(analysisId) {
    try {
      const page = await this.getPage(analysisId);
      const format = config.screenshots?.format || 'webp';
      const quality = config.screenshots?.quality ?? 35;
      const opts = {
        type: format,
        optimizeForSpeed: true,
        captureBeyondViewport: false,
      };
      if (format === 'webp' || format === 'jpeg') {
        opts.quality = quality;
      }
      const raw = await page.screenshot(opts);
      const session = this.sessions.get(analysisId);
      const w = session?.viewportWidth ?? this.viewportWidth;
      const h = session?.viewportHeight ?? this.viewportHeight;
      const dpr = session?.deviceScaleFactor ?? 1;
      return {
        data: Buffer.from(raw).toString('base64'),
        width: Math.round(w * dpr),
        height: Math.round(h * dpr),
      };
    } catch (err) {
      console.error(`[browser] Screenshot error for ${analysisId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Mouse click at (x, y). Coordinates are in screenshot pixel space (same as the image the viewer sees);
   * we convert to CSS pixels using the session's deviceScaleFactor so Puppeteer's viewport matches.
   * @param {string} analysisId - Analysis UUID.
   * @param {number} x - X in screenshot/image pixels.
   * @param {number} y - Y in screenshot/image pixels.
   */
  async click(analysisId, x, y) {
    const session = this.sessions.get(analysisId);
    const page = await this.getPage(analysisId);
    const dpr = session?.deviceScaleFactor ?? 1;
    const cssX = x / dpr;
    const cssY = y / dpr;
    await page.mouse.click(cssX, cssY);
  }

  /**
   * Mouse wheel scroll by (deltaX, deltaY).
   * @param {string} analysisId - Analysis UUID.
   * @param {number} deltaX - Horizontal scroll delta.
   * @param {number} deltaY - Vertical scroll delta.
   */
  async scroll(analysisId, deltaX, deltaY) {
    const page = await this.getPage(analysisId);
    await page.mouse.wheel({ deltaX, deltaY });
  }

  /**
   * Move mouse to (x, y). Coordinates are in screenshot pixel space; convert to CSS using deviceScaleFactor.
   * @param {string} analysisId - Analysis UUID.
   * @param {number} x - X in screenshot/image pixels.
   * @param {number} y - Y in screenshot/image pixels.
   */
  async moveMouse(analysisId, x, y) {
    const session = this.sessions.get(analysisId);
    const page = await this.getPage(analysisId);
    const dpr = session?.deviceScaleFactor ?? 1;
    const cssX = x / dpr;
    const cssY = y / dpr;
    await page.mouse.move(cssX, cssY);
  }

  /**
   * Type a string using the keyboard (keyboard.type).
   * @param {string} analysisId - Analysis UUID.
   * @param {string} text - Text to type.
   */
  async typeText(analysisId, text) {
    const page = await this.getPage(analysisId);
    await page.keyboard.type(text);
  }

  /**
   * Press a single key (e.g. Enter, Backspace).
   * @param {string} analysisId - Analysis UUID.
   * @param {string} key - Key name (Puppeteer keyboard key).
   */
  async keyPress(analysisId, key) {
    const page = await this.getPage(analysisId);
    await page.keyboard.press(key);
  }

  /**
   * Inject stealth patches before any page script runs to evade headless Chrome detection.
   * Covers: navigator.webdriver, plugins, languages, chrome runtime, Permissions, WebGL, screen, vendor, document artifacts.
   * @param {import('puppeteer').Page} page - Puppeteer page to patch.
   */
  async installStealthPatches(page) {
    const viewportWidth = this.viewportWidth;
    const viewportHeight = this.viewportHeight;
    await page.evaluateOnNewDocument((vw, vh) => {
      // 1. Remove navigator.webdriver flag (most common detection)
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

      // 2. Fake navigator.plugins (headless has 0 plugins)
      Object.defineProperty(navigator, 'plugins', {
        configurable: true,
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
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
      Object.defineProperty(navigator, 'language', { get: () => 'en-US', configurable: true });

      // 4. navigator.vendor / pdfViewerEnabled / maxTouchPoints (Chrome desktop)
      Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
      Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });

      // 5. navigator.platform (match common Chrome desktop; headless often reports "Linux")
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });

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

      // 6b. window.outerWidth/outerHeight (detect-headless: "Outer Dimension" — 0 in headless)
      try {
        Object.defineProperty(window, 'outerWidth', { get: () => vw, configurable: true });
        Object.defineProperty(window, 'outerHeight', { get: () => vh, configurable: true });
      } catch (_) {}

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
          configurable: true,
          get: () => ({
            effectiveType: '4g',
            rtt: 50,
            downlink: 10,
            saveData: false,
          }),
        });
      }

      // 12. Ensure navigator.hardwareConcurrency reports a realistic value
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });

      // 13. Ensure navigator.deviceMemory reports a realistic value
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

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
   * Lightweight patches applied when puppeteer-extra stealth plugin is active.
   * Only covers gaps the plugin doesn't handle: automation artifact cleanup, realistic
   * screen dimensions, iframe cross-frame chrome stub, and force-dark-mode preference.
   * @param {import('puppeteer').Page} page - Puppeteer page to patch.
   */
  async installSupplementalPatches(page) {
    const viewportWidth = this.viewportWidth;
    const viewportHeight = this.viewportHeight;
    await page.evaluateOnNewDocument((vw, vh) => {
      // Screen dimensions (stealth plugin doesn't override these)
      const screenOverrides = {
        width: 1920, height: 1080, availWidth: 1920, availHeight: 1040,
        colorDepth: 24, pixelDepth: 24,
      };
      Object.keys(screenOverrides).forEach((k) => {
        try {
          Object.defineProperty(screen, k, { get: () => screenOverrides[k], configurable: true });
        } catch (_) {}
      });

      // window.outerWidth/outerHeight (detect-headless "Outer Dimension" — 0 in headless)
      try {
        Object.defineProperty(window, 'outerWidth', { get: () => vw, configurable: true });
        Object.defineProperty(window, 'outerHeight', { get: () => vh, configurable: true });
      } catch (_) {}

      // Remove automation artifacts ($cdc_, __webdriver_, etc.)
      const artifactPrefixes = ['$cdc_', '__webdriver_', '__driver_', '__selenium_', '__fxdriver_', '__nightmare_', '_Selenium_IDE_', '_WEBDRIVER_ELEM_CACHE_', 'callSelenium_', '__$webdriverAsyncExecutor_', '__lastWatirAlert_', '__lastWatirConfirm_', '__lastWatirPrompt_', 'webdriver'];
      artifactPrefixes.forEach((prefix) => {
        Object.keys(document).forEach((key) => {
          if (key.indexOf(prefix) === 0 || key.toLowerCase().indexOf(prefix.toLowerCase()) === 0) {
            try { delete document[key]; } catch (_) {}
          }
        });
      });

      // Patch iframe contentWindow.chrome for cross-frame detection
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
   * Install monitors that record when page scripts probe properties commonly used for headless detection.
   * The monitors wrap the already-patched stealth values, so they return the spoofed value while
   * logging the access (property, category, stack trace) to window.__detectionAttempts.
   * @param {import('puppeteer').Page} page - Puppeteer page to attach monitors to.
   */
  async installDetectionMonitors(page) {
    await page.evaluateOnNewDocument(() => {
      window.__detectionAttempts = [];
      const seen = new Set();

      // Whitelist: don't record bot/fingerprint probes when the call originates from these hosts (CDNs, analytics, tag managers).
      const CALLER_WHITELIST = [
        'jsdelivr.net',
        'cdn.jsdelivr.net',
        'googletagmanager.com',
        'www.googletagmanager.com',
        'google-analytics.com',
        'www.google-analytics.com',
        'googleadservices.com',
        'gstatic.com',
        'ajax.googleapis.com',
        'fonts.googleapis.com',
        'cdnjs.cloudflare.com',
        'unpkg.com',
        'cdn.skypack.dev',
        'connect.facebook.net',
        'facebook.net',
        'hotjar.com',
        'segment.io',
        'segment.com',
        'mixpanel.com',
        'amplitude.com',
        'fullstory.com',
        'clarity.ms',
        'cloudflareinsights.com',
      ];

      function hostnameFromStackFrame(frame) {
        const match = frame.match(/https?:\/\/([^/):\s]+)/);
        if (!match) return null;
        const host = match[1].toLowerCase().replace(/^www\./, '');
        return host;
      }

      function isWhitelistedCaller(stackText) {
        const frames = stackText.split('\n');
        for (const frame of frames) {
          if (frame.includes('evaluateOnNewDocument') || frame.includes('__puppeteer')) continue;
          const host = hostnameFromStackFrame(frame);
          if (!host) continue;
          for (const allowed of CALLER_WHITELIST) {
            const domain = allowed.toLowerCase().replace(/^www\./, '');
            if (host === domain || host.endsWith('.' + domain)) return true;
          }
        }
        return false;
      }

      function record(property, category, severity, description) {
        const stack = new Error().stack || '';
        if (isWhitelistedCaller(stack)) return;
        const frames = stack.split('\n').slice(2).filter(f => !f.includes('evaluateOnNewDocument') && !f.includes('__puppeteer'));
        const caller = frames[0]?.trim() || '';
        const key = `${property}|${caller}`;
        if (seen.has(key)) return;
        seen.add(key);
        window.__detectionAttempts.push({
          property,
          category,
          severity,
          description,
          caller,
          timestamp: Date.now(),
        });
      }

      function wrapGetter(obj, prop, meta) {
        let desc = Object.getOwnPropertyDescriptor(obj, prop);
        if (!desc) {
          // Property may live on the prototype chain (e.g. Navigator.prototype)
          let proto = Object.getPrototypeOf(obj);
          while (proto && !desc) {
            desc = Object.getOwnPropertyDescriptor(proto, prop);
            proto = Object.getPrototypeOf(proto);
          }
        }
        if (!desc) return;
        const origGet = desc.get || (() => desc.value);
        try {
          Object.defineProperty(obj, prop, {
            get: function () {
              record(meta.property, meta.category, meta.severity, meta.description);
              return origGet.call(this);
            },
            configurable: true,
            enumerable: desc.enumerable !== false,
          });
        } catch (_) {}
      }

      // navigator probes
      const navProbes = [
        ['webdriver', 'bot-detection', 'high', 'Checks navigator.webdriver automation flag'],
        ['plugins', 'fingerprint', 'high', 'Enumerates browser plugins (empty in headless)'],
        ['languages', 'fingerprint', 'medium', 'Reads navigator.languages array'],
        ['platform', 'fingerprint', 'medium', 'Reads navigator.platform string'],
        ['vendor', 'fingerprint', 'low', 'Reads navigator.vendor string'],
        ['hardwareConcurrency', 'fingerprint', 'medium', 'Reads CPU core count'],
        ['deviceMemory', 'fingerprint', 'medium', 'Reads device memory (GB)'],
        ['connection', 'fingerprint', 'medium', 'Reads Network Information API'],
        ['maxTouchPoints', 'fingerprint', 'low', 'Reads touch capability'],
        ['pdfViewerEnabled', 'fingerprint', 'low', 'Checks PDF viewer support'],
      ];
      for (const [prop, cat, sev, desc] of navProbes) {
        wrapGetter(navigator, prop, {
          property: `navigator.${prop}`, category: cat, severity: sev, description: desc,
        });
      }

      // screen probes
      const screenProbes = ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth'];
      for (const prop of screenProbes) {
        wrapGetter(screen, prop, {
          property: `screen.${prop}`, category: 'fingerprint', severity: 'low',
          description: `Reads screen.${prop}`,
        });
      }

      // window.chrome probe
      try {
        const chromeVal = window.chrome;
        Object.defineProperty(window, 'chrome', {
          get: function () {
            record('window.chrome', 'bot-detection', 'high', 'Checks if window.chrome object exists');
            return chromeVal;
          },
          set: function (v) {},
          configurable: true,
        });
      } catch (_) {}

      // Notification.permission
      if (typeof Notification !== 'undefined') {
        wrapGetter(Notification, 'permission', {
          property: 'Notification.permission', category: 'fingerprint', severity: 'medium',
          description: 'Reads notification permission state',
        });
      }

      // Permissions.query for notifications
      if (window.Permissions?.prototype?.query) {
        const origPQ = window.Permissions.prototype.query;
        window.Permissions.prototype.query = function (params) {
          if (params?.name === 'notifications') {
            record('Permissions.query(notifications)', 'bot-detection', 'high',
              'Probes notification permission via Permissions API');
          }
          return origPQ.call(this, params);
        };
      }

      // WebGL getParameter (vendor/renderer fingerprint)
      for (const Ctx of [WebGLRenderingContext, WebGL2RenderingContext]) {
        if (!Ctx?.prototype?.getParameter) continue;
        const origGP = Ctx.prototype.getParameter;
        Ctx.prototype.getParameter = function (param) {
          if (param === 37445 || param === 37446) {
            record(`WebGL.getParameter(${param === 37445 ? 'VENDOR' : 'RENDERER'})`,
              'fingerprint', 'high', 'Reads WebGL vendor/renderer for GPU fingerprinting');
          }
          return origGP.call(this, param);
        };
      }

      // Canvas fingerprinting
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        record('canvas.toDataURL', 'fingerprint', 'high', 'Canvas fingerprinting via toDataURL');
        return origToDataURL.apply(this, args);
      };
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (...args) {
        record('canvas.toBlob', 'fingerprint', 'high', 'Canvas fingerprinting via toBlob');
        return origToBlob.apply(this, args);
      };
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        record('canvas.getImageData', 'fingerprint', 'high', 'Canvas fingerprinting via getImageData');
        return origGetImageData.apply(this, args);
      };

      // AudioContext fingerprinting
      if (typeof AudioContext !== 'undefined') {
        const origCreateOsc = AudioContext.prototype.createOscillator;
        AudioContext.prototype.createOscillator = function () {
          record('AudioContext.createOscillator', 'fingerprint', 'high',
            'Audio fingerprinting via OscillatorNode');
          return origCreateOsc.call(this);
        };
      }

      // matchMedia probes (prefers-color-scheme, prefers-reduced-motion)
      // Returns a wrapped MediaQueryList that also monitors .matches and .addEventListener('change')
      const origMatchMedia = window.matchMedia;
      if (origMatchMedia) {
        window.matchMedia = function (query) {
          const mql = origMatchMedia.call(this, query);
          const isDetectionQuery = typeof query === 'string' &&
            (query.includes('prefers-color-scheme') || query.includes('prefers-reduced-motion'));
          if (isDetectionQuery) {
            record(`matchMedia("${query}")`, 'bot-detection', 'medium',
              'Media query probe often used to detect headless mode');

            // Wrap .matches to detect when the result is read
            try {
              const origMatches = Object.getOwnPropertyDescriptor(MediaQueryList.prototype, 'matches')?.get;
              if (origMatches) {
                Object.defineProperty(mql, 'matches', {
                  get: function () {
                    record(`matchMedia("${query}").matches`, 'bot-detection', 'high',
                      'Reads media query result — headless browsers may return unexpected values');
                    return origMatches.call(this);
                  },
                  configurable: true,
                });
              }
            } catch (_) {}

            // Wrap addEventListener to detect change listeners (cookie persistence / reload detection pattern)
            const origAddEL = mql.addEventListener?.bind(mql);
            if (origAddEL) {
              mql.addEventListener = function (type, ...rest) {
                if (type === 'change') {
                  record(`matchMedia("${query}").addEventListener("change")`, 'bot-detection', 'high',
                    'Listens for media query changes — classic headless detection: mismatched events trigger redirect');
                }
                return origAddEL(type, ...rest);
              };
            }
            // Legacy .addListener (deprecated but still used by detection scripts)
            const origAddL = mql.addListener?.bind(mql);
            if (origAddL) {
              mql.addListener = function (cb) {
                record(`matchMedia("${query}").addListener`, 'bot-detection', 'high',
                  'Legacy media query change listener — headless detection pattern');
                return origAddL(cb);
              };
            }
          }
          return mql;
        };
      }

      // document.cookie reads (cookie persistence verification)
      try {
        const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
                           Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
        if (cookieDesc) {
          const origCookieGet = cookieDesc.get;
          const origCookieSet = cookieDesc.set;
          Object.defineProperty(document, 'cookie', {
            get: function () {
              record('document.cookie (read)', 'bot-detection', 'medium',
                'Reads cookies — may verify cookie persistence across reloads (headless detection)');
              return origCookieGet.call(this);
            },
            set: function (val) {
              // Only flag suspicious theme/detection cookies, not all cookie writes
              const lv = (typeof val === 'string' ? val : '').toLowerCase();
              if (lv.includes('theme') || lv.includes('bot') || lv.includes('detect') ||
                  lv.includes('captcha') || lv.includes('challenge') || lv.includes('fingerprint')) {
                record(`document.cookie (set: ${val.split('=')[0]})`, 'bot-detection', 'high',
                  'Sets a detection/theme cookie — part of cookie persistence verification pattern');
              }
              return origCookieSet.call(this, val);
            },
            configurable: true,
          });
        }
      } catch (_) {}

      // window.location assignments (redirect after detection)
      try {
        const locDesc = Object.getOwnPropertyDescriptor(window, 'location');
        if (locDesc?.set) {
          const origLocSet = locDesc.set;
          Object.defineProperty(window, 'location', {
            get: locDesc.get,
            set: function (val) {
              record('window.location (redirect)', 'bot-detection', 'high',
                'Redirecting via location assignment — may be a detection-triggered redirect');
              return origLocSet.call(this, val);
            },
            configurable: true,
          });
        }
      } catch (_) {}

      // location.href setter (most common redirect pattern)
      try {
        const hrefDesc = Object.getOwnPropertyDescriptor(window.location.__proto__, 'href') ||
                         Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (hrefDesc?.set) {
          const origHrefGet = hrefDesc.get;
          const origHrefSet = hrefDesc.set;
          Object.defineProperty(window.location, 'href', {
            get: function () { return origHrefGet.call(this); },
            set: function (val) {
              record(`location.href = "${(val || '').substring(0, 80)}"`, 'bot-detection', 'high',
                'Redirect via location.href — often used after bot/headless detection fails');
              return origHrefSet.call(this, val);
            },
            configurable: true,
          });
        }
      } catch (_) {}

      // location.replace (another common redirect method)
      try {
        const origReplace = Location.prototype.replace;
        Location.prototype.replace = function (url) {
          record(`location.replace("${(url || '').substring(0, 80)}")`, 'bot-detection', 'high',
            'Redirect via location.replace — often used after bot/headless detection');
          return origReplace.call(this, url);
        };
      } catch (_) {}

      // Error.stack analysis (some detectors look for "puppeteer" in the stack)
      const origPrepare = Error.prepareStackTrace;
      if (typeof Error.prepareStackTrace === 'function' || Error.prepareStackTrace === undefined) {
        Error.prepareStackTrace = function (err, structuredStack) {
          record('Error.prepareStackTrace', 'bot-detection', 'medium',
            'Overrides Error.prepareStackTrace (stack trace analysis)');
          if (origPrepare) return origPrepare(err, structuredStack);
          return structuredStack.map(s => `    at ${s}`).join('\n');
        };
      }

      // Object.keys(document) scanning for automation artifacts
      const origObjKeys = Object.keys;
      Object.keys = function (obj) {
        const result = origObjKeys.call(this, obj);
        if (obj === document) {
          record('Object.keys(document)', 'bot-detection', 'high',
            'Scanning document properties for automation artifacts ($cdc_, __webdriver_, etc.)');
        }
        return result;
      };

      // Object.getOwnPropertyNames(document/navigator) — deeper artifact scan
      const origGetOwnPropNames = Object.getOwnPropertyNames;
      Object.getOwnPropertyNames = function (obj) {
        const result = origGetOwnPropNames.call(this, obj);
        if (obj === document || obj === navigator) {
          record(`Object.getOwnPropertyNames(${obj === document ? 'document' : 'navigator'})`,
            'bot-detection', 'high',
            'Deep property scan for automation artifacts');
        }
        return result;
      };

      // navigator.sendBeacon — sometimes used to phone home detection results
      if (navigator.sendBeacon) {
        const origBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
          const bodyStr = typeof data === 'string' ? data : '';
          const lv = (url + ' ' + bodyStr).toLowerCase();
          if (lv.includes('bot') || lv.includes('detect') || lv.includes('fingerprint') ||
              lv.includes('headless') || lv.includes('automation') || lv.includes('webdriver')) {
            record(`navigator.sendBeacon("${(url || '').substring(0, 80)}")`, 'bot-detection', 'high',
              'Beacon with detection-related keywords — may be reporting bot detection result');
          }
          return origBeacon(url, data);
        };
      }

      // fetch/XHR to detection endpoints
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input?.url || '';
        const lv = url.toLowerCase();
        if (lv.includes('bot') || lv.includes('captcha') || lv.includes('challenge') ||
            lv.includes('fingerprint') || lv.includes('detect') || lv.includes('verify-browser')) {
          record(`fetch("${url.substring(0, 80)}")`, 'bot-detection', 'high',
            'Fetch to detection/challenge endpoint — site may be verifying browser legitimacy');
        }
        return origFetch.call(this, input, init);
      };
    });
  }

  /**
   * Inject clipboard write interceptors before any page script runs (evaluateOnNewDocument).
   * Intercepts: navigator.clipboard.writeText/write, document.execCommand('copy'), and 'copy' event.
   * Captured writes are pushed to window.__clipboardCaptures for later drain.
   */
  /**
   * Install clipboard interception (writeText, write, execCommand, copy event) and store captures for the analysis.
   * @param {string} analysisId - Analysis UUID.
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
  /**
   * Retrieve and clear clipboard captures for this analysis (used after navigation, on poll, or at stop).
   * @param {string} analysisId - Analysis UUID.
   * @returns {Promise<Array<{ content: string, timestamp?: number, method?: string }>>}
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

  /**
   * Retrieve and clear detection attempts (headless probes) recorded by installDetectionMonitors for this analysis.
   * @param {string} analysisId - Analysis UUID.
   * @returns {Promise<Array<{ property: string, category: string, severity: string, description?: string, caller?: string, timestamp: number }>>}
   */
  async drainDetectionAttempts(analysisId) {
    try {
      const page = await this.getPage(analysisId);
      const attempts = await page.evaluate(() => {
        const list = window.__detectionAttempts || [];
        window.__detectionAttempts = [];
        return list;
      });
      return attempts;
    } catch (err) {
      console.warn(`[browser] Detection drain error for ${analysisId}: ${err.message}`);
      return [];
    }
  }

  /**
   * Get element at viewport (x, y): tag, id, classes, attributes, text snippet, rect, computed styles.
   * (x, y) are in screenshot pixel space; we convert to CSS for elementFromPoint.
   * @param {string} analysisId - Analysis UUID.
   * @param {number} x - X in screenshot/image pixels.
   * @param {number} y - Y in screenshot/image pixels.
   * @returns {Promise<{ tag: string, id?: string, classes: string[], attributes: Object, text: string, rect: { x, y, width, height } } | null>}
   */
  async inspectElement(analysisId, x, y) {
    try {
      const session = this.sessions.get(analysisId);
      const page = await this.getPage(analysisId);
      const dpr = session?.deviceScaleFactor ?? 1;
      const cssX = x / dpr;
      const cssY = y / dpr;
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
      }, cssX, cssY);
    } catch (err) {
      console.error(`[browser] Inspect error for ${analysisId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Close the browser for this analysis and remove the session from the map.
   * @param {string} analysisId - Analysis UUID.
   */
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

  /**
   * Close all browser sessions and clear the session map (e.g. on process shutdown).
   */
  async closeAll() {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.closeSession(id);
    }
  }
}
