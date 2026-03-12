/**
 * Preset User-Agent strings for simulating different devices/browsers.
 * Used when "User agent" selector is not Default or Custom.
 */
const USER_AGENT_PRESETS = {
  'chrome-desktop': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'safari-iphone': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'chrome-android': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'firefox-desktop': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
};

/** Verdict tag values stored in analysis.tags. */
const VERDICT_TAGS = Object.freeze({
  FALSE_POSITIVE: 'false positive',
  MALICIOUS: 'malicious',
  PHISHING: 'phishing',
  CLICK_FIX: 'click fix',
});
const VERDICT_TAG_LIST = [VERDICT_TAGS.FALSE_POSITIVE, VERDICT_TAGS.MALICIOUS, VERDICT_TAGS.PHISHING, VERDICT_TAGS.CLICK_FIX];

/** Get verdict and subtype from a tags array for UI state. */
function getVerdictFromTags(tags) {
  if (!Array.isArray(tags)) return { verdict: null, subtype: null };
  const set = new Set(tags.map((t) => String(t).toLowerCase()));
  let verdict = null;
  let subtype = null;
  if (set.has(VERDICT_TAGS.FALSE_POSITIVE)) verdict = 'false_positive';
  else if (set.has(VERDICT_TAGS.MALICIOUS)) {
    verdict = 'malicious';
    if (set.has(VERDICT_TAGS.PHISHING)) subtype = 'phishing';
    else if (set.has(VERDICT_TAGS.CLICK_FIX)) subtype = 'click_fix';
  }
  return { verdict, subtype };
}

/** Label for display next to status (one line: "False positive" or "Phishing" etc.). */
function getVerdictLabel(tags) {
  if (!Array.isArray(tags)) return null;
  const s = new Set(tags.map((t) => String(t).toLowerCase()));
  if (s.has(VERDICT_TAGS.FALSE_POSITIVE)) return 'False positive';
  if (s.has(VERDICT_TAGS.PHISHING)) return 'Phishing';
  if (s.has(VERDICT_TAGS.CLICK_FIX)) return 'Click fix';
  if (s.has(VERDICT_TAGS.MALICIOUS)) return 'Malicious';
  return null;
}

/**
 * Main dashboard UI: URL submit, analysis list, viewer WebSocket, viewport interaction,
 * report panels (Network, Scripts, Console, Raw, Screenshots, Security), risk badge.
 */
class App {
  constructor() {
    this.currentAnalysisId = null;
    this.ws = null;
    this.activeTool = 'interact';
    this.networkRequests = [];
    this.scripts = [];
    this.consoleLogs = [];
    this.security = null;
    this.riskScore = null;
    this.riskFactors = [];
    this.rawFiles = [];
    this.clipboardReads = [];
    this.detectionAttempts = [];
    this.pageSource = null;
    this.domSnapshot = null;
    this.storageCapture = null;
    this.phishingIndicators = [];
    this.securityHeaders = [];
    this.redirectChain = [];
    this.finalUrl = null;
    this.pageTitle = null;
    this.screenshotTimeline = [];
    this.screenshotTimelineCount = 0;
    this.lastMouseMoveTime = 0;
    this.screenshotCount = 0;
    this.wsEventCount = 0;
    this.analysisStartTime = null;
    this._reportSearchQuery = '';
    this._scrubberIndex = 0;
    this.webrtcPc = null;
    this.iceServers = [];
    this.wsBytesSent = 0;
    this.wsBytesReceived = 0;
    this.webrtcRttMs = null;
    this.webrtcPacketsLost = null;
    this._connectionStatsInterval = null;

    this.initElements();
    this.initEventListeners();
    if (window.i18n) {
      window.i18n.applyTheme();
      window.i18n.applyLang();
      window.onLangChange = () => this.onLangChange();
    }
    this.loadAnalyses();
    this.pollAgentStatus();
    this.initPermalink();
    this.initSettings();
    this.initNotesTags();
    this.initReportActions();
    this.initReportSearch();
    this.initAdvancedFilters();
    this.initScrubber();
    this.initGeoLocale();
    this.initTagFilter();

    console.log('[ui] App initialized');
  }

