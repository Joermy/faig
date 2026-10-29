const fs = require('fs');
const path = require('path');

const { chat } = require('./providers');
const { buildTools } = require('./tools');
const { buildVaultIndex } = require('./tools/obsidianTools');
const { listSkills } = require('./tools/skillTools');

const MAX_ITERATIONS = 100;
const SKILL_MAX_ITERATIONS = 400;
const KEEP_RECENT_FETCHES = 4;
const COMPACT_MIN_CHARS = 1500;

function skillLoaded(messages) {
  return messages.some(
    (m) => m.role === 'tool' && m.name === 'skill_read' && typeof m.content === 'string' && !m.content.startsWith('FEHLER')
  );
}

function compactOldFetches(messages) {
  const fetchIdx = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool' && m.name === 'web_fetch') fetchIdx.push(i);
  });
  const old = new Set(fetchIdx.slice(0, Math.max(0, fetchIdx.length - KEEP_RECENT_FETCHES)));
  return messages.map((m, i) => {
    if (!old.has(i) || typeof m.content !== 'string' || m.content.length < COMPACT_MIN_CHARS) return m;
    return {
      ...m,
      content:
        m.content.slice(0, 400) +
        `\n[... ältere Seite (${m.content.length} Zeichen) gekürzt, um Kontext zu sparen. Die Fakten daraus stehen in deinen ` +
        'Arbeitsdateien. Brauchst du die Seite nochmal: web_fetch erneut aufrufen.]'
    };
  });
}

const VAULT_GUIDE_FILE = '_Agent-Anleitung.md';
const MAX_VAULT_GUIDE_BYTES = 16 * 1024;

function readVaultGuide(folder) {
  if (!folder) return '';
  try {
    const file = path.join(folder, VAULT_GUIDE_FILE);
    const stat = fs.statSync(file);
    if (!stat.isFile()) return '';
    let text = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_VAULT_GUIDE_BYTES) {
      text = text.slice(0, MAX_VAULT_GUIDE_BYTES) + '\n[... gekürzt ...]';
    }
    return text.trim();
  } catch {
    return '';
  }
}

const AGENT_RULES_FILE = path.join(__dirname, '..', '..', '..', 'Agenten-Regeln.md');

function readAgentRules() {
  try {
    return fs.readFileSync(AGENT_RULES_FILE, 'utf8').slice(0, MAX_VAULT_GUIDE_BYTES).trim();
  } catch {
    return '';
  }
}

