const openaiCompatible = require('./openaiCompatible');
const anthropic = require('./anthropic');
const localGguf = require('./localGguf');

const ADAPTERS = {
  'openai-compatible': openaiCompatible,
  anthropic,
  'local-gguf': localGguf
};

function getAdapter(kind) {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`Unbekannter Connection-Typ: ${kind}`);
  return adapter;
}

async function chat(connection, args) {
  const adapter = getAdapter(connection.kind);
  return adapter.chat({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    modelsFolder: connection.modelsFolder,
    ...args
  });
}

async function listModels(connection) {
  const adapter = getAdapter(connection.kind);
  return adapter.listModels({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    modelsFolder: connection.modelsFolder
  });
}

module.exports = { chat, listModels, ADAPTERS };
