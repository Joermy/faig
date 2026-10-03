const { buildFileTools } = require('./fileTools');
const { buildShellTool } = require('./shellTool');
const { buildObsidianTools } = require('./obsidianTools');
const { buildBrowserTools } = require('./browserTools');
const { buildEmailTools } = require('./emailTools');
const { buildVideoNoteTools } = require('./videoNoteTools');
const { buildComfyUiTools } = require('./comfyUiTools');
const { buildPdfTools } = require('./pdfTools');
const { buildWebSearchTools } = require('./webSearchTool');
const { buildStudioMcpTools } = require('./studioMcpTools');

function buildTools(
  root,
  {
    vaultPath,
    enableShellTool,
    enableBrowserTool,
    browserProfileDir,
    enableEmailTool,
    emailAccount,
    enableComfyUiTool,
    comfyUiConfig,
    enableStudioMcpTool,
    studioMcpConfig,
    getMessages,
    historyLength,
    controller,
    onEvent
  } = {}
) {
  const tools = buildFileTools(root);
  tools.push(...buildPdfTools(root));
  tools.push(...buildWebSearchTools());
  if (vaultPath) tools.push(...buildObsidianTools(vaultPath), ...buildVideoNoteTools(vaultPath));
  if (enableShellTool) tools.push(buildShellTool(root));
  if (enableBrowserTool) tools.push(...buildBrowserTools(browserProfileDir));
  if (enableEmailTool) tools.push(...buildEmailTools(emailAccount, getMessages, historyLength));
  if (enableComfyUiTool) tools.push(...buildComfyUiTools(comfyUiConfig, { controller, onEvent }));
  if (enableStudioMcpTool) tools.push(...buildStudioMcpTools(studioMcpConfig));
  return tools;
}

module.exports = { buildTools };
