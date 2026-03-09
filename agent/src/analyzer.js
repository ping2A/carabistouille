/**
 * Analyzer: orchestrates a single analysis — request/response/console listeners, navigation,
 * inline scripts, page source, clipboard drain, screenshots; builds report and risk score on stop.
 */
import config from '../config.js';

/**
 * Holds per-analysis state (requests, scripts, console, redirects, clipboard), runs capture and report.
 * Orchestrates navigation, network/console listeners, screenshots, and final risk computation.
 */
export class Analyzer {
  /**
   * @param {import('./browser.js').BrowserManager} browserManager - Browser/session manager for creating pages and taking screenshots.
   */
  constructor(browserManager) {
    this.browserManager = browserManager;
    this.activeAnalyses = new Map();
    this.screenshotIntervals = new Map();
  }

  /**
   * Set up request/response/console listeners, navigate to url, capture inline scripts and page source; keep analysis live until stop.
   * @param {string} analysisId - Analysis UUID.
   * @param {string} url - URL to navigate to.
   * @param {(event: object) => void} sendEvent - Callback to send events (e.g. to WebSocket).
   * @returns {Promise<void>}
   */
  async startAnalysis(analysisId, url, sendEvent) {
    console.log(`[analyzer] Starting analysis ${analysisId} for ${url}`);

    const page = await this.browserManager.getPage(analysisId);
    const networkRequests = [];
    const scripts = [];
    const consoleLogs = [];
    const redirectChain = [];

    let originalHost;
    try {
      originalHost = new URL(url).hostname;
    } catch {
      console.error(`[analyzer] Invalid URL: ${url}`);
      sendEvent({ type: 'error', analysis_id: analysisId, message: `Invalid URL: ${url}` });
      return;
    }

    const clipboardReads = [];
    /** Last response headers per URL for document responses (used for CSP / security headers at stop). */
    const lastDocumentHeadersByUrl = {};
    const detectionAttempts = [];
    const state = {
      aborted: false,
      sendEvent,
      url,
      originalHost,
      networkRequests,
      scripts,
      consoleLogs,
      redirectChain,
      clipboardReads,
      detectionAttempts,
      lastDocumentHeadersByUrl,
    };

    const requestHandler = (request) => {
      if (state.aborted) return;
      const reqUrl = request.url();
      let isThirdParty = false;
      try { isThirdParty = new URL(reqUrl).hostname !== originalHost; } catch {}

      let reqHeaders = {};
      try { reqHeaders = request.headers() || {}; } catch {}
      let postData = null;
      try { postData = request.postData() || null; } catch {}

      let initiator = null;
      try {
        const init = request.initiator?.() || request._initiator;
        if (init) initiator = { type: init.type || null, url: init.url || null, lineNumber: init.lineNumber ?? null };
      } catch {}

      networkRequests.push({
        url: reqUrl,
        method: request.method(),
        resource_type: request.resourceType() || null,
        is_navigation: request.isNavigationRequest() || false,
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
        request_headers: reqHeaders,
        request_body: postData,
        response_headers: null,
        timing: null,
        security_details: null,
        initiator,
        failure: null,
        _request: request,
      });
    };

    const responseHandler = async (response) => {
      if (state.aborted) return;
      const reqUrl = response.url();
      const status = response.status();
      const request = response.request();
      if (request.resourceType() === 'document') {
        try {
          const headers = response.headers();
          state.lastDocumentHeadersByUrl[reqUrl] = typeof headers === 'object' && headers !== null
            ? { ...headers }
            : {};
        } catch {}
      }

      if (status >= 300 && status < 400) {
        const location = response.headers()['location'];
        if (location) {
          console.log(`[analyzer] Redirect: ${reqUrl} -> ${location} (${status})`);
          redirectChain.push({ from: reqUrl, to: location, status });
          sendEvent({
            type: 'redirect_detected',
            analysis_id: analysisId,
            from: reqUrl,
            to: location,
            status,
          });
        }
      }

      const existing = networkRequests.find((r) => r.url === reqUrl && r.status === null);
      if (existing) {
        existing.status = status;
        try { existing.status_text = response.statusText() || null; } catch { existing.status_text = null; }

        const respHeaders = response.headers() || {};
        existing.content_type = respHeaders['content-type'] || null;
        existing.response_headers = respHeaders;

        const contentLength = parseInt(respHeaders['content-length'], 10);
        if (!isNaN(contentLength)) existing.response_size = contentLength;

        const remote = response.remoteAddress();
        existing.remote_ip = remote?.ip || null;
        existing.remote_port = remote?.port || null;

        try { existing.from_cache = response.fromCache() || false; } catch { existing.from_cache = false; }
        try { existing.from_service_worker = response.fromServiceWorker() || false; } catch { existing.from_service_worker = false; }

        try {
          const timing = response.timing();
          if (timing) {
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
          const sec = response.securityDetails();
          if (sec) {
            existing.security_details = {
              protocol: sec.protocol?.() ?? sec.protocol ?? null,
              issuer: sec.issuer?.() ?? sec.issuer ?? null,
              subjectName: sec.subjectName?.() ?? sec.subjectName ?? null,
              validFrom: sec.validFrom?.() ?? sec.validFrom ?? null,
              validTo: sec.validTo?.() ?? sec.validTo ?? null,
            };
          }
        } catch {}

        const { _request, ...serializable } = existing;
        sendEvent({
          type: 'network_request_captured',
          analysis_id: analysisId,
          request: serializable,
        });

        const ct = existing.content_type || '';
        const isText = ct.includes('text/') || ct.includes('javascript') || ct.includes('json') ||
                        ct.includes('xml') || ct.includes('css') || ct.includes('html') ||
                        reqUrl.endsWith('.js') || reqUrl.endsWith('.css') || reqUrl.endsWith('.html') ||
                        reqUrl.endsWith('.json') || reqUrl.endsWith('.xml') || reqUrl.endsWith('.svg');

        if (isText && status >= 200 && status < 400) {
          let body = null;
          try {
            body = await response.text();
          } catch {}
          if (body !== null) {
            sendEvent({
              type: 'raw_file_captured',
              analysis_id: analysisId,
              file: { url: reqUrl, content_type: ct.split(';')[0].trim(), size: body.length, content: body, timestamp: Date.now() },
            });
          }

          if (ct.includes('javascript') || reqUrl.endsWith('.js')) {
            const script = {
              url: reqUrl,
              is_inline: false,
              size: body ? body.length : (parseInt(response.headers()['content-length']) || null),
              hash: null,
              content: body,
              timestamp: Date.now(),
            };
            scripts.push(script);
            sendEvent({ type: 'script_loaded', analysis_id: analysisId, script });
          }
        }
      }
    };

    const requestFailedHandler = (request) => {
      if (state.aborted) return;
      const reqUrl = request.url();
      const existing = networkRequests.find((r) => r.url === reqUrl && r.status === null);
      if (existing) {
        const failInfo = request.failure();
        existing.failure = failInfo?.errorText || 'unknown';
        existing.status_text = 'Failed';
        const { _request, ...serializable } = existing;
        sendEvent({
          type: 'network_request_captured',
          analysis_id: analysisId,
          request: serializable,
        });
      }
    };

    const consoleHandler = (msg) => {
      if (state.aborted) return;
      const log = { level: msg.type(), text: msg.text(), timestamp: Date.now() };
      consoleLogs.push(log);
      sendEvent({ type: 'console_log_captured', analysis_id: analysisId, log });
    };

    page.on('request', requestHandler);
    page.on('response', responseHandler);
    page.on('requestfailed', requestFailedHandler);
    page.on('console', consoleHandler);

    state.requestHandler = requestHandler;
    state.responseHandler = responseHandler;
    state.requestFailedHandler = requestFailedHandler;
    state.consoleHandler = consoleHandler;
    this.activeAnalyses.set(analysisId, state);

    await this.browserManager.installClipboardHooks(analysisId);

    try {
      await this._navigateWithRetries(page, url, state);

      if (state.aborted) return;

      const title = await page.title();
      const finalUrl = page.url();

      console.log(`[analyzer] Navigation complete: url=${finalUrl} title="${title}"`);
      sendEvent({
        type: 'navigation_complete',
        analysis_id: analysisId,
        url: finalUrl,
        title,
        engine: config.browser.engine || 'puppeteer',
        headless: config.browser.headless !== false,
      });

      try {
        const shot = await this.browserManager.takeScreenshot(analysisId);
        if (shot) {
          console.log(`[analyzer] Sending initial screenshot (${(shot.data.length / 1024).toFixed(1)} KB base64)`);
          sendEvent({ type: 'screenshot', analysis_id: analysisId, data: shot.data, width: shot.width, height: shot.height });
        }
      } catch (e) {
        console.warn(`[analyzer] Initial screenshot: ${e.message}`);
      }

      // Periodic screenshots at config interval; skip a tick if previous capture still in flight (keeps analysis fluid).
      const intervalMs = config.screenshots?.intervalMs ?? 800;
      let screenshotTick = 0;
      let screenshotInFlight = false;
      const screenshotInterval = setInterval(async () => {
        if (state.aborted) return;
        if (screenshotInFlight) return;
        screenshotInFlight = true;
        try {
          const shot = await this.browserManager.takeScreenshot(analysisId);
          if (shot) {
            sendEvent({ type: 'screenshot', analysis_id: analysisId, data: shot.data, width: shot.width, height: shot.height });
          }
        } catch (err) {
          console.error(`[analyzer] Screenshot interval error: ${err.message}`);
        } finally {
          screenshotInFlight = false;
        }
        screenshotTick++;
        if (screenshotTick % 2 === 0) {
          this._drainAndReportClipboard(analysisId, 'poll');
          this._drainAndReportDetection(analysisId);
        }
      }, intervalMs);
      this.screenshotIntervals.set(analysisId, screenshotInterval);

      // Capture the rendered page HTML source
      try {
        const html = await page.content();
        if (html) {
          sendEvent({
            type: 'page_source_captured',
            analysis_id: analysisId,
            html,
          });
          console.log(`[analyzer] Page source captured (${html.length} chars)`);
        }
      } catch (err) {
        console.warn(`[analyzer] Page source capture error: ${err.message}`);
      }

      this._drainAndReportClipboard(analysisId, 'navigation');

      try {
        const now = Date.now();
        const inlineScripts = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('script:not([src])')).map((s, i) => ({
            url: null,
            is_inline: true,
            size: s.textContent.length,
            hash: null,
            content: s.textContent || null,
            index: i,
          }));
        });
        inlineScripts.forEach(s => { s.timestamp = now; });
        for (const s of inlineScripts) {
          scripts.push(s);
          sendEvent({ type: 'script_loaded', analysis_id: analysisId, script: s });
        }
        if (inlineScripts.length > 0) {
          console.log(`[analyzer] Found ${inlineScripts.length} inline scripts`);
        }
      } catch (err) {
        console.warn(`[analyzer] Inline script scan error: ${err.message}`);
      }