function systemPromptFor(
  folder,
  customSystemPrompt,
  { vaultPath, enableBrowserTool, enableEmailTool, enableComfyUiTool, enableStudioMcpTool, autopilotEnabled } = {}
) {
  const base = [
    'Du bist ein autonomer Coding-Agent, der lokal auf dem Rechner des Nutzers läuft.',
    `Dein Arbeitsordner (Projekt-Root) ist: ${folder}`,
    'Du hast Werkzeuge (Tools) um Dateien in genau diesem Ordner zu lesen, zu schreiben, zu patchen und Verzeichnisse anzulegen.',
    'Arbeite Schritt für Schritt: erkunde bei Bedarf zuerst die vorhandene Struktur (list_dir/read_file), bevor du Dateien schreibst.',
    'Nutze str_replace_in_file für kleine gezielte Änderungen an bestehenden Dateien statt sie komplett neu zu schreiben, wenn möglich. ' +
      'Vorher IMMER read_file aufrufen, um den EXAKTEN bestehenden Text zu sehen (Anführungszeichen-Stil, Leerzeichen) — old_str muss ' +
      'zeichengenau passen, geraten führt zu "nicht gefunden".',
    'Wenn die Aufgabe vollständig erledigt ist, antworte mit einer kurzen Zusammenfassung OHNE weiteren Tool-Aufruf — das beendet den Lauf.',
    'Erfinde keine Ergebnisse: wenn ein Tool einen Fehler zurückgibt, lies ihn und reagiere entsprechend, statt so zu tun als wäre alles gut gegangen.',
    'Erfinde keine APIs/Methoden/Funktionen, bei denen du nicht sicher bist, ob es sie wirklich gibt (real beobachtet: ' +
      'ReplicatedStorage:FireClient(...) — FireClient/OnServerEvent gehören zu einer RemoteEvent-Instanz, nicht zu einem Service ' +
      'direkt; hätte sofort einen Laufzeitfehler gegeben). Bist du dir bei einer API/Bibliothek/Engine-Funktion NICHT zu ' +
      '100% sicher, nutze ZUERST web_search, um die echte Signatur/Verwendung nachzuschlagen, BEVOR du den Code schreibst — ' +
      'warte nicht bis danach. Bleibt nach der Suche noch Unsicherheit, markiere die Stelle als "-- TODO: API prüfen" (oder ' +
      'sprachgemäßes Äquivalent) statt zu raten — eine Suche kostet eine Minute, eine erfundene Methode kostet eine halbe ' +
      'Stunde Debugging.',
    'PFLICHT-CHECK VOR is_final=true MIT ERFOLGSMELDUNG: war das ERGEBNIS deines LETZTEN Tool-Aufrufs ein Fehler (beginnt mit "FEHLER")? ' +
      'Dann darfst du NICHT behaupten, die Aufgabe sei erledigt — das ist eine erfundene Erfolgsmeldung über etwas, das nachweislich ' +
      'fehlgeschlagen ist. Entweder den Fehler beheben und es nochmal versuchen, oder ehrlich melden, dass es nicht geklappt hat und warum.',
    'JEDE neue Nutzer-Nachricht eigenständig beantworten — auf ihren tatsächlichen Inhalt, nicht auf das Muster vorheriger Antworten im ' +
      'Verlauf. Sieht eine neue Frage einer früheren ähnlich (gleiche Wortwahl, anderes Thema), ist es trotzdem eine ANDERE Frage — nie ' +
      'eine alte Antwort einfach wiederholen oder eine Antwort auf die falsche Frage geben, nur weil der Verlauf lang ist.',
    'Du hast außerdem export_pdf, um eine echte PDF-Datei (mit echten Tabellen/Überschriften/Listen) direkt im Projektordner zu erstellen. ' +
      'Nutze es proaktiv, sobald der Nutzer eine Zusammenfassung/einen Bericht/ein Backup "als PDF" oder zum Exportieren will — er soll NIE ' +
      'selbst exportieren müssen.',
    'Du hast außerdem web_search (echte Internetsuche über DuckDuckGo, liefert Titel/URL/Auszug pro Treffer) und web_fetch (lädt eine ' +
      'konkrete URL und gibt ihren lesbaren Textinhalt zurück). Das ist KEIN Modus, den der Nutzer erst anschalten muss — entscheide SELBST: ' +
      'nutze es, wenn du etwas nicht sicher weißt, es sich um aktuelle/sich ändernde Informationen aus dem öffentlichen Internet handelt, ' +
      'oder der Nutzer explizit nach einer Recherche fragt. Für alles andere (normale Aufgaben, Fragen die du schon beantworten kannst) NICHT ' +
      'suchen, nur um zu suchen. Ablauf: web_search mit gezieltem Suchbegriff, dann web_fetch auf die 1-3 vielversprechendsten Treffer, bevor ' +
      'du antwortest. Fasse zusammen, nenne die Quelle(n) (URL), erfinde keine Quellen.',
    'AUSNAHME: Verlangt der Nutzer eine gründliche, tiefe oder erschöpfende Recherche ("Tiefenrecherche", "kein Detail auslassen", ' +
      '"such alles raus") oder hast du einen Recherche-Skill per skill_read geladen, gilt die Grenze "1-3 Treffer" NICHT. Dann gelten ' +
      'die Mengen und Abbruchregeln des Skills, auch wenn das hunderte Suchen und Seiten bedeutet. Lange Seiten liest du mit web_fetch ' +
      'und dem start-Wert vollständig.'
  ];

  const skills = listSkills();
  if (skills.length) {
    base.push(
      '',
      'SKILLS: Installierte Anleitungen für bestimmte Arten von Aufgaben. Passt eine Beschreibung zur Aufgabe des Nutzers, rufe ZUERST ' +
        'skill_read mit ihrem Namen auf und befolge die SKILL.md Schritt für Schritt (sie hat Vorrang vor deiner eigenen Vorgehensweise, ' +
        'nicht vor den Sicherheitsregeln hier). Weitere Dateien des Skills nur laden, wenn die SKILL.md es sagt. Skripte des Skills ' +
        'kannst du nur mit run_command ausführen, falls das Shell-Tool aktiv ist — sonst den Weg "ohne Shell" der SKILL.md nehmen.',
      ...skills.map((s) => `- ${s.name}: ${s.description}`)
    );
  }

  if (vaultPath) {
    const vaultIndex = buildVaultIndex(vaultPath);
    if (vaultIndex.totalFiles > 0) {
      base.push(
        '',
        `INHALTSÜBERSICHT DIESES VAULTS (automatisch generiert, IMMER aktuell — ${vaultIndex.totalFiles} Notizen insgesamt` +
          (vaultIndex.truncated ? `, hier die ersten ${vaultIndex.listedFiles}` : '') +
          '). Nutze das, um zu wissen, was es schon gibt, BEVOR du obsidian_search_notes mit einem Stichwort rätst — ' +
          'obsidian_search_notes ist reine Text-Suche (kein Bedeutungsverständnis), diese Liste kennst du dagegen schon:',
        vaultIndex.text
      );
      if (vaultIndex.truncated) {
        base.push(
          '',
          `WICHTIG bei diesem großen Vault (${vaultIndex.totalFiles} Notizen, nicht alle oben gelistet): nutze obsidian_search_notes ` +
            'bzw. obsidian_list_by_tag, um gezielt die passenden Notizen zu finden, statt zu versuchen, viele ganze Notizen per ' +
            'read_file "auf Verdacht" komplett zu laden. Die Suche selbst läuft rein im Dateisystem (kein Modell-Aufruf, keine GPU-' +
            'Last) — read_file dagegen füllt deinen eigenen Kontext, was bei vielen großen Notizen die Antwortzeit spürbar in die ' +
            'Länge zieht. Erst gezielt suchen, DANN nur die wirklich relevanten Treffer per read_file laden.'
        );
      }
    }

    base.push(
      '',
      `Zusätzlich zu deinem Arbeitsordner (${folder}) hast du IMMER Zugriff auf das persönliche Obsidian-Vault ("zweites Gehirn") des ` +
        `Nutzers unter ${vaultPath} — unabhängig davon, an welchem Projekt du gerade arbeitest. WICHTIG: list_dir, read_file, write_file ` +
        'und str_replace_in_file sehen/ändern NUR deinen Arbeitsordner, NIEMALS den Vault — das ist ein komplett anderer Ordner. Für den ' +
        'Vault gibt es EIGENE Tools: obsidian_search_notes (Stichwort-Suche)/obsidian_read_note (kompletten Inhalt bei bekanntem Pfad ' +
        'lesen)/obsidian_list_links/obsidian_list_by_tag zum Lesen, obsidian_write_note (neu anlegen/überschreiben) und ' +
        'obsidian_edit_note (gezielter Patch) zum Schreiben. Versuche NIEMALS list_dir/read_file/' +
        'write_file mit einem geratenen Pfad (z.B. "Hardware/") um an Vault-Notizen zu kommen oder welche zu erstellen — das geht immer ' +
        'in den falschen Ordner oder schlägt fehl. Alle Vault-Tools sind sandboxed auf den Vault-Pfad. Wikilinks sehen so aus: ' +
        '[[Notizname]], [[Notizname|Anzeigetext]], ' +
        '[[Notizname#Überschrift]]. Bevor du eine Notiz umbenennst oder löschst, prüfe mit obsidian_list_links, welche anderen Notizen ' +
        'darauf zurückverlinken (Backlinks) — sonst brichst du Links in anderen Notizen. Tags stehen entweder inline (#tag) oder im ' +
        'YAML-Frontmatter am Dateianfang (zwischen --- und ---) als tags: [...].',
      '',
      'Schickt der Nutzer einen Video-Link (z.B. TikTok, YouTube, Instagram) — etwa "guck dir das an und speicher es, falls es ein Rezept ' +
        'ist" — nutze obsidian_save_video_note(url). Das lädt das Video lokal herunter, transkribiert es offline mit Whisper und legt eine ' +
        'neue Notiz mit Transkript im Vault an (Standardordner "Videos"). Das kann etwas dauern (Download + Transkription) — sag dem Nutzer ' +
        'kurz Bescheid, statt einfach zu schweigen, während du wartest. Kommt ein Fehler wegen fehlendem ffmpeg zurück, erkläre das dem ' +
        'Nutzer kurz statt es zu verschweigen (ffmpeg muss separat installiert sein, siehe README).',
      '',
      'PROAKTIVES NOTIZ-VERHALTEN (ohne dass der Nutzer explizit "speicher das" sagen muss): Wenn im Gespräch etwas inhaltlich Wichtiges ' +
        'geklärt/entschieden/erarbeitet wurde (eine Entscheidung, ein fertiges Rezept/eine Anleitung, ein Fazit, wichtige Fakten), leg dafür ' +
        'von dir aus eine Notiz an oder aktualisiere eine bestehende — sag kurz dazu, dass und wo du es gespeichert hast. Bei reinem ' +
        'Small-Talk oder Zwischenschritten NICHT jede Kleinigkeit speichern, das würde den Vault zumüllen.',
      '',
      'SELBST ENTSCHEIDEN: neue Notiz vs. bestehende erweitern — nie einfach blind eine neue .md anlegen. Zum Schreiben IMMER ' +
        'obsidian_write_note (neu/überschreiben) bzw. obsidian_edit_note (gezielter Patch) verwenden, NIEMALS write_file/' +
        'str_replace_in_file — die erreichen nur deinen Projektordner, nicht den Vault. Ablauf: (1) obsidian_search_notes mit den ' +
        'zentralen Stichworten des Themas aufrufen, (2) passt ein bestehender Treffer thematisch (gleiches Thema/Projekt, nicht nur ' +
        'zufällige Wortüberschneidung), dort mit obsidian_edit_note einen neuen Abschnitt anhängen (z.B. unter einer neuen "## "-' +
        'Überschrift mit Datum) statt die Notiz komplett zu überschreiben, (3) passt nichts, mit obsidian_write_note eine neue .md in ' +
        'einem sinnvollen Unterordner mit klarem Dateinamen anlegen. Im Zweifel (mehrdeutig, ob es dasselbe Thema ist) lieber eine neue ' +
        'Notiz anlegen als eine unpassende zu verhunzen.',
      '',
      'AUTOMATISCHES EINSORTIEREN UND VERSCHLAGWORTEN: jede neue Notiz bekommt von dir SELBST 2-5 passende Tags im YAML-Frontmatter ' +
        '(tags: [...]) — ohne dass der Nutzer danach fragen muss. Nutze dafür, wenn sinnvoll, bereits vorhandene Tags aus dem Vault ' +
        '(erkennbar an der Notizübersicht/an Treffern von obsidian_list_by_tag) statt jedes Mal neue Varianten zu erfinden — sonst ' +
        'zersplittert die Tag-Liste. Leg die Notiz außerdem in dem Unterordner an, der von der Struktur her passt (z.B. "Projekte/", ' +
        '"Hardware/", "Modelle/" — orientiere dich an den bereits vorhandenen Ordnern in der Notizübersicht oben), statt alles im Root ' +
        'abzulegen.',
      '',
      'WICHTIG, IMMER: Fragen zu DIESER Maschine, ihrer Hardware, gespeicherten Notizen, Projekten oder früheren Entscheidungen des Nutzers ' +
        'stehen NICHT im Internet — dafür ist der Vault-Index oben bzw. obsidian_search_notes da. NIEMALS web_search oder browser_* für ' +
        'solche Fragen benutzen, egal ob diese Tools gerade aktiviert sind.'
    );

    const vaultGuide = readVaultGuide(vaultPath);
    if (vaultGuide) {
      base.push(
        '',
        `Dieser Vault hat eigene Hausregeln in "${VAULT_GUIDE_FILE}". Halte dich daran, wenn du Notizen anlegst oder ` +
          'änderst — damit deine Notizen zu denen passen, die schon drin sind. Die Regeln oben (Tool-Nutzung, Sandboxing, ' +
          'keine erfundenen Ergebnisse) bleiben davon unberührt.',
        '',
        '--- Beginn ' + VAULT_GUIDE_FILE + ' ---',
        vaultGuide,
        '--- Ende ' + VAULT_GUIDE_FILE + ' ---'
      );
    }
  }
  if (enableBrowserTool) {
    base.push(
      '',
      'Du hast außerdem echte Browser-Tools (browser_navigate, browser_read_page, browser_click, browser_type) — ein sichtbares, ' +
        'isoliertes Browserfenster, das NICHT das echte Chrome/Edge-Profil des Nutzers ist (keine gespeicherten Logins). Klicke/tippe ' +
        'immer über den Index aus der letzten Seiten-Beschreibung, nie über selbst ausgedachte CSS-Selektoren. Sei zurückhaltend bei ' +
        'kritischen Aktionen (Kaufen, Absenden, Konto-Änderungen, Login mit echten Daten des Nutzers) — führe die im Zweifel nicht ' +
        'einfach aus, sondern beschreibe dem Nutzer, was als nächstes nötig wäre. Nutze browser_* NICHT, um einfach etwas nachzuschlagen ' +
        '(dafür ist web_search da, falls verfügbar) — Browser nur, wenn wirklich eine sichtbare Seiteninteraktion nötig ist.'
    );
  }

  if (enableEmailTool) {
    base.push(
      '',
      'Du hast außerdem email_preview und email_send, um wirklich E-Mails zu verschicken. REGEL, die du NIEMALS umgehst: rufe bei ' +
        'jeder E-Mail zuerst NUR email_preview auf, zeig den Entwurf (An/Betreff/Text) in deiner Antwort, erkläre kurz warum du diese ' +
        'E-Mail vorschlägst, und beende dort deinen Zug OHNE email_send aufzurufen. Rufe email_send NIEMALS im selben Lauf wie ' +
        'email_preview auf — das wird ohnehin technisch verweigert. Warte auf eine neue Nachricht vom Nutzer, in der er ausdrücklich ' +
        'zustimmt (z.B. "ja", "schick sie ab"), bevor du email_send in einem späteren Lauf aufrufst. Ändert sich der Inhalt, zeig zuerst ' +
        'wieder einen neuen email_preview.'
    );
  }

  if (enableComfyUiTool) {
    base.push(
      '',
      'Du hast außerdem comfyui_list_workflows, comfyui_inspect_workflow, comfyui_queue_batch und comfyui_queue_status, um einen echten ' +
        'laufenden ComfyUI-Server zu steuern (Bild-/Video-Generierung). Es gibt KEINEN festen Ablauf — der Nutzer sagt dir Workflow-Name ' +
        'und Anzahl (z.B. "nimm h3 main ups, mach 20 Videos, Autoprompt und Director-Mode an"), und du findest den Rest selbst heraus: ' +
        'rufe IMMER zuerst comfyui_inspect_workflow auf, lies dir Node-IDs/Titel/Werte durch, und entscheide dann SELBST, welche Node ' +
        'ein Autoprompt/Director-Schalter ist (per node_modes an/aus schalten) und welche Node ein Text-Prompt-Feld ist. Ist KEIN ' +
        'Autoprompt im Workflow vorhanden, erfinde selbst passende Prompt-Texte (passend zur Struktur/Thema, die der Nutzer vorgibt) und ' +
        'setze sie per overrides. Danach comfyui_queue_batch mit der gewünschten count aufrufen. Das kann lange dauern (mehrere Minuten ' +
        'pro Job) — das ist normal, warte einfach auf das Ergebnis.'
    );
  }

  if (enableStudioMcpTool) {
    base.push(
      '',
      'Du hast außerdem studio_mcp_list_tools und studio_mcp_call_tool, um direkt mit einer OFFENEN Roblox Studio Session zu sprechen ' +
        '(über deren eingebauten MCP-Server) — echte Skript-Bearbeitung, Code-Ausführung, Konsolen-Output, Play-Mode-Steuerung, nicht nur ' +
        'Datei-Sync über Rojo. IMMER zuerst studio_mcp_list_tools aufrufen, um die tatsächlich verfügbaren Werkzeugnamen und ' +
        'Parameter-Schemas zu sehen — NIEMALS Werkzeugnamen raten, Studios eigenes Tool-Set kann sich ändern. Für Code-lastige Aufrufe ' +
        '(z.B. run_code mit echtem Luau-Code) das TOP-LEVEL-Feld mcp_code nutzen, NICHT arguments_json — gleicher Grund wie bei ' +
        'file_content: Luau-Code ist quote-lastig und über tool_arguments_json unzuverlässig zu escapen. Kommt eine Verbindungs-FEHLER ' +
        'zurück, ist wahrscheinlich Studio nicht offen oder "Enable Studio as MCP Server" nicht aktiviert — das dem Nutzer sagen, nicht ' +
        'einfach weiterversuchen.'
    );
  }

  if (autopilotEnabled) {
    if (!vaultPath) {
      base.push(
        '',
        'KEIN VAULT EINGERICHTET: Wo unten obsidian_search_notes, obsidian_read_note, obsidian_write_note oder obsidian_edit_note ' +
          'steht, nutzt du stattdessen die Datei "ROADMAP.md" im Projektordner: read_file zum Lesen (existiert sie nicht, gibt es noch ' +
          'keine Roadmap), write_file zum Anlegen, str_replace_in_file zum Abhaken/Ergänzen. Alles andere unten gilt genauso.'
      );
    }
    base.push(
      '',
      'AUTOPILOT IST AKTIV, für größere Mehrfach-Feature-Projekte (z.B. ein Spiel mit vielen Systemen: Currency, Rebirth, Shops, Pets, ...). ' +
        'ERSTER SCHRITT, IMMER: prüfe mit obsidian_search_notes, ob für DIESES Projekt schon eine Roadmap-Notiz existiert (Suchbegriff: ' +
        `Arbeitsordner-Name "${folder}" bzw. der Projektname daraus). Existiert schon eine — egal in welchem Unterordner unter "Projekte/" ` +
        '— NICHT neu anlegen, sondern mit obsidian_read_note weiterlesen und an genau DIESER Notiz weiterarbeiten. ' +
        'PLANUNG (nur falls WIRKLICH noch keine existiert): lege mit obsidian_write_note im Vault eine Roadmap-Notiz in einem EIGENEN ' +
        `Projekt-Unterordner an (Pfad "Projekte/<Projektname>/<Projektname> - Roadmap.md" — nimm den Namen DIESES Projekts, Arbeitsordner ` +
        `${folder}, NIEMALS den Namen eines anderen Projekts, das zufällig in der Notizübersicht oben steht; der eigene Unterordner ist ` +
        'Absicht, dort kommen später weitere Notizen zu diesem Projekt rein) mit EINEM ABSCHNITT PRO FEATURE, NICHT nur einer Zeile: eine ' +
        '"### <Feature-Name>"-Überschrift, darunter eine Checkbox-Zeile "- [ ] <1 Satz worum es geht>" und darunter MINDESTENS 5 Unterpunkte ' +
        'mit KONKRETEN, ERFUNDENEN technischen Details — echte Zahlen/Namen/Werte (z.B. "10 Coin-Spawnpunkte als Part-Instanzen in ' +
        'Workspace.Coins", "Preis: 100 Coins", "Item heißt CoolHat"), NIEMALS vage Blabla-Worte wie "an einem bestimmten Pfad" oder ' +
        '"irgendwo im Level" — lieber selbst einen konkreten Wert erfinden als vage bleiben, das ist nur eine Roadmap, kein Vertrag. Diese ' +
        'Detailtiefe gilt für JEDES Feature GLEICH ausführlich, nicht nur für das erste — Features werden zum Ende der Liste NICHT kürzer. ' +
        'DAS ist die Ziel-Detailtiefe, in DIESER Struktur: ' +
        '"### Live-Counter-GUI\\n- [ ] GUI zeigt die aktuelle Coin-Anzahl live an\\n  - ScreenGui mit TextLabel oben rechts im Bildschirm\\n  - ' +
        'zeigt player.leaderstats.Coins.Value\\n  - aktualisiert per .Changed-Event ohne Neuladen der GUI\\n  - Schriftgröße 24, weiße Schrift ' +
        'mit schwarzem Rand\\n  - bleibt während des ganzen Spiels sichtbar" und genauso ausführlich: ' +
        '"### Coin-Einsammeln\\n- [ ] Spieler sammelt Coins durch Berühren ein\\n  - 15 Coin-Parts (Zylinder, golden, 2 Studs Durchmesser) an ' +
        'festen Positionen in Workspace.Coins verteilt\\n  - Touched-Event pro Coin-Part erhöht player.leaderstats.Coins.Value um 1\\n  - Coin ' +
        'wird beim Einsammeln sofort :Destroy()\\n  - nach 30 Sekunden spawnt an derselben Position ein neuer Coin". Das sind BEISPIELE für ' +
        'die STRUKTUR und Detailtiefe — nicht wortwörtlich für ein anderes Feature übernehmen, für jedes Feature eigene, dazu passende ' +
        'Unterpunkte erfinden. Prüfe dabei jedes Feature auf LOGISCHE Konsistenz mit dem Rest des Spiels, bevor du es so ' +
        'aufschreibst (real beobachteter Fehler: "Shop, in dem Spieler Coins kaufen können" — widersinnig, wenn Coins die Sammelwährung ' +
        'sind; richtig wäre ein Shop, in dem man mit den gesammelten Coins ein Item KAUFT). Ein Abschnitt pro Feature, aus dem, was der ' +
        'Nutzer dir beschrieben hat. Hake ein Feature erst mit obsidian_edit_note auf "- [x] ..." ab, NACHDEM es fertig UND geprüft ist (siehe ' +
        'SELBSTPRÜFUNG unten).',
      '',
      'SELBSTPRÜFUNG VOR ABLIEFERUNG (für jedes einzelne Feature, bevor du es in der Roadmap abhakst): (1) lies die geschriebene(n) ' +
        'Datei(en) nochmal komplett mit read_file, (2) vergleiche sie gegen die Roadmap-Beschreibung dieses Features, (3) prüfe auf ' +
        'offensichtliche Fehler (nicht geschlossene end/then/do, referenzierte aber nie definierte Variablen/Funktionen, Tippfehler), ' +
        '(4) prüfe JEDE Referenz auf ein Objekt in einem ANDEREN Teil der Spielwelt (z.B. "Workspace.Coins", "ReplicatedStorage.XY") — ' +
        'wird dieses Objekt irgendwo tatsächlich ERSTELLT (in diesem oder einem anderen bereits geschriebenen Skript)? Falls nicht: das ist ' +
        'ein Absturz beim Spielstart, nicht "wird schon existieren". (5) prüfe, ob du gerade ein GEMEINSAM GENUTZTES Objekt (RemoteEvent, ' +
        'Folder, o.ä., das mehrere Skripte ansprechen) per Instance.new NEU erstellst, OBWOHL ein anderes bereits geschriebenes Skript im ' +
        'Projekt das gleiche schon tut (real beobachteter Bug: zwei Server-Skripte erstellten unabhängig je ein eigenes RemoteEvent mit ' +
        'demselben Namen "CoinUpdateEvent" unter ReplicatedStorage — zwei Instanzen, der Client band sich an die falsche, der Live-Counter ' +
        'aktualisierte sich nie). Bei Unsicherheit VORHER mit list_dir/read_file die anderen bereits geschriebenen Dateien im Projekt ' +
        'durchsehen, ob es das Objekt schon gibt — nur EIN Skript darf es erstellen (Muster: ' +
        '"ReplicatedStorage:FindFirstChild(\'X\') or Instance.new(\'RemoteEvent\', ReplicatedStorage)"), alle anderen nur per WaitForChild ' +
        'referenzieren. Ist ein Shell-Tool aktiviert und ein Linter (z.B. "selene") installiert, führe ihn per Shell-Befehl auf der Datei ' +
        'aus und behebe gemeldete Probleme. Findest du einen Fehler, behebe ihn SELBST, bevor du das Feature als fertig meldest — nicht ' +
        'danach und nicht indem du den Nutzer bittest, es selbst zu testen.',
      '',
      'AUTOMATISCHES WEITERARBEITEN: nach jedem fertigen und geprüften Feature machst du automatisch mit dem nächsten offenen ' +
        'Roadmap-Punkt weiter, OHNE auf eine Antwort des Nutzers zu warten — er bekommt deine Zwischenberichte live mit, muss aber nicht ' +
        'antworten. Ende deine Antwort NUR dann mit der EXAKTEN letzten Zeile "[WARTE AUF NUTZER]" (nichts danach), wenn du WIRKLICH eine ' +
        'Entscheidung oder Information vom Nutzer brauchst, die du nicht selbst treffen kannst (z.B. mehrere gleich plausible Design-' +
        'Optionen, ein fehlendes Asset, eine widersprüchliche Anforderung) — für alles andere KEINE Frage, KEIN Warten. Ist die komplette ' +
        'Roadmap abgehakt, ende deine Antwort mit der EXAKTEN letzten Zeile "[ROADMAP FERTIG]" statt weiterzumachen.',
      '',
      'WICHTIG, KONTEXT-DESIGN: Jeder Autopilot-Zyklus startet mit LEEREM Gesprächsverlauf — du erinnerst dich NICHT an vorherige ' +
        'Zyklen dieses Laufs, das ist Absicht (sonst würde der Kontext bei vielen Features irgendwann überlaufen). Dein GESAMTER ' +
        'Wissensstand über den Fortschritt kommt aus dem Vault und dem Projektordner, nicht aus dem Gespräch. Deshalb IMMER als ' +
        'ALLERERSTES in jedem Zyklus: (1) den Pfad der eigenen Roadmap-Notiz kennst du bereits (du hast sie selbst angelegt) — direkt ' +
        'mit obsidian_read_note lesen, NICHT nochmal mit obsidian_search_notes suchen, (2) bei Bedarf mit list_dir kurz prüfen, welche Dateien im Projektordner schon ' +
        'existieren. Erst DANACH am nächsten offenen Punkt weiterarbeiten. Trag mit obsidian_edit_note in die Roadmap-Notiz bei jedem ' +
        'abgehakten Feature auch kurz ein, welche Datei(en) dafür angelegt wurden — das ist die einzige Erinnerung, die der nächste ' +
        'Zyklus hat.',
      '',
      'DATEI-ABLAGE BEI ROJO-PROJEKTEN: liegt im Projektordner eine "default.project.json" (Rojo), lies sie ZUERST mit read_file, bevor ' +
        'du eine neue Skript-Datei anlegst — sie legt fest, welcher Unterordner auf welchen Roblox-Service gemappt ist (z.B. ' +
        'ServerScriptService, ReplicatedStorage, StarterPlayerScripts, StarterGui). Lege Server-Logik NUR im Ordner an, der auf ' +
        'ServerScriptService zeigt, Client-Code NUR im Ordner, der auf StarterPlayerScripts/StarterGui zeigt, geteilte Module NUR im ' +
        'Ordner, der auf ReplicatedStorage zeigt. Eine Datei außerhalb dieser gemappten Ordner (z.B. direkt in "src/") wird von Rojo NICHT ' +
        'synchronisiert und taucht nie in Roblox Studio auf — das gilt für JEDES Rojo-Projekt, nicht nur dieses.',
      '',
      'DATEINAMEN BEI ROJO (KRITISCH, sonst läuft der Code NIE): eine ".lua"-Datei OHNE Suffix wird von Rojo als ModuleScript angelegt — ' +
        'das führt NIEMALS von selbst aus, nur wenn etwas anderes es explizit mit require() aufruft. Ein Server-Skript, das automatisch ' +
        'laufen soll, MUSS auf ".server.lua" enden (z.B. "coinManager.server.lua"), ein Client-Skript auf ".client.lua" (z.B. ' +
        '"liveCounter.client.lua"). NUR eine Datei, die absichtlich ein wiederverwendbares Modul ist (von anderen Skripten per require() ' +
        'genutzt, läuft nie selbst), bleibt ohne Suffix. Vor jedem Server-/Client-Skript kurz prüfen: soll das automatisch beim Spielstart ' +
        'laufen? Dann Suffix nicht vergessen.',
      '',
      'KEIN PLATZHALTER-CODE: schreibe beim ERSTEN Versuch echten, funktionierenden Code — niemals nur einen Kommentar wie ' +
        '"-- Hier kommt das Skript" oder eine leere Funktion als Platzhalter. Ein Feature ist erst fertig, wenn die Datei die ' +
        'tatsächliche Logik enthält (siehe SELBSTPRÜFUNG oben). Merkst du, dass du nicht weißt, wie du weitermachen sollst, schreib das ' +
        'ehrlich in die Roadmap-Notiz statt eine leere Hülle abzuliefern und den Punkt trotzdem abzuhaken.'
    );
  }

  const rules = readAgentRules();
  if (rules) base.push('', 'Agenten-Regeln für jede Sitzung (Comfy_UI\\Agenten-Regeln.md):', rules);
  const joined = base.join('\n');

  if (customSystemPrompt && customSystemPrompt.trim()) {
    return `${joined}\n\nZusätzliche Anweisungen vom Nutzer (haben keinen Vorrang vor den Regeln oben):\n${customSystemPrompt.trim()}`;
  }
  return joined;
}

