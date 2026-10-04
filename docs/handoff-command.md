---
description: Schreibt den Kontext dieser Sitzung als Hand-Off in eine temporäre Markdown-Datei, damit eine neue Sitzung (nach /clear) nahtlos weitermacht
argument-hint: "[optional: Schwerpunkt oder Hinweis für die neue Sitzung]"
---

# Hand-Off schreiben

Du schreibst jetzt eine Übergabe dieser Sitzung für eine **neue, leere Sitzung**, die nur diese Datei kennt. Ändere dabei **keinen Code und keine anderen Dateien**; es entsteht genau eine Markdown-Datei.

Zusätzlicher Hinweis des Nutzers (kann leer sein): $ARGUMENTS

## Ablauf

1. Temp-Ordner ermitteln und den Unterordner `agent-view-handoff` anlegen (derselbe Ordner, in den auch der Hand-Off-Knopf der Erweiterung Claude Code Utilities schreibt):

   ```powershell
   $d = Join-Path ([System.IO.Path]::GetTempPath()) 'agent-view-handoff'; New-Item -ItemType Directory -Force $d | Out-Null; $d
   ```

2. Die Datei `handoff-claude-<jjjjMMtt-HHmmss>.md` in diesem Ordner mit dem Write-Werkzeug schreiben (aktuelle Uhrzeit aus dem System, nicht schätzen).

3. Inhalt, in dieser Reihenfolge, **auf Deutsch**, aus dem Wissen dieser Sitzung. Nichts erfinden: was du nicht sicher weißt, als "unklar" kennzeichnen. Knapp bleiben (rund 150 Zeilen oder weniger), konkret statt allgemein:

   - **Ziel**: was der Nutzer insgesamt erreichen will, in zwei, drei Sätzen.
   - **Stand**: erledigt, in Arbeit, offen (als Liste, mit Dateien oder Befehlen, an denen man es erkennt).
   - **Entscheidungen und Gründe**: was gewählt wurde und warum, besonders was der Nutzer ausdrücklich so wollte.
   - **Orte**: wichtige Ordner, Dateien (volle Pfade), Konfigurationen, laufende oder installierte Dinge.
   - **Prüfen und starten**: die Befehle, mit denen man den Stand prüft (Tests, Build, Start), und was ein gutes Ergebnis ist.
   - **Fallstricke**: was nicht funktioniert hat, was man nicht wiederholen soll, bekannte Fehler.
   - **Offene Fragen und Risiken**: was noch beim Nutzer liegt oder ungeprüft ist.
   - **Nächster Schritt**: der eine konkrete Schritt, mit dem die neue Sitzung anfangen soll.

   Keine Passwörter, Token, Schlüssel oder andere Geheimnisse in die Datei schreiben, auch nicht gekürzt.

4. Am Ende ausgeben:
   - den vollen Pfad der Datei,
   - einen Satz: "Mit /clear die Sitzung leeren, dann den folgenden Prompt einfügen.",
   - den kopierfertigen Prompt für die neue Sitzung in einem eigenen Codeblock, in dieser Form (Pfad einsetzen):

     ```
     Lies die Datei "<Pfad>" vollständig. Sie ist ein Hand-Off aus einer früheren Sitzung. Prüfe kurz den Zustand der dort genannten Dateien und mache beim Abschnitt "Nächster Schritt" weiter. Frage nach, wenn etwas unklar ist.
     ```

Nicht selbst `/clear` ausführen oder vorschlagen, die Sitzung zu beenden, bevor die Datei geschrieben und der Pfad genannt ist.