  /** Read ?id= from URL and select that analysis if present. */
  initPermalink() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (id) {
      this.selectAnalysis(id);
    }
  }

  /** Settings modal: open/close; load/save VirusTotal API key from localStorage. */
  initSettings() {
    if (!this.settingsBtn || !this.settingsModal) return;
    const VT_KEY_STORAGE = 'virustotal_api_key';
    this.settingsBtn.addEventListener('click', () => {
      if (this.virustotalKeyInput) {
        try {
          this.virustotalKeyInput.value = localStorage.getItem(VT_KEY_STORAGE) || '';
        } catch (_) {}
      }
      this.settingsModal.style.display = 'flex';
      this.settingsModal.setAttribute('aria-hidden', 'false');
    });
    const saveAndClose = () => {
      if (this.virustotalKeyInput) {
        try {
          const v = this.virustotalKeyInput.value.trim();
          if (v) localStorage.setItem(VT_KEY_STORAGE, v);
          else localStorage.removeItem(VT_KEY_STORAGE);
        } catch (_) {}
      }
      this.settingsModal.style.display = 'none';
      this.settingsModal.setAttribute('aria-hidden', 'true');
    };
    this.settingsClose.addEventListener('click', saveAndClose);
    this.settingsModal.addEventListener('click', (e) => {
      if (e.target === this.settingsModal) saveAndClose();
    });
  }

  /** Geo/locale row toggle and include in submit. */
  initGeoLocale() {
    if (!this.geoToggle || !this.geoLocaleRow) return;
    this.geoToggle.addEventListener('click', () => {
      const isHidden = this.geoLocaleRow.style.display === 'none';
      this.geoLocaleRow.style.display = isHidden ? 'grid' : 'none';
      this.geoToggle.classList.toggle('active', isHidden);
      const icon = this.geoToggle.querySelector('.geo-toggle-icon');
      const text = this.geoToggle.querySelector('.geo-toggle-text');
      if (icon) icon.textContent = isHidden ? '▲' : '▼';
      if (text) text.textContent = isHidden ? 'Hide location' : 'Set location';
    });
  }

  /** Notes/tags: verdict buttons only (no custom tags), save via PATCH. */
  initNotesTags() {
    if (!this.notesInput || !this.tagsChips || !this.saveNotesTagsBtn) return;
    this.saveNotesTagsBtn.addEventListener('click', () => this.saveNotesAndTags());
    document.querySelectorAll('.verdict-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const verdict = btn.dataset.verdict;
        this.setVerdict(verdict, null);
        if (verdict === 'malicious' && this.verdictSubtypeRow) this.verdictSubtypeRow.style.display = 'flex';
        else if (this.verdictSubtypeRow) this.verdictSubtypeRow.style.display = 'none';
        this.updateVerdictButtonsState();
      });
    });
    document.querySelectorAll('.verdict-subtype-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setVerdict('malicious', btn.dataset.subtype);
        this.updateVerdictButtonsState();
      });
    });
  }

  /** Replace verdict-related tags with the new verdict (and optional subtype). Only predefined verdict tags are used. */
  setVerdict(verdict, subtype) {
    let tags = this.getCurrentTags().filter((t) => VERDICT_TAG_LIST.includes(t.toLowerCase()));
    if (verdict === 'false_positive') tags = [VERDICT_TAGS.FALSE_POSITIVE];
    else if (verdict === 'malicious') {
      tags = [VERDICT_TAGS.MALICIOUS];
      if (subtype === 'phishing') tags.push(VERDICT_TAGS.PHISHING);
      else if (subtype === 'click_fix') tags.push(VERDICT_TAGS.CLICK_FIX);
    }
    this.renderTagsChips(tags);
    this.saveNotesAndTags();
  }

  /** Sync verdict buttons and subtype row with current tags. */
  updateVerdictButtonsState() {
    const tags = this.getCurrentTags();
    const { verdict, subtype } = getVerdictFromTags(tags);
    document.querySelectorAll('.verdict-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.verdict === verdict);
    });
    document.querySelectorAll('.verdict-subtype-btn').forEach((btn) => {
      btn.classList.toggle('active', verdict === 'malicious' && btn.dataset.subtype === subtype);
    });
    if (this.verdictSubtypeRow) this.verdictSubtypeRow.style.display = verdict === 'malicious' ? 'flex' : 'none';
    this.updateReportVerdictBadge(tags);
  }

  /** Show verdict badge in report header. */
  updateReportVerdictBadge(tags) {
    if (!this.reportVerdictBadge) return;
    const label = getVerdictLabel(tags);
    if (!label) {
      this.reportVerdictBadge.style.display = 'none';
      return;
    }
    this.reportVerdictBadge.textContent = label;
    this.reportVerdictBadge.className = 'verdict-badge ' + (label === 'False positive' ? 'false-positive' : 'malicious');
    if (label === 'Phishing') this.reportVerdictBadge.classList.add('phishing');
    else if (label === 'Click fix') this.reportVerdictBadge.classList.add('click-fix');
    this.reportVerdictBadge.style.display = 'inline-block';
  }

  getCurrentTags() {
    const chips = this.tagsChips.querySelectorAll('.tag-chip');
    return Array.from(chips).map((c) => c.dataset.tag || c.textContent.trim()).filter(Boolean);
  }

  renderTagsChips(tags) {
    const allowed = (tags || []).filter((t) => VERDICT_TAG_LIST.includes(String(t).toLowerCase()));
    this.tagsChips.innerHTML = allowed
      .map(
        (tag) =>
          `<span class="tag-chip" data-tag="${this.esc(tag)}">${this.esc(tag)} <span class="tag-remove" data-tag="${this.esc(tag)}" aria-label="Remove">×</span></span>`
      )
      .join('');
    this.tagsChips.querySelectorAll('.tag-remove').forEach((el) => {
      el.addEventListener('click', () => {
        const t = el.dataset.tag;
        const newTags = this.getCurrentTags().filter((x) => x !== t);
        this.renderTagsChips(newTags);
        this.updateVerdictButtonsState();
        this.saveNotesAndTags();
      });
    });
  }

  async saveNotesAndTags() {
    if (!this.currentAnalysisId) return;
    const notes = this.notesInput.value.trim();
    const tags = this.getCurrentTags().filter((t) => VERDICT_TAG_LIST.includes(String(t).toLowerCase()));
    try {
      const res = await fetch(`/api/analyses/${this.currentAnalysisId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notes || null, tags }),
      });
      if (!res.ok) throw new Error(await res.text());
      console.log('[ui] Notes/tags saved');
    } catch (err) {
      console.error('[ui] Save notes/tags failed:', err);
      alert('Failed to save: ' + err.message);
    }
  }

  /** Copy permalink, Export PDF, VirusTotal check. */
  initReportActions() {
    if (this.copyLinkBtn) {
      this.copyLinkBtn.addEventListener('click', () => {
        const url = new URL(window.location.href);
        url.searchParams.set('id', this.currentAnalysisId || '');
        navigator.clipboard.writeText(url.toString()).then(() => {
          this.copyLinkBtn.title = 'Copied!';
          setTimeout(() => { this.copyLinkBtn.title = 'Copy permalink'; }, 2000);
        });
      });
    }
    if (this.exportPdfBtn) {
      this.exportPdfBtn.addEventListener('click', () => this.exportReportPdf());
    }
    if (this.virustotalBtn) {
      this.virustotalBtn.addEventListener('click', () => this.checkVirusTotal());
    }
    if (this.exportHarBtn) {
      this.exportHarBtn.addEventListener('click', () => this.exportReportHar());
    }
    if (this.exportVideoBtn) {
      this.exportVideoBtn.addEventListener('click', () => this.exportSessionVideo());
    }
  }

  /** Build HAR 1.2 log from current report network requests and trigger download. */
  exportReportHar() {
    const requests = this.networkRequests || [];
    const pageUrl = this.currentAnalysisUrl || this.finalUrl || '';
    const pageTitle = this.pageTitle || '';
    const entries = requests.map((r) => {
      const ts = typeof r.timestamp === 'number' ? r.timestamp : 0;
      const startDate = new Date(ts);
      const startedDateTime = startDate.toISOString();
      const reqHeaders = [];
      if (r.request_headers && typeof r.request_headers === 'object') {
        if (Array.isArray(r.request_headers)) {
          r.request_headers.forEach((h) => { if (h && h.name != null) reqHeaders.push({ name: String(h.name), value: String(h.value ?? '') }); });
        } else {
          Object.entries(r.request_headers).forEach(([k, v]) => reqHeaders.push({ name: k, value: String(v ?? '') }));
        }
      }
      const resHeaders = [];
      if (r.response_headers && typeof r.response_headers === 'object') {
        if (Array.isArray(r.response_headers)) {
          r.response_headers.forEach((h) => { if (h && h.name != null) resHeaders.push({ name: String(h.name), value: String(h.value ?? '') }); });
        } else {
          Object.entries(r.response_headers).forEach(([k, v]) => resHeaders.push({ name: k, value: String(v ?? '') }));
        }
      }
      const time = (r.timing && typeof r.timing === 'object' && r.timing.receiveHeadersEnd != null && r.timing.sendStart != null)
        ? Math.round((r.timing.receiveHeadersEnd - r.timing.sendStart) * 1000) : 0;
      return {
        startedDateTime,
        time: Math.max(0, time),
        request: {
          method: r.method || 'GET',
          url: r.url || '',
          httpVersion: 'HTTP/1.1',
          headers: reqHeaders.length ? reqHeaders : [{ name: 'Host', value: '' }],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: r.request_body ? new Blob([r.request_body]).size : -1,
          postData: r.request_body ? { mimeType: 'application/octet-stream', text: r.request_body } : undefined,
        },
        response: {
          status: r.status || 0,
          statusText: r.status_text || '',
          httpVersion: 'HTTP/1.1',
          headers: resHeaders.length ? resHeaders : [],
          cookies: [],
          content: { size: r.size || r.response_size || 0, mimeType: r.content_type || 'application/octet-stream', text: '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
      };
    });
    const log = {
      version: '1.2',
      creator: { name: 'Carabistouille', version: '1.0' },
      browser: { name: '', version: '' },
      pages: pageUrl ? [{ startedDateTime: new Date().toISOString(), id: 'page_1', title: pageTitle || pageUrl, pageTimings: {} }] : [],
      entries,
    };
    const blob = new Blob([JSON.stringify({ log }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analysis-${(this.currentAnalysisId || 'export').slice(0, 8)}.har`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Full-text search across report: on input re-render all panels with global query. */
  initReportSearch() {
    if (!this.reportSearchInput) return;
    this.reportSearchInput.addEventListener('input', () => {
      this._reportSearchQuery = (this.reportSearchInput.value || '').trim().toLowerCase();
      this.renderNetworkPanel();
      this.renderScriptsPanel();
      this.renderConsolePanel();
      this.renderRawPanel();
      if (document.getElementById('panel-session')?.classList.contains('active')) this.renderSessionPanel();
    });
  }

  /** Advanced filters: date, risk, has redirects/clipboard/mixed. Applied in renderAnalysesList. */
  initAdvancedFilters() {
    const ids = ['filter-date-from', 'filter-date-to', 'filter-risk-min', 'filter-risk-max', 'filter-has-redirects', 'filter-has-clipboard', 'filter-has-mixed'];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this.loadAnalyses());
    });
  }

  /** Screenshot timeline scrubber: slider updates viewport image to selected frame. */
  initScrubber() {
    if (!this.screenshotScrubber || !this.scrubberValue) return;
    this.screenshotScrubber.addEventListener('input', () => {
      const idx = parseInt(this.screenshotScrubber.value, 10);
      this._scrubberIndex = idx;
      const entry = this.screenshotTimeline[idx];
      if (entry && this.viewportImg) {
        const mime = entry.data.startsWith('UklG') ? 'image/webp' : 'image/jpeg';
        this.viewportImg.src = `data:${mime};base64,${entry.data}`;
        this.viewportPlaceholder.style.display = 'none';
        this.viewportImg.style.display = 'block';
      }
      if (this.scrubberValue) this.scrubberValue.textContent = `${idx + 1} / ${this.screenshotTimeline.length}`;
    });
  }

  async checkVirusTotal() {
    const id = this.currentAnalysisId;
    if (!id) {
      alert('No analysis selected.');
      return;
    }
    let apiKey = '';
    try {
      apiKey = (localStorage.getItem('virustotal_api_key') || '').trim();
    } catch (_) {}
    if (!apiKey) {
      this.virustotalResult.style.display = 'block';
      this.virustotalResult.textContent = 'Add your VirusTotal API key in Settings (gear icon), or set VIRUSTOTAL_API_KEY on the server.';
      return;
    }
    this.virustotalResult.style.display = 'block';
    this.virustotalResult.textContent = 'Checking VirusTotal...';
    try {
      const res = await fetch(`/api/analyses/${id}/virustotal`, {
        headers: { 'X-VirusTotal-API-Key': apiKey },
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try {
          const j = JSON.parse(text);
          if (j && typeof j === 'string') msg = j;
          else if (j && typeof j === 'object') msg = j.error || j.message || text;
        } catch (_) {}
        if (res.status === 503 && !text) msg = 'VirusTotal not configured. Set VIRUSTOTAL_API_KEY on the server.';
        this.virustotalResult.innerHTML = `Error: ${this.esc(msg)}`;
        return;
      }
      const data = await res.json();
      const malicious = data.malicious ?? 0;
      const suspicious = data.suspicious ?? 0;
      const harmless = data.harmless ?? 0;
      const undetected = data.undetected ?? 0;
      const total = data.total ?? 0;
      const reportUrl = data.report_url || '#';
      const checkedUrl = data.checked_url || '';
      const dateTs = data.last_analysis_date;
      const dateStr = dateTs ? new Date(dateTs * 1000).toLocaleString() : '';
      const parts = [
        `VirusTotal results for <code class="vt-url">${this.esc(checkedUrl)}</code>`,
        dateStr ? `Last scanned: ${dateStr}` : '',
        `<strong>Malicious:</strong> ${malicious} · <strong>Suspicious:</strong> ${suspicious} · <strong>Harmless:</strong> ${harmless} · <strong>Undetected:</strong> ${undetected} (${total} engines)`,
        reportUrl !== '#' ? `<a href="${this.esc(reportUrl)}" target="_blank" rel="noopener">View full report on VirusTotal</a>` : '',
      ].filter(Boolean);
      this.virustotalResult.innerHTML = `<div class="vt-details">${parts.map((p) => `<div>${p}</div>`).join('')}</div>`;
    } catch (err) {
      this.virustotalResult.textContent = 'VirusTotal check failed: ' + err.message;
    }
  }

  async exportReportPdf() {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) {
      alert('PDF library not loaded.');
      return;
    }
    const id = this.currentAnalysisId;
    const margin = 18;
    const pageW = 210;
    const lineHeight = 6;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    let y = margin;

    const addSection = (title, size = 12) => {
      if (y > 250) { doc.addPage(); y = margin; }
      doc.setFontSize(size);
      doc.setFont(undefined, 'bold');
      doc.text(title, margin, y);
      y += lineHeight + 2;
      doc.setFont(undefined, 'normal');
    };
    const addLine = (label, value, wrap = 85) => {
      if (y > 275) { doc.addPage(); y = margin; }
      const str = `${label} ${value}`;
      const lines = doc.splitTextToSize(str, wrap);
      doc.setFontSize(10);
      doc.text(lines, margin, y);
      y += lineHeight * lines.length;
    };

    doc.setFontSize(20);
    doc.setFont(undefined, 'bold');
    doc.text('Carabistouille Report', margin, y);
    y += lineHeight * 2;
    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    doc.text(`Exported on ${new Date().toISOString()}`, margin, y);
    y += lineHeight * 2;

    const url = this.currentAnalysisUrl || '';
    const status = this.currentStatus || '';
    const risk = this.riskScore != null ? this.riskScore : '';
    const factors = (this.riskFactors || []).join(', ');
    const notes = this.notesInput ? this.notesInput.value : '';
    const tags = this.getCurrentTags ? this.getCurrentTags() : [];

    addSection('Summary', 12);
    addLine('URL:', url);
    addLine('Final URL:', this.finalUrl || url);
    addLine('Status:', status);
    addLine('Risk score:', String(risk));
    addLine('Risk factors:', factors || '—');
    addLine('Verdict/Tags:', tags.length ? tags.join(', ') : '—');
    addLine('Notes:', notes || '—');
    y += 2;

    addSection('Report details', 11);
    addLine('Network requests:', String((this.networkRequests || []).length));
    addLine('Scripts captured:', String((this.scripts || []).length));
    addLine('Console logs:', String((this.consoleLogs || []).length));
    addLine('Raw files:', String((this.rawFiles || []).length));
    addLine('Clipboard reads:', String((this.clipboardReads || []).length));
    addLine('Detection attempts:', String((this.detectionAttempts || []).length));
    addLine('Security headers:', String((this.securityHeaders || []).length));
    addLine('Redirects:', String((this.redirectChain || []).length));
    if (this.engine) addLine('Engine:', this.engine);
    if (this.headless != null) addLine('Headless:', String(this.headless));
    y += 2;

    if (this.redirectChain && this.redirectChain.length > 0) {
      addSection('Redirect chain', 11);
      this.redirectChain.forEach((r, i) => {
        addLine(`${i + 1}.`, r.from || r.to || '', 80);
      });
      y += 2;
    }

    let analysis = null;
    let screenshotTimeline = [];
    try {
      if (id) {
        const [resAnalysis, resScreenshots] = await Promise.all([
          fetch(`/api/analyses/${id}`),
          fetch(`/api/analyses/${id}/screenshots`),
        ]);
        if (resAnalysis.ok) analysis = await resAnalysis.json();
        if (resScreenshots.ok) screenshotTimeline = await resScreenshots.json();
      }
    } catch (e) {
      console.warn('[ui] PDF: could not fetch analysis/screenshots', e);
    }

    const mainScreenshot = analysis && analysis.screenshot ? analysis.screenshot : null;
    const maxImgW = pageW - 2 * margin;
    const maxImgH = 120;

    const toJpegBase64 = (base64, format) => {
      if (!base64 || format !== 'WEBP') return base64;
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          try {
            resolve(canvas.toDataURL('image/jpeg', 0.85).replace(/^data:image\/jpeg;base64,/, ''));
          } catch (e) {
            resolve(base64);
          }
        };
        img.onerror = () => resolve(base64);
        img.src = `data:image/webp;base64,${base64}`;
      });
    };
    const imgFormat = (base64) => (base64 && base64.startsWith('UklG') ? 'WEBP' : 'JPEG');

    if (mainScreenshot) {
      if (y > 200) { doc.addPage(); y = margin; }
      addSection('Screenshot (final)', 11);
      y += 2;
      const format = imgFormat(mainScreenshot);
      const data = format === 'WEBP' ? await toJpegBase64(mainScreenshot, 'WEBP') : mainScreenshot;
      const useFormat = format === 'WEBP' ? 'JPEG' : format;
      try {
        const imgW = maxImgW;
        const imgH = Math.min(maxImgH, imgW * 0.75);
        doc.addImage(data, useFormat, margin, y, imgW, imgH);
        y += imgH + lineHeight;
      } catch (e) {
        doc.setFontSize(9);
        doc.text('(Image could not be embedded)', margin, y);
        y += lineHeight;
      }
      y += 4;
    }

    const timelineToAdd = (screenshotTimeline && Array.isArray(screenshotTimeline)) ? screenshotTimeline.slice(0, 6) : (this.screenshotTimeline || []).slice(0, 6);
    if (timelineToAdd.length > 0) {
      addSection('Screenshot timeline', 11);
      y += 2;
      const firstTs = timelineToAdd[0].timestamp;
      for (let i = 0; i < timelineToAdd.length; i++) {
        const ss = timelineToAdd[i];
        if (y > 220) { doc.addPage(); y = margin; }
        const relSec = ((ss.timestamp - firstTs) / 1000).toFixed(0);
        doc.setFontSize(9);
        doc.text(`Screenshot ${i + 1} (+${relSec}s)`, margin, y);
        y += 4;
        const format = imgFormat(ss.data);
        const data = format === 'WEBP' ? await toJpegBase64(ss.data, 'WEBP') : ss.data;
        const useFormat = format === 'WEBP' ? 'JPEG' : format;
        try {
          const imgW = maxImgW;
          const imgH = Math.min(60, imgW * 0.6);
          doc.addImage(data, useFormat, margin, y, imgW, imgH);
          y += imgH + 6;
        } catch (e) {
          doc.text('(Image not embedded)', margin, y);
          y += lineHeight + 4;
        }
      }
      y += 4;
    }

    const name = `carabistouille-report-${id ? id.slice(0, 8) : 'export'}.pdf`;
    doc.save(name);
  }

  /** Tag filter in sidebar: collect all tags from analyses, filter list by selected tag. */
  initTagFilter() {
    // Tag filter chips are populated when we render the list; clicking a chip filters the list.
    this._selectedTagFilter = null;
  }

  /**
   * Translate a key using i18n if available.
   * @param {string} key - Translation key.
   * @returns {string}
   */
  t(key) {
    return window.i18n ? window.i18n.t(key) : key;
  }

  /** Re-render all report panels and agent status when language changes. */
  onLangChange() {
    this.updateAgentStatusText();
    this.renderNetworkPanel();
    this.renderScriptsPanel();
    this.renderConsolePanel();
    this.renderRawPanel();
    this.renderScreenshotsPanel();
    this.renderSecurityPanel();
    this.renderDetectionPanel();
    this.renderSessionPanel();
  }

  /** Update agent status label (connected / disconnected) using current language. */
  updateAgentStatusText() {
    if (!this.agentStatus || !this.statusText) return;
    if (this.agentStatus.classList.contains('connected')) {
      this.statusText.textContent = this.t('app.agentConnected');
    } else {
      this.statusText.textContent = this.t('app.agentDisconnected');
    }
  }

  /** Cache DOM references for form, viewport, panels, buttons. */
  initElements() {
    this.urlForm = document.getElementById('url-form');
    this.urlInput = document.getElementById('url-input');
    this.proxyInput = document.getElementById('proxy-input');
    this.proxyToggle = document.getElementById('proxy-toggle');
    this.userAgentSelect = document.getElementById('user-agent-select');
    this.userAgentCustomRow = document.getElementById('user-agent-custom-row');
    this.userAgentCustomInput = document.getElementById('user-agent-custom');
    this.submitBtn = document.getElementById('submit-btn');
    this.stopBtn = document.getElementById('stop-btn');
    this.analysesList = document.getElementById('analyses-list');
    this.agentStatus = document.getElementById('agent-status');
    this.statusText = this.agentStatus.querySelector('.status-text');
    this.viewportImg = document.getElementById('viewport-img');
    this.viewportPlaceholder = document.getElementById('viewport-placeholder');
    this.viewportWrapper = document.getElementById('viewport-wrapper');
    this.viewportWebrtc = document.getElementById('viewport-webrtc');
    this.viewportVideo = document.getElementById('viewport-video');
    this.viewportWebrtcWaiting = document.getElementById('viewport-webrtc-waiting');
    this.viewportWebrtcWaitingText = document.getElementById('viewport-webrtc-waiting-text');
    this.viewportWebrtcPlaceholder = document.getElementById('viewport-webrtc-placeholder');
    this.inspectHighlight = document.getElementById('inspect-highlight');
    this.elementInspector = document.getElementById('element-inspector');
    this.inspectorContent = document.getElementById('inspector-content');
    this.pageUrl = document.getElementById('page-url');
    this.riskBadge = document.getElementById('risk-badge');
    this.riskScoreEl = document.getElementById('risk-score');
    this.agentModeEl = document.getElementById('agent-mode');
    this.agentEngineEl = document.getElementById('agent-engine');
    this.streamVideoEl = document.getElementById('stream-video');
    this.streamCodecEl = document.getElementById('stream-codec');
    this.streamFpsEl = document.getElementById('stream-fps');
    this.streamInputEl = document.getElementById('stream-input');
    this.streamIceEl = document.getElementById('stream-ice');
    this.networkLabelAgentEl = document.getElementById('network-label-agent');
    this.networkEdgeServerAgentEl = document.getElementById('network-edge-server-agent');
    this.settingsBtn = document.getElementById('settings-btn');
    this.settingsModal = document.getElementById('settings-modal');
    this.settingsClose = document.getElementById('settings-close');
    this.virustotalKeyInput = document.getElementById('virustotal-key-input');
    this.geoLocaleRow = document.getElementById('geo-locale-row');
    this.geoToggle = document.getElementById('geo-toggle');
    this.timezoneInput = document.getElementById('timezone-input');
    this.localeInput = document.getElementById('locale-input');
    this.latitudeInput = document.getElementById('latitude-input');
    this.longitudeInput = document.getElementById('longitude-input');
    this.copyLinkBtn = document.getElementById('copy-link-btn');
    this.exportPdfBtn = document.getElementById('export-pdf-btn');
    this.virustotalBtn = document.getElementById('virustotal-btn');
    this.exportHarBtn = document.getElementById('export-har-btn');
    this.exportVideoBtn = document.getElementById('export-video-btn');
    this.reportSearchInput = document.getElementById('report-search-input');
    this.reportSearchRow = document.getElementById('report-search-row');
    this.screenshotScrubber = document.getElementById('screenshot-scrubber');
    this.scrubberValue = document.getElementById('scrubber-value');
    this.scrubberRow = document.getElementById('screenshot-scrubber-row');
    this.notesTagsSection = document.getElementById('notes-tags-section');
    this.notesInput = document.getElementById('notes-input');
    this.tagsChips = document.getElementById('tags-chips');
    this.saveNotesTagsBtn = document.getElementById('save-notes-tags-btn');
    this.virustotalResult = document.getElementById('virustotal-result');
    this.tagFilter = document.getElementById('tag-filter');
    this.tagFilterChips = document.getElementById('tag-filter-chips');
    this.reportLoading = document.getElementById('report-loading');
    this.reportVerdictBadge = document.getElementById('report-verdict-badge');
    this.verdictSubtypeRow = document.getElementById('verdict-subtype-row');
    this.reportRunOptions = document.getElementById('report-run-options');
    this.reportRunOptionsBody = document.getElementById('report-run-options-body');
    this.connectionStatsEl = document.getElementById('connection-stats');
    this.connectionStatsBytesEl = document.getElementById('connection-stats-bytes');
    this.connectionStatsQualityEl = document.getElementById('connection-stats-quality');
    this.sidebarConnectionStatsEl = document.getElementById('sidebar-connection-stats');
  }

  /** Form submit, tool buttons, stop, proxy toggle, tab clicks, search inputs, viewport click/scroll/mousemove, keyboard, resizer. */
  initEventListeners() {
    this.urlForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitUrl();
    });

    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeTool = btn.dataset.tool;
        this.viewportImg.style.cursor = this.activeTool === 'inspect' ? 'help' : 'crosshair';
        if (this.activeTool !== 'inspect') {
          this.inspectHighlight.style.display = 'none';
          this.elementInspector.style.display = 'none';
        }
        console.log(`[ui] Tool switched to: ${this.activeTool}`);
      });
    });

    this.stopBtn.addEventListener('click', () => this.stopAnalysis());

    this.proxyToggle.addEventListener('click', () => {
      const active = this.proxyToggle.classList.toggle('active');
      this.proxyInput.disabled = !active;
      if (!active) this.proxyInput.value = '';
    });
    this.proxyInput.disabled = true;

    if (this.userAgentSelect) {
      this.userAgentSelect.addEventListener('change', () => {
        const isCustom = this.userAgentSelect.value === 'custom';
        if (this.userAgentCustomRow) this.userAgentCustomRow.style.display = isCustom ? 'block' : 'none';
      });
    }

    document.querySelectorAll('.report-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.report-tabs .tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
        if (tab.dataset.tab === 'screenshots' && this.screenshotTimeline.length === 0 && this.screenshotTimelineCount > 0) {
          this.loadScreenshotTimeline();
        }
        if (tab.dataset.tab === 'session') {
          this.renderSessionPanel();
        }
      });
    });

    document.getElementById('search-network').addEventListener('input', () => this.renderNetworkPanel());
    this._activeNetTypeFilter = 'all';
    document.querySelectorAll('#net-type-filters .net-type-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#net-type-filters .net-type-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._activeNetTypeFilter = btn.dataset.type;
        this.renderNetworkPanel();
      });
    });
    document.getElementById('search-scripts').addEventListener('input', () => this.renderScriptsPanel());
    document.getElementById('search-console').addEventListener('input', () => this.renderConsolePanel());
    document.getElementById('search-raw').addEventListener('input', () => this.renderRawPanel());
    document.querySelectorAll('#raw-extension-filters input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => this.renderRawPanel());
    });

    this.viewportImg.addEventListener('click', (e) => this.handleViewportClick(e));
    this.viewportImg.addEventListener('wheel', (e) => this.handleViewportScroll(e), { passive: false });
    if (this.viewportVideo) {
      this.viewportVideo.addEventListener('click', (e) => this.handleViewportClick(e));
      this.viewportVideo.addEventListener('wheel', (e) => this.handleViewportScroll(e), { passive: false });
    }
    // Document-level mousemove so we keep sending when pointer is over viewport even after clicking elsewhere (viewport loses focus)
    document.addEventListener('mousemove', (e) => {
      if (!this.ws || this.activeTool !== 'interact') return;
      const el = this.streamVideoMode === 'webrtc' && this.viewportVideo?.offsetParent != null
        ? this.viewportVideo
        : this.viewportImg;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width && rect.height &&
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        this.handleViewportMouseMove(e);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (!this.ws || !this.currentAnalysisId) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.classList.contains('search-input')) return;

      if (e.key.length === 1) {
        this.wsSend({ type: 'type_text', text: e.key });
      } else {
        this.wsSend({ type: 'keypress', key: e.key });
      }
      // Prevent Enter (and other keys) from triggering form submit or other page actions while controlling the remote view
      e.preventDefault();
      e.stopPropagation();
    });

    this._initReportResizer();
  }

  /** Initialize drag resizer for the report panel (left edge). */
  _initReportResizer() {
    const resizer = document.getElementById('report-resizer');
    const panel = document.getElementById('report-panel');
    let startX, startWidth;

    const onMouseMove = (e) => {
      const delta = startX - e.clientX;
      const newWidth = Math.max(280, Math.min(startWidth + delta, window.innerWidth * 0.6));
      panel.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = panel.getBoundingClientRect().width;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  /**
   * Get viewport-relative (x, y) from mouse/pointer event (screenshot image or WebRTC video).
   * For WebRTC (Baliverne-style): use video element rect and stream aspect ratio (videoWidth/videoHeight or 1920×1080).
   * @param {MouseEvent|WheelEvent} e - Event.
   * @returns {{ x: number, y: number } | null}
   */
  getViewportCoords(e) {
    if (this.streamVideoMode === 'webrtc' && this.viewportVideo) {
      const rect = this.viewportVideo.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const streamW = this.viewportVideo.videoWidth > 0 ? this.viewportVideo.videoWidth : 1920;
      const streamH = this.viewportVideo.videoHeight > 0 ? this.viewportVideo.videoHeight : 1080;
      const contentAspect = streamW / streamH;
      const rectAspect = rect.width / rect.height;
      let contentLeft, contentTop, contentWidth, contentHeight;
      if (rectAspect > contentAspect) {
        contentHeight = rect.height;
        contentWidth = rect.height * contentAspect;
        contentLeft = rect.left + (rect.width - contentWidth) / 2;
        contentTop = rect.top;
      } else {
        contentWidth = rect.width;
        contentHeight = rect.width / contentAspect;
        contentLeft = rect.left;
        contentTop = rect.top + (rect.height - contentHeight) / 2;
      }
      const x = Math.max(0, Math.min(streamW, ((e.clientX - contentLeft) / contentWidth) * streamW));
      const y = Math.max(0, Math.min(streamH, ((e.clientY - contentTop) / contentHeight) * streamH));
      return { x: Math.round(x), y: Math.round(y) };
    }
    const rect = this.viewportImg.getBoundingClientRect();
    const nw = this.viewportImg.naturalWidth;
    const nh = this.viewportImg.naturalHeight;
    if (!nw || !nh || !rect.width || !rect.height) return null;
    const scaleX = nw / rect.width;
    const scaleY = nh / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  /** Send click or inspect command to agent depending on active tool. */
  /** Handle click on viewport: interact (send click) or inspect (request element at coords). */
  handleViewportClick(e) {
    if (!this.ws) return;
    const coords = this.getViewportCoords(e);
    if (!coords) return;
    const { x, y } = coords;
    console.log(`[ui] Viewport click at (${x.toFixed(0)}, ${y.toFixed(0)}) tool=${this.activeTool}`);

    if (this.activeTool === 'inspect') {
      this.wsSend({ type: 'inspect', x, y });
    } else {
      this.wsSend({ type: 'click', x, y });
    }
  }

  /** Send scroll (delta_x, delta_y) to agent. */
  /** Send scroll delta to agent for current analysis. */
  handleViewportScroll(e) {
    if (!this.ws) return;
    e.preventDefault();
    this.wsSend({ type: 'scroll', delta_x: e.deltaX, delta_y: e.deltaY });
  }

  /** Throttled mousemove: send coordinates to agent for hover/cursor. Use ~60 Hz so Baliverne runtime (which coalesces at 125 Hz) feels responsive; 100 ms was too laggy. */
  handleViewportMouseMove(e) {
    if (!this.ws || this.activeTool !== 'interact') return;

    const now = Date.now();
    if (now - this.lastMouseMoveTime < 16) return; // ~60 Hz for responsive remote cursor
    this.lastMouseMoveTime = now;

    const coords = this.getViewportCoords(e);
    if (!coords) return;
    this.wsSend({ type: 'mousemove', x: coords.x, y: coords.y });
  }

  /** POST /api/analyses with url (and optional proxy), then select the new analysis and connect viewer WS. */
  /** Submit URL form: POST /api/analyze, then connect viewer and load report if already complete. */
  async submitUrl() {
    const url = this.urlInput.value.trim();
    if (!url) return;

    const proxy = this.proxyInput.value.trim() || undefined;
    const userAgentValue = this.userAgentSelect?.value || '';
    const userAgent = userAgentValue === 'custom'
      ? (this.userAgentCustomInput?.value.trim() || undefined)
      : (USER_AGENT_PRESETS[userAgentValue] || undefined);
    console.log(`[ui] Submitting URL: ${url}${proxy ? ` via proxy ${proxy}` : ''}${userAgent ? ' with custom UA' : ''}`);
    this.submitBtn.disabled = true;
    try {
      const body = { url };
      if (proxy) body.proxy = proxy;
      if (userAgent) body.user_agent = userAgent;
      if (this.geoLocaleRow && this.geoLocaleRow.style.display !== 'none') {
        const tz = this.timezoneInput?.value?.trim();
        const loc = this.localeInput?.value?.trim();
        const lat = this.latitudeInput?.value ? parseFloat(this.latitudeInput.value) : undefined;
        const lng = this.longitudeInput?.value ? parseFloat(this.longitudeInput.value) : undefined;
        if (tz) body.timezone_id = tz;
        if (loc) body.locale = loc;
        if (typeof lat === 'number' && !Number.isNaN(lat)) body.latitude = lat;
        if (typeof lng === 'number' && !Number.isNaN(lng)) body.longitude = lng;
      }
      const viewportPreset = document.getElementById('viewport-preset')?.value;
      if (viewportPreset) {
        const [w, h, scale, isMobile] = viewportPreset.split(',');
        if (w && h) {
          body.viewport_width = parseInt(w, 10);
          body.viewport_height = parseInt(h, 10);
          if (scale) body.device_scale_factor = parseFloat(scale) || 1;
          body.is_mobile = isMobile === 'true';
        }
      }
      const networkThrottle = document.getElementById('network-throttle')?.value?.trim();
      if (networkThrottle) body.network_throttling = networkThrottle;
      const res = await fetch('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[ui] Submit failed: ${res.status} ${text}`);
        alert(`Error: ${text}`);
        return;
      }

      const data = await res.json();
      console.log(`[ui] Analysis created: ${data.id}`);
      this.urlInput.value = '';
      this.selectAnalysis(data.id);
      this.updateStopButton('pending');
      this.loadAnalyses();
    } catch (err) {
      console.error(`[ui] Submit error:`, err);
      alert(`Failed to submit: ${err.message}`);
    } finally {
      this.submitBtn.disabled = false;
    }
  }

  /** POST /api/analyses/:id/stop to request analysis finish. Spinner stays until analysis_complete or error. */
  /** POST /api/stop for current analysis and disconnect viewer. */
  async stopAnalysis() {
    if (!this.currentAnalysisId) return;

    const defaultContent = this.stopBtn.querySelector('.stop-btn-default');
    const loadingContent = this.stopBtn.querySelector('.stop-btn-loading');
    if (defaultContent) defaultContent.style.display = 'none';
    if (loadingContent) loadingContent.style.display = 'inline-flex';
    this.stopBtn.disabled = true;

    try {
      this.wsSend({ type: 'stop_analysis' });
      const res = await fetch(`/api/analyses/${this.currentAnalysisId}/stop`, { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        console.warn(`[ui] Stop failed: ${res.status} ${text}`);
        this._resetFinishButtonContent(defaultContent, loadingContent);
        this.stopBtn.disabled = false;
      } else {
        // Mark complete immediately so we stop sending input; server will also send analysis_complete.
        this.updateStopButton('complete');
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close();
        }
        this.loadAnalyses();
      }
    } catch (err) {
      console.error('[ui] Stop error:', err);
      this._resetFinishButtonContent(defaultContent, loadingContent);
      this.stopBtn.disabled = false;
    }
  }

  /** Restore Finish button to default label (hide spinner). */
  _resetFinishButtonContent(defaultContent, loadingContent) {
    if (defaultContent) defaultContent.style.display = '';
    if (loadingContent) loadingContent.style.display = 'none';
  }

  /** Fetch GET /api/analyses and render the sidebar list; update selected item. */
  /** Fetch /api/analyses and render analyses list. */
  async loadAnalyses() {
    try {
      const res = await fetch('/api/analyses');
      const analyses = await res.json();
      this.renderAnalysesList(analyses);
    } catch (err) {
      console.error('[ui] Failed to load analyses:', err);
    }
  }

  /**
   * Render the analyses list in the sidebar (URL, status, tags, select). Filter by selected tag if set.
   * @param {Array<{ id: string, url: string, status: string, tags?: string[] }>} analyses - List from API.
   */
  renderAnalysesList(analyses) {
    let list = analyses || [];
    const dateFrom = document.getElementById('filter-date-from')?.value;
    const dateTo = document.getElementById('filter-date-to')?.value;
    const riskMin = document.getElementById('filter-risk-min')?.value;
    const riskMax = document.getElementById('filter-risk-max')?.value;
    const hasRedirects = document.getElementById('filter-has-redirects')?.checked;
    const hasClipboard = document.getElementById('filter-has-clipboard')?.checked;
    const hasMixed = document.getElementById('filter-has-mixed')?.checked;
    if (dateFrom) list = list.filter((a) => (a.created_at || '').slice(0, 10) >= dateFrom);
    if (dateTo) list = list.filter((a) => (a.created_at || '').slice(0, 10) <= dateTo);
    if (riskMin !== undefined && riskMin !== '') {
      const min = parseInt(riskMin, 10);
      if (!isNaN(min)) list = list.filter((a) => (a.risk_score ?? 0) >= min);
    }
    if (riskMax !== undefined && riskMax !== '') {
      const max = parseInt(riskMax, 10);
      if (!isNaN(max)) list = list.filter((a) => (a.risk_score ?? 0) <= max);
    }
    if (hasRedirects) list = list.filter((a) => (a.redirect_count || 0) > 0);
    if (hasClipboard) list = list.filter((a) => a.has_clipboard === true);
    if (hasMixed) list = list.filter((a) => a.has_mixed_content === true);

    const allTags = [...new Set(list.flatMap((a) => (a.tags || []).filter((t) => VERDICT_TAG_LIST.includes(String(t).toLowerCase()))))].sort();
    if (this.tagFilter && this.tagFilterChips) {
      this.tagFilter.style.display = allTags.length ? 'block' : 'none';
      this.tagFilterChips.innerHTML = allTags
        .map(
          (tag) =>
            `<button type="button" class="tag-filter-chip ${this._selectedTagFilter === tag ? 'active' : ''}" data-tag="${this.esc(tag)}">${this.esc(tag)}</button>`
        )
        .join('');
      this.tagFilterChips.querySelectorAll('.tag-filter-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
          this._selectedTagFilter = this._selectedTagFilter === btn.dataset.tag ? null : btn.dataset.tag;
          this.loadAnalyses();
        });
      });
    }

    const filtered = this._selectedTagFilter
      ? list.filter((a) => (a.tags || []).includes(this._selectedTagFilter))
      : list;

    this.analysesList.innerHTML = filtered
      .map((a) => {
        const isActive = a.id === this.currentAnalysisId;
        const time = new Date(a.created_at).toLocaleTimeString();
        let displayUrl;
        try { displayUrl = new URL(a.url).hostname; } catch { displayUrl = a.url; }
        const verdictLabel = getVerdictLabel(a.tags || []);
        const verdictClass = verdictLabel === 'False positive' ? 'false-positive' : 'malicious';
        return `
        <div class="analysis-card ${isActive ? 'active' : ''}" data-id="${a.id}">
          <div class="analysis-url" title="${this.esc(a.url)}">${this.esc(displayUrl)}</div>
          <div class="analysis-meta">
            <span class="analysis-status ${a.status}">${a.status}</span>
            ${verdictLabel ? `<span class="verdict-badge ${verdictClass}">${this.esc(verdictLabel)}</span>` : ''}
            <span>${time}</span>
          </div>
        </div>`;
      })
      .join('');

    this.analysesList.querySelectorAll('.analysis-card').forEach((card) => {
      card.addEventListener('click', () => this.selectAnalysis(card.dataset.id));
    });
  }

  /** Switch current analysis: close viewer WS, reset panels, load report from API, connect viewer WS. */
  selectAnalysis(id) {
    console.log(`[ui] Selecting analysis: ${id}`);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.currentAnalysisId = id;
    this.currentStatus = null;
    const url = new URL(window.location.href);
    url.searchParams.set('id', id);
    window.history.replaceState({}, '', url);
    this.screenshotCount = 0;
    this.wsEventCount = 0;
    this.resetReportPanels();
    if (this.reportLoading) this.reportLoading.style.display = 'flex';
    this.loadAnalyses();
    this.loadAnalysisReport(id);
    this.connectViewer(id);
  }

  /** Show/hide Finish button based on status (pending | running vs complete | error). */
  /** Show/hide and enable/disable stop button based on analysis status (running vs not). */
  updateStopButton(status) {
    if (!this.stopBtn) return;
    const s = String(status ?? '').toLowerCase();
    this.currentStatus = s || status;

    const defaultContent = this.stopBtn.querySelector('.stop-btn-default');
    const loadingContent = this.stopBtn.querySelector('.stop-btn-loading');
    const isActive = s === 'pending' || s === 'running';
    if (!isActive) {
      this._resetFinishButtonContent(defaultContent, loadingContent);
    }
    this.stopBtn.style.display = isActive ? 'inline-flex' : 'none';
    this.stopBtn.disabled = false;
  }

  /** Clear in-memory report data and re-render all panels; hide viewport image and stop button. */
  /** Clear all report data (network, scripts, console, raw, screenshots, security, risk) and re-render panels. */
  resetReportPanels() {
    this.networkRequests = [];
    this.scripts = [];
    this.consoleLogs = [];
    this.security = null;
    this.riskScore = null;
    this.riskFactors = [];
    this.analysisStartTime = null;
    this.rawFiles = [];
    this.clipboardReads = [];
    this.detectionAttempts = [];
    this.pageSource = null;
    this.domSnapshot = null;
    this.storageCapture = null;
    this.phishingIndicators = [];
    this.securityHeaders = [];
    this.redirectChain = [];
    this.finalUrl = null;
    this.pageTitle = null;
    this.screenshotTimeline = [];
    this.screenshotTimelineCount = 0;
    document.getElementById('search-network').value = '';
    document.getElementById('search-scripts').value = '';
    document.getElementById('search-console').value = '';
    document.getElementById('search-raw').value = '';
    this.renderNetworkPanel();
    this.renderScriptsPanel();
    this.renderConsolePanel();
    this.renderRawPanel();
    this.renderScreenshotsPanel();
    this.renderSecurityPanel();
    this.renderDetectionPanel();
    this.engine = null;
    this.headless = null;
    this.riskBadge.style.display = 'none';
    this.updateAgentHeaderInfo();
    this.stopBtn.style.display = 'none';
    this.pageUrl.textContent = '';
    this.inspectHighlight.style.display = 'none';
    if (this.notesTagsSection) this.notesTagsSection.style.display = 'none';
    if (this.copyLinkBtn) this.copyLinkBtn.style.display = 'none';
    if (this.exportPdfBtn) this.exportPdfBtn.style.display = 'none';
    if (this.virustotalBtn) this.virustotalBtn.style.display = 'none';
    if (this.exportHarBtn) this.exportHarBtn.style.display = 'none';
    if (this.exportVideoBtn) this.exportVideoBtn.style.display = 'none';
    if (this.reportSearchRow) this.reportSearchRow.style.display = 'none';
    if (this.reportSearchInput) this.reportSearchInput.value = '';
    if (this.scrubberRow) this.scrubberRow.style.display = 'none';
    if (this.virustotalResult) this.virustotalResult.style.display = 'none';
    if (this.reportRunOptions) this.reportRunOptions.style.display = 'none';
    if (this.reportVerdictBadge) this.reportVerdictBadge.style.display = 'none';
    this.elementInspector.style.display = 'none';
    this.streamVideoMode = null;
    this.viewportImg.style.display = 'none';
    this.viewportPlaceholder.style.display = 'flex';
    if (this.viewportWebrtc) this.viewportWebrtc.style.display = 'none';
    if (this.viewportWebrtcWaiting) this.viewportWebrtcWaiting.style.display = 'none';
    if (this.viewportWebrtcPlaceholder) this.viewportWebrtcPlaceholder.style.display = 'none';
    if (this.viewportVideo) this.viewportVideo.classList.remove('has-stream');
    if (this.webrtcPc) {
      this.webrtcPc.close();
      this.webrtcPc = null;
      this.webrtcRttMs = null;
      this.webrtcPacketsLost = null;
    }
    if (this.viewportVideo) {
      this.viewportVideo.srcObject = null;
      this.viewportVideo.classList.remove('has-stream');
    }
  }

  /** Render "Options used for this analysis" from run_options (proxy, viewport, network, geo, etc.). */
  renderRunOptions(runOptions) {
    if (!this.reportRunOptions || !this.reportRunOptionsBody) return;
    const o = runOptions || {};
    const rows = [];
    const push = (label, value) => {
      if (value != null && value !== '') rows.push({ label, value: String(value) });
    };
    push('Proxy', o.proxy);
    push('User agent', o.user_agent ? (o.user_agent.length > 60 ? o.user_agent.slice(0, 60) + '…' : o.user_agent) : null);
    push('Viewport', (o.viewport_width && o.viewport_height) ? `${o.viewport_width}×${o.viewport_height}` : null);
    push('Device scale', o.device_scale_factor);
    push('Mobile', o.is_mobile === true ? 'Yes' : (o.is_mobile === false ? 'No' : null));
    push('Network throttling', o.network_throttling);
    push('Timezone', o.timezone_id);
    push('Locale', o.locale);
    push('Latitude', o.latitude);
    push('Longitude', o.longitude);
    if (rows.length === 0) {
      this.reportRunOptions.style.display = 'none';
      return;
    }
    this.reportRunOptionsBody.innerHTML = rows
      .map((r) => `<span class="run-opt-label">${this.esc(r.label)}</span><span class="run-opt-value">${this.esc(r.value)}</span>`)
      .join('');
    this.reportRunOptions.style.display = 'block';
  }

  /** Fetch GET /api/analyses/:id and populate report panels and viewport screenshot for completed analyses. */
  async loadAnalysisReport(id) {
    try {
      const res = await fetch(`/api/analyses/${id}`);
      if (!res.ok) {
        console.warn(`[ui] Failed to load analysis ${id}: ${res.status}`);
        return;
      }
      const analysis = await res.json();
      console.log(`[ui] Loaded analysis: status=${analysis.status}`);

      this.pageUrl.textContent = analysis.url;
      this.currentAnalysisUrl = analysis.url;

      if (this.notesTagsSection) {
        this.notesTagsSection.style.display = 'block';
        this.notesInput.value = analysis.notes || '';
        this.renderTagsChips(analysis.tags || []);
        this.updateVerdictButtonsState();
      }
      if (this.copyLinkBtn) this.copyLinkBtn.style.display = 'inline-block';
      if (this.exportPdfBtn) this.exportPdfBtn.style.display = 'inline-block';
      if (this.virustotalBtn) this.virustotalBtn.style.display = 'inline-block';
      if (this.exportHarBtn) this.exportHarBtn.style.display = 'inline-block';
      if (this.exportVideoBtn) this.exportVideoBtn.style.display = this.screenshotTimeline?.length > 0 ? 'inline-block' : 'none';
      if (this.reportSearchRow) this.reportSearchRow.style.display = 'flex';
      if (this.reportSearchInput) this.reportSearchInput.value = '';
      this._reportSearchQuery = '';
      if (this.virustotalResult) this.virustotalResult.style.display = 'none';
      this.renderRunOptions(analysis.run_options);

      // Always sync button visibility (hide for complete/error, show for pending/running).
      this.updateStopButton(analysis.status);

      // Show the last screenshot for completed/error analyses
      if (analysis.screenshot && (analysis.status === 'complete' || analysis.status === 'error')) {
        this.viewportPlaceholder.style.display = 'none';
        this.viewportImg.style.display = 'block';
        // Detect format: WebP starts with 'UklG' in base64, JPEG with '/9j/'
        const mime = analysis.screenshot.startsWith('UklG') ? 'image/webp' : 'image/jpeg';
        this.viewportImg.src = `data:${mime};base64,${analysis.screenshot}`;
      }

      if (analysis.report) {
        const r = analysis.report;
        this.networkRequests = r.network_requests || [];
        this.scripts = r.scripts || [];
        this.consoleLogs = r.console_logs || [];
        this.security = r.security || null;
        this.riskScore = r.risk_score;
        this.riskFactors = r.risk_factors || [];
        this.phishingIndicators = r.phishing_indicators || [];
        this.clipboardReads = r.clipboard_reads || [];
        this.detectionAttempts = r.detection_attempts || [];
        this.rawFiles = r.raw_files || [];
        this.pageSource = r.page_source || null;
        this.domSnapshot = r.dom_snapshot || null;
        this.storageCapture = r.storage_capture || null;
        this.securityHeaders = r.security_headers || [];
        this.redirectChain = r.redirect_chain || [];
        this.finalUrl = r.final_url || null;
        this.pageTitle = r.page_title || null;
        this.engine = r.engine || null;
        this.headless = r.headless ?? null;

        const allTimestamps = [
          ...this.networkRequests.map(r => r.timestamp),
          ...this.scripts.map(s => s.timestamp),
          ...this.consoleLogs.map(l => l.timestamp),
        ].filter(Boolean);
        if (allTimestamps.length > 0) {
          this.analysisStartTime = Math.min(...allTimestamps);
        }

        this.renderNetworkPanel();
        this.renderScriptsPanel();
        this.renderConsolePanel();
        this.renderRawPanel();
        this.renderSecurityPanel();
        this.renderDetectionPanel();
        this.renderSessionPanel();
        this.updateEngineBadge();
        this.updateRiskBadge();
        this.updateAgentHeaderInfo();
      }

      if (analysis.status === 'complete' || analysis.status === 'error') {
        this.loadScreenshotTimeline();
      }
    } catch (err) {
      console.error('[ui] Failed to load analysis:', err);
    } finally {
      if (this.reportLoading) this.reportLoading.style.display = 'none';
    }
  }

  /**
   * Open WebSocket to /ws/viewer/:id; on message dispatch to handleViewerEvent; reconnect on close if still selected.
   * @param {string} analysisId - Analysis UUID.
   */
  connectViewer(analysisId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/viewer/${analysisId}`;
    console.log(`[ui] Connecting viewer WS: ${wsUrl}`);
    this.wsBytesSent = 0;
    this.wsBytesReceived = 0;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[ui] Viewer WS connected for ${analysisId}`);
      if (this.connectionStatsEl) this.connectionStatsEl.style.display = 'flex';
      this._startConnectionStatsInterval();
    };

    this.ws.onmessage = (e) => {
      try {
        let raw = e.data;
        if (raw instanceof ArrayBuffer) {
          this.wsBytesReceived += raw.byteLength;
          raw = new TextDecoder().decode(raw);
        } else if (raw instanceof Blob) {
          this.wsBytesReceived += raw.size;
          console.warn('[ui] Received Blob, cannot parse as JSON');
          return;
        } else {
          this.wsBytesReceived += new TextEncoder().encode(raw).length;
        }
        const event = JSON.parse(raw);
        this.wsEventCount++;
        if (event.type !== 'screenshot') {
          console.log(`[ui] <- WS event: ${event.type} (total: ${this.wsEventCount})`);
        }
        this.handleViewerEvent(event);
      } catch (err) {
        console.error('[ui] WS parse error:', err, 'data:', typeof e.data === 'string' ? e.data?.substring?.(0, 200) : '(binary)');
      }
    };

    this.ws.onclose = (e) => {
      console.log(`[ui] Viewer WS closed (code=${e.code}, reason=${e.reason})`);
      this._stopConnectionStatsInterval();
      if (this.connectionStatsEl) this.connectionStatsEl.style.display = 'none';
      this.updateConnectionStats(); // clear sidebar connection stats
      // Do not reconnect if this analysis was finished (complete/error) or user switched away.
      if (this.currentAnalysisId !== analysisId) return;
      if (this.currentStatus === 'complete' || this.currentStatus === 'error') return;
      console.log(`[ui] Will reconnect in 2s...`);
      setTimeout(() => {
        if (this.currentAnalysisId === analysisId && this.currentStatus !== 'complete' && this.currentStatus !== 'error' && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
          this.connectViewer(analysisId);
        }
      }, 2000);
    };

    this.ws.onerror = (e) => {
      console.error(`[ui] Viewer WS error:`, e);
    };
  }

  _startConnectionStatsInterval() {
    this._stopConnectionStatsInterval();
    this._connectionStatsInterval = setInterval(async () => {
      if (this.webrtcPc) await this._pollWebRTCStats();
      this.updateConnectionStats();
    }, 1000);
  }

  _stopConnectionStatsInterval() {
    if (this._connectionStatsInterval) {
      clearInterval(this._connectionStatsInterval);
      this._connectionStatsInterval = null;
    }
  }

  /** Format bytes as KB or MB for display. */
  _formatBytes(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  /** Update connection stats UI: bytes ↓/↑ and quality (WebRTC RTT/loss or WebSocket). */
  updateConnectionStats() {
    const down = this._formatBytes(this.wsBytesReceived || 0);
    const up = this._formatBytes(this.wsBytesSent || 0);
    const bytesText = `↓ ${down}  ↑ ${up}`;
    const isOpen = this.ws?.readyState === WebSocket.OPEN;

    if (this.connectionStatsBytesEl) {
      this.connectionStatsBytesEl.textContent = bytesText;
      this.connectionStatsBytesEl.title = `Received: ${down}, Sent: ${up}`;
    }
    if (this.sidebarConnectionStatsEl) {
      if (!isOpen) {
        this.sidebarConnectionStatsEl.textContent = '—';
        this.sidebarConnectionStatsEl.title = '';
      } else {
        let qualityPart = '';
        if (this.webrtcPc && (this.webrtcRttMs != null || this.webrtcPacketsLost != null)) {
          const parts = [];
          if (this.webrtcRttMs != null) parts.push(`RTT ${Math.round(this.webrtcRttMs)} ms`);
          if (this.webrtcPacketsLost != null) parts.push(`${this.webrtcPacketsLost}% loss`);
          qualityPart = ' · ' + parts.join(' · ');
        } else {
          qualityPart = ' · WebSocket';
        }
        this.sidebarConnectionStatsEl.textContent = bytesText + qualityPart;
        this.sidebarConnectionStatsEl.title = `Received: ${down}, Sent: ${up}${qualityPart}`;
      }
    }

    const qualityEl = this.connectionStatsQualityEl;
    if (!qualityEl) return;
    if (this.webrtcPc && (this.webrtcRttMs != null || this.webrtcPacketsLost != null)) {
      const parts = [];
      if (this.webrtcRttMs != null) parts.push(`RTT ${Math.round(this.webrtcRttMs)} ms`);
      if (this.webrtcPacketsLost != null) parts.push(`${this.webrtcPacketsLost}% loss`);
      qualityEl.textContent = parts.join(' · ');
      qualityEl.title = 'WebRTC video link quality';
      qualityEl.classList.remove('quality-good', 'quality-fair', 'quality-poor');
      if (this.webrtcRttMs != null) {
        if (this.webrtcRttMs < 80) qualityEl.classList.add('quality-good');
        else if (this.webrtcRttMs < 200) qualityEl.classList.add('quality-fair');
        else qualityEl.classList.add('quality-poor');
      }
    } else {
      qualityEl.textContent = isOpen ? 'WebSocket' : '';
      qualityEl.title = isOpen ? 'Viewer connection (WebSocket)' : '';
      qualityEl.classList.remove('quality-good', 'quality-fair', 'quality-poor');
    }
  }

  /** Poll WebRTC stats for RTT and packet loss (when Baliverne video is active). */
  async _pollWebRTCStats() {
    if (!this.webrtcPc || this.webrtcPc.connectionState === 'closed') return;
    try {
      const stats = await this.webrtcPc.getStats();
      let rttMs = null;
      let packetsLost = null;
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.roundTripTime != null) {
          rttMs = report.roundTripTime * 1000;
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const lost = report.packetsLost;
          const total = (report.packetsReceived || 0) + (lost || 0);
          if (total > 0 && lost != null) {
            packetsLost = Math.round((lost / total) * 100);
          }
        }
      });
      this.webrtcRttMs = rttMs;
      this.webrtcPacketsLost = packetsLost;
    } catch (_) {}
  }

  /**
   * Dispatch incoming viewer WebSocket events: screenshot, network_request_captured, report_snapshot, analysis_complete, element_info, error, etc.
   * @param {object} event - Parsed WS message (type, and type-specific fields).
   */
  handleViewerEvent(event) {
    switch (event.type) {
      case 'screenshot':
        if (this.streamVideoMode === 'webrtc') break; // Baliverne: video via WebRTC only, ignore screenshot
        this.screenshotCount++;
        if (!event.data || typeof event.data !== 'string') break;
        if (this.screenshotCount <= 3 || this.screenshotCount % 20 === 0) {
          console.log(`[ui] Screenshot #${this.screenshotCount} (${(event.data.length / 1024).toFixed(1)} KB)`);
        }
        this.viewportPlaceholder.style.display = 'none';
        this.viewportImg.style.display = 'block';
        try {
          const bin = atob(event.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/webp' });
          if (this._lastScreenshotUrl) URL.revokeObjectURL(this._lastScreenshotUrl);
          this._lastScreenshotUrl = URL.createObjectURL(blob);
          this.viewportImg.src = this._lastScreenshotUrl;
        } catch {
          this.viewportImg.src = `data:image/webp;base64,${event.data}`;
        }
        if (this.currentStatus !== 'complete' && this.currentStatus !== 'error') {
          this.updateStopButton('running');
        }
        break;

      case 'network_request_captured': {
        // Agent sends event.request; Baliverne runtime sends flat url/method/status/status_text
        const request = event.request || {
          url: event.url || '',
          method: event.method || 'GET',
          resource_type: event.resource_type || 'other',
          status: event.status ?? null,
          status_text: event.status_text ?? null,
          timestamp: event.timestamp ?? Date.now(),
        };
        if (!this.analysisStartTime && request.timestamp) {
          this.analysisStartTime = request.timestamp;
        }
        this.networkRequests.push(request);
        this.renderNetworkPanel();
        break;
      }

      case 'script_loaded':
        this.scripts.push(event.script);
        this.renderScriptsPanel();
        break;

      case 'console_log_captured':
        this.consoleLogs.push(event.log);
        this.renderConsolePanel();
        break;

      case 'raw_file_captured':
        this.rawFiles.push(event.file);
        this.renderRawPanel();
        break;

      case 'page_source_captured':
        this.pageSource = event.html;
        this.renderRawPanel();
        break;

      case 'storage_captured':
        this.storageCapture = event.capture;
        this.renderSecurityPanel();
        break;

      case 'security_headers_captured':
        this.securityHeaders = event.headers || [];
        this.renderSecurityPanel();
        break;

      case 'dom_snapshot_captured':
        this.domSnapshot = event.html;
        this.renderRawPanel();
        break;

      case 'clipboard_captured':
        this.clipboardReads.push(event.read);
        this.renderSecurityPanel();
        break;

      case 'detection_event':
        this.detectionAttempts.push(event.attempt);
        this.renderDetectionPanel();
        break;

      case 'screenshot_timeline_available':
        console.log(`[ui] Screenshot timeline available: ${event.count} entries`);
        this.screenshotTimelineCount = event.count;
        document.getElementById('count-screenshots').textContent = event.count;
        break;

      case 'report_snapshot':
        console.log(`[ui] Received report snapshot (${event.report?.network_requests?.length || 0} requests, ${event.report?.scripts?.length || 0} scripts, ${event.report?.raw_files?.length || 0} raw files)`);
        if (event.report) {
          const r = event.report;
          if (r.network_requests?.length > this.networkRequests.length) this.networkRequests = r.network_requests;
          if (r.scripts?.length > this.scripts.length) this.scripts = r.scripts;
          if (r.console_logs?.length > this.consoleLogs.length) this.consoleLogs = r.console_logs;
          if (r.security) this.security = r.security;
          if (r.risk_score !== undefined) this.riskScore = r.risk_score;
          if (r.risk_factors?.length) this.riskFactors = r.risk_factors;
          if (r.clipboard_reads?.length) this.clipboardReads = r.clipboard_reads;
          if (r.detection_attempts?.length > this.detectionAttempts.length) this.detectionAttempts = r.detection_attempts;
          if (r.raw_files?.length > this.rawFiles.length) this.rawFiles = r.raw_files;
          if (r.page_source) this.pageSource = r.page_source;
          if (r.dom_snapshot) this.domSnapshot = r.dom_snapshot;
          if (r.storage_capture) this.storageCapture = r.storage_capture;
          if (r.phishing_indicators?.length) this.phishingIndicators = r.phishing_indicators;
          if (r.security_headers?.length) this.securityHeaders = r.security_headers;
          if (r.redirect_chain?.length) this.redirectChain = r.redirect_chain;
          if (r.final_url) this.finalUrl = r.final_url;
          if (r.engine) this.engine = r.engine;
          if (r.headless !== undefined) this.headless = r.headless;

          const allTimestamps = [
            ...this.networkRequests.map(x => x.timestamp),
            ...this.scripts.map(x => x.timestamp),
            ...this.consoleLogs.map(x => x.timestamp),
          ].filter(Boolean);
          if (allTimestamps.length > 0) this.analysisStartTime = Math.min(...allTimestamps);

          this.renderNetworkPanel();
          this.renderScriptsPanel();
          this.renderConsolePanel();
          this.renderRawPanel();
          this.renderSecurityPanel();
          this.renderDetectionPanel();
          this.updateRiskBadge();
          this.updateEngineBadge();
        }
        if (event.engine) this.engine = event.engine;
        if (event.headless !== undefined) this.headless = event.headless;
        this.updateEngineBadge();
        this.updateAgentHeaderInfo();
        if (event.status) {
          this.updateStopButton(event.status);
        }
        break;

      case 'redirect_detected':
        console.log(`[ui] Redirect: ${event.from} -> ${event.to}`);
        this.redirectChain.push({ from: event.from, to: event.to, status: event.status });
        this.renderSecurityPanel();
        break;

      case 'navigation_complete':
        console.log(`[ui] Navigation complete: ${event.url} "${event.title}" engine=${event.engine}`);
        this.pageUrl.textContent = event.url;
        this.finalUrl = event.url;
        if (event.title) {
          document.title = `${event.title} — Carabistouille`;
        }
        if (event.engine) this.engine = event.engine;
        if (event.headless !== undefined) this.headless = event.headless;
        this.updateEngineBadge();
        this.updateAgentHeaderInfo();
        this.updateStopButton('running');
        this.loadAnalyses();
        break;

      case 'analysis_complete':
        console.log(`[ui] Analysis complete, risk_score=${event.report?.risk_score}`);
        this.updateStopButton('complete');
        if (event.report) {
          this.networkRequests = event.report.network_requests || this.networkRequests;
          this.scripts = event.report.scripts || this.scripts;
          this.consoleLogs = event.report.console_logs || this.consoleLogs;
          this.clipboardReads = event.report.clipboard_reads || this.clipboardReads;
          if (event.report.detection_attempts?.length) this.detectionAttempts = event.report.detection_attempts;
          if (event.report.raw_files?.length) this.rawFiles = event.report.raw_files;
          if (event.report.page_source) this.pageSource = event.report.page_source;
          if (event.report.dom_snapshot) this.domSnapshot = event.report.dom_snapshot;
          if (event.report.storage_capture) this.storageCapture = event.report.storage_capture;
          if (event.report.phishing_indicators?.length) this.phishingIndicators = event.report.phishing_indicators;
          if (event.report.security_headers?.length) this.securityHeaders = event.report.security_headers;
          if (event.report.redirect_chain?.length) this.redirectChain = event.report.redirect_chain;
          if (event.report.final_url) this.finalUrl = event.report.final_url;
          if (event.report.engine) this.engine = event.report.engine;
          if (event.report.headless !== undefined) this.headless = event.report.headless;
          this.security = event.report.security || null;
          this.riskScore = event.report.risk_score;
          this.riskFactors = event.report.risk_factors || [];
          this.renderNetworkPanel();
          this.renderScriptsPanel();
          this.renderConsolePanel();
          this.renderRawPanel();
          this.renderSecurityPanel();
          this.renderDetectionPanel();
          this.updateRiskBadge();
          this.updateEngineBadge();
          this.updateAgentHeaderInfo();
        }
        this.loadScreenshotTimeline();
        this.loadAnalyses();
        break;

      case 'element_info':
        console.log(`[ui] Element info: <${event.tag}>`);
        this.showElementInfo(event);
        break;

      case 'error':
        console.error('[ui] Analysis error:', event.message);
        this.updateStopButton('error');
        this.loadAnalyses();
        break;

      case 'browser_starting':
        // Baliverne: container is up, browser/display not ready yet — ignore or show transient state
        break;

      case 'stream_mode':
        // Baliverne: video is via WebRTC; show video viewport (Baliverne-style), waiting message, request SDP offer
        if (event.video === 'webrtc') {
          this.streamVideoMode = 'webrtc';
          this.viewportPlaceholder.style.display = 'none';
          this.viewportImg.style.display = 'none';
          if (this.viewportWebrtc) this.viewportWebrtc.style.display = 'flex';
          if (this.viewportWebrtcWaiting) this.viewportWebrtcWaiting.style.display = 'block';
          if (this.viewportWebrtcPlaceholder) this.viewportWebrtcPlaceholder.style.display = 'none';
          this.wsSend({ type: 'webrtc_request_offer' });
        }
        break;

      case 'webrtc_offer':
        if (!event.sdp) break;
        this.setupWebRTCViewer(event.sdp);
        break;

      case 'webrtc_ice_candidate':
        if (this.webrtcPc && event.candidate) {
          this.webrtcPc.addIceCandidate(new RTCIceCandidate(event.candidate)).catch((err) => {
            console.warn('[ui] addIceCandidate failed:', err);
          });
        }
        break;

      default:
        console.warn(`[ui] Unknown event type: ${event.type}`);
    }
  }

  /**
   * Set up WebRTC viewer from server SDP offer (Baliverne): create PeerConnection, set remote description,
   * create answer, send answer and ICE candidates; attach received track to viewport video.
   * @param {object} sdp - { type: 'offer', sdp: string }
   */
  async setupWebRTCViewer(sdp) {
    if (this.webrtcPc) {
      this.webrtcPc.close();
      this.webrtcPc = null;
      this.webrtcRttMs = null;
      this.webrtcPacketsLost = null;
    }
    const config = { iceServers: [] };
    if (Array.isArray(this.iceServers) && this.iceServers.length > 0) {
      config.iceServers = this.iceServers.map((s) => ({
        urls: typeof s.urls === 'string' ? s.urls.split(/\s+/) : [].concat(s.urls || []),
        username: s.username || undefined,
        credential: s.credential || undefined,
      }));
    }
    const pc = new RTCPeerConnection(config);
    this.webrtcPc = pc;

    const video = this.viewportVideo;
    pc.ontrack = (e) => {
      console.log('[ui] WebRTC track received', e.track?.kind, e.streams?.length);
      if (video) {
        video.muted = true;
        video.playsInline = true;
        if (e.streams && e.streams[0]) {
          video.srcObject = e.streams[0];
        } else if (e.track) {
          const stream = new MediaStream();
          stream.addTrack(e.track);
          video.srcObject = stream;
        }
        video.classList.add('has-stream');
        video.play().catch((err) => console.warn('[ui] video.play failed', err));
        if (this.viewportWebrtcWaiting) this.viewportWebrtcWaiting.style.display = 'none';
        if (this.viewportWebrtcPlaceholder) this.viewportWebrtcPlaceholder.style.display = 'none';
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.wsSend({
          type: 'webrtc_ice_candidate',
          candidate: {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
          },
        });
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.wsSend({
        type: 'webrtc_answer',
        sdp: { type: answer.type, sdp: answer.sdp },
      });
      console.log('[ui] WebRTC answer sent');
    } catch (err) {
      console.warn('[ui] WebRTC setup failed', err);
      pc.close();
      this.webrtcPc = null;
      this.webrtcRttMs = null;
      this.webrtcPacketsLost = null;
    }
  }

  /**
   * Display inspected element: highlight rect on viewport and show tag/attributes in inspector panel.
   * Supports both screenshot viewport and WebRTC video (Baliverne).
   * @param {object} info - Element info from agent (tag, rect, attributes, text).
   */
  showElementInfo(info) {
    let scaleX, scaleY, left, top;
    if (this.streamVideoMode === 'webrtc' && this.viewportVideo && this.viewportVideo.videoWidth > 0) {
      const rect = this.viewportVideo.getBoundingClientRect();
      const streamW = this.viewportVideo.videoWidth;
      const streamH = this.viewportVideo.videoHeight;
      const contentAspect = streamW / streamH;
      const rectAspect = rect.width / rect.height;
      let contentWidth, contentHeight, contentLeft, contentTop;
      if (rectAspect > contentAspect) {
        contentHeight = rect.height;
        contentWidth = rect.height * contentAspect;
        contentLeft = rect.left + (rect.width - contentWidth) / 2;
        contentTop = rect.top;
      } else {
        contentWidth = rect.width;
        contentHeight = rect.width / contentAspect;
        contentLeft = rect.left;
        contentTop = rect.top + (rect.height - contentHeight) / 2;
      }
      scaleX = contentWidth / streamW;
      scaleY = contentHeight / streamH;
      const wrapperRect = this.viewportWrapper.getBoundingClientRect();
      left = contentLeft - wrapperRect.left + info.rect.x * scaleX;
      top = contentTop - wrapperRect.top + info.rect.y * scaleY;
    } else {
      const imgRect = this.viewportImg.getBoundingClientRect();
      scaleX = imgRect.width / (this.viewportImg.naturalWidth || 1);
      scaleY = imgRect.height / (this.viewportImg.naturalHeight || 1);
      left = this.viewportImg.offsetLeft + info.rect.x * scaleX;
      top = this.viewportImg.offsetTop + info.rect.y * scaleY;
    }

    this.inspectHighlight.style.display = 'block';
    this.inspectHighlight.style.left = `${left}px`;
    this.inspectHighlight.style.top = `${top}px`;
    this.inspectHighlight.style.width = `${info.rect.width * scaleX}px`;
    this.inspectHighlight.style.height = `${info.rect.height * scaleY}px`;

    const attrs = Object.entries(info.attributes || {})
      .map(([k, v]) => `<span class="attr-name">${this.esc(k)}</span>=<span class="attr-value">"${this.esc(v)}"</span>`)
      .join(' ');

    this.elementInspector.style.display = 'block';
    this.inspectorContent.innerHTML = `
      <span class="tag">&lt;${this.esc(info.tag)}</span> ${attrs}<span class="tag">&gt;</span>
      ${info.text ? `<div class="text-preview">${this.esc(info.text.substring(0, 200))}</div>` : ''}
    `;
  }

  /** Set risk score text and color class (low/medium/high) on the report header badge. */
  updateRiskBadge() {
    if (this.riskScore === null || this.riskScore === undefined) return;

    this.riskBadge.style.display = 'inline-flex';
    this.riskScoreEl.textContent = `${this.riskScore}/100`;

    this.riskBadge.classList.remove('low', 'medium', 'high');
    if (this.riskScore <= 25) this.riskBadge.classList.add('low');
    else if (this.riskScore <= 50) this.riskBadge.classList.add('medium');
    else this.riskBadge.classList.add('high');
  }

  /** Show engine label (e.g. Puppeteer, Puppeteer Extra + Stealth) in report header from current analysis. */
  updateEngineBadge() {
    if (!this.agentEngineEl) return;
    if (!this.engine) {
      this.agentEngineEl.style.display = 'none';
      return;
    }
    const labels = {
      'puppeteer': 'Puppeteer',
      'puppeteer-extra': 'Puppeteer Extra + Stealth',
    };
    this.agentEngineEl.textContent = labels[this.engine] || this.engine;
    this.agentEngineEl.style.display = 'inline';
  }

  /** Update header agent mode and engine labels from run_mode, chrome_mode (from /api/status) and engine/headless (from analysis). */
  updateAgentHeaderInfo() {
    if (!this.agentModeEl || !this.agentEngineEl) return;
    const connected = this.agentStatus?.classList.contains('connected');
    if (!connected) {
      this.agentModeEl.style.display = 'none';
      this.agentEngineEl.style.display = 'none';
      return;
    }
    let modeText = '';
    if (this.agentBackend === 'baliverne') {
      const browser = this.baliverneBrowser === 'firefox' ? 'Firefox' : 'Chrome';
      modeText = `Baliverne + ${browser}`;
    } else if (this.runMode === 'docker') {
      modeText = this.chromeMode === 'real' ? 'Docker + real Chrome' : 'Docker + headless';
    } else {
      if (this.headless === false) modeText = 'Local + real Chrome';
      else if (this.headless === true) modeText = 'Local + headless';
      else modeText = 'Local';
    }
    this.agentModeEl.textContent = modeText;
    this.agentModeEl.style.display = 'inline';
    const engineLabels = { 'puppeteer': 'Puppeteer', 'puppeteer-extra': 'Puppeteer Extra + Stealth' };
    const engineText = this.engine ? (engineLabels[this.engine] || this.engine) : '—';
    this.agentEngineEl.textContent = engineText;
    this.agentEngineEl.style.display = 'inline';
  }

  /** Render Network tab with type filters, resource type badges, and expandable request details. */
  renderNetworkPanel() {
    const list = document.getElementById('panel-network-list');
    document.getElementById('count-network').textContent = this.networkRequests.length;

    if (this.networkRequests.length === 0) {
      list.innerHTML = '<div class="panel-empty">' + this.t('app.noNetwork') + '</div>';
      return;
    }

    const query = (document.getElementById('search-network')?.value || '').toLowerCase();
    const globalQ = this._reportSearchQuery || '';
    const typeFilter = this._activeNetTypeFilter || 'all';
    const knownTypes = ['document','script','stylesheet','xhr','fetch','image','font','media','websocket','manifest','ping','preflight','other'];

    let filtered = this.networkRequests;
    if (globalQ) {
      filtered = filtered.filter(r =>
        (r.url || '').toLowerCase().includes(globalQ) ||
        (r.method || '').toLowerCase().includes(globalQ) ||
        (r.content_type || '').toLowerCase().includes(globalQ) ||
        (r.resource_type || '').toLowerCase().includes(globalQ) ||
        (r.request_body || '').toLowerCase().includes(globalQ) ||
        (JSON.stringify(r.request_headers || {}) + JSON.stringify(r.response_headers || {})).toLowerCase().includes(globalQ));
    }
    if (typeFilter !== 'all') {
      const types = typeFilter.split(',');
      filtered = filtered.filter(r => {
        const rt = (r.resource_type || '').toLowerCase();
        if (types.includes(rt)) return true;
        if (typeFilter === 'other') return !knownTypes.includes(rt) || !rt;
        return false;
      });
    }
    const searchQ = query || globalQ;
    if (searchQ) {
      filtered = filtered.filter(r =>
        (r.url || '').toLowerCase().includes(searchQ) ||
        (r.content_type || '').toLowerCase().includes(searchQ) ||
        (r.method || '').toLowerCase().includes(searchQ) ||
        (r.resource_type || '').toLowerCase().includes(searchQ)
      );
    }

    // Newest first (reverse chronological order)
    filtered = [...filtered].reverse();

    const TYPE_COLORS = {
      document: '#3b82f6', script: '#f59e0b', stylesheet: '#8b5cf6', xhr: '#10b981',
      fetch: '#10b981', image: '#ec4899', font: '#6366f1', media: '#f97316',
      websocket: '#14b8a6', manifest: '#64748b', ping: '#64748b', other: '#6b7280',
    };

    list.innerHTML = filtered
      .map((r) => {
        const origIdx = this.networkRequests.indexOf(r);
        const statusClass = r.status ? `s${Math.floor(r.status / 100)}xx` : (r.failure ? 'sfail' : '');
        const thirdPartyClass = r.is_third_party ? 'third-party' : '';
        const ct = r.content_type || '';
        const isJs = ct.includes('javascript') || r.url.endsWith('.js');
        const scriptMatch = isJs ? this.scripts.find(s => s.url === r.url && s.content) : null;
        const timeLabel = this._timeLabel(r.timestamp);
        const rt = (r.resource_type || 'other').toLowerCase();
        const typeColor = TYPE_COLORS[rt] || TYPE_COLORS.other;
        const statusDisplay = r.failure ? 'ERR' : (r.status || '...');
        const cacheTag = r.from_cache ? '<span class="net-badge net-badge-cache">cache</span>' : '';
        const swTag = r.from_service_worker ? '<span class="net-badge net-badge-sw">SW</span>' : '';
        return `
        <div class="net-row" data-idx="${origIdx}">
          <span class="net-time" title="${timeLabel}">${this._absTime(r.timestamp)}</span>
          <span class="net-status ${statusClass}">${statusDisplay}</span>
          <span class="net-method">${this.esc(r.method)}</span>
          <span class="net-resource-type" style="color:${typeColor}">${this.esc(rt)}</span>
          <div class="net-url-wrap">
            <span class="net-url-full ${thirdPartyClass}">${this.esc(r.url)}</span>
            ${cacheTag}${swTag}
            <span class="net-actions">
              <button class="icon-btn copy-btn" data-url="${this.esc(r.url)}" title="${this.t('app.copyUrl')}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
              ${scriptMatch ? `<button class="icon-btn js-btn" data-script-url="${this.esc(r.url)}" title="${this.t('app.viewJs')}">JS</button>` : ''}
            </span>
          </div>
          ${ct ? `<span class="net-type">${this.esc(ct.split(';')[0])}</span>` : ''}
        </div>`;
      })
      .join('');

    list.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.url);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1000);
      });
    });

    list.querySelectorAll('.js-btn[data-script-url]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const script = this.scripts.find(s => s.url === btn.dataset.scriptUrl);
        if (script?.content) this.showSourceViewer(script.url || '(inline)', script.content);
      });
    });

    list.querySelectorAll('.net-row').forEach(row => {
      row.addEventListener('click', () => {
        const existing = row.nextElementSibling;
        if (existing && existing.classList.contains('net-detail')) {
          existing.remove();
          row.classList.remove('net-row-expanded');
          return;
        }
        list.querySelectorAll('.net-detail').forEach(d => d.remove());
        list.querySelectorAll('.net-row-expanded').forEach(r => r.classList.remove('net-row-expanded'));

        const idx = parseInt(row.dataset.idx, 10);
        const r = this.networkRequests[idx];
        if (!r) return;

        row.classList.add('net-row-expanded');
        const detail = document.createElement('div');
        detail.className = 'net-detail';
        detail.innerHTML = this._buildRequestDetail(r);
        row.after(detail);

        detail.querySelectorAll('.net-detail-copy').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const target = btn.getAttribute('data-copy-target') || btn.dataset.copyTarget;
            const el = detail.querySelector(`[data-section="${target}"]`);
            if (!el) return;
            const textToCopy = (el.textContent || el.innerText || '').trim();
            const copyLabel = this.t('app.copy');
            function setCopied() {
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = copyLabel; }, 1200);
            }
            function setFailed() {
              btn.textContent = 'Copy failed';
              setTimeout(() => { btn.textContent = copyLabel; }, 1500);
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(textToCopy).then(setCopied).catch(() => {
                try {
                  const ta = document.createElement('textarea');
                  ta.value = textToCopy;
                  ta.setAttribute('readonly', '');
                  ta.style.position = 'absolute';
                  ta.style.left = '-9999px';
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  document.body.removeChild(ta);
                  setCopied();
                } catch (err) {
                  setFailed();
                }
              });
            } else {
              try {
                const ta = document.createElement('textarea');
                ta.value = textToCopy;
                ta.setAttribute('readonly', '');
                ta.style.position = 'absolute';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                setCopied();
              } catch (err) {
                setFailed();
              }
            }
          });
        });

        detail.querySelectorAll('.net-detail-tab').forEach(tab => {
          tab.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabName = tab.dataset.detailTab;
            detail.querySelectorAll('.net-detail-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            detail.querySelectorAll('.net-detail-content').forEach(c => { c.style.display = 'none'; });
            const target = detail.querySelector(`[data-detail-tab-content="${tabName}"]`);
            if (target) target.style.display = '';
          });
        });
      });
    });
  }

  /** Format headers (object or array of {name, value}) as plain text for display and copy. */
  _formatHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    let entries;
    if (Array.isArray(headers)) {
      entries = headers.map(h => (h && (h.name != null || h.value != null)) ? [String(h.name ?? ''), String(h.value ?? '')] : null).filter(Boolean);
    } else {
      entries = Object.entries(headers).map(([k, v]) => [k, String(v)]);
    }
    if (!entries.length) return null;
    return entries.map(([k, v]) => `${this.esc(k)}: ${this.esc(v)}`).join('\n');
  }

  /** Format a key-value row for request detail HTML. */
  _kv(key, val) {
    return `<div class="net-detail-kv"><span class="net-detail-key">${this.esc(key)}</span><span class="net-detail-val">${val}</span></div>`;
  }

  /** Build expandable request detail HTML: headers, payload, timing, security, initiator, response. */
  _buildRequestDetail(r) {
    const s = [];
    const reqHeaders = this._formatHeaders(r.request_headers);
    const respHeaders = this._formatHeaders(r.response_headers);
    const bodyStr = typeof r.request_body === 'string' ? r.request_body : (r.request_body != null ? JSON.stringify(r.request_body) : '');
    const hasPayload = bodyStr.length > 0;
    const hasTiming = r.timing && typeof r.timing === 'object';
    const hasSecurity = r.security_details && typeof r.security_details === 'object';
    const hasInitiator = r.initiator && typeof r.initiator === 'object';
    const hasResponse = this.rawFiles.find(f => f.url === r.url);

    s.push('<div class="net-detail-tabs">');
    s.push(`<button class="net-detail-tab active" data-detail-tab="general">${this.t('app.detailGeneral')}</button>`);
    if (reqHeaders) s.push(`<button class="net-detail-tab" data-detail-tab="req-headers">${this.t('app.detailReqHeaders')}</button>`);
    if (respHeaders) s.push(`<button class="net-detail-tab" data-detail-tab="resp-headers">${this.t('app.detailRespHeaders')}</button>`);
    if (hasPayload) s.push(`<button class="net-detail-tab" data-detail-tab="payload">${this.t('app.detailPayload')}</button>`);
    if (hasTiming) s.push(`<button class="net-detail-tab" data-detail-tab="timing">${this.t('app.detailTiming')}</button>`);
    if (hasSecurity) s.push(`<button class="net-detail-tab" data-detail-tab="security">${this.t('app.detailSecurity')}</button>`);
    if (hasInitiator) s.push(`<button class="net-detail-tab" data-detail-tab="initiator">${this.t('app.detailInitiator')}</button>`);
    if (hasResponse) s.push(`<button class="net-detail-tab" data-detail-tab="response">${this.t('app.detailResponse')}</button>`);
    s.push('</div>');

    // General tab
    s.push('<div class="net-detail-content" data-detail-tab-content="general">');
    s.push(this._kv('URL', this.esc(r.url)));
    s.push(this._kv('Method', this.esc(r.method)));
    const statusStr = r.failure ? `<span style="color:var(--danger)">Failed — ${this.esc(r.failure)}</span>` : `${r.status || 'pending'}${r.status_text ? ' ' + this.esc(r.status_text) : ''}`;
    s.push(this._kv('Status', statusStr));
    if (r.resource_type) s.push(this._kv('Resource Type', this.esc(r.resource_type)));
    if (r.content_type) s.push(this._kv('Content-Type', this.esc(r.content_type)));
    if (r.response_size != null) s.push(this._kv('Response Size', this._formatSize(r.response_size)));
    if (r.remote_ip) {
      const addr = r.remote_port ? `${r.remote_ip}:${r.remote_port}` : r.remote_ip;
      s.push(this._kv('Remote Address', this.esc(addr)));
    }
    s.push(this._kv('Third-party', r.is_third_party ? 'Yes' : 'No'));
    if (r.is_navigation) s.push(this._kv('Navigation', 'Yes'));
    if (r.from_cache) s.push(this._kv('From Cache', 'Yes'));
    if (r.from_service_worker) s.push(this._kv('Service Worker', 'Yes'));
    s.push('</div>');

    // Request Headers tab
    if (reqHeaders) {
      s.push('<div class="net-detail-content" data-detail-tab-content="req-headers" style="display:none">');
      s.push(`<div class="net-detail-section-bar"><button type="button" class="net-detail-copy icon-btn" data-copy-target="req-headers">${this.t('app.copy')}</button></div>`);
      s.push(`<pre class="net-detail-pre" data-section="req-headers">${reqHeaders}</pre>`);
      s.push('</div>');
    }

    // Response Headers tab
    if (respHeaders) {
      s.push('<div class="net-detail-content" data-detail-tab-content="resp-headers" style="display:none">');
      s.push(`<div class="net-detail-section-bar"><button type="button" class="net-detail-copy icon-btn" data-copy-target="resp-headers">${this.t('app.copy')}</button></div>`);
      s.push(`<pre class="net-detail-pre" data-section="resp-headers">${respHeaders}</pre>`);
      s.push('</div>');
    }

    // Payload tab
    if (hasPayload) {
      let prettyPayload;
      try {
        const parsed = JSON.parse(bodyStr);
        prettyPayload = this.esc(JSON.stringify(parsed, null, 2));
      } catch {
        prettyPayload = this.esc(bodyStr);
      }

      s.push('<div class="net-detail-content" data-detail-tab-content="payload" style="display:none">');
      s.push(`<div class="net-detail-section-bar"><span class="net-detail-size">${this._formatSize(bodyStr.length)}</span><button type="button" class="net-detail-copy icon-btn" data-copy-target="payload">${this.t('app.copy')}</button></div>`);
      s.push(`<pre class="net-detail-pre" data-section="payload">${prettyPayload}</pre>`);
      s.push('</div>');
    }

    // Timing tab
    if (hasTiming) {
      s.push('<div class="net-detail-content" data-detail-tab-content="timing" style="display:none">');
      s.push(this._buildTimingWaterfall(r.timing));
      s.push('</div>');
    }

    // Security tab
    if (hasSecurity) {
      const sec = r.security_details;
      s.push('<div class="net-detail-content" data-detail-tab-content="security" style="display:none">');
      if (sec.protocol) s.push(this._kv('Protocol', this.esc(String(sec.protocol))));
      if (sec.issuer) s.push(this._kv('Issuer', this.esc(String(sec.issuer))));
      if (sec.subjectName) s.push(this._kv('Subject', this.esc(String(sec.subjectName))));
      if (sec.validFrom != null) s.push(this._kv('Valid From', this._formatCertDate(sec.validFrom)));
      if (sec.validTo != null) s.push(this._kv('Valid To', this._formatCertDate(sec.validTo)));
      s.push('</div>');
    }

    // Initiator tab
    if (hasInitiator) {
      const init = r.initiator;
      s.push('<div class="net-detail-content" data-detail-tab-content="initiator" style="display:none">');
      if (init.type) s.push(this._kv('Type', this.esc(String(init.type))));
      if (init.url) s.push(this._kv('URL', this.esc(String(init.url))));
      if (init.lineNumber != null) s.push(this._kv('Line', String(init.lineNumber)));
      s.push('</div>');
    }

    // Response body preview tab
    if (hasResponse) {
      const preview = hasResponse.content || '';
      const truncated = preview.length > 5000 ? preview.substring(0, 5000) + '\n… (truncated)' : preview;
      s.push('<div class="net-detail-content" data-detail-tab-content="response" style="display:none">');
      s.push(`<div class="net-detail-section-bar"><span class="net-detail-size">${this._formatSize(preview.length)}</span><button type="button" class="net-detail-copy icon-btn" data-copy-target="response">${this.t('app.copy')}</button></div>`);
      s.push(`<pre class="net-detail-pre" data-section="response">${this.esc(truncated)}</pre>`);
      s.push('</div>');
    }

    return s.join('');
  }

  /** Format byte count as human-readable string (e.g. 1.2 KB). */
  _formatSize(bytes) {
    if (bytes == null) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  /** Format TLS cert date (seconds since epoch) as locale string. */
  _formatCertDate(epoch) {
    if (epoch == null) return '—';
    try {
      const d = new Date(typeof epoch === 'number' && epoch < 1e12 ? epoch * 1000 : epoch);
      return d.toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
    } catch { return String(epoch); }
  }

  /** Build HTML for request timing waterfall (DNS, connect, SSL, send, receive). */
  _buildTimingWaterfall(timing) {
    if (!timing) return '';
    const phases = [];
    const push = (label, startMs, endMs, color) => {
      if (startMs >= 0 && endMs >= 0 && endMs > startMs) {
        phases.push({ label, duration: (endMs - startMs).toFixed(1), color });
      }
    };
    push('DNS', timing.dnsStart, timing.dnsEnd, '#3b82f6');
    push('Connect', timing.connectStart, timing.connectEnd, '#f59e0b');
    push('SSL/TLS', timing.sslStart, timing.sslEnd, '#8b5cf6');
    push('Send', timing.sendStart, timing.sendEnd, '#10b981');
    push('Wait (TTFB)', timing.sendEnd, timing.receiveHeadersStart, '#ef4444');
    push('Receive', timing.receiveHeadersStart, timing.receiveHeadersEnd, '#ec4899');

    if (phases.length === 0) return '<span class="net-detail-empty">No timing data</span>';

    const total = phases.reduce((sum, p) => sum + parseFloat(p.duration), 0);
    let html = '<div class="net-timing-waterfall">';
    for (const p of phases) {
      const pct = total > 0 ? (parseFloat(p.duration) / total * 100) : 0;
      html += `<div class="net-timing-row">`;
      html += `<span class="net-timing-label">${p.label}</span>`;
      html += `<div class="net-timing-bar-wrap"><div class="net-timing-bar" style="width:${Math.max(pct, 2)}%;background:${p.color}"></div></div>`;
      html += `<span class="net-timing-dur">${p.duration} ms</span>`;
      html += `</div>`;
    }
    html += `<div class="net-timing-total">Total: ${total.toFixed(1)} ms</div>`;
    html += '</div>';
    return html;
  }

  /** Render Scripts tab: expandable rows, preview, view source locally, download. */
  renderScriptsPanel() {
    const list = document.getElementById('panel-scripts-list');
    document.getElementById('count-scripts').textContent = this.scripts.length;

    if (this.scripts.length === 0) {
      list.innerHTML = '<div class="panel-empty">' + this.t('app.noScripts') + '</div>';
      return;
    }

    const query = (document.getElementById('search-scripts')?.value || '').toLowerCase();
    const globalQ = this._reportSearchQuery || '';
    const searchQ = query || globalQ;
    const filtered = searchQ
      ? this.scripts.filter(s =>
          (s.url || '').toLowerCase().includes(searchQ) ||
          (s.is_inline && 'inline'.includes(searchQ)) ||
          (s.content || '').toLowerCase().includes(searchQ))
      : this.scripts;

    list.innerHTML = filtered
      .map((s, i) => {
        const type = s.is_inline ? 'inline' : 'external';
        const label = s.is_inline ? 'INLINE' : 'EXTERNAL';
        const url = s.url || '(inline script)';
        const size = s.size ? `${(s.size / 1024).toFixed(1)} KB` : '';
        const hasContent = !!s.content;
        const preview = hasContent ? s.content.trim().substring(0, 200) : '';
        const lineCount = hasContent ? s.content.split('\n').length : 0;
        const timeLabel = this._timeLabel(s.timestamp);
        return `
        <div class="script-entry" data-script-idx="${i}">
          <div class="script-row ${hasContent ? 'expandable' : ''}">
            <div class="script-header">
              ${hasContent ? `<span class="expand-arrow">&#9654;</span>` : `<span class="expand-arrow-placeholder"></span>`}
              <span class="script-type ${type}">${label}</span>
              ${timeLabel ? `<span class="timeline-badge" title="${timeLabel}">${this._absTime(s.timestamp)} <span class="rel">${this._relTime(s.timestamp)}</span></span>` : ''}
              ${size ? `<span class="script-size">${size}</span>` : ''}
              ${lineCount ? `<span class="script-lines">${lineCount} lines</span>` : ''}
              <span class="script-actions">
                ${s.url ? `<button class="icon-btn copy-btn" data-url="${this.esc(s.url)}" title="Copy URL">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>` : ''}
                ${hasContent ? `<button class="icon-btn copy-btn" data-content-idx="${i}" title="Copy content">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>` : ''}
                ${hasContent ? `<button class="icon-btn dl-btn" data-script-idx="${i}" title="Download file">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>` : ''}
                ${hasContent ? `<button class="icon-btn view-src-btn" data-script-idx="${i}" title="Open in full viewer">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                </button>` : ''}
              </span>
            </div>
            <span class="script-url" title="${this.esc(s.url || '')}">${this.esc(url)}</span>
            ${hasContent ? `<div class="script-preview"><code class="language-javascript">${this.esc(preview)}${s.content.length > 200 ? '...' : ''}</code></div>` : ''}
          </div>
          ${hasContent ? `<div class="script-content-expanded" style="display:none"><pre><code class="language-javascript">${this.esc(s.content)}</code></pre></div>` : ''}
        </div>`;
      })
      .join('');

    this._highlightCodeBlocks(list);

    list.querySelectorAll('.copy-btn[data-url]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.url);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1000);
      });
    });

    list.querySelectorAll('.copy-btn[data-content-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = this.scripts[parseInt(btn.dataset.contentIdx)];
        if (s?.content) {
          navigator.clipboard.writeText(s.content);
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1000);
        }
      });
    });

    list.querySelectorAll('.dl-btn[data-script-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = this.scripts[parseInt(btn.dataset.scriptIdx)];
        if (s?.content) {
          let filename;
          try { filename = new URL(s.url).pathname.split('/').pop() || 'script.js'; } catch { filename = s.is_inline ? `inline-${btn.dataset.scriptIdx}.js` : 'script.js'; }
          this._downloadFile(filename, s.content, 'application/javascript');
        }
      });
    });

    list.querySelectorAll('.view-src-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = this.scripts[parseInt(btn.dataset.scriptIdx)];
        if (s?.content) this.showSourceViewer(s.url || '(inline)', s.content);
      });
    });

    list.querySelectorAll('.script-row.expandable').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.icon-btn')) return;
        const entry = row.closest('.script-entry');
        const expanded = entry.querySelector('.script-content-expanded');
        const arrow = row.querySelector('.expand-arrow');
        const isOpen = expanded.style.display !== 'none';
        expanded.style.display = isOpen ? 'none' : 'block';
        arrow.classList.toggle('open', !isOpen);
      });
    });
  }

  /** Render Console tab: filtered list of log entries with level, text, timestamps. */
  renderConsolePanel() {
    const list = document.getElementById('panel-console-list');
    document.getElementById('count-console').textContent = this.consoleLogs.length;

    if (this.consoleLogs.length === 0) {
      list.innerHTML = '<div class="panel-empty">' + this.t('app.noConsole') + '</div>';
      return;
    }

    const query = (document.getElementById('search-console')?.value || '').toLowerCase();
    const globalQ = this._reportSearchQuery || '';
    const searchQ = query || globalQ;
    const filtered = searchQ
      ? this.consoleLogs.filter(l => (l.text || '').toLowerCase().includes(searchQ) || (l.level || '').toLowerCase().includes(searchQ))
      : this.consoleLogs;

    list.innerHTML = filtered
      .map((l) => {
        const timeLabel = this._timeLabel(l.timestamp);
        return `<div class="console-row ${l.level}">${timeLabel ? `<span class="timeline-badge" title="${timeLabel}">${this._absTime(l.timestamp)} <span class="rel">${this._relTime(l.timestamp)}</span></span> ` : ''}[${l.level}] ${this.esc(l.text)}</div>`;
      })
      .join('');
  }

  /** Return array of selected extension filters for the Raw tab (e.g. ['js', 'html']). Empty = show all. */
  getRawExtensionFilters() {
    const el = document.getElementById('raw-extension-filters');
    if (!el) return [];
    return Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
  }

  /** Render Raw tab: page source, DOM snapshot (at finish), and captured raw files; expand, copy, download, view source. */
  renderRawPanel() {
    const list = document.getElementById('panel-raw-list');
    const totalCount = this.rawFiles.length + (this.pageSource ? 1 : 0) + (this.domSnapshot ? 1 : 0);
    document.getElementById('count-raw').textContent = totalCount;

    if (this.rawFiles.length === 0 && !this.pageSource && !this.domSnapshot) {
      list.innerHTML = '<div class="panel-empty">' + this.t('app.noFiles') + '</div>';
      return;
    }

    const query = (document.getElementById('search-raw')?.value || '').toLowerCase();
    const globalQ = this._reportSearchQuery || '';
    const searchQ = query || globalQ;
    const selectedExts = this.getRawExtensionFilters();

    const matchExtension = (url, contentType, ext) => {
      const u = (url || '').toLowerCase();
      const ct = (contentType || '').toLowerCase();
      switch (ext) {
        case 'js': return u.endsWith('.js') || ct.includes('javascript');
        case 'html': return u.endsWith('.html') || u.endsWith('.htm') || ct.includes('html');
        case 'css': return u.endsWith('.css') || ct.includes('css');
        case 'json': return u.endsWith('.json') || ct.includes('json');
        case 'xml': return u.endsWith('.xml') || ct.includes('xml');
        case 'svg': return u.endsWith('.svg') || ct.includes('svg');
        default: return false;
      }
    };

    const showByExtension = (ext) => !selectedExts.length || selectedExts.includes(ext);

    // Page Source pinned entry (counts as HTML)
    let pageSourceHtml = '';
    if (this.pageSource && showByExtension('html') && (!searchQ || 'page source'.includes(searchQ) || 'html'.includes(searchQ))) {
      const preview = this.pageSource.trim().substring(0, 150);
      const sizeKb = (this.pageSource.length / 1024).toFixed(1);
      pageSourceHtml = `
        <div class="raw-entry page-source-entry" data-page-source="true">
          <div class="raw-row">
            <div class="raw-header">
              <span class="expand-arrow">&#9654;</span>
              <span class="raw-type page-source-badge">PAGE SOURCE</span>
              <span class="script-size">${sizeKb} KB</span>
              <span class="script-actions">
                <button class="icon-btn copy-content-btn" data-page-source="true" title="Copy HTML source">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="icon-btn dl-btn" data-page-source="true" title="Download page source">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
                <button class="icon-btn view-src-btn" data-page-source="true" title="Open in full viewer">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                </button>
              </span>
            </div>
            <span class="raw-filename">Rendered HTML (document)</span>
            <div class="script-preview"><code class="language-html">${this.esc(preview)}${this.pageSource.length > 150 ? '...' : ''}</code></div>
          </div>
          <div class="script-content-expanded" style="display:none"><pre><code class="language-html">${this.esc(this.pageSource)}</code></pre></div>
        </div>`;
    }

    // DOM snapshot (at finish) pinned entry (counts as HTML)
    let domSnapshotHtml = '';
    if (this.domSnapshot && showByExtension('html') && (!searchQ || 'dom snapshot'.includes(searchQ) || 'html'.includes(searchQ))) {
      const preview = this.domSnapshot.trim().substring(0, 150);
      const sizeKb = (this.domSnapshot.length / 1024).toFixed(1);
      domSnapshotHtml = `
        <div class="raw-entry dom-snapshot-entry" data-dom-snapshot="true">
          <div class="raw-row">
            <div class="raw-header">
              <span class="expand-arrow">&#9654;</span>
              <span class="raw-type dom-snapshot-badge">DOM SNAPSHOT</span>
              <span class="script-size">${sizeKb} KB</span>
              <span class="script-actions">
                <button class="icon-btn copy-content-btn" data-dom-snapshot="true" title="Copy HTML">Copy</button>
                <button class="icon-btn dl-btn" data-dom-snapshot="true" title="Download">Download</button>
                <button class="icon-btn view-src-btn" data-dom-snapshot="true" title="Open in full viewer">View</button>
              </span>
            </div>
            <span class="raw-filename">HTML at finish time</span>
            <div class="script-preview"><code class="language-html">${this.esc(preview)}${this.domSnapshot.length > 150 ? '...' : ''}</code></div>
          </div>
          <div class="script-content-expanded" style="display:none"><pre><code class="language-html">${this.esc(this.domSnapshot)}</code></pre></div>
        </div>`;
    }

    let filtered = this.rawFiles;
    if (selectedExts.length) {
      filtered = filtered.filter(f => selectedExts.some(ext => matchExtension(f.url, f.content_type, ext)));
    }
    if (searchQ) {
      filtered = filtered.filter(f => (f.url || '').toLowerCase().includes(searchQ) || (f.content_type || '').toLowerCase().includes(searchQ) || (f.content || '').toLowerCase().includes(searchQ));
    }

    list.innerHTML = pageSourceHtml + domSnapshotHtml + filtered
      .map((f) => {
        const origIdx = this.rawFiles.indexOf(f);
        const timeLabel = this._timeLabel(f.timestamp);
        const absTime = this._absTime(f.timestamp);
        const relTime = this._relTime(f.timestamp);
        const size = f.size ? `${(f.size / 1024).toFixed(1)} KB` : '';
        const ct = f.content_type || '';
        const lang = ct.includes('javascript') ? 'javascript' : ct.includes('css') ? 'css' : ct.includes('html') ? 'html' : ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : '';
        const preview = f.content ? f.content.trim().substring(0, 150) : '';
        let shortName;
        try { shortName = new URL(f.url).pathname.split('/').pop() || f.url; } catch { shortName = f.url; }
        return `
        <div class="raw-entry" data-raw-idx="${origIdx}">
          <div class="raw-row">
            <div class="raw-header">
              <span class="expand-arrow">&#9654;</span>
              <span class="raw-type">${this.esc(ct || 'unknown')}</span>
              ${size ? `<span class="script-size">${size}</span>` : ''}
              ${timeLabel ? `<span class="timeline-badge" title="${timeLabel}">${absTime} <span class="rel">${relTime}</span></span>` : ''}
              <span class="script-actions">
                <button class="icon-btn copy-url-btn" data-url="${this.esc(f.url)}" title="Copy URL">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="icon-btn copy-content-btn" data-raw-idx="${origIdx}" title="Copy content">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="icon-btn dl-btn" data-raw-idx="${origIdx}" title="Download file">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
                <button class="icon-btn view-src-btn" data-raw-idx="${origIdx}" title="Open in full viewer">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                </button>
              </span>
            </div>
            <span class="raw-filename" title="${this.esc(f.url)}">${this.esc(shortName)}</span>
            <span class="raw-url">${this.esc(f.url)}</span>
            ${preview ? `<div class="script-preview"><code${lang ? ` class="language-${lang}"` : ''}>${this.esc(preview)}${f.content.length > 150 ? '...' : ''}</code></div>` : ''}
          </div>
          <div class="script-content-expanded" style="display:none"><pre><code${lang ? ` class="language-${lang}"` : ''}>${this.esc(f.content || '')}</code></pre></div>
        </div>`;
      })
      .join('');

    this._highlightCodeBlocks(list);

    list.querySelectorAll('.copy-url-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.url);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1000);
      });
    });

    list.querySelectorAll('.copy-content-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const f = this.rawFiles[parseInt(btn.dataset.rawIdx)];
        if (f?.content) {
          navigator.clipboard.writeText(f.content);
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1000);
        }
      });
    });

    list.querySelectorAll('.dl-btn[data-raw-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const f = this.rawFiles[parseInt(btn.dataset.rawIdx)];
        if (f?.content) {
          let filename;
          try { filename = new URL(f.url).pathname.split('/').pop() || 'download'; } catch { filename = 'download'; }
          this._downloadFile(filename, f.content, f.content_type || 'text/plain');
        }
      });
    });

    list.querySelectorAll('.view-src-btn[data-raw-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const f = this.rawFiles[parseInt(btn.dataset.rawIdx)];
        if (f?.content) this.showSourceViewer(f.url, f.content);
      });
    });

    // Page source buttons
    list.querySelectorAll('.copy-content-btn[data-page-source]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.pageSource) {
          navigator.clipboard.writeText(this.pageSource);
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1000);
        }
      });
    });
    list.querySelectorAll('.dl-btn[data-page-source]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.pageSource) this._downloadFile('page-source.html', this.pageSource, 'text/html');
      });
    });
    list.querySelectorAll('.view-src-btn[data-page-source]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.pageSource) this.showSourceViewer('Page Source (rendered HTML)', this.pageSource);
      });
    });

    // DOM snapshot buttons
    list.querySelectorAll('.copy-content-btn[data-dom-snapshot]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.domSnapshot) {
          navigator.clipboard.writeText(this.domSnapshot);
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1000);
        }
      });
    });
    list.querySelectorAll('.dl-btn[data-dom-snapshot]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.domSnapshot) this._downloadFile('dom-snapshot.html', this.domSnapshot, 'text/html');
      });
    });
    list.querySelectorAll('.view-src-btn[data-dom-snapshot]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.domSnapshot) this.showSourceViewer('DOM snapshot (at finish)', this.domSnapshot);
      });
    });

    list.querySelectorAll('.raw-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.icon-btn')) return;
        const entry = row.closest('.raw-entry');
        const expanded = entry.querySelector('.script-content-expanded');
        const arrow = row.querySelector('.expand-arrow');
        const isOpen = expanded.style.display !== 'none';
        expanded.style.display = isOpen ? 'none' : 'block';
        arrow.classList.toggle('open', !isOpen);
        if (!isOpen) this._highlightCodeBlocks(expanded);
      });
    });
  }

  /** Build chronological session events from redirects, network, console, scripts. */
  buildSessionEvents() {
    const events = [];
    (this.redirectChain || []).forEach((r, i) => {
      events.push({ type: 'redirect', timestamp: this.analysisStartTime || 0, summary: `${r.from || ''} → ${r.to || ''} (${r.status || ''})`, detail: r });
    });
    (this.networkRequests || []).forEach((r) => {
      events.push({ type: 'request', timestamp: r.timestamp || 0, summary: `${r.method || 'GET'} ${(r.url || '').slice(0, 80)}${(r.url || '').length > 80 ? '…' : ''}`, detail: r });
    });
    (this.consoleLogs || []).forEach((l) => {
      events.push({ type: 'console', timestamp: l.timestamp || 0, summary: `[${l.level || 'log'}] ${(l.text || '').slice(0, 100)}${(l.text || '').length > 100 ? '…' : ''}`, detail: l });
    });
    (this.scripts || []).forEach((s) => {
      const url = s.url || '(inline)';
      events.push({ type: 'script', timestamp: s.timestamp || 0, summary: url.slice(0, 80) + (url.length > 80 ? '…' : ''), detail: s });
    });
    events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return events;
  }

  /** Render Session tab: chronological event log (redirects, requests, console, scripts). */
  renderSessionPanel() {
    const list = document.getElementById('panel-session-list');
    const countEl = document.getElementById('count-session');
    const events = this.buildSessionEvents();
    if (countEl) countEl.textContent = events.length;

    const globalQ = this._reportSearchQuery || '';
    const filtered = globalQ
      ? events.filter((e) => (e.summary || '').toLowerCase().includes(globalQ))
      : events;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="panel-empty">' + (events.length === 0 ? this.t('app.noSession') : 'No matching session events.') + '</div>';
      return;
    }
    const startTs = this.analysisStartTime || 0;
    list.innerHTML = filtered
      .map((e) => {
        const rel = e.timestamp && startTs ? ((e.timestamp - startTs) / 1000).toFixed(1) + 's' : '';
        const abs = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
        const icon = e.type === 'redirect' ? '↪' : e.type === 'request' ? '↵' : e.type === 'console' ? '☰' : '◉';
        return `<div class="session-event ${e.type}" title="${this.esc(e.summary)}">
          <span class="session-event-icon">${icon}</span>
          <span class="session-event-time">${abs} ${rel ? `+${rel}` : ''}</span>
          <span class="session-event-body">${this.esc(e.summary)}</span>
        </div>`;
      })
      .join('');
  }

  /** Fetch GET /api/analyses/:id/screenshots and render the screenshot gallery. */
  async loadScreenshotTimeline() {
    if (!this.currentAnalysisId) return;
    try {
      const res = await fetch(`/api/analyses/${this.currentAnalysisId}/screenshots`);
      if (!res.ok) return;
      this.screenshotTimeline = await res.json();
      document.getElementById('count-screenshots').textContent = this.screenshotTimeline.length;
      this.renderScreenshotsPanel();
      if (this.exportVideoBtn && this.screenshotTimeline.length > 0) this.exportVideoBtn.style.display = 'inline-block';
    } catch (err) {
      console.error('[ui] Failed to load screenshot timeline:', err);
    }
  }

  /** Export session as WebM video from screenshot timeline. Uses canvas + MediaRecorder; frames shown at original timestamps. */
  async exportSessionVideo() {
    if (!this.screenshotTimeline?.length) {
      await this.loadScreenshotTimeline();
      if (!this.screenshotTimeline?.length) {
        alert('No screenshots in timeline to export as video.');
        return;
      }
    }
    const timeline = this.screenshotTimeline;
    const firstTs = timeline[0].timestamp;
    const fps = 4;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    const loadImage = (src) => new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
    const mime = timeline[0].data.startsWith('UklG') ? 'image/webp' : 'image/jpeg';
    await loadImage(`data:${mime};base64,${timeline[0].data}`);
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const stream = canvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1000000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${(this.currentAnalysisId || 'export').slice(0, 8)}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };
    recorder.start(500);
    const drawFrame = (index) => {
      if (index >= timeline.length) {
        setTimeout(() => recorder.stop(), 500);
        return;
      }
      const entry = timeline[index];
      const src = `data:${entry.data.startsWith('UklG') ? 'image/webp' : 'image/jpeg'};base64,${entry.data}`;
      const nextImg = new Image();
      nextImg.onload = () => {
        ctx.drawImage(nextImg, 0, 0, canvas.width, canvas.height);
        const nextIndex = index + 1;
        const delay = nextIndex < timeline.length ? Math.max(0, (timeline[nextIndex].timestamp - entry.timestamp)) : 0;
        setTimeout(() => drawFrame(nextIndex), delay);
      };
      nextImg.onerror = () => drawFrame(index + 1);
      nextImg.src = src;
    };
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const delay0 = timeline.length > 1 ? Math.max(0, timeline[1].timestamp - firstTs) : 0;
    setTimeout(() => drawFrame(1), delay0);
  }

  /** Render Screenshots tab: thumbnails with timestamps; click opens modal with prev/next and download. */
  renderScreenshotsPanel() {
    const list = document.getElementById('panel-screenshots-list');
    document.getElementById('count-screenshots').textContent = this.screenshotTimeline.length || this.screenshotTimelineCount || 0;

    if (this.screenshotTimeline.length === 0) {
      const msg = this.screenshotTimelineCount > 0
        ? `${this.screenshotTimelineCount} screenshots available — click to load`
        : this.t('app.noScreenshots');
      list.innerHTML = `<div class="panel-empty ss-load-prompt">${msg}</div>`;
      if (this.screenshotTimelineCount > 0) {
        list.querySelector('.ss-load-prompt').style.cursor = 'pointer';
        list.querySelector('.ss-load-prompt').addEventListener('click', () => this.loadScreenshotTimeline());
      }
      return;
    }

    if (this.scrubberRow) {
      this.scrubberRow.style.display = 'flex';
      if (this.screenshotScrubber) {
        this.screenshotScrubber.min = 0;
        this.screenshotScrubber.max = Math.max(0, this.screenshotTimeline.length - 1);
        this.screenshotScrubber.value = this._scrubberIndex = 0;
      }
      if (this.scrubberValue) this.scrubberValue.textContent = `1 / ${this.screenshotTimeline.length}`;
    }

    const firstTs = this.screenshotTimeline[0].timestamp;
    list.innerHTML = `<div class="ss-gallery">${
      this.screenshotTimeline.map((ss, i) => {
        const relSec = ((ss.timestamp - firstTs) / 1000).toFixed(0);
        const absTime = new Date(ss.timestamp).toLocaleTimeString();
        return `<div class="ss-thumb" data-ss-idx="${i}" title="${absTime} (+${relSec}s)">
          <img src="data:${ss.data.startsWith('UklG') ? 'image/webp' : 'image/jpeg'};base64,${ss.data}" loading="lazy" alt="Screenshot ${i + 1}">
          <span class="ss-label">${absTime} <span class="rel">+${relSec}s</span></span>
        </div>`;
      }).join('')
    }</div>`;

    list.querySelectorAll('.ss-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => {
        const idx = parseInt(thumb.dataset.ssIdx);
        this._showScreenshotModal(idx);
      });
    });
  }

  /** Open screenshot modal at given index; wire prev/next and keyboard. Syncs scrubber and viewport. */
  _showScreenshotModal(idx) {
    const ss = this.screenshotTimeline[idx];
    if (!ss) return;
    this._scrubberIndex = idx;
    if (this.screenshotScrubber) {
      this.screenshotScrubber.value = idx;
      const mime = ss.data.startsWith('UklG') ? 'image/webp' : 'image/jpeg';
      if (this.viewportImg) {
        this.viewportImg.src = `data:${mime};base64,${ss.data}`;
        this.viewportPlaceholder.style.display = 'none';
        this.viewportImg.style.display = 'block';
      }
    }
    if (this.scrubberValue) this.scrubberValue.textContent = `${idx + 1} / ${this.screenshotTimeline.length}`;

    let modal = document.getElementById('ss-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ss-modal';
      modal.className = 'ss-modal-overlay';
      modal.innerHTML = `
        <div class="ss-modal-content">
          <div class="ss-modal-header">
            <span class="ss-modal-title"></span>
            <div class="ss-modal-nav">
              <button class="ss-nav-btn" id="ss-prev" title="Previous">&#9664;</button>
              <span class="ss-nav-counter"></span>
              <button class="ss-nav-btn" id="ss-next" title="Next">&#9654;</button>
            </div>
            <button class="ss-modal-close" title="Close">&times;</button>
          </div>
          <img class="ss-modal-img" alt="Screenshot">
          <div class="ss-modal-footer">
            <button class="ss-dl-btn">Download</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
      });
      modal.querySelector('.ss-modal-close').addEventListener('click', () => {
        modal.style.display = 'none';
      });
      this._ssModalKeyHandler = (e) => {
        if (modal.style.display !== 'flex') return;
        if (e.key === 'Escape') { modal.style.display = 'none'; return; }
        const cur = parseInt(modal.dataset.currentIdx);
        if (e.key === 'ArrowLeft' && cur > 0) this._updateSSModal(cur - 1);
        if (e.key === 'ArrowRight' && cur < this.screenshotTimeline.length - 1) this._updateSSModal(cur + 1);
      };
      document.addEventListener('keydown', this._ssModalKeyHandler);
    }

    modal.querySelector('#ss-prev').onclick = () => {
      const cur = parseInt(modal.dataset.currentIdx);
      if (cur > 0) this._updateSSModal(cur - 1);
    };
    modal.querySelector('#ss-next').onclick = () => {
      const cur = parseInt(modal.dataset.currentIdx);
      if (cur < this.screenshotTimeline.length - 1) this._updateSSModal(cur + 1);
    };
    modal.querySelector('.ss-dl-btn').onclick = () => {
      const cur = parseInt(modal.dataset.currentIdx);
      const entry = this.screenshotTimeline[cur];
      if (!entry) return;
      const mime = entry.data.startsWith('UklG') ? 'image/webp' : 'image/jpeg';
      const blob = this._b64toBlob(entry.data, mime);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot-${cur + 1}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
    };

    this._updateSSModal(idx);
    modal.style.display = 'flex';
  }

  /** Update screenshot modal content to index i (image, counter, download). */
  _updateSSModal(i) {
    const modal = document.getElementById('ss-modal');
    if (!modal) return;
    const entry = this.screenshotTimeline[i];
    if (!entry) return;
    const firstTs = this.screenshotTimeline[0].timestamp;
    const relSec = ((entry.timestamp - firstTs) / 1000).toFixed(1);
    const absTime = new Date(entry.timestamp).toLocaleTimeString();
    modal.querySelector('.ss-modal-title').textContent = `${absTime} (+${relSec}s)`;
    modal.querySelector('.ss-nav-counter').textContent = `${i + 1} / ${this.screenshotTimeline.length}`;
    const mime = entry.data.startsWith('UklG') ? 'image/webp' : 'image/jpeg';
    modal.querySelector('.ss-modal-img').src = `data:${mime};base64,${entry.data}`;
    modal.querySelector('#ss-prev').disabled = i <= 0;
    modal.querySelector('#ss-next').disabled = i >= this.screenshotTimeline.length - 1;
    modal.dataset.currentIdx = i;
  }

  /**
   * Decode base64 string to Blob for the given MIME type.
   * @param {string} b64 - Base64-encoded string.
   * @param {string} type - MIME type (e.g. 'image/webp').
   * @returns {Blob}
   */
  _b64toBlob(b64, type) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type });
  }

  /** Render Security tab: SSL, mixed content, suspicious patterns, clipboard, storage, headers, redirect export, risk factors; update count badge. */
  renderSecurityPanel() {
    const panel = document.getElementById('panel-security');
    const countEl = document.getElementById('count-security');
    const storageCount = this.storageCapture
      ? this.storageCapture.cookies?.length + (this.storageCapture.local_storage?.length || 0) + (this.storageCapture.session_storage?.length || 0)
      : 0;
    const securityItemCount =
      (this.security ? 2 + (this.security.suspicious_patterns?.length || 0) : 0) +
      this.clipboardReads.length +
      this.securityHeaders.length +
      (this.redirectChain.length > 0 ? 1 : 0) +
      (storageCount > 0 ? Math.min(storageCount, 99) : 0) +
      this.riskFactors.length;
    if (countEl) countEl.textContent = securityItemCount;

    const hasAny =
      this.security || this.riskFactors.length > 0 || this.clipboardReads.length > 0 ||
      (this.storageCapture && (this.storageCapture.cookies?.length || this.storageCapture.local_storage?.length || this.storageCapture.session_storage?.length)) ||
      this.securityHeaders.length > 0 || this.redirectChain.length > 0;
    if (!hasAny) {
      panel.innerHTML = '<div class="panel-empty">' + this.t('app.noSecurity') + '</div>';
      return;
    }

    let html = '<div class="security-section">';

    if (this.security) {
      const sslIcon = this.security.ssl_valid ? '&#x2705;' : '&#x274C;';
      const sslText = this.security.ssl_valid ? 'HTTPS enabled' : 'No HTTPS — connection not secure';
      html += `<div class="security-item"><span class="security-icon">${sslIcon}</span><span>${sslText}</span></div>`;

      const mixedIcon = this.security.has_mixed_content ? '&#x26A0;' : '&#x2705;';
      const mixedText = this.security.has_mixed_content ? 'Mixed content detected' : 'No mixed content';
      html += `<div class="security-item"><span class="security-icon">${mixedIcon}</span><span>${mixedText}</span></div>`;

      if (this.security.suspicious_patterns?.length > 0) {
        this.security.suspicious_patterns.forEach((p) => {
          html += `<div class="security-item"><span class="security-icon">&#x26A0;</span><span>${this.esc(p)}</span></div>`;
        });
      }
    }

    html += '</div>';

    // Redirect chain + export
    if (this.redirectChain.length > 0 || this.finalUrl) {
      html += '<div class="security-subsection"><h3 class="clipboard-heading">Redirect chain</h3>';
      if (this.redirectChain.length > 0) {
        this.redirectChain.forEach((r, i) => {
          html += `<div class="security-item redirect-step"><span class="redirect-num">${i + 1}</span> <span class="redirect-from">${this.esc(r.from)}</span> → <span class="redirect-to">${this.esc(r.to)}</span> <span class="redirect-status">${r.status}</span></div>`;
        });
      }
      if (this.finalUrl) {
        html += `<div class="security-item"><strong>Final URL:</strong> <span class="redirect-to">${this.esc(this.finalUrl)}</span></div>`;
      }
      html += '<div class="redirect-export-actions"><button type="button" class="btn-export redirect-copy-btn">Copy as text</button> <button type="button" class="btn-export redirect-dl-json-btn">Download JSON</button></div></div>';
    }

    // Security headers (CSP, X-Frame-Options, etc.)
    if (this.securityHeaders.length > 0) {
      const importantNames = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security', 'referrer-policy'];
      html += '<div class="security-subsection"><h3 class="clipboard-heading">Security headers</h3>';
      this.securityHeaders.forEach((h) => {
        const name = (h.name || '').toLowerCase();
        const isImportant = importantNames.some((n) => name === n);
        const warn = name === 'content-security-policy' && (!h.value || h.value.length < 10) ? ' (weak or missing)' : '';
        html += `<div class="security-item header-row${isImportant ? ' header-important' : ''}"><span class="header-name">${this.esc(h.name)}</span>: <span class="header-value" title="${this.esc(h.value)}">${this.esc(h.value.length > 120 ? h.value.slice(0, 120) + '…' : h.value)}</span>${warn}</div>`;
      });
      html += '</div>';
    }

    // Phishing kit / template indicators
    if (this.phishingIndicators && this.phishingIndicators.length > 0) {
      html += '<div class="security-subsection"><h3 class="clipboard-heading">Phishing indicators</h3>';
      this.phishingIndicators.forEach((ind) => {
        html += `<div class="security-item phishing-indicator">${this.esc(ind)}</div>`;
      });
      html += '</div>';
    }

    // Cookies & storage
    if (this.storageCapture) {
      const sens = (s) => /session|token|auth|csrf|sid|jwt|refresh|access_token|oauth|credential/i.test(s || '');
      html += '<div class="security-subsection"><div class="storage-section-header"><h3 class="clipboard-heading">Cookies & storage</h3><button type="button" class="icon-btn storage-export-btn" title="Export cookies and storage as JSON">Export</button></div>';
      if (this.storageCapture.cookies?.length > 0) {
        html += '<div class="storage-group"><strong>Cookies</strong> (' + this.storageCapture.cookies.length + ')</div>';
        this.storageCapture.cookies.forEach((c) => {
          const sensitive = sens(c.name);
          html += `<div class="cookie-row${sensitive ? ' cookie-sensitive' : ''}"><span class="cookie-name">${this.esc(c.name)}</span>${sensitive ? ' <span class="cookie-flag" title="Sensitive name">⚠</span>' : ''} <span class="cookie-meta">${c.domain || ''} ${c.http_only ? 'HttpOnly' : ''} ${c.secure ? 'Secure' : ''}</span><br><span class="cookie-value">${this.esc((c.value || '').slice(0, 80))}${(c.value || '').length > 80 ? '…' : ''}</span></div>`;
        });
      }
      if (this.storageCapture.local_storage?.length > 0) {
        html += '<div class="storage-group"><strong>localStorage</strong> (' + this.storageCapture.local_storage.length + ')</div>';
        this.storageCapture.local_storage.forEach((e) => {
          html += `<div class="storage-entry"><span class="storage-key">${this.esc(e.key)}</span>: <span class="storage-value">${this.esc((e.value || '').slice(0, 60))}${(e.value || '').length > 60 ? '…' : ''}</span></div>`;
        });
      }
      if (this.storageCapture.session_storage?.length > 0) {
        html += '<div class="storage-group"><strong>sessionStorage</strong> (' + this.storageCapture.session_storage.length + ')</div>';
        this.storageCapture.session_storage.forEach((e) => {
          html += `<div class="storage-entry"><span class="storage-key">${this.esc(e.key)}</span>: <span class="storage-value">${this.esc((e.value || '').slice(0, 60))}${(e.value || '').length > 60 ? '…' : ''}</span></div>`;
        });
      }
      html += '</div>';
    }

    if (this.clipboardReads.length > 0) {
      const nonEmpty = this.clipboardReads.filter(r => r.content && r.content.length > 0);
      const statusIcon = nonEmpty.length > 0 ? '&#x1F6A8;' : '&#x2705;';
      const statusText = nonEmpty.length > 0
        ? `Clipboard hijack detected! ${nonEmpty.length} non-empty read(s)`
        : `Clipboard clean (${this.clipboardReads.length} check(s), all empty)`;
      html += `<div class="clipboard-section">
        <h3 class="clipboard-heading">Clipboard monitoring</h3>
        <div class="security-item"><span class="security-icon">${statusIcon}</span><span>${statusText}</span></div>`;

      this.clipboardReads.forEach((read, i) => {
        const trigger = read.trigger || 'unknown';
        const content = read.content || '';
        const hasContent = content.length > 0;
        const timeLabel = this._timeLabel(read.timestamp);
        const absTime = this._absTime(read.timestamp);
        html += `<div class="clipboard-read${hasContent ? ' has-content' : ''}" data-idx="${i}">
          <div class="clipboard-read-header">
            <span class="clipboard-trigger">${this.esc(trigger)}</span>
            ${absTime ? `<span class="timeline-badge" title="${timeLabel}">${absTime}</span>` : ''}
            ${hasContent
              ? `<span class="clipboard-size">${content.length} chars</span>`
              : '<span class="clipboard-empty">empty</span>'}
            ${hasContent ? `<button class="icon-btn clipboard-copy-btn" data-clipboard-idx="${i}" title="Copy clipboard content">Copy</button>` : ''}
          </div>
          ${hasContent ? `<pre class="clipboard-preview">${this.esc(content)}</pre>` : ''}
        </div>`;
      });
      html += '</div>';
    }

    if (this.riskFactors.length > 0) {
      html += '<div class="risk-factors">';
      this.riskFactors.forEach((f) => {
        html += `<div class="risk-factor">${this.esc(f)}</div>`;
      });
      html += '</div>';
    }

    panel.innerHTML = html;

    panel.querySelectorAll('.storage-export-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.storageCapture) return;
        const payload = {
          exported_at: new Date().toISOString(),
          analysis_id: this.currentAnalysisId || null,
          cookies: this.storageCapture.cookies || [],
          local_storage: this.storageCapture.local_storage || [],
          session_storage: this.storageCapture.session_storage || [],
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `carabistouille-storage-${this.currentAnalysisId || 'export'}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
    });

    panel.querySelectorAll('.clipboard-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const read = this.clipboardReads[parseInt(btn.dataset.clipboardIdx)];
        if (read?.content != null) {
          navigator.clipboard.writeText(read.content);
          btn.classList.add('copied');
          btn.textContent = 'Copied';
          setTimeout(() => { btn.classList.remove('copied'); btn.textContent = 'Copy'; }, 1000);
        }
      });
    });

    const redirectText = () => {
      const lines = (this.redirectChain || []).map((r, i) => `${i + 1}. ${r.from} → ${r.to} (${r.status})`);
      if (this.finalUrl) lines.push('Final: ' + this.finalUrl);
      return lines.join('\n');
    };
    panel.querySelectorAll('.redirect-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(redirectText());
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy as text'; }, 1500);
      });
    });
    panel.querySelectorAll('.redirect-dl-json-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const payload = { redirect_chain: this.redirectChain || [], final_url: this.finalUrl || null };
        this._downloadFile('redirect-chain.json', JSON.stringify(payload, null, 2), 'application/json');
      });
    });
  }

  /** Render Detection tab: list of headless/fingerprint detection attempts with category and severity. */
  renderDetectionPanel() {
    const list = document.getElementById('panel-detection-list');
    const countEl = document.getElementById('count-detection');
    if (countEl) countEl.textContent = this.detectionAttempts.length;

    if (this.detectionAttempts.length === 0) {
      list.innerHTML = '<div class="panel-empty">' + this.t('app.noDetection') + '</div>';
      return;
    }

    const grouped = {};
    for (const a of this.detectionAttempts) {
      const cat = a.category || 'other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(a);
    }

    const catOrder = ['bot-detection', 'fingerprint', 'other'];
    const catLabels = {
      'bot-detection': this.t('app.detCatBot'),
      'fingerprint': this.t('app.detCatFingerprint'),
      'other': this.t('app.detCatOther'),
    };
    const sevColors = { high: 'var(--danger)', medium: 'var(--warning)', low: 'var(--text-tertiary)' };
    const sevLabels = { high: this.t('app.detSevHigh'), medium: this.t('app.detSevMedium'), low: this.t('app.detSevLow') };

    const highCount = this.detectionAttempts.filter(a => a.severity === 'high').length;
    const medCount = this.detectionAttempts.filter(a => a.severity === 'medium').length;
    const lowCount = this.detectionAttempts.filter(a => a.severity === 'low').length;

    let html = '<div class="det-summary">';
    html += `<div class="det-summary-title">${this.t('app.detSummary')}</div>`;
    html += '<div class="det-summary-badges">';
    if (highCount > 0) html += `<span class="det-badge det-badge-high">${highCount} ${sevLabels.high}</span>`;
    if (medCount > 0) html += `<span class="det-badge det-badge-medium">${medCount} ${sevLabels.medium}</span>`;
    if (lowCount > 0) html += `<span class="det-badge det-badge-low">${lowCount} ${sevLabels.low}</span>`;
    html += `<span class="det-badge det-badge-total">${this.detectionAttempts.length} total</span>`;
    html += '</div>';
    if (highCount > 0) {
      html += `<div class="det-verdict det-verdict-detected">${this.t('app.detVerdictDetected')}</div>`;
    } else if (medCount > 0) {
      html += `<div class="det-verdict det-verdict-possible">${this.t('app.detVerdictPossible')}</div>`;
    } else {
      html += `<div class="det-verdict det-verdict-low">${this.t('app.detVerdictLow')}</div>`;
    }
    html += '</div>';

    for (const cat of catOrder) {
      const items = grouped[cat];
      if (!items || items.length === 0) continue;
      html += `<div class="det-category">`;
      html += `<div class="det-category-header">${catLabels[cat] || cat} <span class="det-category-count">(${items.length})</span></div>`;
      for (const a of items) {
        const sevColor = sevColors[a.severity] || sevColors.low;
        const timeLabel = this._timeLabel(a.timestamp);
        const absTime = this._absTime(a.timestamp);
        const callerShort = a.caller ? a.caller.replace(/^\s*at\s+/, '').substring(0, 100) : '';
        html += `<div class="det-item">`;
        html += `<div class="det-item-header">`;
        html += `<span class="det-severity" style="color:${sevColor}">${sevLabels[a.severity] || a.severity}</span>`;
        html += `<code class="det-property">${this.esc(a.property)}</code>`;
        if (absTime) html += `<span class="det-time" title="${timeLabel}">${absTime}</span>`;
        html += `</div>`;
        if (a.description) html += `<div class="det-description">${this.esc(a.description)}</div>`;
        if (callerShort) html += `<div class="det-caller" title="${this.esc(a.caller || '')}"><span class="det-caller-label">Caller:</span> ${this.esc(callerShort)}</div>`;
        html += `</div>`;
      }
      html += `</div>`;
    }

    list.innerHTML = html;
  }

  /** Run highlight.js on code blocks in the container. */
  _highlightCodeBlocks(container) {
    if (typeof hljs === 'undefined') return;
    container.querySelectorAll('code[class*="language-"]').forEach(block => {
      if (!block.dataset.highlighted) {
        hljs.highlightElement(block);
      }
    });
  }

  _downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Open modal with full source (syntax-highlighted), copy and download buttons. */
  showSourceViewer(title, content) {
    let overlay = document.getElementById('source-viewer-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'source-viewer-overlay';
      overlay.className = 'source-overlay';
      overlay.innerHTML = `
        <div class="source-modal">
          <div class="source-modal-header">
            <span class="source-modal-title"></span>
            <div class="source-modal-actions">
              <button class="icon-btn source-download" title="Download file">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button class="icon-btn source-copy-all" title="Copy all">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
              <button class="icon-btn source-close" title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
          <pre class="source-modal-code"><code class="language-javascript"></code></pre>
        </div>`;
      document.body.appendChild(overlay);

      overlay.querySelector('.source-close').addEventListener('click', () => {
        overlay.style.display = 'none';
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
      });
      overlay.querySelector('.source-copy-all').addEventListener('click', () => {
        const code = overlay.querySelector('code').textContent;
        navigator.clipboard.writeText(code);
        const btn = overlay.querySelector('.source-copy-all');
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1000);
      });
      overlay.querySelector('.source-download').addEventListener('click', () => {
        const code = overlay.querySelector('code').textContent;
        const titleEl = overlay.querySelector('.source-modal-title');
        let filename;
        try { filename = new URL(titleEl.textContent).pathname.split('/').pop() || 'download.txt'; } catch { filename = 'download.txt'; }
        this._downloadFile(filename, code, 'text/plain');
      });
    }

    overlay.querySelector('.source-modal-title').textContent = title;
    overlay._currentTitle = title;
    const codeEl = overlay.querySelector('code');
    codeEl.textContent = content;
    codeEl.removeAttribute('data-highlighted');
    const lang = this._guessLanguage(title);
    codeEl.className = lang ? `language-${lang}` : '';
    if (typeof hljs !== 'undefined' && lang) hljs.highlightElement(codeEl);
    overlay.style.display = 'flex';
  }

  _guessLanguage(titleOrUrl) {
    if (!titleOrUrl) return 'javascript';
    const lower = titleOrUrl.toLowerCase();
    if (lower.endsWith('.css') || lower.includes('text/css')) return 'css';
    if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.includes('text/html')) return 'html';
    if (lower.endsWith('.json') || lower.includes('/json')) return 'json';
    if (lower.endsWith('.xml') || lower.includes('/xml')) return 'xml';
    if (lower.endsWith('.svg')) return 'xml';
    return 'javascript';
  }

  /**
   * Send a JSON object over the viewer WebSocket (no-op if not open).
   * @param {object} data - Object to JSON.stringify and send.
   */
  wsSend(data) {
    if (this.currentStatus === 'complete' || this.currentStatus === 'error') return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      const str = JSON.stringify(data);
      this.wsBytesSent += new TextEncoder().encode(str).length;
      this.ws.send(str);
    }
  }

  /** Fetch GET /api/status once then every 3s; update agent badge, submit button, and header info. */
  async pollAgentStatus() {
    const check = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        this.runMode = data.run_mode || 'local';
        this.chromeMode = data.chrome_mode ?? null;
        this.agentBackend = data.agent_backend || 'builtin';
        this.baliverneBrowser = data.baliverne_browser ?? null;
        if (data.agent_connected) {
          this.agentStatus.classList.remove('disconnected');
          this.agentStatus.classList.add('connected');
          this.statusText.textContent = this.t('app.agentConnected');
          this.submitBtn.disabled = false;
        } else {
          this.agentStatus.classList.remove('connected');
          this.agentStatus.classList.add('disconnected');
          this.statusText.textContent = this.t('app.agentDisconnected');
          this.submitBtn.disabled = true;
        }
        this.updateAgentHeaderInfo();
        this.updateNetworkAndStreamInfo(data);
      } catch {
        this.agentStatus.classList.remove('connected');
        this.agentStatus.classList.add('disconnected');
        this.statusText.textContent = this.t('app.serverUnreachable');
        this.submitBtn.disabled = true;
        this.updateAgentHeaderInfo();
        this.updateNetworkAndStreamInfo(null);
      }
    };

    await check();
    setInterval(check, 3000);
  }

  /** Update network graph labels and stream info (video, codec, fps, input, ICE servers) from /api/status. */
  updateNetworkAndStreamInfo(data) {
    this.iceServers = Array.isArray(data?.ice_servers) ? data.ice_servers : [];
    const stream = data?.stream;
    if (this.streamVideoEl) this.streamVideoEl.textContent = stream?.video ?? '—';
    if (this.streamCodecEl) this.streamCodecEl.textContent = stream?.codec ?? '—';
    if (this.streamFpsEl) this.streamFpsEl.textContent = stream?.fps != null ? String(stream.fps) : '—';
    const inputLabels = { puppeteer: 'Puppeteer', xtest: 'xtest-injector', neko: 'Neko (xf86-input)' };
    if (this.streamInputEl) this.streamInputEl.textContent = stream?.input ? (inputLabels[stream.input] || stream.input) : '—';
    const iceServers = data?.ice_servers;
    if (this.streamIceEl) {
      if (Array.isArray(iceServers) && iceServers.length > 0) {
        this.streamIceEl.textContent = iceServers.map((s) => s.urls || s).join(', ');
        this.streamIceEl.title = iceServers.map((s) => s.urls || s).join('\n');
      } else {
        this.streamIceEl.textContent = '—';
        this.streamIceEl.title = '';
      }
    }
    if (!this.networkLabelAgentEl || !this.networkEdgeServerAgentEl) return;
    if (!data) {
      this.networkLabelAgentEl.textContent = 'Agent';
      this.networkEdgeServerAgentEl.textContent = 'WS';
      return;
    }
    const backend = data.agent_backend || 'builtin';
    const runMode = data.run_mode || 'local';
    if (backend === 'baliverne') {
      const browser = (data.baliverne_browser === 'firefox' ? 'Firefox' : 'Chrome');
      this.networkLabelAgentEl.textContent = `Baliverne (${browser})`;
      this.networkEdgeServerAgentEl.textContent = 'WebRTC / Docker';
    } else if (runMode === 'docker') {
      this.networkLabelAgentEl.textContent = 'Agent (Docker)';
      this.networkEdgeServerAgentEl.textContent = 'WS / Docker';
    } else {
      this.networkLabelAgentEl.textContent = 'Agent (local)';
      this.networkEdgeServerAgentEl.textContent = 'WebSocket';
    }
  }

  /**
   * Format timestamp as seconds since analysis start (e.g. +2.5s).
   * @param {number} timestamp - Unix ms.
   * @returns {string}
   */
  _relTime(timestamp) {
    if (!timestamp || !this.analysisStartTime) return '';
    const delta = (timestamp - this.analysisStartTime) / 1000;
    if (delta < 0) return '+0s';
    if (delta < 60) return `+${delta.toFixed(1)}s`;
    const min = Math.floor(delta / 60);
    const sec = (delta % 60).toFixed(0);
    return `+${min}m${sec}s`;
  }

  _absTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 1 });
  }

  _timeLabel(timestamp) {
    const abs = this._absTime(timestamp);
    const rel = this._relTime(timestamp);
    if (!abs) return '';
    return rel ? `${abs} (${rel})` : abs;
  }

  /**
   * Escape HTML for safe insertion into innerHTML.
   * @param {string} str - Raw string.
   * @returns {string} HTML-escaped string.
   */
  esc(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  }
}

const app = new App();
