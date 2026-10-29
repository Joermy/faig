const TEMPLATES = {
  openrouter: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', name: 'OpenRouter' },
  ollama: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', name: 'Ollama (lokal)' },
  lmstudio: { kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', name: 'LM Studio (lokal)' },
  localgguf: { kind: 'local-gguf', name: 'Lokales GGUF-Modell' },
  openai: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI' },
  venice: { kind: 'openai-compatible', baseUrl: 'https://api.venice.ai/api/v1', name: 'Venice AI' },
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', name: 'Anthropic (Claude)' }
};

const EMAIL_TEMPLATES = {
  gmail: { host: 'smtp.gmail.com', port: '587', secure: false },
  outlook: { host: 'smtp.office365.com', port: '587', secure: false }
};

let connections = [];
let chats = [];
let activeChat = null;
let editingConnectionId = null;
const runs = new Map();
function isChatRunning(id) {
  return !!id && runs.has(id);
}
let emailAccount = {};
let comfyUiConfig = { baseUrl: 'http://127.0.0.1:8188', workflowsDir: '' };
let vaultPath = '';

const SAMPLING_FIELD_IDS = [
  'samplingTemperature', 'samplingTopP', 'samplingTopK', 'samplingMinP', 'samplingRepeatPenalty',
  'samplingRepeatLastN', 'samplingMaxTokens', 'samplingSeed', 'samplingStopSequences',
  'samplingContextSize', 'samplingGpuLayers', 'samplingThreads', 'samplingBatchSize', 'samplingFlashAttention',
  'samplingContextWindow'
];

let live = null;
let loadingChatId = null;

let micState = 'idle';
let micStream = null;
let micAudioCtx = null;
let micSourceNode = null;
let micProcessorNode = null;
let micChunks = [];

const el = (id) => document.getElementById(id);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

async function init() {
  const config = await window.api.getConfig();
  connections = config.connections || [];
  emailAccount = config.emailAccount || {};
  comfyUiConfig = config.comfyui || { baseUrl: 'http://127.0.0.1:8188', workflowsDir: '' };
  vaultPath = config.vaultPath || '';
  chats = await window.api.listChats();

  renderChatList();
  renderConnectionCards();
  loadEmailAccountIntoForm();
  loadComfyUiConfigIntoForm();
  loadStudioMcpConfigIntoForm(config.studioMcp);
  el('vaultPathInput').value = vaultPath;
  loadBuildInfo();

  const last = chats.find((c) => c.id === config.lastChatId) || chats[0];
  if (last) {
    selectChat(last.id);
  } else {
    await onNewChat();
  }

  wireEvents();
  window.api.onAgentEvent(onAgentEvent);
  window.api.onAgentDone(onAgentDone);
  for (const id of await window.api.getRunningChats()) {
    if (!runs.has(id)) runs.set(id, { task: null, events: [], startedAt: Date.now() });
  }
  renderChatList();
  updateRunUi();
}

async function loadBuildInfo() {
  const res = await window.api.getBuildInfo();
  const el2 = el('buildInfoLine');
  if (!res || !res.ok) {
    el2.textContent = 'Build: unbekannt';
    return;
  }
  const date = new Date(res.commitDate);
  const dateStr = isNaN(date) ? '' : ` · ${date.toLocaleDateString('de-DE')} ${date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  el2.textContent = `Build: ${res.commitHash}${dateStr}`;
}

function wireEvents() {
  el('newChatBtn').addEventListener('click', onNewChat);
  el('openConnectionsBtn').addEventListener('click', openConnectionsModal);
  el('closeConnectionsBtn').addEventListener('click', closeConnectionsModal);
  el('connectionsModal').addEventListener('click', (e) => {
    if (e.target.id === 'connectionsModal') closeConnectionsModal();
  });
  document.querySelectorAll('.settings-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => selectSettingsSection(btn.dataset.section));
  });
  el('refreshSpecsBtn').addEventListener('click', loadSystemSpecsIntoSettings);

  el('tplSelect').addEventListener('change', onTemplateChange);
  el('connKind').addEventListener('change', () => toggleConnKindFields(el('connKind').value));
  el('pickModelsFolderBtn').addEventListener('click', onPickModelsFolder);
  el('saveConnectionBtn').addEventListener('click', onSaveConnection);
  el('cancelEditBtn').addEventListener('click', resetConnectionForm);

  el('runConnection').addEventListener('change', onChatConnectionChange);
  el('loadModelsBtn').addEventListener('click', onLoadModels);
  el('pickFolderBtn').addEventListener('click', onPickFolder);
  el('shellToolCheckbox').addEventListener('change', onShellToolChange);
  el('browserToolCheckbox').addEventListener('change', onBrowserToolChange);
  el('emailToolCheckbox').addEventListener('change', onEmailToolChange);
  el('emailTplSelect').addEventListener('change', onEmailTemplateChange);
  el('saveEmailAccountBtn').addEventListener('click', onSaveEmailAccount);
  el('comfyUiToolCheckbox').addEventListener('change', onComfyUiToolChange);
  el('studioMcpToolCheckbox').addEventListener('change', onStudioMcpToolChange);
  el('autoCompactCheckbox').addEventListener('change', onBehaviorToggleChange);
  el('infiniteOutputCheckbox').addEventListener('change', onBehaviorToggleChange);
  el('compactNowBtn').addEventListener('click', onCompactNow);
  el('saveStudioMcpBtn').addEventListener('click', onSaveStudioMcpConfig);
  el('modelLoadChat').addEventListener('click', () => {
    if (loadingChatId) selectChat(loadingChatId);
  });
  el('reasoningEffortSelect').addEventListener('change', onReasoningEffortChange);
  for (const id of SAMPLING_FIELD_IDS) {
    el(id).addEventListener('change', onSamplingSettingsChange);
  }
  el('resetSamplingBtn').addEventListener('click', onResetSampling);
  el('autoOptimizeBtn').addEventListener('click', onAutoOptimize);
  el('refreshSystemPromptViewBtn').addEventListener('click', onRefreshSystemPromptView);
  el('modelLoadSpecsToggleBtn').addEventListener('click', onToggleModelLoadSpecs);
  el('pickComfyUiWorkflowsDirBtn').addEventListener('click', onPickComfyUiWorkflowsDir);
  el('saveComfyUiBtn').addEventListener('click', onSaveComfyUiConfig);
  el('pickVaultPathBtn').addEventListener('click', onPickVaultPath);
  el('saveVaultPathBtn').addEventListener('click', onSaveVaultPath);
  el('micBtn').addEventListener('click', onMicClick);
  el('chatTitleInput').addEventListener('change', onRenameChat);
  el('systemPromptInput').addEventListener('change', onSystemPromptChange);

  el('taskInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  el('taskInput').addEventListener('input', autoGrowTextarea);
  el('runBtn').addEventListener('click', onSend);
  el('stopBtn').addEventListener('click', onStop);
  el('exportChatBtn').addEventListener('click', onExportChat);
  el('clearHistoryBtn').addEventListener('click', onClearHistory);

  el('messages').addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-code-btn');
    if (!btn) return;
    const codeEl = document.getElementById(btn.dataset.target);
    if (!codeEl) return;
    navigator.clipboard
      .writeText(codeEl.textContent)
      .then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Kopiert!';
        setTimeout(() => (btn.textContent = orig), 1200);
      })
      .catch(() => {});
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      onNewChat();
    } else if (mod && e.key === ',') {
      e.preventDefault();
      openConnectionsModal();
    } else if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      onExportChat();
    } else if (e.key === 'Escape') {
      if (!el('connectionsModal').hidden) {
        closeConnectionsModal();
      } else if (HEADER_POPOVER_IDS.some((id) => !el(id).hidden)) {
        closeHeaderPopovers();
      } else if (!el('chatSettingsPanel').hidden) {
        el('chatSettingsPanel').hidden = true;
      } else if (activeChat && isChatRunning(activeChat.id)) {
        onStop();
      }
    }
  });

  el('chatSettingsToggleBtn').addEventListener('click', () => {
    el('chatSettingsPanel').hidden = !el('chatSettingsPanel').hidden;
  });
  el('closeChatSettingsBtn').addEventListener('click', () => {
    el('chatSettingsPanel').hidden = true;
  });

  for (const [btnId, menuId] of [
    ['modelMenuBtn', 'modelMenu'],
    ['projectMenuBtn', 'projectMenu'],
    ['toolsMenuBtn', 'toolsMenu'],
    ['moreMenuBtn', 'moreMenu']
  ]) {
    el(btnId).addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = el(menuId).hidden;
      closeHeaderPopovers();
      el(menuId).hidden = !willOpen;
    });
  }
  el('toolsMenu').addEventListener('change', updateToolsMenuCount);
  el('runConnection').addEventListener('change', refreshHeaderMenuLabels);
  el('runModel').addEventListener('change', refreshHeaderMenuLabels);
  el('runModelManual').addEventListener('input', refreshHeaderMenuLabels);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.header-popover-wrap')) closeHeaderPopovers();
  });

  toggleConnKindFields(el('connKind').value);
}

const HEADER_POPOVER_IDS = ['modelMenu', 'projectMenu', 'toolsMenu', 'moreMenu'];
function closeHeaderPopovers() {
  for (const id of HEADER_POPOVER_IDS) el(id).hidden = true;
}

function refreshHeaderMenuLabels() {
  const connSel = el('runConnection');
  const connOpt = connSel.options[connSel.selectedIndex];
  const connName = connOpt ? connOpt.textContent : '';
  const modelVal = getRunModelValue();
  el('modelMenuLabel').textContent = modelVal ? (connName ? `${connName} · ${modelVal}` : modelVal) : (connName || 'Modell wählen');

  const folder = el('folderPath').value;
  el('projectMenuLabel').textContent = folder ? folder.split(/[\\/]/).filter(Boolean).pop() : 'Projektordner wählen';
  el('projectMenuBtn').title = folder || 'Projektordner wählen';
}

const TOOL_CHECKBOX_IDS = [
  'shellToolCheckbox', 'browserToolCheckbox', 'emailToolCheckbox', 'comfyUiToolCheckbox', 'studioMcpToolCheckbox', 'autopilotCheckbox'
];

function updateToolsMenuCount() {
  const count = TOOL_CHECKBOX_IDS.filter((id) => el(id).checked).length;
  const badge = el('toolsMenuCount');
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function autoGrowTextarea() {
  const ta = el('taskInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

function renderChatList() {
  const container = el('chatList');
  container.innerHTML = '';
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (activeChat && activeChat.id === c.id ? ' active' : '');
    const pinTitle = c.title || 'Neuer Chat';
    item.innerHTML = `
      <span class="chat-item-title">${c.pinned ? '<span class="pin-dot" title="Angepinnt"></span>' : ''}${escapeHtml(pinTitle)}</span>
      ${isChatRunning(c.id) ? '<span class="chat-run-dot" title="Arbeitet gerade"></span>' : c.hasUnseenUpdate ? '<span class="chat-unseen-dot" title="Neue Antwort"></span>' : ''}
      <span class="chat-item-actions">
        <span class="chat-item-rename" data-id="${c.id}" title="Umbenennen">✎</span>
        ${c.pinned ? '' : `<span class="chat-item-del" data-id="${c.id}" title="Löschen">✕</span>`}
      </span>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('chat-item-del') || e.target.classList.contains('chat-item-rename')) return;
      selectChat(c.id);
    });
    item.querySelector('.chat-item-title').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(item, c);
    });
    item.querySelector('.chat-item-rename').addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineRename(item, c);
    });
    const delBtn = item.querySelector('.chat-item-del');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDeleteChat(c.id);
      });
    }
    container.appendChild(item);
  }
}

