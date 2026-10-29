const REASONING_EFFORT_MAP = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high' };

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [2000, 5000, 12000];

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function isVenice(baseUrl) {
  return /(^|\/\/|\.)venice\.ai\b/i.test(String(baseUrl || ''));
}

function needsReasoningEcho(baseUrl, model) {
  return /deepseek/i.test(String(model || '')) || /deepseek/i.test(String(baseUrl || ''));
}

function toWireMessages(systemPrompt, messages, { echoReasoning = false } = {}) {
  const wire = [];
  if (systemPrompt) wire.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    if (m.role === 'user') {
      wire.push({ role: 'user', content: m.content || '' });
    } else if (m.role === 'assistant') {
      const entry = { role: 'assistant', content: m.content || null };
      if (m.toolCalls && m.toolCalls.length) {
        entry.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(stripInternalArgs(tc.arguments)) }
        }));
      }
      if (m.reasoning && m.reasoningField === 'reasoning_content') entry.reasoning_content = m.reasoning;
      else if (echoReasoning) entry.reasoning_content = m.reasoning || ' ';
      if (entry.content == null && !entry.tool_calls) entry.content = '';
      wire.push(entry);
    } else if (m.role === 'tool') {
      wire.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || '' });
    }
  }
  return wire;
}

function stripInternalArgs(args) {
  if (!args || typeof args !== 'object') return {};
  if (args.__parse_error) return typeof args.raw === 'string' ? { _raw: args.raw } : {};
  return args;
}

function toWireTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

function parseToolArguments(text, finishReason) {
  if (!text || !String(text).trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {
      __parse_error: true,
      raw: text,
      truncated: finishReason === 'length',
      message:
        finishReason === 'length'
          ? 'die Antwort wurde vom Token-Limit mitten im Tool-Aufruf abgeschnitten'
          : `ungültiges JSON in den Tool-Argumenten (${err.message || err})`
    };
  }
}

let fallbackIdCounter = 0;
function ensureToolCallId(id) {
  return id || `call_${Date.now().toString(36)}_${(fallbackIdCounter++).toString(36)}`;
}

function createThinkSplitter() {
  let inThink = false;
  let pending = '';
  const OPEN = '<think>';
  const CLOSE = '</think>';
  const holdBack = (s, tag) => {
    for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
      if (tag.startsWith(s.slice(-k))) return k;
    }
    return 0;
  };
  return {
    push(text) {
      let s = pending + text;
      pending = '';
      let content = '';
      let reasoning = '';
      while (s) {
        const tag = inThink ? CLOSE : OPEN;
        const idx = s.indexOf(tag);
        if (idx === -1) {
          const keep = holdBack(s, tag);
          const out = s.slice(0, s.length - keep);
          pending = s.slice(s.length - keep);
          if (inThink) reasoning += out;
          else content += out;
          break;
        }
        if (inThink) reasoning += s.slice(0, idx);
        else content += s.slice(0, idx);
        inThink = !inThink;
        s = s.slice(idx + tag.length);
      }
      return { content, reasoning };
    },
    flush() {
      const rest = pending;
      pending = '';
      return inThink ? { content: '', reasoning: rest } : { content: rest, reasoning: '' };
    }
  };
}

function parseFullResponse(data) {
  if (data && data.error) throw new Error(`Anbieter meldet Fehler: ${data.error.message || JSON.stringify(data.error)}`);
  const choice = data.choices && data.choices[0];
  const message = (choice && choice.message) || {};
  const finishReason = choice && choice.finish_reason;
  const splitter = createThinkSplitter();
  const split = splitter.push(message.content || '');
  const tail = splitter.flush();
  let reasoning = message.reasoning_content || message.reasoning || '';
  const reasoningField = message.reasoning_content ? 'reasoning_content' : reasoning ? 'reasoning' : split.reasoning || tail.reasoning ? 'think' : '';
  if (!reasoning) reasoning = split.reasoning + tail.reasoning;
  return {
    content: (split.content + tail.content).trim() ? split.content + tail.content : '',
    reasoning,
    reasoningField,
    toolCalls: (message.tool_calls || []).map((tc) => ({
      id: ensureToolCallId(tc.id),
      name: tc.function && tc.function.name,
      arguments: parseToolArguments(tc.function && tc.function.arguments, finishReason)
    })),
    stopReason: finishReason,
    usage: data.usage || null,
    raw: data
  };
}

