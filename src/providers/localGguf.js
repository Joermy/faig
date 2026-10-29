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

  const w = fork(path.join(__dirname, 'localGgufWorker.js'), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });
  worker = w;

  w.on('message', (msg) => {
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
      const err = new Error(msg.message);
      if (msg.aborted) err.name = 'AbortError';
      req.reject(err);
    }
  });

  const failAllPending = (err) => {
    for (const [id, req] of pending) {
      if (req.worker !== w) continue;
      clearTimeout(req.watchdog);
      pending.delete(id);
      req.reject(err);
    }
  };

  w.on('exit', (code) => {
    if (worker === w) worker = null;
    failAllPending(new Error(
      `Der lokale-Modell-Hintergrundprozess wurde unerwartet beendet (Exit-Code ${code}). Das kann bei einem echten Absturz im nativen ` +
        'Teil passieren (z.B. Out-of-Memory). Versuch es einfach nochmal — beim nächsten Senden wird automatisch ein neuer Hintergrundprozess gestartet.'
    ));
  });

  w.on('error', (err) => {
    if (worker === w) worker = null;
    failAllPending(new Error(`Der lokale-Modell-Hintergrundprozess konnte nicht gestartet werden: ${err.message || err}`));
  });

  return w;
}

let queueTail = Promise.resolve();
let queuedOrRunning = 0;

function abortError() {
  const err = new Error('Vom Nutzer gestoppt.');
  err.name = 'AbortError';
  return err;
}

async function chat({ modelsFolder, model, systemPrompt, messages, tools, onEvent, reasoningEffort, sampling, signal }) {
  if (queuedOrRunning > 0 && onEvent) {
    onEvent({ type: 'local_model_status', message: 'Wartet auf das lokale Modell — ein anderer Chat nutzt es gerade...' });
  }
  queuedOrRunning++;
  const run = queueTail.then(() => {
    if (signal && signal.aborted) throw abortError();
    const w = ensureWorker();
    const id = nextRequestId++;
    const payload = { modelsFolder, model, systemPrompt, messages, tools, reasoningEffort, sampling };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        try {
          w.send({ id, type: 'abort' });
        } catch {
        }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const done = (fn) => (value) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      pending.set(id, { resolve: done(resolve), reject: done(reject), onEvent, worker: w });
      armWatchdog(id);
      w.send({ id, type: 'chat', payload });
    });
  });
  queueTail = run.catch(() => {}).finally(() => {
    queuedOrRunning--;
  });
  return run;
}

async function listModels({ modelsFolder }) {
  return engine.listGgufFiles(modelsFolder);
}

async function recommendSettings({ modelsFolder, model }) {
  const modelPath = engine.resolveModel(modelsFolder, model);
  const w = ensureWorker();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent: null, worker: w });
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
