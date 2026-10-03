let sayModule = null;
function loadSay() {
  if (sayModule) return sayModule;
  try {
    sayModule = require('say');
    return sayModule;
  } catch (err) {
    throw new Error(
      'say ist nicht installiert. Führe im Projektordner "npm install" aus, starte die App danach neu. ' +
        'Original-Fehler: ' + (err && err.message ? err.message : err)
    );
  }
}

function speak(text, { voice, speed } = {}) {
  return new Promise((resolve, reject) => {
    const clean = String(text || '').trim();
    if (!clean) return resolve();
    let say;
    try {
      say = loadSay();
    } catch (err) {
      return reject(err);
    }
    say.speak(clean, voice || null, speed || 1.0, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function stop() {
  try {
    loadSay().stop();
  } catch {
  }
}

module.exports = { speak, stop };
