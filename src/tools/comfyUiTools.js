const fs = require('fs');
const path = require('path');

const SKIP_TYPES = new Set(['MarkdownNote', 'Note', 'Reroute']);
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN']);
const MAX_LIST_ENTRIES = 500;

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function isWidgetField(spec) {
  const t = spec[0];
  const cfg = spec.length > 1 && spec[1] && typeof spec[1] === 'object' ? spec[1] : {};
  if (cfg.forceInput) return false;
  return Array.isArray(t) || WIDGET_TYPES.has(t);
}

function resolveWorkflowPath(workflowsDir, workflow) {
  if (!workflowsDir) {
    throw new Error(
      'Kein ComfyUI-Workflow-Ordner konfiguriert. Im Connections-Fenster unter "ComfyUI" den ComfyUI-Ordner wählen.'
    );
  }
  const rootAbs = path.resolve(workflowsDir);
  const rel = String(workflow || '').trim();
  if (!rel) throw new Error('workflow darf nicht leer sein.');
  const withExt = rel.toLowerCase().endsWith('.json') ? rel : `${rel}.json`;
  const target = path.resolve(rootAbs, withExt);
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (target !== rootAbs && !target.startsWith(withSep)) {
    throw new Error(`Workflow "${workflow}" liegt außerhalb des Workflow-Ordners (${rootAbs}). Verweigert.`);
  }
  if (!fs.existsSync(target)) throw new Error(`Workflow-Datei nicht gefunden: ${target}`);
  return target;
}

function listWorkflowFiles(workflowsDir) {
  if (!workflowsDir || !fs.existsSync(workflowsDir)) return [];
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= MAX_LIST_ENTRIES || depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        out.push(path.relative(workflowsDir, full));
      }
    }
  };
  walk(workflowsDir, 0);
  return out.sort();
}

function loadWorkflowJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const wf = JSON.parse(raw);
  if (!Array.isArray(wf.nodes)) throw new Error('Datei sieht nicht wie eine ComfyUI-Workflow-Exportdatei aus (kein "nodes"-Array).');
  return wf;
}

function makeObjectInfoFetcher(baseUrl) {
  const cache = new Map();
  return async function objectInfo(type) {
    if (!cache.has(type)) {
      const res = await fetch(`${trimSlash(baseUrl)}/object_info/${encodeURIComponent(type)}`);
      if (!res.ok) {
        cache.set(type, null);
      } else {
        const data = await res.json();
        cache.set(type, data[type] || null);
      }
    }
    return cache.get(type);
  };
}

function walkNodeFields(node, info, onField) {
  const order = info.input_order || {};
  const fieldOrder = [...(order.required || []), ...(order.optional || [])];
  const specs = { ...(info.input.required || {}), ...(info.input.optional || {}) };
  const byName = new Map((node.inputs || []).map((i) => [i.name, i]));
  const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  let wvIndex = 0;
  for (const name of fieldOrder) {
    const spec = specs[name];
    if (!spec) continue;
    const winput = byName.get(name);
    const widget = isWidgetField(spec);
    let value;
    if (widget) {
      value = wv[wvIndex];
      wvIndex++;
      if ((name === 'seed' || name === 'noise_seed') && spec[0] === 'INT') wvIndex++;
    }
    onField({ name, spec, widget, linked: !!(winput && winput.link != null), link: winput && winput.link, value });
  }
}

async function inspectWorkflow(baseUrl, wf) {
  const objectInfo = makeObjectInfoFetcher(baseUrl);
  const lines = [];
  for (const node of wf.nodes) {
    if (SKIP_TYPES.has(node.type)) continue;
    const title = node.title || node.type;
    const modeLabel = node.mode === 2 ? 'AUS/MUTED(2)' : node.mode === 4 ? 'BYPASS(4)' : 'AN(0)';
    const info = await objectInfo(node.type);
    if (!info) {
      lines.push(`[${node.id}] ${node.type} "${title}" mode=${modeLabel} — Node-Typ auf diesem Server unbekannt (fehlender Custom Node?)`);
      continue;
    }
    const fields = [];
    walkNodeFields(node, info, ({ name, widget, linked, value }) => {
      if (!widget || linked) return;
      let display = value;
      if (typeof display === 'string' && display.length > 160) display = display.slice(0, 160) + '…';
      fields.push(`${name}=${JSON.stringify(display)}`);
    });
    lines.push(`[${node.id}] ${node.type} "${title}" mode=${modeLabel}${fields.length ? ' — ' + fields.join(', ') : ''}`);
  }
  return lines.join('\n');
}

