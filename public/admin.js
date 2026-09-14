/* Admin-Center — Module, Import, Referenzdateien, Einstellungen */

const $ = (s) => document.querySelector(s);

let token = sessionStorage.getItem('pruefstand-token') || null;
let module = [];
let einstellungen = {};
let offenesModul = null;

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
  const roh = await antwort.text();
  let daten = null;
  try { daten = roh ? JSON.parse(roh) : null; } catch { /* kein JSON */ }
  if (antwort.status === 401) { abmelden(); throw new Error('Anmeldung abgelaufen.'); }
  if (!antwort.ok) throw new Error(daten?.fehler || `Fehler ${antwort.status}`);
  return daten;
}

function meldung(el, inhalt, art = 'fehler') {
  if (!inhalt) { el.classList.add('versteckt'); return; }
  el.textContent = inhalt;
  el.className = art === 'hinweis' ? 'meldung hinweis' : 'meldung';
}

function text(el, wert) { el.textContent = wert; return el; }

/* ---------- Anmeldung ---------- */

async function anmelden() {
  try {
    const { token: neu } = await hole('/api/anmelden', {
      method: 'POST',
      body: JSON.stringify({ passwort: $('#passwort').value })
    });
    token = neu;
    sessionStorage.setItem('pruefstand-token', token);
    zeigeBereich();
  } catch (err) {
    meldung($('#anmelde-fehler'), err.message);
  }
}

function abmelden() {
  token = null;
  sessionStorage.removeItem('pruefstand-token');
  $('#bereich').classList.add('versteckt');
  $('#anmeldung').classList.remove('versteckt');
  $('#abmelden-knopf').classList.add('versteckt');
}

async function zeigeBereich() {
  $('#anmeldung').classList.add('versteckt');
  $('#bereich').classList.remove('versteckt');
  $('#abmelden-knopf').classList.remove('versteckt');
  await Promise.all([moduleLaden(), einstellungenLaden(), wissenLaden()]);
}

/* ---------- Reiter ---------- */

function blattZeigen(name) {
  for (const b of document.querySelectorAll('.blatt')) b.classList.add('versteckt');
  $(`#blatt-${name}`).classList.remove('versteckt');
  for (const r of document.querySelectorAll('.reiter button')) {
    r.setAttribute('aria-selected', String(r.dataset.blatt === name));
  }
}

/* ---------- Module ---------- */

async function moduleLaden() {
  // Das Admin-Center verwaltet alle Module, nicht nur die freigeschalteten.
  module = await hole('/api/profil?alle=1');
  moduleZeichnen();
}

function moduleZeichnen() {
  const suche = ($('#modul-suche').value || '').toLowerCase();
  const liste = $('#modulliste');
  liste.replaceChildren();

  const gefiltert = module.filter(m => !suche || m.name.toLowerCase().includes(suche));

  if (!gefiltert.length) {
    const leer = document.createElement('div');
    leer.className = 'leer';
    leer.append(text(Object.assign(document.createElement('div'), { className: 'leer-titel' }),
      module.length ? 'Kein Modul passt zur Suche.' : 'Noch keine Module.'));
    leer.append(text(document.createElement('div'), module.length
      ? 'Suchbegriff ändern oder leeren.'
      : 'Unter „Import aus claude.ai" holst du deine vorhandenen Projekte herüber.'));
    liste.append(leer);
    return;
  }

  // Freigeschaltete zuerst - das ist die Liste, die im Prüfstand ankommt.
  gefiltert.sort((a, b) => (b.aktiv - a.aktiv) || a.name.localeCompare(b.name, 'de'));

  for (const m of gefiltert) {
    const zeile = document.createElement('div');
    zeile.className = 'zeile' + (m.aktiv ? '' : ' aus');

    const links = document.createElement('div');
    links.append(text(Object.assign(document.createElement('div'), { className: 'zeile-titel' }), m.name));
    const teile = [
      `${m.anweisungZeichen.toLocaleString('de-DE')} Zeichen`,
      m.wissen ? `${m.wissen} Referenzdatei${m.wissen > 1 ? 'en' : ''}` : null,
      m.modell || null,
      m.quelle === 'claude.ai' ? 'aus claude.ai' : null
    ].filter(Boolean);
    links.append(text(Object.assign(document.createElement('div'), { className: 'zeile-unter' }),
      teile.join('  ·  ')));
    zeile.append(links);

    const knoepfe = document.createElement('div');
    knoepfe.className = 'zeile-knoepfe';

    const schalten = text(document.createElement('button'), m.aktiv ? 'Abschalten' : 'Freischalten');
    schalten.className = m.aktiv ? 'knopf leise klein' : 'knopf klein';
    schalten.onclick = async () => {
      await hole(`/api/profil/${m.id}`, { method: 'PUT', body: JSON.stringify({ aktiv: !m.aktiv }) });
      await moduleLaden();
    };
    knoepfe.append(schalten);

    const bearbeiten = text(document.createElement('button'), 'Bearbeiten');
    bearbeiten.className = 'knopf leise klein';
    bearbeiten.onclick = () => modulOeffnen(m.id);
    knoepfe.append(bearbeiten);

    zeile.append(knoepfe);
    liste.append(zeile);
  }
}

