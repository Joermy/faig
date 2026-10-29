const { app, BrowserWindow, ipcMain, dialog, shell, session, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'FAIG-Data'));
}

const Store = require('electron-store');

const { listModels } = require('./src/providers');
const { runAgent, systemPromptFor } = require('./src/agentLoop');
const { closeBrowser } = require('./src/tools/browserTools');
const { closeStudioMcpClients } = require('./src/tools/studioMcpTools');
const { disposeWorker: disposeLocalGgufWorker, recommendSettings: recommendLocalGgufSettings } = require('./src/providers/localGguf');
const { transcribe } = require('./src/speech/whisper');
const tts = require('./src/speech/tts');
const { getSystemSpecs } = require('./src/systemSpecs');

const store = new Store({
  name: 'freeagent-config',
  defaults: {
    connections: [],
    chats: [],
    lastFolder: '',
    lastConnectionId: '',
    lastModel: '',
    lastChatId: '',
    enableShellTool: false,
    emailAccount: {},
    comfyui: { baseUrl: 'http://127.0.0.1:8188', workflowsDir: '' },
    vaultPath: ''
  }
});

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let mainWindow;
const activeRuns = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    title: 'FAIG',
    backgroundColor: '#08090b',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#08090b', symbolColor: '#8a919c', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function cleanupChildProcesses() {
  try {
    closeBrowser();
  } catch {
  }
  try {
    disposeLocalGgufWorker();
  } catch {
  }
  closeStudioMcpClients().catch(() => {});
}

app.on('before-quit', cleanupChildProcesses);

