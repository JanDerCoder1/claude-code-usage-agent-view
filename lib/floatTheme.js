'use strict';
// Colours for the stand-alone floating window. Inside VS Code a webview gets the --vscode-* variables of the active theme from the
// editor; a normal browser window does not, so the same variables are served as a stylesheet. The values follow the built-in
// Dark Modern, Light Modern, Dark High Contrast and Light High Contrast themes (approximately; a custom theme maps to its kind).
const COMMON = { 'font-family': '"Segoe WPC", "Segoe UI", sans-serif', 'font-size': '13px' };
const THEMES = {
  dark: {
    cls: 'vscode-dark', bg: '#181818',
    v: {
      foreground: '#CCCCCC', descriptionForeground: '#9D9D9D', 'editor-foreground': '#CCCCCC', 'editor-background': '#1F1F1F', 'widget-border': '#313131', 'panel-border': '#2B2B2B',
      'badge-background': '#616161', 'badge-foreground': '#F8F8F8', 'progressBar-background': '#0078D4', 'scrollbarSlider-background': '#79797966',
      'charts-blue': '#3794FF', 'charts-green': '#89D185', 'charts-red': '#F14C4C', 'charts-yellow': '#CCA700', 'charts-orange': '#D18616', errorForeground: '#F85149',
      focusBorder: '#0078D4', 'editorWidget-background': '#202020', 'sideBar-background': '#181818', 'sideBar-foreground': '#CCCCCC', 'sideBar-border': '#2B2B2B',
      'list-hoverBackground': '#2A2D2E', 'toolbar-hoverBackground': '#5A5D5E50', 'icon-foreground': '#CCCCCC',
    },
  },
  light: {
    cls: 'vscode-light', bg: '#F8F8F8',
    v: {
      foreground: '#3B3B3B', descriptionForeground: '#717171', 'editor-foreground': '#3B3B3B', 'editor-background': '#FFFFFF', 'widget-border': '#E5E5E5', 'panel-border': '#E5E5E5',
      'badge-background': '#CCCCCC', 'badge-foreground': '#3B3B3B', 'progressBar-background': '#005FB8', 'scrollbarSlider-background': '#64646466',
      'charts-blue': '#1A85FF', 'charts-green': '#388A34', 'charts-red': '#E51400', 'charts-yellow': '#BF8803', 'charts-orange': '#D18616', errorForeground: '#E51400',
      focusBorder: '#005FB8', 'editorWidget-background': '#F8F8F8', 'sideBar-background': '#F8F8F8', 'sideBar-foreground': '#3B3B3B', 'sideBar-border': '#E5E5E5',
      'list-hoverBackground': '#F2F2F2', 'toolbar-hoverBackground': '#B8B8B850', 'icon-foreground': '#3B3B3B',
    },
  },
  hc: {
    cls: 'vscode-dark vscode-high-contrast', bg: '#000000',
    v: {
      foreground: '#FFFFFF', descriptionForeground: '#FFFFFF', 'editor-foreground': '#FFFFFF', 'editor-background': '#000000', 'widget-border': '#6FC3DF', 'panel-border': '#6FC3DF',
      'badge-background': '#000000', 'badge-foreground': '#FFFFFF', 'progressBar-background': '#6FC3DF', 'scrollbarSlider-background': '#6FC3DF66',
      'charts-blue': '#3794FF', 'charts-green': '#89D185', 'charts-red': '#F14C4C', 'charts-yellow': '#CCA700', 'charts-orange': '#D18616', errorForeground: '#F48771',
      focusBorder: '#F38518', contrastBorder: '#6FC3DF', 'editorWidget-background': '#0C141F', 'sideBar-background': '#000000', 'sideBar-foreground': '#FFFFFF', 'sideBar-border': '#6FC3DF',
      'list-hoverBackground': '#FFFFFF1F', 'toolbar-hoverBackground': '#FFFFFF1F', 'icon-foreground': '#FFFFFF',
    },
  },
  hclight: {
    cls: 'vscode-light vscode-high-contrast-light', bg: '#FFFFFF',
    v: {
      foreground: '#292929', descriptionForeground: '#292929', 'editor-foreground': '#292929', 'editor-background': '#FFFFFF', 'widget-border': '#0F4A85', 'panel-border': '#0F4A85',
      'badge-background': '#FFFFFF', 'badge-foreground': '#292929', 'progressBar-background': '#0F4A85', 'scrollbarSlider-background': '#0F4A8566',
      'charts-blue': '#1A85FF', 'charts-green': '#388A34', 'charts-red': '#E51400', 'charts-yellow': '#BF8803', 'charts-orange': '#D18616', errorForeground: '#B5200D',
      focusBorder: '#006BBD', contrastBorder: '#0F4A85', 'editorWidget-background': '#FFFFFF', 'sideBar-background': '#FFFFFF', 'sideBar-foreground': '#292929', 'sideBar-border': '#0F4A85',
      'list-hoverBackground': '#0F4A8517', 'toolbar-hoverBackground': '#0F4A8517', 'icon-foreground': '#292929',
    },
  },
};

const name = (n) => (Object.prototype.hasOwnProperty.call(THEMES, n) ? n : 'dark');

/** VS Code's ColorThemeKind (1 light, 2 dark, 3 high contrast, 4 high contrast light) -> theme name. */
function themeFromKind(kind) { return kind === 1 ? 'light' : kind === 3 ? 'hc' : kind === 4 ? 'hclight' : 'dark'; }

/** The --vscode-* variables as a stylesheet, plus an opaque page background (a webview is transparent over the editor's own colour). */
function themeCss(n) {
  const t = THEMES[name(n)];
  const lines = [];
  for (const [k, v] of Object.entries(COMMON)) lines.push('  --vscode-' + k + ': ' + v + ';');
  for (const [k, v] of Object.entries(t.v)) lines.push('  --vscode-' + k + ': ' + v + ';');
  return ':root {\n' + lines.join('\n') + '\n}\nhtml { background: ' + t.bg + '; }\n';
}

const bodyClass = (n) => THEMES[name(n)].cls;

module.exports = { themeCss, bodyClass, themeFromKind, THEMES };
