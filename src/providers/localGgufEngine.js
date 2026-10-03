const fs = require('fs');
const path = require('path');
const { getSystemSpecs } = require('../systemSpecs');
const optimizer = require('./localGgufOptimizer');

let llamaSingleton = null;
let modelCache = null;
let loadingPromise = null;
let recommendCache = null;

let libPromise = null;
function loadLib() {
  if (!libPromise) {
    libPromise = import('node-llama-cpp').catch((err) => {
      libPromise = null;
      throw new Error(
        'node-llama-cpp ist nicht installiert oder konnte nicht geladen werden. ' +
          'Führe im Projektordner "npm install" aus (lädt u.a. node-llama-cpp mit seinen ' +
          'nativen Binaries), starte die App danach neu. Original-Fehler: ' +
          (err && err.message ? err.message : err)
      );
    });
  }
  return libPromise;
}

async function getLlamaSingleton() {
  if (llamaSingleton) return llamaSingleton;
  const { getLlama } = await loadLib();
  llamaSingleton = await getLlama();
  return llamaSingleton;
}

async function getOrLoadModel(modelPath, gpuLayers, onEvent) {
  if (modelCache && modelCache.modelPath === modelPath && modelCache.gpuLayers === gpuLayers) return modelCache.model;

  if (loadingPromise) {
    await loadingPromise;
    return getOrLoadModel(modelPath, gpuLayers, onEvent);
  }
  let resolveLoading;
  loadingPromise = new Promise((resolve) => { resolveLoading = resolve; });

  try {
    return await loadModelExclusive(modelPath, gpuLayers, onEvent);
  } finally {
    loadingPromise = null;
    resolveLoading();
  }
}

async function loadModelExclusive(modelPath, gpuLayers, onEvent) {
  if (modelCache) {
    if (onEvent) onEvent({ type: 'local_model_status', message: 'Entlade vorheriges lokales Modell...' });
    try {
      await modelCache.model.dispose();
    } catch {
    }
    modelCache = null;
  }

  const fileSizeBytes = fs.statSync(modelPath).size;
  if (onEvent) {
    onEvent({
      type: 'local_model_status',
      message: `Lade ${path.basename(modelPath)} von der Platte — beim ersten Mal kann das je nach Größe 1-2+ Minuten dauern...`
    });
    let specs = null;
    try {
      specs = await getSystemSpecs();
    } catch {
    }
    onEvent({ type: 'model_load_start', modelName: path.basename(modelPath), fileSizeBytes, specs });
  }
  const llama = await getLlamaSingleton();
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: gpuLayers ?? 'auto',
    onLoadProgress: onEvent ? (loadProgress) => onEvent({ type: 'model_load_progress', progress: loadProgress }) : undefined
  });
  modelCache = { modelPath, gpuLayers, model };
  if (onEvent) {
    onEvent({ type: 'model_load_progress', progress: 1 });
    onEvent({ type: 'local_model_status', message: 'Modell geladen, generiere Antwort...' });
  }
  return model;
}

function listGgufFiles(modelsFolder) {
  if (!modelsFolder || !fs.existsSync(modelsFolder)) return [];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        out.push(path.relative(modelsFolder, full));
      }
    }
  };
  walk(modelsFolder, 0);
  return out.sort();
}

function buildTranscript(messages) {
  const answeredToolCallIds = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId));

  const lines = [];
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`AUFGABE / NEUE INFORMATION VOM NUTZER:\n${m.content}`);
    } else if (m.role === 'assistant') {
      if (m.content) lines.push(`DEIN VORHERIGER GEDANKE:\n${m.content}`);
      for (const tc of m.toolCalls || []) {
        const unanswered = !answeredToolCallIds.has(tc.id);
        lines.push(
          `DEIN VORHERIGER TOOL-AUFRUF: ${tc.name}(${JSON.stringify(tc.arguments)})` +
            (unanswered ? ' → KEIN ERGEBNIS ERHALTEN (Lauf wurde unterbrochen, bevor das Tool fertig war — ignoriere diesen Aufruf, er ist erledigt/veraltet).' : '')
        );
      }
    } else if (m.role === 'tool') {
      lines.push(`TOOL-ERGEBNIS von "${m.name}":\n${m.content}`);
    }
  }
  return lines.join('\n\n');
}

const TOP_LEVEL_FIELD_TOOLS = new Set(['write_file', 'obsidian_write_note', 'str_replace_in_file', 'obsidian_edit_note']);