async function convertWorkflowToPrompt(baseUrl, wf, overridesByNodeField) {
  const objectInfo = makeObjectInfoFetcher(baseUrl);
  const linksById = new Map((wf.links || []).map((l) => [l[0], l]));

  const bypassSrc = new Map();
  for (const node of wf.nodes) {
    if (node.mode !== 4 && node.type !== 'Reroute') continue;
    const linkedInputs = (node.inputs || []).filter((i) => i.link != null);
    if ((node.outputs || []).length === 1 && linkedInputs.length === 1) {
      const l = linksById.get(linkedInputs[0].link);
      if (l) bypassSrc.set(`${node.id}:0`, [l[1], l[2]]);
    }
  }
  function resolveSource(nodeId, outIndex, depth) {
    if (depth > 20) throw new Error(`Bypass-Kette zu tief/zyklisch bei Node ${nodeId}.`);
    const hit = bypassSrc.get(`${nodeId}:${outIndex}`);
    return hit ? resolveSource(hit[0], hit[1], depth + 1) : [nodeId, outIndex];
  }

  const prompt = {};
  for (const node of wf.nodes) {
    if (SKIP_TYPES.has(node.type)) continue;
    if (node.mode === 2 || node.mode === 4) continue;
    const info = await objectInfo(node.type);
    if (!info) continue;

    const inputs = {};
    walkNodeFields(node, info, ({ name, linked, link, value }) => {
      if (linked) {
        const l = linksById.get(link);
        if (!l) return;
        const [srcId, srcOut] = resolveSource(l[1], l[2], 0);
        inputs[name] = [String(srcId), srcOut];
        return;
      }
      const override = overridesByNodeField.get(`${node.id}:${name}`);
      inputs[name] = override !== undefined ? override : value;
    });
    prompt[String(node.id)] = { class_type: node.type, inputs };
  }
  return prompt;
}