async function modulOeffnen(pid) {
  const p = await hole(`/api/profil/${pid}`);
  offenesModul = p;
  $('#bearbeiten-titel').textContent = p.name;
  $('#b-name').value = p.name;
  $('#b-anweisung').value = p.anweisung || '';
  $('#b-modell').value = p.modell || '';
  $('#b-zeitlimit').value = p.zeitlimitSek || '';
  $('#b-aktiv').checked = Boolean(p.aktiv);
  $('#b-startanweisung').value = p.startAnweisung || '';
  $('#b-freitext-aktiv').checked = Boolean(p.freitext?.aktiv);
  $('#b-freitext-beschriftung').value = p.freitext?.beschriftung || '';
  $('#b-freitext-platzhalter').value = p.freitext?.platzhalter || '';

  herkunftZeichnen(p.herkunft);
  wissenZeichnen();
  felderZeichnen(p.felder || []);

  meldung($('#b-meldung'), null);
  blattZeigen('bearbeiten');
}

/* ---------- Herkunft der Einstellung ---------- */

/* Zeigt, welche bisherigen Chats zu der Einstellung gefuehrt haben - damit
   nachvollziehbar bleibt, warum ein Modul einen festen Text hat oder ein Feld. */
function herkunftZeichnen(h) {
  const gruppe = $('#b-herkunft-gruppe');
  const behaelter = $('#b-herkunft');
  behaelter.replaceChildren();

  if (!h || !h.chats) { gruppe.hidden = true; return; }
  gruppe.hidden = false;

  const kopf = document.createElement('p');
  kopf.className = 'blatt-text';
  kopf.style.cssText = 'margin:0 0 8px;font-size:13px';
  kopf.textContent = h.chats === 1
    ? 'Aus einer bisherigen Unterhaltung in claude.ai:'
    : `Aus ${h.chats} bisherigen Unterhaltungen in claude.ai — so wurde das Modul dort benutzt:`;
  behaelter.append(kopf);

  for (const b of h.beispiele || []) {
    const zeile = document.createElement('div');
    zeile.className = 'zeile-unter';
    zeile.style.cssText = 'font-family:var(--mono);padding:5px 9px;border-left:2px solid var(--linie);margin-bottom:3px';
    zeile.textContent = b;
    behaelter.append(zeile);
  }
}

/* ---------- Referenzdateien eines Moduls ---------- */

