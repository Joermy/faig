const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConnections: (connections) => ipcRenderer.invoke('config:setConnections', connections),
  setLast: (last) => ipcRenderer.invoke('config:setLast', last),
  setShellTool: (enabled) => ipcRenderer.invoke('config:setShellTool', enabled),
  setEmailAccount: (account) => ipcRenderer.invoke('config:setEmailAccount', account),
  setComfyUi: (comfyui) => ipcRenderer.invoke('config:setComfyUi', comfyui),
  setVaultPath: (vaultPath) => ipcRenderer.invoke('config:setVaultPath', vaultPath),
  setStudioMcp: (studioMcpConfig) => ipcRenderer.invoke('config:setStudioMcp', studioMcpConfig),

  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  listChats: () => ipcRenderer.invoke('chats:list'),
  createChat: (partial) => ipcRenderer.invoke('chats:create', partial),
  renameChat: (id, title) => ipcRenderer.invoke('chats:rename', { id, title }),
  updateChatSettings: (id, settings) => ipcRenderer.invoke('chats:updateSettings', { id, ...settings }),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),
  clearChatMessages: (id) => ipcRenderer.invoke('chats:clearMessages', id),
  exportChat: (id) => ipcRenderer.invoke('chats:export', { id }),

  listModels: (connection) => ipcRenderer.invoke('models:list', connection),

  getSystemSpecs: () => ipcRenderer.invoke('system:getSpecs'),
  getBuildInfo: () => ipcRenderer.invoke('system:getBuildInfo'),
  getEffectiveSystemPrompt: (params) => ipcRenderer.invoke('agent:getSystemPrompt', params),
  recommendModelSettings: (connection, model) => ipcRenderer.invoke('models:recommendSettings', { connection, model }),

  runAgent: (args) => ipcRenderer.invoke('agent:run', args),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  onAgentEvent: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
  onAgentDone: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('agent:done', listener);
    return () => ipcRenderer.removeListener('agent:done', listener);
  },

  transcribeAudio: (samples) => ipcRenderer.invoke('audio:transcribe', samples),

  speak: (text) => ipcRenderer.invoke('tts:speak', text),
  stopSpeaking: () => ipcRenderer.invoke('tts:stop')
});
