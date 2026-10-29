const path = require('path');

const WHISPER_MODEL = 'Xenova/whisper-base';

let transcriberPromise = null;

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      if (process.env.PORTABLE_EXECUTABLE_DIR) {
        env.cacheDir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'FAIG-Data', 'whisper-cache');
      }
      return pipeline('automatic-speech-recognition', WHISPER_MODEL);
    })().catch((err) => {
      transcriberPromise = null;
      throw err;
    });
  }
  return transcriberPromise;
}

const SAMPLE_RATE = 16000;
const LONG_FORM_THRESHOLD_S = 28;
const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;

async function transcribe(samples) {
  if (!samples || !samples.length) return '';
  const transcriber = await getTranscriber();
  const input = samples instanceof Float32Array ? samples : Float32Array.from(samples);

  const options = {};
  if (input.length > LONG_FORM_THRESHOLD_S * SAMPLE_RATE) {
    options.chunk_length_s = CHUNK_LENGTH_S;
    options.stride_length_s = STRIDE_LENGTH_S;
  }

  const result = await transcriber(input, options);
  const text = (result && result.text) || '';
  return text.trim();
}

module.exports = { transcribe, WHISPER_MODEL, SAMPLE_RATE };