async function parseStreamResponse(res, { onToken, onReasoning, onToolCallDelta }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const splitter = createThinkSplitter();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let reasoningField = '';
  const toolCallsMap = new Map();
  let finishReason = null;
  let usage = null;
  let raw = null;

  const emitContent = (text) => {
    const part = splitter.push(text);
    if (part.reasoning) {
      reasoning += part.reasoning;
      if (!reasoningField) reasoningField = 'think';
      if (onReasoning) onReasoning(part.reasoning);
    }
    if (part.content) {
      content += part.content;
      if (onToken) onToken(part.content);
    }
  };

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk.error) {
      throw new Error(`Anbieter meldet Fehler im Stream: ${chunk.error.message || JSON.stringify(chunk.error)}`);
    }
    raw = chunk;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    const reasoningDelta = delta.reasoning_content || (typeof delta.reasoning === 'string' ? delta.reasoning : '');
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      reasoningField = delta.reasoning_content ? 'reasoning_content' : reasoningField || 'reasoning';
      if (onReasoning) onReasoning(reasoningDelta);
    }
    if (delta.content) emitContent(delta.content);
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index === undefined ? toolCallsMap.size : tc.index;
        if (!toolCallsMap.has(i)) toolCallsMap.set(i, { id: '', name: '', arguments: '' });
        const entry = toolCallsMap.get(i);
        if (tc.id) entry.id = tc.id;
        if (tc.function) {
          if (tc.function.name) entry.name += tc.function.name;
          if (tc.function.arguments) entry.arguments += tc.function.arguments;
        }
        if (onToolCallDelta) onToolCallDelta({ index: i, name: entry.name, argumentsLength: entry.arguments.length });
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  }
  if (buffer.trim()) handleLine(buffer);
  const tail = splitter.flush();
  if (tail.reasoning) reasoning += tail.reasoning;
  if (tail.content) {
    content += tail.content;
    if (onToken) onToken(tail.content);
  }

  const toolCalls = [...toolCallsMap.keys()]
    .sort((a, b) => a - b)
    .map((i) => {
      const entry = toolCallsMap.get(i);
      return { id: ensureToolCallId(entry.id), name: entry.name, arguments: parseToolArguments(entry.arguments, finishReason) };
    })
    .filter((tc) => tc.name);

  return { content: content.trim() ? content : '', reasoning, reasoningField, toolCalls, stopReason: finishReason, usage, raw };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(Object.assign(new Error('Vom Nutzer gestoppt.'), { name: 'AbortError' }));
        },
        { once: true }
      );
    }
  });
}

function adjustBodyForError(body, errorText, state) {
  const msg = String(errorText || '');
  let changed = false;
  if (/reasoning_content/i.test(msg) && !state.echoReasoning) {
    state.echoReasoning = true;
    changed = true;
  }
  if (/max_tokens/i.test(msg) && /max_completion_tokens/i.test(msg) && body.max_tokens != null) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    changed = true;
  }
  for (const field of ['reasoning_effort', 'temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'seed', 'stream_options', 'venice_parameters', 'tool_choice', 'thinking']) {
    if (body[field] !== undefined && new RegExp(`\\b${field}\\b`, 'i').test(msg)) {
      delete body[field];
      changed = true;
    }
  }
  return changed;
}

