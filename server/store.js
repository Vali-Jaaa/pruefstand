import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATEN, PROFIL_DIR, WISSEN_DIR, AUFTRAG_DIR, STANDARD_EINSTELLUNGEN } from './config.js';

for (const d of [DATEN, PROFIL_DIR, WISSEN_DIR, AUFTRAG_DIR]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (err) {
    // Im Container ist das fast immer der Datentraeger vom Host, dessen
    // Eigentuemer nicht zum Benutzer im Container passt. Klartext statt Stapel.
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.error(
        `\nDer Datenordner ist nicht beschreibbar: ${d}\n` +
        `Der Dienst laeuft als Benutzer "${process.getuid?.() ?? '?'}" und darf dort nicht schreiben.\n` +
        `Im Container uebernimmt das Startskript docker/einstieg.sh diese Angleichung - ` +
        `laeuft der Dienst direkt auf dem Rechner, die Schreibrechte des Ordners pruefen.\n`
      );
      process.exit(1);
    }
    throw err;
  }
}

const EINSTELLUNGEN_DATEI = path.join(DATEN, 'einstellungen.json');

/* ---------- Hilfsfunktionen ---------- */

export function id() {
  return crypto.randomBytes(8).toString('hex');
}

/** Macht aus einem Projektnamen eine dateisystemtaugliche Kennung. */
export function kennung(name) {
  return String(name)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'profil';
}

function lesen(datei, ersatz) {
  try { return JSON.parse(fs.readFileSync(datei, 'utf8')); }
  catch { return ersatz; }
}

/** Schreibt atomar: erst in eine Nebendatei, dann umbenennen. Verhindert halbe Dateien. */
function schreiben(datei, wert) {
  const temp = datei + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(wert, null, 2));
  fs.renameSync(temp, datei);
}

/* ---------- Einstellungen ---------- */

export function einstellungenLesen() {
  return { ...STANDARD_EINSTELLUNGEN, ...lesen(EINSTELLUNGEN_DATEI, {}) };
}

export function einstellungenSchreiben(neu) {
  const zusammen = { ...einstellungenLesen(), ...neu };
  schreiben(EINSTELLUNGEN_DATEI, zusammen);
  return zusammen;
}

/* ---------- Profile ---------- */
/* Ein Profil entspricht einem frueheren Claude-Projekt:
   Name + Anweisungen (Systemprompt) + verknuepfte Wissensdateien. */