function groesse(w) {
  if (w.zeichen) return `${w.zeichen.toLocaleString('de-DE')} Zeichen`;
  const b = w.bytes || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} kB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function wissenZeichnen() {
  const behaelter = $('#b-wissen');
  behaelter.replaceChildren();

  const liste = offenesModul.wissen || [];
  if (!liste.length) {
    behaelter.append(text(Object.assign(document.createElement('p'),
      { className: 'blatt-text', style: 'margin:0;font-size:13px' }),
      'Keine Referenzdateien verknüpft.'));
  } else {
    for (const w of liste) {
      const zeile = document.createElement('div');
      zeile.className = 'zeile';
      const links = document.createElement('div');
      links.append(text(Object.assign(document.createElement('div'), { className: 'zeile-titel' }), w.dateiname));
      links.append(text(Object.assign(document.createElement('div'), { className: 'zeile-unter' }), groesse(w)));
      zeile.append(links);
      const weg = text(document.createElement('button'), 'Trennen');
      weg.className = 'knopf leise klein';
      weg.onclick = () => {
        offenesModul.wissen = (offenesModul.wissen || []).filter(x => x.hash !== w.hash);
        wissenZeichnen();
      };
      const huelle = document.createElement('div');
      huelle.className = 'zeile-knoepfe';
      huelle.append(weg);
      zeile.append(huelle);
      behaelter.append(zeile);
    }
  }

  // Dateien, die in claude.ai am Projekt hingen, deren Inhalt der Import aber
  // nicht mitbringen konnte.
  const offen = $('#b-fehlende');
  offen.replaceChildren();
  const fehlend = (offenesModul.fehlendeDateien || [])
    .filter(n => !(offenesModul.wissen || []).some(w => (w.dateiname || '').startsWith(n)));
  if (fehlend.length) {
    const kasten = document.createElement('p');
    kasten.className = 'meldung hinweis';
    kasten.style.marginTop = '10px';
    kasten.textContent =
      `In claude.ai hängen an diesem Projekt noch: ${fehlend.join(', ')}. ` +
      `Der Import kann ihren Inhalt nicht mitbringen — lade sie unten hoch, ` +
      `dann arbeitet das Modul mit derselben Unterlage wie das Projekt.`;
    offen.append(kasten);
  }
}

async function wissenHochladen(dateien) {
  const status = $('#b-wissen-status');
  for (const datei of dateien) {
    status.textContent = `„${datei.name}" wird übertragen …`;
    try {
      const base64 = await new Promise((fertig, fehler) => {
        const leser = new FileReader();
        leser.onload = () => fertig(String(leser.result).split(',')[1] || '');
        leser.onerror = () => fehler(new Error('Datei konnte nicht gelesen werden.'));
        leser.readAsDataURL(datei);
      });
      const eintrag = await hole('/api/wissen', {
        method: 'POST',
        body: JSON.stringify({ dateiname: datei.name, inhaltBase64: base64 })
      });
      offenesModul.wissen = offenesModul.wissen || [];
      if (!offenesModul.wissen.some(w => w.hash === eintrag.hash)) {
        offenesModul.wissen.push(eintrag);
      }
      wissenZeichnen();
    } catch (err) {
      meldung($('#b-meldung'), `„${datei.name}": ${err.message}`);
    }
  }
  status.textContent = 'Übertragen. Zum Übernehmen unten speichern.';
  setTimeout(() => { status.textContent = ''; }, 6000);
}

/* ---------- Eingabefelder eines Moduls ---------- */

function felderZeichnen(felder) {
  offenesModul.felder = felder;
  const behaelter = $('#b-felder');
  behaelter.replaceChildren();

  if (!felder.length) {
    behaelter.append(text(Object.assign(document.createElement('p'),
      { className: 'blatt-text', style: 'margin:0;font-size:13px' }),
      'Keine Eingabefelder — der Prüfstand fragt bei diesem Modul nichts ab.'));
    return;
  }

  for (const [i, f] of felder.entries()) {
    const zeile = document.createElement('div');
    zeile.className = 'zeile';
    zeile.style.gridTemplateColumns = '1fr auto';

    const eingaben = document.createElement('div');
    eingaben.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0';

    const beschriftung = document.createElement('input');
    beschriftung.type = 'text';
    beschriftung.value = f.beschriftung || '';
    beschriftung.placeholder = 'Beschriftung';
    beschriftung.oninput = () => { f.beschriftung = beschriftung.value; };
    eingaben.append(beschriftung);

    const platzhalter = document.createElement('input');
    platzhalter.type = 'text';
    platzhalter.value = f.platzhalter || '';
    platzhalter.placeholder = 'Beispieltext (optional)';
    platzhalter.oninput = () => { f.platzhalter = platzhalter.value; };
    eingaben.append(platzhalter);

    zeile.append(eingaben);

    const knoepfe = document.createElement('div');
    knoepfe.className = 'zeile-knoepfe';

    const pflicht = document.createElement('label');
    pflicht.className = 'schalter';
    const haken = document.createElement('input');
    haken.type = 'checkbox';
    haken.checked = Boolean(f.pflicht);
    haken.onchange = () => { f.pflicht = haken.checked; };
    pflicht.append(haken, document.createTextNode('Pflicht'));
    knoepfe.append(pflicht);

    const weg = text(document.createElement('button'), 'Entfernen');
    weg.className = 'knopf leise klein';
    weg.onclick = () => felderZeichnen(felder.filter((_, j) => j !== i));
    knoepfe.append(weg);

    zeile.append(knoepfe);
    behaelter.append(zeile);
  }
}