function startInlineRename(item, chat) {
  const titleSpan = item.querySelector('.chat-item-title');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-item-rename-input';
  input.value = chat.title || '';
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newTitle = input.value.trim() || 'Neuer Chat';
    chat.title = newTitle;
    await window.api.renameChat(chat.id, newTitle);
    if (activeChat && activeChat.id === chat.id) el('chatTitleInput').value = newTitle;
    renderChatList();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      e.stopPropagation();
      input.value = chat.title || '';
      input.blur();
    }
  });
  input.addEventListener('blur', commit);
}

async function onNewChat() {
  const defaults = activeChat
    ? {
        connectionId: activeChat.connectionId,
        model: activeChat.model,
        folder: activeChat.folder,
        enableShellTool: activeChat.enableShellTool,
        enableBrowserTool: activeChat.enableBrowserTool,
        enableEmailTool: activeChat.enableEmailTool,
        enableComfyUiTool: activeChat.enableComfyUiTool,
        enableStudioMcpTool: activeChat.enableStudioMcpTool,
        autoCompact: activeChat.autoCompact,
        infiniteOutput: activeChat.infiniteOutput,
        reasoningEffort: activeChat.reasoningEffort,
        samplingSettings: activeChat.samplingSettings,
        systemPrompt: activeChat.systemPrompt
      }
    : {};
  const chat = await window.api.createChat({ title: 'Neuer Chat', ...defaults });
  chats.unshift(chat);
  renderChatList();
  selectChat(chat.id);
}

function selectChat(id) {
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  activeChat = chat;
  chat.hasUnseenUpdate = false;
  window.api.setLast({ chatId: chat.id });
  renderChatList();

  el('chatTitleInput').value = chat.title || '';
  el('folderPath').value = chat.folder || '';
  el('shellToolCheckbox').checked = !!chat.enableShellTool;
  el('browserToolCheckbox').checked = !!chat.enableBrowserTool;
  el('emailToolCheckbox').checked = !!chat.enableEmailTool;
  el('comfyUiToolCheckbox').checked = !!chat.enableComfyUiTool;
  el('studioMcpToolCheckbox').checked = !!chat.enableStudioMcpTool;
  el('autopilotCheckbox').checked = !!chat.autopilotEnabled;
  el('autoCompactCheckbox').checked = chat.autoCompact !== false;
  el('infiniteOutputCheckbox').checked = !!chat.infiniteOutput;
  el('clearHistoryBtn').hidden = !chat.pinned;
  updateToolsMenuCount();
  el('reasoningEffortSelect').value = chat.reasoningEffort || 'medium';
  loadSamplingSettingsIntoForm(chat.samplingSettings);
  el('systemPromptInput').value = chat.systemPrompt || '';
  el('systemPromptView').textContent = 'Noch nicht geladen — Neu-laden-Knopf klicken.';

  populateRunConnectionSelect();
  if (chat.connectionId) el('runConnection').value = chat.connectionId;
  setModelDropdownSingleValue(chat.model || '');

  renderTranscript();
  updateRunUi();
}

async function onClearHistory() {
  if (!activeChat || !activeChat.pinned) return;
  if (!confirm(`Nachrichtenverlauf von "${activeChat.title || 'diesem Chat'}" wirklich löschen? Connection/Ordner/Tools/Einstellungen bleiben erhalten.`)) return;
  await window.api.stopAgent(activeChat.id);
  runs.delete(activeChat.id);
  live = null;
  updateRunUi();
  const chat = await window.api.clearChatMessages(activeChat.id);
  if (chat) activeChat.messages = chat.messages;
  renderTranscript();
}

async function onSystemPromptChange() {
  if (!activeChat) return;
  const systemPrompt = el('systemPromptInput').value;
  activeChat.systemPrompt = systemPrompt;
  await window.api.updateChatSettings(activeChat.id, { systemPrompt });
}

async function onDeleteChat(id) {
  const chat = chats.find((c) => c.id === id);
  if (chat && chat.pinned) {
    alert('Dieser Chat ist angepinnt und kann nicht gelöscht werden.');
    return;
  }
  await window.api.deleteChat(id);
  runs.delete(id);
  chats = chats.filter((c) => c.id !== id);
  if (activeChat && activeChat.id === id) {
    activeChat = null;
    if (chats.length) selectChat(chats[0].id);
    else await onNewChat();
  }
  renderChatList();
}

async function onRenameChat() {
  if (!activeChat) return;
  const title = el('chatTitleInput').value.trim() || 'Neuer Chat';
  activeChat.title = title;
  await window.api.renameChat(activeChat.id, title);
  renderChatList();
}

function populateRunConnectionSelect() {
  const sel = el('runConnection');
  const prevValue = sel.value;
  sel.innerHTML = '';
  if (!connections.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(keine Connection — erst anlegen)';
    sel.appendChild(opt);
    return;
  }
  for (const c of connections) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if (connections.some((c) => c.id === prevValue)) sel.value = prevValue;
}

function setModelDropdownSingleValue(model) {
  el('runModel').hidden = false;
  el('runModelManual').hidden = true;
  const sel = el('runModel');
  sel.innerHTML = '';
  if (model) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    sel.appendChild(opt);
  }
  refreshHeaderMenuLabels();
}

async function onChatConnectionChange() {
  if (!activeChat) return;
  const connectionId = el('runConnection').value;
  activeChat.connectionId = connectionId;
  activeChat.model = '';
  setModelDropdownSingleValue('');
  await window.api.updateChatSettings(activeChat.id, { connectionId, model: '' });
}

async function onLoadModels() {
  const connId = el('runConnection').value;
  const connection = connections.find((c) => c.id === connId);
  if (!connection) {
    alert('Bitte zuerst in den Connections eine Connection anlegen und hier auswählen.');
    return;
  }
  el('loadModelsBtn').disabled = true;
  el('loadModelsBtn').textContent = 'Lade...';
  let res;
  try {
    res = await window.api.listModels(connection);
  } catch (err) {
    appendSystemLine(`Modelle konnten nicht geladen werden: ${err.message || err}`, 'error');
    makeModelSelectEditable();
    return;
  } finally {
    el('loadModelsBtn').disabled = false;
    el('loadModelsBtn').textContent = 'Modelle laden';
  }

  el('runModel').hidden = false;
  el('runModelManual').hidden = true;
  const modelSel = el('runModel');
  modelSel.innerHTML = '';
  if (!res.ok) {
    appendSystemLine(`Modelle konnten nicht geladen werden: ${res.error}`, 'error');
    makeModelSelectEditable();
    return;
  }
  for (const m of res.models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelSel.appendChild(opt);
  }
  if (!res.models.length) {
    appendSystemLine(
      connection.kind === 'local-gguf'
        ? 'Keine .gguf-Dateien in diesem Ordner gefunden (auch nicht in Unterordnern, max. 2 Ebenen tief).'
        : 'Server hat eine leere Modell-Liste zurückgegeben.',
      'error'
    );
  }
  refreshHeaderMenuLabels();
}

function makeModelSelectEditable() {
  el('runModel').hidden = true;
  const manual = el('runModelManual');
  manual.hidden = false;
  manual.value = '';
  manual.focus();
  refreshHeaderMenuLabels();
}

function getRunModelValue() {
  return el('runModelManual').hidden ? el('runModel').value : el('runModelManual').value;
}

