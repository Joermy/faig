let clientModulePromise = null;
function loadMcpClient() {
  if (!clientModulePromise) {
    clientModulePromise = Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js')
    ]);
  }
  return clientModulePromise;
}

function buildStudioMcpTools(mcpConfig) {
  if (!mcpConfig || !mcpConfig.command) return [];

  let clientPromise = null;
  function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const [{ Client }, { StdioClientTransport }] = await loadMcpClient();
        const transport = new StdioClientTransport({
          command: mcpConfig.command,
          args: mcpConfig.args || []
        });
        const client = new Client({ name: 'faig', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        return client;
      })().catch((err) => {
        clientPromise = null;
        throw err;
      });
    }
    return clientPromise;
  }

  return [
    {
      name: 'studio_mcp_list_tools',
      description:
        'Listet die Werkzeuge, die die offene Roblox Studio Session GERADE über MCP anbietet (z.B. run_code, get_console_output, ' +
        'start_stop_play, insert_model) — mit Namen, Beschreibung und Parameter-Schema. IMMER zuerst aufrufen, bevor ' +
        'studio_mcp_call_tool genutzt wird, nie Werkzeugnamen raten. Braucht Roblox Studio offen, mit einem Place geladen, und ' +
        '"Enable Studio as MCP Server" aktiviert (Assistant -> Manage MCP Servers).',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        try {
          const client = await getClient();
          const { tools } = await client.listTools();
          if (!tools || !tools.length) return 'Roblox Studio MCP meldet keine Werkzeuge.';
          return tools
            .map((t) => `- ${t.name}: ${t.description || ''}\n  Parameter-Schema: ${JSON.stringify(t.inputSchema)}`)
            .join('\n');
        } catch (err) {
          clientPromise = null;
          return (
            `FEHLER: Verbindung zu Roblox Studio MCP fehlgeschlagen (${err.message || err}). ` +
            'Prüfe: Ist Roblox Studio offen mit einem geladenen Place? Ist "Enable Studio as MCP Server" im Assistant-Panel aktiv?'
          );
        }
      }
    },
    {
      name: 'studio_mcp_call_tool',
      description:
        'Ruft ein Werkzeug auf, das Roblox Studio über MCP anbietet (Namen/Parameter vorher mit studio_mcp_list_tools nachschauen). ' +
        'Für Code-lastige Aufrufe (z.B. run_code mit echtem Luau-Code) NICHT arguments_json verwenden — stattdessen das TOP-LEVEL-Feld ' +
        'mcp_code setzen (siehe ANTWORTFORMAT), das landet automatisch im wahrscheinlichsten Code-Parameter des Ziel-Werkzeugs.',
      parameters: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'Name des Studio-MCP-Werkzeugs, z.B. "run_code"' },
          arguments_json: {
            type: 'string',
            description: 'Übrige (nicht code-lastige) Argumente als JSON-String, z.B. {"context":"Server"}. Leer lassen wenn nicht gebraucht.'
          }
        },
        required: ['tool_name']
      },
      execute: async ({ tool_name, arguments_json, mcp_code }) => {
        if (!tool_name) return 'FEHLER: "tool_name" fehlt.';
        let args = {};
        if (arguments_json) {
          try {
            args = JSON.parse(arguments_json);
          } catch (err) {
            return `FEHLER: arguments_json ist kein gültiges JSON (${err.message}).`;
          }
        }
        if (typeof mcp_code === 'string' && mcp_code !== '') {
          args.command = mcp_code;
          if (args.code == null) args.code = mcp_code;
        }
        try {
          const client = await getClient();
          const result = await client.callTool({ name: tool_name, arguments: args });
          const parts = (result.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type} content]`));
          const text = parts.join('\n');
          if (result.isError) return `FEHLER von Roblox Studio ("${tool_name}"): ${text || JSON.stringify(result)}`;
          return text || 'OK (keine Textantwort).';
        } catch (err) {
          clientPromise = null;
          return `FEHLER beim Aufruf von "${tool_name}" über Roblox Studio MCP: ${err.message || err}`;
        }
      }
    }
  ];
}

module.exports = { buildStudioMcpTools };
