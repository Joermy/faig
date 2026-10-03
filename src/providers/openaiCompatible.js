const REASONING_EFFORT_MAP = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high' };

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function toWireMessages(systemPrompt, messages) {
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
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) }
        }));
      }
      wire.push(entry);
    } else if (m.role === 'tool') {
      wire.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || '' });
    }
  }
  return wire;
}

function toWireTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

function toolCallsFromMessage(message) {
  return (message.tool_calls || []).map((tc) => {
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      args = { _raw: tc.function.arguments };
    }
    return { id: tc.id, name: tc.function.name, arguments: args };
  });
}

function parseFullResponse(data) {
  const choice = data.choices && data.choices[0];
  const message = (choice && choice.message) || {};
  return {
    content: message.content || '',
    toolCalls: toolCallsFromMessage(message),
    stopReason: choice && choice.finish_reason,
    usage: data.usage || null,
    raw: data
  };
}

async function parseStreamResponse(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  const toolCallsMap = new Map();
  let finishReason = null;
  let usage = null;
  let raw = null;

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
      if (payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      raw = chunk;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        content += delta.content;
        if (onToken) onToken(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index === undefined ? 0 : tc.index;
          if (!toolCallsMap.has(i)) toolCallsMap.set(i, { id: '', name: '', arguments: '' });
          const entry = toolCallsMap.get(i);
          if (tc.id) entry.id = tc.id;
          if (tc.function) {
            if (tc.function.name) entry.name += tc.function.name;
            if (tc.function.arguments) entry.arguments += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  const toolCalls = [...toolCallsMap.keys()]
    .sort((a, b) => a - b)
    .map((i) => {
      const entry = toolCallsMap.get(i);
      let args = {};
      try {
        args = JSON.parse(entry.arguments || '{}');
      } catch {
        args = { _raw: entry.arguments };
      }
      return { id: entry.id, name: entry.name, arguments: args };
    });

  return { content, toolCalls, stopReason: finishReason, usage, raw };
}

async function chat({ baseUrl, apiKey, model, systemPrompt, messages, tools, extraHeaders, onToken, reasoningEffort, sampling }) {
  const url = `${trimSlash(baseUrl)}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: toWireMessages(systemPrompt, messages),
    temperature: sampling && sampling.temperature != null ? sampling.temperature : 0.2,
    stream: true
  };
  if (reasoningEffort && reasoningEffort !== 'off' && REASONING_EFFORT_MAP[reasoningEffort]) {
    body.reasoning_effort = REASONING_EFFORT_MAP[reasoningEffort];
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

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  if (!res.ok) {
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const msg = (data && data.error && (data.error.message || data.error)) || text;
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
    return parseFullResponse(data);
  }

  return parseStreamResponse(res, onToken);
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
