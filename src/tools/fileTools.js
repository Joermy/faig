const fs = require('fs');
const path = require('path');

const MAX_READ_BYTES = 200 * 1000;
const MAX_LIST_ENTRIES = 500;

function resolveSafe(root, relPath) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relPath || '.');
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (target !== rootAbs && !target.startsWith(withSep)) {
    throw new Error(
      `Pfad "${relPath}" liegt außerhalb des Projektordners (${rootAbs}). Verweigert.`
    );
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
        return entries.length ? entries.join('\n') : '(leer)';
      }
    },
    {
      name: 'read_file',
      description: 'Liest den Inhalt einer Textdatei relativ zum Projektordner.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relativer Dateipfad' } },
        required: ['path']
      },
      execute: async ({ path: relPath }) => {
        const file = resolveSafe(root, relPath);
        if (!fs.existsSync(file)) return `FEHLER: Datei existiert nicht: ${relPath}`;
        const stat = fs.statSync(file);
        if (stat.isDirectory()) return `FEHLER: ${relPath} ist ein Verzeichnis, keine Datei.`;
        const buf = fs.readFileSync(file);
        const truncated = buf.length > MAX_READ_BYTES;
        const content = buf.slice(0, MAX_READ_BYTES).toString('utf8');
        return truncated
          ? `${content}\n\n[... abgeschnitten, Datei ist ${buf.length} Bytes groß ...]`
          : content;
      }
    },
    {
      name: 'write_file',
      description:
        'Schreibt (überschreibt) eine Datei relativ zum Projektordner. Legt fehlende Elternordner automatisch an. NICHT ' +
          'tool_arguments_json verwenden — stattdessen die TOP-LEVEL-Felder file_path (relativer Pfad) UND file_content (Inhalt) ' +
          'zusammen setzen, beide Pflicht.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relativer Dateipfad' },
          content: { type: 'string', description: 'Vollständiger neuer Dateiinhalt' }
        },
        required: ['path', 'content']
      },
      execute: async ({ path: relPath, content }) => {
        if (!relPath) return 'FEHLER: "path" Argument fehlt oder ist leer.';
        const file = resolveSafe(root, relPath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content ?? '', 'utf8');
        return `OK: ${relPath} geschrieben (${Buffer.byteLength(content ?? '', 'utf8')} Bytes).`;
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
        if (typeof new_str !== 'string') new_str = '';
        const file = resolveSafe(root, relPath);
        if (!fs.existsSync(file)) return `FEHLER: Datei existiert nicht: ${relPath}`;
        const content = fs.readFileSync(file, 'utf8');
        const count = content.split(old_str).length - 1;
        if (count === 0) return `FEHLER: old_str wurde in ${relPath} nicht gefunden.`;
        if (count > 1) return `FEHLER: old_str kommt ${count}x in ${relPath} vor, muss eindeutig sein.`;
        const updated = content.replace(old_str, new_str);
        fs.writeFileSync(file, updated, 'utf8');
        return `OK: ${relPath} gepatcht.`;
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
