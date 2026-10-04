# Claude Code Utilities: Anleitung

Ausführliche Anleitung und Referenz. Die Startseite des Projekts ist die [README](../README.md).

Claude Code Utilities zeigt laufende Claude-Code-Agenten und Workflows als Karten in einer eigenen Ansicht von VS Code: Titel, Beschreibung, Status, Modell, Tokens, Laufzeit, Phasen (n/m), aktuelle Tätigkeit und eine ehrliche Restzeit-Schätzung. Oben steht die Nutzung (5-Stunden-Limit und Wochenlimit mit Prozent und Reset-Zeit). Die Ansicht lässt sich auch als schwebendes Fenster öffnen, das im Vordergrund bleibt. Zwei Knöpfe schreiben den Kontext einer Sitzung in eine Markdown-Datei (Hand-Off) oder starten eine neue Unterhaltung (Clear). Die Erweiterung liest dafür nur lokale Dateien von Claude Code und verändert nichts.

Claude Code selbst bietet keine Schnittstelle, um Karten in seinen Chat einzubauen. Claude Code Utilities ist deshalb eine zweite Erweiterung, die neben dem Chat andockt.

## Was angezeigt wird

- **Läuft**: jeder laufende Workflow als Karte mit Phasen (aufklappbar), den Agenten je Phase (Modell, Tokens, Zeit, Rest) und der aktuellen Tätigkeit (Werkzeug, Denken, Schreiben, Warten). Laufende Agenten ohne Workflow (Agent-Werkzeug) erscheinen als eigene Karte.
- **Zuletzt fertig**: abgeschlossene, abgebrochene und fehlgeschlagene Läufe der letzten Stunden, einzeilig, per Klick aufklappbar.
- **Status**: `läuft`, `fertig`, `Fehler`, `abgebrochen`, `gestoppt` (verwaist), `wartet` und `ruhig seit N Min.` (Hinweis, kein Beweis für einen Abbruch).
- **Nutzung**: 5-Stunden-Limit und Wochenlimit mit verbrauchten Prozent, Reset-Zeitpunkt und Restzeit bis zum Reset. Die Zahlen stammen aus dem Zwischenspeicher, den Claude Code selbst pflegt. Damit sie frisch sind, führt Claude Code Utilities selbst den Claude-Code-Befehl `/usage` aus: beim Öffnen der Ansicht, danach alle 5 Minuten, solange sie sichtbar ist (`agentView.usage.autoRefreshMinutes`), und sofort über den Aktualisieren-Knopf. Während das läuft, steht "wird aktualisiert …" neben den Zahlen; sonst nennt die Ansicht das Alter ("Stand vor 12 Min."). Ist die Reset-Zeit eines Fensters schon vorbei, steht dort "zurückgesetzt" statt einer veralteten Zahl.
- **Beschreibung**: Die Beschreibung eines Workflows steht ungekürzt direkt unter dem Titel; auch lange Tätigkeitszeilen laufen über mehrere Zeilen, und der Tooltip zeigt jeweils den ganzen Text.
- **Schwebendes Fenster**: der Knopf in der Titelleiste der Ansicht (zwei Fenster-Symbole) und in der Kopfzeile öffnet dieselben Karten samt Nutzung in einem eigenen kleinen Windows-Fenster ohne VS-Code-Rahmen, das du frei verschieben kannst und das vor VS Code im Vordergrund bleibt (nicht vor anderen Programmen).
- **Hand-Off** (Knopf in der Ansicht und Symbol in der Titelleiste): schreibt einen Auszug der gewählten Sitzung in eine Markdown-Datei im Temp-Ordner (`%TEMP%\agent-view-handoff`), danach kannst du die Datei öffnen oder einen fertigen Prompt für die neue Sitzung kopieren. Es ist ein **mechanischer Auszug, keine Zusammenfassung durch Claude**: letzte Fragen, letzter Stand, offene Aufgabenliste, bearbeitete Dateien, letzte Befehle, Verlauf deiner Aufträge. Gibt es mehrere Sitzungen im Arbeitsbereich, wählst du eine aus (die zuletzt aktive steht oben).
- **Clear** (Knopf in der Ansicht und Symbol in der Titelleiste): schreibt zuerst ein Hand-Off (ohne Hand-Off wird nichts gelöscht), öffnet dann über "Claude Code: Open in New Tab" eine neue Unterhaltung, in deren Eingabefeld der Prompt mit dem Pfad der Hand-Off-Datei schon steht (zusätzlich in der Zwischenablage), und schließt den alten Chat-Tab. Liegt der alte Chat in der Seitenleiste statt in einem Editor-Tab, bleibt er bestehen, da er sich nicht schließen lässt. Schlägt das Öffnen fehl, wird "New Conversation" benutzt. Die alte Unterhaltung bleibt in deren Verlauf erhalten. Das spart Tokens, weil der alte Kontext nicht mehr mitgeschickt wird. Für das Übernehmen von Wissen zuerst Hand-Off, dann Clear.
- Standardmäßig nur der Arbeitsbereich des aktuellen Fensters; der Filter oben in der Ansicht wechselt auf alle Sitzungen.

