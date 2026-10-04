'use strict';
// Harness stand-in for VS Code's webview host: --vscode-* theme variables, body theme class, acquireVsCodeApi() and a
// host that answers 'ready' / 'refresh' / 'setScope' with the fixture ViewState (embedded by server.js as a data block).
// Query: fixture=<name|none> theme=dark|light|hc|hclight open=all|none reduce=1 fresh=1
(function () {
  const q = new URLSearchParams(location.search);
  const common = { '--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif', '--vscode-font-size': '13px' };
  // Values follow the built-in Dark Modern / Light Modern / Dark High Contrast / Light High Contrast themes (approximate).
  const THEMES = {
    dark: {
      cls: ['vscode-dark'], bg: '#181818',
      v: {
        foreground: '#CCCCCC', descriptionForeground: '#9D9D9D', 'editor-foreground': '#CCCCCC', 'editor-background': '#1F1F1F', 'widget-border': '#313131', 'panel-border': '#2B2B2B',
        'badge-background': '#616161', 'badge-foreground': '#F8F8F8', 'progressBar-background': '#0078D4', 'scrollbarSlider-background': '#79797966',
        'charts-blue': '#3794FF', 'charts-green': '#89D185', 'charts-red': '#F14C4C', 'charts-yellow': '#CCA700', 'charts-orange': '#D18616', errorForeground: '#F85149',
        focusBorder: '#0078D4', 'editorWidget-background': '#202020', 'sideBar-background': '#181818', 'sideBar-foreground': '#CCCCCC', 'sideBar-border': '#2B2B2B',
        'list-hoverBackground': '#2A2D2E', 'toolbar-hoverBackground': '#5A5D5E50', 'icon-foreground': '#CCCCCC',
      },
    },
    light: {
      cls: ['vscode-light'], bg: '#F8F8F8',
      v: {
        foreground: '#3B3B3B', descriptionForeground: '#717171', 'editor-foreground': '#3B3B3B', 'editor-background': '#FFFFFF', 'widget-border': '#E5E5E5', 'panel-border': '#E5E5E5',
        'badge-background': '#CCCCCC', 'badge-foreground': '#3B3B3B', 'progressBar-background': '#005FB8', 'scrollbarSlider-background': '#64646466',
        'charts-blue': '#1A85FF', 'charts-green': '#388A34', 'charts-red': '#E51400', 'charts-yellow': '#BF8803', 'charts-orange': '#D18616', errorForeground: '#E51400',
        focusBorder: '#005FB8', 'editorWidget-background': '#F8F8F8', 'sideBar-background': '#F8F8F8', 'sideBar-foreground': '#3B3B3B', 'sideBar-border': '#E5E5E5',
        'list-hoverBackground': '#F2F2F2', 'toolbar-hoverBackground': '#B8B8B850', 'icon-foreground': '#3B3B3B',
      },
    },
    hc: {
      cls: ['vscode-dark', 'vscode-high-contrast'], bg: '#000000',
      v: {
        foreground: '#FFFFFF', descriptionForeground: '#FFFFFF', 'editor-foreground': '#FFFFFF', 'editor-background': '#000000', 'widget-border': '#6FC3DF', 'panel-border': '#6FC3DF',
        'badge-background': '#000000', 'badge-foreground': '#FFFFFF', 'progressBar-background': '#6FC3DF', 'scrollbarSlider-background': '#6FC3DF66',
        'charts-blue': '#3794FF', 'charts-green': '#89D185', 'charts-red': '#F14C4C', 'charts-yellow': '#CCA700', 'charts-orange': '#D18616', errorForeground: '#F48771',
        focusBorder: '#F38518', contrastBorder: '#6FC3DF', 'editorWidget-background': '#0C141F', 'sideBar-background': '#000000', 'sideBar-foreground': '#FFFFFF', 'sideBar-border': '#6FC3DF',
        'list-hoverBackground': '#FFFFFF1F', 'toolbar-hoverBackground': '#FFFFFF1F', 'icon-foreground': '#FFFFFF',
      },
    },
    hclight: {
      cls: ['vscode-light', 'vscode-high-contrast-light'], bg: '#FFFFFF',
      v: {
        foreground: '#292929', descriptionForeground: '#292929', 'editor-foreground': '#292929', 'editor-background': '#FFFFFF', 'widget-border': '#0F4A85', 'panel-border': '#0F4A85',
        'badge-background': '#FFFFFF', 'badge-foreground': '#292929', 'progressBar-background': '#0F4A85', 'scrollbarSlider-background': '#0F4A8566',
        'charts-blue': '#1A85FF', 'charts-green': '#388A34', 'charts-red': '#E51400', 'charts-yellow': '#BF8803', 'charts-orange': '#D18616', errorForeground: '#B5200D',
        focusBorder: '#006BBD', contrastBorder: '#0F4A85', 'editorWidget-background': '#FFFFFF', 'sideBar-background': '#FFFFFF', 'sideBar-foreground': '#292929', 'sideBar-border': '#0F4A85',
        'list-hoverBackground': '#0F4A8517', 'toolbar-hoverBackground': '#0F4A8517', 'icon-foreground': '#292929',
      },
    },
  };

  const H = window.__harness = { posted: [], csp: [], theme: null, seq: 0 };
  document.addEventListener('securitypolicyviolation', (e) => H.csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample }));

  function setTheme(name) {
    const t = THEMES[name] || THEMES.dark;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(Object.assign({}, t.v, common))) {
      root.style.setProperty(k.startsWith('--') ? k : '--vscode-' + k, v);
    }
    // contrastBorder is undefined outside high contrast themes: make sure a previous theme's value is gone
    if (!t.v.contrastBorder) root.style.removeProperty('--vscode-contrastBorder');
    document.body.className = t.cls.join(' ') + (q.get('reduce') === '1' ? ' vscode-reduce-motion' : '');
    root.style.background = t.bg; // the host side bar behind the transparent webview
    H.theme = name in THEMES ? name : 'dark';
  }
  H.setTheme = setTheme;
  setTheme(q.get('theme') || 'dark');

  // ---- fixture ----
  const dataEl = document.getElementById('fixture');
  let fixture = null;
  try { fixture = dataEl ? JSON.parse(dataEl.textContent) : null; } catch (e) { fixture = null; }
  const TIME_FIELDS = ['now', 'startedAt', 'endedAt', 'fetchedAt', 'resetsAt'];
  function rebase(s, delta) {
    if (Array.isArray(s)) return s.map((x) => rebase(x, delta));
    if (s === null || typeof s !== 'object') return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) out[k] = TIME_FIELDS.includes(k) && typeof v === 'number' ? v + delta : rebase(v, delta);
    return out;
  }
  // timestamps of the fixture are shifted so that "now" of the fixture is the load time of the page
  const baseState = fixture && q.get('rebase') !== '0' ? rebase(fixture, Date.now() - fixture.now) : fixture;
  H.state = baseState;

  function deliver(state) {
    H.seq += 1;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', seq: H.seq, hostNow: Date.now(), state } }));
  }
  H.send = (state) => { H.state = state; deliver(state); };

  // ---- seed UI toggles: open=all expands recent section, cards and phases; open=none collapses every phase ----
  const key = (c) => c['key'];
  if (q.get('open') && baseState) {
    const open = {};
    const val = q.get('open') === 'all';
    if (val) open['s:recent'] = true;
    for (const c of baseState.running.concat(baseState.recent)) {
      if (val) open['c:' + key(c)] = true;
      for (const p of c.phases || []) open['p:' + key(c) + '|' + p.title] = val;
    }
    try { sessionStorage.setItem('vsstate', JSON.stringify({ v: 1, last: null, ui: { open } })); } catch (e) { /* ignore */ }
  } else if (q.get('fresh') === '1') {
    try { sessionStorage.removeItem('vsstate'); } catch (e) { /* ignore */ }
  }

  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem('vsstate') || 'null'); } catch (e) { stored = null; }
  window.acquireVsCodeApi = () => ({
    postMessage(m) {
      H.posted.push(m);
      if (!m || !H.state) return;
      if (m.type === 'ready' && q.get('fixture') !== 'none') setTimeout(() => deliver(H.state), 0);
      else if (m.type === 'refresh') setTimeout(() => deliver(H.state), 0);
      else if (m.type === 'setScope') {
        H.state = Object.assign({}, H.state, { scope: m.scope, scopeLabel: m.scope === 'all' ? 'Alle Projekte' : 'Arbeitsbereich: agent-view' });
        setTimeout(() => deliver(H.state), 0);
      }
    },
    getState: () => stored,
    setState(s) {
      stored = s;
      try { sessionStorage.setItem('vsstate', JSON.stringify(s)); } catch (e) { /* ignore */ }
      return s;
    },
  });
  H.reload = () => location.reload();
})();
