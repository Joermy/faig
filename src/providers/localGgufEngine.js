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

const SCANNED_ROOTS = path.join(__dirname, '..', '..', '..', 'Agentic-OS', 'data', 'local-model-roots.json');
const firstFolder = (modelsFolder) => String(modelsFolder || '').split(';')[0].trim();

function modelFolders(modelsFolder) {
  const own = String(modelsFolder || '').split(';').map((s) => s.trim()).filter(Boolean);
  let scanned = [];
  try {
    scanned = JSON.parse(fs.readFileSync(SCANNED_ROOTS, 'utf8')).roots || [];
  } catch {
  }
  const seen = new Set();
  return [...own, ...scanned].filter((d) => {
    const k = path.resolve(d).toLowerCase();
    if (seen.has(k) || !fs.existsSync(d)) return false;
    seen.add(k);
    return true;
  });
}

function resolveModel(modelsFolder, model) {
  return path.isAbsolute(String(model || '')) ? model : path.join(firstFolder(modelsFolder), model);
}

function listGgufFiles(modelsFolder) {
  const out = [];
  for (const root of modelFolders(modelsFolder)) out.push(...listIn(root, root === firstFolder(modelsFolder)));
  return [...new Set(out)].sort();
}

function listIn(modelsFolder, relative) {
  if (!modelsFolder || !fs.existsSync(modelsFolder)) return [];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > (relative ? 2 : 4)) return;
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
        out.push(relative ? path.relative(modelsFolder, full) : full);
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
      lines.push(
        m.compaction
          ? `ZUSAMMENFASSUNG DES BISHERIGEN VERLAUFS (ältere Nachrichten wurden komprimiert):\n${m.content}`
          : `AUFGABE / NEUE INFORMATION VOM NUTZER:\n${m.content}`
      );
    } else if (m.role === 'assistant') {
      if (m.reasoning) lines.push(`DEIN VORHERIGER GEDANKE:\n${m.reasoning}`);
      if (m.content) {
        lines.push(`${m.toolCalls && m.toolCalls.length ? 'DEIN VORHERIGER GEDANKE' : 'DEINE ANTWORT AN DEN NUTZER'}:\n${m.content}`);
      }
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
  off: { maxTokens: 4096, instruction: 'Halte thought SO KURZ WIE MÖGLICH (max. 1 kurzer Satz oder leer) — keine ausführliche Herleitung, keine Zwischenschritte.' },
  low: { maxTokens: 6144, instruction: 'Halte thought kurz (1-2 Sätze).' },
  medium: { maxTokens: 8192, instruction: 'thought darf ein paar Sätze lang sein, wenn es dem Ergebnis hilft.' },
  high: { maxTokens: 12288, instruction: 'Denke in thought gründlich in mehreren Schritten nach, bevor du dich festlegst.' },
  xhigh: { maxTokens: 16384, instruction: 'Denke in thought SEHR gründlich nach: wäge mehrere Optionen ab, geh Schritt für Schritt vor, bevor du dich festlegst.' }
};

function stripThinkTags(s) {
  return typeof s === 'string' ? s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : s;
}

function parseGrammarOutput(grammar, mainText, segmentText) {
  const candidates = [mainText, segmentText, `${segmentText}${mainText}`];
  for (const c of candidates) {
    const text = stripThinkTags(String(c || '')).replace(/^<think>\s*/i, '').trim();
    if (!text) continue;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    for (const attempt of [text, start !== -1 && end > start ? text.slice(start, end + 1) : null]) {
      if (!attempt) continue;
      try {
        return { parsed: grammar.parse(attempt), raw: attempt };
      } catch {
      }
    }
  }
  return null;
}

function createGrammarStreamWatcher(onEvent) {
  let raw = '';
  let emittedThought = 0;
  let announced = '';
  let tokens = 0;
  let lastProgressTs = 0;
  return {
    push(text, tokenCount) {
      if (!onEvent) return;
      raw += text;
      tokens += tokenCount || 0;
      const m = /"thought"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
      if (m) {
        let body = m[1];
        body = body.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '');
        let decoded = '';
        try {
          decoded = JSON.parse(`"${body}"`);
        } catch {
          decoded = '';
        }
        if (decoded.length > emittedThought) {
          onEvent({ type: 'reasoning_token', text: decoded.slice(emittedThought) });
          emittedThought = decoded.length;
        }
      }
      const tool = /"tool_name"\s*:\s*"([^"]+)"/.exec(raw);
      const file = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
      const key = `${tool ? tool[1] : ''}|${file ? file[1] : ''}`;
      if (tool && key !== announced) {
        announced = key;
        let filePath = '';
        try {
          filePath = file ? JSON.parse(`"${file[1]}"`) : '';
        } catch {
          filePath = '';
        }
        onEvent({ type: 'tool_preparing', name: tool[1], path: filePath });
      }
      const now = Date.now();
      if (now - lastProgressTs > 150) {
        lastProgressTs = now;
        onEvent({ type: 'gen_progress', tokens });
      }
    },
    get tokens() {
      return tokens;
    }
  };
}