## Voraussetzungen

- VS Code ab 1.94.
- Entwickelt und geprüft unter Windows (der Code ist plattformneutral). Zum Bauen des Pakets Node.js ab 14; zur Laufzeit wird kein eigenes Node benötigt, die Erweiterung läuft im Node von VS Code.
- Keine npm-Abhängigkeiten.

## Installation

Die vier Befehle nacheinander im Hauptordner des Projekts ausführen, jeweils einzeln kopieren. Reihenfolge: bauen, Inhalt prüfen (erwartet: 0 CRC-Fehler und keine Namen mit Backslash), installieren, Installation prüfen.

```powershell
node tools/build-vsix.js . dist/claude-code-usage-agent-view-0.9.3.vsix
```

```powershell
node tools/zip-list.js dist/claude-code-usage-agent-view-0.9.3.vsix
```

```powershell
code --install-extension dist/claude-code-usage-agent-view-0.9.3.vsix
```

```powershell
code --list-extensions --show-versions
```

Die letzte Ausgabe der Liste sollte `local.claude-code-usage-agent-view@0.9.3` enthalten (die CLI gibt dabei eine harmlose DEP0169-Warnung aus). Danach in VS Code die Befehlspalette öffnen (Strg+Umschalt+P) und `Developer: Reload Window` ausführen. In der Aktivitätsleiste erscheint das Symbol "Claude Code Utilities", die Ansicht heißt "Agenten".

Gleiche Version erneut installieren ersetzt die vorhandene. Ein lokales Paket wird nicht automatisch aktualisiert: nach jeder Änderung `version` in `package.json` erhöhen, neu bauen und installieren (die README und die Tests verweisen auf den Dateinamen `claude-code-usage-agent-view-<Version>.vsix`).

Deinstallieren:

```powershell
code --uninstall-extension local.claude-code-usage-agent-view
```

Das Paket enthält nur `package.json`, `extension.js`, `lib/*.js`, `media/*` und diese README. Tests, Werkzeuge, Dokumentation und Testdaten werden beim Bauen ausgeschlossen.

## Ansicht in die rechte Seitenleiste verschieben

Standardmäßig liegt Claude Code Utilities in der Aktivitätsleiste links. Damit es wie der Claude-Code-Chat rechts sitzt:

1. Befehlspalette öffnen (Strg+Umschalt+P) und `View: Move View` ausführen.
2. Die Ansicht "Agenten" (Claude Code Utilities) auswählen.
3. `New Secondary Side Bar Entry` wählen.

Die sekundäre Seitenleiste lässt sich mit `View: Toggle Secondary Side Bar Visibility` ein- und ausblenden. VS Code speichert die Position selbst.

