#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { transcribe } = require('../src/speech/whisper');
const { readWavAsFloat32, looksLikeUrl } = require('../src/tools/videoNoteTools');

function noteFilename(title, fallback) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 90)
    .trim();
  return cleaned || fallback;
}

const YTDLP = path.join(__dirname, '..', 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');

function parseArgs(argv) {
  const opts = { urls: [], subfolder: 'Videos', vault: '', skipExisting: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--subfolder') opts.subfolder = argv[++i];
    else if (a === '--skip-existing') opts.skipExisting = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--urls-file') {
      const lines = fs.readFileSync(argv[++i], 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [url, title] = trimmed.split('|').map((s) => s.trim());
        opts.urls.push({ url, title: title || '' });
      }
    } else if (a.startsWith('--')) {
      throw new Error(`Unbekannte Option: ${a}`);
    } else {
      opts.urls.push({ url: a, title: '' });
    }
  }
  return opts;
}

function ytdlpJson(url) {
  const out = execFileSync(
    YTDLP,
    ['--skip-download', '--no-warnings', '--print', '%(webpage_url)s\n%(uploader)s\n%(duration)s\n%(title)s', url],
    { encoding: 'utf8', timeout: 120000 }
  );
  const [webpageUrl, uploader, duration, ...titleParts] = out.trim().split('\n');
  return {
    webpageUrl: webpageUrl || url,
    uploader: uploader && uploader !== 'NA' ? uploader : '',
    duration: duration && duration !== 'NA' ? Number(duration) : null,
    title: titleParts.join(' ').trim()
  };
}

function downloadWav(url, target) {
  execFileSync(
    YTDLP,
    [
      '--extract-audio',
      '--audio-format', 'wav',
      '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
      '--output', `${target}.%(ext)s`,
      '--no-playlist',
      '--no-warnings',
      url
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000 }
  );
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function yamlValue(value) {
  const s = String(value == null ? '' : value);
  return /[:"#]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function buildNote({ noteTitle, meta, transcript, dateStr }) {
  const fm = [
    '---',
    `title: ${yamlValue(noteTitle)}`,
    `source: ${yamlValue(meta.webpageUrl)}`,
    meta.uploader ? `kanal: ${yamlValue(meta.uploader)}` : null,
    meta.duration ? `laufzeit: ${yamlValue(formatDuration(meta.duration))}` : null,
    `erfasst: ${dateStr}`,
    'tags:',
    '  - video',
    '  - transkript',
    'status: entwurf',
    '---',
    ''
  ].filter((line) => line !== null).join('\n');

  const body = [
    `# ${noteTitle}`,
    '',
    `Quelle: ${meta.webpageUrl}`,
    meta.uploader ? `Kanal: ${meta.uploader}` : null,
    meta.duration ? `Laufzeit: ${formatDuration(meta.duration)}` : null,
    '',
    '> [!warning] Rohtranskript, noch nicht aufbereitet',
    '> Kernaussagen nach oben ziehen, wiederverwendbare Begriffe als eigene Notiz nach `Konzepte/`',
    '> auslagern, dann `status` auf `geprüft` setzen.',
    '',
    '## Transkript',
    '',
    transcript,
    ''
  ].filter((l) => l !== null).join('\n');

  return fm + body;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.vault) throw new Error('--vault fehlt');
  if (!fs.existsSync(opts.vault)) throw new Error(`Vault nicht gefunden: ${opts.vault}`);
  if (!opts.urls.length) throw new Error('Keine URLs angegeben');
  if (!fs.existsSync(YTDLP)) throw new Error(`yt-dlp nicht gefunden: ${YTDLP}`);

  const outDir = path.join(opts.vault, opts.subfolder);
  fs.mkdirSync(outDir, { recursive: true });

  let ok = 0;
  const failed = [];

  for (const [index, entry] of opts.urls.entries()) {
    const label = `[${index + 1}/${opts.urls.length}]`;
    if (!looksLikeUrl(entry.url)) {
      console.error(`${label} UEBERSPRUNGEN (keine http(s)-URL): ${entry.url}`);
      failed.push({ url: entry.url, reason: 'keine gueltige URL' });
      continue;
    }

    let meta;
    try {
      meta = ytdlpJson(entry.url);
    } catch (err) {
      const msg = String(err.stderr || err.message).split('\n')[0];
      console.error(`${label} FEHLER Metadaten: ${entry.url} -> ${msg}`);
      failed.push({ url: entry.url, reason: msg });
      continue;
    }

    const noteTitle = entry.title || meta.title || `Video ${new Date().toISOString().slice(0, 10)}`;
    const file = path.join(outDir, `${noteFilename(noteTitle, `Video ${Date.now()}`)}.md`);

    console.log(`${label} ${noteTitle}  (${meta.uploader || '?'}, ${formatDuration(meta.duration) || '?'})`);

    if (opts.skipExisting && fs.existsSync(file)) {
      console.log('      existiert schon, uebersprungen');
      continue;
    }
    if (opts.dryRun) continue;

    const tmpBase = path.join(os.tmpdir(), `faig-cli-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    const wavPath = `${tmpBase}.wav`;
    try {
      console.log('      Audio laden...');
      downloadWav(entry.url, tmpBase);
      if (!fs.existsSync(wavPath)) throw new Error('yt-dlp hat keine WAV-Datei erzeugt (Video ohne Ton?)');

      console.log('      transkribieren...');
      const transcript = await transcribe(readWavAsFloat32(wavPath));
      if (!transcript) throw new Error('Transkript ist leer (kein gesprochener Text?)');

      if (/^[\s\[\(]*(music|musik|applause|dramatic music|[^a-z]*)[\s\]\)]*$/i.test(transcript) || transcript.length < 40) {
        console.log(`      HINWEIS: kaum Sprache erkannt ("${transcript.slice(0, 60)}") - vermutlich reines Musikvideo.`);
      }

      fs.writeFileSync(
        file,
        buildNote({ noteTitle, meta, transcript, dateStr: new Date().toISOString().slice(0, 10) }),
        'utf8'
      );
      console.log(`      OK -> ${path.relative(opts.vault, file)} (${transcript.length} Zeichen)`);
      ok++;
    } catch (err) {
      const msg = String((err && err.stderr) || (err && err.message) || err).split('\n')[0];
      console.error(`      FEHLER: ${msg}`);
      failed.push({ url: entry.url, reason: msg });
    } finally {
      fs.unlink(wavPath, () => {});
    }
  }

  console.log(`\nFertig: ${ok} von ${opts.urls.length} geschrieben.`);
  if (failed.length) {
    console.log('Fehlgeschlagen:');
    failed.forEach((f) => console.log(`  ${f.url} -> ${f.reason}`));
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`ABBRUCH: ${err && err.message ? err.message : err}`);
  process.exitCode = 2;
});
