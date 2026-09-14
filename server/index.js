import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PORT, HOST, OEFFENTLICH, MAX_UPLOAD, CLAUDE_BIN } from './config.js';
import {
  id, kennung,
  sitzungenLesen, sitzungenSchreiben,
  einstellungenLesen, einstellungenSchreiben,
  profileListe, profilLesen, profilSchreiben, profilLoeschen,
  wissenSpeichern, wissenIndex, wissenLoeschen,
  auftragLesen, auftragSchreiben, auftraegeListe, auftragLoeschen,
  auftragOrdner, auftraegeAufraeumen
} from './store.js';
import { wecken, abbrechen, beimStartAufraeumen } from './worker.js';

/* ---------------- Anmeldung ---------------- */

const SITZUNG_DAUER = 12 * 3600 * 1000;

// Beim Start uebernehmen, damit ein Update niemanden abmeldet.
const sitzungen = new Map(Object.entries(sitzungenLesen()));

function sitzungenSichern() {
  try { sitzungenSchreiben(Object.fromEntries(sitzungen)); }
  catch { /* Anmeldung funktioniert auch ohne Sicherung weiter */ }
}

function passwortHashen(passwort, salz = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(passwort, salz, 64).toString('hex');
  return `${salz}:${hash}`;
}

function passwortPruefen(passwort, gespeichert) {
  if (!gespeichert) return false;
  const [salz, hash] = gespeichert.split(':');
  const versuch = crypto.scryptSync(passwort, salz, 64).toString('hex');
  // Zeitkonstanter Vergleich, damit sich das Passwort nicht erraten laesst.
  const a = Buffer.from(versuch, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function angemeldet(req) {
  const kopf = req.headers.authorization || '';
  const token = kopf.startsWith('Bearer ') ? kopf.slice(7) : null;
  if (!token) return false;
  const ablauf = sitzungen.get(token);
  if (!ablauf || ablauf < Date.now()) {
    if (sitzungen.delete(token)) sitzungenSichern();
    return false;
  }
  return true;
}

/* ---------------- Hilfen ---------------- */

function antwort(res, code, wert, kopfzeilen = {}) {
  const koerper = JSON.stringify(wert);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...kopfzeilen
  });
  res.end(koerper);
}

function koerperLesen(req, grenze = MAX_UPLOAD) {
  return new Promise((fertig, fehler) => {
    const teile = [];
    let laenge = 0;
    req.on('data', d => {
      laenge += d.length;
      if (laenge > grenze) {
        fehler(new Error(
          `Anfrage zu gross: Grenze ${Math.round(grenze / 1048576)} MB. ` +
          `Bei mehreren Dateien die Menge aufteilen und in zwei Auftraegen ablegen.`));
        req.destroy();
        return;
      }
      teile.push(d);
    });
    req.on('end', () => {
      const roh = Buffer.concat(teile).toString('utf8');
      if (!roh) return fertig({});
      try { fertig(JSON.parse(roh)); }
      catch { fehler(new Error('Ungueltiges JSON im Anfragekoerper.')); }
    });
    req.on('error', fehler);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* Kennungen aus der Adresszeile duerfen niemals zu einem anderen Ordner
   fuehren - nur die Zeichen, die kennung() auch erzeugt. */
const KENNUNG_ERLAUBT = /^[a-z0-9][a-z0-9-]{0,79}$/;

function statischAusliefern(res, pfad) {
  // Pfaddurchquerung ausschliessen: aufgeloester Pfad muss im public-Ordner liegen.
  const ziel = path.resolve(OEFFENTLICH, '.' + pfad);
  if (!ziel.startsWith(OEFFENTLICH)) { res.writeHead(403); return res.end('Verboten'); }
  const datei = fs.existsSync(ziel) && fs.statSync(ziel).isDirectory()
    ? path.join(ziel, 'index.html') : ziel;
  if (!fs.existsSync(datei)) { res.writeHead(404); return res.end('Nicht gefunden'); }

  /* Ohne diese Zeile entscheidet ein vorgeschalteter Zwischenspeicher selbst,
     wie lange er die Datei behaelt - bei Cloudflare vier Stunden. Ein Update
     kaeme dann erst Stunden spaeter an. "no-cache" heisst nicht "gar nicht
     speichern", sondern "vor jeder Nutzung nachfragen, ob es etwas Neues gibt".
     Ueber last-modified bleibt der Abgleich billig. */
  const stat = fs.statSync(datei);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(datei)] || 'application/octet-stream',
    'Cache-Control': 'no-cache, must-revalidate',
    'Last-Modified': stat.mtime.toUTCString()
  });
  fs.createReadStream(datei).pipe(res);
}