Optional gibt es eine Paketvariante, die den Container von Anfang an in der sekundären Seitenleiste deklariert (benötigt VS Code ab 1.106; Bauen und Installieren sind geprüft, die Darstellung in einem echten Fenster noch nicht):

```powershell
node tools/build-vsix.js . dist/claude-code-usage-agent-view-0.9.3-secondary.vsix --secondary
```

## Befehle

| Befehl | Wirkung |
|---|---|
| `Claude Code Utilities: Öffnen` | Ansicht anzeigen und fokussieren |
| `Claude Code Utilities: Hand-Off (Kontext in Markdown-Datei schreiben)` | Auszug der gewählten Sitzung in eine Markdown-Datei im Temp-Ordner schreiben (auch Knopf und Symbol in der Titelleiste) |
| `Claude Code Utilities: Clear (neue Unterhaltung starten)` | Hand-Off schreiben, neue Unterhaltung mit dem Pfad im Eingabefeld starten, alten Tab schließen (auch Knopf und Symbol in der Titelleiste) |
| `Claude Code Utilities: In schwebendem Fenster öffnen` | Karten und Nutzung in einem eigenen kleinen Fenster (auch Symbol in der Titelleiste und in der Kopfzeile der Ansicht) |
| `Claude Code Utilities: Aktualisieren` | sofort neu einlesen (auch Symbol in der Titelleiste der Ansicht) |
| `Claude Code Utilities: Arbeitsbereich / Alle Sitzungen` | Filter umschalten (auch Symbol in der Titelleiste der Ansicht) |
| `Claude Code Utilities: Zeitschätzungs-Verlauf löschen` | gelernte Laufzeiten verwerfen (mit Rückfrage) |

## Einstellungen

| Einstellung | Standard | Bedeutung |
|---|---|---|
| `agentView.scope` | `workspace` | `workspace`: Sitzungen der geöffneten Ordner; `all`: alle Sitzungen unter `~/.claude/projects` |
| `agentView.recentHours` | `24` | "Zuletzt fertig" zeigt die letzten N Stunden (mindestens 1) |
| `agentView.claudeHome` | leer | überschreibt das Claude-Verzeichnis. Nur absolute lokale Pfade (Netzwerkpfade wie `\\Server\Freigabe` und relative Pfade werden ignoriert); gilt nur in den Benutzereinstellungen, nie aus einem Arbeitsbereich. Ohne Wert gilt `CLAUDE_CONFIG_DIR` aus der Einstellung `claudeCode.environmentVariables` der Claude-Code-Erweiterung, dann die Umgebungsvariable, dann `~/.claude` |
| `agentView.showToolTargets` | `true` | Ziel des aktuellen Werkzeugs (Pfad, Befehl) anzeigen |
| `agentView.pollMs` | `1500` | Abfrageintervall in Millisekunden, solange Agenten laufen (mindestens 500) |
| `agentView.staleMinutes` | `10` | Ruhezeit (mindestens 2), nach der ein Lauf als verwaist ("gestoppt") gilt, wenn `~/.claude/sessions` fehlt. Mit diesem Verzeichnis (Normalfall) gilt ein Lauf einer lebenden Sitzung erst nach mindestens 60 Minuten Ruhe als verwaist; der Wert wirkt dort nur, wenn er größer ist. "Ruhig seit" erscheint unabhängig davon fest nach 10 Minuten Ruhe |
| `agentView.eta.enabled` | `true` | geschätzte Restzeit anzeigen |
| `agentView.usage.autoRefreshMinutes` | `5` | wie oft Claude Code Utilities selbst `/usage` ausführt, solange die Ansicht sichtbar ist (Minuten; `0` = nie). Der Aktualisieren-Knopf führt es immer sofort aus |
| `agentView.usage.enabled` | `true` | Nutzung (5-Stunden- und Wochenlimit) anzeigen; liest dafür den Zwischenspeicher aus `~/.claude.json`, siehe Datenschutz |
| `agentView.floating.width` / `agentView.floating.height` | `380` / `480` | Größe des schwebenden Fensters beim Öffnen in Pixeln (bei hoher Windows-Skalierung automatisch größer; `0` = Standardgröße). Das Fenster erscheint oben rechts im VS-Code-Fenster, aus dem du es geöffnet hast |
| `agentView.floating.closeWithVscode` | `true` | schließt das schwebende Fenster, sobald das VS-Code-Fenster geschlossen wird, aus dem du es geöffnet hast (ein kleiner PowerShell-Wächter, der endet, wenn das schwebende Fenster weg ist) |

