import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_BIN } from './config.js';
import {
  auftragLesen, auftragSchreiben, auftraegeListe, auftragOrdner,
  profilLesen, wissenLesen, wissenDateiname, einstellungenLesen
} from './store.js';

/* Der Worker haelt eine kleine Warteschlange im Prozess. Der Zustand jedes
   Auftrags liegt aber auf der Platte - stuerzt der Dienst ab, geht nichts
   verloren, laufende Auftraege werden beim Start neu eingereiht. */

const laufend = new Map();   // auftragId -> Kindprozess
let arbeitetGerade = 0;
let geweckt = false;

export function beimStartAufraeumen() {
  let zurueck = 0;
  for (const a of auftraegeListe({ limit: 100000 })) {
    if (a.status === 'laeuft') {
      a.status = 'wartet';
      a.hinweis = 'Dienst wurde neu gestartet - Auftrag erneut eingereiht.';
      auftragSchreiben(a);
      zurueck++;
    }
  }
  return zurueck;
}

export function wecken() {
  if (geweckt) return;
  geweckt = true;
  setImmediate(() => { geweckt = false; abarbeiten(); });
}

function abarbeiten() {
  const { parallel } = einstellungenLesen();
  while (arbeitetGerade < Math.max(1, parallel)) {
    const naechster = auftraegeListe({ limit: 100000 })
      .filter(a => a.status === 'wartet')
      .sort((a, b) => (a.angelegt || '').localeCompare(b.angelegt || ''))[0];
    if (!naechster) return;
    arbeitetGerade++;
    ausfuehren(naechster.id)
      .catch(() => {})
      .finally(() => { arbeitetGerade--; wecken(); });
  }
}

export function abbrechen(aid) {
  const kind = laufend.get(aid);
  if (kind) { kind.kill('SIGTERM'); return true; }
  const a = auftragLesen(aid);
  if (a && a.status === 'wartet') {
    a.status = 'abgebrochen';
    a.beendet = new Date().toISOString();
    auftragSchreiben(a);
    return true;
  }
  return false;
}

/** Baut das Arbeitsverzeichnis auf: Anweisung, Eingabedateien, Wissensdateien. */
function arbeitsordnerBauen(auftrag, profil) {
  const arbeit = path.join(auftragOrdner(auftrag.id), 'arbeit');
  fs.rmSync(arbeit, { recursive: true, force: true });
  fs.mkdirSync(path.join(arbeit, 'eingabe'), { recursive: true });

  // Anweisungen des Profils als Systemprompt-Datei.
  fs.writeFileSync(path.join(arbeit, '.anweisung.txt'), profil.anweisung || '');

  // Eingabedateien aus dem Auftrag herueberkopieren.
  const quelle = path.join(auftragOrdner(auftrag.id), 'eingabe');
  for (const f of auftrag.dateien || []) {
    const von = path.join(quelle, f.gespeichertAls);
    if (fs.existsSync(von)) fs.copyFileSync(von, path.join(arbeit, 'eingabe', f.name));
  }

  // Verknuepftes Referenzmaterial - im Originalformat, damit eine PDF auch als
  // PDF gelesen wird und nicht als Textdatei mit falscher Endung.
  const wissen = profil.wissen || [];
  if (wissen.length) {
    const wdir = path.join(arbeit, 'wissen');
    fs.mkdirSync(wdir, { recursive: true });
    for (const w of wissen) {
      const inhalt = wissenLesen(w.hash);
      if (inhalt == null) continue;
      fs.writeFileSync(path.join(wdir, wissenDateiname(w)), inhalt);
    }
  }
  return arbeit;
}

