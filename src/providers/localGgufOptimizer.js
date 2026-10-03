const fs = require('fs');
const { getSystemSpecs } = require('../systemSpecs');

let loadLibPromise = null;
function loadLib() {
  if (!loadLibPromise) loadLibPromise = import('node-llama-cpp');
  return loadLibPromise;
}

const ARCH_LABELS = {
  llama: 'Llama',
  qwen2: 'Qwen2',
  qwen3: 'Qwen3',
  gemma: 'Gemma',
  gemma2: 'Gemma 2',
  mistral: 'Mistral',
  phi3: 'Phi-3'
};

function formatGb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function recommendSettings(modelPath, llama) {
  if (!fs.existsSync(modelPath)) throw new Error(`Modell-Datei nicht gefunden: ${modelPath}`);
  const { readGgufFileInfo, GgufInsights } = await loadLib();

  const fileInfo = await readGgufFileInfo(modelPath);
  const insights = await GgufInsights.from(fileInfo, llama);

  const specs = await getSystemSpecs();
  const gpu = specs.gpus && specs.gpus[0];
  if (!gpu) {
    throw new Error(
      'Keine NVIDIA-GPU gefunden (nvidia-smi nicht verfügbar) — automatische Hardware-Optimierung braucht aktuell eine NVIDIA-Karte. ' +
        'Setz die Felder manuell, oder lass GPU-Layer/Kontext-Größe leer für node-llama-cpps eigenes "auto".'
    );
  }

  const resolved = await insights.configurationResolver.resolveAndScoreConfig(
    {},
    {
      getVramState: async () => ({ total: gpu.totalMb * 1024 * 1024, free: gpu.freeMb * 1024 * 1024, unifiedSize: 0 }),
      getRamState: async () => ({ total: specs.ram.totalMb * 1024 * 1024, free: specs.ram.freeMb * 1024 * 1024 }),
      llamaGpu: llama.gpu,
      llamaSupportsGpuOffloading: true
    }
  );

  const { gpuLayers, contextSize, totalVramUsage, totalRamUsage } = resolved.resolvedValues;
  const archName = insights.ggufFileInfo.metadata.general && insights.ggufFileInfo.metadata.general.architecture;
  const archLabel = ARCH_LABELS[archName] || archName || 'unbekannt';
  const allLayersOnGpu = gpuLayers >= insights.totalLayers;

  const reasoning = [
    `Modell: ${archLabel}, ${insights.totalLayers} Layer, ${(insights.totalParameters / 1e9).toFixed(1)} Mrd. Parameter, ${formatGb(insights.modelSize)} auf der Platte.`,
    `Trainiertes Kontext-Maximum: ${insights.trainContextSize ?? '?'} Tokens.`,
    `Hardware gerade: ${gpu.name} — ${formatGb(gpu.freeMb * 1024 * 1024)} von ${formatGb(gpu.totalMb * 1024 * 1024)} VRAM frei` +
      (specs.vramConsumers && specs.vramConsumers.length ? ` (belegt u.a. von: ${specs.vramConsumers.join(', ')})` : '') +
      '.',
    allLayersOnGpu
      ? `Empfehlung: alle ${gpuLayers} Layer auf die GPU (passt komplett in den freien VRAM).`
      : `Empfehlung: ${gpuLayers} von ${insights.totalLayers} Layern auf die GPU, Rest läuft auf der CPU (mehr Layer passen gerade nicht in den freien VRAM — z.B. weil parallel etwas anderes GPU-Speicher belegt).`,
    `Empfohlene Kontext-Größe: ${contextSize} Tokens (Kompromiss zwischen Platzbedarf und trainiertem Maximum von ${insights.trainContextSize ?? '?'}).`,
    `Geschätzter Bedarf mit diesen Werten: ~${formatGb(totalVramUsage)} VRAM, ~${formatGb(totalRamUsage)} RAM.`,
    `Kompatibilitäts-Score: ${Math.round(resolved.compatibilityScore * 100)}%.`
  ];
  if (resolved.compatibilityScore < 0.5) {
    reasoning.push(
      `⚠ Score unter 50% — diese Werte passen JETZT wahrscheinlich NICHT wirklich (zu wenig freier VRAM in diesem Moment). ` +
        'Schließ andere GPU-Programme (siehe oben, welche VRAM belegen) und lass die Empfehlung danach neu berechnen, statt diese Werte blind zu übernehmen.'
    );
  }

  return {
    gpuLayers,
    contextSize,
    flashAttentionRecommended: insights.flashAttentionSupported,
    compatibilityScore: resolved.compatibilityScore,
    totalLayers: insights.totalLayers,
    trainContextSize: insights.trainContextSize,
    architecture: archLabel,
    totalParameters: insights.totalParameters,
    modelSizeBytes: insights.modelSize,
    estimatedVramBytes: totalVramUsage,
    estimatedRamBytes: totalRamUsage,
    reasoning: reasoning.join('\n')
  };
}

module.exports = { recommendSettings };