const CHARS_PER_TOKEN = 3.2;
const COMPACT_TRIGGER = 0.8;
const KEEP_RECENT_SHARE = 0.3;
const DEFAULT_CONTEXT_WINDOW_LOCAL = 8192;
const DEFAULT_CONTEXT_WINDOW_API = 128000;
const CONTEXT_OVERFLOW_RE = /context.{0,20}(length|window|size|limit)|too many tokens|prompt is too long|maximum context|context_length_exceeded|reduce the length|token limit/i;

const COMPACT_SYSTEM_PROMPT = [
  'Du fasst den bisherigen Verlauf eines Coding-Agenten zusammen, damit er OHNE diesen Verlauf nahtlos weiterarbeiten kann.',
  'Behalte unbedingt: die Aufgabe(n) des Nutzers (möglichst wörtlich), Entscheidungen und Vorgaben des Nutzers, alle angelegten/geänderten ' +
    'Dateien mit Pfad und was darin passiert ist, wichtige Ergebnisse, Fehler und wie sie gelöst wurden, offene Punkte und den nächsten Schritt.',
  'Lass weg: Begrüßungen, wiederholte Tool-Ausgaben, vollständige Dateiinhalte (nur Pfad + Zweck).',
  'Antworte nur mit der Zusammenfassung als Stichpunkte, ohne Einleitung.'
].join('\n');

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(m) {
  let n = estimateTokens(m.content) + 4;
  if (m.toolCalls && m.toolCalls.length) n += estimateTokens(JSON.stringify(m.toolCalls.map((tc) => tc.arguments || {})));
  if (m.compactedSummary) n += estimateTokens(m.compactedSummary);
  return n;
}

function summaryIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].compactedSummary) return i;
  }
  return -1;
}

function modelView(messages) {
  const k = summaryIndex(messages);
  if (k === -1) return messages;
  return [
    {
      role: 'user',
      compaction: true,
      content:
        '[Automatische Zusammenfassung des älteren Verlaufs — die Nachrichten davor wurden komprimiert, um Kontext zu sparen]\n' +
        messages[k].compactedSummary
    },
    ...messages.slice(k)
  ];
}

function transcriptForSummary(view, maxChars) {
  const lines = [];
  for (const m of view) {
    if (m.role === 'user') lines.push(`${m.compaction ? 'FRÜHERE ZUSAMMENFASSUNG' : 'NUTZER'}:\n${m.content || ''}`);
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`AGENT:\n${m.content}`);
      for (const tc of m.toolCalls || []) {
        const args = { ...(tc.arguments || {}) };
        for (const key of ['content', 'file_content', 'new_str', 'old_str', 'mcp_code']) {
          if (typeof args[key] === 'string' && args[key].length > 300) args[key] = `${args[key].slice(0, 300)}… (${args[key].length} Zeichen)`;
        }
        lines.push(`AGENT RUFT TOOL: ${tc.name}(${JSON.stringify(args)})`);
      }
    } else if (m.role === 'tool') {
      const text = String(m.content || '');
      lines.push(`TOOL-ERGEBNIS ${m.name}:\n${text.length > 1500 ? `${text.slice(0, 1500)}… (${text.length} Zeichen)` : text}`);
    }
  }
  let text = lines.join('\n\n');
  if (text.length > maxChars) text = `[... Anfang gekürzt ...]\n${text.slice(text.length - maxChars)}`;
  return text;
}

