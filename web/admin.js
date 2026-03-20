/** Verdict tag values (must match main app). */
const VERDICT_TAGS = Object.freeze({
  FALSE_POSITIVE: 'false positive',
  MALICIOUS: 'malicious',
  PHISHING: 'phishing',
  CLICK_FIX: 'click fix',
});

/** Label for display (verdict badge). */
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
 * Admin dashboard UI: analyses list, stats, detail view, delete, agent status polling.
 */
class AdminApp {
  constructor() {
    this.analyses = [];
    this.selectedId = null;
    this.initElements();
    this.initEventListeners();
    if (window.i18n) {
      window.i18n.applyTheme();
      window.i18n.applyLang();
      window.onLangChange = () => this.onLangChange();
    }
    this.refresh();
    this.pollAgentStatus();
    setInterval(() => this.refresh(), 5000);
  }

  /**
   * Translate a key using i18n if available.
   * @param {string} key - Translation key.
   * @returns {string}
   */
  t(key) {
    return window.i18n ? window.i18n.t(key) : key;
  }

  /** Re-render stats, table, and agent status text when language changes. */
  onLangChange() {
    this.renderStats();
    this.renderTable();
    this.updateAgentStatusText();
  }

  /** Update agent status label (connected / disconnected) using current language. */
  updateAgentStatusText() {
    if (!this.agentStatus || !this.statusText) return;
    if (this.agentStatus.classList.contains('connected')) {
      this.statusText.textContent = this.t('app.agentConnected');
    } else if (this.agentStatus.classList.contains('disconnected')) {
      this.statusText.textContent = this.t('app.agentDisconnected');
    }
  }

  /** Cache DOM references for stats, table, detail panel, agent status, search. */
  initElements() {
    this.statsEl = document.getElementById('admin-stats');
    this.tbody = document.getElementById('analyses-tbody');
    this.emptyEl = document.getElementById('admin-empty');
    this.detailEl = document.getElementById('admin-detail');
    this.detailBody = document.getElementById('detail-body');
    this.detailTitle = document.getElementById('detail-title');
    this.detailOpenLink = document.getElementById('detail-open-link');
    this.detailCopyLink = document.getElementById('detail-copy-link');
    this.agentStatus = document.getElementById('agent-status');
    this.statusText = this.agentStatus.querySelector('.status-text');
    this.agentModeEl = document.getElementById('agent-mode');
    this.searchInput = document.getElementById('admin-search');
  }

  /** Update header agent mode label from /api/status (agent_backend, run_mode, chrome_mode, baliverne_browser). */
  updateAgentHeaderInfo() {
    if (!this.agentModeEl) return;
    const connected = this.agentStatus?.classList.contains('connected');
    if (!connected) {
      this.agentModeEl.style.display = 'none';
      return;
    }
    let modeText = '';
    if (this.agentBackend === 'baliverne') {
      const browser = this.baliverneBrowser === 'firefox' ? 'Firefox' : 'Chrome';
      modeText = `Baliverne + ${browser}`;
    } else if (this.runMode === 'docker') {
      if (this.chromeMode === 'lightpanda') modeText = 'Docker + Lightpanda';
      else if (this.chromeMode === 'real') modeText = 'Docker + real Chrome';
      else modeText = 'Docker + headless';
    } else {
      modeText = 'Local';
    }
    this.agentModeEl.textContent = modeText;
    this.agentModeEl.style.display = 'inline';
  }

  /** Attach click handlers for refresh, detail close, search, cleanup. */
  initEventListeners() {
    document.getElementById('refresh-btn').addEventListener('click', () => this.refresh());
    document.getElementById('detail-close').addEventListener('click', () => this.closeDetail());
    if (this.searchInput) {
      this.searchInput.addEventListener('input', () => {
        this.renderTable();
      });
    }
    const cleanupBtn = document.getElementById('cleanup-db-btn');
    if (cleanupBtn) {
      cleanupBtn.addEventListener('click', () => this.cleanupDatabase());
    }
  }

