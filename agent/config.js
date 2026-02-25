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
    // 'shell' = old headless (more permissive, bypasses most blocking)
    // true    = new headless (Chrome for Testing)
    // false   = headed (visible browser window, useful for debugging)
    headless: 'shell',

    viewportWidth: 1280,
    viewportHeight: 800,

    // Chromium flags applied to every launched instance.
    // Add or remove entries to tweak behaviour.
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