Ist kein Ordner geöffnet, verhält sich die Ansicht wie `all`. Ohne Laufzeit-Aktivität fragt die Erweiterung nur alle 5 Sekunden ab; ist die Ansicht verborgen, ruht sie vollständig.

## Datenschutz

- **Nur lesend.** Claude Code Utilities schreibt nichts nach `~/.claude` und sendet nichts. Es startet nur eines: `claude -p /usage --no-session-persistence --setting-sources project` (Programm der Claude-Code-Erweiterung, ohne Shell, mit festen Argumenten). Das ist ein lokaler Befehl von Claude Code, der kein Modell aufruft, nichts im Sitzungsverlauf speichert und deine Benutzer-Hooks (etwa den Ton beim Stop) nicht auslöst; er lässt Claude Code seinen Nutzungs-Zwischenspeicher neu schreiben, den Claude Code Utilities danach liest. Abschalten mit `agentView.usage.autoRefreshMinutes = 0` (nur der Knopf startet ihn dann) oder `agentView.usage.enabled = false`. Es gibt keine Stopp-Schaltfläche und keine Möglichkeit, Nachrichten an Claude Code zu schicken.
- **Nur lokale Dateien, kein Netzwerk nach außen.** Die Erweiterung ruft nichts im Internet auf und enthält keine Telemetrie. Die Ansicht in VS Code darf laut Content-Security-Policy nichts nachladen (`default-src 'none'`). Nur wenn du das schwebende Fenster öffnest, lauscht die Erweiterung auf einem zufälligen Port **nur auf `127.0.0.1`** (dieser Rechner), solange das Fenster offen ist: Die Adresse enthält ein zufälliges Kennwort, der Host-Header und bei Eingaben die Herkunft werden geprüft, es werden nur drei feste Dateien und der Datenstrom ausgeliefert, und die Seite darf selbst ebenfalls nichts nachladen. Andere Programme auf diesem Rechner, die die Adresse nicht kennen, kommen nicht an die Daten.
- **Was gelesen wird:** die Transkripte der Unteragenten (`subagents/agent-*.jsonl`), Workflow-Journale und -Ergebnisdateien sowie die Sitzungsliste unter `~/.claude/sessions` (Prozess-ID und Arbeitsverzeichnis, um laufende Sitzungen zu erkennen).
- **Was nur auf Knopfdruck gelesen wird:** beim Hand-Off das Haupt-Transkript der von dir gewählten Sitzung, in Teilen gelesen und nur als begrenzter Auszug behalten. Die Datei im Temp-Ordner enthält Texte aus deiner Unterhaltung (deine Aufträge, die letzte Antwort, Dateinamen, Befehle). Passwörter, Token und Schlüssel werden bestmöglich geschwärzt, eine Garantie ist das nicht; gib die Datei nicht ungeprüft weiter. Eigene Hand-Off-Dateien werden nach 7 Tagen automatisch gelöscht.
- **Was nie gelesen wird:** das Haupt-Transkript einer Sitzung ohne Hand-Off (nur Änderungszeit per `stat`), Zugangsdaten, Schlüssel- und Sperrdateien. Von Ergebnissen erscheint höchstens eine Vorschau von 160 Zeichen, ausschließlich als Text.
- **Nutzungsanzeige:** gelesen wird ausschließlich der Schlüssel `cachedUsageUtilization` aus `~/.claude.json` (bei gesetztem `CLAUDE_CONFIG_DIR` aus `<Verzeichnis>/.claude.json`), also Prozentwerte und Reset-Zeiten, die Claude Code selbst dort ablegt. Die Datei enthält auch anderes (Kontoangaben, Einstellungen); alles außer diesem Schlüssel wird sofort verworfen, nie angezeigt, protokolliert oder gespeichert. Es gibt keine Netzwerkabfrage, und Zugangsdaten (`.credentials.json`) werden nie gelesen. Abschalten mit `agentView.usage.enabled`.
- **Das Protokoll (Ausgabe "Claude Code Utilities")** enthält nur Pfade und Anzahlen, nie Inhalte aus Transkripten.
- **Einzige Datei, die die Erweiterung selbst schreibt:** `history.json` im Speicherordner der Erweiterung (von VS Code verwaltet). Sie enthält für die Restzeit-Schätzung zu jedem abgeschlossenen Agenten die Laufzeit **und Text**: den Namensanfang des Labels, den Phasentitel (klein geschrieben) und den Namen des Projektordners. Darin können Namen aus deinen Aufträgen stehen, etwa ein Kunde. Beim Start liest die Erweiterung im Hintergrund die Ergebnisdateien **aller** Projekte unter `~/.claude/projects` ein, unabhängig vom Filter `agentView.scope`. Die Datei verlässt den Rechner nicht, solange du den Speicherordner nicht selbst weitergibst. Löschen über `Claude Code Utilities: Zeitschätzungs-Verlauf löschen`.
- **Zustand der Ansicht:** damit die Ansicht nach dem Verbergen sofort wieder erscheint, sichert VS Code den zuletzt angezeigten Zustand im Arbeitsbereich-Speicher (Kartentitel, Labels, Ergebnisvorschauen von höchstens 160 Zeichen, das Claude-Verzeichnis und, solange `agentView.showToolTargets` an ist, Werkzeug-Ziele wie Befehle und Pfade). Das passiert in VS Code, nicht durch Dateizugriffe der Erweiterung; es wird beim nächsten Zustand überschrieben und vom Löschbefehl oben nicht erfasst.
- Eine Datei aus der Ansicht im Dateimanager anzuzeigen ist nur für Pfade innerhalb des Claude-Verzeichnisses möglich; alles andere lehnt die Erweiterung ab.

