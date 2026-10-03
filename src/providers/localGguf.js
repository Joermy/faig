const path = require('path');
const { fork } = require('child_process');
const engine = require('./localGgufEngine');

let worker = null;
let nextRequestId = 1;
const pending = new Map();

const HANG_TIMEOUT_MS = 5 * 60 * 1000;

function armWatchdog(id) {
  const req = pending.get(id);
  if (!req) return;
  clearTimeout(req.watchdog);
  req.watchdog = setTimeout(() => {
    pending.delete(id);
    req.reject(new Error(
      'Der lokale-Modell-Hintergrundprozess hat seit mehreren Minuten kein Lebenszeichen mehr gesendet (vermutlich hängt der native ' +
        'Aufruf fest, z.B. GPU-Treiber-Stall). Prozess wird neu gestartet — einfach nochmal senden.'
    ));
    if (worker) {
      worker.kill();
      worker = null;
    }
  }, HANG_TIMEOUT_MS);
}

function ensureWorker() {
  if (worker) return worker;

  worker = fork(path.join(__dirname, 'localGgufWorker.js'), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });

  worker.on('message', (msg) => {
    const req = pending.get(msg.id);
    if (!req) return;
    armWatchdog(msg.id);
    if (msg.type === 'event') {
      if (req.onEvent) {
        try {
          req.onEvent(msg.event);
        } catch {
        }
      }
    } else if (msg.type === 'result') {
      clearTimeout(req.watchdog);
      pending.delete(msg.id);
      req.resolve(msg.result);
    } else if (msg.type === 'error') {
      clearTimeout(req.watchdog);
      pending.delete(msg.id);
      req.reject(new Error(msg.message));
    }
  });

  const failAllPending = (err) => {
    for (const [id, req] of pending) {
      clearTimeout(req.watchdog);
      pending.delete(id);
      req.reject(err);
    }
  };

  worker.on('exit', (code) => {
    worker = null;
    failAllPending(new Error(
      `Der lokale-Modell-Hintergrundprozess wurde unerwartet beendet (Exit-Code ${code}). Das kann bei einem echten Absturz im nativen ` +
        'Teil passieren (z.B. Out-of-Memory). Versuch es einfach nochmal — beim nächsten Senden wird automatisch ein neuer Hintergrundprozess gestartet.'
    ));
  });

  worker.on('error', (err) => {
    worker = null;
    failAllPending(new Error(`Der lokale-Modell-Hintergrundprozess konnte nicht gestartet werden: ${err.message || err}`));
  });

  return worker;
}

async function chat({ modelsFolder, model, systemPrompt, messages, tools, onEvent, reasoningEffort, sampling }) {
  const w = ensureWorker();
  const id = nextRequestId++;
  const payload = { modelsFolder, model, systemPrompt, messages, tools, reasoningEffort, sampling };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent });
    armWatchdog(id);
    w.send({ id, type: 'chat', payload });
  });
}

async function listModels({ modelsFolder }) {
  return engine.listGgufFiles(modelsFolder);
}

async function recommendSettings({ modelsFolder, model }) {
  const modelPath = path.join(modelsFolder, model);
  const w = ensureWorker();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent: null });
    armWatchdog(id);
    w.send({ id, type: 'recommend', payload: { modelPath } });
  });
}

function disposeWorker() {
  if (worker) {
    worker.kill();
    worker = null;
  }
}

module.exports = { chat, listModels, recommendSettings, disposeWorker };