async function onPickFolder() {
  const folder = await window.api.pickFolder({ title: 'Projektordner wählen (wo der Agent Dateien liest/schreibt)' });
  if (!folder || !activeChat) return;
  el('folderPath').value = folder;
  activeChat.folder = folder;
  refreshHeaderMenuLabels();
  await window.api.updateChatSettings(activeChat.id, { folder });
  await window.api.setLast({ folder });
}

async function onShellToolChange(e) {
  if (!activeChat) return;
  activeChat.enableShellTool = e.target.checked;
  await window.api.updateChatSettings(activeChat.id, { enableShellTool: e.target.checked });
}

async function onBrowserToolChange(e) {
  if (!activeChat) return;
  activeChat.enableBrowserTool = e.target.checked;
  await window.api.updateChatSettings(activeChat.id, { enableBrowserTool: e.target.checked });
}

async function onEmailToolChange(e) {
  if (!activeChat) return;
  if (e.target.checked && !emailAccount.host) {
    alert('Erst im Connections-Fenster unter "E-Mail-Konto" ein SMTP-Konto eintragen und speichern, sonst kann email_send nicht funktionieren.');
  }
  activeChat.enableEmailTool = e.target.checked;
  await window.api.updateChatSettings(activeChat.id, { enableEmailTool: e.target.checked });
}

async function onReasoningEffortChange(e) {
  if (!activeChat) return;
  activeChat.reasoningEffort = e.target.value;
  await window.api.updateChatSettings(activeChat.id, { reasoningEffort: e.target.value });
}

