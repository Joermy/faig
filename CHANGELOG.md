# Changelog

## Unveröffentlicht — 29.10.2026

Neu:
- Chats wechseln, während ein Modell lädt oder ein Agent arbeitet. Mehrere Chats können gleichzeitig laufen, Stop gilt nur für den Chat, in dem er gedrückt wird. Laufende Chats blinken in der Seitenleiste, neue Antworten bekommen einen Punkt
- Denk- und Tool-Ansicht: die Gedanken des Modells live und danach eingeklappt, pro Werkzeug eine Zeile mit Datei, Zeilennummern, `+`/`−`-Zählern, Diff, geschriebenen Zeilen oder Shell-Ausgabe
- Live-Anzeige der Tokens pro Sekunde während das Modell schreibt; die Statistik unter jeder Antwort misst ab dem ersten Token
- Auto-Compact (Tools-Menü, standardmäßig an): wird der Kontext knapp, fasst das Modell ältere Nachrichten zusammen; der Chat bleibt komplett sichtbar. Manuell über „Verlauf komprimieren“ oder `/compact`
- Unendlicher Output (Tools-Menü): bricht eine Antwort am Token-Limit ab, schreibt der Agent automatisch an derselben Stelle weiter
- Vorlage „Venice AI“ (z. B. `deepseek-v4-1-flash-uncensored`); Venices eigener System-Prompt wird abgeschaltet, „Denkaufwand: Aus“ schaltet das Denken dort wirklich aus
- `write_file` mit `append` (große Dateien in Teilen), `read_file` mit Zeilenbereich
- Einstellungen → Studio MCP; ohne Eintrag wird Robloxs `mcp.bat` automatisch genutzt
- Feld „Kontextfenster“ in den Modell-Einstellungen

Behoben:
- Lokale Qwen3.5/3.6-Modelle meldeten „so gut wie nichts generiert (0 Zeichen)“: die Vorlage öffnet `<think>` schon im Prompt, dadurch landete das ganze Tool-JSON im Gedanken-Abschnitt, den node-llama-cpp nicht als Antwort zurückgibt. Der Abschnitt wird jetzt mit ausgewertet; eine leere Antwort wird einmal neu versucht
- Der Agent hörte bei einer leeren Antwort des Modells einfach auf. Jetzt fragt er einmal nach und meldet sonst den Grund
- DeepSeek V4 (auch über Venice/OpenRouter) lehnte ab dem zweiten Werkzeugaufruf mit 400 ab, weil `reasoning_content` nicht zurückgeschickt wurde
- Gedanken aus `reasoning_content`, `reasoning` und `<think>`-Tags werden erkannt statt als Antworttext zu erscheinen
- Ein Fehler mitten im Stream des Anbieters wurde verschluckt; 429/5xx/Verbindungsabbrüche beenden den Lauf nicht mehr, sondern werden wiederholt
- OpenAI-Modelle ohne `reasoning_effort`/`temperature`/`max_tokens`-Unterstützung lieferten 400; das betroffene Feld wird jetzt weggelassen oder umbenannt
- Das Shell-Werkzeug blockierte die ganze App bis zu 60 s, Stop half nicht, längere `npm install` wurden abgebrochen. Jetzt läuft es im Hintergrund, zeigt die Ausgabe live, wird bei Stop beendet (Limit 10 min)
- `str_replace_in_file`/`obsidian_edit_note` verfälschten Code mit `$'`, `$&` oder `$$` (z. B. jQuery `$('#id')`)
- ComfyUI: „20 Videos“ ergaben 20-mal dasselbe Video, weil die Seeds nicht neu gewürfelt wurden; Stop bricht jetzt auch den laufenden Job in ComfyUI ab
- Studio MCP startete pro Nachricht einen neuen `mcp.bat`-Prozess und schloss keinen; ohne Konfiguration tat der Schalter nichts, versprach dem Modell aber die Werkzeuge
- Autopilot ohne Vault schickte das Modell zu Obsidian-Werkzeugen, die es nicht gab; die Roadmap liegt dann in `ROADMAP.md` im Projektordner
- Scheiterte ein späterer Autopilot-Zyklus, wurden alle früheren Zyklen aus dem Chat gelöscht
- Eine Endlosschleifen-Erkennung mit mehreren Werkzeugaufrufen in einer Antwort hinterließ einen ungültigen Verlauf
- Neue Chats übernahmen den Studio-MCP-Schalter nicht; nach dem Löschen eines anderen Chats wurde der offene Chat nicht mehr aktualisiert
- Der Verlauf wird nach jedem Schritt gespeichert, nicht erst am Ende des Laufs
- `web_search`/`web_fetch` konnten ohne Zeitlimit hängen
- 30 Schritte reichten für normale Coding-Aufgaben oft nicht; jetzt 100 (Endlosschleifen-Erkennung und Stop bleiben)