async function modulSpeichern() {
  try {
    await hole(`/api/profil/${offenesModul.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: $('#b-name').value.trim(),
        anweisung: $('#b-anweisung').value,
        modell: $('#b-modell').value || null,
        zeitlimitSek: Number($('#b-zeitlimit').value) || null,
        aktiv: $('#b-aktiv').checked,
        startAnweisung: $('#b-startanweisung').value.trim() || null,
        freitext: $('#b-freitext-aktiv').checked
          ? {
              aktiv: true,
              beschriftung: $('#b-freitext-beschriftung').value.trim() || 'Anmerkung',
              platzhalter: $('#b-freitext-platzhalter').value.trim()
            }
          : null,
        wissen: offenesModul.wissen || [],
        fehlendeDateien: offenesModul.fehlendeDateien || [],
        felder: (offenesModul.felder || [])
          .filter(f => (f.beschriftung || '').trim())
          .map(f => ({
            schluessel: f.schluessel || f.beschriftung.toLowerCase()
              .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
              .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60),
            beschriftung: f.beschriftung.trim(),
            platzhalter: (f.platzhalter || '').trim(),
            pflicht: Boolean(f.pflicht)
          }))
      })
    });
    await moduleLaden();
    meldung($('#b-meldung'), 'Gespeichert.', 'hinweis');
  } catch (err) {
    meldung($('#b-meldung'), err.message);
  }
}

async function modulLoeschen() {
  if (!confirm(`Modul "${offenesModul.name}" wirklich löschen? Bereits erzeugte Ergebnisse bleiben erhalten.`)) return;
  await hole(`/api/profil/${offenesModul.id}`, { method: 'DELETE' });
  await moduleLaden();
  blattZeigen('module');
}

async function modulAnlegen() {
  const name = prompt('Name des neuen Moduls:');
  if (!name) return;
  const p = await hole('/api/profil', {
    method: 'POST',
    body: JSON.stringify({ name, anweisung: '', aktiv: false })
  });
  await moduleLaden();
  modulOeffnen(p.id);
}

/* ---------- Import ---------- */

/* Der Befehl für die Konsole auf claude.ai.
   Überträgt jedes Projekt einzeln hierher — Anweisung, Kontextdokumente, die
   hochgeladenen Projektdateien im Originalformat, und wertet die bisherigen
   Unterhaltungen aus:

     immer dieselbe erste Nachricht  ->  fester Text, kein Eingabefeld
     jedes Mal eine andere           ->  freies Feld mit Beispiel
     gar keine Unterhaltungen        ->  leeres freies Feld

   Einzeln übertragen, weil PDFs zusammen schnell sehr groß werden. */
function schnipselDirekt() {
  const ziel = `${location.origin}/api/import?schluessel=${einstellungen.importSchluessel || ''}`;
  return `(async()=>{
  const ZIEL='${ziel}';
  const O=await (await fetch('/api/organizations',{credentials:'include'})).json();
  const ORG=(O.find(x=>x.capabilities?.includes('chat'))||O[0]).uuid;
  const A='/api/organizations/'+ORG;
  const L=await (await fetch(A+'/projects',{credentials:'include'})).json();
  const b64=async u=>{const r=await fetch(u,{credentials:'include'});if(!r.ok)return null;
    const a=new Uint8Array(await r.arrayBuffer());let s='';
    for(let i=0;i<a.length;i+=8192)s+=String.fromCharCode.apply(null,a.subarray(i,i+8192));
    return btoa(s);};
  // Nachrichten, in denen der Prompt selbst entwickelt wurde, sind keine Auftraege.
  const ENTWICKLUNG=/^(schreibe|erstelle|baue|formuliere|passe|aendere|ändere|verbessere|kuerze|kürze)\\b[^]{0,30}\\bprompt/i;
  const norm=s=>s.toLowerCase().replace(/[^a-z0-9äöüß ]+/g,' ').replace(/\\s+/g,' ').trim();
  let ok=0,leer=0,fehler=0,fest=0,feld=0;
  for(let i=0;i<L.length;i++){
    const p=L[i];
    try{
      const d=await (await fetch(A+'/projects/'+p.uuid,{credentials:'include'})).json();
      const k=await (await fetch(A+'/projects/'+p.uuid+'/docs',{credentials:'include'})).json();
      let fl=[];try{fl=await (await fetch(A+'/projects/'+p.uuid+'/files',{credentials:'include'})).json();}catch(e){}

      // --- bisherige Unterhaltungen auswerten ---
      let ersten=[];
      try{
        const cs=await (await fetch(A+'/projects/'+p.uuid+'/conversations',{credentials:'include'})).json();
        for(const c of (Array.isArray(cs)?cs:[]).slice(0,12)){
          const j=await (await fetch(A+'/chat_conversations/'+c.uuid+'?tree=True&rendering_mode=messages',{credentials:'include'})).json();
          const m=(j.chat_messages||j.messages||[]).filter(x=>x.sender==='human')[0];
          if(!m)continue;
          const t=(m.content||[]).map(c2=>c2.text||'').join(' ').trim();
          if(t && t.length>2 && !ENTWICKLUNG.test(t)) ersten.push(t);
        }
      }catch(e){}

      let startAnweisung=null, freitext=null;
      const einzig=[...new Set(ersten.map(norm))];
      if(ersten.length>=2 && einzig.length===1){
        startAnweisung=ersten.sort((a,b)=>b.length-a.length)[0];   // immer dasselbe
        fest++;
      }else if(ersten.length>=1){
        freitext={aktiv:true,beschriftung:'Auftrag',
                  platzhalter:'z. B. '+ersten[0].slice(0,90)};      // jedes Mal anders
        feld++;
      }else{
        freitext={aktiv:true,beschriftung:'Auftrag',platzhalter:''}; // keine Chats
        feld++;
      }

      if(!(d.prompt_template||'').trim() && !startAnweisung && !freitext){leer++;continue;}

      const dateien=[];
      for(const f of (Array.isArray(fl)?fl:[])){
        const u=f.document_asset?.url;
        dateien.push({file_name:f.file_name, inhaltBase64: u? await b64(u): null});
      }
      const nutz={projects:[{uuid:p.uuid,name:p.name,description:p.description||'',updated_at:p.updated_at,
        prompt_template:d.prompt_template||'',
        startAnweisung, freitext,
        herkunft:{chats:ersten.length, beispiele:ersten.slice(0,4).map(t=>t.slice(0,160))},
        docs:(Array.isArray(k)?k:[]).map(x=>({file_name:x.file_name,content:x.content||''})),
        files:dateien}]};
      const r=await fetch(ZIEL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(nutz)});
      if(r.ok){ok++;console.log((i+1)+'/'+L.length+'  '+p.name+'  ('+dateien.length+' Datei(en), '+ersten.length+' Chat(s)'+(startAnweisung?', fester Text':'')+')');}
      else{fehler++;console.warn('abgelehnt: '+p.name+' -> '+r.status);}
    }catch(e){fehler++;console.warn('Fehler bei '+p.name+': '+e.message);}
  }
  console.log('Fertig. '+ok+' uebertragen ('+fest+' mit festem Text, '+feld+' mit freiem Feld), '+leer+' uebersprungen, '+fehler+' fehlgeschlagen.');
})();`;
}

/* Rückfallweg über die Zwischenablage, falls der Prüfstand von claude.ai aus
   nicht erreichbar ist (z. B. nur im Heimnetz). Ohne Dateiinhalte. */
function schnipselBauen() {
  return `(async()=>{
  const O=await (await fetch('/api/organizations',{credentials:'include'})).json();
  const ORG=(O.find(x=>x.capabilities?.includes('chat'))||O[0]).uuid;
  const L=await (await fetch('/api/organizations/'+ORG+'/projects',{credentials:'include'})).json();
  const out=[];let i=0;
  const w=async()=>{while(i<L.length){const p=L[i++];
    try{
      const d=await (await fetch('/api/organizations/'+ORG+'/projects/'+p.uuid,{credentials:'include'})).json();
      const k=await (await fetch('/api/organizations/'+ORG+'/projects/'+p.uuid+'/docs',{credentials:'include'})).json();
      let fl=[];try{fl=await (await fetch('/api/organizations/'+ORG+'/projects/'+p.uuid+'/files',{credentials:'include'})).json();}catch(e){}
      out.push({uuid:p.uuid,name:p.name,description:p.description||'',updated_at:p.updated_at,
        prompt_template:d.prompt_template||'',
        docs:(Array.isArray(k)?k:[]).map(x=>({file_name:x.file_name,content:x.content||''})),
        files:(Array.isArray(fl)?fl:[]).map(x=>x.file_name).filter(Boolean)});
    }catch(e){}
    if(i%10===0)console.log(i+'/'+L.length);
    await new Promise(r=>setTimeout(r,60));}};
  await Promise.all([w(),w(),w(),w()]);
  const text=JSON.stringify({projects:out});
  console.log(out.length+' Projekte gelesen ('+(text.length/1048576).toFixed(1)+' MB).');
  const b=document.createElement('button');
  b.textContent='IN DIE ZWISCHENABLAGE ('+out.length+' Projekte)';
  b.style.cssText='position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;padding:34px 54px;font-size:22px;font-weight:700;background:#2F6B3F;color:#fff;border:0;border-radius:8px;cursor:pointer';
  b.onclick=async()=>{await navigator.clipboard.writeText(text);b.textContent='KOPIERT - Fenster schliessen';b.style.background='#201F1C';};
  document.body.appendChild(b);
})();`;
}

function importZeichnen() {
  $('#import-direkt').textContent = schnipselDirekt();
  $('#import-schnipsel').textContent = schnipselBauen();
}

async function importUebernehmen(roh) {
  if (!roh || !roh.trim()) {
    meldung($('#import-meldung'), 'Nichts zum Übernehmen — Feld ist leer.');
    return;
  }
  try {
    const bericht = await hole('/api/import', { method: 'POST', body: roh });
    meldung($('#import-meldung'),
      `${bericht.neu} neu, ${bericht.aktualisiert} aktualisiert, ` +
      `${bericht.uebersprungen} ohne Anweisung übersprungen, ${bericht.dubletten} Dubletten ausgelassen. ` +
      `Alle sind noch abgeschaltet — unter „Module" freischalten.`, 'hinweis');
    $('#import-einfuegen').value = '';
    await moduleLaden();
    await wissenLaden();
  } catch (err) {
    meldung($('#import-meldung'),
      /JSON/i.test(err.message)
        ? 'Der eingefügte Text ist kein gültiger Export. Bitte Schritt 1 wiederholen und den Knopf anklicken.'
        : err.message);
  }
}