function numOrUndef(v) {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function readSamplingSettingsFromForm() {
  const stopRaw = el('samplingStopSequences').value.trim();
  return {
    temperature: numOrUndef(el('samplingTemperature').value),
    topP: numOrUndef(el('samplingTopP').value),
    topK: numOrUndef(el('samplingTopK').value),
    minP: numOrUndef(el('samplingMinP').value),
    repeatPenalty: numOrUndef(el('samplingRepeatPenalty').value),
    repeatLastN: numOrUndef(el('samplingRepeatLastN').value),
    maxTokens: numOrUndef(el('samplingMaxTokens').value),
    seed: numOrUndef(el('samplingSeed').value),
    stopSequences: stopRaw ? stopRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    contextSize: numOrUndef(el('samplingContextSize').value),
    gpuLayers: numOrUndef(el('samplingGpuLayers').value),
    threads: numOrUndef(el('samplingThreads').value),
    batchSize: numOrUndef(el('samplingBatchSize').value),
    contextWindow: numOrUndef(el('samplingContextWindow').value),
    flashAttention: el('samplingFlashAttention').checked || undefined
  };
}

function loadSamplingSettingsIntoForm(sampling) {
  const s = sampling || {};
  el('samplingTemperature').value = s.temperature ?? '';
  el('samplingTopP').value = s.topP ?? '';
  el('samplingTopK').value = s.topK ?? '';
  el('samplingMinP').value = s.minP ?? '';
  el('samplingRepeatPenalty').value = s.repeatPenalty ?? '';
  el('samplingRepeatLastN').value = s.repeatLastN ?? '';
  el('samplingMaxTokens').value = s.maxTokens ?? '';
  el('samplingSeed').value = s.seed ?? '';
  el('samplingStopSequences').value = (s.stopSequences && s.stopSequences.join(', ')) || '';
  el('samplingContextSize').value = s.contextSize ?? '';
  el('samplingGpuLayers').value = s.gpuLayers ?? '';
  el('samplingThreads').value = s.threads ?? '';
  el('samplingBatchSize').value = s.batchSize ?? '';
  el('samplingContextWindow').value = s.contextWindow ?? '';
  el('samplingFlashAttention').checked = !!s.flashAttention;
}

async function onSamplingSettingsChange() {
  if (!activeChat) return;
  const samplingSettings = readSamplingSettingsFromForm();
  activeChat.samplingSettings = samplingSettings;
  await window.api.updateChatSettings(activeChat.id, { samplingSettings });
}

async function onResetSampling() {
  loadSamplingSettingsIntoForm({});
  await onSamplingSettingsChange();
}

async function onRefreshSystemPromptView() {
  const viewEl = el('systemPromptView');
  if (!activeChat) {
    viewEl.textContent = 'Kein Chat ausgewählt.';
    return;
  }
  viewEl.textContent = 'Lädt...';
  const res = await window.api.getEffectiveSystemPrompt({
    folder: el('folderPath').value,
    enableBrowserTool: el('browserToolCheckbox').checked,
    enableEmailTool: el('emailToolCheckbox').checked,
    enableComfyUiTool: el('comfyUiToolCheckbox').checked,
    enableStudioMcpTool: el('studioMcpToolCheckbox').checked,
    autopilotEnabled: el('autopilotCheckbox').checked,
    customSystemPrompt: el('systemPromptInput').value
  });
  viewEl.textContent = res && res.ok ? res.prompt : `Fehler: ${res && res.error}`;
}

async function onAutoOptimize() {
  const connection = connections.find((c) => c.id === el('runConnection').value);
  const model = getRunModelValue();
  if (!connection) return alert('Bitte zuerst eine Connection wählen.');
  if (connection.kind !== 'local-gguf') {
    alert('Automatische Hardware-Optimierung gibt es nur für lokale .gguf-Connections — bei einem Server/einer API laufen Modelle nicht auf deiner eigenen Hardware.');
    return;
  }
  if (!model) return alert('Bitte zuerst ein Modell wählen.');

  const resultEl = el('autoOptimizeResult');
  const btn = el('autoOptimizeBtn');
  btn.disabled = true;
  btn.textContent = 'Berechne (liest Modell-Metadaten + aktuelle Hardware)...';
  resultEl.hidden = true;
  try {
    const res = await window.api.recommendModelSettings(connection, model);
    if (!res.ok) {
      resultEl.hidden = false;
      resultEl.className = 'auto-optimize-result low-score';
      resultEl.textContent = `Fehler: ${res.error}`;
      return;
    }
    const rec = res.recommendation;
    el('samplingGpuLayers').value = rec.gpuLayers;
    el('samplingContextSize').value = rec.contextSize;
    el('samplingFlashAttention').checked = !!rec.flashAttentionRecommended;
    await onSamplingSettingsChange();

    resultEl.hidden = false;
    resultEl.className = 'auto-optimize-result' + (rec.compatibilityScore < 0.5 ? ' low-score' : '');
    resultEl.textContent = rec.reasoning;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = 'auto-optimize-result low-score';
    resultEl.textContent = `Fehler: ${err.message || err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Automatisch für meine Hardware optimieren';
  }
}

async function onComfyUiToolChange(e) {
  if (!activeChat) return;
  if (e.target.checked && !comfyUiConfig.workflowsDir) {
    alert('Erst im Connections-Fenster unter "ComfyUI" den Workflow-Ordner wählen und speichern, sonst kann das ComfyUI-Tool nichts finden.');
  }
  activeChat.enableComfyUiTool = e.target.checked;
  await window.api.updateChatSettings(activeChat.id, { enableComfyUiTool: e.target.checked });
}

async function onStudioMcpToolChange(e) {
  if (!activeChat) return;
  activeChat.enableStudioMcpTool = e.target.checked;
  await window.api.updateChatSettings(activeChat.id, { enableStudioMcpTool: e.target.checked });
}

async function onBehaviorToggleChange() {
  if (!activeChat) return;
  activeChat.autoCompact = el('autoCompactCheckbox').checked;
  activeChat.infiniteOutput = el('infiniteOutputCheckbox').checked;
  await window.api.updateChatSettings(activeChat.id, {
    autoCompact: activeChat.autoCompact,
    infiniteOutput: activeChat.infiniteOutput
  });
}

function onCompactNow() {
  closeHeaderPopovers();
  if (!activeChat || isChatRunning(activeChat.id)) return;
  if (!(activeChat.messages || []).length) {
    alert('Dieser Chat hat noch keinen Verlauf zum Komprimieren.');
    return;
  }
  onSend({ compactOnly: true });
}

function loadStudioMcpConfigIntoForm(cfg) {
  const c = cfg || {};
  el('studioMcpCommand').value = c.command || '';
  el('studioMcpArgs').value = (c.args || []).join('\n');
}

async function onSaveStudioMcpConfig() {
  const command = el('studioMcpCommand').value.trim();
  const args = el('studioMcpArgs').value.split('\n').map((a) => a.trim()).filter(Boolean);
  await window.api.setStudioMcp(command ? { command, args } : {});
  alert(command ? 'Studio-MCP-Befehl gespeichert.' : 'Gespeichert — FAIG nutzt wieder den Standard (Robloxs mcp.bat).');
}

function loadComfyUiConfigIntoForm() {
  el('comfyUiBaseUrl').value = comfyUiConfig.baseUrl || 'http://127.0.0.1:8188';
  el('comfyUiWorkflowsDir').value = comfyUiConfig.workflowsDir || '';
}

async function onPickComfyUiWorkflowsDir() {
  const folder = await window.api.pickFolder({ title: 'ComfyUI-Workflow-Ordner wählen (enthält die Workflow-.json-Dateien)' });
  if (!folder) return;
  el('comfyUiWorkflowsDir').value = folder;
}

async function onSaveComfyUiConfig() {
  const config = {
    baseUrl: el('comfyUiBaseUrl').value.trim() || 'http://127.0.0.1:8188',
    workflowsDir: el('comfyUiWorkflowsDir').value.trim()
  };
  comfyUiConfig = config;
  await window.api.setComfyUi(config);
  alert('ComfyUI-Einstellungen gespeichert.');
}

async function onPickVaultPath() {
  const folder = await window.api.pickFolder({ title: 'Obsidian-Vault-Ordner wählen' });
  if (!folder) return;
  el('vaultPathInput').value = folder;
}

async function onSaveVaultPath() {
  vaultPath = el('vaultPathInput').value.trim();
  await window.api.setVaultPath(vaultPath);
  alert('Vault-Pfad gespeichert.');
}

function loadEmailAccountIntoForm() {
  el('emailFromName').value = emailAccount.fromName || '';
  el('emailFromAddress').value = emailAccount.fromAddress || '';
  el('emailHost').value = emailAccount.host || '';
  el('emailPort').value = emailAccount.port || '';
  el('emailSecure').checked = !!emailAccount.secure;
  el('emailUser').value = emailAccount.user || '';
  el('emailPass').value = emailAccount.pass || '';
}

function onEmailTemplateChange(e) {
  const tpl = EMAIL_TEMPLATES[e.target.value];
  if (!tpl) return;
  el('emailHost').value = tpl.host;
  el('emailPort').value = tpl.port;
  el('emailSecure').checked = tpl.secure;
}

async function onSaveEmailAccount() {
  const account = {
    fromName: el('emailFromName').value.trim(),
    fromAddress: el('emailFromAddress').value.trim(),
    host: el('emailHost').value.trim(),
    port: el('emailPort').value.trim(),
    secure: el('emailSecure').checked,
    user: el('emailUser').value.trim(),
    pass: el('emailPass').value
  };
  if (!account.host || !account.user || !account.pass) {
    alert('Host, Benutzername und Passwort sind Pflicht, damit das E-Mail-Tool funktionieren kann.');
    return;
  }
  emailAccount = account;
  await window.api.setEmailAccount(account);
  alert('E-Mail-Konto gespeichert.');
}

function openConnectionsModal() {
  resetConnectionForm();
  el('connectionsModal').hidden = false;
  selectSettingsSection('connections');
}

function closeConnectionsModal() {
  el('connectionsModal').hidden = true;
}

function selectSettingsSection(name) {
  document.querySelectorAll('.settings-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === name);
  });
  document.querySelectorAll('.settings-section').forEach((sec) => {
    sec.hidden = sec.dataset.sectionPanel !== name;
  });
  if (name === 'system') loadSystemSpecsIntoSettings();
}

async function loadSystemSpecsIntoSettings() {
  const gridEl = el('settingsSpecsGrid');
  const noGpuEl = el('settingsSpecsNoGpu');
  const warnEl = el('settingsSpecsWarning');
  const res = await window.api.getSystemSpecs();
  if (!res.ok) {
    gridEl.hidden = true;
    warnEl.hidden = true;
    noGpuEl.hidden = false;
    noGpuEl.textContent = `Specs konnten nicht geladen werden: ${res.error}`;
    return;
  }
  const specs = res.specs;
  if (!specs.gpus || !specs.gpus.length) {
    gridEl.hidden = true;
    noGpuEl.hidden = false;
    noGpuEl.textContent = 'Kein NVIDIA-GPU/nvidia-smi gefunden — nur RAM-Info verfügbar.';
  } else {
    gridEl.hidden = false;
    noGpuEl.hidden = true;
    const gpu = specs.gpus[0];
    el('settingsSpecsGpuName').textContent = gpu.name;
    const usedPct = Math.round((gpu.usedMb / gpu.totalMb) * 100);
    const fill = el('settingsSpecsVramFill');
    fill.style.width = `${usedPct}%`;
    fill.className = 'specs-bar-fill' + (usedPct > 90 ? ' danger' : usedPct > 70 ? ' warn' : '');
    el('settingsSpecsVramText').textContent = `${formatMb(gpu.freeMb)} frei von ${formatMb(gpu.totalMb)}`;
  }
  el('settingsSpecsRamText').textContent = `${formatMb(specs.ram.freeMb)} frei von ${formatMb(specs.ram.totalMb)}`;
  if (specs.vramConsumers && specs.vramConsumers.length) {
    warnEl.hidden = false;
    warnEl.textContent = `⚠ Belegt evtl. schon VRAM: ${specs.vramConsumers.join(', ')}`;
  } else {
    warnEl.hidden = true;
  }
}

function renderConnectionCards() {
  const container = el('connectionCards');
  container.innerHTML = '';
  if (!connections.length) {
    container.innerHTML = '<div class="note">Noch keine Connection angelegt.</div>';
    return;
  }
  for (const c of connections) {
    const detail = c.kind === 'local-gguf' ? c.modelsFolder || '(kein Ordner)' : c.baseUrl;
    const card = document.createElement('div');
    card.className = 'connection-card';
    card.innerHTML = `
      <div class="connection-card-main">
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="meta">${escapeHtml(c.kind)} · ${escapeHtml(detail)}</div>
      </div>
      <div class="connection-card-actions">
        <button class="edit-btn" data-id="${c.id}">Bearbeiten</button>
        <button class="del-btn" data-id="${c.id}">Löschen</button>
      </div>
    `;
    card.querySelector('.edit-btn').addEventListener('click', () => loadConnectionIntoForm(c.id));
    card.querySelector('.del-btn').addEventListener('click', () => onDeleteConnection(c.id));
    container.appendChild(card);
  }
}

function loadConnectionIntoForm(id) {
  const c = connections.find((x) => x.id === id);
  if (!c) return;
  editingConnectionId = id;
  el('connFormTitle').textContent = `Connection bearbeiten: ${c.name}`;
  el('connName').value = c.name;
  el('connKind').value = c.kind;
  el('connBaseUrl').value = c.baseUrl || '';
  el('connApiKey').value = c.apiKey || '';
  el('connModelsFolder').value = c.modelsFolder || '';
  toggleConnKindFields(c.kind);
  el('cancelEditBtn').hidden = false;
  el('saveConnectionBtn').textContent = 'Änderungen speichern';
}

function resetConnectionForm() {
  editingConnectionId = null;
  el('connFormTitle').textContent = 'Neue Connection';
  el('tplSelect').value = '';
  el('connName').value = '';
  el('connKind').value = 'openai-compatible';
  el('connBaseUrl').value = '';
  el('connApiKey').value = '';
  el('connModelsFolder').value = '';
  toggleConnKindFields('openai-compatible');
  el('cancelEditBtn').hidden = true;
  el('saveConnectionBtn').textContent = 'Speichern';
}

function onTemplateChange(e) {
  const tpl = TEMPLATES[e.target.value];
  if (!tpl) return;
  el('connName').value = tpl.name;
  el('connKind').value = tpl.kind;
  el('connBaseUrl').value = tpl.baseUrl || '';
  toggleConnKindFields(tpl.kind);
}

function toggleConnKindFields(kind) {
  const isLocalGguf = kind === 'local-gguf';
  el('httpFields').hidden = isLocalGguf;
  el('localGgufFields').hidden = !isLocalGguf;
}

async function onPickModelsFolder() {
  const folder = await window.api.pickFolder({
    title: 'Ordner mit .gguf-Dateien wählen (z.B. dein LM-Studio "models"-Ordner)'
  });
  if (!folder) return;
  el('connModelsFolder').value = folder;
}

async function onSaveConnection() {
  const name = el('connName').value.trim();
  const kind = el('connKind').value;
  if (!name) {
    alert('Name ist Pflicht.');
    return;
  }

  let patch;
  if (kind === 'local-gguf') {
    const modelsFolder = el('connModelsFolder').value.trim();
    if (!modelsFolder) {
      alert('Bitte einen Ordner mit .gguf-Dateien wählen.');
      return;
    }
    patch = { name, kind, modelsFolder, baseUrl: '', apiKey: '' };
  } else {
    const baseUrl = el('connBaseUrl').value.trim();
    if (!baseUrl) {
      alert('Base URL ist Pflicht.');
      return;
    }
    patch = { name, kind, baseUrl, apiKey: el('connApiKey').value, modelsFolder: '' };
  }

  if (editingConnectionId) {
    const idx = connections.findIndex((c) => c.id === editingConnectionId);
    if (idx !== -1) connections[idx] = { ...connections[idx], ...patch };
  } else {
    connections.push({ id: uid(), ...patch });
  }

  await window.api.setConnections(connections);
  renderConnectionCards();
  populateRunConnectionSelect();
  resetConnectionForm();
}

async function onDeleteConnection(id) {
  connections = connections.filter((c) => c.id !== id);
  await window.api.setConnections(connections);
  renderConnectionCards();
  populateRunConnectionSelect();
  if (editingConnectionId === id) resetConnectionForm();
}

async function onSend(opts) {
  const fromMenu = !!(opts && opts.compactOnly);
  if (!activeChat || isChatRunning(activeChat.id)) return;
  window.api.stopSpeaking();

  const connId = el('runConnection').value;
  const connection = connections.find((c) => c.id === connId);
  const model = getRunModelValue();
  const task = fromMenu ? '/compact' : el('taskInput').value.trim();
  const folder = el('folderPath').value;
  const enableShellTool = el('shellToolCheckbox').checked;
  const enableBrowserTool = el('browserToolCheckbox').checked;
  const enableEmailTool = el('emailToolCheckbox').checked;
  const enableComfyUiTool = el('comfyUiToolCheckbox').checked;
  const enableStudioMcpTool = el('studioMcpToolCheckbox').checked;
  const autopilotEnabled = el('autopilotCheckbox').checked;
  const autoCompact = el('autoCompactCheckbox').checked;
  const infiniteOutput = el('infiniteOutputCheckbox').checked;
  const reasoningEffort = el('reasoningEffortSelect').value;
  const samplingSettings = readSamplingSettingsFromForm();
  const compactOnly = task === '/compact';

  if (!connection) return alert('Bitte eine Connection wählen (Connections verwalten → anlegen/auswählen).');
  if (!model) return alert('Bitte ein Modell wählen oder eingeben.');
  if (!folder) return alert('Bitte einen Projektordner wählen.');
  if (!task) return;

  const chat = activeChat;
  if (compactOnly && !(chat.messages || []).length) return;
  const myRun = { task: compactOnly ? null : task, events: [], startedAt: Date.now() };
  runs.set(chat.id, myRun);
  updateRunUi();
  chat.connectionId = connId;
  chat.model = model;
  chat.folder = folder;
  refreshHeaderMenuLabels();
  chat.enableShellTool = enableShellTool;
  chat.enableBrowserTool = enableBrowserTool;
  chat.enableEmailTool = enableEmailTool;
  chat.enableComfyUiTool = enableComfyUiTool;
  chat.enableStudioMcpTool = enableStudioMcpTool;
  chat.autopilotEnabled = autopilotEnabled;
  chat.autoCompact = autoCompact;
  chat.infiniteOutput = infiniteOutput;
  chat.reasoningEffort = reasoningEffort;
  chat.samplingSettings = samplingSettings;
  const customSystemPrompt = el('systemPromptInput').value;
  chat.systemPrompt = customSystemPrompt;
  await window.api.updateChatSettings(chat.id, {
    connectionId: connId,
    model,
    folder,
    enableShellTool,
    enableBrowserTool,
    enableEmailTool,
    enableComfyUiTool,
    enableStudioMcpTool,
    autopilotEnabled,
    autoCompact,
    infiniteOutput,
    reasoningEffort,
    samplingSettings,
    systemPrompt: customSystemPrompt
  });

  const history = chat.messages || [];
  const isFirstMessage = history.length === 0;

  if (!fromMenu) {
    el('taskInput').value = '';
    autoGrowTextarea();
  }
  if (activeChat === chat) {
    hideEmptyState();
    live = null;
    if (compactOnly) appendNotice('Komprimiere den Verlauf...', 'info');
    else appendUserBubble(task);
  }
  renderChatList();

  if (isFirstMessage && !chat.pinned && !compactOnly) {
    const title = task.length > 40 ? task.slice(0, 40) + '…' : task;
    chat.title = title;
    if (activeChat === chat) el('chatTitleInput').value = title;
    await window.api.renameChat(chat.id, title);
    renderChatList();
  }

  let res;
  try {
    res = await window.api.runAgent({
      chatId: chat.id,
      connection,
      model,
      task,
      folder,
      enableShellTool,
      enableBrowserTool,
      enableEmailTool,
      enableComfyUiTool,
      enableStudioMcpTool,
      autopilotEnabled,
      autoCompact,
      infiniteOutput,
      compactOnly,
      reasoningEffort,
      samplingSettings,
      history,
      customSystemPrompt
    });
  } catch (err) {
    res = { ok: false, error: err.message || String(err) };
  }

  if (!res.ok && runs.get(chat.id) === myRun) {
    runs.delete(chat.id);
    if (activeChat === chat) {
      appendNotice(`Lauf fehlgeschlagen: ${res.error}`, 'error');
      updateRunUi();
    }
    renderChatList();
  }
}

async function onExportChat() {
  if (!activeChat) return;
  if (!activeChat.messages || !activeChat.messages.length) {
    alert('Dieser Chat hat noch keine Nachrichten zum Exportieren.');
    return;
  }
  const res = await window.api.exportChat(activeChat.id);
  if (res.canceled) return;
  if (!res.ok) {
    appendSystemLine(`Export fehlgeschlagen: ${res.error}`, 'error');
    return;
  }
  appendSystemLine(`Chat exportiert nach: ${res.path}`, 'result');
}

async function onMicClick() {
  if (micState === 'transcribing') return;
  if (micState === 'recording') {
    await stopRecordingAndTranscribe();
  } else if (micState === 'idle') {
    micState = 'starting';
    await startRecording();
  }
}

async function startRecording() {
  window.api.stopSpeaking();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    micState = 'idle';
    appendSystemLine(`Mikrofonzugriff fehlgeschlagen: ${err.message || err}`, 'error');
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  micAudioCtx = new AudioCtx({ sampleRate: 16000 });
  micSourceNode = micAudioCtx.createMediaStreamSource(micStream);
  micProcessorNode = micAudioCtx.createScriptProcessor(4096, 1, 1);
  micChunks = [];
  micProcessorNode.onaudioprocess = (e) => {
    micChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  const silentGain = micAudioCtx.createGain();
  silentGain.gain.value = 0;
  micSourceNode.connect(micProcessorNode);
  micProcessorNode.connect(silentGain);
  silentGain.connect(micAudioCtx.destination);

  micState = 'recording';
  el('micBtn').classList.add('recording');
  el('statusText').textContent = 'Nimmt auf... (nochmal klicken zum Stoppen)';
}

async function stopRecordingAndTranscribe() {
  const stream = micStream;
  const ctx = micAudioCtx;
  const source = micSourceNode;
  const processor = micProcessorNode;
  const chunks = micChunks;

  micState = 'transcribing';
  el('micBtn').classList.remove('recording');
  el('micBtn').classList.add('transcribing');
  el('statusText').textContent = 'Transkribiere (lokal, kann etwas dauern)...';

  try {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
  } catch {
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const samples = new Float32Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    samples.set(c, offset);
    offset += c.length;
  }

  try {
    await ctx.close();
  } catch {
  }
  micStream = null;
  micAudioCtx = null;
  micSourceNode = null;
  micProcessorNode = null;
  micChunks = [];

  if (totalLength === 0) {
    resetMicUi();
    return;
  }

  try {
    const res = await window.api.transcribeAudio(samples);
    if (res.ok && res.text) {
      const existing = el('taskInput').value;
      el('taskInput').value = existing ? `${existing} ${res.text}` : res.text;
      autoGrowTextarea();
      if (el('conversationModeCheckbox').checked && !(activeChat && isChatRunning(activeChat.id))) {
        resetMicUi();
        onSend();
        return;
      }
      el('taskInput').focus();
    } else if (res.ok && !res.text) {
      appendSystemLine('Transkription war leer (nichts Verständliches erkannt).', 'error');
    } else {
      appendSystemLine(`Transkription fehlgeschlagen: ${res.error}`, 'error');
    }
  } catch (err) {
    appendSystemLine(`Transkription fehlgeschlagen: ${err.message || err}`, 'error');
  }
  resetMicUi();
}

function resetMicUi() {
  micState = 'idle';
  el('micBtn').classList.remove('recording', 'transcribing');
  if (!(activeChat && isChatRunning(activeChat.id))) el('statusText').textContent = '';
}

async function onStop() {
  window.api.stopSpeaking();
  if (!activeChat) return;
  await window.api.stopAgent(activeChat.id);
  el('stopBtn').disabled = true;
  el('statusText').textContent = 'Stoppe...';
}

function updateRunUi() {
  const running = !!(activeChat && isChatRunning(activeChat.id));
  el('runBtn').disabled = running;
  el('stopBtn').disabled = !running;
  if (!running) el('statusText').textContent = '';
  else if (!el('statusText').textContent) el('statusText').textContent = 'Läuft...';
}

function formatMb(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const MODEL_LOAD_SPECS_PREF_KEY = 'faig.modelLoadSpecsVisible';
function modelLoadSpecsVisible() {
  return localStorage.getItem(MODEL_LOAD_SPECS_PREF_KEY) !== 'false';
}
function onToggleModelLoadSpecs() {
  const next = !modelLoadSpecsVisible();
  localStorage.setItem(MODEL_LOAD_SPECS_PREF_KEY, String(next));
  el('modelLoadSpecs').hidden = !next;
  el('specsWarning').hidden = !next;
}

function showModelLoadOverlay(evt) {
  loadingChatId = evt.chatId || null;
  const chat = chats.find((c) => c.id === loadingChatId);
  el('modelLoadChat').textContent = chat ? `für Chat: ${chat.title || 'Neuer Chat'}` : '';
  el('modelLoadName').textContent = `${evt.modelName} (${formatMb((evt.fileSizeBytes || 0) / 1024 / 1024)})`;
  el('modelLoadProgressFill').style.width = '0%';
  el('modelLoadProgressPct').textContent = 'Startet...';

  const specs = evt.specs;
  const specsEl = el('modelLoadSpecs');
  const warnEl = el('specsWarning');
  const showSpecs = modelLoadSpecsVisible();
  if (!showSpecs || !specs || !specs.gpus || !specs.gpus.length) {
    specsEl.hidden = true;
  } else {
    specsEl.hidden = false;
    const gpu = specs.gpus[0];
    el('specsGpuName').textContent = gpu.name;
    const usedPct = Math.round((gpu.usedMb / gpu.totalMb) * 100);
    const fill = el('specsVramFill');
    fill.style.width = `${usedPct}%`;
    fill.className = 'specs-bar-fill' + (usedPct > 90 ? ' danger' : usedPct > 70 ? ' warn' : '');
    el('specsVramText').textContent = `${formatMb(gpu.freeMb)} frei von ${formatMb(gpu.totalMb)}`;
    el('specsRamText').textContent = `${formatMb(specs.ram.freeMb)} frei von ${formatMb(specs.ram.totalMb)}`;
  }
  if (showSpecs && specs && specs.vramConsumers && specs.vramConsumers.length) {
    warnEl.hidden = false;
    warnEl.textContent = `⚠ Belegt evtl. schon VRAM: ${specs.vramConsumers.join(', ')}`;
  } else {
    warnEl.hidden = true;
  }

  el('modelLoadOverlay').hidden = false;
}

function updateModelLoadProgress(fraction) {
  if (el('modelLoadOverlay').hidden) return;
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  el('modelLoadProgressFill').style.width = `${pct}%`;
  el('modelLoadProgressPct').textContent = `${pct}%`;
}

function hideModelLoadOverlay() {
  el('modelLoadOverlay').hidden = true;
  loadingChatId = null;
}

const COALESCE_TYPES = new Set(['token', 'reasoning_token', 'tool_output']);
const MAX_KEPT_EVENTS = 50000;

function onAgentEvent(evt) {
  const run = evt.chatId && runs.get(evt.chatId);
  if (run) {
    const last = run.events[run.events.length - 1];
    if (
      last &&
      COALESCE_TYPES.has(evt.type) &&
      last.type === evt.type &&
      last.iteration === evt.iteration &&
      last.callId === evt.callId
    ) {
      last.text += evt.text || '';
      last.chunks = (last.chunks || 1) + 1;
    } else if (last && evt.type === 'gen_progress' && last.type === 'gen_progress') {
      last.tokens = evt.tokens;
    } else if (run.events.length < MAX_KEPT_EVENTS) {
      run.events.push({ ...evt, chunks: 1 });
    }
  }
  if (evt.type === 'model_load_start') showModelLoadOverlay(evt);
  else if (evt.type === 'model_load_progress') updateModelLoadProgress(evt.progress);
  else if (evt.type === 'local_model_status' && /geladen, generiere/.test(evt.message)) hideModelLoadOverlay();
  else if ((evt.type === 'error' || evt.type === 'stopped') && loadingChatId === evt.chatId) hideModelLoadOverlay();

  if (activeChat && evt.chatId === activeChat.id) applyEvent(evt, { replay: false });
}

function onAgentDone(payload) {
  const chat = chats.find((c) => c.id === payload.chatId);
  const messages = payload.ok ? payload.result && payload.result.messages : payload.messages;
  if (chat && messages) chat.messages = messages;
  runs.delete(payload.chatId);
  if (loadingChatId === payload.chatId) hideModelLoadOverlay();
  if (activeChat && activeChat.id === payload.chatId) {
    finishLiveTurn();
    if (!payload.ok) appendNotice(`Lauf fehlgeschlagen: ${payload.error}`, 'error');
    live = null;
    updateRunUi();
  } else if (chat) {
    chat.hasUnseenUpdate = true;
  }
  renderChatList();
}

function applyEvent(evt, { replay }) {
  switch (evt.type) {
    case 'thinking':
      startLiveTurn(evt.iteration);
      break;
    case 'reasoning_token':
      ensureLive(evt.iteration);
      noteTokens(evt);
      appendThinking(live, evt.text, { streaming: true });
      break;
    case 'token':
      ensureLive(evt.iteration);
      noteTokens(evt);
      appendAnswerText(live, evt.text);
      break;
    case 'gen_progress':
      ensureLive(evt.iteration);
      if (!live.firstTokenTs) live.firstTokenTs = Date.now();
      live.progressTokens = evt.tokens;
      break;
    case 'tool_preparing':
      ensureLive(evt.iteration);
      showPreparing(live, evt);
      break;
    case 'thinking_text':
      ensureLive(evt.iteration);
      if (!live.thinkingText) appendThinking(live, evt.text, { streaming: false });
      break;
    case 'stats':
      ensureLive(evt.iteration);
      live.stats = evt;
      break;
    case 'assistant_message':
      ensureLive(evt.iteration);
      finalizeTurn(live, evt);
      if (!replay && evt.content && el('conversationModeCheckbox').checked && !(evt.toolCalls && evt.toolCalls.length)) {
        window.api.speak(evt.content).catch(() => {
        });
      }
      break;
    case 'tool_call':
      ensureLive(evt.iteration);
      clearPreparing(live);
      addToolCard(live, { callId: evt.callId, name: evt.name, args: evt.arguments, running: true });
      break;
    case 'tool_output': {
      const card = live && live.cards.get(evt.callId);
      if (card) appendToolOutput(card, evt.text);
      break;
    }
    case 'tool_result': {
      ensureLive(evt.iteration);
      let card = live.cards.get(evt.callId);
      if (!card) card = addToolCard(live, { callId: evt.callId, name: evt.name, args: {}, running: false });
      completeToolCard(card, { result: evt.result, meta: evt.meta, durationMs: evt.durationMs, isError: evt.isError });
      break;
    }
    case 'local_model_status':
      appendNotice(evt.message, 'local');
      break;
    case 'comfy_progress':
      appendNotice(evt.message, 'info');
      break;
    case 'provider_retry':
      appendNotice(evt.message, 'warn');
      break;
    case 'notice':
      appendNotice(evt.message, evt.level || 'info');
      break;
    case 'continuation':
      appendNotice(`Token-Limit erreicht — schreibt automatisch weiter (Teil ${evt.count + 1})...`, 'info');
      break;
    case 'compacting':
      appendNotice(`Kontext wird knapp — fasse ${evt.messages} ältere Nachrichten zusammen (~${formatTokens(evt.tokens)} Tokens)...`, 'info');
      break;
    case 'compacted':
      appendCompactionDivider(evt.summary, evt.beforeTokens, evt.afterTokens);
      break;
    case 'error':
      if (live) clearPreparing(live);
      appendNotice(evt.error, 'error');
      break;
    case 'stopped':
      finishLiveTurn();
      appendNotice('Vom Nutzer gestoppt.', 'error');
      break;
    case 'max_iterations_reached':
      appendNotice(`Maximale Schrittzahl (${evt.iterations}) erreicht.`, 'error');
      break;
    case 'stuck_loop':
      appendNotice(`Abgebrochen: "${evt.name}" wurde ${evt.count || 3}x mit identischen Argumenten aufgerufen, ohne Fortschritt.`, 'error');
      break;
    case 'autopilot_cycle':
      appendNotice(`Autopilot: weiter mit dem nächsten Roadmap-Punkt (Zyklus ${evt.cycle})...`, 'local');
      break;
    case 'autopilot_max_cycles':
      appendNotice(`Autopilot: Sicherheitslimit (${evt.cycles} Zyklen) erreicht, gestoppt. Bei Bedarf "weiter" schreiben.`, 'error');
      break;
  }
}

function startLiveTurn(iteration) {
  finishLiveTurn();
  live = createTurn({ live: true });
  live.iteration = iteration;
  live.startedAt = Date.now();
  live.tokenChunks = 0;
  live.progressTokens = 0;
  live.firstTokenTs = null;
  el('messages').appendChild(live.row);
  scrollToBottom();
}

function ensureLive(iteration) {
  if (!live || (live.finalized && iteration !== undefined && live.iteration !== iteration)) startLiveTurn(iteration);
}

function noteTokens(evt) {
  if (!live.firstTokenTs) live.firstTokenTs = Date.now();
  live.tokenChunks += evt.chunks || 1;
}

function liveTokenCount(turn) {
  return Math.max(turn.tokenChunks || 0, turn.progressTokens || 0);
}

function finishLiveTurn() {
  if (!live) return;
  clearPreparing(live);
  if (!live.finalized) {
    live.finalized = true;
    live.row.classList.remove('live');
    setThinkingDone(live);
    if (live.answerText) renderAnswer(live, live.answerText);
    if (!live.thinkingText && !live.answerText && !live.cards.size) live.row.remove();
  }
}

function createTurn({ live: isLive }) {
  const row = document.createElement('div');
  row.className = 'msg-row assistant turn' + (isLive ? ' live' : '');
  const wrap = document.createElement('div');
  wrap.className = 'assistant-wrap';
  row.appendChild(wrap);
  const turn = { row, wrap, thinkingEl: null, thinkingBody: null, thinkingText: '', answerEl: null, answerText: '', cards: new Map(), finalized: false };
  if (isLive) {
    const pending = document.createElement('div');
    pending.className = 'turn-pending';
    pending.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span><span class="turn-pending-label">Wartet auf das Modell...</span>';
    wrap.appendChild(pending);
    turn.pendingEl = pending;
  }
  return turn;
}

function dropPending(turn) {
  if (turn.pendingEl) {
    turn.pendingEl.remove();
    turn.pendingEl = null;
  }
}

function appendThinking(turn, text, { streaming }) {
  if (!text) return;
  dropPending(turn);
  if (!turn.thinkingEl) {
    const details = document.createElement('details');
    details.className = 'think-block';
    if (streaming) details.open = true;
    const summary = document.createElement('summary');
    summary.innerHTML = `${ICON('brain')}<span class="think-label">${streaming ? 'Denkt nach' : 'Gedanken'}</span><span class="think-meta"></span>`;
    const body = document.createElement('div');
    body.className = 'think-text';
    details.append(summary, body);
    turn.wrap.insertBefore(details, turn.answerEl || firstCardEl(turn) || null);
    turn.thinkingEl = details;
    turn.thinkingBody = body;
  }
  turn.thinkingText += text;
  turn.thinkingBody.textContent = turn.thinkingText;
  if (turn.thinkingEl.open) turn.thinkingBody.scrollTop = turn.thinkingBody.scrollHeight;
  scrollToBottom();
}

function setThinkingDone(turn) {
  if (!turn.thinkingEl) return;
  turn.thinkingEl.open = false;
  turn.thinkingEl.querySelector('.think-label').textContent = 'Gedanken';
  const secs = turn.firstTokenTs && turn.startedAt ? ((turn.thinkDoneTs || Date.now()) - turn.startedAt) / 1000 : null;
  const words = turn.thinkingText.trim().split(/\s+/).filter(Boolean).length;
  turn.thinkingEl.querySelector('.think-meta').textContent = [secs ? `${secs.toFixed(1)}s` : '', `${words} Wörter`].filter(Boolean).join(' · ');
}

function firstCardEl(turn) {
  const first = turn.cards.values().next();
  return first.done ? null : first.value.el;
}

function appendAnswerText(turn, text) {
  if (!text) return;
  dropPending(turn);
  if (!turn.thinkDoneTs && turn.thinkingEl) turn.thinkDoneTs = Date.now();
  if (!turn.answerEl) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble assistant-bubble streaming';
    turn.wrap.insertBefore(bubble, firstCardEl(turn));
    turn.answerEl = bubble;
  }
  turn.answerText += text;
  turn.answerEl.textContent = turn.answerText;
  scrollToBottom();
}

function renderAnswer(turn, content) {
  if (!content) return;
  dropPending(turn);
  if (!turn.answerEl) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble assistant-bubble';
    turn.wrap.insertBefore(bubble, firstCardEl(turn));
    turn.answerEl = bubble;
  }
  turn.answerText = content;
  turn.answerEl.classList.remove('streaming');
  turn.answerEl.innerHTML = renderMarkdownLite(content);
}

function finalizeTurn(turn, msg) {
  dropPending(turn);
  clearPreparing(turn);
  if (msg.reasoning && !turn.thinkingText) appendThinking(turn, msg.reasoning, { streaming: false });
  setThinkingDone(turn);
  if (msg.content) renderAnswer(turn, msg.content);
  const stats = msg.stats || turn.stats;
  if (stats) appendStatsBadge(turn, stats);
  turn.finalized = true;
  turn.row.classList.remove('live');
  scrollToBottom();
}

function appendStatsBadge(turn, stats) {
  if (turn.statsEl) turn.statsEl.remove();
  const badge = document.createElement('div');
  badge.className = 'stats-badge';
  const parts = [];
  if (stats.ms != null) parts.push(`${(stats.ms / 1000).toFixed(1)}s`);
  if (stats.tokensPerSec) parts.push(`${stats.tokensPerSec} tok/s`);
  if (stats.completionTokens) parts.push(`${formatTokens(stats.completionTokens)} Tokens`);
  if (stats.promptTokens) parts.push(`Kontext ${formatTokens(stats.promptTokens)}`);
  if (stats.ttftMs != null && stats.ttftMs > 1500) parts.push(`erstes Token nach ${(stats.ttftMs / 1000).toFixed(1)}s`);
  badge.textContent = parts.join(' · ');
  turn.wrap.appendChild(badge);
  turn.statsEl = badge;
}

function showPreparing(turn, evt) {
  dropPending(turn);
  if (!turn.preparingEl) {
    turn.preparingEl = document.createElement('div');
    turn.preparingEl.className = 'tool-preparing';
    turn.wrap.appendChild(turn.preparingEl);
  }
  const d = describeTool(evt.name || '', { path: evt.path });
  const size = evt.argumentsLength ? ` · ${formatChars(evt.argumentsLength)}` : '';
  turn.preparingEl.innerHTML =
    `<span class="tool-dot running"></span>${ICON(d.icon)}<span class="tool-verb">${escapeHtml(d.verb)}</span>` +
    `<span class="tool-target">${escapeHtml(d.target || '')}</span><span class="tool-badge">wird vorbereitet${escapeHtml(size)}</span>`;
  scrollToBottom();
}

function clearPreparing(turn) {
  if (turn && turn.preparingEl) {
    turn.preparingEl.remove();
    turn.preparingEl = null;
  }
}

const TOOL_LABELS = {
  list_dir: { icon: 'folder', verb: 'Listet' },
  read_file: { icon: 'file', verb: 'Liest' },
  write_file: { icon: 'filePlus', verb: 'Schreibt' },
  str_replace_in_file: { icon: 'edit', verb: 'Bearbeitet' },
  make_dir: { icon: 'folder', verb: 'Ordner' },
  run_command: { icon: 'terminal', verb: 'Shell' },
  web_search: { icon: 'search', verb: 'Sucht' },
  web_fetch: { icon: 'globe', verb: 'Lädt' },
  export_pdf: { icon: 'file', verb: 'PDF' },
  skill_read: { icon: 'book', verb: 'Skill' },
  email_preview: { icon: 'mail', verb: 'E-Mail-Entwurf' },
  email_send: { icon: 'mail', verb: 'E-Mail senden' },
  studio_mcp_list_tools: { icon: 'cube', verb: 'Studio' },
  studio_mcp_call_tool: { icon: 'cube', verb: 'Studio' }
};

function describeTool(name, args, meta) {
  const a = args || {};
  const m = meta || {};
  let label = TOOL_LABELS[name];
  if (!label) {
    if (name.startsWith('obsidian_')) label = { icon: 'brain', verb: `Vault ${name.slice(9).replace(/_/g, ' ')}` };
    else if (name.startsWith('browser_')) label = { icon: 'globe', verb: `Browser ${name.slice(8)}` };
    else if (name.startsWith('comfyui_')) label = { icon: 'image', verb: `ComfyUI ${name.slice(8).replace(/_/g, ' ')}` };
    else label = { icon: 'tool', verb: name || 'Tool' };
  }
  let verb = label.verb;
  const target =
    a.path || a.file_path || m.path || a.command || a.query || a.url || a.workflow || a.name || a.tool_name || a.to ||
    (a.index != null ? `[${a.index}]` : '');
  const badges = [];
  if (name === 'write_file') {
    if (m.appended) verb = 'Hängt an';
    else if (m.created) verb = 'Erstellt';
    if (m.lines != null) badges.push({ text: `+${m.lines}`, cls: 'add' });
    if (m.startLine && m.appended) badges.push({ text: `ab Z. ${m.startLine}` });
  } else if (name === 'str_replace_in_file') {
    if (m.startLine) badges.push({ text: `Z. ${m.startLine}${m.added > 1 ? `–${m.startLine + m.added - 1}` : ''}` });
    if (m.removed != null) badges.push({ text: `−${m.removed}`, cls: 'del' });
    if (m.added != null) badges.push({ text: `+${m.added}`, cls: 'add' });
  } else if (name === 'read_file') {
    if (m.from && m.to) badges.push({ text: `Z. ${m.from}–${m.to}${m.lines && m.to !== m.lines ? ` von ${m.lines}` : ''}` });
    else if (a.start_line) badges.push({ text: `ab Z. ${a.start_line}` });
  } else if (name === 'list_dir') {
    if (m.entries != null) badges.push({ text: `${m.entries} Einträge` });
  } else if (name === 'run_command') {
    if (m.exitCode != null) badges.push({ text: `exit ${m.exitCode}`, cls: m.exitCode === 0 ? '' : 'del' });
  }
  return { icon: label.icon, verb, target: String(target || ''), badges };
}

function addToolCard(turn, { callId, name, args, running }) {
  dropPending(turn);
  const card = document.createElement('details');
  card.className = 'tool-card' + (running ? ' running' : '');
  const summary = document.createElement('summary');
  const body = document.createElement('div');
  body.className = 'tool-body';
  card.append(summary, body);
  turn.wrap.insertBefore(card, turn.statsEl || null);
  const entry = { el: card, summary, body, name, args: args || {}, meta: null, output: '' };
  turn.cards.set(callId || `c${turn.cards.size}`, entry);
  renderToolSummary(entry, { running });
  renderToolBody(entry, null);
  scrollToBottom();
  return entry;
}

function renderToolSummary(entry, { running, isError, durationMs }) {
  const d = describeTool(entry.name, entry.args, entry.meta);
  const badges = d.badges.map((b) => `<span class="tool-badge ${b.cls || ''}">${escapeHtml(b.text)}</span>`).join('');
  const dur = durationMs != null && durationMs >= 100 ? `<span class="tool-dur">${formatDuration(durationMs)}</span>` : '';
  entry.summary.innerHTML =
    `<span class="tool-dot ${running ? 'running' : isError ? 'error' : 'ok'}"></span>${ICON(d.icon)}` +
    `<span class="tool-verb">${escapeHtml(d.verb)}</span>` +
    `<span class="tool-target" title="${escapeAttr(d.target)}">${escapeHtml(d.target)}</span>${badges}${dur}`;
}

function renderToolBody(entry, result) {
  const { name, args, meta } = entry;
  const m = meta || {};
  const parts = [];
  if (name === 'str_replace_in_file') {
    const oldStr = m.oldStr != null ? m.oldStr : args.old_str;
    const newStr = m.newStr != null ? m.newStr : args.new_str;
    if (oldStr != null || newStr != null) parts.push(renderDiff(oldStr || '', newStr || '', m.startLine || 1));
  } else if (name === 'write_file') {
    const text = m.preview != null ? m.preview : args.content;
    if (text) parts.push(renderNumbered(text, m.startLine || 1, 60));
  } else if (name === 'run_command') {
    parts.push(`<div class="tool-cmd"><span class="prompt">$</span>${escapeHtml(args.command || m.command || '')}</div>`);
  }
  const outText = name === 'run_command' && entry.output && !result ? entry.output : result;
  if (outText != null && !(name === 'write_file' && !/^FEHLER/.test(outText)) && !(name === 'str_replace_in_file' && !/^FEHLER/.test(outText))) {
    parts.push(`<pre class="tool-result">${escapeHtml(truncate(outText, 6000))}</pre>`);
  } else if (outText != null && /^OK/.test(outText)) {
    parts.push(`<div class="tool-ok">${escapeHtml(outText)}</div>`);
  }
  if (!parts.length && args && Object.keys(args).length) {
    parts.push(`<pre class="tool-result">${escapeHtml(truncate(JSON.stringify(args, null, 2), 3000))}</pre>`);
  }
  entry.body.innerHTML = parts.join('');
}

function appendToolOutput(entry, text) {
  entry.output += text;
  let pre = entry.body.querySelector('.tool-live-output');
  if (!pre) {
    pre = document.createElement('pre');
    pre.className = 'tool-result tool-live-output';
    entry.body.appendChild(pre);
    entry.el.open = true;
  }
  pre.textContent = entry.output.length > 20000 ? `…${entry.output.slice(-20000)}` : entry.output;
  pre.scrollTop = pre.scrollHeight;
  scrollToBottom();
}

function completeToolCard(entry, { result, meta, durationMs, isError }) {
  entry.meta = meta || entry.meta;
  const failed = isError != null ? isError : /^FEHLER/.test(String(result || ''));
  entry.el.classList.remove('running');
  entry.el.classList.toggle('error', failed);
  renderToolSummary(entry, { running: false, isError: failed, durationMs });
  renderToolBody(entry, String(result ?? ''));
  if (entry.name === 'run_command') entry.el.open = false;
}

function renderDiff(oldStr, newStr, startLine) {
  const oldLines = oldStr ? oldStr.split('\n') : [];
  const newLines = newStr ? newStr.split('\n') : [];
  const rows = [];
  oldLines.forEach((line, i) => rows.push(`<div class="dl del"><span class="ln">${startLine + i}</span><span class="sg">-</span><span class="tx">${escapeHtml(line)}</span></div>`));
  newLines.forEach((line, i) => rows.push(`<div class="dl add"><span class="ln">${startLine + i}</span><span class="sg">+</span><span class="tx">${escapeHtml(line)}</span></div>`));
  return `<div class="diff">${rows.join('')}</div>`;
}

function renderNumbered(text, startLine, maxLines) {
  const lines = String(text).replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, maxLines);
  const rows = shown.map((line, i) => `<div class="dl add"><span class="ln">${startLine + i}</span><span class="sg">+</span><span class="tx">${escapeHtml(line)}</span></div>`);
  if (lines.length > maxLines) rows.push(`<div class="dl more">… ${lines.length - maxLines} weitere Zeilen</div>`);
  return `<div class="diff">${rows.join('')}</div>`;
}

function appendNotice(text, level) {
  const container = el('messages');
  const row = document.createElement('div');
  row.className = 'msg-row system';
  const cls = { error: 'notice-error', warn: 'notice-warn', local: 'notice-local', info: 'notice-info' }[level] || 'notice-info';
  row.innerHTML = `<div class="notice ${cls}">${escapeHtml(text)}</div>`;
  container.appendChild(row);
  scrollToBottom();
}

function appendCompactionDivider(summary, beforeTokens, afterTokens) {
  const container = el('messages');
  const row = document.createElement('div');
  row.className = 'msg-row system';
  const sizes = beforeTokens ? ` · ~${formatTokens(beforeTokens)} → ~${formatTokens(afterTokens || 0)} Tokens` : '';
  row.innerHTML =
    `<details class="compact-divider"><summary>${ICON('layers')}Ältere Nachrichten zusammengefasst${escapeHtml(sizes)}</summary>` +
    `<div class="compact-summary">${escapeHtml(summary || '')}</div></details>`;
  container.appendChild(row);
  scrollToBottom();
}

setInterval(() => {
  if (!activeChat || !isChatRunning(activeChat.id)) return;
  const statusEl = el('statusText');
  if (!live || live.finalized) {
    statusEl.textContent = 'Läuft...';
    return;
  }
  const tokens = liveTokenCount(live);
  if (!live.firstTokenTs || !tokens) {
    const waited = (Date.now() - live.startedAt) / 1000;
    statusEl.textContent = waited > 2 ? `Wartet auf das Modell · ${waited.toFixed(0)}s` : 'Läuft...';
    if (live.pendingEl && waited > 2) live.pendingEl.querySelector('.turn-pending-label').textContent = `Wartet auf das Modell · ${waited.toFixed(0)}s`;
    return;
  }
  const secs = Math.max(0.25, (Date.now() - live.firstTokenTs) / 1000);
  const tps = tokens / secs;
  statusEl.innerHTML = `<span class="live-dot"></span>${tps.toFixed(1)} tok/s · ${formatTokens(tokens)} Tokens`;
  if (live.thinkingEl && live.thinkingEl.open) {
    live.thinkingEl.querySelector('.think-meta').textContent = `${tps.toFixed(1)} tok/s · ${formatTokens(tokens)} Tokens`;
  }
}, 250);

function formatTokens(n) {
  n = Number(n) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function formatChars(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k Zeichen` : `${n} Zeichen`;
}

function formatDuration(ms) {
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

const ICON_PATHS = {
  brain: 'M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  filePlus: 'M6 3h8l4 4v14H6zM14 3v4h4M12 11v6M9 14h6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  book: 'M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5l3 3 5.8-5.8a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5'
};

function ICON(name) {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_PATHS[name] || ICON_PATHS.tool}"/></svg>`;
}

function hideEmptyState() {
  const empty = el('emptyState');
  if (empty) empty.remove();
}

function renderTranscript() {
  const container = el('messages');
  container.innerHTML = '';
  live = null;
  const chat = activeChat;
  const messages = (chat && chat.messages) || [];
  const run = chat && runs.get(chat.id);
  if (!messages.length && !run) {
    container.innerHTML =
      '<div class="empty-state" id="emptyState">Wähle oben eine Connection, ein Modell und einen Projektordner — dann leg los.</div>';
    return;
  }
  const used = new Set();
  messages.forEach((m, idx) => {
    if (m.compactedSummary) appendCompactionDivider(m.compactedSummary);
    if (m.role === 'user') {
      appendUserBubble(m.content);
    } else if (m.role === 'assistant') {
      const turn = createTurn({ live: false });
      container.appendChild(turn.row);
      const reasoning = m.reasoning || (m.thinking || []).map((t) => t.thinking).filter(Boolean).join('\n\n');
      if (reasoning) appendThinking(turn, reasoning, { streaming: false });
      setThinkingDone(turn);
      if (m.content) renderAnswer(turn, m.content);
      const following = [];
      for (let k = idx + 1; k < messages.length && messages[k].role === 'tool'; k++) following.push(messages[k]);
      for (const tc of m.toolCalls || []) {
        const entry = addToolCard(turn, { callId: tc.id, name: tc.name, args: tc.arguments, running: false });
        const res = following.find((t) => t.toolCallId === tc.id && !used.has(t)) || following.find((t) => !used.has(t));
        if (res) {
          used.add(res);
          completeToolCard(entry, { result: res.content, meta: res.meta, durationMs: res.durationMs });
        } else {
          completeToolCard(entry, { result: '(kein Ergebnis — der Lauf endete vorher)', isError: false });
        }
      }
      if (m.stats) appendStatsBadge(turn, m.stats);
      turn.finalized = true;
    } else if (m.role === 'tool' && !used.has(m)) {
      appendNotice(truncate(m.content, 1500), 'info');
    }
  });
  if (run) {
    if (run.task) appendUserBubble(run.task);
    for (const evt of run.events) applyEvent(evt, { replay: true });
  }
  container.scrollTop = container.scrollHeight;
}

function appendUserBubble(text) {
  const container = el('messages');
  const row = document.createElement('div');
  row.className = 'msg-row user';
  row.innerHTML = `<div class="bubble user-bubble">${escapeHtml(text)}</div>`;
  container.appendChild(row);
  scrollToBottom();
}

function renderMarkdownLite(text) {
  const escaped = escapeHtml(text);
  const parts = escaped.split(/```(\w*)\n?([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 3) {
    html += inlineFormat(parts[i] || '');
    if (parts[i + 1] !== undefined) {
      const lang = parts[i + 1];
      const code = parts[i + 2];
      const codeId = `code-${Math.random().toString(36).slice(2, 9)}`;
      html +=
        `<div class="code-block"><div class="code-block-header"><span>${escapeHtml(lang) || 'code'}</span>` +
        `<button class="copy-code-btn" data-target="${codeId}" type="button">Kopieren</button></div>` +
        `<pre><code id="${codeId}">${code}</code></pre></div>`;
    }
  }
  return html;
}

function inlineFormat(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');
}

function appendSystemLine(text, kind) {
  appendNotice(text, kind === 'error' ? 'error' : kind === 'local' ? 'local' : 'info');
}

function scrollToBottom() {
  const container = el('messages');
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (distanceFromBottom < 120) {
    container.scrollTop = container.scrollHeight;
  }
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '\n[...gekürzt...]' : s;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

init();
