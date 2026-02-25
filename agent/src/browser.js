import puppeteer from 'puppeteer';
import config from '../config.js';

export class BrowserManager {
  constructor() {
    this.sessions = new Map();
    this.viewportWidth = config.browser.viewportWidth;
    this.viewportHeight = config.browser.viewportHeight;
  }

  async createSession(analysisId, proxy = null) {
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
    await page.setViewport({ width: this.viewportWidth, height: this.viewportHeight });

    if (config.browser.bypassCSP) {
      await page.setBypassCSP(true);
    }

    this.sessions.set(analysisId, { browser, page, proxy });
    console.log(`[browser] Session created for ${analysisId} (proxy: ${proxy || 'none'}, active: ${this.sessions.size})`);
    return page;
  }

  getSession(analysisId) {
    return this.sessions.get(analysisId);
  }

  hasSession(analysisId) {
    return this.sessions.has(analysisId);
  }

  async getPage(analysisId) {
    const session = this.sessions.get(analysisId);
    if (!session) throw new Error(`No browser session for analysis ${analysisId}`);
    if (session.page.isClosed()) {
      session.page = await session.browser.newPage();
      await session.page.setViewport({ width: this.viewportWidth, height: this.viewportHeight });
    }
    return session.page;
  }

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

  async click(analysisId, x, y) {
    const page = await this.getPage(analysisId);
    await page.mouse.click(x, y);
  }

  async scroll(analysisId, deltaX, deltaY) {
    const page = await this.getPage(analysisId);
    await page.mouse.wheel({ deltaX, deltaY });
  }

  async moveMouse(analysisId, x, y) {
    const page = await this.getPage(analysisId);
    await page.mouse.move(x, y);
  }

  async typeText(analysisId, text) {
    const page = await this.getPage(analysisId);
    await page.keyboard.type(text);
  }

  async keyPress(analysisId, key) {
    const page = await this.getPage(analysisId);
    await page.keyboard.press(key);
  }

  /**
   * Inject clipboard write interceptors BEFORE any page script runs.
   * This catches navigator.clipboard.writeText(), navigator.clipboard.write(),
   * document.execCommand('copy'), and the 'copy' DOM event.
   * Captured writes are stored in window.__clipboardCaptures.
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

  async closeAll() {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.closeSession(id);
    }
  }
}