function ausfuehren(aid) {
  return new Promise((fertig) => {
    const auftrag = auftragLesen(aid);
    if (!auftrag || auftrag.status !== 'wartet') return fertig();

    const profil = profilLesen(auftrag.profil);
    if (!profil) {
      auftrag.status = 'fehler';
      auftrag.fehler = `Profil "${auftrag.profil}" existiert nicht mehr.`;
      auftrag.beendet = new Date().toISOString();
      auftragSchreiben(auftrag);
      return fertig();
    }

    const e = einstellungenLesen();
    const modell    = profil.modell    || e.modell;
    const werkzeuge = profil.werkzeuge || e.werkzeuge;
    const zeitlimit = (profil.zeitlimitSek || e.zeitlimitSek) * 1000;

    // Startanweisung plus die im Dashboard eingetragenen Angaben. Viele
    // Anweisungen enthalten eckige Platzhalter - die werden hier aufgeloest.
    let anweisung = profil.startAnweisung || e.startAnweisung;
    const angaben = Object.entries(auftrag.angaben || {}).filter(([, w]) => String(w || '').trim());
    if (angaben.length) {
      const felder = profil.felder || [];
      const zeilen = angaben.map(([schluessel, wert]) => {
        const feld = felder.find(f => f.schluessel === schluessel);
        return `- ${feld?.beschriftung || schluessel}: ${wert}`;
      });
      anweisung += '\n\nANGABEN ZU DIESEM AUFTRAG\n' + zeilen.join('\n') +
        '\n\nSetze diese Angaben anstelle der eckigen Platzhalter in der Anweisung ein. ' +
        'Platzhalter, zu denen hier nichts steht, sind den vorgelegten Unterlagen zu entnehmen.';
    }

    // Freitext: was frueher von Hand in den Chat getippt wurde.
    const freitext = String(auftrag.freitext || '').trim();
    if (freitext) {
      anweisung += '\n\nZUSAETZLICHE ANWEISUNG FUER DIESEN AUFTRAG\n' + freitext;
    }

    let arbeit;
    try { arbeit = arbeitsordnerBauen(auftrag, profil); }
    catch (err) {
      auftrag.status = 'fehler';
      auftrag.fehler = `Arbeitsordner konnte nicht angelegt werden: ${err.message}`;
      auftrag.beendet = new Date().toISOString();
      auftragSchreiben(auftrag);
      return fertig();
    }

    auftrag.status    = 'laeuft';
    auftrag.gestartet = new Date().toISOString();
    auftrag.modell    = modell;
    auftragSchreiben(auftrag);

    /* Claude Code verweigert "bypassPermissions", wenn es mit Systemrechten
       laeuft - eine Sicherheitssperre, die man nicht umgehen soll. Im Container
       ist genau das aber der Normalfall, damit der eingebundene Datenordner
       beschreibbar bleibt. "acceptEdits" kommt ohne Rueckfragen aus, solange
       die benoetigten Werkzeuge ueber --allowedTools ausdruecklich erlaubt
       sind; das ist hier der Fall. */
    const alsSystembenutzer = typeof process.getuid === 'function' && process.getuid() === 0;
    const rechtemodus = alsSystembenutzer ? 'acceptEdits' : 'bypassPermissions';

    const argumente = [
      '-p',
      '--append-system-prompt-file', '.anweisung.txt',
      '--output-format', 'json',
      '--model', modell,
      '--permission-mode', rechtemodus,
      '--allowedTools', werkzeuge.join(','),
      '--no-session-persistence',
      '--strict-mcp-config',
      anweisung
    ];

    const kind = spawn(CLAUDE_BIN, argumente, {
      cwd: arbeit,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    laufend.set(aid, kind);

    let aus = '', fehlerAus = '';
    kind.stdout.on('data', d => { aus += d; });
    kind.stderr.on('data', d => { fehlerAus += d; });

    const uhr = setTimeout(() => {
      kind.kill('SIGTERM');
      setTimeout(() => kind.kill('SIGKILL'), 5000);
    }, zeitlimit);

    kind.on('error', (err) => {
      clearTimeout(uhr);
      laufend.delete(aid);
      const a = auftragLesen(aid) || auftrag;
      a.status = 'fehler';
      a.fehler = err.code === 'ENOENT'
        ? `Claude-Code-CLI nicht gefunden (gesucht: "${CLAUDE_BIN}"). Pfad ueber CLAUDE_BIN setzen.`
        : err.message;
      a.beendet = new Date().toISOString();
      auftragSchreiben(a);
      fertig();
    });

    kind.on('close', (code, signal) => {
      clearTimeout(uhr);
      laufend.delete(aid);
      const a = auftragLesen(aid) || auftrag;
      a.beendet = new Date().toISOString();
      a.dauerSek = Math.round((new Date(a.beendet) - new Date(a.gestartet)) / 1000);

      if (signal) {
        a.status = 'abgebrochen';
        a.fehler = a.dauerSek * 1000 >= zeitlimit - 2000
          ? `Zeitlimit von ${zeitlimit / 1000}s ueberschritten.`
          : 'Auftrag wurde abgebrochen.';
        auftragSchreiben(a);
        return fertig();
      }

      let daten = null;
      try { daten = JSON.parse(aus); } catch { /* unten behandelt */ }

      if (!daten) {
        a.status = 'fehler';
        a.fehler = fehlerAus.trim() || `Claude Code endete mit Code ${code} ohne verwertbare Ausgabe.`;
        a.rohausgabe = aus.slice(0, 4000);
        auftragSchreiben(a);
        return fertig();
      }

      if (daten.is_error) {
        a.status = 'fehler';
        a.fehler = daten.result || 'Unbekannter Fehler aus Claude Code.';
        // Die haeufigste Ursache im Dauerbetrieb gleich benennen.
        if (/authenticate|OAuth/i.test(a.fehler)) {
          a.hinweis = 'Anmeldung abgelaufen. Auf dem Server "claude setup-token" ausfuehren ' +
                      'und den Wert als CLAUDE_CODE_OAUTH_TOKEN hinterlegen.';
        }
        auftragSchreiben(a);
        return fertig();
      }

      a.status    = 'fertig';
      a.ergebnis  = daten.result || '';
      a.kosten    = daten.total_cost_usd ?? null;
      a.schritte  = daten.num_turns ?? null;
      a.verbrauch = daten.usage
        ? { ein: daten.usage.input_tokens, aus: daten.usage.output_tokens }
        : null;
      fs.writeFileSync(path.join(auftragOrdner(aid), 'ergebnis.md'), a.ergebnis);
      auftragSchreiben(a);
      fertig();
    });
  });
}