/* ---------------- Platzhalter zu Eingabefeldern ---------------- */

/* Viele Anweisungen enthalten eckige Platzhalter, die beim Einfuegen in den Chat
   von Hand ersetzt wurden - "[Firma, Ort]", "[Auditart, Datum, Auditor]".
   Daraus werden Eingabefelder, die das Dashboard beim Ablegen abfragt. */

const FELD_STOPPLISTE = /^(datei|dateiname|liste|anlage|anhang|anhänge|anhaenge|liste bzw\.? anhänge|dokumente?)$/i;

// Diese Anweisungen gliedern sich mit Versalien-Ueberschriften: ROLLE, ABSCHNITT,
// AUFGABE. Steht ein Platzhalter allein unter einer solchen Zeile, ist die
// Ueberschrift seine Beschriftung.
const UEBERSCHRIFT = /^[A-ZÄÖÜ][A-ZÄÖÜß0-9 \-/()]{2,40}$/;

export function felderErkennen(anweisung) {
  const felder = [];
  const gesehen = new Set();
  let letzteUeberschrift = null;

  for (const zeile of String(anweisung || '').split('\n')) {
    const blank = zeile.trim();
    if (UEBERSCHRIFT.test(blank)) { letzteUeberschrift = blank; continue; }

    const treffer = zeile.match(/\[[^\]\n]{2,80}\]/g);
    if (!treffer) continue;

    for (const t of treffer) {
      const inhalt = t.slice(1, -1).trim();
      const davor = zeile.slice(0, zeile.indexOf(t));

      // "Registernummer: [z. B. ...]" -> Beschriftung steht vor dem Doppelpunkt.
      const mitDoppelpunkt = davor.match(/([^:\-*#|]{2,44}):\s*$/);
      // Steht der Platzhalter allein auf der Zeile, traegt die Ueberschrift den Namen.
      const alleinUnterUeberschrift = !mitDoppelpunkt && blank === t && letzteUeberschrift;

      let beschriftung, platzhalter;
      if (mitDoppelpunkt) {
        beschriftung = mitDoppelpunkt[1].trim();
        platzhalter = inhalt;
      } else if (alleinUnterUeberschrift) {
        beschriftung = letzteUeberschrift.charAt(0) + letzteUeberschrift.slice(1).toLowerCase();
        platzhalter = inhalt;
      } else {
        // Reine Beispiele ohne eigene Beschriftung taugen nicht als Feldname.
        if (/^z\.\s*B\./i.test(inhalt)) continue;
        beschriftung = inhalt;
        platzhalter = '';
      }

      if (FELD_STOPPLISTE.test(beschriftung)) continue;

      const schluessel = kennung(beschriftung);
      if (!schluessel || gesehen.has(schluessel)) continue;
      gesehen.add(schluessel);

      felder.push({ schluessel, beschriftung, platzhalter, pflicht: false });
    }
  }
  return felder.slice(0, 8);
}

/* ---------------- Import aus claude.ai ---------------- */

/* Nimmt den Export der Projektliste entgegen und legt daraus Profile an.
   Dubletten (gleicher Name, gleiche Anweisung) werden zusammengefasst,
   Projekte ohne Anweisung als "unvollstaendig" markiert. */
function importVerarbeiten(nutzlast) {
  const projekte = Array.isArray(nutzlast?.projects) ? nutzlast.projects : [];
  if (!projekte.length) throw new Error('Der Export enthaelt keine Projekte.');

  const vorhanden = new Map(profileListe().map(p => [p.id, p]));
  const gesehen = new Set();
  let neu = 0, aktualisiert = 0, uebersprungen = 0, dubletten = 0, wissenNeu = 0;

  for (const p of projekte) {
    const anweisung = (p.prompt_template || '').trim();
    const name = (p.name || '').trim() || 'Ohne Namen';

    // Aus den bisherigen Chats abgeleitet: fester Text bzw. freies Feld.
    const startAnweisung = String(p.startAnweisung || '').trim() || null;
    const freitext = p.freitext || null;

    // Brauchbar ist ein Projekt, wenn es eine Anweisung hat ODER sich aus den
    // Chats ein wiederkehrender Auftrag ableiten liess. Viele Projekte haben
    // gar keine Projektanweisung - ihre Logik steckt allein in den Chats.
    if (!anweisung && !startAnweisung && !freitext) { uebersprungen++; continue; }

    // Dublettenerkennung ueber Name, Anweisung und abgeleitetem Auftrag.
    const fingerabdruck = crypto.createHash('sha256')
      .update(`${name}|${anweisung}|${startAnweisung || ''}`).digest('hex').slice(0, 16);
    if (gesehen.has(fingerabdruck)) { dubletten++; continue; }
    gesehen.add(fingerabdruck);

    const wissen = [];
    for (const d of p.docs || []) {
      if (!d.content) continue;
      const name = d.file_name || 'dokument';
      const hash = wissenSpeichern(name, d.content, { alsText: true });
      wissen.push({ hash, dateiname: /\.txt$/i.test(name) ? name : `${name}.txt`, endung: '.txt', zeichen: d.content.length });
      wissenNeu++;
    }

    // Hochgeladene Projektdateien fuehrt claude.ai getrennt von den
    // Kontextdokumenten. Bringt der Import sie als Inhalt mit, werden sie im
    // Originalformat abgelegt; kommen nur Namen an, bleiben sie als offener
    // Punkt am Modul stehen.
    const fehlendeDateien = [];
    for (const f of p.files || []) {
      if (typeof f === 'string') { fehlendeDateien.push(f); continue; }
      const name = f.file_name || 'projektdatei';
      if (!f.inhaltBase64) { fehlendeDateien.push(name); continue; }
      try {
        const daten = Buffer.from(f.inhaltBase64, 'base64');
        if (!daten.length) { fehlendeDateien.push(name); continue; }
        const hash = wissenSpeichern(name, daten);
        if (!wissen.some(w => w.hash === hash)) {
          wissen.push({ hash, dateiname: name, endung: wissenIndex()[hash].endung, bytes: daten.length });
        }
        wissenNeu++;
      } catch { fehlendeDateien.push(name); }
    }

    const pid = kennung(name);
    const alt = vorhanden.get(pid);
    const profil = {
      id: pid,
      name,
      anweisung,
      wissen,
      felder: alt?.felder?.length ? alt.felder : (p.felder || felderErkennen(anweisung)),
      fehlendeDateien,
      aktiv: alt ? alt.aktiv : false,   // Import schaltet nichts ungefragt frei
      modell: alt?.modell || null,
      werkzeuge: alt?.werkzeuge || null,
      zeitlimitSek: alt?.zeitlimitSek || null,
      startAnweisung: startAnweisung || alt?.startAnweisung || null,
      freitext: freitext !== null ? freitext : (alt?.freitext || null),
      // Woraus die Einstellung abgeleitet wurde - damit im Admin-Center
      // nachvollziehbar bleibt, warum ein Modul so eingestellt ist.
      herkunft: p.herkunft || alt?.herkunft || null,
      quelle: { system: 'claude.ai', projektId: p.uuid, importiert: new Date().toISOString() },
      erstellt: alt?.erstellt
    };
    profilSchreiben(profil);
    if (alt) aktualisiert++; else neu++;
  }

  return { gesamt: projekte.length, neu, aktualisiert, uebersprungen, dubletten, wissenNeu };
}

/* ---------------- Anfragen ---------------- */

async function behandeln(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pfad = url.pathname;
  const m = req.method;

  // CORS nur fuer den Import aus claude.ai.
  // Chrome behandelt den Zugriff einer oeffentlichen Seite auf das lokale Netz
  // gesondert (Private Network Access) und verlangt dafuer einen eigenen Header
  // in der Vorabanfrage - ohne ihn scheitert der Import mit "Failed to fetch".
  if (pfad === '/api/import') {
    res.setHeader('Access-Control-Allow-Origin', 'https://claude.ai');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  if (!pfad.startsWith('/api/')) {
    if (m !== 'GET') { res.writeHead(405); return res.end(); }
    return statischAusliefern(res, pfad === '/' ? '/index.html' : pfad);
  }

  const e = einstellungenLesen();
  const eingerichtet = Boolean(e.adminPasswort);
  const istAdmin = angemeldet(req);

  const nurAdmin = () => {
    if (istAdmin) return false;
    antwort(res, 401, { fehler: 'Nicht angemeldet.' });
    return true;
  };

  /* Ist der Zugang geschuetzt, bleibt ohne Anmeldung nur das Noetigste offen:
     der Zustand (damit die Oberflaeche weiss, dass sie fragen muss), die
     Anmeldung selbst und die Ersteinrichtung. Das ist Pflicht, sobald der
     Dienst aus dem Internet erreichbar ist. */
  const OHNE_ANMELDUNG = new Set(['/api/status', '/api/anmelden', '/api/abmelden', '/api/einrichten']);
  // Der Import bringt seinen eigenen Schluessel mit - er laeuft aus dem
  // claude.ai-Tab heraus, wo keine Anmeldung am Pruefstand moeglich ist.
  const mitImportSchluessel =
    pfad === '/api/import' && e.importSchluessel &&
    url.searchParams.get('schluessel') === e.importSchluessel;
  if (e.zugangSchutz === 'passwort' && !istAdmin && !mitImportSchluessel && !OHNE_ANMELDUNG.has(pfad)) {
    return antwort(res, 401, { fehler: 'Anmeldung erforderlich.' });
  }

  try {
    /* --- Zustand und Anmeldung --- */

    /* Zeigt, ob der Anmeldetoken sauber im Container ankommt - ohne ihn
       preiszugeben. Laenge und Raender genuegen, um abgeschnittene Werte,
       Anfuehrungszeichen oder Zeilenumbrueche zu erkennen. Nur fuer Angemeldete. */
    if (pfad === '/api/diagnose' && m === 'GET') {
      if (nurAdmin()) return;
      const gespeichert = einstellungenLesen().claudeToken || '';
      const ausUmgebung = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
      const t = gespeichert || ausUmgebung;
      return antwort(res, 200, {
        tokenVorhanden: Boolean(t),
        quelle: gespeichert ? 'Admin-Center' : (ausUmgebung ? '.env' : 'keine'),
        laengeAdminCenter: gespeichert.length,
        laengeUmgebung: ausUmgebung.length,
        laenge: t.length,
        beginnt: t.slice(0, 14),
        endet: t.slice(-4),
        beginntRichtig: t.startsWith('sk-ant-oat'),
        enthaeltZeilenumbruch: /[\r\n]/.test(t),
        enthaeltAnfuehrungszeichen: /["']/.test(t),
        randLeerzeichen: t !== t.trim(),
        benutzer: typeof process.getuid === 'function' ? process.getuid() : null,
        arbeitsverzeichnis: process.cwd()
      });
    }

    if (pfad === '/api/status' && m === 'GET') {
      const auftraege = auftraegeListe({ limit: 100000 });
      return antwort(res, 200, {
        eingerichtet,
        admin: istAdmin,
        schutz: e.zugangSchutz || 'offen',
        claudeBin: CLAUDE_BIN,
        profile: profileListe().filter(p => p.aktiv).length,
        profileGesamt: profileListe().length,
        warteschlange: auftraege.filter(a => a.status === 'wartet').length,
        laufend: auftraege.filter(a => a.status === 'laeuft').length
      });
    }

    if (pfad === '/api/einrichten' && m === 'POST') {
      if (eingerichtet) return antwort(res, 409, { fehler: 'Bereits eingerichtet.' });
      const { passwort } = await koerperLesen(req, 64 * 1024);
      if (!passwort || String(passwort).length < 8) {
        return antwort(res, 400, { fehler: 'Passwort muss mindestens 8 Zeichen haben.' });
      }
      einstellungenSchreiben({
        adminPasswort: passwortHashen(String(passwort)),
        importSchluessel: crypto.randomBytes(24).toString('hex')
      });
      return antwort(res, 200, { ok: true });
    }

    if (pfad === '/api/anmelden' && m === 'POST') {
      const { passwort } = await koerperLesen(req, 64 * 1024);
      if (!passwortPruefen(String(passwort || ''), e.adminPasswort)) {
        return antwort(res, 401, { fehler: 'Passwort falsch.' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      sitzungen.set(token, Date.now() + SITZUNG_DAUER);
      sitzungenSichern();
      return antwort(res, 200, { token });
    }

    if (pfad === '/api/abmelden' && m === 'POST') {
      const kopf = req.headers.authorization || '';
      sitzungen.delete(kopf.startsWith('Bearer ') ? kopf.slice(7) : '');
      sitzungenSichern();
      return antwort(res, 200, { ok: true });
    }

    /* --- Profile --- */

    if (pfad === '/api/profil' && m === 'GET') {
      /* Der Pruefstand zeigt ausschliesslich freigeschaltete Module - auch dann,
         wenn gerade jemand mit Admin-Rechten davorsitzt. Sonst waere die
         Freischaltung wirkungslos und die Liste unbrauchbar lang. Nur das
         Admin-Center fragt mit "?alle=1" ausdruecklich alle ab. */
      const alle = profileListe();
      const willAlle = istAdmin && url.searchParams.get('alle') === '1';
      const liste = (willAlle ? alle : alle.filter(p => p.aktiv)).map(p => ({
        id: p.id, name: p.name, aktiv: p.aktiv,
        anweisungZeichen: (p.anweisung || '').length,
        wissen: (p.wissen || []).length,
        felder: p.felder || [],
        freitext: p.freitext || null,
        herkunft: p.herkunft || null,
        fehlendeDateien: p.fehlendeDateien || [],
        modell: p.modell, quelle: p.quelle?.system || 'eigen',
        geaendert: p.geaendert
      }));
      return antwort(res, 200, liste);
    }

    if (pfad.startsWith('/api/profil/') && m === 'GET') {
      const p = profilLesen(pfad.slice('/api/profil/'.length));
      if (!p) return antwort(res, 404, { fehler: 'Profil nicht gefunden.' });
      if (!p.aktiv && !istAdmin) return antwort(res, 404, { fehler: 'Profil nicht gefunden.' });
      return antwort(res, 200, p);
    }

    if (pfad === '/api/profil' && m === 'POST') {
      if (nurAdmin()) return;
      const koerper = await koerperLesen(req, 4 * 1024 * 1024);
      if (!koerper.name) return antwort(res, 400, { fehler: 'Name fehlt.' });
      return antwort(res, 200, profilSchreiben({
        id: kennung(koerper.name),
        name: koerper.name,
        anweisung: koerper.anweisung || '',
        wissen: koerper.wissen || [],
        felder: koerper.felder || felderErkennen(koerper.anweisung || ''),
        freitext: koerper.freitext || null,
        aktiv: koerper.aktiv !== false,
        modell: koerper.modell || null,
        werkzeuge: koerper.werkzeuge || null,
        zeitlimitSek: koerper.zeitlimitSek || null,
        startAnweisung: koerper.startAnweisung || null,
        quelle: { system: 'eigen' }
      }));
    }

    if (pfad.startsWith('/api/profil/') && (m === 'PUT' || m === 'PATCH')) {
      if (nurAdmin()) return;
      const pid = pfad.slice('/api/profil/'.length);
      const alt = profilLesen(pid);
      if (!alt) return antwort(res, 404, { fehler: 'Profil nicht gefunden.' });
      const koerper = await koerperLesen(req, 4 * 1024 * 1024);
      const erlaubt = ['name', 'anweisung', 'wissen', 'felder', 'fehlendeDateien',
                       'freitext', 'herkunft', 'aktiv', 'modell', 'werkzeuge',
                       'zeitlimitSek', 'startAnweisung'];
      for (const f of erlaubt) if (f in koerper) alt[f] = koerper[f];
      return antwort(res, 200, profilSchreiben(alt));
    }

    // Platzhalter einer Anweisung als Feldvorschlag - eine Implementierung,
    // im Admin-Center und beim Import dieselbe.
    if (pfad === '/api/felder-erkennen' && m === 'POST') {
      if (nurAdmin()) return;
      const { anweisung } = await koerperLesen(req, 4 * 1024 * 1024);
      return antwort(res, 200, felderErkennen(anweisung || ''));
    }

    if (pfad.startsWith('/api/profil/') && m === 'DELETE') {
      if (nurAdmin()) return;
      const weg = profilLoeschen(pfad.slice('/api/profil/'.length));
      return antwort(res, weg ? 200 : 404, { ok: weg });
    }

    /* --- Import aus claude.ai --- */

    if (pfad === '/api/import' && m === 'POST') {
      const schluessel = url.searchParams.get('schluessel');
      const gueltig = istAdmin || (e.importSchluessel && schluessel === e.importSchluessel);
      if (!gueltig) return antwort(res, 401, { fehler: 'Import-Schluessel fehlt oder ist falsch.' });
      const nutzlast = await koerperLesen(req, 128 * 1024 * 1024);
      const bericht = importVerarbeiten(nutzlast);
      return antwort(res, 200, bericht);
    }

    /* --- Wissensdateien --- */

    if (pfad === '/api/wissen' && m === 'GET') {
      if (nurAdmin()) return;
      return antwort(res, 200, Object.values(wissenIndex()));
    }

    if (pfad === '/api/wissen' && m === 'POST') {
      if (nurAdmin()) return;
      const koerper = await koerperLesen(req);
      const name = String(koerper.dateiname || '').trim();
      if (!name) return antwort(res, 400, { fehler: 'Dateiname fehlt.' });
      const daten = Buffer.from(koerper.inhaltBase64 || '', 'base64');
      if (!daten.length) return antwort(res, 400, { fehler: 'Die Datei ist leer.' });
      const hash = wissenSpeichern(name, daten);
      return antwort(res, 200, wissenIndex()[hash]);
    }

    if (pfad.startsWith('/api/wissen/') && m === 'DELETE') {
      if (nurAdmin()) return;
      wissenLoeschen(pfad.slice('/api/wissen/'.length));
      return antwort(res, 200, { ok: true });
    }

    /* --- Auftraege --- */

    if (pfad === '/api/auftrag' && m === 'GET') {
      const liste = auftraegeListe({ limit: Number(url.searchParams.get('limit') || 100) })
        .map(a => ({
          id: a.id, profil: a.profil, profilName: a.profilName, status: a.status,
          dateien: (a.dateien || []).map(d => d.name),
          angelegt: a.angelegt, beendet: a.beendet, dauerSek: a.dauerSek,
          fehler: a.fehler, hinweis: a.hinweis,
          vorschau: a.ergebnis ? a.ergebnis.slice(0, 180) : null
        }));
      return antwort(res, 200, liste);
    }

    if (pfad === '/api/auftrag' && m === 'POST') {
      const koerper = await koerperLesen(req);
      const profil = profilLesen(koerper.profil);
      if (!profil) return antwort(res, 400, { fehler: 'Unbekanntes Profil.' });
      if (!profil.aktiv) return antwort(res, 400, { fehler: 'Profil ist nicht freigeschaltet.' });
      const dateien = Array.isArray(koerper.dateien) ? koerper.dateien : [];
      if (!dateien.length) return antwort(res, 400, { fehler: 'Keine Datei uebergeben.' });

      const aid = id();
      const ordner = path.join(auftragOrdner(aid), 'eingabe');
      fs.mkdirSync(ordner, { recursive: true });

      const abgelegt = [];
      for (const [i, d] of dateien.entries()) {
        // Dateinamen entschaerfen, aber lesbar halten.
        const name = String(d.name || `datei-${i + 1}`).replace(/[/\\]/g, '_').slice(0, 120);
        const gespeichertAls = `${String(i).padStart(2, '0')}-${name}`;
        fs.writeFileSync(path.join(ordner, gespeichertAls), Buffer.from(d.inhaltBase64 || '', 'base64'));
        abgelegt.push({ name, gespeichertAls, bytes: Buffer.from(d.inhaltBase64 || '', 'base64').length });
      }

      const auftrag = auftragSchreiben({
        id: aid,
        profil: profil.id,
        profilName: profil.name,
        dateien: abgelegt,
        angaben: (koerper.angaben && typeof koerper.angaben === 'object') ? koerper.angaben : {},
        freitext: String(koerper.freitext || '').slice(0, 20000),
        status: 'wartet',
        angelegt: new Date().toISOString()
      });
      wecken();
      return antwort(res, 200, auftrag);
    }

    if (pfad.startsWith('/api/auftrag/') && pfad.endsWith('/abbrechen') && m === 'POST') {
      const aid = pfad.slice('/api/auftrag/'.length, -'/abbrechen'.length);
      return antwort(res, 200, { ok: abbrechen(aid) });
    }

    if (pfad.startsWith('/api/auftrag/') && pfad.endsWith('/ergebnis') && m === 'GET') {
      const aid = pfad.slice('/api/auftrag/'.length, -'/ergebnis'.length);
      const a = auftragLesen(aid);
      if (!a || a.status !== 'fertig') return antwort(res, 404, { fehler: 'Kein Ergebnis vorhanden.' });
      const name = `ergebnis-${(a.dateien?.[0]?.name || aid).replace(/\.[^.]+$/, '')}.md`;
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`
      });
      return res.end(a.ergebnis || '');
    }

    if (pfad.startsWith('/api/auftrag/') && m === 'GET') {
      const a = auftragLesen(pfad.slice('/api/auftrag/'.length));
      if (!a) return antwort(res, 404, { fehler: 'Auftrag nicht gefunden.' });
      return antwort(res, 200, a);
    }

    if (pfad.startsWith('/api/auftrag/') && m === 'DELETE') {
      const weg = auftragLoeschen(pfad.slice('/api/auftrag/'.length));
      return antwort(res, weg ? 200 : 404, { ok: weg });
    }

    /* --- Einstellungen --- */

    if (pfad === '/api/einstellungen' && m === 'GET') {
      if (nurAdmin()) return;
      const { adminPasswort, claudeToken, ...rest } = einstellungenLesen();
      rest.claudeTokenLaenge = (claudeToken || '').length;
      return antwort(res, 200, rest);
    }

    if (pfad === '/api/einstellungen' && m === 'PUT') {
      if (nurAdmin()) return;
      const koerper = await koerperLesen(req, 1024 * 1024);
      const neu = {};
      for (const f of ['modell', 'parallel', 'zeitlimitSek', 'werkzeuge',
                       'aufbewahrungTage', 'startAnweisung', 'zugangSchutz']) {
        if (f in koerper) neu[f] = koerper[f];
      }
      if (koerper.neuesPasswort) {
        if (String(koerper.neuesPasswort).length < 8) {
          return antwort(res, 400, { fehler: 'Passwort muss mindestens 8 Zeichen haben.' });
        }
        neu.adminPasswort = passwortHashen(String(koerper.neuesPasswort));
      }
      if (koerper.schluesselErneuern) {
        neu.importSchluessel = crypto.randomBytes(24).toString('hex');
      }
      /* Der Anmeldetoken fuer Claude. Ueber .env ging bei jedem Versuch etwas
         verloren - hier kommt er unveraendert an und die Laenge ist sofort
         sichtbar. Gespeichert wird er, zurueckgegeben nie. */
      if (typeof koerper.claudeToken === 'string') {
        const t = koerper.claudeToken.trim();
        neu.claudeToken = t || null;
      }
      const { adminPasswort, claudeToken, ...rest } = einstellungenSchreiben(neu);
      rest.claudeTokenLaenge = (claudeToken || '').length;
      wecken();
      return antwort(res, 200, rest);
    }

    if (pfad === '/api/aufraeumen' && m === 'POST') {
      if (nurAdmin()) return;
      return antwort(res, 200, { entfernt: auftraegeAufraeumen() });
    }

    return antwort(res, 404, { fehler: 'Unbekannte Schnittstelle.' });

  } catch (err) {
    return antwort(res, 400, { fehler: err.message });
  }
}

/* ---------------- Start ---------------- */

const zurueckgestellt = beimStartAufraeumen();
if (zurueckgestellt) console.log(`${zurueckgestellt} unterbrochene Auftraege neu eingereiht.`);

http.createServer((req, res) => { behandeln(req, res); }).listen(PORT, HOST, () => {
  const e = einstellungenLesen();
  console.log(`PEFC-Dashboard laeuft auf http://localhost:${PORT}`);
  if (!e.adminPasswort) console.log('Noch nicht eingerichtet - beim ersten Aufruf Admin-Passwort setzen.');
  wecken();
});

// Alte Auftraege einmal taeglich aufraeumen.
setInterval(() => { try { auftraegeAufraeumen(); } catch {} }, 24 * 3600 * 1000).unref();