      console.log(`[analyzer] Analysis ${analysisId} is now live — waiting for user to finish`);
    } catch (err) {
      if (state.aborted) return;
      console.error(`[analyzer] Navigation error for ${analysisId}: ${err.message}`);
      sendEvent({ type: 'error', analysis_id: analysisId, message: err.message });
      this.cleanupAnalysis(analysisId);
    }
  }

  /**
   * Try each waitUntil strategy in order; if all fail, use CDP Page.navigate as fallback.
   * @param {import('puppeteer').Page} page - Puppeteer page.
   * @param {string} url - URL to load.
   * @param {object} state - Analysis state (checked for aborted).
   * @returns {Promise<void>}
   */
  async _navigateWithRetries(page, url, state) {
    const timeout = config.navigation.timeout;
    const chain = config.navigation.waitUntilChain;

    for (const strategy of chain) {
      if (state.aborted) return;
      try {
        console.log(`[analyzer] Navigating to ${url} (timeout: ${timeout}ms, waitUntil: ${strategy})...`);
        await page.goto(url, { waitUntil: strategy, timeout });
        return;
      } catch (err) {
        if (state.aborted) return;
        console.warn(`[analyzer] ${strategy} failed: ${err.message}`);
      }
    }

    // All page.goto strategies failed — fall back to CDP Page.navigate
    // which does not throw ERR_BLOCKED_BY_CLIENT.
    if (state.aborted) return;
    console.log(`[analyzer] All goto strategies failed, using CDP Page.navigate for ${url}...`);
    const cdp = await page.createCDPSession();
    try {
      await cdp.send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 3000));

      const currentUrl = page.url();
      if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('chrome-error://')) {
        throw new Error(`CDP navigation ended on ${currentUrl || 'blank'}`);
      }
      console.log(`[analyzer] CDP navigation landed on ${currentUrl}`);
    } finally {
      await cdp.detach();
    }
  }

  /**
   * Check HTTPS, mixed content, suspicious patterns (eval+unescape, iframes, hidden forms, etc.).
   * @param {import('puppeteer').Page} page - Puppeteer page (final URL used for HTTPS check).
   * @param {string} originalUrl - Original navigation URL (for reference).
   * @returns {Promise<{ ssl_valid: boolean|null, ssl_issuer: string|null, ssl_protocol: string|null, has_mixed_content: boolean, suspicious_patterns: string[] }>}
   */
  async analyzeSecurityIndicators(page, originalUrl) {
    const security = {
      ssl_valid: null,
      ssl_issuer: null,
      ssl_protocol: null,
      has_mixed_content: false,
      mixed_danger: false,
      suspicious_patterns: [],
    };

    try {
      security.ssl_valid = page.url().startsWith('https://');

      const pageAnalysis = await page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        const patterns = [];

        // Eval+unescape: require close proximity (obfuscation) to avoid minified/bundled code FP
        const evalIdx = html.indexOf('eval(');
        if (evalIdx !== -1 && html.includes('unescape(')) {
          const window = 400;
          const slice = html.slice(Math.max(0, evalIdx - 100), evalIdx + window);
          if (slice.includes('unescape(')) patterns.push('Obfuscated JavaScript (eval + unescape)');
        }
        if (html.includes('document.write(unescape(')) patterns.push('document.write with unescape');

        const iframeCount = (html.match(/<iframe/gi) || []).length;
        if (iframeCount > 12) patterns.push(`Excessive iframes (${iframeCount})`);

        // Skip hidden forms / delayed redirect: too many FPs (modals, consent, "redirecting..." pages)
        const mixedContent = document.querySelectorAll(
          'img[src^="http:"], script[src^="http:"], link[href^="http:"], iframe[src^="http:"]'
        );
        const mixedScriptOrIframe = document.querySelectorAll('script[src^="http:"], iframe[src^="http:"]');
        const mixedCount = mixedContent.length;
        const mixedDangerCount = mixedScriptOrIframe.length;

        const forms = document.querySelectorAll('form[action]');
        let crossOriginForms = 0;
        forms.forEach((f) => {
          const action = (f.getAttribute('action') || '').trim();
          if (action && !action.startsWith('/') && !action.startsWith('#') && action !== '') {
            try {
              const origin = window.location.origin;
              if (action.indexOf(origin) !== 0) crossOriginForms++;
            } catch (_) {}
          }
        });
        if (crossOriginForms > 2) patterns.push(`Multiple cross-origin forms (${crossOriginForms})`);

        return {
          mixedContentCount: mixedCount,
          mixedDangerCount,
          patterns,
        };
      });

      security.has_mixed_content = pageAnalysis.mixedContentCount > 0;
      security.mixed_danger = pageAnalysis.mixedDangerCount > 0;
      security.suspicious_patterns = pageAnalysis.patterns || [];
      console.log(`[analyzer] Security: ssl=${security.ssl_valid}, mixed_content=${security.has_mixed_content}, mixed_danger=${security.mixed_danger}, patterns=${security.suspicious_patterns.length}`);
    } catch (err) {
      console.error('[analyzer] Security analysis error:', err.message);
    }

    return security;
  }

  /**
   * Detect phishing kit / template indicators: password fields, credential forms, brand impersonation.
   * @param {import('puppeteer').Page} page - Puppeteer page.
   * @param {string} pageUrl - Final page URL (for hostname check).
   * @returns {Promise<{ indicators: string[] }>}
   */
  async detectPhishingIndicators(page, pageUrl) {
    let hostname = '';
    try {
      hostname = (new URL(pageUrl)).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return { indicators: [] };
    }

    try {
      const indicators = await page.evaluate((currentHost) => {
        const out = [];
        const body = document.body ? document.body.innerText : '';
        const title = (document.title || '').toLowerCase();
        const html = document.documentElement.outerHTML.toLowerCase();

        const passwordInputs = document.querySelectorAll('input[type="password"]');
        const signInText = /sign\s*in|log\s*in|login|connexion|anmelden|accedi|iniciar\s*sesión/i;
        const authInputs = document.querySelectorAll('input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[name*="email"], input[type="password"], input[name*="pass"]');
        // Only flag brand impersonation when the page looks like a credential page (reduces FP from "Sign in with Google", analytics, etc.)
        const hasCredentialContext = passwordInputs.length > 0 || ((signInText.test(body) || signInText.test(title)) && authInputs.length >= 2);

        // Known brands often impersonated in phishing (domain must NOT match); only when page has login/credential context
        const brands = [
          { name: 'Microsoft', domains: ['microsoft.com', 'login.live.com', 'outlook.com', 'office.com'] },
          { name: 'Google', domains: ['google.com', 'accounts.google.com', 'gmail.com'] },
          { name: 'Apple', domains: ['apple.com', 'icloud.com'] },
          { name: 'Amazon', domains: ['amazon.com', 'amazon.'] },
          { name: 'PayPal', domains: ['paypal.com'] },
          { name: 'Netflix', domains: ['netflix.com'] },
          { name: 'Facebook', domains: ['facebook.com', 'fb.com', 'meta.com'] },
          { name: 'LinkedIn', domains: ['linkedin.com'] },
          { name: 'Dropbox', domains: ['dropbox.com'] },
          { name: 'Adobe', domains: ['adobe.com'] },
          { name: 'DHL', domains: ['dhl.'] },
          { name: 'FedEx', domains: ['fedex.com'] },
          { name: 'UPS', domains: ['ups.com'] },
          { name: 'Bank', domains: [] }, // generic "bank" / "sign in to your account"
        ];

        if (hasCredentialContext) {
          for (const b of brands) {
            const nameLower = b.name.toLowerCase();
            const inPage = body.includes(b.name) || title.includes(nameLower) || html.includes(nameLower);
            if (!inPage) continue;
            const domainMatches = b.domains.length && b.domains.some((d) => currentHost.includes(d) || d.includes(currentHost));
            if (!domainMatches && b.domains.length > 0) {
              out.push(`Brand "${b.name}" mentioned but domain is not ${b.domains[0]} (possible impersonation)`);
            }
          }
        }

        // Password field + form (credential harvesting)
        if (passwordInputs.length > 0) {
          const formsWithPassword = Array.from(document.querySelectorAll('form')).filter((f) => f.querySelector('input[type="password"]'));
          const hasExternalAction = formsWithPassword.some((f) => {
            const action = (f.getAttribute('action') || '').trim();
            if (!action || action.startsWith('#') || action.startsWith('/')) return false;
            try {
              return new URL(action, document.location.href).origin !== document.location.origin;
            } catch {
              return true;
            }
          });
          if (hasExternalAction) out.push('Login form with password field submits to external URL (credential harvesting)');
          else if (passwordInputs.length >= 2) out.push('Multiple password fields on page (unusual for login)');
          else out.push('Page contains password input (login/credential form)');
        }

        // Generic "sign in" / "log in" without obvious brand
        if (signInText.test(body) || signInText.test(title)) {
          const hasUserOrPass = authInputs.length >= 2;
          if (hasUserOrPass && passwordInputs.length > 0) out.push('Sign-in / login form with user and password fields');
        }

        return out;
      }, hostname);

      return { indicators: indicators || [] };
    } catch (err) {
      console.warn('[analyzer] Phishing detection error:', err.message);
      return { indicators: [] };
    }
  }

  /**
   * Compute risk score 0–100 and list of risk factors. Conservative thresholds to reduce false positives:
   * only strong or combined signals contribute meaningfully; weak/ambiguous signals are down-weighted or gated.
   * @param {Array} networkRequests - Captured network requests.
   * @param {Array} scripts - Captured scripts (inline and external).
   * @param {Array} redirectChain - Redirect chain from navigation.
   * @param {object} security - Result of analyzeSecurityIndicators.
   * @param {Array} [clipboardReads=[]] - Intercepted clipboard writes (content, trigger).
   * @returns {{ riskScore: number, riskFactors: string[] }}
   */
  computeRisk(networkRequests, scripts, redirectChain, security, clipboardReads = []) {
    let riskScore = 0;
    const riskFactors = [];

    // Redirects: only flag long chains (many legit sites do 2–3). Threshold 5+, modest points.
    if (redirectChain.length >= 5) {
      riskScore += 10;
      riskFactors.push(`Long redirect chain (${redirectChain.length})`);
    }

    // Third-party: modern sites often have 20+. Only flag very high counts.
    const thirdParty = networkRequests.filter((r) => r.is_third_party);
    if (thirdParty.length > 50) {
      riskScore += 8;
      riskFactors.push(`Very high third-party requests (${thirdParty.length})`);
    }

    // No HTTPS: strong signal, keep but slightly lower to leave room for other factors.
    if (security.ssl_valid === false) {
      riskScore += 22;
      riskFactors.push('No HTTPS');
    }

    // Mixed content: only score dangerous mixed (script/iframe), and only if multiple or any script.
    if (security.mixed_danger) {
      riskScore += 12;
      riskFactors.push('Mixed content (script or iframe over HTTP)');
    } else if (security.has_mixed_content) {
      riskScore += 3;
      riskFactors.push('Mixed content (images/resources)');
    }

    // Suspicious patterns: cap total contribution and use lower per-pattern points (many patterns are FP-prone).
    const maxPatternScore = 25;
    const perPattern = 6;
    let patternScore = 0;
    for (const pattern of (security.suspicious_patterns || [])) {
      patternScore = Math.min(patternScore + perPattern, maxPatternScore);
      riskFactors.push(pattern);
    }
    riskScore += patternScore;

    // Inline scripts: many sites have 10+. Only flag very high counts.
    const inlineScripts = scripts.filter((s) => s.is_inline);
    if (inlineScripts.length > 25) {
      riskScore += 6;
      riskFactors.push(`Very high inline scripts (${inlineScripts.length})`);
    }

    // Clipboard: only flag when strongly suggestive of hijack (multiple writes, or write not from user click).
    const nonEmptyClipboard = clipboardReads.filter((r) => r.content && r.content.length > 0);
    const triggerStr = (t) => (t || '').toLowerCase();
    const autoClipboard = nonEmptyClipboard.filter((r) => {
      const t = triggerStr(r.trigger);
      return !t || t.startsWith('stop') || t.includes('poll') || t.includes('navigation');
    });
    if (nonEmptyClipboard.length >= 2) {
      riskScore += 22;
      riskFactors.push(`Repeated clipboard writes (${nonEmptyClipboard.length}) — possible hijack`);
    } else if (autoClipboard.length >= 1) {
      riskScore += 18;
      riskFactors.push('Clipboard write without user action');
    } else if (nonEmptyClipboard.length >= 1) {
      riskScore += 5;
      riskFactors.push('Clipboard write on user action (low confidence)');
    }

    return { riskScore: Math.min(riskScore, 100), riskFactors };
  }

  /**
   * Remove request/response/console listeners and screenshot interval for this analysis; mark state aborted.
   * @param {string} analysisId - Analysis UUID.
   */
  cleanupAnalysis(analysisId) {
    const state = this.activeAnalyses.get(analysisId);
    if (state) {
      state.aborted = true;
      try {
        const session = this.browserManager.getSession(analysisId);
        if (session?.page && !session.page.isClosed()) {
          session.page.off('request', state.requestHandler);
          session.page.off('response', state.responseHandler);
          session.page.off('requestfailed', state.requestFailedHandler);
          session.page.off('console', state.consoleHandler);
        }
      } catch (err) {
        console.warn(`[analyzer] Cleanup listener removal error: ${err.message}`);
      }
      this.activeAnalyses.delete(analysisId);
    }

    const interval = this.screenshotIntervals.get(analysisId);
    if (interval) {
      clearInterval(interval);
      this.screenshotIntervals.delete(analysisId);
    }
  }

  /**
   * Drain clipboard and detection attempts, cleanup, collect final URL/title/storage/security/DOM, compute risk, send analysis_complete.
   * @param {string} analysisId - Analysis UUID.
   * @returns {Promise<void>}
   */
  async stopAnalysis(analysisId) {
    console.log(`[analyzer] Stopping analysis ${analysisId}`);
    const state = this.activeAnalyses.get(analysisId);
    if (!state || state.aborted) return;

    const sendEvent = state.sendEvent;

    // Drain intercepted clipboard writes before cleanup removes the state
    try {
      const captures = await this.browserManager.drainClipboardCaptures(analysisId);
      for (const cap of captures) {
        if (!cap.content) continue;
        const read = {
          content: cap.content,
          timestamp: cap.timestamp || Date.now(),
          trigger: `stop (${cap.method})`,
        };
        state.clipboardReads.push(read);
        sendEvent({ type: 'clipboard_captured', analysis_id: analysisId, read });
        console.log(`[analyzer] Clipboard write intercepted [${cap.method}] at stop: ${cap.content.length} chars`);
      }
    } catch (err) {
      console.warn(`[analyzer] Clipboard drain at stop: ${err.message}`);
    }

    // Final drain of detection attempts
    try {
      const attempts = await this.browserManager.drainDetectionAttempts(analysisId);
      for (const attempt of attempts) {
        state.detectionAttempts.push(attempt);
        sendEvent({ type: 'detection_event', analysis_id: analysisId, attempt });
      }
    } catch (err) {
      console.warn(`[analyzer] Detection drain at stop: ${err.message}`);
    }

    this.cleanupAnalysis(analysisId);

    let finalUrl = null;
    let title = null;
    let security = { ssl_valid: null, ssl_issuer: null, ssl_protocol: null, has_mixed_content: false, suspicious_patterns: [] };
    let phishingResult = { indicators: [] };
    try {
      const page = await this.browserManager.getPage(analysisId);
      finalUrl = page.url();
      title = await page.title();

      // Cookie / storage inspection (main frame)
      try {
        const cookies = await page.cookies();
        const storage = await page.evaluate(() => ({
          local: Object.entries(localStorage || {}).map(([key, value]) => ({ key, value })),
          session: Object.entries(sessionStorage || {}).map(([key, value]) => ({ key, value })),
        }));
        const cookieList = (cookies || []).map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || null,
          path: c.path || null,
          http_only: c.httpOnly ?? null,
          secure: c.secure ?? null,
          same_site: c.sameSite || null,
        }));
        sendEvent({
          type: 'storage_captured',
          analysis_id: analysisId,
          capture: {
            cookies: cookieList,
            local_storage: storage?.local || [],
            session_storage: storage?.session || [],
          },
        });
        console.log(`[analyzer] Storage: ${cookieList.length} cookies, ${(storage?.local || []).length} localStorage, ${(storage?.session || []).length} sessionStorage`);
      } catch (err) {
        console.warn(`[analyzer] Storage capture error: ${err.message}`);
      }

      // Security headers (last document response for final URL)
      const docHeaders = state.lastDocumentHeadersByUrl[finalUrl];
      if (docHeaders && typeof docHeaders === 'object') {
        const headers = Object.entries(docHeaders).map(([name, value]) => ({ name, value: String(value) }));
        sendEvent({ type: 'security_headers_captured', analysis_id: analysisId, headers });
        console.log(`[analyzer] Security headers: ${headers.length} headers`);
      }

      // DOM snapshot at finish time
      try {
        const html = await page.content();
        if (html) {
          sendEvent({ type: 'dom_snapshot_captured', analysis_id: analysisId, html });
          console.log(`[analyzer] DOM snapshot: ${html.length} chars`);
        }
      } catch (err) {
        console.warn(`[analyzer] DOM snapshot error: ${err.message}`);
      }

      const stopNow = Date.now();
      const currentInline = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('script:not([src])')).map((s) => ({
          url: null,
          is_inline: true,
          size: s.textContent.length,
          hash: null,
          content: s.textContent || null,
        }));
      });
      currentInline.forEach(s => { s.timestamp = stopNow; });

      const existingInlineCount = state.scripts.filter(s => s.is_inline).length;
      const newInline = currentInline.slice(existingInlineCount);
      if (newInline.length > 0) {
        console.log(`[analyzer] Found ${newInline.length} new inline scripts since navigation`);
        state.scripts.push(...newInline);
      }

      security = await this.analyzeSecurityIndicators(page, state.url);

      // Phishing kit / template detection (run while we still have the page)
      phishingResult = await this.detectPhishingIndicators(page, finalUrl || state.url);
      if (phishingResult.indicators.length > 0) {
        console.log(`[analyzer] Phishing indicators: ${phishingResult.indicators.join('; ')}`);
      }
    } catch (err) {
      console.warn(`[analyzer] Report data collection error: ${err.message}`);
    }

    const allScripts = state.scripts;
    const phishingIndicators = phishingResult.indicators || [];

    const { riskScore: baseScore, riskFactors: baseFactors } = this.computeRisk(
      state.networkRequests, allScripts, state.redirectChain, security, state.clipboardReads
    );

    const phishingScore = Math.min(phishingIndicators.length * 12, 28);
    const riskScore = Math.min(baseScore + phishingScore, 100);
    const riskFactors = [...baseFactors];
    for (const ind of phishingIndicators) {
      riskFactors.push(`Phishing: ${ind}`);
    }

    console.log(`[analyzer] Report for ${analysisId}: risk=${riskScore}/100, ${state.networkRequests.length} requests, ${allScripts.length} scripts, ${state.detectionAttempts.length} detection probes, ${phishingIndicators.length} phishing indicators`);
    sendEvent({
      type: 'analysis_complete',
      analysis_id: analysisId,
      report: {
        final_url: finalUrl,
        page_title: title,
        redirect_chain: state.redirectChain,
        network_requests: state.networkRequests.map(r => { const { _request, ...rest } = r; return rest; }),
        scripts: allScripts,
        console_logs: state.consoleLogs,
        clipboard_reads: state.clipboardReads,
        detection_attempts: state.detectionAttempts,
        security,
        risk_score: riskScore,
        risk_factors: riskFactors,
        phishing_indicators: phishingIndicators,
        engine: config.browser.engine || 'puppeteer',
        headless: config.browser.headless !== false,
      },
    });
  }

  /**
   * Drain clipboard captures from the page, push to state.clipboardReads, send clipboard_captured events.
   * @param {string} analysisId - Analysis UUID.
   * @param {string} [trigger='poll'] - Trigger label (e.g. 'poll', 'navigation', 'click').
   * @returns {Promise<void>}
   */
  async _drainAndReportClipboard(analysisId, trigger = 'poll') {
    const state = this.activeAnalyses.get(analysisId);
    if (!state?.sendEvent) return;
    try {
      const captures = await this.browserManager.drainClipboardCaptures(analysisId);
      for (const cap of captures) {
        if (!cap.content) continue;
        const read = {
          content: cap.content,
          timestamp: cap.timestamp || Date.now(),
          trigger: `${trigger} (${cap.method})`,
        };
        state.clipboardReads.push(read);
        state.sendEvent({ type: 'clipboard_captured', analysis_id: analysisId, read });
        console.log(`[analyzer] Clipboard write intercepted [${cap.method}] after ${trigger}: ${cap.content.length} chars`);
      }
    } catch (err) {
      console.warn(`[analyzer] Clipboard drain (${trigger}): ${err.message}`);
    }
  }

  /**
   * Convenience: drain and report clipboard for a given trigger (e.g. 'click', 'keypress').
   * @param {string} analysisId - Analysis UUID.
   * @param {string} [trigger='click'] - Trigger label for the report.
   * @returns {Promise<void>}
   */
  async reportClipboard(analysisId, trigger = 'click') {
    await this._drainAndReportClipboard(analysisId, trigger);
  }

  /**
   * Drain detection attempts from the page, push to state.detectionAttempts, send detection_event events.
   * @param {string} analysisId - Analysis UUID.
   * @returns {Promise<void>}
   */
  async _drainAndReportDetection(analysisId) {
    const state = this.activeAnalyses.get(analysisId);
    if (!state?.sendEvent) return;
    try {
      const attempts = await this.browserManager.drainDetectionAttempts(analysisId);
      for (const attempt of attempts) {
        state.detectionAttempts.push(attempt);
        state.sendEvent({ type: 'detection_event', analysis_id: analysisId, attempt });
      }
      if (attempts.length > 0) {
        console.log(`[analyzer] Detected ${attempts.length} detection probe(s) for ${analysisId}`);
      }
    } catch (err) {
      console.warn(`[analyzer] Detection drain: ${err.message}`);
    }
  }
}
