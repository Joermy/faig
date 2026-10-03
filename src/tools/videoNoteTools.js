const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { resolveSafe } = require('./fileTools');
const { transcribe } = require('../speech/whisper');

let ytdlpModule = null;
function loadYtDlp() {
  if (ytdlpModule) return ytdlpModule;
  try {
    ytdlpModule = require('yt-dlp-exec');
    return ytdlpModule;
  } catch (err) {
    throw new Error(
      'yt-dlp-exec ist nicht installiert. Führe im Projektordner "npm install" aus, starte die App danach neu. ' +
        'Original-Fehler: ' + (err && err.message ? err.message : err)
    );
  }
}

function looksLikeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) && !trimmed.startsWith('-');
}

function readWavAsFloat32(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Extrahierte Audiodatei ist keine gültige WAV-Datei.');
  }
  let offset = 12;
  let fmt = null;
  let dataStart = null;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(bodyStart),
        numChannels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14)
      };
    } else if (chunkId === 'data') {
      dataStart = bodyStart;
      dataLength = chunkSize;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (!fmt || dataStart === null) {
    throw new Error('WAV-Datei hat keinen gültigen fmt- oder data-Chunk.');
  }
  if (fmt.numChannels !== 1 || fmt.sampleRate !== 16000 || fmt.bitsPerSample !== 16) {
    throw new Error(
      `Unerwartetes Audioformat nach Extraktion (Kanäle=${fmt.numChannels}, Rate=${fmt.sampleRate}, Bits=${fmt.bitsPerSample}); ` +
        'erwartet: 1 Kanal, 16000 Hz, 16 Bit. Prüfe die ffmpeg-Installation.'
    );
  }
  const sampleCount = Math.floor(Math.min(dataLength, buf.length - dataStart) / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  }
  return samples;
}

function frontmatterEscape(value) {
  const s = String(value == null ? '' : value);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function cleanupTmpFiles(tmpBase) {
  const dir = path.dirname(tmpBase);
  const prefix = path.basename(tmpBase);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      fs.unlink(path.join(dir, entry), () => {});
    }
  }
}

function slugify(text, fallback) {
  const base = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s-]/gi, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return base || fallback;
}

function buildVideoNoteTools(root) {
  return [
    {
      name: 'obsidian_save_video_note',
      description:
        'Lädt Audio von einem Video-Link (TikTok, YouTube, Instagram etc.) herunter, transkribiert es lokal mit Whisper (offline, kein Cloud-Upload) ' +
          'und speichert das Transkript als neue Notiz im Vault (Projektordner) — z.B. für ein Rezept-Video oder ein nützliches Tutorial, das der Nutzer schickt. ' +
          'Braucht ffmpeg auf dem Rechner des Nutzers (yt-dlp-Voraussetzung für Audio-Extraktion); wenn das fehlt, kommt ein klarer Fehler statt eines Absturzes.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Video-URL, z.B. ein TikTok- oder YouTube-Link' },
          title: { type: 'string', description: 'Optionaler Titel für die Notiz (sonst wird einer aus der URL/Zeit generiert)' },
          subfolder: { type: 'string', description: 'Optionaler Unterordner im Vault, Standard: "Videos"' }
        },
        required: ['url']
      },
      execute: async ({ url, title, subfolder }) => {
        if (!looksLikeUrl(url)) {
          return 'FEHLER: url muss ein echter http(s)-Link sein (z.B. ein TikTok- oder YouTube-Link).';
        }

        let ytdlp;
        try {
          ytdlp = loadYtDlp();
        } catch (err) {
          return `FEHLER: ${err.message}`;
        }

        const tmpBase = path.join(os.tmpdir(), `faig-video-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
        const wavPath = `${tmpBase}.wav`;

        let transcript;
        try {
          try {
            await ytdlp(url.trim(), {
              extractAudio: true,
              audioFormat: 'wav',
              postprocessorArgs: 'ffmpeg:-ar 16000 -ac 1',
              output: `${tmpBase}.%(ext)s`,
              noPlaylist: true
            });
          } catch (err) {
            const msg = String((err && err.stderr) || (err && err.message) || err);
            if (/ffmpeg|ffprobe/i.test(msg) && /not found|no such file|not recognized/i.test(msg)) {
              return (
                'FEHLER: ffmpeg/ffprobe wurden nicht gefunden. yt-dlp braucht beides installiert und im PATH, um Audio zu extrahieren ' +
                  '(siehe README, Abschnitt Video-Notizen). Original-Fehler: ' + msg.split('\n')[0]
              );
            }
            return `FEHLER beim Herunterladen/Extrahieren von "${url}": ${msg.split('\n')[0]}`;
          }

          try {
            if (!fs.existsSync(wavPath)) {
              return 'FEHLER: yt-dlp hat keine Audiodatei erzeugt (Video ohne Ton? Nicht unterstützte Plattform?).';
            }
            const samples = readWavAsFloat32(wavPath);
            transcript = await transcribe(samples);
          } catch (err) {
            return `FEHLER bei der Transkription: ${err && err.message ? err.message : err}`;
          }
        } finally {
          cleanupTmpFiles(tmpBase);
        }

        if (!transcript) {
          return 'Video wurde geladen, aber die Transkription war leer (evtl. kein gesprochener Text im Video).';
        }

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const noteTitle = (title && title.trim()) || `Video ${dateStr}`;
        const folder = (subfolder && subfolder.trim()) || 'Videos';
        const fileSlug = slugify(noteTitle, `video-${now.getTime()}`);
        const relPath = path.join(folder, `${fileSlug}.md`);

        const frontmatter = [
          '---',
          `title: ${frontmatterEscape(noteTitle)}`,
          `source: ${frontmatterEscape(url.trim())}`,
          `erfasst: ${dateStr}`,
          'tags:',
          '  - video',
          '  - transkript',
          'status: entwurf',
          '---',
          ''
        ].join('\n');
        const body = [
          `# ${noteTitle}`,
          '',
          `Quelle: ${url.trim()}`,
          '',
          '> [!warning] Rohtranskript, noch nicht aufbereitet',
          '> Kernaussagen nach oben ziehen, wiederverwendbare Begriffe als eigene Notiz nach `Konzepte/` auslagern,',
          '> dann `status` auf `geprüft` setzen.',
          '',
          '## Transkript',
          '',
          transcript,
          ''
        ].join('\n');

        const file = resolveSafe(root, relPath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, frontmatter + body, 'utf8');

        return `OK: Video transkribiert und gespeichert als "${relPath}" (${transcript.length} Zeichen Transkript).`;
      }
    }
  ];
}

module.exports = { buildVideoNoteTools, readWavAsFloat32, looksLikeUrl, slugify };
