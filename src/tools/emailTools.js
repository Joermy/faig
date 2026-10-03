let nodemailerModule = null;
function loadNodemailer() {
  if (nodemailerModule) return nodemailerModule;
  try {
    nodemailerModule = require('nodemailer');
    return nodemailerModule;
  } catch (err) {
    throw new Error(
      'nodemailer ist nicht installiert. Führe im Projektordner "npm install" aus, starte die App danach neu. ' +
        'Original-Fehler: ' + (err && err.message ? err.message : err)
    );
  }
}

function findLastPreviewArgs(messages) {
  let found = null;
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (tc.name === 'email_preview' && tc.arguments) found = tc.arguments;
      }
    }
  }
  return found;
}

function sameDraft(a, b) {
  if (!a || !b) return false;
  return (
    String(a.to || '').trim() === String(b.to || '').trim() &&
    String(a.subject || '').trim() === String(b.subject || '').trim() &&
    String(a.body || '').trim() === String(b.body || '').trim()
  );
}

function buildEmailTools(account, getMessages, historyLength, createTransport) {
  return [
    {
      name: 'email_preview',
      description:
        'Zeigt einen E-Mail-Entwurf (An/Betreff/Text) an — sendet NICHTS. Zeige den Entwurf danach in deiner Antwort und beende deinen Zug OHNE email_send aufzurufen. Frag den Nutzer ausdrücklich, ob er einverstanden ist.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Empfänger-E-Mail-Adresse' },
          subject: { type: 'string', description: 'Betreff' },
          body: { type: 'string', description: 'E-Mail-Text (Klartext)' }
        },
        required: ['to', 'subject', 'body']
      },
      execute: async ({ to, subject, body }) => {
        if (!to || !subject || !body) return 'FEHLER: to, subject und body sind Pflicht.';
        return [
          'ENTWURF (noch NICHT gesendet):',
          `An: ${to}`,
          `Betreff: ${subject}`,
          '',
          body,
          '',
          '--- WICHTIG: Zeige diesen Entwurf jetzt dem Nutzer in deiner Antwort und beende deinen Zug, OHNE email_send aufzurufen. ' +
            'Rufe email_send erst in einem SPÄTEREN Lauf auf — also erst, nachdem der Nutzer in einer NEUEN Nachricht ausdrücklich ' +
            'zugestimmt hat (z.B. "ja, schick sie ab"). Ein sofortiger email_send-Aufruf jetzt wird technisch verweigert.'
        ].join('\n');
      }
    },
    {
      name: 'email_send',
      description:
        'Versendet eine E-Mail wirklich per SMTP. Funktioniert NUR, wenn exakt dieser Entwurf bereits per email_preview in einem früheren, bereits abgeschlossenen Lauf gezeigt wurde.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['to', 'subject', 'body']
      },
      execute: async ({ to, subject, body }) => {
        if (!account || !account.host || !account.user) {
          return 'FEHLER: Kein E-Mail-Konto konfiguriert. Im Connections-Fenster unter "E-Mail-Konto" SMTP-Zugangsdaten eintragen.';
        }

        const messages = getMessages();
        const thisRun = messages.slice(historyLength);
        const previewedThisRun = thisRun.some((m) => m.role === 'tool' && m.name === 'email_preview');
        if (previewedThisRun) {
          return (
            'FEHLER: email_preview wurde in DIESEM SELBEN Lauf aufgerufen — das zählt NICHT als Zustimmung des Nutzers. ' +
            'Zeige den Entwurf in deiner Antwort und beende deinen Zug ohne weiteren Tool-Aufruf. Erst wenn der Nutzer in einer ' +
            'neuen Nachricht ausdrücklich zustimmt, kannst du email_send in einem neuen Lauf aufrufen.'
          );
        }

        const lastPreview = findLastPreviewArgs(messages);
        if (!lastPreview) {
          return 'FEHLER: Es gab noch keinen email_preview-Aufruf. Rufe zuerst email_preview auf, zeig den Entwurf, und warte auf Zustimmung.';
        }
        if (!sameDraft(lastPreview, { to, subject, body })) {
          return (
            'FEHLER: Dieser Inhalt unterscheidet sich vom zuletzt gezeigten Entwurf (An/Betreff/Text). Rufe email_preview erneut ' +
            'mit dem NEUEN Inhalt auf und warte wieder auf ausdrückliche Zustimmung, bevor du sendest.'
          );
        }

        try {
          const nodemailer = createTransport ? null : loadNodemailer();
          const makeTransport = createTransport || nodemailer.createTransport;
          const transporter = makeTransport({
            host: account.host,
            port: Number(account.port) || 587,
            secure: !!account.secure,
            auth: { user: account.user, pass: account.pass }
          });
          const fromHeader = account.fromName
            ? `"${account.fromName}" <${account.fromAddress || account.user}>`
            : account.fromAddress || account.user;
          const info = await transporter.sendMail({ from: fromHeader, to, subject, text: body });
          return `OK: E-Mail an ${to} gesendet (messageId: ${(info && info.messageId) || '?'}).`;
        } catch (err) {
          return `FEHLER beim Senden: ${err.message || err}`;
        }
      }
    }
  ];
}

module.exports = { buildEmailTools, findLastPreviewArgs, sameDraft };