function exampleValueForProperty(prop) {
  if (prop && Array.isArray(prop.enum) && prop.enum.length) return prop.enum[0];
  if (!prop || prop.type === 'string') return '...';
  if (prop.type === 'boolean') return false;
  if (prop.type === 'number' || prop.type === 'integer') return 0;
  if (prop.type === 'array') return [];
  return null;
}
function exampleArgsFor(parameters) {
  if (!parameters || !parameters.properties) return {};
  const example = {};
  for (const [key, prop] of Object.entries(parameters.properties)) {
    example[key] = exampleValueForProperty(prop);
  }
  return example;
}

function toolsDescriptionText(tools) {
  if (!tools || !tools.length) return '(keine Tools verfügbar)';
  return tools
    .map((t) => {
      if (TOP_LEVEL_FIELD_TOOLS.has(t.name)) {
        return `- ${t.name}: ${t.description}`;
      }
      return `- ${t.name}: ${t.description}\n  Beispiel: tool_arguments_json = ${JSON.stringify(exampleArgsFor(t.parameters))}`;
    })
    .join('\n');
}

const REASONING_PROFILES = {
  off: { maxTokens: 1024, instruction: 'Halte thought SO KURZ WIE MÖGLICH (max. 1 kurzer Satz oder leer) — keine ausführliche Herleitung, keine Zwischenschritte.' },
  low: { maxTokens: 2048, instruction: 'Halte thought kurz (1-2 Sätze).' },
  medium: { maxTokens: 4096, instruction: 'thought darf ein paar Sätze lang sein, wenn es dem Ergebnis hilft.' },
  high: { maxTokens: 8192, instruction: 'Denke in thought gründlich in mehreren Schritten nach, bevor du dich festlegst.' },
  xhigh: { maxTokens: 16384, instruction: 'Denke in thought SEHR gründlich nach: wäge mehrere Optionen ab, geh Schritt für Schritt vor, bevor du dich festlegst.' }
};

function stripThinkTags(s) {
  return typeof s === 'string' ? s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : s;
}