function mechanicalSummary(view) {
  const lines = [];
  for (const m of view) {
    if (m.role === 'user') lines.push(`- ${m.compaction ? 'Frühere Zusammenfassung' : 'Nutzer'}: ${String(m.content || '').slice(0, 600)}`);
    else if (m.role === 'assistant') {
      for (const tc of m.toolCalls || []) {
        const a = tc.arguments || {};
        lines.push(`- Tool ${tc.name}${a.path ? ` (${a.path})` : a.command ? ` (${String(a.command).slice(0, 120)})` : ''}`);
      }
      if (m.content) lines.push(`- Agent: ${String(m.content).slice(0, 300)}`);
    }
  }
  return lines.slice(-120).join('\n');
}

async function compactMessages({ messages, connection, model, samplingSettings, contextWindow, signal, onEvent, force }) {
  const startIdx = Math.max(0, summaryIndex(messages));
  const keepBudget = Math.max(512, Math.floor(contextWindow * KEEP_RECENT_SHARE));
  let acc = 0;
  let cut = messages.length - 1;
  for (let i = messages.length - 1; i > startIdx; i--) {
    acc += estimateMessageTokens(messages[i]);
    if (acc > keepBudget) break;
    cut = i;
  }
  while (cut > startIdx && messages[cut].role === 'tool') cut--;
  if (cut - startIdx < (force ? 1 : 2)) return false;

  const view = modelView(messages.slice(0, cut));
  const before = view.reduce((n, m) => n + estimateMessageTokens(m), 0);
  onEvent({ type: 'compacting', messages: view.length, tokens: before });

  let summary = '';
  try {
    const maxChars = Math.floor(contextWindow * 0.55 * CHARS_PER_TOKEN);
    const response = await chat(connection, {
      model,
      systemPrompt: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Fasse diesen Verlauf zusammen:\n\n${transcriptForSummary(view, maxChars)}` }],
      tools: [],
      reasoningEffort: 'off',
      sampling: { ...(samplingSettings || {}), maxTokens: Math.min(4096, Math.max(1024, Math.floor(contextWindow * 0.15))), stopSequences: undefined },
      signal,
      onEvent: () => {}
    });
    summary = String(response.content || '').trim();
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    onEvent({ type: 'notice', level: 'warn', message: `Zusammenfassung durch das Modell fehlgeschlagen (${err.message || err}) — nutze eine einfache Liste.` });
  }
  if (!summary) summary = mechanicalSummary(view);

  messages[cut].compactedSummary = summary;
  messages[cut].compactedAt = Date.now();
  const after = modelView(messages).reduce((n, m) => n + estimateMessageTokens(m), 0);
  onEvent({ type: 'compacted', summary, beforeTokens: before, afterTokens: after, atIndex: cut });
  return true;
}

const MAX_CONTINUATIONS = 40;
const CONTINUE_PROMPT =
  '[System] Deine letzte Antwort wurde vom Token-Limit abgeschnitten. Schreib EXAKT an der Stelle weiter, an der sie aufgehört hat — ' +
  'ohne Wiederholung, ohne Einleitung, ohne Kommentar dazu (auch mitten im Wort oder Codeblock).';

function isLengthStop(stopReason) {
  return stopReason === 'length' || stopReason === 'max_tokens' || stopReason === 'maxTokens';
}

const EMPTY_RESPONSE_NUDGE =
  '[System] Deine letzte Antwort war komplett leer. Rufe jetzt entweder das nächste passende Tool auf oder antworte dem Nutzer mit Text.';

function isAbort(err, controller) {
  return (err && err.name === 'AbortError') || (controller && controller.stopped);
}

async function runAgent({
  connection,
  model,
  task,
  folder,
  vaultPath,
  enableShellTool,
  enableBrowserTool,
  browserProfileDir,
  enableEmailTool,
  emailAccount,
  enableComfyUiTool,
  comfyUiConfig,
  enableStudioMcpTool,
  studioMcpConfig,
  reasoningEffort,
  samplingSettings,
  history,
  customSystemPrompt,
  autopilotEnabled,
  autoCompact = true,
  infiniteOutput = false,
  compactOnly = false,
  controller,
  onEvent,
  onCheckpoint
}) {
  if (!connection) throw new Error('Keine Connection ausgewählt.');
  if (!model) throw new Error('Kein Modell ausgewählt.');
  if (!folder) throw new Error('Kein Projektordner ausgewählt.');
  if (!compactOnly && (!task || !task.trim())) throw new Error('Keine Aufgabe eingegeben.');

  const historyLength = (history || []).length;
  const messages = compactOnly ? [...(history || [])] : [...(history || []), { role: 'user', content: task }];
  const signal = controller && controller.signal;
  const checkpoint = () => {
    if (onCheckpoint) {
      try {
        onCheckpoint(messages);
      } catch {
      }
    }
  };

  let contextWindow =
    Number(samplingSettings && samplingSettings.contextWindow) ||
    (connection.kind === 'local-gguf'
      ? Number(samplingSettings && samplingSettings.contextSize) || DEFAULT_CONTEXT_WINDOW_LOCAL
      : DEFAULT_CONTEXT_WINDOW_API);

  if (compactOnly) {
    const done = await compactMessages({ messages, connection, model, samplingSettings, contextWindow, signal, onEvent, force: true });
    return {
      finalMessage: done ? '(Verlauf komprimiert.)' : '(Nichts zu komprimieren — der Verlauf ist noch kurz.)',
      iterations: 0,
      messages,
      compacted: done
    };
  }

  const tools = buildTools(folder, {
    vaultPath,
    enableShellTool,
    enableBrowserTool,
    browserProfileDir,
    enableEmailTool,
    emailAccount,
    enableComfyUiTool,
    comfyUiConfig,
    enableStudioMcpTool,
    studioMcpConfig,
    getMessages: () => messages,
    historyLength,
    controller,
    onEvent
  });
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const systemPrompt = systemPromptFor(folder, customSystemPrompt, {
    vaultPath,
    enableBrowserTool,
    enableEmailTool,
    enableComfyUiTool,
    enableStudioMcpTool: enableStudioMcpTool && toolMap.has('studio_mcp_list_tools'),
    autopilotEnabled
  });
  const wireTools = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(wireTools));

  let lastToolSignature = null;
  let toolRepeatCount = 0;
  let iterationLimit = skillLoaded(messages) ? SKILL_MAX_ITERATIONS : MAX_ITERATIONS;

  const stoppedResult = (i) => {
    onEvent({ type: 'stopped', iteration: i });
    return { stopped: true, iterations: i, messages };
  };

  const callModel = async (i, extraMessages = []) => {
    let firstTokenTs = null;
    let lastPreparing = 0;
    const markFirst = () => {
      if (firstTokenTs == null) firstTokenTs = Date.now();
    };
    let view = modelView(messages);
    if (iterationLimit === SKILL_MAX_ITERATIONS) view = compactOldFetches(view);
    const startTs = Date.now();
    const response = await chat(connection, {
      model,
      systemPrompt,
      messages: extraMessages.length ? [...view, ...extraMessages] : view,
      tools: wireTools,
      reasoningEffort,
      sampling: samplingSettings,
      signal,
      onEvent: (e) => {
        if (e && (e.type === 'reasoning_token' || e.type === 'gen_progress' || e.type === 'token')) markFirst();
        onEvent({ ...e, iteration: i });
      },
      onToken: (text) => {
        markFirst();
        onEvent({ type: 'token', iteration: i, text });
      },
      onReasoning: (text) => {
        markFirst();
        onEvent({ type: 'reasoning_token', iteration: i, text });
      },
      onToolCallDelta: ({ name, argumentsLength }) => {
        markFirst();
        const now = Date.now();
        if (now - lastPreparing < 200) return;
        lastPreparing = now;
        onEvent({ type: 'tool_preparing', iteration: i, name, argumentsLength });
      }
    });
    const endTs = Date.now();
    if (response.contextSize) contextWindow = Number(samplingSettings && samplingSettings.contextWindow) || response.contextSize;
    const usage = response.usage || null;
    const completionTokens = usage && (usage.completion_tokens ?? usage.output_tokens);
    const promptTokens = usage && (usage.prompt_tokens ?? usage.input_tokens);
    const genMs = firstTokenTs ? Math.max(1, endTs - firstTokenTs) : endTs - startTs;
    response.stats = {
      ms: endTs - startTs,
      ttftMs: firstTokenTs ? firstTokenTs - startTs : null,
      tokensPerSec: completionTokens ? Math.round((completionTokens / (genMs / 1000)) * 10) / 10 : null,
      completionTokens: completionTokens ?? null,
      promptTokens: promptTokens ?? null,
      totalTokens: usage ? usage.total_tokens ?? (promptTokens || 0) + (completionTokens || 0) : null
    };
    response.content = response.content || '';
    response.toolCalls = response.toolCalls || [];
    return response;
  };

  for (let i = 0; i < iterationLimit; i++) {
    if (controller && controller.stopped) return stoppedResult(i);

    if (autoCompact) {
      const estimate = fixedTokens + modelView(messages).reduce((n, m) => n + estimateMessageTokens(m), 0);
      if (estimate > contextWindow * COMPACT_TRIGGER) {
        try {
          if (await compactMessages({ messages, connection, model, samplingSettings, contextWindow, signal, onEvent })) checkpoint();
        } catch (err) {
          if (isAbort(err, controller)) return stoppedResult(i);
          onEvent({ type: 'notice', level: 'warn', message: `Auto-Compact fehlgeschlagen: ${err.message || err}` });
        }
      }
    }

    onEvent({ type: 'thinking', iteration: i });

    let response;
    try {
      try {
        response = await callModel(i);
      } catch (err) {
        if (isAbort(err, controller) || !CONTEXT_OVERFLOW_RE.test(String(err && err.message))) throw err;
        onEvent({ type: 'notice', level: 'warn', message: 'Kontext voll — komprimiere den Verlauf und versuche es nochmal...' });
        if (!(await compactMessages({ messages, connection, model, samplingSettings, contextWindow, signal, onEvent, force: true }))) throw err;
        checkpoint();
        response = await callModel(i);
      }

      if (!response.content.trim() && !response.toolCalls.length) {
        onEvent({ type: 'notice', level: 'warn', iteration: i, message: 'Leere Antwort vom Modell — frage nochmal nach...' });
        const reasoningSoFar = response.reasoning;
        response = await callModel(i, [{ role: 'user', content: EMPTY_RESPONSE_NUDGE }]);
        if (!response.reasoning && reasoningSoFar) response.reasoning = reasoningSoFar;
      }

      if (isLengthStop(response.stopReason) && !response.toolCalls.length && response.content) {
        if (infiniteOutput) {
          let combined = response.content;
          let stop = response.stopReason;
          let totalCompletion = response.stats.completionTokens || 0;
          for (let c = 0; c < MAX_CONTINUATIONS && isLengthStop(stop); c++) {
            if (controller && controller.stopped) break;
            onEvent({ type: 'continuation', iteration: i, count: c + 1 });
            const next = await callModel(i, [
              { role: 'assistant', content: combined },
              { role: 'user', content: CONTINUE_PROMPT }
            ]);
            combined += next.content;
            stop = next.stopReason;
            totalCompletion += next.stats.completionTokens || 0;
            if (next.toolCalls.length) {
              response.toolCalls = next.toolCalls;
              break;
            }
            if (!next.content) break;
          }
          response.content = combined;
          response.stopReason = stop;
          response.stats.completionTokens = totalCompletion || response.stats.completionTokens;
        } else {
          onEvent({
            type: 'notice',
            level: 'info',
            iteration: i,
            message: 'Antwort vom Token-Limit abgeschnitten. Mit „Unendlicher Output“ (Chat-Einstellungen) schreibt der Agent automatisch weiter.'
          });
        }
      }
    } catch (err) {
      if (isAbort(err, controller)) return stoppedResult(i);
      onEvent({ type: 'error', iteration: i, error: String(err.message || err) });
      err.messages = messages;
      throw err;
    }

    onEvent({ type: 'stats', iteration: i, ...response.stats });

    const reasoningText =
      response.reasoning || (response.thinking || []).map((t) => t.thinking).filter(Boolean).join('\n\n') || '';
    if (reasoningText) onEvent({ type: 'thinking_text', iteration: i, text: reasoningText });

    let emptyFailure = false;
    if (!response.content.trim() && !response.toolCalls.length) {
      emptyFailure = true;
      response.content =
        `(Das Modell hat keine Antwort geliefert${response.stopReason ? ` — Stop-Grund: ${response.stopReason}` : ''}. ` +
        (isLengthStop(response.stopReason)
          ? 'Das Token-Limit war schon beim Nachdenken erreicht: Denkaufwand senken oder „Max. Antwort-Tokens“ erhöhen.)'
          : 'Nochmal senden oder ein anderes Modell probieren.)');
      onEvent({ type: 'error', iteration: i, error: response.content });
    }

    onEvent({
      type: 'assistant_message',
      iteration: i,
      content: response.content,
      reasoning: reasoningText,
      toolCalls: response.toolCalls,
      stats: response.stats
    });

    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      thinking: response.thinking && response.thinking.length ? response.thinking : undefined,
      reasoning: reasoningText || undefined,
      reasoningField: response.reasoningField || undefined,
      stats: response.stats
    });

    if (!response.toolCalls.length) {
      checkpoint();
      return { finalMessage: response.content, iterations: i + 1, messages, emptyFailure };
    }

    for (let c = 0; c < response.toolCalls.length; c++) {
      const call = response.toolCalls[c];
      if (controller && controller.stopped) {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: '(Abgebrochen durch Nutzer, nicht ausgeführt.)' });
        continue;
      }
      const tool = toolMap.get(call.name);
      let resultText;
      let meta;
      const t0 = Date.now();
      onEvent({ type: 'tool_call', iteration: i, callId: call.id, name: call.name, arguments: call.arguments });
      if (!tool) {
        resultText = `FEHLER: Unbekanntes Tool "${call.name}". Verfügbar: ${[...toolMap.keys()].join(', ')}.`;
      } else if (call.arguments && call.arguments.__parse_error) {
        if (call.arguments.truncated) {
          resultText =
            'FEHLER: Deine Antwort wurde vom Token-Limit mitten in diesem Tool-Aufruf abgeschnitten — die Argumente sind unvollständig, ' +
            'nichts wurde ausgeführt. Schreib große Dateien in Teilen: zuerst write_file mit dem ersten Teil, danach write_file mit ' +
            'append=true für jeden weiteren Teil (jeder Teil höchstens ~150 Zeilen).';
        } else if (connection.kind === 'local-gguf') {
          resultText =
            `FEHLER: tool_arguments_json war kein gültiges JSON (${call.arguments.message}). Jedes " im Inhalt muss als \\" ` +
            'geschrieben werden, jeder Zeilenumbruch als \\n, jeder Backslash als \\\\. Beispiel für write_file mit HTML-Inhalt: ' +
            '{"path":"index.html","content":"<html>\\n  <body>Hallo \\"Welt\\"</body>\\n</html>"}. Versuch das Tool nochmal mit ' +
            'sauber escaptem JSON in tool_arguments_json auf.';
        } else {
          resultText = `FEHLER: Die Tool-Argumente waren kein gültiges JSON (${call.arguments.message}). Ruf das Tool nochmal mit gültigen Argumenten auf.`;
        }
      } else {
        try {
          const out = await tool.execute(call.arguments || {}, {
            signal,
            controller,
            onOutput: (text) => onEvent({ type: 'tool_output', iteration: i, callId: call.id, text })
          });
          if (out && typeof out === 'object') {
            resultText = String(out.text ?? '');
            meta = out.meta;
          } else {
            resultText = String(out ?? '');
          }
        } catch (err) {
          resultText = `FEHLER beim Ausführen von ${call.name}: ${err.message || err}`;
        }
        if (
          vaultPath &&
          (call.name === 'list_dir' || call.name === 'read_file') &&
          /ENOENT|existiert nicht/i.test(resultText)
        ) {
          resultText +=
            '\n\n[HINWEIS: list_dir/read_file sehen NUR deinen Arbeitsordner, NIEMALS den Obsidian-Vault — das ist ein ' +
            'komplett anderer Ordner. Kennst du den genauen Vault-Pfad schon (z.B. weil du die Notiz selbst gerade erst ' +
            'angelegt hast) — nutze obsidian_read_note mit exakt diesem Pfad. Kennst du den Pfad noch nicht — nutze ' +
            'obsidian_search_notes mit einem Stichwort. NIEMALS list_dir/read_file mit geratenen Pfaden weiter versuchen.]';
        }
      }
      const durationMs = Date.now() - t0;
      onEvent({
        type: 'tool_result',
        iteration: i,
        callId: call.id,
        name: call.name,
        result: resultText,
        meta,
        durationMs,
        isError: /^FEHLER/.test(resultText)
      });

      const signature = `${call.name}:${JSON.stringify(call.arguments || {})}`;
      if (signature === lastToolSignature) {
        toolRepeatCount++;
      } else {
        lastToolSignature = signature;
        toolRepeatCount = 1;
      }
      if (toolRepeatCount === 2) {
        resultText += '\n\n[HINWEIS: Du hast dieses Tool bereits mehrfach mit exakt denselben Argumenten aufgerufen und immer dasselbe Ergebnis bekommen — das bringt keinen Fortschritt. Antworte jetzt mit einer Zusammenfassung OHNE weiteren Tool-Aufruf, oder versuche etwas grundlegend anderes.]';
      }
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: resultText, meta, durationMs });

      if (toolRepeatCount >= 3) {
        for (const rest of response.toolCalls.slice(c + 1)) {
          messages.push({ role: 'tool', toolCallId: rest.id, name: rest.name, content: '(Nicht ausgeführt — Lauf wegen Endlosschleife abgebrochen.)' });
        }
        onEvent({ type: 'stuck_loop', iteration: i, name: call.name, count: toolRepeatCount });
        checkpoint();
        return {
          finalMessage: `(Abgebrochen: "${call.name}" wurde ${toolRepeatCount}x hintereinander mit identischen Argumenten aufgerufen, ohne Fortschritt — das Modell hängt fest.)`,
          iterations: i + 1,
          messages
        };
      }
    }
    checkpoint();
    if (iterationLimit < SKILL_MAX_ITERATIONS && skillLoaded(messages)) iterationLimit = SKILL_MAX_ITERATIONS;
  }

  onEvent({ type: 'max_iterations_reached', iterations: iterationLimit });
  return {
    finalMessage: '(Maximale Anzahl an Schritten erreicht, ohne dass der Agent fertig gemeldet hat.)',
    iterations: iterationLimit,
    messages
  };
}

module.exports = {
  runAgent,
  MAX_ITERATIONS,
  SKILL_MAX_ITERATIONS,
  systemPromptFor,
  compactOldFetches,
  skillLoaded,
  modelView,
  compactMessages,
  estimateTokens
};
