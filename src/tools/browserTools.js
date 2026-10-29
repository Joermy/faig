let browserCtx = null;
let page = null;

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    throw new Error(
      'playwright ist nicht installiert. Führe im Projektordner "npm install" aus ' +
        '(lädt u.a. playwright samt Chromium-Browser, das kann etwas dauern), starte die App danach neu. ' +
        'Original-Fehler: ' + (err && err.message ? err.message : err)
    );
  }
}

async function ensurePage(userDataDir, headless) {
  if (page && !page.isClosed()) return page;
  const { chromium } = loadPlaywright();
  browserCtx = await chromium.launchPersistentContext(userDataDir, {
    headless: !!headless,
    viewport: { width: 1280, height: 900 }
  });
  page = browserCtx.pages()[0] || (await browserCtx.newPage());
  browserCtx.on('close', () => {
    browserCtx = null;
    page = null;
  });
  return page;
}

async function indexInteractiveElements(p) {
  return p.evaluate(() => {
    const sel = 'a, button, input, textarea, select, [role="button"], [contenteditable="true"]';
    const all = Array.from(document.querySelectorAll(sel));
    const visible = all.filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const capped = visible.slice(0, 60);
    capped.forEach((el, i) => el.setAttribute('data-faig-idx', String(i)));
    return capped.map((el, i) => {
      const label =
        (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return { index: i, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', text: label };
    });
  });
}

async function describePage(p) {
  const title = await p.title().catch(() => '');
  const url = p.url();
  const bodyText = await p
    .evaluate(() => (document.body ? document.body.innerText : ''))
    .catch(() => '');
  const truncated = bodyText.length > 4000 ? bodyText.slice(0, 4000) + '\n[...gekürzt...]' : bodyText;
  const elements = await indexInteractiveElements(p).catch(() => []);
  const elLines = elements.map(
    (e) => `[${e.index}] <${e.tag}${e.type ? ' type=' + e.type : ''}> ${e.text ? `"${e.text}"` : '(kein Text)'}`
  );
  return [
    `Seite: ${title || '(kein Titel)'}`,
    `URL: ${url}`,
    '',
    'Sichtbarer Text:',
    truncated || '(kein Text)',
    '',
    'Klickbare/eingebbare Elemente (Index für browser_click/browser_type nutzen):',
    elLines.length ? elLines.join('\n') : '(keine gefunden)'
  ].join('\n');
}

function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return u;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
}

function buildBrowserTools(userDataDir, { headless } = {}) {
  return [
    {
      name: 'browser_navigate',
      description: 'Öffnet eine URL in einem echten, sichtbaren Browserfenster (eigenes isoliertes Profil) und gibt Titel, Text und klickbare Elemente der Seite zurück.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Ziel-URL, z.B. "https://example.com" (Protokoll optional)' } },
        required: ['url']
      },
      execute: async ({ url }) => {
        const target = normalizeUrl(url);
        if (!target) return 'FEHLER: url darf nicht leer sein.';
        try {
          const p = await ensurePage(userDataDir, headless);
          await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await p.waitForTimeout(300);
          return await describePage(p);
        } catch (err) {
          return `FEHLER beim Navigieren zu ${target}: ${err.message || err}`;
        }
      }
    },
    {
      name: 'browser_read_page',
      description: 'Liest die aktuell geöffnete Seite erneut (z.B. nachdem sich der Inhalt ohne neue Navigation geändert hat).',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        if (!page || page.isClosed()) return 'FEHLER: Noch keine Seite offen. Zuerst browser_navigate aufrufen.';
        try {
          return await describePage(page);
        } catch (err) {
          return `FEHLER beim Lesen der Seite: ${err.message || err}`;
        }
      }
    },
    {
      name: 'browser_click',
      description: 'Klickt auf das Element mit dem angegebenen Index (aus der letzten browser_navigate/browser_read_page-Antwort).',
      parameters: {
        type: 'object',
        properties: { index: { type: 'number', description: 'Index des Elements, siehe letzte Seiten-Beschreibung' } },
        required: ['index']
      },
      execute: async ({ index }) => {
        if (!page || page.isClosed()) return 'FEHLER: Noch keine Seite offen. Zuerst browser_navigate aufrufen.';
        try {
          await page.locator(`[data-faig-idx="${index}"]`).first().click({ timeout: 10000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(250);
          return `Geklickt auf Element [${index}].\n\n${await describePage(page)}`;
        } catch (err) {
          return `FEHLER beim Klicken auf [${index}]: ${err.message || err}`;
        }
      }
    },
    {
      name: 'browser_type',
      description: 'Schreibt Text in ein Eingabefeld (Index aus der letzten Seiten-Beschreibung). Optional danach Enter drücken (z.B. für eine Suche).',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Index des Eingabefelds' },
          text: { type: 'string', description: 'Einzugebender Text' },
          submit: { type: 'boolean', description: 'Nach dem Tippen Enter drücken (Standard: false)' }
        },
        required: ['index', 'text']
      },
      execute: async ({ index, text, submit }) => {
        if (!page || page.isClosed()) return 'FEHLER: Noch keine Seite offen. Zuerst browser_navigate aufrufen.';
        try {
          const locator = page.locator(`[data-faig-idx="${index}"]`).first();
          await locator.fill(String(text ?? ''), { timeout: 10000 });
          if (submit) {
            await locator.press('Enter');
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          }
          await page.waitForTimeout(200);
          return `Text in Element [${index}] eingegeben${submit ? ' + Enter gedrückt' : ''}.\n\n${await describePage(page)}`;
        } catch (err) {
          return `FEHLER beim Eintippen in [${index}]: ${err.message || err}`;
        }
      }
    }
  ];
}

async function closeBrowser() {
  if (browserCtx) {
    try {
      await browserCtx.close();
    } catch {
    }
    browserCtx = null;
    page = null;
  }
}

module.exports = { buildBrowserTools, closeBrowser, normalizeUrl };
