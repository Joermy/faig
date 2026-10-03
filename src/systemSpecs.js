const os = require('os');
const { execFile } = require('child_process');

const KNOWN_VRAM_CONSUMERS = [
  { match: /llama-server\.exe$/i, label: 'LM Studio (Hintergrund-Modell-Server läuft, auch ohne offenes Fenster)' },
  { match: /^python\.exe$/i, label: 'Python-Prozess (z.B. ComfyUI, falls das dessen Server ist)' },
  { match: /ComfyUI/i, label: 'ComfyUI' },
  { match: /ollama(\.exe)?$/i, label: 'Ollama' }
];

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function getGpuInfo() {
  try {
    const out = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.used,memory.free',
      '--format=csv,noheader,nounits'
    ]);
    const gpus = out
      .trim()
      .split('\n')
      .map((line) => {
        const [name, totalMb, usedMb, freeMb] = line.split(',').map((s) => s.trim());
        return { name, totalMb: Number(totalMb), usedMb: Number(usedMb), freeMb: Number(freeMb) };
      })
      .filter((g) => g.name && Number.isFinite(g.totalMb));
    return gpus;
  } catch {
    return [];
  }
}

async function getVramConsumers() {
  try {
    const out = await execFileAsync('nvidia-smi', ['--query-compute-apps=process_name', '--format=csv,noheader']);
    const names = out
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const hits = new Set();
    for (const name of names) {
      for (const known of KNOWN_VRAM_CONSUMERS) {
        if (known.match.test(name)) hits.add(known.label);
      }
    }
    return [...hits];
  } catch {
    return [];
  }
}

async function getSystemSpecs() {
  const [gpus, vramConsumers] = await Promise.all([getGpuInfo(), getVramConsumers()]);
  return {
    ram: { totalMb: Math.round(os.totalmem() / 1024 / 1024), freeMb: Math.round(os.freemem() / 1024 / 1024) },
    gpus,
    vramConsumers
  };
}

module.exports = { getSystemSpecs };