## Unveröffentlicht — 24.10.2026

Neu:
- Skills aus `~/.claude/skills` über das Werkzeug `skill_read`
- `web_fetch` liest lange Seiten in Teilen über den Parameter `start`
- Werkzeug `obsidian_move_note`: verschiebt eine Datei im Vault (z. B. aus dem Eingang in ihren Ordner), überschreibt nie und löscht nichts

Behoben:
- Ein Dateiname mit ":" (z. B. "Gewerbe & Steuern: Fahrplan.md") legte unter Windows eine leere Datei "Gewerbe & Steuern" an und versteckte den Inhalt in einem NTFS-Datenstrom, gemeldet wurde "OK". Alle Datei- und Vault-Werkzeuge lehnen jetzt `< > : " | ? *` und Punkt oder Leerzeichen am Namensende mit einer klaren Meldung ab
- Gründliche Recherchen brachen nach 30 Schritten ab; mit geladenem Skill sind es jetzt 400
- Die Regel "1-3 Treffer lesen" galt auch dann, wenn der Nutzer ausdrücklich eine tiefe Recherche wollte
- In langen Läufen wurde jede alte Seite bei jedem Schritt neu mitgeschickt; ältere Seiten werden jetzt gekürzt

## 0.5.0 — 14.09.2026

Neu:
- Werkzeug für den Roblox-Studio-MCP-Server
- Aufgeräumter Kopfbereich: Modell, Projektordner und der Rest liegen in drei Menüs
- Name der App ist jetzt FAIG

Behoben:
- Ein abgebrochener Lauf ließ Werkzeugaufrufe ohne Ergebnis im Verlauf zurück; der
  nächste Aufruf im selben Chat wurde vom Anbieter abgelehnt
- Die Fehlermeldung zu `maxTokens` zeigte auf die falsche Ursache
- ComfyUI-Workflows mit Reroute-Knoten wurden mit "missing node" abgelehnt
- Die Meldung zur Werkzeug-Schleife nannte immer 5 Versuche statt der echten Zahl

## 0.4.0 — 14.09.2026

Neu:
- Antworten lokaler Modelle laufen live mit, statt am Stück zu erscheinen
- Aufklappbarer Bereich "Denkt..." während des Streams
- System-Prompt lässt sich im Chat ansehen
- Schreibende Obsidian-Werkzeuge — vorher konnte der Agent den Vault nur lesen

Behoben:
- Verschachteltes `tool_arguments_json` schrieb stillschweigend kaputte Dateien
- Ein leeres `new_str` schrieb das Wort `undefined` in die Datei, statt den Text zu löschen
- Die Ansicht sprang beim Streamen nach unten, auch wenn man hochgescrollt hatte

## 0.3.0 — 13.09.2026

Neu:
- Der Obsidian-Vault ist immer eingebunden, unabhängig vom Projektordner des Chats
- Websuche ohne Schalter: der Agent entscheidet selbst
- Autopilot: Roadmap planen, selbst prüfen, mehrere Schritte ohne Aufsicht
- Knopf für die VRAM- und RAM-Anzeige

Behoben:
- Die Suche im Vault brach ab 3000 Dateien still ab, Grenze steht jetzt bei 20000
- Der Agent verwechselte Vault und Projektordner
- Die Eingabezeile blieb hängen, nachdem man den Verlauf geleert hatte

## 0.2.0 — 13.09.2026

Neu:
- Ladeseite für lokale Modelle mit echtem Fortschritt und Hardware-Anzeige
- Einstellungen als eigene Seite statt als Dialog
- Knopf "Automatisch für meine Hardware optimieren"

Behoben:
- Lokale Modelle liefen im Hauptprozess und ließen das ganze System hängen; sie
  laufen jetzt in einem eigenen Prozess
- Fehlgeschlagene VRAM-Zuweisungen wurden endlos wiederholt
- Der Worker startete im gebauten Programm gar nicht, weil er den falschen
  Electron-Pfad benutzte
