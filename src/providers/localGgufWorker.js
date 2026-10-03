const engine = require('./localGgufEngine');
const optimizer = require('./localGgufOptimizer');

process.on('message', async (msg) => {
  if (!msg) return;
  const { id, type, payload } = msg;
  if (type === 'chat') {
    try {
      const result = await engine.chat({
        ...payload,
        onEvent: (event) => {
          try {
            process.send({ id, type: 'event', event });
          } catch {
          }
        }
      });
      process.send({ id, type: 'result', result });
    } catch (err) {
      process.send({ id, type: 'error', message: String(err && err.message ? err.message : err) });
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
