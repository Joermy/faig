const { spawn } = require('child_process');

const MAX_OUTPUT = 20000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
    }
  }
}

function runCommand(command, { cwd, timeoutMs, signal, onOutput }) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], {
          cwd,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      : spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let pendingChunk = '';
    let lastFlush = 0;
    let finished = false;
    const flush = (force) => {
      if (!onOutput || !pendingChunk) return;
      const now = Date.now();
      if (!force && now - lastFlush < 200) return;
      lastFlush = now;
      onOutput(pendingChunk);
      pendingChunk = '';
    };
    const onData = (buf) => {
      const text = buf.toString('utf8');
      if (output.length < MAX_OUTPUT * 2) output += text;
      pendingChunk += text;
      flush(false);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      flush(true);
      resolve({ ...result, output });
    };
    const onAbort = () => {
      killTree(child);
      finish({ code: null, aborted: true });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => finish({ code: null, error: err }));
    child.on('close', (code) => finish({ code }));
  });
}

function trimOutput(text) {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT / 2)}\n[...gekürzt...]\n${text.slice(-MAX_OUTPUT / 2)}` : text;
}

function buildShellTool(root) {
  return {
    name: 'run_command',
    description:
      'Führt einen Shell-Befehl aus, startend im Projektordner (z.B. npm install, pip install -r requirements.txt). NICHT auf den ' +
        'Projektordner beschränkt — der Befehl kann mit cd/absoluten Pfaden überall auf dem Rechner lesen/schreiben. Nur verfügbar, ' +
        'wenn der Nutzer das Shell-Tool aktiviert hat. Interaktive Befehle (die auf eine Eingabe warten) hängen bis zum Timeout — ' +
        'immer mit nicht-interaktiven Flags aufrufen (z.B. -y, --yes).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Der auszuführende Shell-Befehl' },
        timeout_seconds: { type: 'number', description: 'Optional: Zeitlimit in Sekunden (Standard 600, max 3600)' }
      },
      required: ['command']
    },
    execute: async ({ command, timeout_seconds }, { signal, onOutput } = {}) => {
      if (!command || !String(command).trim()) return 'FEHLER: "command" fehlt oder ist leer.';
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(timeout_seconds) * 1000 || DEFAULT_TIMEOUT_MS));
      const t0 = Date.now();
      const res = await runCommand(String(command), { cwd: root, timeoutMs, signal, onOutput });
      const durationMs = Date.now() - t0;
      const out = trimOutput(res.output || '');
      const meta = { command: String(command), exitCode: res.code, durationMs, timedOut: !!res.timedOut, aborted: !!res.aborted };
      if (res.error) return { text: `FEHLER: Befehl konnte nicht gestartet werden: ${res.error.message || res.error}`, meta };
      if (res.aborted) return { text: `FEHLER: Vom Nutzer abgebrochen.\n${out}`, meta };
      if (res.timedOut) return { text: `FEHLER: Zeitlimit (${Math.round(timeoutMs / 1000)}s) überschritten, Befehl abgebrochen.\n${out}`, meta };
      if (res.code !== 0) return { text: `FEHLER (exit ${res.code}): ${out || '(kein Output)'}`, meta };
      return { text: out || '(kein Output)', meta };
    }
  };
}

module.exports = { buildShellTool, runCommand };
