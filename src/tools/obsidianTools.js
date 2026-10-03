const fs = require('fs');
const path = require('path');
const { resolveSafe } = require('./fileTools');

const MAX_FILES = 20000;
const MAX_MATCHES = 60;
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

function walkMdFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= MAX_FILES || depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, 0);
  return out;
}

function noteBasename(p) {
  return path.basename(p, '.md').toLowerCase();
}

function normalizeNoteArg(note) {
  return String(note || '').replace(/\.md$/i, '').trim();
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

function extractOutlinks(content) {
  const links = new Set();
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content))) {
    links.add(m[1].trim());
  }
  return [...links];
}

function extractFrontmatterTags(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const tags = [];
  const inline = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inline) {
    inline[1].split(',').forEach((t) => {
      const v = t.trim().replace(/^["']|["']$/g, '');
      if (v) tags.push(v);
    });
  }
  const blockMatch = fm.match(/^tags:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/m);
  if (blockMatch) {
    blockMatch[1].split('\n').forEach((line) => {
      const lm = line.match(/^[ \t]*-[ \t]*(.+?)\s*$/);
      if (lm) tags.push(lm[1].trim().replace(/^["']|["']$/g, ''));
    });
  }
  return tags;
}

function extractInlineTags(content) {
  const tags = [];
  const re = /(^|\s)#([A-Za-z0-9_\-/]+)/g;
  let m;
  while ((m = re.exec(content))) {
    tags.push(m[2]);
  }
  return tags;
}

function noteTitle(content, fallback) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const titleLine = fm[1].match(/^title:\s*(.+)$/m);
    if (titleLine) return titleLine[1].trim().replace(/^["']|["']$/g, '');
  }
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return fallback;
}

const MAX_INDEX_FILES = 400;
const MAX_INDEX_CHARS = 12000;

function buildVaultIndex(root) {
  const files = walkMdFiles(root);
  const lines = [];
  let truncatedByChars = false;
  for (const file of files.slice(0, MAX_INDEX_FILES)) {
    const rel = path.relative(root, file);
    let title;
    try {
      title = noteTitle(fs.readFileSync(file, 'utf8'), noteBasename(file));
    } catch {
      title = noteBasename(file);
    }
    const line = `${rel} — ${title}`;
    if (lines.join('\n').length + line.length > MAX_INDEX_CHARS) {
      truncatedByChars = true;
      break;
    }
    lines.push(line);
  }
  const truncated = truncatedByChars || files.length > MAX_INDEX_FILES;
  return {
    text: lines.join('\n'),
    totalFiles: files.length,
    listedFiles: lines.length,
    truncated
  };
}

function buildObsidianTools(root) {
  return [
    {
      name: 'obsidian_read_note',
      description: 'Liest den kompletten Inhalt einer Notiz (.md) im Obsidian-Vault. NICHT read_file verwenden für Vault-Notizen — das sieht nur den Projektordner, nicht den Vault.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relativer Pfad im Vault, z.B. "Projekte/Mein Spiel - Roadmap.md"' } },
        required: ['path']
      },
      execute: async ({ path: relPath }) => {
        if (!relPath) return 'FEHLER: "path" Argument fehlt oder ist leer.';
        const file = resolveSafe(root, relPath);
        if (!fs.existsSync(file)) return `FEHLER: Notiz existiert nicht: ${relPath}`;
        const stat = fs.statSync(file);
        if (stat.isDirectory()) return `FEHLER: ${relPath} ist ein Verzeichnis, keine Notiz.`;
        return fs.readFileSync(file, 'utf8');
      }
    },
    {
      name: 'obsidian_write_note',
      description:
        'Erstellt oder überschreibt eine Notiz (.md) im Obsidian-Vault. Legt fehlende Elternordner automatisch an. NICHT write_file ' +
          'verwenden für Vault-Notizen — das schreibt in den Projektordner, nicht den Vault. NICHT tool_arguments_json verwenden — ' +
          'stattdessen die TOP-LEVEL-Felder file_path (relativer Pfad im Vault) UND file_content (Inhalt) zusammen setzen, beide Pflicht.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relativer Pfad im Vault, z.B. "Projekte/Mein Spiel - Roadmap.md"' },
          content: { type: 'string', description: 'Vollständiger neuer Notiz-Inhalt, inklusive YAML-Frontmatter' }
        },
        required: ['path', 'content']
      },
      execute: async ({ path: relPath, content }) => {
        if (!relPath) return 'FEHLER: "path" Argument fehlt oder ist leer.';
        const file = resolveSafe(root, relPath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content ?? '', 'utf8');
        return `OK: ${relPath} im Vault geschrieben (${Buffer.byteLength(content ?? '', 'utf8')} Bytes).`;
      }
    },
    {
      name: 'obsidian_edit_note',
      description:
        'Ersetzt einen exakten Textblock in einer bestehenden Vault-Notiz (wie str_replace_in_file, aber für den Vault statt den ' +
          'Projektordner). old_str muss genau einmal in der Notiz vorkommen. NICHT tool_arguments_json verwenden — stattdessen die ' +
          'TOP-LEVEL-Felder file_path, old_str und new_str zusammen setzen, alle drei Pflicht.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relativer Pfad im Vault' },
          old_str: { type: 'string', description: 'Exakter bestehender Text (muss eindeutig sein)' },
          new_str: { type: 'string', description: 'Ersetzungstext' }
        },
        required: ['path', 'old_str', 'new_str']
      },
      execute: async ({ path: relPath, old_str, new_str }) => {
        if (!relPath) return 'FEHLER: "path" Argument fehlt oder ist leer.';
        if (typeof new_str !== 'string') new_str = '';
        const file = resolveSafe(root, relPath);
        if (!fs.existsSync(file)) return `FEHLER: Notiz existiert nicht: ${relPath}`;
        const content = fs.readFileSync(file, 'utf8');
        const count = content.split(old_str).length - 1;
        if (count === 0) return `FEHLER: old_str wurde in ${relPath} nicht gefunden.`;
        if (count > 1) return `FEHLER: old_str kommt ${count}x in ${relPath} vor, muss eindeutig sein.`;
        fs.writeFileSync(file, content.replace(old_str, new_str), 'utf8');
        return `OK: ${relPath} im Vault gepatcht.`;
      }
    },
    {
      name: 'obsidian_search_notes',
      description:
        'Durchsucht alle .md-Notizen im Vault (Projektordner) nach einem Text (case-insensitiv) und gibt Fundstellen mit Datei, Zeilennummer und Kontext zurück.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Suchtext' } },
        required: ['query']
      },
      execute: async ({ query }) => {
        if (!query || !query.trim()) return 'FEHLER: query darf nicht leer sein.';
        const files = walkMdFiles(root);
        const needle = query.toLowerCase();
        const hits = [];
        for (const file of files) {
          if (hits.length >= MAX_MATCHES) break;
          let content;
          try {
            content = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              const rel = path.relative(root, file);
              hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
          }
        }
        if (!hits.length) return `Keine Treffer für "${query}" in ${files.length} durchsuchten Notizen.`;
        const suffix = hits.length >= MAX_MATCHES ? `\n[... bei ${MAX_MATCHES} Treffern abgeschnitten ...]` : '';
        return hits.join('\n') + suffix;
      }
    },
    {
      name: 'obsidian_list_links',
      description:
        'Zeigt für eine Notiz alle ausgehenden Wikilinks ([[...]]) UND alle anderen Notizen im Vault, die auf sie zurückverlinken (Backlinks). Nützlich bevor man eine Notiz umbenennt oder löscht.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'Notizname oder relativer Pfad, z.B. "Ideen" oder "Ordner/Ideen.md"' }
        },
        required: ['note']
      },
      execute: async ({ note }) => {
        const target = normalizeNoteArg(note);
        if (!target) return 'FEHLER: note darf nicht leer sein.';
        const files = walkMdFiles(root);
        const targetLower = path.basename(target).toLowerCase();

        let noteFile = files.find(
          (f) => path.relative(root, f).replace(/\.md$/i, '').toLowerCase() === target.toLowerCase()
        );
        if (!noteFile) noteFile = files.find((f) => noteBasename(f) === targetLower);

        let outlinks = [];
        if (noteFile) {
          try {
            outlinks = extractOutlinks(fs.readFileSync(noteFile, 'utf8'));
          } catch {
          }
        }

        const backlinks = [];
        for (const file of files) {
          if (noteFile && file === noteFile) continue;
          let content;
          try {
            content = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          const links = extractOutlinks(content);
          if (links.some((l) => l.toLowerCase() === targetLower)) {
            backlinks.push(path.relative(root, file));
          }
        }

        const lines = [];
        lines.push(
          noteFile
            ? `Notiz gefunden: ${path.relative(root, noteFile)}`
            : `Notiz "${note}" nicht im Vault gefunden (Backlinks werden trotzdem vaultweit gesucht).`
        );
        lines.push('');
        lines.push(`Ausgehende Links (${outlinks.length}):`);
        lines.push(outlinks.length ? outlinks.map((l) => `  [[${l}]]`).join('\n') : '  (keine)');
        lines.push('');
        lines.push(`Backlinks (${backlinks.length} Notizen verlinken hierher):`);
        lines.push(backlinks.length ? backlinks.map((b) => `  ${b}`).join('\n') : '  (keine)');
        return lines.join('\n');
      }
    },
    {
      name: 'obsidian_list_by_tag',
      description:
        'Findet alle Notizen mit einem bestimmten Tag — sowohl inline (#tag im Text) als auch im YAML-Frontmatter (tags: [...]).',
      parameters: {
        type: 'object',
        properties: { tag: { type: 'string', description: 'Tag ohne oder mit #, z.B. "roblox" oder "#roblox"' } },
        required: ['tag']
      },
      execute: async ({ tag }) => {
        const needle = String(tag || '')
          .replace(/^#/, '')
          .toLowerCase()
          .trim();
        if (!needle) return 'FEHLER: tag darf nicht leer sein.';
        const files = walkMdFiles(root);
        const matches = [];
        for (const file of files) {
          let content;
          try {
            content = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          const all = [...extractFrontmatterTags(content), ...extractInlineTags(content)].map((t) => t.toLowerCase());
          if (all.includes(needle)) matches.push(path.relative(root, file));
        }
        if (!matches.length) return `Keine Notizen mit Tag "#${needle}" gefunden (${files.length} Notizen durchsucht).`;
        return matches.join('\n');
      }
    }
  ];
}

module.exports = { buildObsidianTools, walkMdFiles, extractOutlinks, extractFrontmatterTags, extractInlineTags, buildVaultIndex };