/* ---------- Referenzdateien ---------- */

async function wissenLaden() {
  const liste = await hole('/api/wissen');
  const behaelter = $('#wissenliste');
  behaelter.replaceChildren();

  if (!liste.length) {
    const leer = document.createElement('div');
    leer.className = 'leer';
    leer.append(text(Object.assign(document.createElement('div'), { className: 'leer-titel' }),
      'Noch keine Referenzdateien.'));
    leer.append(text(document.createElement('div'),
      'Sie kommen beim Import aus claude.ai automatisch mit.'));
    behaelter.append(leer);
    return;
  }

  for (const w of liste.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))) {
    const zeile = document.createElement('div');
    zeile.className = 'zeile';
    const links = document.createElement('div');
    links.append(text(Object.assign(document.createElement('div'), { className: 'zeile-titel' }), w.dateiname));
    links.append(text(Object.assign(document.createElement('div'), { className: 'zeile-unter' }),
      `${groesse(w)}  ·  ${w.hash}`));
    zeile.append(links);

    const knoepfe = document.createElement('div');
    knoepfe.className = 'zeile-knoepfe';
    const weg = text(document.createElement('button'), 'Löschen');
    weg.className = 'knopf leise klein';
    weg.onclick = async () => {
      if (!confirm(`"${w.dateiname}" endgültig löschen? Module, die sie nutzen, verlieren dieses Material.`)) return;
      await hole(`/api/wissen/${w.hash}`, { method: 'DELETE' });
      await wissenLaden();
    };
    knoepfe.append(weg);
    zeile.append(knoepfe);
    behaelter.append(zeile);
  }
}

