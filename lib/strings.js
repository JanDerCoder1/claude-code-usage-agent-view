'use strict';
// Host-side German strings (warnings, hints, fallbacks). The webview carries its own `T` object; ETA texts live in lib/eta.js.
// Everything that ends up in a ViewState comes from here, so wording is changed in one place only.

const TESTED_FROM = '2.1.263';
const TESTED_TO = '2.1.288';

const S = {
  scopeWorkspace: 'Arbeitsbereich',
  scopeAll: 'Alle Sitzungen',
  scopeAllNoFolder: 'Alle Sitzungen (kein Ordner geöffnet)',
  emptyHint: 'Keine laufenden Agenten. Starte in Claude Code einen Workflow oder Subagent.',
  originVsCode: 'VS Code',
  originDesktop: 'Desktop',
  noReport: 'ohne Bericht',
  noPhase: 'Ohne Phase',
  testedFrom: TESTED_FROM,
  testedTo: TESTED_TO,
  /** Missing <claudeHome>/projects: the view shows the empty state plus this line, never an error. */
  projectsMissing: dir => `Kein Sitzungsverzeichnis gefunden: ${dir}`,
  /** Session title fallback (SPEC 3.6): the first 8 characters of the session id. */
  sessionFallback: id => String(id == null ? '' : id).slice(0, 8),
  warnSession: (id, msg) => `Sitzung ${String(id == null ? '' : id).slice(0, 8)}: ${msg}`,
  warnDiscovery: msg => `Sitzungssuche: ${msg}`,
  warnMore: n => `… und ${n} weitere Warnungen`,
  warnCapped: 'Anzeige gekürzt: zu viele Einträge für die Übertragung.',
  formatNote: found => `Format getestet mit Claude Code ${TESTED_FROM}-${TESTED_TO} (neuere Versionen derselben Reihe 2.1.x gelten als kompatibel); gefunden: ${found}. Die Anzeige kann abweichen.`,
  moreAgents: n => `+${n} weitere`,
};
// `require('./strings')` and `const { S } = require('./strings')` both work
S.S = S;

module.exports = Object.freeze(S);
