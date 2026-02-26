/**
 * i18n: theme (dark/light) and language (en/fr/zh). Persisted in localStorage.
 */
(function () {
  const STORAGE_THEME = 'carabistouille_theme';
  const STORAGE_LANG = 'carabistouille_lang';

  const translations = {
    // App (analyzer)
    'app.title': { en: 'Carabistouille', fr: 'Carabistouille', zh: 'Carabistouille' },
    'app.subtitle': { en: 'Malicious URL Analyzer', fr: 'Analyseur d’URL malveillantes', zh: '恶意 URL 分析器' },
    'app.admin': { en: 'Admin', fr: 'Admin', zh: '管理' },
    'app.analyzer': { en: 'Analyzer', fr: 'Analyseur', zh: '分析器' },
    'app.agentDisconnected': { en: 'Agent disconnected', fr: 'Agent déconnecté', zh: '代理未连接' },
    'app.agentConnected': { en: 'Agent connected', fr: 'Agent connecté', zh: '代理已连接' },
    'app.serverUnreachable': { en: 'Server unreachable', fr: 'Serveur inaccessible', zh: '无法连接服务器' },
    'app.analyzeUrl': { en: 'Analyze URL', fr: 'Analyser une URL', zh: '分析 URL' },
    'app.urlPlaceholder': { en: 'https://suspicious-site.example', fr: 'https://site-suspect.example', zh: 'https://可疑网站.example' },
    'app.proxyPlaceholder': { en: 'Proxy (e.g. socks5://host:port)', fr: 'Proxy (ex. socks5://host:port)', zh: '代理（如 socks5://host:port）' },
    'app.userAgent': { en: 'User agent', fr: 'User-Agent', zh: '用户代理' },
    'app.userAgentDefault': { en: 'Default', fr: 'Par défaut', zh: '默认' },
    'app.userAgentChromeDesktop': { en: 'Chrome (Desktop)', fr: 'Chrome (bureau)', zh: 'Chrome（桌面）' },
    'app.userAgentSafariIphone': { en: 'Safari (iPhone)', fr: 'Safari (iPhone)', zh: 'Safari（iPhone）' },
    'app.userAgentChromeAndroid': { en: 'Chrome (Android)', fr: 'Chrome (Android)', zh: 'Chrome（Android）' },
    'app.userAgentFirefoxDesktop': { en: 'Firefox (Desktop)', fr: 'Firefox (bureau)', zh: 'Firefox（桌面）' },
    'app.userAgentCustom': { en: 'Custom...', fr: 'Personnalisé...', zh: '自定义...' },
    'app.userAgentCustomPlaceholder': { en: 'Paste a custom User-Agent string', fr: 'Coller une chaîne User-Agent', zh: '粘贴自定义 User-Agent' },
    'app.analyze': { en: 'Analyze', fr: 'Analyser', zh: '分析' },
    'app.history': { en: 'History', fr: 'Historique', zh: '历史' },
    'app.toolInteract': { en: 'Interact with the page', fr: 'Interagir avec la page', zh: '与页面交互' },
    'app.toolInspect': { en: 'Inspect elements', fr: 'Inspecter les éléments', zh: '检查元素' },
    'app.finish': { en: 'Finish', fr: 'Terminer', zh: '结束' },
    'app.finishTitle': { en: 'Finish analysis and generate report', fr: 'Terminer l’analyse et générer le rapport', zh: '结束分析并生成报告' },
    'app.placeholderSubmit': { en: 'Submit a URL to begin analysis', fr: 'Saisissez une URL pour lancer l’analyse', zh: '输入 URL 开始分析' },
    'app.report': { en: 'Report', fr: 'Rapport', zh: '报告' },
    'app.tabNetwork': { en: 'Network', fr: 'Réseau', zh: '网络' },
    'app.tabScripts': { en: 'Scripts', fr: 'Scripts', zh: '脚本' },
    'app.tabConsole': { en: 'Console', fr: 'Console', zh: '控制台' },
    'app.tabRaw': { en: 'Raw', fr: 'Fichiers', zh: '原始' },
    'app.tabScreenshots': { en: 'Screenshots', fr: 'Captures', zh: '截图' },
    'app.tabSecurity': { en: 'Security', fr: 'Sécurité', zh: '安全' },
    'app.filterRequests': { en: 'Filter requests...', fr: 'Filtrer les requêtes...', zh: '筛选请求...' },
    'app.filterScripts': { en: 'Filter scripts...', fr: 'Filtrer les scripts...', zh: '筛选脚本...' },
    'app.filterLogs': { en: 'Filter logs...', fr: 'Filtrer les logs...', zh: '筛选日志...' },
    'app.filterFiles': { en: 'Filter files...', fr: 'Filtrer les fichiers...', zh: '筛选文件...' },
    'app.noNetwork': { en: 'No network data yet', fr: 'Aucune donnée réseau', zh: '暂无网络数据' },
    'app.noScripts': { en: 'No scripts detected', fr: 'Aucun script détecté', zh: '未检测到脚本' },
    'app.noConsole': { en: 'No console output', fr: 'Aucune sortie console', zh: '无控制台输出' },
    'app.noFiles': { en: 'No files captured yet', fr: 'Aucun fichier capturé', zh: '暂无捕获文件' },
    'app.noScreenshots': { en: 'No screenshots captured yet', fr: 'Aucune capture d’écran', zh: '暂无截图' },
    'app.noSecurity': { en: 'No security analysis yet', fr: 'Aucune analyse de sécurité', zh: '暂无安全分析' },
    'app.tabDetection': { en: 'Detection', fr: 'Détection', zh: '检测' },
    'app.noDetection': { en: 'No detection probes observed yet', fr: 'Aucune sonde de détection observée', zh: '尚未观察到检测探测' },
    'app.detSummary': { en: 'Detection Summary', fr: 'Résumé de détection', zh: '检测摘要' },
    'app.detCatBot': { en: 'Bot / Automation Detection', fr: 'Détection de bot / automatisation', zh: '机器人/自动化检测' },
    'app.detCatFingerprint': { en: 'Browser Fingerprinting', fr: 'Empreinte du navigateur', zh: '浏览器指纹' },
    'app.detCatOther': { en: 'Other', fr: 'Autre', zh: '其他' },
    'app.detSevHigh': { en: 'High', fr: 'Élevé', zh: '高' },
    'app.detSevMedium': { en: 'Medium', fr: 'Moyen', zh: '中' },
    'app.detSevLow': { en: 'Low', fr: 'Faible', zh: '低' },
    'app.detVerdictDetected': { en: 'This site actively probes for headless/automated browsers', fr: 'Ce site tente activement de détecter les navigateurs headless/automatisés', zh: '此网站正在主动检测无头/自动化浏览器' },
    'app.detVerdictPossible': { en: 'This site may be fingerprinting the browser environment', fr: 'Ce site pourrait effectuer une empreinte de l\'environnement navigateur', zh: '此网站可能在采集浏览器环境指纹' },
    'app.detVerdictLow': { en: 'Only basic environment checks observed', fr: 'Seules des vérifications basiques observées', zh: '仅观察到基本的环境检查' },
    'app.detailGeneral': { en: 'General', fr: 'Général', zh: '概览' },
    'app.detailReqHeaders': { en: 'Request Headers', fr: 'En-têtes requête', zh: '请求头' },
    'app.detailRespHeaders': { en: 'Response Headers', fr: 'En-têtes réponse', zh: '响应头' },
    'app.detailPayload': { en: 'Payload', fr: 'Corps', zh: '请求体' },
    'app.detailTiming': { en: 'Timing', fr: 'Temps', zh: '时序' },
    'app.detailSecurity': { en: 'TLS/SSL', fr: 'TLS/SSL', zh: 'TLS/SSL' },
    'app.detailInitiator': { en: 'Initiator', fr: 'Initiateur', zh: '发起者' },
    'app.detailResponse': { en: 'Response', fr: 'Réponse', zh: '响应体' },
    'app.copyUrl': { en: 'Copy URL', fr: 'Copier l’URL', zh: '复制 URL' },
    'app.viewJs': { en: 'View JS source locally', fr: 'Voir le code JS', zh: '本地查看 JS 源码' },
    'app.copyContent': { en: 'Copy content', fr: 'Copier le contenu', zh: '复制内容' },
    'app.downloadFile': { en: 'Download file', fr: 'Télécharger', zh: '下载文件' },
    'app.openViewer': { en: 'Open in full viewer', fr: 'Ouvrir en plein écran', zh: '全屏查看' },
    'app.download': { en: 'Download', fr: 'Télécharger', zh: '下载' },
    'app.previous': { en: 'Previous', fr: 'Précédent', zh: '上一张' },
    'app.next': { en: 'Next', fr: 'Suivant', zh: '下一张' },
    'app.close': { en: 'Close', fr: 'Fermer', zh: '关闭' },
    'app.pageSource': { en: 'PAGE SOURCE', fr: 'CODE SOURCE PAGE', zh: '页面源码' },
    'app.domSnapshot': { en: 'DOM SNAPSHOT', fr: 'SNAPSHOT DOM', zh: 'DOM 快照' },
    'app.copy': { en: 'Copy', fr: 'Copier', zh: '复制' },
    'app.redirectChain': { en: 'Redirect chain', fr: 'Chaîne de redirections', zh: '重定向链' },
    'app.finalUrl': { en: 'Final URL', fr: 'URL finale', zh: '最终 URL' },
    'app.copyAsText': { en: 'Copy as text', fr: 'Copier en texte', zh: '复制为文本' },
    'app.downloadJson': { en: 'Download JSON', fr: 'Télécharger JSON', zh: '下载 JSON' },
    'app.httpsEnabled': { en: 'HTTPS enabled', fr: 'HTTPS activé', zh: '已启用 HTTPS' },
    'app.noHttps': { en: 'No HTTPS — connection not secure', fr: 'Pas de HTTPS — connexion non sécurisée', zh: '无 HTTPS — 连接不安全' },
    'app.mixedContent': { en: 'Mixed content detected', fr: 'Contenu mixte détecté', zh: '检测到混合内容' },
    'app.noMixedContent': { en: 'No mixed content', fr: 'Pas de contenu mixte', zh: '无混合内容' },

    // Admin
    'admin.dashboard': { en: 'Admin Dashboard', fr: 'Tableau de bord Admin', zh: '管理面板' },
    'admin.refresh': { en: 'Refresh', fr: 'Actualiser', zh: '刷新' },
    'admin.status': { en: 'Status', fr: 'État', zh: '状态' },
    'admin.url': { en: 'URL', fr: 'URL', zh: 'URL' },
    'admin.created': { en: 'Created', fr: 'Créé', zh: '创建时间' },
    'admin.completed': { en: 'Completed', fr: 'Terminé', zh: '完成时间' },
    'admin.risk': { en: 'Risk', fr: 'Risque', zh: '风险' },
    'admin.requests': { en: 'Requests', fr: 'Requêtes', zh: '请求' },
    'admin.scripts': { en: 'Scripts', fr: 'Scripts', zh: '脚本' },
    'admin.redirects': { en: 'Redirects', fr: 'Redirections', zh: '重定向' },
    'admin.actions': { en: 'Actions', fr: 'Actions', zh: '操作' },
    'admin.noAnalyses': { en: 'No analyses yet', fr: 'Aucune analyse', zh: '暂无分析' },
    'admin.total': { en: 'Total', fr: 'Total', zh: '总数' },
    'admin.active': { en: 'Active', fr: 'Actives', zh: '进行中' },
    'admin.complete': { en: 'Complete', fr: 'Terminées', zh: '已完成' },
    'admin.errors': { en: 'Errors', fr: 'Erreurs', zh: '错误' },
    'admin.avgRisk': { en: 'Avg Risk', fr: 'Risque moy.', zh: '平均风险' },
    'admin.viewDetails': { en: 'View details', fr: 'Voir les détails', zh: '查看详情' },
    'admin.deleteAnalysis': { en: 'Delete analysis', fr: 'Supprimer l’analyse', zh: '删除分析' },
    'admin.detailTitle': { en: 'Analysis Details', fr: 'Détails de l’analyse', zh: '分析详情' },
    'admin.deleteConfirm': { en: 'Delete this analysis? It will be removed from the server and the database.', fr: 'Supprimer cette analyse ? Elle sera retirée du serveur et de la base de données.', zh: '确定删除此分析？将从服务器和数据库中移除。' },
    'admin.serverUnreachable': { en: 'Server unreachable', fr: 'Serveur inaccessible', zh: '无法连接服务器' },

    // Theme & language
    'theme.dark': { en: 'Dark', fr: 'Sombre', zh: '深色' },
    'theme.light': { en: 'Light', fr: 'Clair', zh: '浅色' },
    'lang.en': { en: 'English', fr: 'Anglais', zh: '英语' },
    'lang.fr': { en: 'French', fr: 'Français', zh: '法语' },
    'lang.zh': { en: 'Chinese', fr: 'Chinois', zh: '中文' },
  };

  /**
   * Get current language from localStorage ('en' | 'fr' | 'zh').
   * @returns { 'en' | 'fr' | 'zh' }
   */
  function getLang() {
    try {
      const l = localStorage.getItem(STORAGE_LANG);
      if (l === 'fr' || l === 'zh') return l;
    } catch (_) {}
    return 'en';
  }

  /**
   * Get current theme from localStorage ('dark' | 'light').
   * @returns { 'dark' | 'light' }
   */
  function getTheme() {
    try {
      const t = localStorage.getItem(STORAGE_THEME);
      if (t === 'light') return 'light';
    } catch (_) {}
    return 'dark';
  }

  /**
   * Translate a key to the current language.
   * @param {string} key - Translation key (e.g. 'app.title', 'admin.refresh').
   * @returns {string} Translated string or key if not found.
   */
  function t(key) {
    const lang = getLang();
    const map = translations[key];
    if (!map) return key;
    return map[lang] || map.en || key;
  }

  /**
   * Set language and persist to localStorage; reapplies UI translations.
   * @param { 'en' | 'fr' | 'zh' } lang - Language code.
   */
  function setLang(lang) {
    if (lang !== 'en' && lang !== 'fr' && lang !== 'zh') return;
    try {
      localStorage.setItem(STORAGE_LANG, lang);
    } catch (_) {}
    applyLang();
  }

  /**
   * Set theme and persist to localStorage; reapplies body theme class and toggle icon.
   * @param { 'dark' | 'light' } theme - Theme name.
   */
  function setTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    try {
      localStorage.setItem(STORAGE_THEME, theme);
    } catch (_) {}
    applyTheme();
  }

  /**
   * Apply current theme: set body class (theme-dark / theme-light) and update theme toggle icon/title.
   */
  function applyTheme() {
    const theme = getTheme();
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.title = theme === 'light' ? t('theme.dark') : t('theme.light');
      toggle.setAttribute('aria-label', toggle.title);
      const icon = toggle.querySelector('.theme-icon');
      if (icon) icon.textContent = theme === 'light' ? '☀' : '🌙';
    }
  }

  function applyLang() {
    const lang = getLang();
    document.documentElement.lang = lang === 'zh' ? 'zh' : lang === 'fr' ? 'fr' : 'en';
    const sel = document.getElementById('lang-select');
    if (sel) sel.value = lang;
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      const key = el.getAttribute('data-i18n');
      const text = t(key);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.placeholder !== undefined) el.placeholder = text;
      } else {
        el.textContent = text;
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    if (typeof window.onLangChange === 'function') window.onLangChange();
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyTheme();
    applyLang();
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', function () {
        setTheme(getTheme() === 'light' ? 'dark' : 'light');
      });
    }
    const langSelect = document.getElementById('lang-select');
    if (langSelect) {
      langSelect.addEventListener('change', function () {
        setLang(langSelect.value);
      });
    }
  });

  /** Public i18n API: translation, theme/language getters/setters, and apply functions. */
  window.i18n = {
    t: t,
    getLang: getLang,
    setLang: setLang,
    getTheme: getTheme,
    setTheme: setTheme,
    applyTheme: applyTheme,
    applyLang: applyLang,
  };
})();
