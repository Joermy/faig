const TEMPLATES = {
  openrouter: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', name: 'OpenRouter' },
  ollama: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', name: 'Ollama (lokal)' },
  lmstudio: { kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', name: 'LM Studio (lokal)' },
  localgguf: { kind: 'local-gguf', name: 'Lokales GGUF-Modell' },
  openai: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI' },
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
let isRunning = false;
let emailAccount = {};
let comfyUiConfig = { baseUrl: 'http://127.0.0.1:8188', workflowsDir: '' };
let vaultPath = '';

const SAMPLING_FIELD_IDS = [
  'samplingTemperature', 'samplingTopP', 'samplingTopK', 'samplingMinP', 'samplingRepeatPenalty',
  'samplingRepeatLastN', 'samplingMaxTokens', 'samplingSeed', 'samplingStopSequences',
  'samplingContextSize', 'samplingGpuLayers', 'samplingThreads', 'samplingBatchSize', 'samplingFlashAttention'
];

let streamingBubbleEl = null;
let streamingBubbleTextEl = null;
let streamingWrapEl = null;
let pendingStats = null;
let thinkingIndicatorRow = null;

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
      } else if (isRunning) {
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
      <span class="chat-item-title">${c.pinned ? '📌 ' : ''}${escapeHtml(pinTitle)}</span>
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
  if (isRunning) {
    appendSystemLine('Bitte warte, bis der aktuelle Lauf fertig ist (oder stoppe ihn), bevor du den Chat wechselst.', 'error');
    return;
  }
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  activeChat = chat;
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
  el('clearHistoryBtn').hidden = !chat.pinned;
  updateToolsMenuCount();
  el('reasoningEffortSelect').value = chat.reasoningEffort || 'medium';
  loadSamplingSettingsIntoForm(chat.samplingSettings);
  el('systemPromptInput').value = chat.systemPrompt || '';
  el('systemPromptView').textContent = 'Noch nicht geladen — 🔄 klicken.';

  populateRunConnectionSelect();
  if (chat.connectionId) el('runConnection').value = chat.connectionId;
  setModelDropdownSingleValue(chat.model || '');

  renderTranscript();
}

async function onClearHistory() {
  if (!activeChat || !activeChat.pinned) return;
  if (!confirm(`Nachrichtenverlauf von "${activeChat.title || 'diesem Chat'}" wirklich löschen? Connection/Ordner/Tools/Einstellungen bleiben erhalten.`)) return;
  await window.api.stopAgent();
  setRunning(false);
  resetStreamingState();
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
  chats = await window.api.deleteChat(id);
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
    btn.textContent = '🎯 Automatisch für meine Hardware optimieren';
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

async function onSend() {
  if (isRunning || !activeChat) return;
  window.api.stopSpeaking();

  const connId = el('runConnection').value;
  const connection = connections.find((c) => c.id === connId);
  const model = getRunModelValue();
  const task = el('taskInput').value.trim();
  const folder = el('folderPath').value;
  const enableShellTool = el('shellToolCheckbox').checked;
  const enableBrowserTool = el('browserToolCheckbox').checked;
  const enableEmailTool = el('emailToolCheckbox').checked;
  const enableComfyUiTool = el('comfyUiToolCheckbox').checked;
  const enableStudioMcpTool = el('studioMcpToolCheckbox').checked;
  const autopilotEnabled = el('autopilotCheckbox').checked;
  const reasoningEffort = el('reasoningEffortSelect').value;
  const samplingSettings = readSamplingSettingsFromForm();

  if (!connection) return alert('Bitte eine Connection wählen (Connections verwalten → anlegen/auswählen).');
  if (!model) return alert('Bitte ein Modell wählen oder eingeben.');
  if (!folder) return alert('Bitte einen Projektordner wählen.');
  if (!task) return;

  activeChat.connectionId = connId;
  activeChat.model = model;
  activeChat.folder = folder;
  refreshHeaderMenuLabels();
  activeChat.enableShellTool = enableShellTool;
  activeChat.enableBrowserTool = enableBrowserTool;
  activeChat.enableEmailTool = enableEmailTool;
  activeChat.enableComfyUiTool = enableComfyUiTool;
  activeChat.enableStudioMcpTool = enableStudioMcpTool;
  activeChat.autopilotEnabled = autopilotEnabled;
  activeChat.reasoningEffort = reasoningEffort;
  activeChat.samplingSettings = samplingSettings;
  const customSystemPrompt = el('systemPromptInput').value;
  activeChat.systemPrompt = customSystemPrompt;
  await window.api.updateChatSettings(activeChat.id, {
    connectionId: connId,
    model,
    folder,
    enableShellTool,
    enableBrowserTool,
    enableEmailTool,
    enableComfyUiTool,
    enableStudioMcpTool,
    autopilotEnabled,
    reasoningEffort,
    samplingSettings,
    systemPrompt: customSystemPrompt
  });

  const history = activeChat.messages || [];
  const isFirstMessage = history.length === 0;

  el('taskInput').value = '';
  autoGrowTextarea();
  hideEmptyState();
  appendUserBubble(task);
  resetStreamingState();
  setRunning(true);

  let res;
  try {
    res = await window.api.runAgent({
      chatId: activeChat.id,
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
      reasoningEffort,
      samplingSettings,
      history,
      customSystemPrompt
    });
  } catch (err) {
    appendSystemLine(`Lauf fehlgeschlagen: ${err.message || err}`, 'error');
    setRunning(false);
    return;
  }

  if (!res.ok) {
    appendSystemLine(`Lauf fehlgeschlagen: ${res.error}`, 'error');
    setRunning(false);
  }

  if (isFirstMessage && !activeChat.pinned) {
    const title = task.length > 40 ? task.slice(0, 40) + '…' : task;
    activeChat.title = title;
    el('chatTitleInput').value = title;
    await window.api.renameChat(activeChat.id, title);
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
  el('micBtn').textContent = '⏺';
  el('statusText').textContent = '🎤 Nimmt auf... (nochmal klicken zum Stoppen)';
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
  el('micBtn').textContent = '⏳';
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
      if (el('conversationModeCheckbox').checked && !isRunning) {
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
  el('micBtn').textContent = '🎤';
  if (!isRunning) el('statusText').textContent = '';
}

async function onStop() {
  window.api.stopSpeaking();
  await window.api.stopAgent();
  el('stopBtn').disabled = true;
  el('statusText').textContent = 'Stoppe...';
}

function setRunning(running) {
  isRunning = running;
  el('runBtn').disabled = running;
  el('stopBtn').disabled = !running;
  el('statusText').textContent = running ? 'Läuft...' : '';
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
}

function onAgentEvent(evt) {
  switch (evt.type) {
    case 'thinking':
      showThinkingIndicator();
      break;
    case 'token':
      removeThinkingIndicator();
      appendToken(evt.text);
      break;
    case 'thinking_text':
      removeThinkingIndicator();
      appendSystemLine(truncate(evt.text, 2000), 'think');
      break;
    case 'stats':
      pendingStats = evt;
      break;
    case 'assistant_message':
      removeThinkingIndicator();
      if (evt.content) finalizeAssistantMessage(evt.content, pendingStats);
      pendingStats = null;
      if (evt.content && el('conversationModeCheckbox').checked) {
        window.api.speak(evt.content).catch(() => {
        });
      }
      break;
    case 'tool_call':
      removeThinkingIndicator();
      appendSystemLine(`🔧 ${evt.name}(${JSON.stringify(evt.arguments)})`, 'tool');
      break;
    case 'tool_result':
      appendSystemLine(truncate(evt.result, 1500), 'result');
      break;
    case 'local_model_status':
      appendSystemLine(evt.message, 'local');
      if (/geladen, generiere/.test(evt.message)) hideModelLoadOverlay();
      break;
    case 'model_load_start':
      showModelLoadOverlay(evt);
      break;
    case 'model_load_progress':
      updateModelLoadProgress(evt.progress);
      break;
    case 'comfy_progress':
      appendSystemLine(`🎬 ${evt.message}`, 'result');
      break;
    case 'error':
      removeThinkingIndicator();
      hideModelLoadOverlay();
      appendSystemLine(evt.error, 'error');
      break;
    case 'stopped':
      removeThinkingIndicator();
      hideModelLoadOverlay();
      appendSystemLine('Vom Nutzer gestoppt.', 'error');
      break;
    case 'max_iterations_reached':
      appendSystemLine(`Maximale Schrittzahl (${evt.iterations}) erreicht.`, 'error');
      break;
    case 'stuck_loop':
      removeThinkingIndicator();
      appendSystemLine(`Abgebrochen: "${evt.name}" wurde ${evt.count || 3}x mit identischen Argumenten aufgerufen, ohne Fortschritt.`, 'error');
      break;
    case 'autopilot_cycle':
      appendSystemLine(`🚀 Autopilot: weiter mit dem nächsten Roadmap-Punkt (Zyklus ${evt.cycle})...`, 'local');
      break;
    case 'autopilot_max_cycles':
      appendSystemLine(`🚀 Autopilot: Sicherheitslimit (${evt.cycles} Zyklen) erreicht, gestoppt. Bei Bedarf "weiter" schreiben.`, 'error');
      break;
  }
}

function onAgentDone(payload) {
  setRunning(false);
  removeThinkingIndicator();
  hideModelLoadOverlay();
  resetStreamingState();
  if (payload.ok && payload.result && payload.result.messages && activeChat) {
    activeChat.messages = payload.result.messages;
    const idx = chats.findIndex((c) => c.id === activeChat.id);
    if (idx !== -1) chats[idx] = activeChat;
  }
}

function resetStreamingState() {
  streamingBubbleEl = null;
  streamingBubbleTextEl = null;
  streamingWrapEl = null;
  pendingStats = null;
}

function hideEmptyState() {
  const empty = el('emptyState');
  if (empty) empty.remove();
}

function renderTranscript() {
  const container = el('messages');
  container.innerHTML = '';
  const messages = (activeChat && activeChat.messages) || [];
  if (!messages.length) {
    container.innerHTML =
      '<div class="empty-state" id="emptyState">Wähle oben eine Connection, ein Modell und einen Projektordner — dann leg los.</div>';
    return;
  }
  for (const m of messages) {
    if (m.role === 'user') {
      appendUserBubble(m.content);
    } else if (m.role === 'assistant') {
      if (m.content) finalizeAssistantMessage(m.content, null);
      for (const tc of m.toolCalls || []) {
        appendSystemLine(`🔧 ${tc.name}(${JSON.stringify(tc.arguments)})`, 'tool');
      }
    } else if (m.role === 'tool') {
      appendSystemLine(truncate(m.content, 1500), 'result');
    }
  }
}

function appendUserBubble(text) {
  const container = el('messages');
  const row = document.createElement('div');
  row.className = 'msg-row user';
  row.innerHTML = `<div class="bubble user-bubble">${escapeHtml(text)}</div>`;
  container.appendChild(row);
  scrollToBottom();
}

function beginStreamBubble() {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  const wrap = document.createElement('div');
  wrap.className = 'assistant-wrap';
  const details = document.createElement('details');
  details.className = 'thinking-details';
  const summary = document.createElement('summary');
  summary.textContent = '💭 Denkt...';
  const pre = document.createElement('pre');
  pre.className = 'thinking-content';
  details.appendChild(summary);
  details.appendChild(pre);
  wrap.appendChild(details);
  row.appendChild(wrap);
  el('messages').appendChild(row);

  streamingBubbleEl = details;
  streamingBubbleTextEl = pre;
  streamingWrapEl = wrap;
  scrollToBottom();
}

function appendToken(text) {
  if (!streamingBubbleTextEl) beginStreamBubble();
  streamingBubbleTextEl.textContent += text;
  scrollToBottom();
}

function finalizeAssistantMessage(content, statsEvt) {
  let wrap;
  if (streamingBubbleEl) {
    wrap = streamingWrapEl;
    if (content) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble assistant-bubble';
      bubble.innerHTML = renderMarkdownLite(content);
      wrap.appendChild(bubble);
    }
  } else {
    const row = document.createElement('div');
    row.className = 'msg-row assistant';
    wrap = document.createElement('div');
    wrap.className = 'assistant-wrap';
    const bubble = document.createElement('div');
    bubble.className = 'bubble assistant-bubble';
    bubble.innerHTML = renderMarkdownLite(content);
    wrap.appendChild(bubble);
    row.appendChild(wrap);
    el('messages').appendChild(row);
  }
  if (statsEvt) appendStatsBadge(wrap, statsEvt);

  streamingBubbleEl = null;
  streamingBubbleTextEl = null;
  streamingWrapEl = null;
  scrollToBottom();
}

function appendStatsBadge(wrap, statsEvt) {
  const badge = document.createElement('div');
  badge.className = 'stats-badge';
  const secs = (statsEvt.ms / 1000).toFixed(1);
  const parts = [`⏱ ${secs}s`];
  if (statsEvt.tokensPerSec) parts.push(`${statsEvt.tokensPerSec} tok/s`);
  else if (statsEvt.completionTokens) parts.push(`${statsEvt.completionTokens} tokens`);
  badge.textContent = parts.join(' · ');
  wrap.appendChild(badge);
}

function showThinkingIndicator() {
  removeThinkingIndicator();
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML =
    '<div class="bubble assistant-bubble thinking-bubble"><span class="thinking-dots"><span></span><span></span><span></span></span></div>';
  el('messages').appendChild(row);
  thinkingIndicatorRow = row;
  scrollToBottom();
}

function removeThinkingIndicator() {
  if (thinkingIndicatorRow) {
    thinkingIndicatorRow.remove();
    thinkingIndicatorRow = null;
  }
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
  const container = el('messages');
  const row = document.createElement('div');
  row.className = 'msg-row system';
  const tagClass = { think: 'tag-think', tool: 'tag-tool', result: 'tag-result', error: 'tag-error', local: 'tag-result' }[kind] || 'tag-think';
  const tagLabel = { think: 'Denkt', tool: 'Tool', result: 'Ergebnis', error: 'Fehler', local: 'Lokales Modell' }[kind] || kind;
  row.innerHTML = `<div class="sysline"><span class="tag ${tagClass}">${tagLabel}</span>${escapeHtml(text)}</div>`;
  container.appendChild(row);
  scrollToBottom();
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

init();