async function queuePrompt(baseUrl, prompt) {
  const res = await fetch(`${trimSlash(baseUrl)}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: `faig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`ComfyUI /prompt antwortete nicht mit JSON (Status ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || (data.node_errors && Object.keys(data.node_errors).length)) {
    throw new Error(`ComfyUI lehnt den Prompt ab: ${JSON.stringify(data.node_errors || data.error || data).slice(0, 1000)}`);
  }
  return data.prompt_id;
}

function extractOutputFiles(outputs) {
  const files = [];
  for (const out of Object.values(outputs || {})) {
    for (const key of ['videos', 'gifs', 'images']) {
      if (Array.isArray(out[key])) {
        for (const f of out[key]) {
          if (f && f.filename) files.push(f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename);
        }
      }
    }
    if (Array.isArray(out.text)) {
      for (const t of out.text) {
        if (typeof t === 'string' && /\.(mp4|mov|webm|png|jpe?g|gif)$/i.test(t)) files.push(t);
      }
    }
  }
  return files;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCompletion(baseUrl, promptId, { timeoutMs, controller }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (controller && controller.stopped) return { stopped: true };
    let entry;
    try {
      const res = await fetch(`${trimSlash(baseUrl)}/history/${promptId}`);
      const data = await res.json();
      entry = data[promptId];
    } catch {
    }
    if (entry) {
      const status = entry.status || {};
      const files = extractOutputFiles(entry.outputs);
      const erroredMsg = (status.messages || []).find((m) => m[0] === 'execution_error');
      if (erroredMsg) return { ok: false, error: JSON.stringify(erroredMsg[1]).slice(0, 1000), files };
      if (status.completed) return { ok: true, files };
    }
    await sleep(4000);
  }
  return { ok: false, error: `Timeout: kein Ergebnis nach ${Math.round(timeoutMs / 60000)} Minuten.` };
}

function buildComfyUiTools(config, { controller, onEvent } = {}) {
  const baseUrl = (config && config.baseUrl) || 'http://127.0.0.1:8188';
  const workflowsDir = config && config.workflowsDir;

  return [
    {
      name: 'comfyui_list_workflows',
      description: 'Listet alle ComfyUI-Workflow-.json-Dateien im konfigurierten Workflow-Ordner (rekursiv) auf.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        if (!workflowsDir) return 'FEHLER: Kein ComfyUI-Workflow-Ordner konfiguriert (Connections-Fenster → ComfyUI).';
        const files = listWorkflowFiles(workflowsDir);
        return files.length ? files.join('\n') : `(keine .json-Dateien in ${workflowsDir} gefunden)`;
      }
    },
    {
      name: 'comfyui_inspect_workflow',
      description:
        'Lädt einen Workflow (Name/relativer Pfad aus comfyui_list_workflows, ".json" optional) und listet alle Nodes mit ID, Typ, Titel, ' +
        'An/Aus-Status (mode: AN(0)/AUS-MUTED(2)/BYPASS(4)) und ihren aktuellen Widget-Werten auf (z.B. Prompt-Texte, Zahlen, Checkboxen). ' +
        'Nutze das, um HERAUSZUFINDEN, welche Node ein Autoprompt/Director-Schalter ist (Typ/Titel enthält oft "prompt", "director", ' +
        '"auto", "switch" o.ä.) und welche Node das Text-Prompt-Feld ist — es gibt dafür KEINE feste Konvention, jeder Workflow ist anders.',
      parameters: {
        type: 'object',
        properties: { workflow: { type: 'string', description: 'Workflow-Dateiname/-Pfad, z.B. "MiniMax H3 - Master" oder "Cars/ref2vid MAIN CAR.json"' } },
        required: ['workflow']
      },
      execute: async ({ workflow }) => {
        let filePath;
        try {
          filePath = resolveWorkflowPath(workflowsDir, workflow);
        } catch (err) {
          return `FEHLER: ${err.message}`;
        }
        let wf;
        try {
          wf = loadWorkflowJson(filePath);
        } catch (err) {
          return `FEHLER beim Lesen von "${workflow}": ${err.message}`;
        }
        try {
          return await inspectWorkflow(baseUrl, wf);
        } catch (err) {
          return `FEHLER beim Abfragen von ComfyUI (läuft der Server unter ${baseUrl}?): ${err.message}`;
        }
      }
    },
    {
      name: 'comfyui_queue_batch',
      description:
        'Reiht einen Workflow "count"-mal bei ComfyUI ein und wartet nacheinander auf jedes Ergebnis (eine GPU, ein Job gleichzeitig) — ' +
        'genau das richtige Tool für "generier mir N Bilder/Videos mit Workflow X". Vor dem ersten Aufruf IMMER erst comfyui_inspect_workflow ' +
        'nutzen, um die richtigen node_modes/overrides herauszufinden. ' +
        'node_modes schaltet Nodes an/aus: mode 0 = an (normal), 2 = aus/gemutet (komplett übersprungen — für simple Toggle-Nodes wie ' +
        '"Autoprompt an/aus" oder "Director-Mode an/aus", falls der Workflow dafür eine eigene Mute-fähige Node hat), 4 = bypass ' +
        '(nur für simple 1-Eingang/1-Ausgang-Durchleit-Nodes zuverlässig). overrides setzt Widget-Werte direkt (z.B. einen Prompt-Text ' +
        'in eine Text-Node schreiben, wenn KEIN Autoprompt in diesem Workflow vorhanden ist — dann erfindet der Agent selbst passende ' +
        'Prompts und übergibt sie hier). Läuft ggf. lange (mehrere Minuten pro Job) — das ist normal, kein Fehler. Kann per Stop-Button ' +
        'des Nutzers zwischen zwei Jobs abgebrochen werden.',
      parameters: {
        type: 'object',
        properties: {
          workflow: { type: 'string', description: 'Workflow-Dateiname/-Pfad, wie bei comfyui_inspect_workflow' },
          count: { type: 'number', description: 'Wie oft der Workflow eingereiht werden soll (1-500)' },
          node_modes: {
            type: 'array',
            description: 'Optional: An/Aus-Schalter für bestimmte Nodes.',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'number', description: 'Node-ID aus comfyui_inspect_workflow' },
                mode: { type: 'number', description: '0=an, 2=aus/gemutet, 4=bypass' }
              },
              required: ['nodeId', 'mode']
            }
          },
          overrides: {
            type: 'array',
            description: 'Optional: feste Widget-Werte setzen (z.B. einen Prompt-Text), bevor eingereiht wird.',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'number', description: 'Node-ID aus comfyui_inspect_workflow' },
                field: { type: 'string', description: 'Feldname genau wie in comfyui_inspect_workflow angezeigt, z.B. "text" oder "seed"' },
                value: { description: 'Neuer Wert für dieses Feld' }
              },
              required: ['nodeId', 'field', 'value']
            }
          },
          max_minutes_per_job: { type: 'number', description: 'Timeout pro einzelnem Job in Minuten (Standard: 30)' }
        },
        required: ['workflow', 'count']
      },
      execute: async ({ workflow, count, node_modes, overrides, max_minutes_per_job }) => {
        const n = Math.max(1, Math.min(Math.round(Number(count) || 1), 500));
        const timeoutMs = Math.max(1, Number(max_minutes_per_job) || 30) * 60000;

        let filePath;
        try {
          filePath = resolveWorkflowPath(workflowsDir, workflow);
        } catch (err) {
          return `FEHLER: ${err.message}`;
        }
        let wf;
        try {
          wf = loadWorkflowJson(filePath);
        } catch (err) {
          return `FEHLER beim Lesen von "${workflow}": ${err.message}`;
        }

        if (Array.isArray(node_modes)) {
          for (const nm of node_modes) {
            const node = wf.nodes.find((n2) => String(n2.id) === String(nm.nodeId));
            if (node) node.mode = nm.mode;
          }
        }

        const overridesByNodeField = new Map();
        if (Array.isArray(overrides)) {
          for (const ov of overrides) {
            overridesByNodeField.set(`${ov.nodeId}:${ov.field}`, ov.value);
          }
        }

        let prompt;
        try {
          prompt = await convertWorkflowToPrompt(baseUrl, wf, overridesByNodeField);
        } catch (err) {
          return `FEHLER beim Umwandeln des Workflows in einen API-Prompt: ${err.message}`;
        }

        const results = [];
        for (let i = 0; i < n; i++) {
          if (controller && controller.stopped) {
            if (onEvent) onEvent({ type: 'comfy_progress', message: `Gestoppt vor Job ${i + 1}/${n}.` });
            break;
          }
          if (onEvent) onEvent({ type: 'comfy_progress', message: `Reihe Job ${i + 1}/${n} ein...` });
          let promptId;
          try {
            promptId = await queuePrompt(baseUrl, prompt);
          } catch (err) {
            results.push({ i: i + 1, ok: false, error: String(err.message || err) });
            if (onEvent) onEvent({ type: 'comfy_progress', message: `Job ${i + 1}/${n} Fehler beim Einreihen: ${err.message || err}` });
            continue;
          }
          const outcome = await waitForCompletion(baseUrl, promptId, { timeoutMs, controller });
          if (outcome.stopped) {
            if (onEvent) onEvent({ type: 'comfy_progress', message: `Gestoppt während Job ${i + 1}/${n}.` });
            break;
          }
          results.push({ i: i + 1, promptId, ...outcome });
          if (onEvent) {
            onEvent({
              type: 'comfy_progress',
              message: outcome.ok
                ? `Job ${i + 1}/${n} fertig: ${(outcome.files || []).join(', ') || '(keine Ausgabedatei erkannt)'}`
                : `Job ${i + 1}/${n} fehlgeschlagen: ${outcome.error}`
            });
          }
        }

        const okCount = results.filter((r) => r.ok).length;
        const lines = [`${okCount}/${results.length} von ${n} angeforderten Jobs erfolgreich.`];
        for (const r of results) {
          lines.push(r.ok ? `  [${r.i}] OK: ${(r.files || []).join(', ') || '(keine Ausgabedatei erkannt)'}` : `  [${r.i}] FEHLER: ${r.error}`);
        }
        return lines.join('\n');
      }
    },
    {
      name: 'comfyui_queue_status',
      description: 'Zeigt, wie viele Jobs bei ComfyUI gerade laufen bzw. in der Warteschlange stehen.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        try {
          const res = await fetch(`${trimSlash(baseUrl)}/queue`);
          const data = await res.json();
          return `Läuft: ${(data.queue_running || []).length}, wartend: ${(data.queue_pending || []).length}`;
        } catch (err) {
          return `FEHLER beim Abfragen von ComfyUI (läuft der Server unter ${baseUrl}?): ${err.message}`;
        }
      }
    }
  ];
}

module.exports = { buildComfyUiTools, resolveWorkflowPath, listWorkflowFiles, convertWorkflowToPrompt, inspectWorkflow };
