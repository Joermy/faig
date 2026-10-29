const fs = require('fs');
const path = require('path');

const MAX_READ_BYTES = 200 * 1000;
const MAX_LIST_ENTRIES = 500;
const MAX_META_SNIPPET = 4000;

function countLines(text) {
  if (!text) return 0;
  return String(text).split('\n').length - (String(text).endsWith('\n') ? 1 : 0);
}

function snippet(text) {
  const s = String(text || '');
  return s.length > MAX_META_SNIPPET ? `${s.slice(0, MAX_META_SNIPPET)}\n…` : s;
}

function resolveSafe(root, relPath) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relPath || '.');
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (target !== rootAbs && !target.startsWith(withSep)) {
    throw new Error(
      `Pfad "${relPath}" liegt außerhalb des Projektordners (${rootAbs}). Verweigert.`
    );
  }
  if (process.platform === 'win32') {
    const bad = path.relative(rootAbs, target).split(path.sep).map((part) => /[<>:"|?*]/.exec(part) || (/[. ]$/.test(part) ? [part.slice(-1)] : null)).find(Boolean);
    if (bad) {
      throw new Error(
        `Zeichen "${bad[0]}" ist in Windows-Dateinamen nicht erlaubt (verboten: < > : " | ? * und Punkt oder Leerzeichen am Ende). ` +
          'Ersetze es, z. B. ":" durch " -".'
      );
    }
  }
  return target;
}

function buildFileTools(root) {
  return [
    {
      name: 'list_dir',
      description:
        'Listet Dateien und Unterordner eines Verzeichnisses relativ zum Projektordner auf. Nutze "." für das Wurzelverzeichnis.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relativer Pfad, z.B. "." oder "src"' },
          recursive: { type: 'boolean', description: 'Rekursiv auflisten (Standard: false)' }
        },
        required: []
      },
      execute: async ({ path: relPath, recursive }) => {
        const dir = resolveSafe(root, relPath || '.');
        const entries = [];
        const walk = (d, depth) => {
          if (entries.length >= MAX_LIST_ENTRIES) return;
          const items = fs.readdirSync(d, { withFileTypes: true });
          for (const it of items) {
            if (entries.length >= MAX_LIST_ENTRIES) break;
            const full = path.join(d, it.name);
            const rel = path.relative(root, full);
            if (it.isDirectory()) {
              entries.push(`${rel}/`);
              if (recursive && depth < 8) walk(full, depth + 1);
            } else {
              const size = fs.statSync(full).size;
              entries.push(`${rel} (${size}B)`);
            }
          }
        };
        walk(dir, 0);
        return {
          text: entries.length ? entries.join('\n') : '(leer)',
          meta: { path: relPath || '.', entries: entries.length }
        };
      }
    },
    {
      name: 'read_file',
      description:
        'Liest den Inhalt einer Textdatei relativ zum Projektordner. Bei großen Dateien optional nur einen Zeilenbereich ' +
          '(start_line/end_line, 1-basiert).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relativer Dateipfad' },
          start_line: { type: 'number', description: 'Optional: erste Zeile (1-basiert)' },
          end_line: { type: 'number', description: 'Optional: letzte Zeile (einschließlich)' }
        },
        required: ['path']
      },
      execute: async ({ path: relPath, start_line, end_line }) => {
        if (!relPath) return 'FEHLER: "path" Argument fehlt oder ist leer.';
        const file = resolveSafe(root, relPath);
        if (!fs.existsSync(file)) return `FEHLER: Datei existiert nicht: ${relPath}`;
        const stat = fs.statSync(file);
        if (stat.isDirectory()) return `FEHLER: ${relPath} ist ein Verzeichnis, keine Datei.`;
        const buf = fs.readFileSync(file);
        const full = buf.toString('utf8');
        const allLines = full.split('\n');
        const totalLines = countLines(full);
        if (start_line != null || end_line != null) {
          const from = Math.max(1, Math.floor(Number(start_line) || 1));
          const to = Math.min(totalLines, Math.floor(Number(end_line) || totalLines));
          if (from > totalLines) return `FEHLER: start_line ${from} liegt hinter dem Dateiende (${totalLines} Zeilen).`;
          return {
            text: `[${relPath}: Zeilen ${from}-${to} von ${totalLines}]\n${allLines.slice(from - 1, to).join('\n')}`,
            meta: { path: relPath, from, to, lines: totalLines }
          };
        }
        const truncated = buf.length > MAX_READ_BYTES;
        const content = buf.slice(0, MAX_READ_BYTES).toString('utf8');
        return {
          text: truncated
            ? `${content}\n\n[... abgeschnitten, Datei ist ${buf.length} Bytes groß (${totalLines} Zeilen) — den Rest mit start_line/end_line lesen ...]`
            : content,
          meta: { path: relPath, from: 1, to: truncated ? countLines(content) : totalLines, lines: totalLines, truncated }
        };
      }
    },
    {
      name: 'write_file',
      description:
        'Schreibt (überschreibt) eine Datei relativ zum Projektordner. Legt fehlende Elternordner automatisch an. Mit append=true ' +
          'wird der Inhalt ans Dateiende angehängt — so lassen sich große Dateien in mehreren Teilen schreiben. NICHT ' +
          'tool_arguments_json für Pfad/Inhalt verwenden — stattdessen die TOP-LEVEL-Felder file_path (relativer Pfad) UND ' +
          'file_content (Inhalt) zusammen setzen, beide Pflicht.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relativer Dateipfad' },
          content: { type: 'string', description: 'Vollständiger neuer Dateiinhalt (bzw. der anzuhängende Teil bei append=true)' },
          append: { type: 'boolean', description: 'An die bestehende Datei anhängen statt überschreiben (Standard: false)' }
        },
        required: ['path', 'content']
      },
      execute: async ({ path: relPath, content, append }) => {
        if (!relPath) return 'FEHLER: "path" Argument fehlt oder ist leer.';
        const file = resolveSafe(root, relPath);
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) return `FEHLER: ${relPath} ist ein Verzeichnis, keine Datei.`;
        const existed = fs.existsSync(file);
        const previous = existed ? fs.readFileSync(file, 'utf8') : '';
        const text = content ?? '';
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (append) fs.appendFileSync(file, text, 'utf8');
        else fs.writeFileSync(file, text, 'utf8');
        const bytes = Buffer.byteLength(text, 'utf8');
        const startLine = append ? countLines(previous) + 1 : 1;
        return {
          text: append
            ? `OK: ${bytes} Bytes an ${relPath} angehängt (ab Zeile ${startLine}).`
            : `OK: ${relPath} geschrieben (${bytes} Bytes, ${countLines(text)} Zeilen).`,
          meta: {
            path: relPath,
            created: !existed,
            appended: !!append,
            startLine,
            lines: countLines(text),
            previousLines: countLines(previous),
            bytes,
            preview: snippet(text)
          }
        };
      }
    },
    {
      name: 'str_replace_in_file',
      description:
        'Ersetzt einen exakten Textblock in einer bestehenden Datei durch einen neuen (wie ein gezielter Patch). old_str muss genau ' +
          'einmal in der Datei vorkommen. NICHT tool_arguments_json verwenden — stattdessen die TOP-LEVEL-Felder file_path, old_str ' +
          'und new_str zusammen setzen, alle drei Pflicht.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relativer Dateipfad' },
          old_str: { type: 'string', description: 'Exakter bestehender Text (muss eindeutig sein)' },
          new_str: { type: 'string', description: 'Ersetzungstext' }
        },
        required: ['path', 'old_str', 'new_str']
      },
      execute: async ({ path: relPath, old_str, new_str }) => {
        if (!relPath) return 'FEHLER: "path" Argument fehlt oder ist leer.';
        if (typeof old_str !== 'string' || old_str === '') {
          return 'FEHLER: old_str fehlt oder ist leer — vorher mit read_file den exakten bestehenden Text lesen.';
        }
        if (typeof new_str !== 'string') new_str = '';
        const file = resolveSafe(root, relPath);
        if (!fs.existsSync(file)) return `FEHLER: Datei existiert nicht: ${relPath}`;
        const content = fs.readFileSync(file, 'utf8');
        const count = content.split(old_str).length - 1;
        if (count === 0) return `FEHLER: old_str wurde in ${relPath} nicht gefunden.`;
        if (count > 1) return `FEHLER: old_str kommt ${count}x in ${relPath} vor, muss eindeutig sein.`;
        const idx = content.indexOf(old_str);
        const updated = content.slice(0, idx) + new_str + content.slice(idx + old_str.length);
        fs.writeFileSync(file, updated, 'utf8');
        const startLine = content.slice(0, idx).split('\n').length;
        const removed = countLines(old_str) || 1;
        const added = new_str ? countLines(new_str) || 1 : 0;
        return {
          text: `OK: ${relPath} gepatcht (Zeile ${startLine}${added > 1 ? `-${startLine + added - 1}` : ''}, -${removed} +${added}).`,
          meta: { path: relPath, startLine, removed, added, oldStr: snippet(old_str), newStr: snippet(new_str) }
        };
      }
    },
    {
      name: 'make_dir',
      description: 'Legt ein Verzeichnis (rekursiv) relativ zum Projektordner an.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relativer Pfad' } },
        required: ['path']
      },
      execute: async ({ path: relPath }) => {
        if (!relPath) return 'FEHLER: "path" Argument fehlt oder ist leer.';
        const dir = resolveSafe(root, relPath);
        fs.mkdirSync(dir, { recursive: true });
        return `OK: ${relPath} angelegt.`;
      }
    }
  ];
}

module.exports = { buildFileTools, resolveSafe };