async function chat({ modelsFolder, model, systemPrompt, messages, tools, onEvent, reasoningEffort, sampling }) {
  if (!modelsFolder) throw new Error('Für diese Connection ist kein Modell-Ordner konfiguriert.');
  const modelPath = path.join(modelsFolder, model);
  if (!fs.existsSync(modelPath)) throw new Error(`Modell-Datei nicht gefunden: ${modelPath}`);

  const { LlamaChatSession } = await loadLib();
  const llama = await getLlamaSingleton();

  let effectiveSampling = sampling || {};
  if (effectiveSampling.gpuLayers == null || effectiveSampling.contextSize == null) {
    try {
      if (!recommendCache || recommendCache.modelPath !== modelPath) {
        recommendCache = { modelPath, result: await optimizer.recommendSettings(modelPath, llama) };
      }
      const rec = recommendCache.result;
      effectiveSampling = {
        ...effectiveSampling,
        gpuLayers: effectiveSampling.gpuLayers ?? rec.gpuLayers,
        contextSize: effectiveSampling.contextSize ?? rec.contextSize
      };
    } catch {
    }
  }

  const llmModel = await getOrLoadModel(modelPath, effectiveSampling.gpuLayers, onEvent);

  const toolNames = (tools || []).map((t) => t.name);
  const schema = {
    type: 'object',
    properties: {
      thought: { type: 'string' },
      is_final: { type: 'boolean' },
      final_message: { type: 'string' },
      tool_name: { type: 'string', enum: toolNames.length ? toolNames : ['']},
      tool_arguments_json: { type: 'string' },
      file_content: { type: 'string' },
      file_path: { type: 'string' },
      old_str: { type: 'string' },
      new_str: { type: 'string' },
      mcp_code: { type: 'string' }
    },
    required: ['thought', 'is_final']
  };
  const grammar = await llama.createGrammarForJsonSchema(schema);
  const profile = REASONING_PROFILES[reasoningEffort] || REASONING_PROFILES.medium;

  const fullSystemPrompt = [
    systemPrompt,
    '',
    'ANTWORTFORMAT: Du antwortest AUSSCHLIESSLICH als JSON-Objekt mit den Feldern thought (kurzer Gedanke) und is_final (true/false).',
    'Wenn die Aufgabe fertig ist: is_final=true und final_message=kurze Zusammenfassung für den Nutzer.',
    'Wenn du ein Tool aufrufen willst: is_final=false, tool_name=exakter Toolname aus der Liste unten, tool_arguments_json=ein JSON-String (!) mit den Argumenten für dieses Tool.',
    'WICHTIG bei write_file und obsidian_write_note: NICHT tool_arguments_json verwenden. Stattdessen ZWEI TOP-LEVEL-Felder zusammen ' +
      'setzen: file_path = der relative Pfad (z.B. "src/server/x.lua"), UND file_content = der komplette Inhalt. Beide sind Pflicht, ' +
      'beide gehören zusammen — ohne file_path schlägt der Aufruf fehl, selbst wenn file_content korrekt gesetzt ist.',
    'WICHTIG bei str_replace_in_file und obsidian_edit_note: ebenfalls NICHT tool_arguments_json verwenden. Stattdessen DREI ' +
      'TOP-LEVEL-Felder zusammen setzen: file_path (relativer Pfad), old_str (exakter bestehender Text) und new_str ' +
      '(Ersetzungstext). Alle drei sind Pflicht.',
    'Grund für file_path/file_content/old_str/new_str als eigene Felder statt in tool_arguments_json: Code/Text enthält fast immer ' +
      'Anführungszeichen (z.B. game:GetService("Workspace")), die in tool_arguments_json (ein JSON-String IN einem JSON-String) ' +
      'doppelt escaped werden müssten — das geht fast immer schief. Die genannten Felder sind normale Top-Level-Felder, technisch ' +
      'garantiert korrekt, egal was drinsteht.',
    profile.instruction,
    '',
    'Verfügbare Tools:',
    toolsDescriptionText(tools)
  ].join('\n');

  let context;
  try {
    const contextOptions = {
      contextSize: effectiveSampling.contextSize || 'auto',
      flashAttention: effectiveSampling.flashAttention || 'auto'
    };
    if (effectiveSampling.threads != null) contextOptions.threads = effectiveSampling.threads;
    if (effectiveSampling.batchSize != null) contextOptions.batchSize = effectiveSampling.batchSize;
    context = await llmModel.createContext(contextOptions);
  } catch (err) {
    const freeGb = (require('os').freemem() / 1024 ** 3).toFixed(1);
    throw new Error(
      `Konnte für "${model}" keinen Kontext (KV-Cache) im VRAM anlegen. Das ist fast immer zu wenig FREIER Grafikspeicher in diesem ` +
        'Moment, nicht ein Fehler in FAIG selbst — z.B. weil parallel ComfyUI (oder ein anderes GPU-Programm) gerade ein Modell geladen ' +
        `hat. Aktuell nur noch ${freeGb} GB freier System-RAM, was zusätzlich zur Enge beiträgt. Abhilfe: ComfyUI/andere GPU-Programme ` +
        'schließen (oder deren Modell entladen) und danach hier "Modelle laden" erneut versuchen, ein kleiner quantisiertes/kleineres ' +
        `Modell wählen, oder in der Connection einen Ordner mit weniger anspruchsvollen .gguf-Dateien angeben. Original-Fehler: ${err.message || err}`
    );
  }

  const grantedContextSize = context.contextSize;
  if (grantedContextSize < 1024) {
    try {
      await context.dispose();
    } catch {
    }
    throw new Error(
      `Nur ${grantedContextSize} Tokens Kontext bekommen (viel zu wenig — allein System-Prompt + Tool-Liste brauchen meist mehr) — ` +
        'node-llama-cpp musste wegen knappem VRAM automatisch auf diesen Notfall-Wert runtergehen, das erklärt kaputte/"data not found"-' +
        'artige Antworten. Abhilfe: ComfyUI/andere GPU-Programme schließen, oder in "Modell-Einstellungen (erweitert)" eine feste, ' +
        'kleinere "Kontext-Größe" (z.B. 4096) UND ein niedrigeres "GPU-Layer" (z.B. 15-20 statt auto) setzen, damit weniger VRAM pro ' +
        'Ladevorgang gebraucht wird.'
    );
  }
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: fullSystemPrompt
    });
    const transcript = buildTranscript(messages);
    const promptOptions = {
      grammar,
      maxTokens: (sampling && sampling.maxTokens) || profile.maxTokens,
      temperature: (sampling && sampling.temperature) ?? 0.2,
      onTextChunk: onEvent ? (text) => onEvent({ type: 'token', text }) : undefined,
      repeatPenalty: { penalty: 1.1, lastTokens: 64 }
    };
    if (sampling) {
      if (sampling.topK != null) promptOptions.topK = sampling.topK;
      if (sampling.topP != null) promptOptions.topP = sampling.topP;
      if (sampling.minP != null) promptOptions.minP = sampling.minP;
      if (sampling.seed != null) promptOptions.seed = sampling.seed;
      if (sampling.repeatPenalty != null || sampling.repeatLastN != null) {
        promptOptions.repeatPenalty = {
          penalty: sampling.repeatPenalty ?? 1.1,
          lastTokens: sampling.repeatLastN ?? 64
        };
      }
      if (sampling.stopSequences && sampling.stopSequences.length) {
        promptOptions.customStopTriggers = sampling.stopSequences;
      }
    }
    const raw = await session.prompt(transcript, promptOptions);
    let parsed;
    try {
      parsed = grammar.parse(raw);
    } catch (err) {
      if (raw.length < 20) {
        throw new Error(
          `Modell hat unter der Grammar-Einschränkung (Tool-Call-JSON-Format) so gut wie nichts generiert (${raw.length} Zeichen). ` +
            'Das ist normalerweise KEIN Tokens-Limit-Problem, sondern eine Inkompatibilität zwischen node-llama-cpp\'s ' +
            'Grammar-Constrained-Sampling und dieser Modell-Architektur (z.B. bei sehr neuen MoE-Modellen beobachtet). ' +
            'Anderes Modell probieren, oder node-llama-cpp aktualisieren.'
        );
      }
      throw new Error(
        `Modell-Antwort wurde nicht als vollständiges JSON abgeschlossen (wahrscheinlich "Max. Antwort-Tokens" zu knapp für ` +
          `diese Antwort, aktuell ${promptOptions.maxTokens}). Erhöhe den Wert in "Modell-Einstellungen (erweitert)". ` +
          `Original-Fehler: ${err.message || err}`
      );
    }
    parsed.thought = stripThinkTags(parsed.thought);
    parsed.final_message = stripThinkTags(parsed.final_message);

    let usage = null;
    try {
      if (typeof llmModel.tokenize === 'function') {
        const promptTokens = llmModel.tokenize(transcript).length;
        const completionTokens = llmModel.tokenize(raw).length;
        usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens
        };
      }
    } catch {
    }

    if (parsed.is_final) {
      return { content: parsed.final_message || parsed.thought || '', toolCalls: [], stopReason: 'stop', usage };
    }

    let args = {};
    if (parsed.tool_arguments_json) {
      try {
        args = JSON.parse(parsed.tool_arguments_json);
      } catch (err) {
        args = { __parse_error: true, raw: parsed.tool_arguments_json, message: err.message || String(err) };
      }
    }
    if (args && typeof args === 'object' && !args.__parse_error) {
      if (args.path == null && typeof args.file_path === 'string') args.path = args.file_path;
      if (args.content == null && typeof args.file_content === 'string') args.content = args.file_content;
    }
    if (parsed.file_path) {
      if (!args || typeof args !== 'object' || args.__parse_error) args = {};
      args.path = parsed.file_path;
    }
    if (parsed.file_content != null && (parsed.tool_name === 'write_file' || parsed.tool_name === 'obsidian_write_note')) {
      if (!args || typeof args !== 'object' || args.__parse_error) args = {};
      args.content = parsed.file_content;
    }
    const isEditTool = parsed.tool_name === 'str_replace_in_file' || parsed.tool_name === 'obsidian_edit_note';
    if (isEditTool) {
      if (!args || typeof args !== 'object' || args.__parse_error) args = {};
      if (typeof parsed.old_str === 'string' && parsed.old_str !== '') args.old_str = parsed.old_str;
      if (typeof parsed.new_str === 'string') args.new_str = parsed.new_str;
      if (typeof args.old_str !== 'string' || args.old_str === '') {
        args = {
          __parse_error: true,
          message:
            'old_str fehlt oder ist leer. Ein leerer old_str matcht überall in der Datei und wird deshalb abgelehnt. ' +
            'Vorher mit read_file (bzw. obsidian_read_note für Vault-Notizen) den EXAKTEN bestehenden Text lesen und alten ' +
            'Text als old_str, neuen Text als new_str setzen.'
        };
      }
    }
    if (parsed.mcp_code != null && parsed.mcp_code !== '' && parsed.tool_name === 'studio_mcp_call_tool') {
      if (!args || typeof args !== 'object' || args.__parse_error) args = {};
      args.mcp_code = parsed.mcp_code;
    }
    return {
      content: parsed.thought || '',
      toolCalls: [{ id: `local-${Date.now()}`, name: parsed.tool_name, arguments: args }],
      stopReason: 'tool_calls',
      usage
    };
  } finally {
    await context.dispose();
  }
}

async function listModels({ modelsFolder }) {
  return listGgufFiles(modelsFolder);
}

module.exports = { chat, listModels, listGgufFiles, getLlamaSingleton };
