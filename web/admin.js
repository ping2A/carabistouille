class AdminApp {
  constructor() {
    this.analyses = [];
    this.selectedId = null;
    this.initElements();
    this.initEventListeners();
    this.refresh();
    this.pollAgentStatus();
    setInterval(() => this.refresh(), 5000);
  }

  initElements() {
    this.statsEl = document.getElementById('admin-stats');
    this.tbody = document.getElementById('analyses-tbody');
    this.emptyEl = document.getElementById('admin-empty');
    this.detailEl = document.getElementById('admin-detail');
    this.detailBody = document.getElementById('detail-body');
    this.detailTitle = document.getElementById('detail-title');
    this.agentStatus = document.getElementById('agent-status');
    this.statusText = this.agentStatus.querySelector('.status-text');
  }

  initEventListeners() {
    document.getElementById('refresh-btn').addEventListener('click', () => this.refresh());
    document.getElementById('detail-close').addEventListener('click', () => this.closeDetail());
  }

  async refresh() {
    try {
      const res = await fetch('/api/analyses');
      this.analyses = await res.json();
      this.renderStats();
      this.renderTable();
    } catch (err) {
      console.error('[admin] Refresh failed:', err);
    }
  }

  renderStats() {
    const total = this.analyses.length;
    const running = this.analyses.filter(a => a.status === 'running' || a.status === 'pending').length;
    const complete = this.analyses.filter(a => a.status === 'complete').length;
    const errors = this.analyses.filter(a => a.status === 'error').length;
    const avgRisk = complete > 0
      ? Math.round(this.analyses.filter(a => a.report).reduce((s, a) => s + (a.report.risk_score || 0), 0) / complete)
      : 0;

    this.statsEl.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${total}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat-card stat-running">
        <div class="stat-value">${running}</div>
        <div class="stat-label">Active</div>
      </div>
      <div class="stat-card stat-complete">
        <div class="stat-value">${complete}</div>
        <div class="stat-label">Complete</div>
      </div>
      <div class="stat-card stat-error">
        <div class="stat-value">${errors}</div>
        <div class="stat-label">Errors</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${avgRisk}<span class="stat-unit">/100</span></div>
        <div class="stat-label">Avg Risk</div>
      </div>
    `;
  }

  renderTable() {
    if (this.analyses.length === 0) {
      this.emptyEl.style.display = 'flex';
      this.tbody.innerHTML = '';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.tbody.innerHTML = this.analyses.map(a => {
      const created = new Date(a.created_at).toLocaleString();
      const completed = a.completed_at ? new Date(a.completed_at).toLocaleString() : '—';
      const risk = a.report ? a.report.risk_score : '—';
      const riskClass = a.report ? this.riskClass(a.report.risk_score) : '';
      const requests = a.report ? a.report.network_requests.length : '—';
      const scripts = a.report ? a.report.scripts.length : '—';
      const redirects = a.report ? a.report.redirect_chain.length : '—';

      return `
        <tr class="${a.id === this.selectedId ? 'selected' : ''}" data-id="${a.id}">
          <td><span class="status-pill ${a.status}">${a.status}</span></td>
          <td class="url-cell" title="${this.esc(a.url)}">${this.esc(a.url)}</td>
          <td class="time-cell">${created}</td>
          <td class="time-cell">${completed}</td>
          <td><span class="risk-cell ${riskClass}">${risk}</span></td>
          <td class="num-cell">${requests}</td>
          <td class="num-cell">${scripts}</td>
          <td class="num-cell">${redirects}</td>
          <td class="actions-cell">
            <button class="row-btn view-btn" data-id="${a.id}" title="View details">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="row-btn delete-btn" data-id="${a.id}" title="Delete analysis">
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

  async showDetail(id) {
    this.selectedId = id;
    this.renderTable();

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

  renderDetail(a) {
    let html = `
      <div class="detail-section">
        <div class="detail-grid">
          <div class="detail-field"><span class="field-label">ID</span><span class="field-value mono">${this.esc(a.id)}</span></div>
          <div class="detail-field"><span class="field-label">Status</span><span class="status-pill ${a.status}">${a.status}</span></div>
          <div class="detail-field"><span class="field-label">URL</span><span class="field-value mono">${this.esc(a.url)}</span></div>
          <div class="detail-field"><span class="field-label">Created</span><span class="field-value">${new Date(a.created_at).toLocaleString()}</span></div>
          <div class="detail-field"><span class="field-label">Completed</span><span class="field-value">${a.completed_at ? new Date(a.completed_at).toLocaleString() : '—'}</span></div>
        </div>
      </div>`;

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

  async deleteAnalysis(id) {
    if (!confirm('Delete this analysis?')) return;
    try {
      await fetch(`/api/analyses/${id}`, { method: 'DELETE' });
      if (this.selectedId === id) this.closeDetail();
      this.refresh();
    } catch (err) {
      console.error('[admin] Delete failed:', err);
    }
  }

  closeDetail() {
    this.selectedId = null;
    this.detailEl.style.display = 'none';
    this.renderTable();
  }

  riskClass(score) {
    if (score <= 25) return 'risk-low';
    if (score <= 50) return 'risk-medium';
    return 'risk-high';
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
        } else {
          this.agentStatus.classList.remove('connected');
          this.agentStatus.classList.add('disconnected');
          this.statusText.textContent = 'Agent disconnected';
        }
      } catch {
        this.agentStatus.classList.remove('connected');
        this.agentStatus.classList.add('disconnected');
        this.statusText.textContent = 'Server unreachable';
      }
    };
    await check();
    setInterval(check, 3000);
  }

  esc(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  }
}

const admin = new AdminApp();
