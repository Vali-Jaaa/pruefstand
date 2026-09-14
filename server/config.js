import { fileURLToPath } from 'node:url';
import path from 'node:path';

const hier = path.dirname(fileURLToPath(import.meta.url));

export const WURZEL      = path.resolve(hier, '..');
export const DATEN       = process.env.PEFC_DATEN  || path.join(WURZEL, 'daten');
export const PROFIL_DIR  = path.join(DATEN, 'profil');
export const WISSEN_DIR  = path.join(DATEN, 'wissen');
export const AUFTRAG_DIR = path.join(DATEN, 'auftraege');
export const OEFFENTLICH = path.join(WURZEL, 'public');

export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '0.0.0.0';

// Pfad zur Claude-Code-CLI. Im Container liegt sie global.
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Obergrenze fuer eine komplette Anfrage (Bytes) - bei mehreren Dateien zaehlt
// die Summe, plus rund ein Drittel Aufschlag durch die Kodierung. Darueber
// liegt die Grenze von Cloudflare (100 MB), die wir nicht ueberschreiten wollen.
export const MAX_UPLOAD = Number(process.env.PEFC_MAX_UPLOAD || 96 * 1024 * 1024);

export const STANDARD_EINSTELLUNGEN = {
  modell: 'sonnet',
  parallel: 1,
  zeitlimitSek: 900,
  werkzeuge: ['Read', 'Glob', 'Grep', 'Bash'],
  aufbewahrungTage: 90,
  adminPasswort: null,       // wird beim ersten Start gesetzt

  // "offen"    - jeder im Netz darf Dateien ablegen (nur fuer das Heimnetz)
  // "passwort" - auch der Pruefstand verlangt das Passwort (Pflicht, sobald
  //              der Dienst aus dem Internet erreichbar ist)
  zugangSchutz: 'offen',

  startAnweisung:
    'Die Dateien im Ordner "eingabe" sind die vorgelegten Unterlagen. Bearbeite sie streng ' +
    'nach den dir gegebenen Anweisungen. Ergaenzendes Referenzmaterial liegt im Ordner ' +
    '"wissen" und darf nachgeschlagen werden. Gib ausschliesslich das fertige Ergebnis aus - ' +
    'keine Einleitung, keine Erklaerung deines Vorgehens, keine Rueckfragen.'
};
