const engine = require('./localGgufEngine');
const optimizer = require('./localGgufOptimizer');

const abortControllers = new Map();

process.on('message', async (msg) => {
  if (!msg) return;
  const { id, type, payload } = msg;
  if (type === 'abort') {
    const ctrl = abortControllers.get(id);
    if (ctrl) ctrl.abort();
    return;
  }
  if (type === 'chat') {
    const ctrl = new AbortController();
    abortControllers.set(id, ctrl);
    try {
      const result = await engine.chat({
        ...payload,
        signal: ctrl.signal,
        onEvent: (event) => {
          try {
            process.send({ id, type: 'event', event });
          } catch {
          }
        }
      });
      process.send({ id, type: 'result', result });
    } catch (err) {
      process.send({ id, type: 'error', message: String(err && err.message ? err.message : err), aborted: ctrl.signal.aborted });
    } finally {
      abortControllers.delete(id);
    }
  } else if (type === 'recommend') {
    try {
      const llama = await engine.getLlamaSingleton();
      const result = await optimizer.recommendSettings(payload.modelPath, llama);
      process.send({ id, type: 'result', result });
    } catch (err) {
      process.send({ id, type: 'error', message: String(err && err.message ? err.message : err) });
    }
  }
});
