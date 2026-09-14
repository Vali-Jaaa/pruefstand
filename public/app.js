/* Prüfstand — Dashboard
   Datei ablegen, Modul wählen, Ergebnis abholen. */

const $ = (s) => document.querySelector(s);

let dateien = [];          // { name, groesse, inhaltBase64 }
let gewaehltesModul = null;
let module = [];
let letzterStand = '';
let uhrzeitTakt = null;
let token = sessionStorage.getItem('pruefstand-token') || null;

/* ---------- Schnittstelle ---------- */

async function hole(pfad, optionen = {}) {
  const antwort = await fetch(pfad, {
    ...optionen,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(optionen.headers || {})
    }
  });
  const text = await antwort.text();
  let daten = null;
  try { daten = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  if (antwort.status === 401 && pfad !== '/api/anmelden') { anmeldungZeigen(); }
  if (!antwort.ok) throw new Error(daten?.fehler || `Fehler ${antwort.status}`);
  return daten;
}

/* ---------- Anmeldung (nur bei geschütztem Zugang) ---------- */

function anmeldungZeigen() {
  clearInterval(uhrzeitTakt);
  token = null;
  sessionStorage.removeItem('pruefstand-token');
  $('#anmeldung').classList.remove('versteckt');
  $('#hauptbereich').classList.add('versteckt');
  $('#einrichtung').classList.add('versteckt');
}

async function anmelden() {
  try {
    const { token: neu } = await hole('/api/anmelden', {
      method: 'POST',
      body: JSON.stringify({ passwort: $('#passwort').value })
    });
    token = neu;
    sessionStorage.setItem('pruefstand-token', token);
    $('#passwort').value = '';
    $('#anmeldung').classList.add('versteckt');
    $('#hauptbereich').classList.remove('versteckt');
    letzterStand = '';
    starten_ueberwachung();
  } catch (err) {
    meldung($('#anmelde-fehler'), err.message);
  }
}

/* ---------- Darstellungshilfen ---------- */

