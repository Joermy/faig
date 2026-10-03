const { execSync } = require('child_process');

const MAX_OUTPUT = 20000;

function buildShellTool(root) {
  return {
    name: 'run_command',
    description:
      'Führt einen Shell-Befehl aus, startend im Projektordner (z.B. npm install, pip install -r requirements.txt). NICHT auf den ' +
        'Projektordner beschränkt — der Befehl kann mit cd/absoluten Pfaden überall auf dem Rechner lesen/schreiben. Nur verfügbar, ' +
        'wenn der Nutzer das Shell-Tool aktiviert hat.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Der auszuführende Shell-Befehl' } },
      required: ['command']
    },
    execute: async ({ command }) => {
      try {
        const output = execSync(command, {
          cwd: root,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8'
        });
        const text = output || '(kein Output)';
        return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '\n[...abgeschnitten...]' : text;
      } catch (err) {
        const out = (err.stdout || '') + (err.stderr || '');
        return `FEHLER (exit ${err.status}): ${out.slice(0, MAX_OUTPUT) || err.message}`;
      }
    }
  };
}

module.exports = { buildShellTool };