/* ---------- Einstellungen ---------- */

/* Zeigt, ob der Token vollstaendig angekommen ist. Beim Weg ueber .env sind
   mehrfach Zeichen verlorengegangen, ohne dass es jemand bemerkt haette. */
function tokenStandZeigen(laenge) {
  const el = $('#e-token-stand');
  if (!laenge) {
    el.textContent = ' Zurzeit ist hier keiner hinterlegt — es gilt der Wert aus der .env.';
    el.style.color = 'var(--grafit)';
    return;
  }
  const vollstaendig = laenge >= 105;
  el.textContent = ` Hinterlegt: ${laenge} Zeichen` +
    (vollstaendig ? ' — sieht vollständig aus.' : ' — das ist zu kurz, er wurde beim Kopieren abgeschnitten.');
  el.style.color = vollstaendig ? 'var(--siegel)' : 'var(--abweichung)';
}

async function einstellungenLaden() {
  einstellungen = await hole('/api/einstellungen');
  $('#e-modell').value = einstellungen.modell || 'sonnet';
  $('#e-parallel').value = einstellungen.parallel ?? 1;
  $('#e-zeitlimit').value = einstellungen.zeitlimitSek ?? 900;
  $('#e-aufbewahrung').value = einstellungen.aufbewahrungTage ?? 90;
  $('#e-werkzeuge').value = (einstellungen.werkzeuge || []).join(',');
  $('#e-zugang').value = einstellungen.zugangSchutz || 'offen';
  tokenStandZeigen(einstellungen.claudeTokenLaenge || 0);
  $('#e-startanweisung').value = einstellungen.startAnweisung || '';
  importZeichnen();
}