function bytesLesbar(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function dauerLesbar(sek) {
  if (sek == null) return '';
  const m = Math.floor(sek / 60), s = sek % 60;
  return m ? `${m}:${String(s).padStart(2, '0')} min` : `${s} s`;
}

function seitdem(zeitpunkt) {
  const sek = Math.max(0, Math.round((Date.now() - new Date(zeitpunkt)) / 1000));
  return dauerLesbar(sek);
}

const ZUSTAND_TEXT = {
  wartet: 'wartet', laeuft: 'läuft', fertig: 'fertig',
  fehler: 'Fehler', abgebrochen: 'abgebrochen'
};

function text(el, wert) { el.textContent = wert; return el; }

function meldung(el, inhalt, art = 'fehler') {
  if (!inhalt) { el.classList.add('versteckt'); return; }
  el.textContent = inhalt;
  el.className = art === 'hinweis' ? 'meldung hinweis' : 'meldung';
}

/* ---------- Ablage ---------- */

function dateilisteZeichnen() {
  const liste = $('#dateiliste');
  liste.replaceChildren();
  for (const [i, d] of dateien.entries()) {
    const li = document.createElement('li');
    li.append(text(document.createElement('span'), d.name));
    const gr = text(document.createElement('span'), bytesLesbar(d.groesse));
    gr.className = 'groesse';
    li.append(gr);
    const weg = text(document.createElement('button'), '×');
    weg.className = 'weg';
    weg.title = 'Datei entfernen';
    weg.setAttribute('aria-label', `${d.name} entfernen`);
    weg.onclick = () => { dateien.splice(i, 1); dateilisteZeichnen(); knopfPruefen(); };
    li.append(weg);
    liste.append(li);
  }
  $('#ablagefeld').classList.toggle('bereit', dateien.length > 0);
  $('#ablagefeld').querySelector('.feld-titel').textContent =
    dateien.length ? `${dateien.length} Datei${dateien.length > 1 ? 'en' : ''} bereit` : 'Datei hierher ziehen';
  $('#ablagefeld').querySelector('.feld-hinweis').textContent =
    dateien.length ? 'weitere hinzufügen oder Modul wählen' : 'oder klicken zum Auswählen';
}

function alsBase64(datei) {
  return new Promise((fertig, fehler) => {
    const leser = new FileReader();
    leser.onload = () => fertig(String(leser.result).split(',')[1] || '');
    leser.onerror = () => fehler(new Error(`"${datei.name}" konnte nicht gelesen werden.`));
    leser.readAsDataURL(datei);
  });
}

async function dateienAufnehmen(auswahl) {
  meldung($('#ablage-meldung'), null);
  const liste = Array.from(auswahl);
  const uebersprungen = [];

  for (const f of liste) {
    if (f.size > 64 * 1024 * 1024) {
      uebersprungen.push(`${f.name} (größer als 64 MB)`);
      continue;
    }
    try {
      dateien.push({ name: f.name, groesse: f.size, inhaltBase64: await alsBase64(f) });
    } catch {
      uebersprungen.push(`${f.name} (nicht lesbar)`);
    }
  }
  dateilisteZeichnen();
  knopfPruefen();

  // Sichtbar machen, wenn nicht alles angekommen ist - frueher fiel das nicht auf.
  if (uebersprungen.length) {
    meldung($('#ablage-meldung'),
      `Nicht übernommen: ${uebersprungen.join(', ')}. ${liste.length - uebersprungen.length} von ${liste.length} Dateien liegen bereit.`);
  }

  // Gesamtmenge im Blick behalten: alles geht in einer Anfrage zum Server.
  const gesamt = dateien.reduce((a, d) => a + d.groesse, 0);
  if (gesamt > 60 * 1024 * 1024) {
    meldung($('#ablage-meldung'),
      `${bytesLesbar(gesamt)} insgesamt — das ist viel für eine Übertragung. ` +
      `Wenn der Start fehlschlägt, die Dateien auf zwei Aufträge aufteilen.`, 'hinweis');
  }
}

function angabenZeichnen() {
  const bereich = $('#angaben-bereich');
  const behaelter = $('#angabenfelder');
  const modul = module.find(m => m.id === gewaehltesModul);
  const felder = modul?.felder || [];

  if (!felder.length) { bereich.classList.add('versteckt'); behaelter.replaceChildren(); return; }
  bereich.classList.remove('versteckt');

  // Bereits Eingetragenes beim Neuzeichnen behalten.
  const bisher = {};
  for (const el of behaelter.querySelectorAll('input')) bisher[el.dataset.schluessel] = el.value;

  behaelter.replaceChildren();
  for (const f of felder) {
    const huelle = document.createElement('div');
    huelle.style.marginBottom = '10px';

    const marke = document.createElement('label');
    marke.className = 'feldname';
    marke.textContent = f.beschriftung + (f.pflicht ? ' *' : '');
    marke.htmlFor = `angabe-${f.schluessel}`;
    huelle.append(marke);

    const eingabe = document.createElement('input');
    eingabe.type = 'text';
    eingabe.id = `angabe-${f.schluessel}`;
    eingabe.dataset.schluessel = f.schluessel;
    eingabe.placeholder = f.platzhalter || '';
    eingabe.value = bisher[f.schluessel] ?? (localStorage.getItem(`angabe-${gewaehltesModul}-${f.schluessel}`) || '');
    eingabe.oninput = () => {
      // Wiederkehrende Angaben wie Firma oder Registernummer merken.
      localStorage.setItem(`angabe-${gewaehltesModul}-${f.schluessel}`, eingabe.value);
      knopfPruefen();
    };
    huelle.append(eingabe);
    behaelter.append(huelle);
  }
}

function freitextZeichnen() {
  const bereich = $('#freitext-bereich');
  const modul = module.find(m => m.id === gewaehltesModul);
  const f = modul?.freitext;

  if (!f?.aktiv) { bereich.classList.add('versteckt'); return; }
  bereich.classList.remove('versteckt');
  $('#freitext-marke').textContent = f.beschriftung || 'Anmerkung';
  const feld = $('#freitext');
  feld.placeholder = f.platzhalter || '';
  // Beim Modulwechsel nicht den Text des vorigen Moduls stehen lassen.
  if (feld.dataset.modul !== gewaehltesModul) {
    feld.value = '';
    feld.dataset.modul = gewaehltesModul;
  }
}

function angabenSammeln() {
  const werte = {};
  for (const el of $('#angabenfelder').querySelectorAll('input')) {
    if (el.value.trim()) werte[el.dataset.schluessel] = el.value.trim();
  }
  return werte;
}

function pflichtfelderOffen() {
  const modul = module.find(m => m.id === gewaehltesModul);
  const werte = angabenSammeln();
  return (modul?.felder || []).filter(f => f.pflicht && !werte[f.schluessel]);
}

function knopfPruefen() {
  const offen = pflichtfelderOffen();
  $('#start-knopf').disabled = !(dateien.length && gewaehltesModul) || offen.length > 0;
  if (offen.length) {
    meldung($('#ablage-meldung'), `Noch auszufüllen: ${offen.map(f => f.beschriftung).join(', ')}.`, 'hinweis');
  }
}

/* ---------- Module ---------- */

function moduleZeichnen() {
  const behaelter = $('#modulliste');
  behaelter.replaceChildren();

  if (!module.length) {
    const p = document.createElement('p');
    p.className = 'feld-hinweis';
    p.textContent = 'Noch kein Modul freigeschaltet. Im Admin-Center Projekte importieren und freischalten.';
    behaelter.append(p);
    return;
  }

  for (const m of module) {
    const knopf = document.createElement('button');
    knopf.className = 'modul';
    knopf.setAttribute('aria-pressed', String(gewaehltesModul === m.id));
    knopf.onclick = () => {
      gewaehltesModul = m.id;
      localStorage.setItem('pruefstand-modul', m.id);
      moduleZeichnen();
      angabenZeichnen();
      freitextZeichnen();
      knopfPruefen();
    };

    const punkt = document.createElement('span');
    punkt.className = 'modul-punkt';
    knopf.append(punkt);

    const name = text(document.createElement('span'), m.name);
    name.className = 'modul-name';
    name.title = m.name;
    knopf.append(name);

    if (m.wissen) {
      const zahl = text(document.createElement('span'), `${m.wissen} Dok`);
      zahl.className = 'modul-zahl';
      zahl.title = `${m.wissen} hinterlegte Referenzdatei(en)`;
      knopf.append(zahl);
    }

    behaelter.append(knopf);
  }
}

async function moduleLaden() {
  try {
    module = await hole('/api/profil');
    const gemerkt = localStorage.getItem('pruefstand-modul');
    if (gemerkt && module.some(m => m.id === gemerkt)) gewaehltesModul = gemerkt;
    else if (module.length === 1) gewaehltesModul = module[0].id;
    moduleZeichnen();
    angabenZeichnen();
    freitextZeichnen();
    knopfPruefen();
  } catch (err) {
    meldung($('#ablage-meldung'), `Module konnten nicht geladen werden: ${err.message}`);
  }
}

/* ---------- Laufzettel ---------- */

function auftragZeichnen(a) {
  const kasten = document.createElement('article');
  kasten.className = 'auftrag';
  kasten.dataset.status = a.status;

  const schiene = document.createElement('div');
  schiene.className = 'schiene';
  kasten.append(schiene);

  const inhalt = document.createElement('div');
  inhalt.className = 'auftrag-inhalt';

  const zeile = document.createElement('div');
  zeile.className = 'auftrag-zeile';
  const modul = text(document.createElement('span'), a.profilName || a.profil);
  modul.className = 'auftrag-modul';
  zeile.append(modul);
  const datei = text(document.createElement('span'), (a.dateien || []).join(', '));
  datei.className = 'auftrag-datei';
  datei.title = (a.dateien || []).join(', ');
  zeile.append(datei);
  const zustand = text(document.createElement('span'), ZUSTAND_TEXT[a.status] || a.status);
  zustand.className = 'zustand';
  zeile.append(zustand);
  inhalt.append(zeile);

  // Fehler und Hinweise direkt an der Zeile, nicht in einem Nebenkanal.
  if (a.fehler) inhalt.append(text(Object.assign(document.createElement('p'), { className: 'meldung' }), a.fehler));
  if (a.hinweis) inhalt.append(text(Object.assign(document.createElement('p'), { className: 'meldung hinweis' }), a.hinweis));

  // Das Ergebnis erscheint gesetzt wie der Bericht, in den es gehört.
  if (a.status === 'fertig' && a.vorschau) {
    const befund = document.createElement('div');
    befund.className = 'befund';
    befund.dataset.auftrag = a.id;
    befund.textContent = a.vorschau + (a.vorschau.length >= 180 ? ' …' : '');
    inhalt.append(befund);
    // Volltext nachladen, sobald die Karte sichtbar ist.
    volltextNachladen(a.id, befund);
  }

  const fuss = document.createElement('div');
  fuss.className = 'auftrag-fuss';
  const zeit = a.status === 'laeuft'
    ? `seit ${seitdem(a.angelegt)}`
    : (a.dauerSek != null ? dauerLesbar(a.dauerSek) : new Date(a.angelegt).toLocaleString('de-DE'));
  fuss.append(text(document.createElement('span'), zeit));

  const rechts = document.createElement('div');
  rechts.className = 'rechts';

  if (a.status === 'fertig') {
    const kopieren = text(document.createElement('button'), 'Text kopieren');
    kopieren.className = 'knopf leise klein';
    kopieren.onclick = async () => {
      const voll = await hole(`/api/auftrag/${a.id}`);
      await navigator.clipboard.writeText(voll.ergebnis || '');
      kopieren.textContent = 'Kopiert';
      setTimeout(() => { kopieren.textContent = 'Text kopieren'; }, 1600);
    };
    rechts.append(kopieren);

    const laden = document.createElement('a');
    laden.className = 'knopf leise klein';
    laden.href = `/api/auftrag/${a.id}/ergebnis`;
    laden.textContent = 'Herunterladen';
    rechts.append(laden);
  }

  if (a.status === 'wartet' || a.status === 'laeuft') {
    const stopp = text(document.createElement('button'), 'Abbrechen');
    stopp.className = 'knopf leise klein';
    stopp.onclick = async () => {
      await hole(`/api/auftrag/${a.id}/abbrechen`, { method: 'POST' });
      auftraegeLaden();
    };
    rechts.append(stopp);
  }

  if (['fertig', 'fehler', 'abgebrochen'].includes(a.status)) {
    const weg = text(document.createElement('button'), 'Entfernen');
    weg.className = 'knopf leise klein';
    weg.onclick = async () => {
      await hole(`/api/auftrag/${a.id}`, { method: 'DELETE' });
      auftraegeLaden();
    };
    rechts.append(weg);
  }

  fuss.append(rechts);
  inhalt.append(fuss);
  kasten.append(inhalt);
  return kasten;
}

async function volltextNachladen(aid, ziel) {
  try {
    const voll = await hole(`/api/auftrag/${aid}`);
    if (voll?.ergebnis && ziel.isConnected) ziel.textContent = voll.ergebnis;
  } catch { /* Vorschau bleibt stehen */ }
}

async function auftraegeLaden() {
  let liste;
  try { liste = await hole('/api/auftrag'); }
  catch { return; }

  // Nur neu zeichnen, wenn sich etwas geändert hat - sonst springt die Auswahl.
  const stand = JSON.stringify(liste.map(a => [a.id, a.status, a.vorschau]));
  if (stand === letzterStand) {
    // Laufzeiten trotzdem mitzählen.
    for (const a of liste.filter(x => x.status === 'laeuft')) {
      const karte = document.querySelector(`[data-auftrag-id="${a.id}"] .auftrag-fuss span`);
      if (karte) karte.textContent = `seit ${seitdem(a.angelegt)}`;
    }
    return;
  }
  letzterStand = stand;

  const behaelter = $('#auftragsliste');
  behaelter.replaceChildren();

  if (!liste.length) {
    const leer = document.createElement('div');
    leer.className = 'leer';
    leer.append(text(Object.assign(document.createElement('div'), { className: 'leer-titel' }),
      'Noch nichts abgelegt.'));
    leer.append(text(document.createElement('div'),
      'Zieh links eine Datei in die Ablage und wähle ein Modul. Das Ergebnis erscheint hier.'));
    behaelter.append(leer);
  } else {
    for (const a of liste) {
      const karte = auftragZeichnen(a);
      karte.dataset.auftragId = a.id;
      behaelter.append(karte);
    }
  }

  const offen = liste.filter(a => a.status === 'wartet' || a.status === 'laeuft').length;
  $('#zaehler').textContent = offen
    ? `${offen} offen · ${liste.length} gesamt`
    : `${liste.length} gesamt`;
}

/* ---------- Auftrag abschicken ---------- */

async function starten() {
  const knopf = $('#start-knopf');
  knopf.disabled = true;
  knopf.textContent = 'wird abgelegt …';
  try {
    await hole('/api/auftrag', {
      method: 'POST',
      body: JSON.stringify({
        profil: gewaehltesModul,
        dateien,
        angaben: angabenSammeln(),
        freitext: $('#freitext').value
      })
    });
    dateien = [];
    $('#freitext').value = '';
    dateilisteZeichnen();
    meldung($('#ablage-meldung'), null);
    letzterStand = '';
    await auftraegeLaden();
  } catch (err) {
    meldung($('#ablage-meldung'), err.message);
  } finally {
    knopf.textContent = 'Verarbeitung starten';
    knopfPruefen();
  }
}

/* ---------- Ersteinrichtung ---------- */

async function einrichten() {
  const passwort = $('#neues-passwort').value;
  try {
    await hole('/api/einrichten', { method: 'POST', body: JSON.stringify({ passwort }) });
    $('#einrichtung').classList.add('versteckt');
    $('#hauptbereich').classList.remove('versteckt');
    $('#neues-passwort').value = '';
    starten_ueberwachung();
  } catch (err) {
    meldung($('#einrichtung-fehler'), err.message);
  }
}

/* ---------- Ansicht hell/dunkel ---------- */

function themaSetzen(wert) {
  document.documentElement.dataset.thema = wert;
  localStorage.setItem('pruefstand-thema', wert);
}

/* ---------- Start ---------- */

function starten_ueberwachung() {
  moduleLaden();
  auftraegeLaden();
  clearInterval(uhrzeitTakt);
  uhrzeitTakt = setInterval(auftraegeLaden, 2500);
}

async function los() {
  themaSetzen(localStorage.getItem('pruefstand-thema') || '');

  $('#thema-knopf').onclick = () => {
    const jetzt = document.documentElement.dataset.thema;
    themaSetzen(jetzt === 'dunkel' ? 'hell' : jetzt === 'hell' ? '' : 'dunkel');
  };

  const feld = $('#ablagefeld');
  const wahl = $('#dateiwahl');
  feld.onclick = () => wahl.click();
  feld.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); wahl.click(); } };
  /* Die Dateiliste muss sofort in ein eigenes Array uebernommen werden.
     dateienAufnehmen liest asynchron; wuerde man das Eingabefeld vorher oder
     waehrenddessen leeren, bricht die Schleife nach der ersten Datei ab und
     die uebrigen verschwinden lautlos. */
  wahl.onchange = () => {
    const ausgewaehlt = Array.from(wahl.files);
    wahl.value = '';
    dateienAufnehmen(ausgewaehlt);
  };

  for (const ereignis of ['dragenter', 'dragover']) {
    feld.addEventListener(ereignis, (e) => { e.preventDefault(); feld.classList.add('bereit'); });
  }
  feld.addEventListener('dragleave', () => { if (!dateien.length) feld.classList.remove('bereit'); });
  feld.addEventListener('drop', (e) => {
    e.preventDefault();
    // dataTransfer ist nach dem Ereignis nicht mehr gueltig - erst kopieren.
    dateienAufnehmen(Array.from(e.dataTransfer.files));
  });
  // Fallback: Ablegen irgendwo auf der Seite soll die Seite nicht ersetzen.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('#start-knopf').onclick = starten;
  $('#einrichten-knopf').onclick = einrichten;
  $('#neues-passwort').onkeydown = (e) => { if (e.key === 'Enter') einrichten(); };

  $('#anmelden-knopf').onclick = anmelden;
  $('#passwort').onkeydown = (e) => { if (e.key === 'Enter') anmelden(); };

  try {
    const stand = await hole('/api/status');
    if (!stand.eingerichtet) {
      $('#einrichtung').classList.remove('versteckt');
      $('#hauptbereich').classList.add('versteckt');
      return;
    }
    if (stand.schutz === 'passwort' && !stand.admin) {
      anmeldungZeigen();
      return;
    }
  } catch { /* Server antwortet nicht - unten wird es sichtbar */ }

  starten_ueberwachung();
}

los();