export function profileListe() {
  return fs.readdirSync(PROFIL_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => lesen(path.join(PROFIL_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export function profilLesen(pid) {
  return lesen(path.join(PROFIL_DIR, `${pid}.json`), null);
}

export function profilSchreiben(profil) {
  if (!profil.id) profil.id = kennung(profil.name);
  profil.geaendert = new Date().toISOString();
  if (!profil.erstellt) profil.erstellt = profil.geaendert;
  schreiben(path.join(PROFIL_DIR, `${profil.id}.json`), profil);
  return profil;
}

export function profilLoeschen(pid) {
  const datei = path.join(PROFIL_DIR, `${pid}.json`);
  if (fs.existsSync(datei)) { fs.unlinkSync(datei); return true; }
  return false;
}

/* ---------- Referenzdateien ---------- */
/* Zentral abgelegt und ueber ihren Hash eindeutig: dasselbe Dokument, das an
   mehreren Modulen haengt, liegt genau einmal auf der Platte.
   Beliebige Dateitypen - eine hochgeladene PDF bleibt eine PDF, damit Claude
   sie so lesen kann wie in claude.ai. Aus claude.ai uebernommene Inhalte sind
   bereits Text und bekommen ".txt". */

function endungVon(dateiname) {
  const e = path.extname(String(dateiname || '')).toLowerCase();
  // Endungen mit Sonderzeichen oder ungewoehnlicher Laenge nicht uebernehmen.
  return /^\.[a-z0-9]{1,8}$/.test(e) ? e : '.bin';
}

/** Name, unter dem die Datei im Arbeitsordner eines Auftrags landet. */
export function wissenDateiname(eintrag) {
  const roh = String(eintrag.dateiname || eintrag.hash || 'referenz');
  const sicher = roh.replace(/[/\\]/g, '_').slice(0, 120);
  // Altbestand ohne "endung" wurde als Text abgelegt, auch wenn der Name
  // auf .pdf endet - der bekommt sein ".txt" zurueck.
  if (!eintrag.endung) return /\.txt$/i.test(sicher) ? sicher : `${sicher}.txt`;
  return sicher;
}

/**
 * @param {string} dateiname  Anzeigename, moeglichst mit passender Endung
 * @param {Buffer|string} inhalt
 * @param {{alsText?: boolean}} optionen  alsText: Inhalt ist reiner Text (Import)
 */
export function wissenSpeichern(dateiname, inhalt, { alsText = false } = {}) {
  const daten = Buffer.isBuffer(inhalt) ? inhalt : Buffer.from(String(inhalt), 'utf8');
  const hash = crypto.createHash('sha256').update(daten).digest('hex').slice(0, 16);

  const anzeige = alsText && !/\.txt$/i.test(dateiname) ? `${dateiname}.txt` : dateiname;
  const endung = alsText ? '.txt' : endungVon(dateiname);

  const ziel = path.join(WISSEN_DIR, `${hash}${endung}`);
  if (!fs.existsSync(ziel)) fs.writeFileSync(ziel, daten);

  const index = wissenIndex();
  index[hash] = {
    hash,
    dateiname: anzeige,
    endung,
    bytes: daten.length,
    // Bei Text weiterhin die Zeichenzahl zeigen, das ist dort die sprechendere Groesse.
    zeichen: alsText ? daten.toString('utf8').length : null,
    angelegt: index[hash]?.angelegt || new Date().toISOString()
  };
  schreiben(path.join(WISSEN_DIR, 'index.json'), index);
  return hash;
}

export function wissenIndex() {
  return lesen(path.join(WISSEN_DIR, 'index.json'), {});
}

/** Liefert den Dateiinhalt als Buffer, oder null. */
export function wissenLesen(hash) {
  const eintrag = wissenIndex()[hash];
  const endung = eintrag?.endung || '.txt';
  const datei = path.join(WISSEN_DIR, `${hash}${endung}`);
  return fs.existsSync(datei) ? fs.readFileSync(datei) : null;
}

export function wissenLoeschen(hash) {
  const eintrag = wissenIndex()[hash];
  const datei = path.join(WISSEN_DIR, `${hash}${eintrag?.endung || '.txt'}`);
  if (fs.existsSync(datei)) fs.unlinkSync(datei);
  const index = wissenIndex();
  delete index[hash];
  schreiben(path.join(WISSEN_DIR, 'index.json'), index);
}

/* ---------- Auftraege ---------- */

export function auftragOrdner(aid) {
  return path.join(AUFTRAG_DIR, aid);
}

export function auftragLesen(aid) {
  return lesen(path.join(auftragOrdner(aid), 'auftrag.json'), null);
}

export function auftragSchreiben(auftrag) {
  const ordner = auftragOrdner(auftrag.id);
  fs.mkdirSync(ordner, { recursive: true });
  schreiben(path.join(ordner, 'auftrag.json'), auftrag);
  return auftrag;
}

export function auftraegeListe({ limit = 200 } = {}) {
  if (!fs.existsSync(AUFTRAG_DIR)) return [];
  return fs.readdirSync(AUFTRAG_DIR)
    .map(a => auftragLesen(a))
    .filter(Boolean)
    .sort((a, b) => (b.angelegt || '').localeCompare(a.angelegt || ''))
    .slice(0, limit);
}

export function auftragLoeschen(aid) {
  const ordner = auftragOrdner(aid);
  if (fs.existsSync(ordner)) { fs.rmSync(ordner, { recursive: true, force: true }); return true; }
  return false;
}

/** Entfernt Auftraege, die aelter sind als die eingestellte Aufbewahrungsfrist. */
export function auftraegeAufraeumen() {
  const { aufbewahrungTage } = einstellungenLesen();
  if (!aufbewahrungTage) return 0;
  const grenze = Date.now() - aufbewahrungTage * 86400000;
  let weg = 0;
  for (const a of auftraegeListe({ limit: 100000 })) {
    if (new Date(a.angelegt).getTime() < grenze) { auftragLoeschen(a.id); weg++; }
  }
  return weg;
}