  /** Return analyses filtered by current search query (URL, status, verdict, tags). */
  getFilteredAnalyses() {
    const list = Array.isArray(this.analyses) ? this.analyses : [];
    const q = (this.searchInput?.value || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter((a) => {
      const url = (a.url || '').toLowerCase();
      const status = (a.status || '').toLowerCase();
      const verdictLabel = getVerdictLabel(a.tags || []);
      const verdict = (verdictLabel || '').toLowerCase();
      const tags = (a.tags || []).map((t) => String(t).toLowerCase()).join(' ');
      return url.includes(q) || status.includes(q) || verdict.includes(q) || tags.includes(q);
    });
  }

  /** DELETE /api/analyses — clear whole database; confirm then refresh. */
  async cleanupDatabase() {
    const msg = this.t('admin.cleanupDbConfirm');
    if (!confirm(msg)) return;
    try {
      const res = await fetch('/api/analyses', { method: 'DELETE' });
      if (!res.ok) {
        console.error('[admin] Cleanup failed:', res.status, res.statusText);
        alert(res.status === 404 ? 'No analyses to delete.' : `Cleanup failed: ${res.status}`);
        return;
      }
      this.selectedId = null;
      this.detailEl.style.display = 'none';
      await this.refresh();
    } catch (err) {
      console.error('[admin] Cleanup failed:', err);
      alert('Cleanup failed: ' + (err.message || 'Network error'));
    }
  }

  /** Fetch analyses from API and re-render stats and table. */
  async refresh() {
    try {
      const res = await fetch('/api/analyses', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        console.error('[admin] GET /api/analyses failed:', res.status, res.statusText, data);
        this.analyses = [];
        this.showRefreshError(res.status, res.statusText);
      } else if (Array.isArray(data)) {
        this.analyses = data;
        this.clearRefreshError();
      } else if (data && Array.isArray(data.analyses)) {
        this.analyses = data.analyses;
        this.clearRefreshError();
      } else {
        console.warn('[admin] GET /api/analyses returned non-array:', typeof data, data);
        this.analyses = [];
        this.clearRefreshError();
      }
      this.renderStats();
      this.renderTable();
    } catch (err) {
      console.error('[admin] Refresh failed:', err);
      this.analyses = [];
      this.showRefreshError(0, err.message || 'Network error');
      this.renderStats();
      this.renderTable();
    }
  }

  /** Show error message when refresh fails (e.g. network or API error). */
  showRefreshError(status, text) {
    let el = document.getElementById('admin-refresh-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'admin-refresh-error';
      el.className = 'admin-refresh-error';
      const topbar = document.querySelector('.admin-topbar');
      if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(el, topbar.nextSibling);
    }
    el.textContent = status ? `Failed to load analyses (${status} ${text}). ` : `Failed to load analyses: ${text}. `;
    el.innerHTML += '<button type="button" class="admin-retry-btn">Retry</button>';
    el.style.display = 'block';
    el.querySelector('.admin-retry-btn').onclick = () => this.refresh();
  }

  /** Hide refresh error banner. */
  clearRefreshError() {
    const el = document.getElementById('admin-refresh-error');
    if (el) el.style.display = 'none';
  }

  /** Render stat cards: total, active, complete, errors, average risk. */
  renderStats() {
    const list = Array.isArray(this.analyses) ? this.analyses : [];
    const total = list.length;
    const running = list.filter(a => a.status === 'running' || a.status === 'pending').length;
    const complete = list.filter(a => a.status === 'complete').length;
    const errors = list.filter(a => a.status === 'error').length;
    const avgRisk = complete > 0
      ? Math.round(list.filter(a => a.risk_score != null).reduce((s, a) => s + (a.risk_score || 0), 0) / complete)
      : 0;

    this.statsEl.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${total}</div>
        <div class="stat-label">${this.t('admin.total')}</div>
      </div>
      <div class="stat-card stat-running">
        <div class="stat-value">${running}</div>
        <div class="stat-label">${this.t('admin.active')}</div>
      </div>
      <div class="stat-card stat-complete">
        <div class="stat-value">${complete}</div>
        <div class="stat-label">${this.t('admin.complete')}</div>
      </div>
      <div class="stat-card stat-error">
        <div class="stat-value">${errors}</div>
        <div class="stat-label">${this.t('admin.errors')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${avgRisk}<span class="stat-unit">/100</span></div>
        <div class="stat-label">${this.t('admin.avgRisk')}</div>
      </div>
    `;
  }

  /** Render analyses table rows; show empty state if no analyses (filtered by search). */
  renderTable() {
    const list = this.getFilteredAnalyses();
    if (!this.tbody) return;
    if (list.length === 0) {
      this.emptyEl.style.display = 'flex';
      const hasSearch = (this.searchInput?.value || '').trim().length > 0;
      const total = Array.isArray(this.analyses) ? this.analyses.length : 0;
      this.emptyEl.textContent = hasSearch && total > 0
        ? (window.i18n ? window.i18n.t('admin.noMatches') : 'No matches')
        : (window.i18n ? window.i18n.t('admin.noAnalyses') : 'No analyses yet');
      this.tbody.innerHTML = '';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.tbody.innerHTML = list.map(a => {
      const created = new Date(a.created_at).toLocaleString();
      const completed = a.completed_at ? new Date(a.completed_at).toLocaleString() : '—';
      const risk = a.risk_score != null ? a.risk_score : '—';
      const riskClass = a.risk_score != null ? this.riskClass(a.risk_score) : '';
      const requests = a.network_request_count != null ? a.network_request_count : '—';
      const scripts = a.scripts_count != null ? a.scripts_count : '—';
      const redirects = a.redirect_count != null ? a.redirect_count : '—';
      const verdictLabel = getVerdictLabel(a.tags || []);
      const verdictClass = verdictLabel === 'False positive' ? 'false-positive' : 'malicious';
      const otherTags = (a.tags || []).filter((t) => !['false positive', 'malicious', 'phishing', 'click fix'].includes(String(t).toLowerCase()));
      const tagsPreview = otherTags.length > 0 ? otherTags.slice(0, 3).join(', ') + (otherTags.length > 3 ? '…' : '') : '';

      return `
        <tr class="${a.id === this.selectedId ? 'selected' : ''}" data-id="${a.id}">
          <td><span class="status-pill ${a.status}">${a.status}</span></td>
          <td class="verdict-cell">
            ${verdictLabel ? `<span class="verdict-pill verdict-pill-${verdictClass}">${this.esc(verdictLabel)}</span>` : '—'}
            ${tagsPreview ? `<span class="tags-preview" title="${this.esc((a.tags || []).join(', '))}">${this.esc(tagsPreview)}</span>` : ''}
          </td>
          <td class="url-cell" title="${this.esc(a.url)}">${this.esc(a.url)}</td>
          <td class="time-cell">${created}</td>
          <td class="time-cell">${completed}</td>
          <td><span class="risk-cell ${riskClass}">${risk}</span></td>
          <td class="num-cell">${requests}</td>
          <td class="num-cell">${scripts}</td>
          <td class="num-cell">${redirects}</td>
          <td class="actions-cell">
            <a href="/?id=${this.esc(a.id)}" class="row-btn open-btn" data-id="${a.id}" title="${this.t('admin.openInAnalyzer')}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
            <button class="row-btn view-btn" data-id="${a.id}" title="${this.t('admin.viewDetails')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="row-btn delete-btn" data-id="${a.id}" title="${this.t('admin.deleteAnalysis')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </td>
        </tr>`;
    }).join('');

    this.tbody.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showDetail(btn.dataset.id);
      });
    });

    this.tbody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteAnalysis(btn.dataset.id);
      });
    });

    this.tbody.querySelectorAll('tr[data-id]').forEach(row => {
      row.addEventListener('click', () => this.showDetail(row.dataset.id));
    });
  }

  /**
   * Load analysis by id from API and show detail panel with rendered report.
   * @param {string} id - Analysis UUID.
   */
  async showDetail(id) {
    this.selectedId = id;
    this.renderTable();

    const permalink = `${window.location.origin}/?id=${id}`;
    if (this.detailOpenLink) {
      this.detailOpenLink.href = permalink;
      this.detailOpenLink.style.display = 'inline-flex';
    }
    if (this.detailCopyLink) {
      this.detailCopyLink.onclick = () => {
        navigator.clipboard.writeText(permalink).then(() => {
          this.detailCopyLink.textContent = this.t('admin.copied') || 'Copied!';
          setTimeout(() => { this.detailCopyLink.textContent = 'Copy link'; }, 2000);
        });
      };
    }

    try {
      const res = await fetch(`/api/analyses/${id}`);
      if (!res.ok) return;
      const a = await res.json();

      this.detailTitle.textContent = a.url;
      this.detailBody.innerHTML = this.renderDetail(a);
      this.detailEl.style.display = 'flex';
    } catch (err) {
      console.error('[admin] Detail load failed:', err);
    }
  }

  /**
   * Build HTML for the analysis detail panel (risk, page info, redirects, security, network, scripts, console).
   * @param {object} a - Analysis object from API (id, url, status, report, etc.).
   * @returns {string} HTML string.
   */
  renderDetail(a) {
    const verdictLabel = getVerdictLabel(a.tags || []);
    const verdictClass = verdictLabel === 'False positive' ? 'false-positive' : 'malicious';
    const tagsList = (a.tags || []).map((t) => this.esc(t)).join(', ');
    const notes = (a.notes || '').trim();

    let html = `
      <div class="detail-section">
        <div class="detail-grid">
          <div class="detail-field"><span class="field-label">ID</span><span class="field-value mono">${this.esc(a.id)}</span></div>
          <div class="detail-field"><span class="field-label">Status</span><span class="status-pill ${a.status}">${a.status}</span></div>
          ${verdictLabel ? `<div class="detail-field"><span class="field-label">Verdict</span><span class="verdict-pill verdict-pill-${verdictClass}">${this.esc(verdictLabel)}</span></div>` : ''}
          <div class="detail-field"><span class="field-label">URL</span><span class="field-value mono">${this.esc(a.url)}</span></div>
          <div class="detail-field"><span class="field-label">Created</span><span class="field-value">${new Date(a.created_at).toLocaleString()}</span></div>
          <div class="detail-field"><span class="field-label">Completed</span><span class="field-value">${a.completed_at ? new Date(a.completed_at).toLocaleString() : '—'}</span></div>
        </div>
      </div>`;

    const opts = a.run_options;
    if (opts && (opts.proxy || opts.user_agent || opts.timezone_id || opts.locale || opts.viewport_width != null || opts.network_throttling || opts.latitude != null || opts.longitude != null)) {
      const parts = [];
      if (opts.proxy) parts.push(`<div class="detail-field"><span class="field-label">Proxy</span><span class="field-value mono">${this.esc(opts.proxy)}</span></div>`);
      if (opts.user_agent) { const ua = String(opts.user_agent); parts.push(`<div class="detail-field"><span class="field-label">User agent</span><span class="field-value mono">${this.esc(ua.length > 80 ? ua.slice(0, 80) + '…' : ua)}</span></div>`); }
      if (opts.viewport_width != null && opts.viewport_height != null) parts.push(`<div class="detail-field"><span class="field-label">Viewport</span><span class="field-value">${opts.viewport_width}×${opts.viewport_height}</span></div>`);
      if (opts.device_scale_factor != null) parts.push(`<div class="detail-field"><span class="field-label">Device scale</span><span class="field-value">${opts.device_scale_factor}</span></div>`);
      if (opts.is_mobile != null) parts.push(`<div class="detail-field"><span class="field-label">Mobile</span><span class="field-value">${opts.is_mobile ? 'Yes' : 'No'}</span></div>`);
      if (opts.network_throttling) parts.push(`<div class="detail-field"><span class="field-label">Network throttling</span><span class="field-value">${this.esc(opts.network_throttling)}</span></div>`);
      if (opts.timezone_id) parts.push(`<div class="detail-field"><span class="field-label">Timezone</span><span class="field-value">${this.esc(opts.timezone_id)}</span></div>`);
      if (opts.locale) parts.push(`<div class="detail-field"><span class="field-label">Locale</span><span class="field-value">${this.esc(opts.locale)}</span></div>`);
      if (opts.latitude != null || opts.longitude != null) parts.push(`<div class="detail-field"><span class="field-label">Geo</span><span class="field-value">${opts.latitude ?? '—'}, ${opts.longitude ?? '—'}</span></div>`);
      html += `<div class="detail-section"><h3>Options used</h3><div class="detail-grid">${parts.join('')}</div></div>`;
    }

    if (tagsList || notes) {
      html += `
      <div class="detail-section">
        <h3>Notes &amp; Tags</h3>
        ${notes ? `<div class="detail-notes">${this.esc(notes)}</div>` : ''}
        ${tagsList ? `<div class="detail-tags"><span class="field-label">Tags</span> ${tagsList}</div>` : ''}
      </div>`;
    }

    if (!a.report) {
      html += '<div class="detail-section"><div class="detail-empty">No report available</div></div>';
      return html;
    }

    const r = a.report;
    html += `
      <div class="detail-section">
        <h3>Risk Assessment</h3>
        <div class="detail-risk">
          <span class="detail-risk-score ${this.riskClass(r.risk_score)}">${r.risk_score}/100</span>
        </div>
        ${r.risk_factors.length > 0 ? `
          <div class="detail-factors">
            ${r.risk_factors.map(f => `<div class="detail-factor">${this.esc(f)}</div>`).join('')}
          </div>` : ''}
      </div>`;

    if (r.final_url || r.page_title) {
      html += `
        <div class="detail-section">
          <h3>Page Info</h3>
          ${r.page_title ? `<div class="detail-field"><span class="field-label">Title</span><span class="field-value">${this.esc(r.page_title)}</span></div>` : ''}
          ${r.final_url ? `<div class="detail-field"><span class="field-label">Final URL</span><span class="field-value mono">${this.esc(r.final_url)}</span></div>` : ''}
        </div>`;
    }

    if (r.redirect_chain.length > 0) {
      html += `
        <div class="detail-section">
          <h3>Redirect Chain (${r.redirect_chain.length})</h3>
          <div class="detail-list">
            ${r.redirect_chain.map(rd => `
              <div class="redirect-row">
                <span class="redirect-status">${rd.status}</span>
                <span class="redirect-from mono">${this.esc(rd.from)}</span>
                <span class="redirect-arrow">&rarr;</span>
                <span class="redirect-to mono">${this.esc(rd.to)}</span>
              </div>`).join('')}
          </div>
        </div>`;
    }

    if (r.security) {
      const s = r.security;
      html += `
        <div class="detail-section">
          <h3>Security</h3>
          <div class="detail-list">
            <div class="security-row">${s.ssl_valid ? '&#x2705;' : '&#x274C;'} SSL: ${s.ssl_valid ? 'Valid' : 'Invalid or missing'}${s.ssl_issuer ? ` (${this.esc(s.ssl_issuer)})` : ''}</div>
            <div class="security-row">${s.has_mixed_content ? '&#x26A0;' : '&#x2705;'} Mixed content: ${s.has_mixed_content ? 'Detected' : 'None'}</div>
            ${(s.suspicious_patterns || []).map(p => `<div class="security-row">&#x26A0; ${this.esc(p)}</div>`).join('')}
          </div>
        </div>`;
    }

    html += `
      <div class="detail-section">
        <h3>Network Requests (${r.network_requests.length})</h3>
        ${r.network_requests.length > 0 ? `
          <div class="detail-table-wrap">
            <table class="detail-table">
              <thead><tr><th>Status</th><th>Method</th><th>URL</th><th>Type</th><th>3rd Party</th></tr></thead>
              <tbody>
                ${r.network_requests.map(req => `
                  <tr>
                    <td><span class="net-status-cell s${Math.floor((req.status || 0) / 100)}xx">${req.status || '...'}</span></td>
                    <td>${this.esc(req.method)}</td>
                    <td class="url-cell mono" title="${this.esc(req.url)}">${this.esc(req.url)}</td>
                    <td>${this.esc(req.content_type || '—')}</td>
                    <td>${req.is_third_party ? '<span class="badge-warn">Yes</span>' : 'No'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<div class="detail-empty">None</div>'}
      </div>`;

    html += `
      <div class="detail-section">
        <h3>Scripts (${r.scripts.length})</h3>
        ${r.scripts.length > 0 ? `
          <div class="detail-list">
            ${r.scripts.map(s => `
              <div class="script-detail-row">
                <span class="script-type-badge ${s.is_inline ? 'inline' : 'external'}">${s.is_inline ? 'INLINE' : 'EXTERNAL'}</span>
                <span class="mono">${this.esc(s.url || '(inline)')}</span>
                ${s.size ? ` <span class="text-muted">${(s.size / 1024).toFixed(1)} KB</span>` : ''}
              </div>`).join('')}
          </div>` : '<div class="detail-empty">None</div>'}
      </div>`;

    if (r.console_logs.length > 0) {
      html += `
        <div class="detail-section">
          <h3>Console Logs (${r.console_logs.length})</h3>
          <div class="detail-list console-detail">
            ${r.console_logs.map(l => `<div class="console-detail-row ${l.level}">[${l.level}] ${this.esc(l.text)}</div>`).join('')}
          </div>
        </div>`;
    }

    return html;
  }

  /**
   * Delete analysis by id (after confirm); refresh list and close detail if that analysis was selected.
   * @param {string} id - Analysis UUID.
   */
  async deleteAnalysis(id) {
    if (!confirm(this.t('admin.deleteConfirm'))) return;
    try {
      const res = await fetch(`/api/analyses/${id}`, { method: 'DELETE' });
      if (res.ok) {
        if (this.selectedId === id) this.closeDetail();
        this.refresh();
      } else {
        const msg = res.status === 404 ? 'Analysis not found.' : `Delete failed (${res.status}).`;
        alert(msg);
      }
    } catch (err) {
      console.error('[admin] Delete failed:', err);
      alert('Delete failed: ' + (err.message || 'network error'));
    }
  }

  /** Close the detail panel and clear selected analysis. */
  closeDetail() {
    this.selectedId = null;
    this.detailEl.style.display = 'none';
    this.renderTable();
  }

  /**
   * Return CSS class for risk score (risk-low, risk-medium, risk-high).
   * @param {number} score - Risk score 0–100.
   * @returns {string}
   */
  riskClass(score) {
    if (score <= 25) return 'risk-low';
    if (score <= 50) return 'risk-medium';
    return 'risk-high';
  }

  /** Poll /api/status and update agent status badge; run once then every 3s. */
  async pollAgentStatus() {
    const check = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        this.agentBackend = data.agent_backend || 'builtin';
        this.runMode = data.run_mode || 'local';
        this.chromeMode = data.chrome_mode || null;
        this.baliverneBrowser = data.baliverne_browser || null;
        if (data.agent_connected) {
          this.agentStatus.classList.remove('disconnected');
          this.agentStatus.classList.add('connected');
          this.statusText.textContent = this.t('app.agentConnected');
        } else {
          this.agentStatus.classList.remove('connected');
          this.agentStatus.classList.add('disconnected');
          this.statusText.textContent = this.t('app.agentDisconnected');
        }
        this.updateAgentHeaderInfo();
      } catch {
        this.agentStatus.classList.remove('connected');
        this.agentStatus.classList.add('disconnected');
        this.statusText.textContent = this.t('admin.serverUnreachable');
        this.updateAgentHeaderInfo();
      }
    };
    await check();
    setInterval(check, 3000);
  }

  /**
   * Escape string for safe HTML insertion.
   * @param {string} str - Raw string.
   * @returns {string} HTML-escaped string.
   */
  esc(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  }
}

const admin = new AdminApp();