process.on('SIGINT', () => {
  cleanupChildProcesses();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupChildProcesses();
  process.exit(0);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('config:get', () => store.store);

ipcMain.handle('config:setConnections', (_evt, connections) => {
  store.set('connections', connections);
  return store.store;
});

ipcMain.handle('config:setLast', (_evt, { folder, connectionId, model, chatId }) => {
  if (folder !== undefined) store.set('lastFolder', folder);
  if (connectionId !== undefined) store.set('lastConnectionId', connectionId);
  if (model !== undefined) store.set('lastModel', model);
  if (chatId !== undefined) store.set('lastChatId', chatId);
  return store.store;
});

ipcMain.handle('config:setShellTool', (_evt, enabled) => {
  store.set('enableShellTool', !!enabled);
  return store.store;
});

ipcMain.handle('config:setEmailAccount', (_evt, account) => {
  store.set('emailAccount', account || {});
  return store.store;
});

ipcMain.handle('config:setComfyUi', (_evt, comfyui) => {
  store.set('comfyui', comfyui || { baseUrl: 'http://127.0.0.1:8188', workflowsDir: '' });
  return store.store;
});

ipcMain.handle('config:setVaultPath', (_evt, vaultPath) => {
  store.set('vaultPath', vaultPath || '');
  return store.store;
});

ipcMain.handle('config:setStudioMcp', (_evt, studioMcpConfig) => {
  store.set('studioMcp', studioMcpConfig || {});
  return store.store;
});

ipcMain.handle('chats:list', () => store.get('chats'));

ipcMain.handle('chats:create', (_evt, partial) => {
  const chat = {
    id: uid(),
    title: (partial && partial.title) || 'Neuer Chat',
    connectionId: (partial && partial.connectionId) || '',
    model: (partial && partial.model) || '',
    folder: (partial && partial.folder) || '',
    enableShellTool: !!(partial && partial.enableShellTool),
    enableBrowserTool: !!(partial && partial.enableBrowserTool),
    enableEmailTool: !!(partial && partial.enableEmailTool),
    enableComfyUiTool: !!(partial && partial.enableComfyUiTool),
    enableStudioMcpTool: !!(partial && partial.enableStudioMcpTool),
    autopilotEnabled: !!(partial && partial.autopilotEnabled),
    autoCompact: partial && partial.autoCompact === false ? false : true,
    infiniteOutput: !!(partial && partial.infiniteOutput),
    reasoningEffort: (partial && partial.reasoningEffort) || 'medium',
    samplingSettings: (partial && partial.samplingSettings) || {},
    systemPrompt: (partial && partial.systemPrompt) || '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const chats = store.get('chats');
  chats.unshift(chat);
  store.set('chats', chats);
  store.set('lastChatId', chat.id);
  return chat;
});

ipcMain.handle('chats:rename', (_evt, { id, title }) => {
  const chats = store.get('chats');
  const chat = chats.find((c) => c.id === id);
  if (chat) {
    chat.title = title;
    chat.updatedAt = Date.now();
    store.set('chats', chats);
  }
  return chats;
});

ipcMain.handle(
  'chats:updateSettings',
  (_evt, params) => {
    const {
      id,
      connectionId,
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
      systemPrompt
    } = params;
    const chats = store.get('chats');
    const chat = chats.find((c) => c.id === id);
    if (chat) {
      if (connectionId !== undefined) chat.connectionId = connectionId;
      if (model !== undefined) chat.model = model;
      if (folder !== undefined) chat.folder = folder;
      if (enableShellTool !== undefined) chat.enableShellTool = !!enableShellTool;
      if (enableBrowserTool !== undefined) chat.enableBrowserTool = !!enableBrowserTool;
      if (enableEmailTool !== undefined) chat.enableEmailTool = !!enableEmailTool;
      if (enableComfyUiTool !== undefined) chat.enableComfyUiTool = !!enableComfyUiTool;
      if (enableStudioMcpTool !== undefined) chat.enableStudioMcpTool = !!enableStudioMcpTool;
      if (autopilotEnabled !== undefined) chat.autopilotEnabled = !!autopilotEnabled;
      if (autoCompact !== undefined) chat.autoCompact = !!autoCompact;
      if (infiniteOutput !== undefined) chat.infiniteOutput = !!infiniteOutput;
      if (reasoningEffort !== undefined) chat.reasoningEffort = reasoningEffort;
      if (samplingSettings !== undefined) chat.samplingSettings = samplingSettings;
      if (systemPrompt !== undefined) chat.systemPrompt = systemPrompt;
      chat.updatedAt = Date.now();
      store.set('chats', chats);
    }
    return chat;
  }
);

ipcMain.handle('chats:clearMessages', (_evt, id) => {
  const chats = store.get('chats');
  const chat = chats.find((c) => c.id === id);
  if (chat && chat.pinned) {
    const run = activeRuns.get(id);
    if (run) run.stop();
    chat.messages = [];
    chat.updatedAt = Date.now();
    store.set('chats', chats);
  }
  return chat;
});

ipcMain.handle('chats:delete', (_evt, id) => {
  const before = store.get('chats');
  const target = before.find((c) => c.id === id);
  if (target && target.pinned) return before;
  const run = activeRuns.get(id);
  if (run) run.stop();
  const chats = before.filter((c) => c.id !== id);
  store.set('chats', chats);
  if (store.get('lastChatId') === id) store.set('lastChatId', '');
  return chats;
});

ipcMain.handle('dialog:pickFolder', async (_evt, opts) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: (opts && opts.title) || 'Ordner wählen',
    buttonLabel: 'Diesen Ordner auswählen'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:openPath', (_evt, targetPath) => shell.openPath(targetPath));

function roleLabel(role) {
  if (role === 'user') return '🧑 Du';
  if (role === 'assistant') return '🤖 FAIG';
  if (role === 'tool') return '🔧 Tool-Ergebnis';
  return role;
}

ipcMain.handle('chats:export', async (_evt, { id }) => {
  const chats = store.get('chats');
  const chat = chats.find((c) => c.id === id);
  if (!chat) return { ok: false, error: 'Chat nicht gefunden.' };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Chat als Markdown exportieren',
    defaultPath: `${(chat.title || 'chat').replace(/[\\/:*?"<>|]/g, '_')}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  const lines = [`# ${chat.title || 'Chat'}`, ''];
  for (const m of chat.messages || []) {
    if (m.role === 'tool') {
      lines.push(`**${roleLabel('tool')} (${m.name || '?'}):**`, '```', String(m.content || ''), '```', '');
      continue;
    }
    if (m.compactedSummary) lines.push('---', `_Ältere Nachrichten für das Modell zusammengefasst:_`, '', m.compactedSummary, '---', '');
    if (!m.content && !(m.toolCalls && m.toolCalls.length)) continue;
    if (m.role === 'assistant' && m.reasoning) lines.push('<details><summary>Gedanken</summary>', '', m.reasoning, '', '</details>', '');
    lines.push(`**${roleLabel(m.role)}:**`, '', String(m.content || '_(kein Text, nur Tool-Aufrufe)_'), '');
    if (m.toolCalls && m.toolCalls.length) {
      for (const tc of m.toolCalls) {
        lines.push(`_Tool-Aufruf: ${tc.name}(${JSON.stringify(tc.arguments || {})})_`, '');
      }
    }
  }
  fs.writeFileSync(result.filePath, lines.join('\n'), 'utf8');
  return { ok: true, path: result.filePath };
});

ipcMain.handle('models:list', async (_evt, connection) => {
  try {
    const models = await listModels(connection);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('system:getSpecs', async () => {
  try {
    return { ok: true, specs: await getSystemSpecs() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('agent:getSystemPrompt', (_evt, params) => {
  const { folder, enableBrowserTool, enableEmailTool, enableComfyUiTool, enableStudioMcpTool, autopilotEnabled, customSystemPrompt } = params;
  try {
    const prompt = systemPromptFor(folder, customSystemPrompt, {
      vaultPath: store.get('vaultPath'),
      enableBrowserTool,
      enableEmailTool,
      enableComfyUiTool,
      enableStudioMcpTool,
      autopilotEnabled
    });
    return { ok: true, prompt };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('system:getBuildInfo', () => {
  try {
    const { execFileSync } = require('child_process');
    const opts = { cwd: __dirname, encoding: 'utf8' };
    const commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    const commitDate = execFileSync('git', ['log', '-1', '--format=%cI'], opts).trim();
    return { ok: true, commitHash, commitDate };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('models:recommendSettings', async (_evt, { connection, model }) => {
  if (!connection || connection.kind !== 'local-gguf') {
    return { ok: false, error: 'Automatische Hardware-Optimierung gibt es nur für lokale .gguf-Connections.' };
  }
  try {
    const recommendation = await recommendLocalGgufSettings({ modelsFolder: connection.modelsFolder, model });
    return { ok: true, recommendation };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

const AUTOPILOT_WAIT_MARKER = '[WARTE AUF NUTZER]';
const AUTOPILOT_DONE_MARKER = '[ROADMAP FERTIG]';
const AUTOPILOT_CONTINUE_TASK = 'Fahre mit dem nächsten offenen Punkt der Roadmap fort.';
const AUTOPILOT_MAX_CYCLES = 25;

ipcMain.handle('agent:run', async (evt, params) => {
  const {
    chatId,
    connection,
    model,
    task,
    folder,
    enableShellTool,
    enableBrowserTool,
    enableEmailTool,
    enableComfyUiTool,
    enableStudioMcpTool,
    reasoningEffort,
    samplingSettings,
    history,
    customSystemPrompt,
    autopilotEnabled,
    autoCompact,
    infiniteOutput,
    compactOnly
  } = params;
  const sender = evt.sender;
  const send = (channel, payload) => {
    if (!sender.isDestroyed()) sender.send(channel, { ...payload, chatId });
  };

  if (chatId && activeRuns.has(chatId)) {
    return { ok: false, error: 'In diesem Chat läuft schon ein Lauf.' };
  }
  const abortController = new AbortController();
  const controller = {
    stopped: false,
    signal: abortController.signal,
    stop() {
      this.stopped = true;
      abortController.abort();
    }
  };
  if (chatId) activeRuns.set(chatId, controller);

  const persistMessages = (messages) => {
    if (!chatId || !messages) return;
    const chats = store.get('chats');
    const chat = chats.find((c) => c.id === chatId);
    if (chat) {
      chat.messages = messages;
      chat.updatedAt = Date.now();
      store.set('chats', chats);
    }
  };

  let displayLog = [];
  const runOnce = (currentTask, currentHistory, extra = {}) =>
    runAgent({
      connection,
      model,
      task: currentTask,
      folder,
      vaultPath: store.get('vaultPath'),
      enableShellTool,
      enableBrowserTool,
      browserProfileDir: path.join(app.getPath('userData'), 'faig-browser-profile'),
      enableEmailTool,
      emailAccount: store.get('emailAccount'),
      enableComfyUiTool,
      comfyUiConfig: store.get('comfyui'),
      enableStudioMcpTool,
      studioMcpConfig: store.get('studioMcp'),
      reasoningEffort,
      samplingSettings,
      history: currentHistory,
      customSystemPrompt,
      autopilotEnabled,
      autoCompact: autoCompact !== false,
      infiniteOutput: !!infiniteOutput,
      controller,
      onEvent: (evtObj) => send('agent:event', evtObj),
      onCheckpoint: (messages) => persistMessages(displayLog.concat(messages)),
      ...extra
    });

  try {
    let result = await runOnce(task, history, compactOnly ? { compactOnly: true } : {});
    displayLog = result.messages;
    persistMessages(displayLog);

    if (autopilotEnabled && !compactOnly) {
      let cycles = 0;
      while (
        !controller.stopped &&
        !result.stopped &&
        !result.emptyFailure &&
        result.finalMessage &&
        !result.finalMessage.includes(AUTOPILOT_WAIT_MARKER) &&
        !result.finalMessage.includes(AUTOPILOT_DONE_MARKER) &&
        cycles < AUTOPILOT_MAX_CYCLES
      ) {
        cycles++;
        send('agent:event', { type: 'autopilot_cycle', cycle: cycles });
        result = await runOnce(AUTOPILOT_CONTINUE_TASK, []);
        displayLog = displayLog.concat(result.messages);
        persistMessages(displayLog);
      }
      if (cycles >= AUTOPILOT_MAX_CYCLES) {
        send('agent:event', { type: 'autopilot_max_cycles', cycles });
      }
    }

    send('agent:done', { ok: true, result: { ...result, messages: displayLog } });
    return { ok: true };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    const messages = err && err.messages ? displayLog.concat(err.messages) : displayLog.length ? displayLog : null;
    persistMessages(messages);
    send('agent:done', { ok: false, error: message, messages });
    return { ok: false, error: message };
  } finally {
    if (chatId && activeRuns.get(chatId) === controller) activeRuns.delete(chatId);
  }
});

ipcMain.handle('agent:stop', (_evt, chatId) => {
  if (chatId) {
    const run = activeRuns.get(chatId);
    if (run) run.stop();
  } else {
    for (const run of activeRuns.values()) run.stop();
  }
  return true;
});

ipcMain.handle('agent:running', () => [...activeRuns.keys()]);

ipcMain.handle('audio:transcribe', async (_evt, samples) => {
  try {
    const text = await transcribe(samples);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('tts:speak', async (_evt, text) => {
  try {
    await tts.speak(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('tts:stop', () => {
  tts.stop();
  return true;
});