async function chat({ modelsFolder, model, systemPrompt, messages, tools, onEvent, reasoningEffort, sampling, signal }) {
  if (!modelsFolder) throw new Error('Für diese Connection ist kein Modell-Ordner konfiguriert.');
  const modelPath = resolveModel(modelsFolder, model);
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
      'beide gehören zusammen — ohne file_path schlägt der Aufruf fehl, selbst wenn file_content korrekt gesetzt ist. Eine große ' +
      'Datei in Teilen schreiben: erster Teil normal, jeder weitere Teil zusätzlich mit tool_arguments_json = {"append":true}.',
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
    const watcher = createGrammarStreamWatcher(onEvent);
    const promptOptions = {
      grammar,
      maxTokens: (sampling && sampling.maxTokens) || profile.maxTokens,
      temperature: (sampling && sampling.temperature) ?? 0.2,
      onResponseChunk: (chunk) => watcher.push(chunk.text || '', (chunk.tokens && chunk.tokens.length) || 0),
      signal,
      stopOnAbortSignal: true,
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
    const generate = async (options) => {
      const result = await session.promptWithMeta(transcript, options);
      const segmentText = (result.response || [])
        .filter((item) => item && typeof item === 'object' && item.type === 'segment')
        .map((item) => item.text || '')
        .join('');
      return { mainText: result.responseText || '', segmentText, stopReason: result.stopReason };
    };
    let gen = await generate(promptOptions);
    let picked = parseGrammarOutput(grammar, gen.mainText, gen.segmentText);
    if (signal && signal.aborted) {
      const abortErr = new Error('Vom Nutzer gestoppt.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (!picked && !(gen.mainText + gen.segmentText).trim()) {
      if (onEvent) onEvent({ type: 'local_model_status', message: 'Modell hat nichts ausgegeben — versuche es einmal neu...' });
      session.resetChatHistory();
      gen = await generate({ ...promptOptions, temperature: Math.max(0.6, promptOptions.temperature || 0) });
      picked = parseGrammarOutput(grammar, gen.mainText, gen.segmentText);
    }
    const raw = picked ? picked.raw : `${gen.segmentText}${gen.mainText}`;
    if (!picked) {
      if (!raw.trim()) {
        throw new Error(
          `Modell hat zweimal gar nichts ausgegeben (Stop-Grund: ${gen.stopReason || 'unbekannt'}). Meist ist der Kontext zu knapp ` +
            '(Kontext-Größe in den Modell-Einstellungen erhöhen oder GPU-Programme wie ComfyUI schließen) oder die Vorlage des Modells ' +
            'beendet die Antwort sofort — dann ein anderes Quant/Modell probieren.'
        );
      }
      throw new Error(
        `Modell-Antwort wurde nicht als vollständiges JSON abgeschlossen (${gen.stopReason === 'maxTokens' ? 'Token-Limit erreicht' : `Stop-Grund: ${gen.stopReason}`}, ` +
          `aktuell ${promptOptions.maxTokens} Max. Antwort-Tokens, ${raw.length} Zeichen erzeugt). Erhöhe "Max. Antwort-Tokens" in den ` +
          'Modell-Einstellungen, oder lass große Dateien in mehreren Teilen schreiben (write_file mit append).'
      );
    }
    const parsed = picked.parsed;
    parsed.thought = stripThinkTags(parsed.thought);
    parsed.final_message = stripThinkTags(parsed.final_message);

    let usage = null;
    try {
      if (typeof llmModel.tokenize === 'function') {
        const promptTokens = llmModel.tokenize(transcript).length;
        const completionTokens = watcher.tokens || llmModel.tokenize(raw).length;
        usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens
        };
      }
    } catch {
    }

    if (parsed.is_final) {
      return {
        content: parsed.final_message || parsed.thought || '',
        reasoning: parsed.final_message ? parsed.thought || '' : '',
        toolCalls: [],
        stopReason: 'stop',
        usage,
        contextSize: grantedContextSize
      };
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
      content: '',
      reasoning: parsed.thought || '',
      toolCalls: [{ id: `local-${Date.now()}`, name: parsed.tool_name, arguments: args }],
      stopReason: 'tool_calls',
      usage,
      contextSize: grantedContextSize
    };
  } finally {
    await context.dispose();
  }
}

async function listModels({ modelsFolder }) {
  return listGgufFiles(modelsFolder);
}

module.exports = { chat, listModels, listGgufFiles, resolveModel, getLlamaSingleton };
