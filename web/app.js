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
    this.pageSource = null;
    this.screenshotTimeline = [];
    this.screenshotTimelineCount = 0;
    this.lastMouseMoveTime = 0;
    this.screenshotCount = 0;
    this.wsEventCount = 0;
    this.analysisStartTime = null;

    this.initElements();
    this.initEventListeners();
    this.loadAnalyses();
    this.pollAgentStatus();

    console.log('[ui] App initialized');
  }

  initElements() {
    this.urlForm = document.getElementById('url-form');
    this.urlInput = document.getElementById('url-input');
    this.proxyInput = document.getElementById('proxy-input');
    this.proxyToggle = document.getElementById('proxy-toggle');
    this.submitBtn = document.getElementById('submit-btn');
    this.stopBtn = document.getElementById('stop-btn');
    this.analysesList = document.getElementById('analyses-list');
    this.agentStatus = document.getElementById('agent-status');
    this.statusText = this.agentStatus.querySelector('.status-text');
    this.viewportImg = document.getElementById('viewport-img');
    this.viewportPlaceholder = document.getElementById('viewport-placeholder');
    this.viewportWrapper = document.getElementById('viewport-wrapper');
    this.inspectHighlight = document.getElementById('inspect-highlight');
    this.elementInspector = document.getElementById('element-inspector');
    this.inspectorContent = document.getElementById('inspector-content');
    this.pageUrl = document.getElementById('page-url');
    this.riskBadge = document.getElementById('risk-badge');
    this.riskScoreEl = document.getElementById('risk-score');
  }

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

    document.querySelectorAll('.report-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.report-tabs .tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
        if (tab.dataset.tab === 'screenshots' && this.screenshotTimeline.length === 0 && this.screenshotTimelineCount > 0) {
          this.loadScreenshotTimeline();
        }
      });
    });

    document.getElementById('search-network').addEventListener('input', () => this.renderNetworkPanel());
    document.getElementById('search-scripts').addEventListener('input', () => this.renderScriptsPanel());
    document.getElementById('search-console').addEventListener('input', () => this.renderConsolePanel());
    document.getElementById('search-raw').addEventListener('input', () => this.renderRawPanel());

    this.viewportImg.addEventListener('click', (e) => this.handleViewportClick(e));
    this.viewportImg.addEventListener('wheel', (e) => this.handleViewportScroll(e), { passive: false });
    this.viewportImg.addEventListener('mousemove', (e) => this.handleViewportMouseMove(e));

    document.addEventListener('keydown', (e) => {
      if (!this.ws || !this.currentAnalysisId) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.classList.contains('search-input')) return;

      if (e.key.length === 1) {
        this.wsSend({ type: 'type_text', text: e.key });
      } else {
        this.wsSend({ type: 'keypress', key: e.key });
      }
    });

    this._initReportResizer();
  }

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

  getViewportCoords(e) {
    const rect = this.viewportImg.getBoundingClientRect();
    const scaleX = this.viewportImg.naturalWidth / rect.width;
    const scaleY = this.viewportImg.naturalHeight / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  handleViewportClick(e) {
    if (!this.ws) return;
    const { x, y } = this.getViewportCoords(e);
    console.log(`[ui] Viewport click at (${x.toFixed(0)}, ${y.toFixed(0)}) tool=${this.activeTool}`);

    if (this.activeTool === 'inspect') {
      this.wsSend({ type: 'inspect', x, y });
    } else {
      this.wsSend({ type: 'click', x, y });
    }
  }

  handleViewportScroll(e) {
    if (!this.ws) return;
    e.preventDefault();
    this.wsSend({ type: 'scroll', delta_x: e.deltaX, delta_y: e.deltaY });
  }

  handleViewportMouseMove(e) {
    if (!this.ws || this.activeTool !== 'interact') return;

    const now = Date.now();
    if (now - this.lastMouseMoveTime < 100) return;
    this.lastMouseMoveTime = now;

    const { x, y } = this.getViewportCoords(e);
    this.wsSend({ type: 'mousemove', x, y });
  }

  async submitUrl() {
    const url = this.urlInput.value.trim();
    if (!url) return;

    const proxy = this.proxyInput.value.trim() || undefined;
    console.log(`[ui] Submitting URL: ${url}${proxy ? ` via proxy ${proxy}` : ''}`);
    this.submitBtn.disabled = true;
    try {
      const body = { url };
      if (proxy) body.proxy = proxy;
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

  async stopAnalysis() {
    if (!this.currentAnalysisId) return;

    this.stopBtn.disabled = true;
    try {
      this.wsSend({ type: 'stop_analysis' });
      const res = await fetch(`/api/analyses/${this.currentAnalysisId}/stop`, { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        console.warn(`[ui] Stop failed: ${res.status} ${text}`);
      }
    } catch (err) {
      console.error('[ui] Stop error:', err);
    }
  }

  async loadAnalyses() {
    try {
      const res = await fetch('/api/analyses');
      const analyses = await res.json();
      this.renderAnalysesList(analyses);
    } catch (err) {
      console.error('[ui] Failed to load analyses:', err);
    }
  }

  renderAnalysesList(analyses) {
    this.analysesList.innerHTML = analyses
      .map((a) => {
        const isActive = a.id === this.currentAnalysisId;
        const time = new Date(a.created_at).toLocaleTimeString();
        let displayUrl;
        try { displayUrl = new URL(a.url).hostname; } catch { displayUrl = a.url; }
        return `
        <div class="analysis-card ${isActive ? 'active' : ''}" data-id="${a.id}">
          <div class="analysis-url" title="${this.esc(a.url)}">${this.esc(displayUrl)}</div>
          <div class="analysis-meta">
            <span class="analysis-status ${a.status}">${a.status}</span>
            <span>${time}</span>
          </div>
        </div>`;
      })
      .join('');

    this.analysesList.querySelectorAll('.analysis-card').forEach((card) => {
      card.addEventListener('click', () => this.selectAnalysis(card.dataset.id));
    });
  }

  selectAnalysis(id) {
    console.log(`[ui] Selecting analysis: ${id}`);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.currentAnalysisId = id;
    this.currentStatus = null;
    this.screenshotCount = 0;
    this.wsEventCount = 0;
    this.resetReportPanels();
    this.loadAnalyses();
    this.loadAnalysisReport(id);
    this.connectViewer(id);
  }

  updateStopButton(status) {
    this.currentStatus = status;
    const active = status === 'pending' || status === 'running';
    this.stopBtn.style.display = active ? 'inline-flex' : 'none';
    this.stopBtn.disabled = false;
  }

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
    this.pageSource = null;
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
    this.riskBadge.style.display = 'none';
    this.stopBtn.style.display = 'none';
    this.pageUrl.textContent = '';
    this.inspectHighlight.style.display = 'none';
    this.elementInspector.style.display = 'none';
    this.viewportImg.style.display = 'none';
    this.viewportPlaceholder.style.display = 'flex';
  }

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

      if (analysis.status === 'pending' || analysis.status === 'running') {
        this.updateStopButton(analysis.status);
      }

      // Show the last screenshot for completed/error analyses
      if (analysis.screenshot && (analysis.status === 'complete' || analysis.status === 'error')) {
        this.viewportPlaceholder.style.display = 'none';
        this.viewportImg.style.display = 'block';
        this.viewportImg.src = `data:image/jpeg;base64,${analysis.screenshot}`;
      }

      if (analysis.report) {
        const r = analysis.report;
        this.networkRequests = r.network_requests || [];
        this.scripts = r.scripts || [];
        this.consoleLogs = r.console_logs || [];
        this.security = r.security || null;
        this.riskScore = r.risk_score;
        this.riskFactors = r.risk_factors || [];
        this.clipboardReads = r.clipboard_reads || [];
        this.rawFiles = r.raw_files || [];
        this.pageSource = r.page_source || null;

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
        this.updateRiskBadge();
      }

      if (analysis.status === 'complete' || analysis.status === 'error') {
        this.loadScreenshotTimeline();
      }
    } catch (err) {
      console.error('[ui] Failed to load analysis:', err);
    }
  }

  connectViewer(analysisId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/viewer/${analysisId}`;
    console.log(`[ui] Connecting viewer WS: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[ui] Viewer WS connected for ${analysisId}`);
    };

    this.ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        this.wsEventCount++;
        if (event.type !== 'screenshot') {
          console.log(`[ui] <- WS event: ${event.type} (total: ${this.wsEventCount})`);
        }
        this.handleViewerEvent(event);
      } catch (err) {
        console.error('[ui] WS parse error:', err, 'data:', e.data?.substring?.(0, 200));
      }
    };

    this.ws.onclose = (e) => {
      console.log(`[ui] Viewer WS closed (code=${e.code}, reason=${e.reason})`);
      if (this.currentAnalysisId === analysisId) {
        console.log(`[ui] Will reconnect in 2s...`);
        setTimeout(() => {
          if (this.currentAnalysisId === analysisId && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
            this.connectViewer(analysisId);
          }
        }, 2000);
      }
    };

    this.ws.onerror = (e) => {
      console.error(`[ui] Viewer WS error:`, e);
    };
  }

  handleViewerEvent(event) {
    switch (event.type) {
      case 'screenshot':
        this.screenshotCount++;
        if (this.screenshotCount <= 3 || this.screenshotCount % 10 === 0) {
          console.log(`[ui] Screenshot #${this.screenshotCount} received (${(event.data.length / 1024).toFixed(1)} KB)`);
        }
        this.viewportPlaceholder.style.display = 'none';
        this.viewportImg.style.display = 'block';
        this.viewportImg.src = `data:image/jpeg;base64,${event.data}`;
        if (this.currentStatus !== 'complete' && this.currentStatus !== 'error') {
          this.updateStopButton('running');
        }
        break;

      case 'network_request_captured':
        if (!this.analysisStartTime && event.request.timestamp) {
          this.analysisStartTime = event.request.timestamp;
        }
        this.networkRequests.push(event.request);
        this.renderNetworkPanel();
        break;

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

      case 'clipboard_captured':
        this.clipboardReads.push(event.read);
        this.renderSecurityPanel();
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
          if (r.raw_files?.length > this.rawFiles.length) this.rawFiles = r.raw_files;
          if (r.page_source) this.pageSource = r.page_source;

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
          this.updateRiskBadge();
        }
        if (event.status === 'pending' || event.status === 'running') {
          this.updateStopButton(event.status);
        }
        break;

      case 'redirect_detected':
        console.log(`[ui] Redirect: ${event.from} -> ${event.to}`);
        break;

      case 'navigation_complete':
        console.log(`[ui] Navigation complete: ${event.url} "${event.title}"`);
        this.pageUrl.textContent = event.url;
        if (event.title) {
          document.title = `${event.title} — Carabistouille`;
        }
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
          if (event.report.raw_files?.length) this.rawFiles = event.report.raw_files;
          if (event.report.page_source) this.pageSource = event.report.page_source;
          this.security = event.report.security || null;
          this.riskScore = event.report.risk_score;
          this.riskFactors = event.report.risk_factors || [];
          this.renderNetworkPanel();
          this.renderScriptsPanel();
          this.renderConsolePanel();
          this.renderRawPanel();
          this.renderSecurityPanel();
          this.updateRiskBadge();
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

      default:
        console.warn(`[ui] Unknown event type: ${event.type}`);
    }
  }

  showElementInfo(info) {
    const imgRect = this.viewportImg.getBoundingClientRect();
    const scaleX = imgRect.width / this.viewportImg.naturalWidth;
    const scaleY = imgRect.height / this.viewportImg.naturalHeight;

    const imgOffset = {
      x: this.viewportImg.offsetLeft,
      y: this.viewportImg.offsetTop,
    };

    this.inspectHighlight.style.display = 'block';
    this.inspectHighlight.style.left = `${imgOffset.x + info.rect.x * scaleX}px`;
    this.inspectHighlight.style.top = `${imgOffset.y + info.rect.y * scaleY}px`;
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

  updateRiskBadge() {
    if (this.riskScore === null || this.riskScore === undefined) return;

    this.riskBadge.style.display = 'inline-flex';
    this.riskScoreEl.textContent = `${this.riskScore}/100`;

    this.riskBadge.classList.remove('low', 'medium', 'high');
    if (this.riskScore <= 25) this.riskBadge.classList.add('low');
    else if (this.riskScore <= 50) this.riskBadge.classList.add('medium');
    else this.riskBadge.classList.add('high');
  }

  renderNetworkPanel() {
    const list = document.getElementById('panel-network-list');
    document.getElementById('count-network').textContent = this.networkRequests.length;

    if (this.networkRequests.length === 0) {
      list.innerHTML = '<div class="panel-empty">No network data yet</div>';
      return;
    }

    const query = (document.getElementById('search-network')?.value || '').toLowerCase();
    const filtered = query
      ? this.networkRequests.filter(r => r.url.toLowerCase().includes(query) || (r.content_type || '').toLowerCase().includes(query) || r.method.toLowerCase().includes(query))
      : this.networkRequests;

    list.innerHTML = filtered
      .map((r, i) => {
        const statusClass = r.status ? `s${Math.floor(r.status / 100)}xx` : '';
        const thirdPartyClass = r.is_third_party ? 'third-party' : '';
        const ct = r.content_type || '';
        const isJs = ct.includes('javascript') || r.url.endsWith('.js');
        const scriptMatch = isJs ? this.scripts.find(s => s.url === r.url && s.content) : null;
        const timeLabel = this._timeLabel(r.timestamp);
        return `
        <div class="net-row" data-idx="${i}">
          <span class="net-time" title="${timeLabel}">${this._absTime(r.timestamp)}</span>
          <span class="net-status ${statusClass}">${r.status || '...'}</span>
          <span class="net-method">${this.esc(r.method)}</span>
          <div class="net-url-wrap">
            <span class="net-url-full ${thirdPartyClass}">${this.esc(r.url)}</span>
            <span class="net-actions">
              <button class="icon-btn copy-btn" data-url="${this.esc(r.url)}" title="Copy URL">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
              ${scriptMatch ? `<button class="icon-btn js-btn" data-script-url="${this.esc(r.url)}" title="View JS source locally">JS</button>` : ''}
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
  }

  renderScriptsPanel() {
    const list = document.getElementById('panel-scripts-list');
    document.getElementById('count-scripts').textContent = this.scripts.length;

    if (this.scripts.length === 0) {
      list.innerHTML = '<div class="panel-empty">No scripts detected</div>';
      return;
    }

    const query = (document.getElementById('search-scripts')?.value || '').toLowerCase();
    const filtered = query
      ? this.scripts.filter(s =>
          (s.url || '').toLowerCase().includes(query) ||
          (s.is_inline && 'inline'.includes(query)) ||
          (s.content || '').toLowerCase().includes(query))
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

  renderConsolePanel() {
    const list = document.getElementById('panel-console-list');
    document.getElementById('count-console').textContent = this.consoleLogs.length;

    if (this.consoleLogs.length === 0) {
      list.innerHTML = '<div class="panel-empty">No console output</div>';
      return;
    }

    const query = (document.getElementById('search-console')?.value || '').toLowerCase();
    const filtered = query
      ? this.consoleLogs.filter(l => l.text.toLowerCase().includes(query) || l.level.toLowerCase().includes(query))
      : this.consoleLogs;

    list.innerHTML = filtered
      .map((l) => {
        const timeLabel = this._timeLabel(l.timestamp);
        return `<div class="console-row ${l.level}">${timeLabel ? `<span class="timeline-badge" title="${timeLabel}">${this._absTime(l.timestamp)} <span class="rel">${this._relTime(l.timestamp)}</span></span> ` : ''}[${l.level}] ${this.esc(l.text)}</div>`;
      })
      .join('');
  }

  renderRawPanel() {
    const list = document.getElementById('panel-raw-list');
    const totalCount = this.rawFiles.length + (this.pageSource ? 1 : 0);
    document.getElementById('count-raw').textContent = totalCount;

    if (this.rawFiles.length === 0 && !this.pageSource) {
      list.innerHTML = '<div class="panel-empty">No files captured yet</div>';
      return;
    }

    const query = (document.getElementById('search-raw')?.value || '').toLowerCase();

    // Page Source pinned entry
    let pageSourceHtml = '';
    if (this.pageSource && (!query || 'page source'.includes(query) || 'html'.includes(query))) {
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

    const filtered = query
      ? this.rawFiles.filter(f => f.url.toLowerCase().includes(query) || (f.content_type || '').toLowerCase().includes(query))
      : this.rawFiles;

    list.innerHTML = pageSourceHtml + filtered
      .map((f, i) => {
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
        <div class="raw-entry" data-raw-idx="${i}">
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
                <button class="icon-btn copy-content-btn" data-raw-idx="${i}" title="Copy content">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="icon-btn dl-btn" data-raw-idx="${i}" title="Download file">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
                <button class="icon-btn view-src-btn" data-raw-idx="${i}" title="Open in full viewer">
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

  async loadScreenshotTimeline() {
    if (!this.currentAnalysisId) return;
    try {
      const res = await fetch(`/api/analyses/${this.currentAnalysisId}/screenshots`);
      if (!res.ok) return;
      this.screenshotTimeline = await res.json();
      document.getElementById('count-screenshots').textContent = this.screenshotTimeline.length;
      this.renderScreenshotsPanel();
    } catch (err) {
      console.error('[ui] Failed to load screenshot timeline:', err);
    }
  }

  renderScreenshotsPanel() {
    const list = document.getElementById('panel-screenshots-list');
    document.getElementById('count-screenshots').textContent = this.screenshotTimeline.length || this.screenshotTimelineCount || 0;

    if (this.screenshotTimeline.length === 0) {
      const msg = this.screenshotTimelineCount > 0
        ? `${this.screenshotTimelineCount} screenshots available — click to load`
        : 'No screenshots captured yet';
      list.innerHTML = `<div class="panel-empty ss-load-prompt">${msg}</div>`;
      if (this.screenshotTimelineCount > 0) {
        list.querySelector('.ss-load-prompt').style.cursor = 'pointer';
        list.querySelector('.ss-load-prompt').addEventListener('click', () => this.loadScreenshotTimeline());
      }
      return;
    }

    const firstTs = this.screenshotTimeline[0].timestamp;
    list.innerHTML = `<div class="ss-gallery">${
      this.screenshotTimeline.map((ss, i) => {
        const relSec = ((ss.timestamp - firstTs) / 1000).toFixed(0);
        const absTime = new Date(ss.timestamp).toLocaleTimeString();
        return `<div class="ss-thumb" data-ss-idx="${i}" title="${absTime} (+${relSec}s)">
          <img src="data:image/jpeg;base64,${ss.data}" loading="lazy" alt="Screenshot ${i + 1}">
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

  _showScreenshotModal(idx) {
    const ss = this.screenshotTimeline[idx];
    if (!ss) return;

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
      const blob = this._b64toBlob(entry.data, 'image/jpeg');
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
    modal.querySelector('.ss-modal-img').src = `data:image/jpeg;base64,${entry.data}`;
    modal.querySelector('#ss-prev').disabled = i <= 0;
    modal.querySelector('#ss-next').disabled = i >= this.screenshotTimeline.length - 1;
    modal.dataset.currentIdx = i;
  }

  _b64toBlob(b64, type) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type });
  }

  renderSecurityPanel() {
    const panel = document.getElementById('panel-security');

    if (!this.security && this.riskFactors.length === 0 && this.clipboardReads.length === 0) {
      panel.innerHTML = '<div class="panel-empty">No security analysis yet</div>';
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
  }

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

  wsSend(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  async pollAgentStatus() {
    const check = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        if (data.agent_connected) {
          this.agentStatus.classList.remove('disconnected');
          this.agentStatus.classList.add('connected');
          this.statusText.textContent = 'Agent connected';
          this.submitBtn.disabled = false;
        } else {
          this.agentStatus.classList.remove('connected');
          this.agentStatus.classList.add('disconnected');
          this.statusText.textContent = 'Agent disconnected';
          this.submitBtn.disabled = true;
        }
      } catch {
        this.agentStatus.classList.remove('connected');
        this.agentStatus.classList.add('disconnected');
        this.statusText.textContent = 'Server unreachable';
        this.submitBtn.disabled = true;
      }
    };

    await check();
    setInterval(check, 3000);
  }

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

  esc(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  }
}

const app = new App();