async function einstellungenSpeichern() {
  try {
    const koerper = {
      modell: $('#e-modell').value,
      parallel: Number($('#e-parallel').value) || 1,
      zeitlimitSek: Number($('#e-zeitlimit').value) || 900,
      aufbewahrungTage: Number($('#e-aufbewahrung').value) || 0,
      werkzeuge: $('#e-werkzeuge').value.split(',').map(s => s.trim()).filter(Boolean),
      startAnweisung: $('#e-startanweisung').value,
      zugangSchutz: $('#e-zugang').value
    };
    if ($('#e-passwort').value) koerper.neuesPasswort = $('#e-passwort').value;
    // Nur senden, wenn wirklich etwas eingetragen wurde - sonst bliebe er leer.
    const tok = $('#e-claudetoken').value.trim();
    if (tok) koerper.claudeToken = tok;
    einstellungen = await hole('/api/einstellungen', { method: 'PUT', body: JSON.stringify(koerper) });
    $('#e-passwort').value = '';
    $('#e-claudetoken').value = '';
    tokenStandZeigen(einstellungen.claudeTokenLaenge || 0);
    importZeichnen();
    meldung($('#e-meldung'), 'Gespeichert.', 'hinweis');
  } catch (err) {
    meldung($('#e-meldung'), err.message);
  }
}