async function chat({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  messages,
  tools,
  extraHeaders,
  onToken,
  onReasoning,
  onToolCallDelta,
  onEvent,
  reasoningEffort,
  sampling,
  signal
}) {
  const url = `${trimSlash(baseUrl)}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    temperature: sampling && sampling.temperature != null ? sampling.temperature : 0.2,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (reasoningEffort && reasoningEffort !== 'off' && REASONING_EFFORT_MAP[reasoningEffort]) {
    body.reasoning_effort = REASONING_EFFORT_MAP[reasoningEffort];
  }
  if (reasoningEffort === 'off' && /api\.deepseek\.com/i.test(baseUrl || '')) {
    body.thinking = { type: 'disabled' };
  }
  if (isVenice(baseUrl)) {
    body.venice_parameters = { include_venice_system_prompt: false };
    if (reasoningEffort === 'off') body.venice_parameters.disable_thinking = true;
  }
  if (sampling) {
    if (sampling.topP != null) body.top_p = sampling.topP;
    if (sampling.topK != null) body.top_k = sampling.topK;
    if (sampling.minP != null) body.min_p = sampling.minP;
    if (sampling.repeatPenalty != null) body.repeat_penalty = sampling.repeatPenalty;
    if (sampling.maxTokens != null) body.max_tokens = sampling.maxTokens;
    if (sampling.seed != null) body.seed = sampling.seed;
    if (sampling.stopSequences && sampling.stopSequences.length) body.stop = sampling.stopSequences;
  }
  const wireTools = toWireTools(tools);
  if (wireTools) {
    body.tools = wireTools;
    body.tool_choice = 'auto';
  }

  const state = { echoReasoning: needsReasoningEcho(baseUrl, model) };
  let adjustments = 0;
  let transientRetries = 0;
  while (true) {
    body.messages = toWireMessages(systemPrompt, messages, { echoReasoning: state.echoReasoning });
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      if (transientRetries < RETRY_DELAYS_MS.length) {
        if (onEvent) onEvent({ type: 'provider_retry', message: `Verbindung fehlgeschlagen (${err.message || err}) — neuer Versuch...` });
        await sleep(RETRY_DELAYS_MS[transientRetries++], signal);
        continue;
      }
      throw new Error(`${url} nicht erreichbar: ${err.message || err}`);
    }

    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try {
        const data = JSON.parse(text);
        const e = data && data.error;
        msg = (e && (e.message || (typeof e === 'string' ? e : JSON.stringify(e)))) || data.message || text;
      } catch {
        msg = text.slice(0, 500);
      }
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
      if ((res.status === 400 || res.status === 422) && adjustments < 4 && adjustBodyForError(body, msg, state)) {
        adjustments++;
        continue;
      }
      if (RETRY_STATUS.has(res.status) && transientRetries < RETRY_DELAYS_MS.length) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : RETRY_DELAYS_MS[transientRetries];
        transientRetries++;
        if (onEvent) onEvent({ type: 'provider_retry', message: `Anbieter antwortet ${res.status} — neuer Versuch in ${Math.round(wait / 1000)}s...` });
        await sleep(wait, signal);
        continue;
      }
      throw new Error(`${url} -> ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    const canStream = contentType.includes('event-stream') && res.body && typeof res.body.getReader === 'function';

    if (!canStream) {
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`${url} antwortete nicht mit JSON (Status ${res.status}): ${text.slice(0, 300)}`);
      }
      const parsed = parseFullResponse(data);
      if (parsed.reasoning && onReasoning) onReasoning(parsed.reasoning);
      if (parsed.content && onToken) onToken(parsed.content);
      return parsed;
    }

    return parseStreamResponse(res, { onToken, onReasoning, onToolCallDelta });
  }
}

async function listModels({ baseUrl, apiKey }) {
  const url = `${trimSlash(baseUrl)}/models`;
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${url} antwortete nicht mit JSON (Status ${res.status})`);
  }
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || text;
    throw new Error(`${url} -> ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  const list = data.data || data.models || [];
  return list
    .map((m) => (typeof m === 'string' ? m : m.id || m.name))
    .filter(Boolean)
    .sort();
}

module.exports = { chat, listModels };
