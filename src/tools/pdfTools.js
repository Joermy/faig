const fs = require('fs');
const path = require('path');
const { resolveSafe } = require('./fileTools');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    throw new Error(
      'playwright ist nicht installiert. Führe im Projektordner "npm install" aus, starte die App danach neu. ' +
        'Original-Fehler: ' + (err && err.message ? err.message : err)
    );
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapHtml(title, bodyHtml) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1a1a1a; line-height: 1.55; padding: 0; margin: 0; }
  h1 { font-size: 22px; border-bottom: 2px solid #1a5c3f; padding-bottom: 6px; }
  h2 { font-size: 17px; color: #1a5c3f; margin-top: 24px; }
  h3 { font-size: 14px; color: #333; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 12.5px; }
  th, td { border: 1px solid #999; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #eef3f0; }
  tr:nth-child(even) td { background: #fafafa; }
  code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; font-family: Consolas, monospace; font-size: 12px; }
  pre { background: #f0f0f0; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  ul, ol { margin: 6px 0; padding-left: 22px; }
  .meta { color: #666; font-size: 11.5px; margin-bottom: 18px; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

function buildPdfTools(root) {
  return [
    {
      name: 'export_pdf',
      description:
        'Erstellt eine echte PDF-Datei im Projektordner aus HTML-Inhalt — inkl. echter <table>-Tabellen, Überschriften, Listen. Nutze das ' +
          'IMMER wenn der Nutzer eine Zusammenfassung/einen Bericht als PDF haben will oder "exportier das" sagt, statt ihn selbst exportieren ' +
          'zu lassen. content_html ist der BODY-Inhalt (kein <html>/<head> nötig): <h1>/<h2>/<h3> für Überschriften, <p> für Text, ' +
          '<table><tr><th>...</th></tr><tr><td>...</td></tr></table> für Tabellen, <ul>/<ol><li> für Listen. Wird automatisch hübsch formatiert.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relativer Zielpfad, z.B. "Berichte/Zusammenfassung.pdf" (".pdf" wird automatisch ergänzt)' },
          title: { type: 'string', description: 'Titel des Dokuments (erscheint im PDF-Metadaten-Tab, nicht zwingend im sichtbaren Inhalt)' },
          content_html: { type: 'string', description: 'HTML-Body-Inhalt des Berichts' }
        },
        required: ['path', 'content_html']
      },
      execute: async ({ path: relPath, title, content_html }) => {
        if (!content_html || !content_html.trim()) return 'FEHLER: content_html darf nicht leer sein.';
        const withExt = relPath.toLowerCase().endsWith('.pdf') ? relPath : `${relPath}.pdf`;
        let file;
        try {
          file = resolveSafe(root, withExt);
        } catch (err) {
          return `FEHLER: ${err.message}`;
        }

        let playwright;
        try {
          playwright = loadPlaywright();
        } catch (err) {
          return `FEHLER: ${err.message}`;
        }

        let browser;
        try {
          const { chromium } = playwright;
          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();
          await page.setContent(wrapHtml(title || 'Bericht', content_html), { waitUntil: 'load' });
          fs.mkdirSync(path.dirname(file), { recursive: true });
          await page.pdf({
            path: file,
            format: 'A4',
            printBackground: true,
            margin: { top: '18mm', bottom: '18mm', left: '15mm', right: '15mm' }
          });
          return `OK: PDF erstellt unter "${withExt}".`;
        } catch (err) {
          return `FEHLER beim Erstellen der PDF: ${err.message || err}`;
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      }
    }
  ];
}

module.exports = { buildPdfTools };
