const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

const THINKING_BUDGETS = { low: 2000, medium: 6000, high: 16000, xhigh: 32000 };

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function toWireMessages(messages) {
  const wire = [];
  for (const m of messages) {
    if (m.role === 'user') {
      wire.push({ role: 'user', content: [{ type: 'text', text: m.content || '' }] });
    } else if (m.role === 'assistant') {
      const blocks = [];
      for (const t of m.thinking || []) {
        blocks.push({ type: 'thinking', thinking: t.thinking || '', signature: t.signature || '' });
      }
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments && !tc.arguments.__parse_error ? tc.arguments : {} });
      }
      wire.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      wire.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '' }]
      });
    }
  }
  return wire;
}

function toWireTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

function parseFullResponse(data) {
  const blocks = data.content || [];
  const content = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} }));
  const thinking = blocks
    .filter((b) => b.type === 'thinking')
    .map((b) => ({ type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' }));
  return { content, toolCalls, thinking, stopReason: data.stop_reason, usage: data.usage || null, raw: data };
}

async function parseStreamResponse(res, { onToken, onReasoning } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const blocks = new Map();
  let stopReason = null;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      if (evt.type === 'message_start') {
        if (evt.message && evt.message.usage) usage = { ...evt.message.usage };
      } else if (evt.type === 'content_block_start') {
        const cb = evt.content_block || {};
        blocks.set(evt.index, {
          type: cb.type,
          text: cb.text || '',
          thinkingText: cb.thinking || '',
          signature: cb.signature || '',
          id: cb.id,
          name: cb.name,
          jsonBuf: ''
        });
      } else if (evt.type === 'content_block_delta') {
        const entry = blocks.get(evt.index);
        if (!entry) continue;
        const delta = evt.delta || {};
        if (delta.type === 'text_delta' && delta.text) {
          entry.text += delta.text;
          if (onToken) onToken(delta.text);
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          entry.jsonBuf += delta.partial_json;
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          entry.thinkingText += delta.thinking;
          if (onReasoning) onReasoning(delta.thinking);
        } else if (delta.type === 'signature_delta' && delta.signature) {
          entry.signature += delta.signature;
        }
      } else if (evt.type === 'error') {
        const e = evt.error || {};
        throw new Error(`Anthropic meldet Fehler im Stream: ${e.type || ''} ${e.message || ''}`.trim());
      } else if (evt.type === 'message_delta') {
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
      }
    }
  }

  const ordered = [...blocks.keys()].sort((a, b) => a - b).map((i) => blocks.get(i));
  const content = ordered
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const toolCalls = ordered
    .filter((b) => b.type === 'tool_use')
    .map((b) => {
      let args = {};
      try {
        args = b.jsonBuf ? JSON.parse(b.jsonBuf) : {};
      } catch (err) {
        args = {
          __parse_error: true,
          raw: b.jsonBuf,
          truncated: stopReason === 'max_tokens',
          message:
            stopReason === 'max_tokens'
              ? 'die Antwort wurde vom Token-Limit mitten im Tool-Aufruf abgeschnitten'
              : `ungültiges JSON in den Tool-Argumenten (${err.message || err})`
        };
      }
      return { id: b.id, name: b.name, arguments: args };
    });
  const thinking = ordered
    .filter((b) => b.type === 'thinking')
    .map((b) => ({ type: 'thinking', thinking: b.thinkingText, signature: b.signature }));

  const reasoning = thinking.map((t) => t.thinking).filter(Boolean).join('\n\n');
  return { content, reasoning, toolCalls, thinking, stopReason, usage, raw: null };
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [2000, 5000, 12000];

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

async function chat({ baseUrl, apiKey, model, systemPrompt, messages, tools, maxTokens, onToken, onReasoning, onEvent, reasoningEffort, sampling, signal }) {
  const url = `${trimSlash(baseUrl || 'https://api.anthropic.com')}/v1/messages`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey || '',
    'anthropic-version': ANTHROPIC_VERSION
  };

  const thinkingBudget = THINKING_BUDGETS[reasoningEffort];
  const baseMaxTokens = (sampling && sampling.maxTokens) || maxTokens || DEFAULT_MAX_TOKENS;
  const body = {
    model,
    max_tokens: thinkingBudget ? thinkingBudget + baseMaxTokens : baseMaxTokens,
    messages: toWireMessages(messages),
    stream: true
  };
  if (systemPrompt) body.system = systemPrompt;
  if (thinkingBudget) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  } else if (sampling) {
    if (sampling.temperature != null) body.temperature = sampling.temperature;
    if (sampling.topP != null) body.top_p = sampling.topP;
    if (sampling.topK != null) body.top_k = sampling.topK;
  }
  if (sampling && sampling.stopSequences && sampling.stopSequences.length) body.stop_sequences = sampling.stopSequences;
  const wireTools = toWireTools(tools);
  if (wireTools) body.tools = wireTools;

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      if (attempt >= RETRY_DELAYS_MS.length) throw new Error(`${url} nicht erreichbar: ${err.message || err}`);
      if (onEvent) onEvent({ type: 'provider_retry', message: `Verbindung fehlgeschlagen (${err.message || err}) — neuer Versuch...` });
      await sleep(RETRY_DELAYS_MS[attempt], signal);
      continue;
    }
    if (res.ok) break;
    const text = await res.text();
    if (RETRY_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      if (onEvent) onEvent({ type: 'provider_retry', message: `Anthropic antwortet ${res.status} — neuer Versuch...` });
      await sleep(RETRY_DELAYS_MS[attempt], signal);
      continue;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const msg = (data && data.error && data.error.message) || text;
    throw new Error(`${url} -> ${res.status}: ${msg}`);
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
    parsed.reasoning = (parsed.thinking || []).map((t) => t.thinking).filter(Boolean).join('\n\n');
    if (parsed.reasoning && onReasoning) onReasoning(parsed.reasoning);
    if (parsed.content && onToken) onToken(parsed.content);
    return parsed;
  }

  return parseStreamResponse(res, { onToken, onReasoning });
}

async function listModels({ baseUrl, apiKey }) {
  const url = `${trimSlash(baseUrl || 'https://api.anthropic.com')}/v1/models`;
  const headers = { 'x-api-key': apiKey || '', 'anthropic-version': ANTHROPIC_VERSION };
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${url} antwortete nicht mit JSON (Status ${res.status})`);
  }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || text;
    throw new Error(`${url} -> ${res.status}: ${msg}`);
  }
  return (data.data || []).map((m) => m.id).filter(Boolean).sort();
}

module.exports = { chat, listModels };