## Hand-Off und Clear als Claude-Code-Befehle

Neben den Knöpfen gibt es zwei Wege im Chat selbst:

- **`/handoff`** (Datei `~/.claude/commands/handoff.md`, ein Prompt): Claude schreibt die Übergabe der Sitzung selbst in eine Markdown-Datei im Ordner `agent-view-handoff` des Temp-Verzeichnisses und nennt am Ende den Pfad und einen fertigen Prompt für die neue Sitzung. Das ist inhaltlich besser als der mechanische Auszug des Knopfs, weil Claude Entscheidungen, Gründe und den nächsten Schritt kennt; dafür kostet es einen Modellaufruf. Mit Zusatz geht es gezielt: `/handoff Schwerpunkt auf den Tests`.
- **`/clear`** ist in Claude Code eingebaut (ein Befehl, kein Prompt) und leert die Sitzung. Ein eigener Befehl kann das nicht ersetzen; der Clear-Knopf von Claude Code Utilities löst dieselbe Wirkung über "New Conversation" aus.

Reihenfolge zum Sparen von Tokens: `/handoff`, dann `/clear`, dann den ausgegebenen Prompt einfügen.

## Bekannte Grenzen

- **Die Restzeit ist grob.** Wie lange ein einzelner Agent noch braucht, ist aus den Dateien kaum ableitbar: die verbleibende Zeit hängt kaum davon ab, wie lange er schon läuft. Belastbar ist nur der Vergleich mit bereits fertigen Agenten derselben Phase; sonst zeigt die Karte eine weite Spanne, "länger als üblich" oder nichts. Die Schätzung wird mit der Zeit besser, weil abgeschlossene Läufe in den Verlauf eingehen.
- **Tokens sind die Kontextgröße, nicht die kumulierte Summe.** Die Zahl entspricht dem Kontextfenster der letzten Anfrage eines Agenten (so zeigt es auch die Claude-Desktop-Karte); die Summe in der Kopfzeile ist die Summe dieser Werte. Sie liegt rund ein Prozent unter den Werten der Benachrichtigungen von Claude Code, die einen anderen Zähler verwenden.
- **Die Nutzungszahlen sind so frisch wie der letzte `/usage`-Lauf.** Der Lauf dauert einige Sekunden (hier 4 bis 18); schlägt er fehl (etwa weil die Claude-Code-Erweiterung fehlt oder nicht angemeldet ist), bleibt es bei den alten Zahlen, das Alter steht daneben, und ein abgelaufenes Fenster zeigt "zurückgesetzt". Mehrere VS-Code-Fenster starten je ihren eigenen Lauf.
- **Clear wirkt auf den Chat, den Claude Code als aktiv ansieht.** Bei mehreren offenen Chats ist das der zuletzt benutzte; ob der Knopf in jeder Anordnung den richtigen trifft, ist nicht geprüft. Eine laufende Antwort wird dabei nicht abgebrochen, wenn Claude Code sie im Hintergrund weiterführt; das habe ich nicht getestet.
- **Der Hand-Off ist nur so gut wie der Verlauf.** Er erkennt echte Eingaben von dir an der Herkunftsangabe im Transkript, blendet Benachrichtigungen aus und übernimmt bei verdichteten Sitzungen die Zusammenfassung von Claude Code. Eine eigene Aufgabenliste gibt es nur, wenn die Sitzung das Werkzeug `TodoWrite` benutzt hat.
- **Das Mitschließen des schwebenden Fensters** übernimmt ein kleiner PowerShell-Wächter (`agentView.floating.closeWithVscode`): Er prüft jede Sekunde, ob das VS-Code-Fenster noch existiert, und schickt dem schwebenden Fenster sonst den Befehl zum Schließen. Er endet, wenn das schwebende Fenster verschwindet, spätestens nach 12 Stunden, und beim Beenden der Erweiterung. Ein Fenster eines anderen Prozesses schließt Windows nicht von selbst mit seinem Besitzer; das ist an Testfenstern geprüft, in einem echten VS Code noch nicht.
- **Das schwebende Fenster ist ein eigenes Browserfenster, kein VS-Code-Fenster.** Es ist Microsoft Edge (sonst Google Chrome) im App-Modus: nur eine schmale Titelleiste, keine Tabs, keine Adressleiste, und Dateien aus VS Code landen nie darin. Es nutzt ein eigenes, leeres Browserprofil im Speicherordner der Erweiterung (`float-profile`, enthält nur Zwischenspeicher dieser einen Seite) und läuft wie jeder Browser mit mehreren Prozessen (spürbarer Speicherbedarf, solange es offen ist). Die Farben entsprechen der Art deines VS-Code-Themes (hell, dunkel, hoher Kontrast), nicht dem genauen Theme, und werden beim Öffnen festgelegt. Nur unter Windows.
- **Wie das Fenster vor VS Code bleibt.** Unter Windows macht Claude Code Utilities das neue Fenster zum untergeordneten Fenster ("owned window") des VS-Code-Fensters, in dem du den Knopf gedrückt hast: Ein solches Fenster liegt immer vor seinem Besitzer, aber hinter jedem anderen Programm, das du darüber öffnest, genau wie VS Code selbst. Dazu laufen zwei kurze PowerShell-Aufrufe (Fenster auflisten, Besitzer setzen und verkleinern; feste Skripte). Das habe ich mit echtem Edge und einem Testfenster als "VS Code" geprüft (Größe, Besitzer, Mitschließen), **noch nicht in einem echten VS-Code-Fenster**. Klappt die Verknüpfung nicht, bleibt es ein normales Fenster, und eine Meldung nennt den Grund. Mit mehreren VS-Code-Fenstern gilt das Fenster, das beim Klick den Fokus hatte. Wird das VS-Code-Fenster minimiert, verschwindet das schwebende Fenster mit. Nach einem Neustart von VS Code ist das Fenster weg und wird mit dem Knopf neu geöffnet; Reste einer älteren Version (ein von VS Code wiederhergestelltes Panel) schließt die Erweiterung sofort wieder.
- **"Ruhig seit" ist kein Beweis für einen Hänger.** Agenten pausieren teils viele Minuten (gemessen bis über 25 Minuten) und arbeiten dann weiter.
- **Nicht alles steht in Dateien.** Noch nicht gestartete oder wartende Agenten einer Phase sowie die Wartezeit vor der ersten Zeile sind in keiner Datei vermerkt und daher nicht sichtbar.
- **Dateiformat.** Getestet mit Claude Code 2.1.263 bis 2.1.288. Neuere Versionen derselben Reihe 2.1.x gelten als kompatibel (Claude Code erscheint fast täglich in neuen Patch-Versionen, die Tests gegen deine echten Dateien sichern das Format); ein Hinweis erscheint bei älteren Versionen und bei einer neuen Reihe (2.2 oder 3.0). Claude Code löscht Sitzungsdateien nach `cleanupPeriodDays` (Standard 30 Tage), danach fehlen ältere Läufe.
- **Sitzungen in Unterordnern des Arbeitsbereichs.** Im Filter "Arbeitsbereich" erscheint eine Sitzung, die in einem Unterordner des geöffneten Ordners gestartet wurde, über ihren Eintrag in `~/.claude/sessions` (auch nachdem der Prozess beendet ist, solange VS Code läuft). Eine Sitzung, die dort nie lebend gesehen wurde, etwa aus einer früheren VS-Code-Sitzung, sowie Geschwister-Sitzungen im selben Projektordner erscheinen nur im Filter "Alle Sitzungen".
- **Remote-Fenster (WSL, SSH).** Die Erweiterung läuft im Arbeitsbereich-Host und liest dort `~/.claude`; dieser Fall ist ungetestet.
- **Prüfstand.** Die Darstellung wurde in einem Browser-Prüfstand mit Beispieldaten und gegen die echten Sitzungsdateien getestet; der Rauchtest in einem echten VS-Code-Fenster (Verschieben in die rechte Seitenleiste, Theme-Wechsel, echter Workflow) steht noch aus.

## Entwicklung

Alle Tests (Node-Testrunner, keine Abhängigkeiten; das Muster in Anführungszeichen übergeben, ein reiner Ordnername funktioniert ab Node 22 nicht):

```powershell
node --test "test/*.test.js"
```

Entwicklungsschleife ohne Installation: VS Code mit der Erweiterung aus dem Ordner starten (öffnet ein neues Fenster in deinem Profil); dort lädt Strg+R die Erweiterung neu:

```powershell
code --extensionDevelopmentPath=.
```

Aufbau: `extension.js` ist die einzige Datei, die die VS-Code-API verwendet (Ansicht, Befehle, Einstellungen, Nachrichten). Alles unter `lib/` ist reines Node und einzeln testbar: Dateien lesen (`tail.js`, `agentFold.js`), Sitzungsmodell (`sessionModel.js`), Zeitschätzung (`eta.js`, `history.js`) und Abfrage-Takt (`poller.js`). Die Oberfläche steht in `media/`.

## Lizenz

MIT, siehe [LICENSE](../LICENSE). Die Lizenzdatei wird auch in das Paket (`.vsix`) aufgenommen.
