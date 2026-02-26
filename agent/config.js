/**
 * Agent configuration — edit this file to change browser and analysis behaviour.
 */

const config = {
  server: {
    url: process.env.SERVER_URL || 'ws://localhost:3000/ws/agent',

    // Accept self-signed / invalid TLS certificates when connecting via wss://
    // Set to true for production with valid certs.
    rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED === 'true' ? true : false,
  },

  browser: {
    // 'new' = new headless (Chrome for Testing, realistic fingerprint)
    // 'shell' = old headless (legacy, easily fingerprinted)
    // false   = headed / "real" Chrome (needs a display; in Docker use Xvfb + HEADLESS=false)
    // Override: set env HEADLESS=false (or REAL_CHROME=1) for non-headless (e.g. Docker real Chrome).
    headless: process.env.HEADLESS === 'false' || process.env.REAL_CHROME === '1' || process.env.REAL_CHROME === 'true'
      ? false
      : 'new',

    // Browser engine to use:
    //   'puppeteer'       — plain Puppeteer + manual stealth patches (faster, easier to debug)
    //   'puppeteer-extra' — puppeteer-extra with stealth plugin (community evasions)
    // To test without the plugin: BROWSER_ENGINE=puppeteer npm start
    engine: process.env.BROWSER_ENGINE || 'puppeteer-extra',

    viewportWidth: 1280,
    viewportHeight: 800,

    // Chromium flags applied to every launched instance.
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=SafeBrowsing,IsolateOrigins,site-per-process,AdTagging,SubresourceFilter,HeavyAdIntervention',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-extensions',
      '--no-first-run',
      '--disable-popup-blocking',
      '--disable-background-networking',
      '--safebrowsing-disable-auto-update',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--allow-running-insecure-content',

      // Anti-detection: remove automation indicators
      '--disable-blink-features=AutomationControlled',
      '--force-prefers-color-scheme=dark',

      // Anti-detection: mimic real browser window/screen properties
      '--window-position=0,0',
      '--enable-features=NetworkService,NetworkServiceInProcess',

      // Anti-detection: remove "Chrome is being controlled by automated test software" bar
      '--disable-infobars',

      // Anti-detection: consistent locale (matches Accept-Language and navigator.language)
      '--lang=en-US',
    ],

    // Accept invalid / self-signed TLS certificates
    ignoreHTTPSErrors: true,

    // Bypass Content-Security-Policy headers
    bypassCSP: true,
  },

  navigation: {
    // Maximum time (ms) for each navigation attempt
    timeout: 30_000,

    // Ordered list of waitUntil strategies to try.
    // The analyzer tries each one; on failure it falls through to the next.
    // If all fail it uses CDP Page.navigate as a last resort.
    waitUntilChain: ['networkidle2', 'domcontentloaded', 'load'],
  },

  screenshots: {
    format: 'jpeg',
    quality: 65,
    intervalMs: 500,
  },
};

export default config;
