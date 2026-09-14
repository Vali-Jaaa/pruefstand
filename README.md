# Prüfstand

Dashboard für die automatische Bearbeitung von Auditunterlagen mit Claude Code.
Datei ablegen, Modul wählen, fertiges Ergebnis abholen.

Dieses Repository enthält **ausschließlich den Programmcode**. Module,
Anweisungen, Referenzdateien, Aufträge und Zugangsdaten liegen auf dem Server,
auf dem der Dienst läuft, und sind hier bewusst nicht enthalten.

```
server/   Dienst: Weboberfläche, Schnittstelle, Warteschlange
  index.js    HTTP-Server und Schnittstellen
  worker.js   ruft Claude Code auf, ein Auftrag nach dem anderen
  store.js    Ablage auf der Platte
  config.js   Standardwerte und Umgebungsvariablen
public/   Oberfläche: Prüfstand und Admin-Center
```

Der Dienst holt sich Änderungen aus diesem Repository selbst ab und startet
danach neu — ein Update erfordert keinen Eingriff am Server.