/* ---------- Start ---------- */

function themaSetzen(wert) {
  document.documentElement.dataset.thema = wert;
  localStorage.setItem('pruefstand-thema', wert);
}

function los() {
  themaSetzen(localStorage.getItem('pruefstand-thema') || '');
  $('#thema-knopf').onclick = () => {
    const jetzt = document.documentElement.dataset.thema;
    themaSetzen(jetzt === 'dunkel' ? 'hell' : jetzt === 'hell' ? '' : 'dunkel');
  };

  $('#anmelden-knopf').onclick = anmelden;
  $('#passwort').onkeydown = (e) => { if (e.key === 'Enter') anmelden(); };
  $('#abmelden-knopf').onclick = async () => {
    try { await hole('/api/abmelden', { method: 'POST' }); } catch {}
    abmelden();
  };

  for (const r of document.querySelectorAll('.reiter button')) {
    r.onclick = () => blattZeigen(r.dataset.blatt);
  }

  $('#neues-modul').onclick = modulAnlegen;
  $('#modul-suche').oninput = moduleZeichnen;
  $('#b-speichern').onclick = modulSpeichern;
  $('#b-loeschen').onclick = modulLoeschen;
  $('#b-zurueck').onclick = () => blattZeigen('module');

  $('#b-wissen-datei').onchange = (e) => {
    const dateien = [...e.target.files];
    e.target.value = '';
    if (dateien.length) wissenHochladen(dateien);
  };

  $('#b-feld-neu').onclick = () => felderZeichnen([
    ...(offenesModul.felder || []),
    { schluessel: '', beschriftung: '', platzhalter: '', pflicht: false }
  ]);

  $('#b-feld-erkennen').onclick = async () => {
    const vorschlag = await hole('/api/felder-erkennen', {
      method: 'POST', body: JSON.stringify({ anweisung: $('#b-anweisung').value })
    });
    if (!vorschlag.length) {
      meldung($('#b-meldung'), 'In der Anweisung stehen keine eckigen Platzhalter.', 'hinweis');
      return;
    }
    // Vorhandene Felder behalten, nur fehlende ergänzen.
    const da = new Set((offenesModul.felder || []).map(f => f.schluessel));
    felderZeichnen([...(offenesModul.felder || []), ...vorschlag.filter(f => !da.has(f.schluessel))]);
    meldung($('#b-meldung'), `${vorschlag.filter(f => !da.has(f.schluessel)).length} Feld(er) ergänzt.`, 'hinweis');
  };

  $('#schnipsel-kopieren').onclick = async () => {
    await navigator.clipboard.writeText(schnipselBauen());
    $('#schnipsel-kopieren').textContent = 'Kopiert';
    setTimeout(() => { $('#schnipsel-kopieren').textContent = 'Befehl kopieren'; }, 1600);
  };

  $('#direkt-kopieren').onclick = async () => {
    await navigator.clipboard.writeText(schnipselDirekt());
    $('#direkt-kopieren').textContent = 'Kopiert';
    setTimeout(() => { $('#direkt-kopieren').textContent = 'Befehl kopieren'; }, 1600);
  };

  $('#modulliste-neu').onclick = async () => {
    await moduleLaden();
    await wissenLaden();
    meldung($('#import-meldung'),
      `${module.length} Module vorhanden. Unter „Module" freischalten, was du nutzen willst.`, 'hinweis');
  };

  $('#import-uebernehmen').onclick = () => importUebernehmen($('#import-einfuegen').value);

  $('#import-datei').onchange = async (e) => {
    const datei = e.target.files[0];
    e.target.value = '';
    if (datei) importUebernehmen(await datei.text());
  };

  $('#e-speichern').onclick = einstellungenSpeichern;
  $('#e-aufraeumen').onclick = async () => {
    const { entfernt } = await hole('/api/aufraeumen', { method: 'POST' });
    meldung($('#e-meldung'), `${entfernt} alte Aufträge entfernt.`, 'hinweis');
  };

  if (token) zeigeBereich().catch(() => abmelden());
}

los();
