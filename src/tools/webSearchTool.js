const MAX_FETCH_CHARS = 12000;
const MAX_SNIPPET_CHARS = 300;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, '')).trim();
}

function unwrapDdgLink(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href || '');
  if (!m) return href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDdgHtml(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    const html = await res.text();
    if (res.ok && /result__a/.test(html)) return html;
    if (attempt < 2) await sleep(600 * (attempt + 1));
  }
  throw new Error('DuckDuckGo hat mehrfach keine verwertbare Ergebnisseite geliefert (evtl. kurzzeitiges Rate-Limiting) — nochmal versuchen.');
}

async function searchDuckDuckGo(query, maxResults) {
  const html = await fetchDdgHtml(query);

  const results = [];
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titles = [];
  let m;
  while ((m = anchorRe.exec(html)) && titles.length < maxResults) {
    titles.push({ url: unwrapDdgLink(m[1]), title: stripTags(m[2]) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) && snippets.length < maxResults) {
    snippets.push(stripTags(m[1]).slice(0, MAX_SNIPPET_CHARS));
  }
  for (let i = 0; i < titles.length; i++) {
    if (!titles[i].title || !titles[i].url) continue;
    results.push({ ...titles[i], snippet: snippets[i] || '' });
  }
  return results;
}

function buildWebSearchTools() {
  return [
    {
      name: 'web_search',
      description:
        'Durchsucht das echte Internet (DuckDuckGo) nach einem Suchbegriff und gibt Titel, URL und einen kurzen Textauszug pro Treffer ' +
          'zurück. Nutze das für Recherche/aktuelle Informationen, die du nicht sicher weißt. Rufe danach ggf. web_fetch mit einer ' +
          'vielversprechenden URL auf, um die volle Seite zu lesen.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Suchbegriff' },
          max_results: { type: 'number', description: 'Maximale Anzahl Treffer (Standard 8, max 20)' }
        },
        required: ['query']
      },
      execute: async ({ query, max_results }) => {
        if (!query || !query.trim()) return 'FEHLER: query darf nicht leer sein.';
        const n = Math.max(1, Math.min(Math.round(Number(max_results) || 8), 20));
        try {
          const results = await searchDuckDuckGo(query.trim(), n);
          if (!results.length) return `Keine Treffer für "${query}".`;
          return results
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
            .join('\n\n');
        } catch (err) {
          return `FEHLER bei der Suche: ${err.message || err}`;
        }
      }
    },
    {
      name: 'web_fetch',
      description:
        'Lädt eine URL und gibt ihren lesbaren Textinhalt zurück (Skripte/Stylesheets/Tags entfernt) — zum Lesen einer konkreten Seite, ' +
          'z.B. einem Treffer aus web_search. Funktioniert nur für normales HTML (kein JavaScript-gerendertes Interagieren möglich — dafür ' +
          'gibt es browser_navigate, falls verfügbar).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Vollständige URL, inkl. https://' } },
        required: ['url']
      },
      execute: async ({ url }) => {
        const target = String(url || '').trim();
        if (!/^https?:\/\/\S+$/i.test(target)) return 'FEHLER: url muss ein vollständiger http(s)-Link sein.';
        try {
          const res = await fetch(target, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            redirect: 'follow'
          });
          const contentType = res.headers.get('content-type') || '';
          if (!res.ok) return `FEHLER: ${target} antwortete mit Status ${res.status}.`;
          if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
            return `FEHLER: Antwort ist kein HTML/Text (Content-Type: ${contentType || 'unbekannt'}) — web_fetch liest nur Textseiten.`;
          }
          let html = await res.text();
          html = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[\s\S]*?<\/nav>/gi, '')
            .replace(/<(br|\/p|\/div|\/li|\/h[1-6])>/gi, '\n');
          const text = stripTags(html)
            .split('\n')
            .map((line) => line.trim())
            .filter((line, i, arr) => line || (arr[i - 1] && arr[i - 1].trim()))
            .join('\n');
          const truncated = text.length > MAX_FETCH_CHARS;
          return truncated ? `${text.slice(0, MAX_FETCH_CHARS)}\n\n[... gekürzt, Seite ist länger ...]` : text;
        } catch (err) {
          return `FEHLER beim Laden von ${target}: ${err.message || err}`;
        }
      }
    }
  ];
}

module.exports = { buildWebSearchTools };
