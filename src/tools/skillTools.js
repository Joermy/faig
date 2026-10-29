const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const MAX_SKILL_FILE_CHARS = 60000;
const MAX_DESCRIPTION_CHARS = 400;
const READABLE_EXT = new Set(['.md', '.txt', '.py', '.js', '.json', '.yaml', '.yml', '.csv']);

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function listSkills(dir = SKILLS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    try {
      const meta = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      skills.push({
        name: meta.name || entry.name,
        folder: entry.name,
        description: (meta.description || '').slice(0, MAX_DESCRIPTION_CHARS)
      });
    } catch {
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function readSkillFile(name, file, dir = SKILLS_DIR) {
  const skill = listSkills(dir).find((s) => s.name === name || s.folder === name);
  if (!skill) {
    const names = listSkills(dir).map((s) => s.name).join(', ') || '(keine)';
    return `FEHLER: Skill "${name}" nicht gefunden. Vorhanden: ${names}`;
  }
  const root = path.join(dir, skill.folder);
  const rel = String(file || 'SKILL.md').replace(/\\/g, '/');
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return 'FEHLER: file muss innerhalb des Skill-Ordners liegen (kein "..").';
  }
  if (!READABLE_EXT.has(path.extname(target).toLowerCase())) {
    return `FEHLER: Nur Textdateien lesbar (${[...READABLE_EXT].join(', ')}).`;
  }
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    let listing = '';
    try {
      listing = fs.readdirSync(root, { recursive: true }).join(', ');
    } catch {}
    return `FEHLER: ${rel} gibt es im Skill "${skill.name}" nicht. Dateien: ${listing}`;
  }
  if (text.length > MAX_SKILL_FILE_CHARS) text = text.slice(0, MAX_SKILL_FILE_CHARS) + '\n[... gekürzt ...]';
  return `Skill-Ordner (für Skript-Befehle als <skill dir>): ${root}\nDatei: ${rel}\n\n${text}`;
}

function buildSkillTools(dir = SKILLS_DIR) {
  return [
    {
      name: 'skill_read',
      description:
        'Liest einen installierten Skill (Anleitung für eine bestimmte Art Aufgabe) oder eine Datei daraus. Ohne "file" kommt die ' +
        'SKILL.md, die du ZUERST lesen musst. Weitere Dateien (z.B. "references/x.md", "templates/y.md") nur laden, wenn die ' +
        'SKILL.md es sagt. Nur lesen, nichts ausführen.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name des Skills, z.B. "tiefenrecherche"' },
          file: { type: 'string', description: 'Pfad im Skill-Ordner, Standard "SKILL.md"' }
        },
        required: ['name']
      },
      execute: async ({ name, file }) => readSkillFile(String(name || '').trim(), file, dir)
    }
  ];
}

module.exports = { buildSkillTools, listSkills, readSkillFile, SKILLS_DIR };
