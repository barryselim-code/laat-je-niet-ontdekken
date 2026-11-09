// Betrapt! – PWA (vanilla JS, geen build-stap)
const CFG = window.TAFELAGENT_CONFIG || {};
const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const WACHT = 15;          // seconden wachttijd bij beschuldigen
const HOST_SLUIT = 120;    // host kan na 2 minuten sluiten
const LEESTIJD = 5000;     // missie verdwijnt na 5 s vasthouden
const $app = document.getElementById('app');

let sb = null, uid = null, kanaal = null, pingTimer = null, tikTimer = null, laadTimer = null, leesTimer = null;

const S = {
  view: 'laden', terug: 'home', fout: null, bezig: false,
  form: { naam: '', hostNaam: '', thema: 'kerst', moeilijkheid: 'gemengd', context: ['eten', 'drinken'], punten: true, code: '', spelerNaam: '' },
  sid: null, sessie: null, spelers: [], besch: [], deel: [], stemmen: [], overnames: [],
  missie: null, onthulling: null, tab: 'missie', offset: 0,
  sheet: null, toasts: [], uitslag: null, gezien: new Set(), eersteLaad: true,
  vasthouden: false, renderWacht: false, uitlegStap: 0, envelop: 'dicht', overname: null, installPrompt: null,
};

// ---------- hulpjes ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nu = () => Date.now() + S.offset;
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem('ta.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ta.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('ta.' + k); } catch {} },
};
const ceremonieKey = () => 'ceremonie.' + S.sid;
const echteIk = () => S.spelers.find((p) => p.user_id === uid && !p.verwijderd);
const testEigenaar = () => !!S.sessie?.test && S.sessie.test_eigenaar === uid;
const ik = () => (testEigenaar() && S.sessie.test_als && S.spelers.find((p) => p.id === S.sessie.test_als && !p.verwijderd)) || echteIk();
const speler = (id) => S.spelers.find((p) => p.id === id);
const naam = (id) => speler(id)?.naam ?? 'Iemand';
const isHost = () => S.sessie && ik() && S.sessie.host_id === ik().id;
const echteHost = () => !!S.sessie && (testEigenaar() || S.sessie.host_id === echteIk()?.id);
const actief = () => S.spelers.filter((p) => !p.verwijderd);
const restWacht = (b) => Math.max(0, WACHT - (nu() - new Date(b.laatste_meedoen).getTime()) / 1000);
const deelnemers = (bid) => S.deel.filter((d) => d.beschuldiging_id === bid).sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));
const doetMee = (bid) => !!ik() && S.deel.some((d) => d.beschuldiging_id === bid && d.speler_id === ik().id);
const openBesch = () => S.besch.filter((b) => b.status === 'open');
const plural = (n, een, meer) => `${n} ${n === 1 ? een : meer}`;
const tijd = (t) => t ? new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : '';
const namenLijst = (arr) => arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' en ' + arr[arr.length - 1];
const MOEIL = ['', 'Makkelijk', 'Normaal', 'Moeilijk'];
const TINTEN = [['#B3262E', '#FFFFFF'], ['#1F5C45', '#FFFFFF'], ['#E9C774', '#3A0C0F']];
const ini = (p, i) => { const [bg, fg] = TINTEN[(i ?? (p.volgnr - 1)) % 3]; return `<span class="ini" style="background:${bg};color:${fg}">${esc(p.naam[0]?.toUpperCase())}</span>`; };

const FOUTEN = {
  niet_ingelogd: 'Geen verbinding met de server. Probeer het opnieuw.',
  naam_leeg: 'Vul je naam in.',
  code_kort: 'Vul de 4 letters van de code in.',
  code_onbekend: 'Deze code bestaat niet (meer). Check de letters.',
  sessie_gesloten: 'Dit spel is al afgelopen.',
  sessie_vol: 'Deze avond zit vol (maximaal 20 spelers).',
  niet_host: 'Alleen de host kan dit.',
  al_gestart: 'Het spel is al gestart.',
  te_weinig_spelers: 'Je hebt minstens 3 spelers nodig.',
  geen_joker: 'Je hebt al een andere opdracht gekozen of de 10 minuten zijn voorbij. Liet je per ongeluk je scherm zien? Vraag de host of je nog eens mag wisselen.',
  al_voltooid: 'Je hebt je opdracht al geflikt.',
  ontmaskerd: 'Je bent betrapt; je opdracht telt niet meer.',
  jezelf: 'Dat kan niet bij jezelf.',
  al_ontmaskerd: 'Deze speler is al betrapt.',
  nog_wachten: 'Nog even wachten, de teller loopt nog.',
  al_afgerond: 'Deze betrapping is al afgerond.',
  pool_op: 'De opdrachten zijn op. Vraag de host om nieuwe opdrachten.',
  spel_loopt_niet: 'Het spel loopt nu niet.',
  geen_speler: 'Je zit niet (meer) aan deze tafel.',
  nog_geheim: 'De opdrachten zijn nog geheim.',
  geen_onthulling: 'De onthulling is niet bezig.',
  onbekende_speler: 'Die speler bestaat niet (meer).',
  host_niet_verwijderen: 'De host kan zichzelf niet verwijderen.',
  niet_beschuldigd: 'Deze betrapping gaat niet over jou.',
  onbekend: 'Niet gevonden.',
};
function foutTekst(e) {
  const m = String(e?.message || e || '');
  for (const k of Object.keys(FOUTEN)) if (m.includes(k)) return FOUTEN[k];
  if (/fetch|network|Failed/i.test(m)) return 'Geen verbinding. Check je internet en probeer opnieuw.';
  return 'Er ging iets mis: ' + m.slice(0, 120);
}
async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}

// ---------- iconen ----------
const svg = (d, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  vraag: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4"/><path d="M12 17h.01"/>'),
  terug: svg('<path d="M15 5l-7 7 7 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 2),
  ster: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.6 6.1 6.6.5-5 4.3 1.6 6.4L12 16.4l-5.8 3.4 1.6-6.4-5-4.3 6.6-.5z"/></svg>',
  scan: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 12h8"/>'),
  hand: svg('<path d="M9 11V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V9a1.5 1.5 0 0 1 3 0v2"/><path d="M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L5 16.5a1.5 1.5 0 0 1 2.3-2L9 16V11"/>'),
  vink: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.2),
  wissel: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
  wijs: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  missie: svg('<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
  spelers: svg('<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M14.5 14.3c.8-.3 1.6-.5 2.5-.5 2.2 0 3.9 1.5 4.4 4"/>'),
  meer: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  duimOp: svg('<path d="M7 11v9H4v-9zM7 11l4-7c1.4 0 2.3 1 2 2.4L12.5 10H18a2 2 0 0 1 2 2.3l-1.1 6A2 2 0 0 1 17 20H7"/>'),
  duimNeer: svg('<path d="M7 13V4H4v9zM7 13l4 7c1.4 0 2.3-1 2-2.4L12.5 14H18a2 2 0 0 0 2-2.3l-1.1-6A2 2 0 0 0 17 4H7"/>'),
  kroon: svg('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>', 1.6),
  masker: svg('<path d="M3 7c3-1 6-1 9 1 3-2 6-2 9-1 0 6-2.5 10-5.5 10-1.6 0-2.5-1.5-3.5-1.5S10.1 17 8.5 17C5.5 17 3 13 3 7z"/><circle cx="8.3" cy="10.5" r="1.2"/><circle cx="15.7" cy="10.5" r="1.2"/>'),
  tik: svg('<path d="M9 11V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V9a1.5 1.5 0 0 1 3 0v2"/><path d="M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L5 16.5a1.5 1.5 0 0 1 2.3-2L9 16V11"/>'),
};
const LOGO = `<svg class="logo" viewBox="0 0 100 100" role="img" aria-label="Logo: open envelop met een brief en een lakzegel">
<defs><linearGradient id="h-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#30355A"/><stop offset="1" stop-color="#191B2B"/></linearGradient>
<radialGradient id="h-spot" cx="0.5" cy="0.32" r="0.6"><stop offset="0" stop-color="#fff" stop-opacity="0.14"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="h-back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#B9AD97"/><stop offset="1" stop-color="#A59880"/></linearGradient>
<linearGradient id="h-flap" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#CFC3AD"/><stop offset="1" stop-color="#E3D9C7"/></linearGradient>
<linearGradient id="h-card" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#ECE6DB"/></linearGradient>
<linearGradient id="h-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBF7F0"/><stop offset="1" stop-color="#E4DBCB"/></linearGradient>
<radialGradient id="h-seal" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#B84A45"/><stop offset="1" stop-color="#7A2326"/></radialGradient>
<filter id="h-sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#000" flood-opacity="0.35"/></filter>
<filter id="h-shup" x="-30%" y="-40%" width="160%" height="180%"><feDropShadow dx="0" dy="-1.4" stdDeviation="1.4" flood-color="#000" flood-opacity="0.28"/></filter>
<filter id="h-blur" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="2"/></filter></defs>
<rect width="100" height="100" rx="22" fill="url(#h-bg)"/><rect width="100" height="100" rx="22" fill="url(#h-spot)"/>
<ellipse cx="50" cy="87" rx="34" ry="3.5" fill="#000" opacity="0.35" filter="url(#h-blur)"/>
<rect x="18" y="44" width="64" height="40" rx="3.5" fill="url(#h-back)"/>
<path d="M18 46 L50 24 L82 46Z" fill="url(#h-flap)" stroke="#fff" stroke-opacity="0.35" stroke-width="0.6" stroke-linejoin="round"/>
<rect x="28" y="20" width="44" height="52" rx="3" fill="url(#h-card)" filter="url(#h-sh)"/>
<rect x="31" y="23" width="38" height="46" rx="2" fill="none" stroke="#23263A" stroke-opacity="0.12" stroke-width="0.6"/>
<path d="M34 29.5 H66 M34 36.5 H66 M34 43.5 H60 M34 50.5 H63" stroke="#23263A" stroke-opacity="0.5" stroke-width="2.6" stroke-linecap="round"/>
<path d="M18 50 L50 68 L82 50 V80.5 A3.5 3.5 0 0 1 78.5 84 H21.5 A3.5 3.5 0 0 1 18 80.5Z" fill="url(#h-front)" filter="url(#h-shup)"/>
<path d="M18.5 84 L44 65.5 M81.5 84 L56 65.5" stroke="#8F826B" stroke-opacity="0.25" stroke-width="0.7"/>
<path d="M18.4 50.4 L50 68 L81.6 50.4" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="0.7"/>
<circle cx="50" cy="70" r="6.4" fill="url(#h-seal)" filter="url(#h-sh)"/>
<circle cx="50" cy="70" r="3.9" fill="none" stroke="#5E1A1C" stroke-opacity="0.55" stroke-width="0.8"/>
<path d="M47.4 67.6 A3.4 3.4 0 0 1 51.6 66.8" fill="none" stroke="#fff" stroke-opacity="0.4" stroke-width="0.8" stroke-linecap="round"/></svg>`;

function ring(id, rest, maat, kleur, tekst = true) {
  const r = maat / 2 - 6, o = 2 * Math.PI * r;
  return `<div class="ring" style="width:${maat}px;height:${maat}px"><svg viewBox="0 0 ${maat} ${maat}" aria-hidden="true">
    <circle cx="${maat / 2}" cy="${maat / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${maat > 100 ? 8 : 4}"/>
    <circle data-ring="${id}" data-omtrek="${o}" cx="${maat / 2}" cy="${maat / 2}" r="${r}" fill="none" stroke="${kleur}" stroke-width="${maat > 100 ? 8 : 4}" stroke-linecap="round" stroke-dasharray="${o}" stroke-dashoffset="${o * (1 - rest / WACHT)}"/></svg>
    ${tekst ? `<b data-wacht="${id}" style="font-size:${Math.round(maat / 3.2)}px">${Math.ceil(rest)}</b>` : ''}</div>`;
}

// ---------- render ----------
function render() {
  if (S.vasthouden) { S.renderWacht = true; return; }
  const views = { laden: vLaden, home: vHome, nieuw: vNieuw, deelnemen: vDeelnemen, speluitleg: vSpeluitleg, overname: vOvernameWacht, sessie: vSessie, weg: vWeg };
  const ae = document.activeElement, focusId = ae && ae.id;
  const sel = focusId && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;
  const html = (views[S.view] || vHome)();
  document.body.className = /class="screen licht/.test(html.slice(0, 80)) ? 'licht-bg' : /class="feest/.test(html.slice(0, 80)) ? 'feest-bg' : '';
  const test = S.view === 'sessie' && testEigenaar();
  document.body.classList.toggle('testmodus', test);
  $app.innerHTML = (test ? vTestbalk() : '') + html + vOverlay() + vUitslag() + vSheet() + vToasts();
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {} } }
  if (S.view === 'sessie' && S.sessie?.status === 'lobby') tekenQR();
  tik();
}

// Testmodus: wissel van perspectief tussen alle spelers
function vTestbalk() {
  const me = ik();
  return `<div class="testbalk" role="toolbar" aria-label="Testmodus: speel als"><span class="lbl">Test · speel als</span>
    ${actief().map((p) => `<button class="${p.id === me?.id ? 'aan' : ''}" data-a="test-als" data-id="${p.id}" aria-pressed="${p.id === me?.id}">${esc(p.naam)}${p.id === S.sessie.host_id ? ' ★' : ''}</button>`).join('')}</div>`;
}

function vLaden() { return `<main class="screen"><div class="center-msg"><div class="spinner" role="status" aria-label="Laden"></div></div></main>`; }

function vHome() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
  return `<main class="screen licht" style="padding-top:0">
    <div class="home-kop stippen">
      <div style="display:flex;justify-content:flex-end"><button class="iconbtn" data-a="speluitleg" aria-label="Spelregels">${I.vraag}</button></div>
      <div class="home-hero">${LOGO}
        <h1>Betrapt!</h1>
        <p>Iedereen een geheime opdracht. Wie wordt er betrapt voor het dessert?</p>
        <span class="label-feest">Kerstspecial</span></div>
    </div>
    <div class="home-acties">
      ${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}
      <button class="btn rood" data-a="view" data-v="nieuw">${I.plus}Nieuwe avond starten</button>
      <button class="btn groen-rand" data-a="view" data-v="deelnemen">Aanschuiven met code</button>
      ${S.installPrompt ? `<button class="btn ghost klein" data-a="installeer">App installeren</button>` : ''}
      <p class="foot-note">3 tot 20 spelers · één telefoon per persoon${ios ? '<br>Installeren: Deel-knop › Zet op beginscherm' : ''}</p>
    </div></main>`;
}

function vNieuw() {
  const f = S.form, pr = (b) => (b ? 'true' : 'false');
  const ctx = [['eten', 'Er wordt gegeten'], ['drinken', 'Er wordt gedronken'], ['kinderen', 'Kinderen aan tafel'], ['gastheer', 'Ik ben de gastheer']];
  return `<main class="screen licht">
    <div class="kop-terug"><button class="iconbtn" data-a="view" data-v="home" aria-label="Terug">${I.terug}</button></div>
    <div style="display:flex;align-items:center;gap:10px;padding:0 24px 4px"><h1 class="titel-serif" style="color:var(--kerstrood)">Nieuwe avond</h1><span style="width:24px;height:24px;color:#C99A2E">${I.ster}</span></div>
    <div class="body">
      <div class="field"><label class="label" for="f-naam">Naam van de avond</label>
        <input class="input" id="f-naam" data-f="naam" value="${esc(f.naam)}" placeholder="Kerstavond 2026" maxlength="40" autocomplete="off"></div>
      <div class="field"><label class="label" for="f-host">Jouw naam aan tafel</label>
        <input class="input" id="f-host" data-f="hostNaam" value="${esc(f.hostNaam)}" placeholder="Bijv. Barry" maxlength="20" autocomplete="given-name"></div>
      <div class="field"><span class="label">Thema</span><div class="tegels">
        <button class="tegel" data-a="set" data-k="thema" data-val="kerst" aria-pressed="${pr(f.thema === 'kerst')}">${f.thema === 'kerst' ? `<span style="color:var(--feestgoud)">${I.ster}</span>` : ''}Kerst</button>
        <button class="tegel" data-a="set" data-k="thema" data-val="algemeen" aria-pressed="${pr(f.thema === 'algemeen')}">${f.thema === 'algemeen' ? `<span style="color:var(--feestgoud)">${I.ster}</span>` : ''}Algemeen</button></div></div>
      <div class="field"><span class="label">Moeilijkheid</span><div class="seg">${['makkelijk', 'gemengd', 'moeilijk'].map((m) => `<button data-a="set" data-k="moeilijkheid" data-val="${m}" aria-pressed="${pr(f.moeilijkheid === m)}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div></div>
      <div class="field"><span class="label">Wat gebeurt er aan tafel?</span><div class="chips">${ctx.map(([k, t]) => `<button class="chip" data-a="ctx" data-val="${k}" aria-pressed="${pr(f.context.includes(k))}">${t}</button>`).join('')}</div></div>
      <div class="toggle-row"><div><b>Punten tellen</b><span>Uit = alleen gehaald of niet</span></div><button class="toggle" data-a="punten" aria-pressed="${pr(f.punten)}" aria-label="Punten tellen"></button></div>
      ${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}
    </div>
    <div class="foot"><button class="btn rood" data-a="maak" ${S.bezig ? 'disabled' : ''}>${S.bezig ? 'Bezig…' : 'Tafel dekken'}</button></div></main>`;
}

function vDeelnemen() {
  const f = S.form, c = (f.code + '    ').slice(0, 4);
  return `<main class="screen licht">
    <div class="kop-terug"><button class="iconbtn" data-a="view" data-v="home" aria-label="Terug">${I.terug}</button></div>
    <div style="display:flex;flex-direction:column;gap:6px;padding:0 24px 4px"><h1 class="titel-serif" style="color:var(--den)">Schuif aan</h1><span style="font-size:15px;color:var(--ink2)">De host heeft de code op zijn scherm.</span></div>
    <div class="body" style="gap:28px;padding-top:24px">
      <div class="field" style="gap:12px"><label class="label" for="c0">Code van de avond</label>
        <div class="codeboxes">${[0, 1, 2, 3].map((i) => `<input class="codebox" id="c${i}" data-code="${i}" aria-label="Letter ${i + 1}" maxlength="1" autocapitalize="characters" autocomplete="off" value="${esc(c[i].trim())}">`).join('')}</div>
        ${S.scannen ? `<video class="scan" id="scan" playsinline muted></video><button class="btn klein licht-rand" data-a="stopscan">Stoppen met scannen</button>`
          : `<button class="btn klein groen-rand" data-a="scan">${I.scan}Scan de QR-code</button>`}</div>
      <div class="field"><label class="label" for="f-sp">Je naam aan tafel</label>
        <input class="input" id="f-sp" data-f="spelerNaam" value="${esc(f.spelerNaam)}" placeholder="Bijv. Fleur" maxlength="20" autocomplete="given-name">
        <span class="hint">Zo heet je in de lijst en bij de onthulling.</span></div>
      ${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}
    </div>
    <div class="foot"><button class="btn rood" data-a="join" ${S.bezig ? 'disabled' : ''}>${S.bezig ? 'Bezig…' : 'Aanschuiven'}</button></div></main>`;
}

function vOvernameWacht() {
  return `<main class="screen licht"><div class="center-msg"><div class="spinner" role="status"></div>
    <h2>Wachten op de host</h2><p>De host moet bevestigen dat jij ${esc(S.overname?.naam)} bent op een nieuw toestel.</p>
    <button class="btn ghost klein" data-a="overname-stop" style="width:auto">Annuleren</button></div></main>`;
}
function vWeg() {
  return `<main class="screen licht"><div class="center-msg"><h2>${esc(S.fout || 'Je zit niet meer aan deze tafel')}</h2>
    <button class="btn rood" data-a="naar-home" style="max-width:280px">Naar het begin</button></div></main>`;
}

const PUNTEN = [['Opdracht geflikt (makkelijk / normaal / moeilijk)', '+1 / +2 / +3'], ['Betrapper, klopt', '+2'], ['Ik zag het ook!, klopt', '+1'],
  ['Betrapper, klopt niet', '−2'], ['Ik zag het ook!, klopt niet', '−1'], ['Zelf betrapt', '0 voor je opdracht']];

function vSpeluitleg() {
  return `<main class="screen">
    <div class="kop-terug"><button class="iconbtn" data-a="speluitleg-terug" aria-label="Terug">${I.terug}</button></div>
    <article class="speluitleg"><h1>Spelregels</h1>
      <p>Iedereen aan tafel krijgt een unieke geheime opdracht die je ongemerkt vanaf je stoel uitvoert. Wie betrapt wordt, verliest zijn opdracht; wie hem flikt zonder betrapt te worden, scoort.</p>
      <h2>De avond in 4 stappen</h2>
      <ol><li>De host start een nieuwe avond; iedereen schuift aan met de code of QR-code.</li>
        <li>De host deelt de opdrachten uit. Je leest je opdracht door je vinger erop te houden; na 5 seconden verdwijnt hij vanzelf.</li>
        <li>Voer je opdracht ongemerkt uit en tik op Geflikt! Tot het einde kun je nog betrapt worden. Past je opdracht niet? Kies één keer een andere opdracht, in de eerste 10 minuten.</li>
        <li>De host beëindigt het spel en onthult alle opdrachten één voor één.</li></ol>
      <h2>Betrappen</h2>
      <ol><li>Tik bij Spelers op Betrap! en zeg aan tafel hardop wat je denkt dat de opdracht is.</li>
        <li>Zag je het ook? Tik op Ik zag het ook! Er loopt een teller van 15 seconden; elke bijval zet hem terug op 15. Terugtrekken kan niet.</li>
        <li>Op 0 kiest de verdachte: Je hebt me! (betrapt) of Mooi niet! (speelt door).</li></ol>
      <h2>Wanneer klopt een betrapping?</h2>
      <p>Als het hardop genoemde vermoeden de kern van de opdracht raakt; letterlijk hoeft niet. De verdachte beoordeelt dit zelf, maar bij de onthulling bespreekt de tafel elke keer dat iemand Mooi niet! zei.</p>
      <p class="vb">Voorbeeld: is de opdracht "leg mes en vork omgewisseld tot het eerste gerecht op je bord ligt" en zegt iemand "jouw vork ligt aan de verkeerde kant", dan ben je betrapt.</p>
      <h2>Aan het eind van de avond</h2>
      <ul><li>Per speler stemt de tafel: heeft hij zijn opdracht echt geflikt? Meer nee dan ja = geen opdrachtpunten.</li>
        <li>Per Mooi niet! stemt de tafel: raakte de betrapping de kern? Meer ja dan nee = alsnog betrapt.</li></ul>
      <h2>Punten</h2>
      <table><tbody>${PUNTEN.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table>
      <p>De meeste punten? Dan ben jij de Sluwste van de tafel.</p>
    </article></main>`;
}

// ----- in een sessie -----
function vSessie() {
  const s = S.sessie;
  if (!s) return vLaden();
  if (s.status === 'lobby') return vLobby();
  if (s.status === 'spel') {
    if (!ls.get(ceremonieKey())) return S.uitlegStap < 3 ? vUitleg() : vEnvelop();
    return vSpel();
  }
  if (s.status === 'onthulling') return isHost() ? vOnthullingHost() : vOnthullingSpeler();
  return vScorebord();
}

function hostBanners() {
  if (!isHost()) return '';
  let h = '';
  for (const o of S.overnames.filter((x) => x.status === 'open')) {
    h += `<div class="banner"><p><b>${esc(naam(o.speler_id))}</b> wil verder op een nieuw toestel.</p>
      <button class="pill" data-a="overname-ja" data-id="${o.id}">Goed</button><button class="pill" data-a="overname-nee" data-id="${o.id}">Nee</button></div>`;
  }
  if (S.sessie.host_melding) h += `<div class="banner"><p>${esc(S.sessie.host_melding)}</p><button class="pill" data-a="melding-weg">Oké</button></div>`;
  return h;
}

function vLobby() {
  const s = S.sessie, me = ik(), host = isHost(), sp = actief();
  const laatste = sp.length > 1 ? Math.max(...sp.map((p) => p.volgnr)) : -1;
  return `<main class="screen licht">
    <div class="lobby-kaart stippen">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="naam-avond">${esc(s.naam)}</span>
        <span style="display:flex;align-items:center;gap:4px">${host ? '<span class="badge-host">Host</span>' : ''}<button class="iconbtn" style="color:var(--creme)" data-a="speluitleg" aria-label="Spelregels">${I.vraag}</button></span></div>
      <div style="display:flex;align-items:center;gap:18px">
        <div class="qr" id="qr" role="img" aria-label="QR-code om aan te schuiven"></div>
        <div style="display:flex;flex-direction:column;gap:4px"><span style="font-size:13px;color:#FBE7DA">Code</span><span class="bigcode">${esc(s.code)}</span><span style="font-size:13px;color:#FBE7DA">Scan of typ de code</span></div>
      </div>
      <span aria-hidden="true" style="position:absolute;right:18px;bottom:16px;width:34px;height:34px;color:var(--feestgoud);opacity:.7;transform:rotate(14deg)">${I.ster}</span>
    </div>
    ${hostBanners()}
    <div class="sectie"><h2>Aan tafel</h2><span>${plural(sp.length, 'speler', 'spelers')}</span></div>
    <div class="raster" style="flex-grow:1">
      ${sp.map((p, i) => { const tik = host && p.id !== me?.id; return `<${tik ? `button data-a="spelermenu" data-id="${p.id}" aria-label="Opties voor ${esc(p.naam)}" style="font:inherit;color:inherit;text-align:left"` : 'div'} class="speler-kaart">${ini(p, i)}<span class="naam">${esc(p.naam)}${p.id === me?.id ? ' <span style="font-weight:400;color:var(--ink2)">(jij)</span>' : ''}</span>
        ${p.volgnr === laatste && p.id !== me?.id ? '<span class="nieuw">nieuw</span>' : ''}</${tik ? 'button' : 'div'}>`; }).join('')}
      ${sp.length < 20 ? `<div class="speler-kaart leeg"><span class="ini" style="border:1.5px dashed #D9C6AA"></span>Nog iemand?</div>` : ''}
    </div>
    <div class="foot">
      ${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}
      ${host ? `<button class="btn rood" data-a="start" ${sp.length < 3 || S.bezig ? 'disabled' : ''}><span style="width:20px;height:20px;color:var(--feestgoud)">${I.ster}</span>${S.bezig ? 'Opdrachten uitdelen…' : 'Deel de opdrachten uit'}</button>
        <p class="foot-note">${sp.length < 3 ? `Nog ${3 - sp.length} speler${3 - sp.length === 1 ? '' : 's'} nodig.` : 'Eerst een korte uitleg, dan je opdracht. Daarna wordt je scherm donker en discreet.'}</p>`
        : `<div style="display:flex;align-items:center;justify-content:center;gap:10px;color:var(--ink2);font-size:14px;padding:12px"><div class="spinner" style="width:18px;height:18px;border-width:2px"></div>Wachten tot de host de opdrachten uitdeelt…</div>`}
      ${echteHost() ? `<button class="btn ghost klein" style="color:var(--kerstrood)" data-a="annuleer">Avond annuleren</button>` : `<button class="btn ghost klein" style="color:var(--ink2)" data-a="verlaat">Verlaten</button>`}
    </div></main>`;
}

// ----- uitleg 1-3 en envelop -----
function vUitleg() {
  const i = S.uitlegStap;
  const stapjes = `<div class="stapjes" aria-label="Stap ${i + 1} van 3">${[0, 1, 2].map((j) => `<i class="${j === i ? 'aan' : ''}"></i>`).join('')}</div>`;
  const kop = `<div style="display:flex;align-items:center;justify-content:space-between;height:44px">${stapjes}${i < 2 ? `<button class="btn ghost klein" style="width:auto;padding:0 4px" data-a="uitleg-klaar">Overslaan</button>` : ''}</div>`;
  let inhoud = '', knop = '';
  if (i === 0) {
    inhoud = `<span class="kicker" style="margin-top:8px">Zo werkt het · 1 van 3</span><h1 class="titel-serif" style="font-size:32px;margin-top:6px">Jouw geheime opdracht</h1>
      <div class="mock"><div class="vak"><span style="font-size:11px;color:var(--faint)">Jouw opdracht</span><span class="balk" style="width:90%"></span><span class="balk" style="width:64%"></span>
        <span style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)"><span style="width:16px;height:16px">${I.hand}</span>Houd vast om te lezen</span><span class="nr" style="position:absolute;right:-6px;top:-6px">1</span></div>
        <div class="knopjes"><span>Geflikt!<span class="nr">3</span></span><span>Andere<span class="nr">2</span></span><span style="color:var(--rood-t)">Betrap!</span></div></div>
      <ol class="punten-lijst"><li><span class="nr">1</span><span><b>Lezen = vasthouden.</b> Je opdracht is verborgen. Houd je vinger erop om hem te lezen; laat je los of doe je 5 seconden niets, dan is hij weer weg.</span></li>
        <li><span class="nr">2</span><span><b>Andere opdracht.</b> Past je opdracht echt niet? Je mag hem één keer wisselen, alleen in de eerste 10 minuten.</span></li>
        <li><span class="nr">3</span><span><b>Gelukt? Geflikt!</b> Voer je opdracht uit zonder dat iemand het doorheeft en tik dan op Geflikt! Je bent daarna niet veilig: tot het einde kun je nog betrapt worden.</span></li></ol>`;
    knop = `<button class="btn rood" data-a="uitleg-volgende">Volgende: betrappen</button>`;
  } else if (i === 1) {
    inhoud = `<span class="kicker" style="margin-top:8px">Zo werkt het · 2 van 3</span><h1 class="titel-serif" style="font-size:32px;margin-top:6px">Betrappen</h1>
      <div class="mock">
        <div style="position:relative;display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px;background:var(--s1)"><span class="ini" style="width:28px;height:28px;background:var(--s2);color:var(--muted);font-size:12px">J</span><span style="flex-grow:1;font-size:14px">Joris</span><span class="pill" style="height:30px;font-size:12px">Betrap!</span><span class="nr" style="position:absolute;right:-6px;top:-8px">1</span></div>
        <div style="position:relative;display:flex;align-items:center;gap:10px;padding:10px;border-radius:12px;background:var(--s3);border:1px solid var(--line2)">${ring('mock', 12, 40, 'var(--goud)')}<span style="flex-grow:1;font-size:13px"><b>Sanne betrapt Joris</b><br><span style="color:var(--muted)">Mehmet zag het ook</span></span><span class="pill meedoen" style="height:30px;font-size:12px">Meedoen</span><span class="nr" style="position:absolute;right:-6px;top:-8px">2</span></div>
        <div style="position:relative" class="twee"><span class="btn klein toegeven" style="height:38px;font-size:13px">Je hebt me!</span><span class="btn klein licht-knop" style="height:38px;font-size:13px">Mooi niet!</span><span class="nr" style="position:absolute;right:-6px;top:-8px">3</span></div></div>
      <ol class="punten-lijst"><li><span class="nr">1</span><span><b>Betrap en zeg het hardop.</b> Tik bij Spelers op Betrap! en zeg aan tafel wat je denkt dat de opdracht is.</span></li>
        <li><span class="nr">2</span><span><b>Zag jij het ook?</b> Tik op Ik zag het ook! Er loopt een teller van 15 seconden. Elke keer dat iemand bijvalt, begint hij opnieuw. Terugtrekken kan niet.</span></li>
        <li><span class="nr">3</span><span><b>De verdachte kiest.</b> Op 0: Je hebt me! = betrapt, Mooi niet! = hij speelt door. Het klopt als het de kern van de opdracht raakt; letterlijk hoeft niet.</span></li></ol>
      <p style="margin:14px 0 0;font-size:13px;color:var(--ink2)">Liegen valt op: bij de onthulling ziet iedereen elke Mooi niet! naast de echte opdracht.</p>`;
    knop = `<button class="btn rood" data-a="uitleg-volgende">Volgende: punten</button>`;
  } else {
    inhoud = `<span class="kicker" style="margin-top:8px">Zo werkt het · 3 van 3</span><h1 class="titel-serif" style="font-size:32px;margin-top:6px">Punten en de onthulling</h1>
      <div class="ptabel">${PUNTEN.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('')}</div>
      <p style="margin:10px 0 0;font-size:13px;color:var(--ink2)">Betrapt betekent ook: geen punten voor je opdracht, zelfs als je hem al had geflikt.</p>
      <div class="eindblok stippen"><b>Aan het eind van de avond</b>
        <span><b style="color:#fff">Per speler stemt de tafel:</b> heeft hij zijn opdracht echt geflikt? Meer nee dan ja = geen opdrachtpunten.</span>
        <span><b style="color:#fff">Elke Mooi niet! wordt gecheckt:</b> vindt de tafel dat hij betrapt was, dan telt hij alsnog als betrapt.</span>
        <span>De meeste punten? Dan ben jij de <b>Sluwste van de tafel</b>.</span></div>
      <p style="margin:10px 0 0;font-size:13px;color:var(--ink2)">Alles teruglezen kan tijdens het spel via het vraagteken.</p>`;
    knop = `<button class="btn rood" data-a="uitleg-klaar">Geef mij mijn opdracht</button>`;
  }
  return `<main class="screen licht uitleg-slide">${kop}${inhoud}<div style="flex-grow:1;min-height:18px"></div>${knop}</main>`;
}

function vEnvelop() {
  const f = S.envelop, open = f !== 'dicht', donker = f === 'donker';
  return `<main class="envelop-scherm ${donker ? 'donker' : ''}">
    <div class="stippen-laag stippen" aria-hidden="true"></div>
    <div class="env-tekst"><span class="k">${donker ? `${esc(S.sessie.naam)} · ${esc(S.sessie.code)}` : 'De opdrachten zijn uitgedeeld'}</span>
      <h1>${donker ? 'Alleen voor jouw ogen' : 'Je opdracht is binnen'}</h1>
      <p>${donker ? 'Vanaf nu is je scherm donker en rustig. Houd je opdracht vast om hem te lezen; laat los en hij is weg.' : 'Iedereen aan tafel krijgt er nu een. Niet bij je buren kijken!'}</p></div>
    <div class="env ${open ? 'open' : ''}">
      <svg width="260" height="170" viewBox="0 0 260 170" aria-hidden="true" style="z-index:1;filter:drop-shadow(0 14px 22px rgba(0,0,0,.35))"><defs><linearGradient id="mo-back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#B9AD97"/><stop offset="1" stop-color="#A59880"/></linearGradient></defs><rect width="260" height="170" rx="8" fill="url(#mo-back)"/></svg>
      <div class="brief" aria-hidden="true"><b>Strikt geheim</b><i style="width:100%"></i><i style="width:100%"></i><i style="width:80%"></i><i style="width:90%"></i></div>
      <svg width="260" height="170" viewBox="0 0 260 170" aria-hidden="true" style="z-index:3"><defs><linearGradient id="mo-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBF7F0"/><stop offset="1" stop-color="#E4DBCB"/></linearGradient></defs>
        <path d="M0 44 L130 112 L260 44 V162 A8 8 0 0 1 252 170 H8 A8 8 0 0 1 0 162Z" fill="url(#mo-front)"/><path d="M2 168 L112 104 M258 168 L148 104" stroke="#8F826B" stroke-opacity="0.25" stroke-width="1.4"/><path d="M1 45 L130 112 L259 45" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="1.4"/></svg>
      <div class="klep" aria-hidden="true"><svg width="260" height="104" viewBox="0 0 260 104" style="display:block"><defs><linearGradient id="mo-flap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9E0CF"/><stop offset="1" stop-color="#D3C8B3"/></linearGradient></defs><path d="M0 0 H260 L138 100 Q130 106 122 100Z" fill="url(#mo-flap)"/><path d="M1 1 L124 101 M259 1 L136 101" fill="none" stroke="#8F826B" stroke-opacity="0.25" stroke-width="1.2"/></svg></div>
      <svg class="dicht-laag" width="260" height="170" viewBox="0 0 260 170" aria-hidden="true" style="filter:drop-shadow(0 14px 22px rgba(0,0,0,.35))"><defs><linearGradient id="mo-dflap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F2EBDF"/><stop offset="1" stop-color="#DCD2BF"/></linearGradient></defs>
        <rect width="260" height="170" rx="8" fill="#EEE7DA"/><path d="M0 10 L120 98 L0 160Z" fill="#E7DECF"/><path d="M260 10 L140 98 L260 160Z" fill="#E7DECF"/><path d="M2 170 L122 94 Q130 89 138 94 L258 170Z" fill="#F5F0E7"/><path d="M0 0 H260 L141 100 Q130 108 119 100Z" fill="url(#mo-dflap)"/></svg>
      ${open ? '' : '<span class="puls" aria-hidden="true"></span>'}
      <div class="zegel" aria-hidden="true"><span></span><span></span></div>
      ${open ? '' : '<button class="tik" data-a="zegel" aria-label="Breek het zegel"></button>'}
    </div>
    <div style="flex-grow:1"></div>
    <div style="position:relative;width:100%;max-width:432px;display:flex;flex-direction:column;align-items:center;gap:12px">
      ${!open ? '<span style="font-size:16px;font-weight:600;color:#FBE7DA">Tik op het zegel</span>' : ''}
      ${donker ? '<button class="btn goud" data-a="naar-missie">Naar je opdracht</button>' : ''}
    </div></main>`;
}

// ----- spel -----
function vSpelkop() {
  const s = S.sessie, me = ik();
  return `<div class="spelkop"><div class="t"><b>${esc(s.naam)}</b><span>${esc(s.code)} · ${plural(actief().length, 'speler', 'spelers')}${isHost() ? ' · host' : ''}</span></div>
    <div class="r">${s.punten_aan ? `<span class="chip-score">${me?.punten_beschuldiging ?? 0} pt</span>` : ''}<button class="iconbtn" data-a="speluitleg" aria-label="Spelregels">${I.vraag}</button></div></div>`;
}

function vSpel() {
  const nOpen = openBesch().filter((b) => b.beschuldigde_id !== ik()?.id).length;
  return `<main class="screen">
    ${S.tab === 'missie' ? vSpelkop() : ''}
    ${hostBanners()}
    ${S.tab === 'missie' ? vMissieTab() : vSpelersTab()}
    <nav class="tabbalk" role="tablist">
      <button role="tab" aria-selected="${S.tab === 'missie'}" data-a="tab" data-v="missie">${I.missie}Opdracht</button>
      <button role="tab" aria-selected="${S.tab === 'spelers'}" data-a="tab" data-v="spelers">${I.spelers}Spelers${nOpen ? ` · ${nOpen} open` : ''}</button>
    </nav></main>`;
}

function vMissieTab() {
  const m = S.missie, me = ik();
  if (!m) return `<div class="missie-wrap"><div class="center-msg"><div class="spinner"></div></div></div>`;
  if (!m.heeft_missie) return `<div class="missie-wrap"><div class="center-msg"><h2>Nog geen opdracht</h2><p>${esc(S.fout || 'Even geduld…')}</p></div></div>`;
  if (me?.ontmaskerd) {
    return `<div class="missie-wrap"><div class="voltooid-kaart" style="background:#2E1E1A;border-color:var(--rood-rand)">
      <span class="vink" style="background:var(--rood-t);color:#2E1E1A">${I.masker}</span><h2>Betrapt!</h2>
      <p>Je opdracht is mislukt. Je kunt nog wel anderen betrappen.</p></div>
      ${vMissieKaart(m, true)}
      <button class="btn" data-a="tab" data-v="spelers">${I.wijs}Naar de spelers</button></div>`;
  }
  if (m.voltooid) {
    const mijnDeel = S.deel.filter((d) => d.speler_id === me?.id);
    const speur = mijnDeel.reduce((a, d) => a + d.punten, 0);
    const verdacht = S.besch.filter((b) => b.beschuldigde_id === me?.id && b.status !== 'vervallen').length;
    return `<div class="missie-wrap">
      <div class="voltooid-kaart"><span class="vink">${I.vink}</span><h2>Geflikt!</h2>
        <span class="sub">om ${tijd(m.voltooid_op)}${m.getuige_id ? ` · getuige: ${esc(naam(m.getuige_id))}` : ''}</span>
        <p>Blijf onder de radar. Tot het einde van de avond kun je nog betrapt worden, en dan vervallen je opdrachtpunten.</p>
        <button class="btn ghost klein" style="justify-content:flex-start;padding:0;height:32px;font-size:13px" data-a="voltooid-ongedaan">Per ongeluk? Ongedaan maken</button></div>
      ${vMissieKaart(m, true)}
      ${S.sessie.punten_aan ? `<div class="mini-scores"><div><b>+${m.moeilijkheid}</b><span>opdracht</span></div><div><b>${speur > 0 ? '+' : ''}${speur}</b><span>speuren</span></div><div><b>${verdacht}</b><span>keer verdacht</span></div></div>` : ''}
      <button class="btn" data-a="tab" data-v="spelers">${I.wijs}Iemand betrappen</button></div>`;
  }
  const jokerTot = new Date(m.joker_tot).getTime();
  const jokerKan = m.gratis_wissel || m.joker_extra || (!m.joker_gebruikt && nu() < jokerTot);
  const jokerTekst = m.gratis_wissel ? 'Gratis wissel beschikbaar' : m.joker_extra ? 'Extra wissel van de host' : m.joker_gebruikt ? 'Al gewisseld' : nu() < jokerTot ? `Wisselen kan nog <span data-jokertot="${jokerTot}">${fmtMin(jokerTot - nu())}</span>` : 'Wisselen kan niet meer';
  return `<div class="missie-wrap" id="missiewrap">
    ${m.gratis_wissel ? `<div class="banner" style="margin:0"><p>Je doelwit is vertrokken. Je mag gratis wisselen.</p></div>` : ''}
    ${vMissieKaart(m, false)}
    <div class="status-regel"><span>${jokerTekst}</span><span>Nog niet geflikt</span></div>
    <div class="acties3">
      <button class="act" data-a="voltooid">${I.vink}Geflikt!</button>
      <button class="act" data-a="joker" ${jokerKan ? '' : 'disabled'}>${I.wissel}Andere opdracht</button>
      <button class="act rood" data-a="tab" data-v="spelers">${I.wijs}Betrap!</button>
    </div></div>`;
}
const fmtMin = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function vMissieKaart(m, klein) {
  return `<div class="missie-kaart" id="missiekaart" tabindex="0" aria-label="Houd vast om je opdracht te lezen" ${klein ? 'style="flex-grow:0;min-height:140px"' : ''}>
    <div class="mk-dicht" aria-hidden="true"><span class="lbl">Jouw opdracht</span><span class="balk" style="width:88%"></span><span class="balk" style="width:70%"></span>${klein ? '' : '<span class="balk" style="width:80%"></span>'}
      <span class="hold">${I.hand}Houd vast om te lezen</span></div>
    <div class="mk-open"><div class="boven"><span>Jouw opdracht</span><span>${MOEIL[m.moeilijkheid] || ''} · ${m.moeilijkheid} pt</span></div>
      <div style="display:flex;flex-direction:column;gap:14px"><p class="missie-tekst">${esc(m.tekst)}</p>${m.uitleg ? `<p class="missie-uitleg">${esc(m.uitleg)}</p>` : ''}</div>
      <div class="voet"><div class="timer5"><i></i></div><span>Laat los om te verbergen · verdwijnt vanzelf na 5 s</span></div></div>
  </div>`;
}

function vSpelersTab() {
  const me = ik(), open = openBesch(), host = isHost();
  const openVoor = (id) => open.find((b) => b.beschuldigde_id === id);
  const sp = actief().slice().sort((a, b) => (a.id === me?.id) - (b.id === me?.id) || a.ontmaskerd - b.ontmaskerd || a.volgnr - b.volgnr);
  const mijnOpen = open.filter((b) => doetMee(b.id));
  return `<div style="flex-grow:1;padding-bottom:16px">
    <div class="spelers-kop"><h1>Spelers<span class="s">Zeg hardop wat je vermoedt</span></h1>
      <div class="r" style="display:flex;align-items:center;gap:4px">${S.sessie.punten_aan ? `<span class="chip-score">${me?.punten_beschuldiging ?? 0} pt</span>` : ''}<button class="iconbtn" data-a="speluitleg" aria-label="Spelregels">${I.vraag}</button></div></div>
    ${mijnOpen.map((b) => `<button class="besch-kaart" style="width:calc(100% - 32px);text-align:left;color:inherit" data-a="open-besch" data-id="${b.id}">${ring(b.id, restWacht(b), 44, 'var(--goud)')}
      <span class="t"><b>${b.eerste_beschuldiger_id === me?.id ? 'Jij betrapt' : 'Jij zag het ook bij'} ${esc(naam(b.beschuldigde_id))}</b><span>${plural(deelnemers(b.id).length, 'betrapper', 'betrappers')} · tik voor details</span></span></button>`).join('')}
    <div class="lijst">
      ${sp.map((p) => {
        const b = openVoor(p.id), zelf = p.id === me?.id;
        let sub = zelf ? 'jij' : p.ontmaskerd ? 'betrapt' : b ? `betrapt door ${esc(naam(b.eerste_beschuldiger_id))}?` : '';
        let knop = '';
        if (!zelf && !p.ontmaskerd) {
          if (b) knop = doetMee(b.id) ? `<span class="jedoetmee">Jij zag het ook</span>` : `<button class="pill meedoen" data-a="meedoen" data-id="${b.id}">Ik zag het ook! <span data-wacht="${b.id}" style="font-variant-numeric:tabular-nums">${Math.ceil(restWacht(b)) || ''}</span></button>`;
          else knop = `<button class="pill" data-a="beschuldig" data-id="${p.id}">Betrap!</button>`;
        }
        return `<div class="rij ${p.ontmaskerd || zelf ? 'grijs' : ''}"><span class="ini">${esc(p.naam[0]?.toUpperCase())}</span>
          <span class="naam"><b>${esc(p.naam)}</b>${sub ? `<span>${sub}</span>` : ''}</span>${knop}
          ${host && !zelf ? `<button class="iconbtn" data-a="spelermenu" data-id="${p.id}" aria-label="Opties voor ${esc(p.naam)}">${I.meer}</button>` : ''}</div>`;
      }).join('')}
    </div>
    ${host ? `<div class="foot" style="padding-top:20px">${open.filter((b) => (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT && b.beschuldigde_id !== me?.id)
        .map((b) => `<button class="btn klein" data-a="host-sluit" data-id="${b.id}">${esc(naam(b.beschuldigde_id))} reageert niet: sluit als Mooi niet!</button>`).join('')}
      <button class="btn klein" style="border-color:var(--rood-rand);color:var(--rood-t)" data-a="beeindig">Spel beëindigen en onthullen</button>
      <p class="foot-note">Iedereen ziet daarna alle opdrachten.</p></div>` : ''}
    <div class="foot" style="padding-top:${host ? 4 : 20}px">${echteHost() ? `<button class="btn ghost klein" style="color:var(--rood-t)" data-a="annuleer">Avond annuleren</button>`
      : `<button class="btn ghost klein" style="color:var(--muted)" data-a="verlaat">Tafel verlaten</button>`}</div>
  </div>`;
}

// Volledig scherm voor de beschuldigde
function vOverlay() {
  if (S.view !== 'sessie' || S.sessie?.status !== 'spel' || !ls.get(ceremonieKey())) return '';
  const me = ik(), b = me && openBesch().find((x) => x.beschuldigde_id === me.id);
  if (!b) { vOverlay.laatste = null; return ''; }
  const nieuw = vOverlay.laatste !== b.id; vOverlay.laatste = b.id;
  const d = deelnemers(b.id), rest = restWacht(b);
  const lang = (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT;
  return `<div class="accused ${nieuw ? 'anim' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="acc-t"><div class="inner">
    <span class="k">Je bent betrapt?!</span><h2 id="acc-t" class="door" style="font-size:18px;font-weight:600;color:var(--muted)">door ${esc(namenLijst(d.map((x) => naam(x.speler_id))))}</h2>
    ${rest > 0 ? `<div style="margin:18px 0 6px">${ring(b.id, rest, 200, 'var(--rood-t)')}</div><span style="color:var(--muted)">tot je kunt reageren</span>
        <p style="margin-top:10px">Luister wat ze denken. Doet er nog iemand mee, dan begint de teller opnieuw.</p>`
      : `<div style="margin:24px 0 8px;display:flex;flex-direction:column;gap:6px"><span style="font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--rood-t)">Jouw beurt</span><span style="color:var(--faint);font-size:13px">teller staat op 0</span></div>
        <p class="vraag">Raakt hun vermoeden de kern van je opdracht?</p>
        <p>Letterlijk hoeft niet. Bij de onthulling ziet iedereen deze betrapping naast je echte opdracht.</p>
        ${lang ? '<p style="color:var(--goud)">Iedereen wacht op jou. Kies nu.</p>' : ''}`}
    <div class="groei"></div>
    <div class="check-missie" id="checkmissie" role="button" tabindex="0" aria-label="Houd vast om je opdracht te checken"><span class="label" style="display:flex;align-items:center;gap:10px"><span style="width:20px;height:20px">${I.hand}</span>Houd vast om je opdracht te checken</span><span class="tekst">${esc(S.missie?.tekst || '')}</span></div>
    <div class="twee"><button class="btn toegeven" data-a="reageer" data-id="${b.id}" data-val="ja" ${rest > 0 ? 'disabled' : ''}>Je hebt me!</button>
      <button class="btn licht-knop" data-a="reageer" data-id="${b.id}" data-val="nee" ${rest > 0 ? 'disabled' : ''}>Mooi niet!</button></div>
  </div></div>`;
}

function vUitslag() {
  const u = S.uitslag;
  if (!u) { vUitslag.laatste = null; return ''; }
  const nieuw = vUitslag.laatste !== u.id; vUitslag.laatste = u.id;
  return `<div class="uitslag ${nieuw ? 'anim' : ''}" data-a="uitslag-dicht"><div class="kaart" role="status">
    <span class="ico ${u.goed ? 'good' : 'bad'}" style="width:52px;height:52px">${u.goed ? `<span style="width:26px;height:26px">${I.masker}</span>` : `<span style="width:26px;height:26px">${I.wissel}</span>`}</span>
    <h2>${esc(u.titel)}</h2><span class="sub">${esc(u.sub)}</span>
    ${S.sessie?.punten_aan ? u.rijen.map((r) => `<div class="r"><span>${esc(r.naam)} <span style="color:var(--faint)">· ${r.rol}</span></span><span style="color:${r.pt > 0 ? 'var(--good)' : 'var(--rood-t)'}">${r.pt > 0 ? '+' : '−'}${Math.abs(r.pt)}</span></div>`).join('') : ''}
    <button class="btn goud klein" data-a="uitslag-dicht">Verder spelen</button><span class="noot">Verdwijnt vanzelf na 6 seconden</span></div></div>`;
}

// ----- onthulling -----
function huidig() {
  const s = S.sessie, id = s.onthul_volgorde?.[s.onthul_index];
  const data = S.onthulling?.find((x) => x.speler_id === id);
  const check = s.onthul_stap === 'missie' && s.onthul_check >= 0 ? data?.afgewezen?.[s.onthul_check] : null;
  return { id, data, stap: s.onthul_stap, check, n: s.onthul_volgorde?.length || 0, i: s.onthul_index };
}
function status(o) {
  if (o.ontmaskerd) return ['bad', 'Betrapt'];
  if (o.voltooid && !o.afgewezen.length) return ['good', 'Ongezien'];
  if (o.voltooid) return ['good', 'Geflikt'];
  return ['meh', 'Niet geflikt'];
}
function tellingen(spelerId, beschId) {
  const st = S.stemmen.filter((x) => x.speler_id === spelerId && (x.beschuldiging_id || null) === (beschId || null));
  const c = { ja: 0, nee: 0, weet: 0 }; st.forEach((x) => c[x.keuze]++);
  return { ...c, totaal: st.length, kiezers: actief().length - 1 };
}
// Welke stemvraag hoort bij de huidige stap? null = geen stemming.
function stemVraag() {
  const { data, stap, check } = huidig();
  if (!data || stap !== 'missie') return null;
  if (check) return { ronde: 'Ronde 2 · controle', vraag: 'Raakte de betrapping de kern?', besch: check.id,
    gevolg: `Meer ja dan nee: ${data.naam} telt alsnog als betrapt.` };
  if (data.voltooid && !data.ontmaskerd) return { ronde: 'Ronde 1 · stemming', vraag: `Heeft ${data.naam} dit echt geflikt?`, besch: null,
    gevolg: 'Meer nee dan ja: de opdrachtpunten vervallen.' };
  return null;
}
function revealAnim() {
  const k = `${S.sessie.onthul_index}${S.sessie.onthul_stap}${S.sessie.onthul_check}`;
  const nieuw = revealAnim.laatste !== k; revealAnim.laatste = k; return nieuw ? 'anim' : '';
}
function vStemKaart(v, data) {
  const t = tellingen(data.speler_id, v.besch);
  return `<div class="feest-kaart"><span class="k">${v.ronde}</span><p class="vraag">${esc(v.vraag)}</p>
    <div class="tellers"><div><b>${t.ja}</b><span>Ja</span></div><div><b>${t.nee}</b><span>Nee</span></div><div><b>${t.weet}</b><span>Weet niet</span></div></div>
    <p>${esc(v.gevolg)}</p><p style="font-size:13px">Stem op je telefoon · ${t.totaal} van ${t.kiezers} gestemd · ${esc(data.naam)} stemt niet</p></div>`;
}
function vOnthullingInhoud(groot) {
  const { data, stap, check, n, i } = huidig();
  if (!data) return `<div class="spinner"></div>`;
  if (stap === 'naam') {
    return `<span class="ondertitel">De opdracht van</span><h2 class="grote-naam">${esc(data.naam)}</h2>
      ${groot ? `<span class="tik-hint"><span style="width:18px;height:18px">${I.tik}</span>Tik om te onthullen</span>` : ''}`;
  }
  const [cls, txt] = status(data), v = stemVraag();
  const links = `<div class="links"><span class="ondertitel">${esc(data.naam)}</span><span class="status-badge ${cls}">${txt}</span>
    <p class="citaat">“${esc(data.tekst)}”</p>
    <span class="meta">${MOEIL[data.moeilijkheid]} · ${data.moeilijkheid} ${data.moeilijkheid === 1 ? 'punt' : 'punten'}${data.voltooid ? ` · geflikt om ${tijd(data.voltooid_op)}` : ''}${data.getuige ? ` · getuige: ${esc(data.getuige)}` : ''}</span></div>`;
  let zij = '';
  if (check) {
    zij = `<div style="display:flex;flex-direction:column;gap:12px"><div class="feest-kaart"><span class="k">Mooi niet!${data.afgewezen.length > 1 ? ` ${S.sessie.onthul_check + 1} van ${data.afgewezen.length}` : ''}</span>
      <p class="vraag" style="font-size:clamp(16px,2vw,22px)">${esc(namenLijst(check.door))} ${check.door.length > 1 ? 'betrapten' : 'betrapte'} ${esc(data.naam)} om ${tijd(check.op)}</p>
      <p>Wat dachten jullie toen? Zeg het hardop.</p></div>${groot ? vStemKaart(v, data) : ''}</div>`;
  } else if (groot && v) {
    zij = vStemKaart(v, data);
  } else if (groot && data.afgewezen.length) {
    zij = `<div class="feest-kaart"><span class="k">Mooi niet!</span><p>${data.afgewezen.length}× betrapt maar ontkend. Die bespreken we zo.</p></div>`;
  }
  return `<div class="onthul-grid ${zij ? 'met-zij' : ''}">${links}${zij}</div>`;
}
function volgendeLabel() {
  const { data, stap, n, i } = huidig(), s = S.sessie;
  if (stap === 'naam') return 'Onthul de opdracht';
  const aw = data?.afgewezen?.length || 0;
  if (s.onthul_check < aw - 1) return s.onthul_check < 0 ? 'Naar de controle' : 'Volgende betrapping';
  return i < n - 1 ? 'Volgende speler' : null;
}
function vOnthullingHost() {
  const { stap, n, i } = huidig(), lbl = volgendeLabel();
  return `<main class="feest stippen">
    <div class="feest-top"><b>De onthulling</b><span>Speler ${Math.min(i + 1, n)} van ${n}</span></div>
    <div class="feest-main ${revealAnim()} ${stap === 'naam' ? 'tik' : ''}" ${stap === 'naam' ? 'data-a="onthul-volgende" role="button" tabindex="0"' : ''}>${vOnthullingInhoud(true)}</div>
    <div class="feest-voet"><button class="btn fk-rand" data-a="onthul-vorige" ${i === 0 && stap === 'naam' ? 'disabled' : ''}>Vorige</button>
      ${lbl ? `<button class="btn fk" data-a="onthul-volgende">${lbl}</button>` : `<button class="btn fk" data-a="scorebord">Naar het scorebord</button>`}</div></main>`;
}
function vOnthullingSpeler() {
  const { data, stap, n, i } = huidig(), me = ik(), v = stemVraag();
  const magStemmen = v && data && data.speler_id !== me?.id;
  const mijn = magStemmen && S.stemmen.find((x) => x.speler_id === data.speler_id && x.stemmer_id === me?.id && (x.beschuldiging_id || null) === (v.besch || null));
  const t = v && data ? tellingen(data.speler_id, v.besch) : null;
  return `<main class="feest stippen">
    <div class="feest-top"><b>De onthulling</b><span>Speler ${Math.min(i + 1, n)} van ${n}</span></div>
    <div class="feest-main ${revealAnim()}" style="justify-content:flex-start;padding-top:32px">${vOnthullingInhoud(false)}</div>
    <div class="foot" style="width:100%;max-width:480px;margin:0 auto">
      ${magStemmen ? `<div class="feest-kaart" style="background:transparent;border:0;padding:0;text-align:center"><span class="k">${v.ronde}</span><p class="vraag">${esc(v.vraag)}</p></div>
        <div class="stem-knoppen"><button class="stem" data-a="stem" data-val="ja" aria-pressed="${mijn?.keuze === 'ja'}">${I.duimOp}Ja</button>
          <button class="stem" data-a="stem" data-val="nee" aria-pressed="${mijn?.keuze === 'nee'}">${I.duimNeer}Nee</button></div>
        <button class="stem-weet" data-a="stem" data-val="weet" aria-pressed="${mijn?.keuze === 'weet'}">Weet ik niet</button>
        <p class="foot-note" style="color:#F0D9C9">${mijn ? 'Je stem is binnen. Je mag nog wisselen.' : ''} ${t.totaal} van ${t.kiezers} gestemd</p>`
        : `<p class="foot-note" style="color:#F0D9C9;font-size:15px">${v && data?.speler_id === me?.id ? 'Dit gaat over jou. De anderen stemmen.' : 'Kijk mee op het scherm van de host.'}</p>`}
    </div></main>`;
}

function vScorebord() {
  const sp = actief().slice().sort((a, b) => (b.eindscore ?? 0) - (a.eindscore ?? 0) || a.volgnr - b.volgnr);
  const punten = S.sessie.punten_aan, top = sp[0];
  const raak = {}, totaal = {};
  S.deel.forEach((d) => { const b = S.besch.find((x) => x.id === d.beschuldiging_id); if (!b || b.status === 'vervallen') return; totaal[d.speler_id] = (totaal[d.speler_id] || 0) + 1; if (d.punten > 0) raak[d.speler_id] = (raak[d.speler_id] || 0) + 1; });
  const speurder = Object.keys(raak).sort((a, b) => raak[b] - raak[a] || totaal[a] - totaal[b])[0];
  const radar = sp.filter((p) => p.missie_gehaald).sort((a, b) => (S.onthulling?.find((o) => o.speler_id === a.id)?.keer_verdacht ?? 0) - (S.onthulling?.find((o) => o.speler_id === b.id)?.keer_verdacht ?? 0))[0];
  const radarV = radar ? (S.onthulling?.find((o) => o.speler_id === radar.id)?.keer_verdacht ?? 0) : 0;
  return `<main class="feest stippen" style="padding-bottom:env(safe-area-inset-bottom)">
    <div class="feest-top"><b>Eindstand</b><span>${esc(S.sessie.naam)}</span></div>
    <div style="width:100%;max-width:520px;margin:0 auto;display:flex;flex-direction:column;flex-grow:1">
    ${punten && top ? `<div class="topkaart">${I.kroon}<span class="k">Sluwste van de tafel</span><h2>${esc(sp.filter((p) => p.eindscore === top.eindscore).map((p) => p.naam).join(' & '))}</h2><span>${top.eindscore} punten</span></div>`
      : `<div class="topkaart">${I.kroon}<span class="k">Het spel is uit</span><h2>${sp.filter((p) => p.missie_gehaald).length} van ${sp.length}</h2><span>opdrachten geflikt</span></div>`}
    <div class="titels">
      ${speurder ? `<div><span class="k">Haviksoog</span><b>${esc(naam(speurder))}</b><span>${raak[speurder]} van ${totaal[speurder]} raak</span></div>` : ''}
      ${radar ? `<div><span class="k">Onder de radar</span><b>${esc(radar.naam)}</b><span>${radarV ? `${radarV}× verdacht, toch gehaald` : 'nooit verdacht'}</span></div>` : ''}
    </div>
    <div class="rang">${sp.map((p, i) => `<div><span class="pos">${punten ? i + 1 : ''}</span><span class="n"><b>${esc(p.naam)}</b><span>${p.missie_gehaald ? 'opdracht geflikt' : p.ontmaskerd ? 'betrapt' : 'opdracht niet geflikt'}${punten ? ` · speuren ${p.punten_beschuldiging > 0 ? '+' : ''}${p.punten_beschuldiging}` : ''}</span></span>
      ${punten ? `<span class="pt">${p.eindscore ?? 0}</span>` : `<span style="width:22px;color:${p.missie_gehaald ? 'var(--feestgoud)' : 'transparent'}">${I.vink}</span>`}</div>`).join('')}</div>
    <div class="foot"><button class="btn fk-rand klein" data-a="missies-terug">Alle opdrachten terugzien</button><button class="btn fk" data-a="naar-home">Nieuwe avond</button></div>
    </div></main>`;
}

// ----- sheets en toasts -----
function vSheet() {
  const sh = S.sheet;
  if (!sh) { vSheet.laatste = null; return ''; }
  let inner = '';
  if (sh.type === 'voltooid') {
    const me = ik();
    inner = `<h2>Geflikt?</h2><p>Kies eventueel wie er getuige of slachtoffer was. Dat helpt bij de onthulling.</p>
      <div class="picks">${actief().filter((p) => p.id !== me?.id).map((p) => `<button class="pick" data-a="getuige" data-id="${p.id}" aria-pressed="${sh.getuige === p.id}">${esc(p.naam)}</button>`).join('')}</div>
      <button class="btn goud" data-a="voltooid-ok">Ja, geflikt!</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'joker') {
    inner = `<h2>Andere opdracht?</h2><p>${S.missie?.gratis_wissel ? 'Je doelwit is vertrokken, dus deze wissel is gratis.' : 'Je krijgt een nieuwe opdracht. Je oude komt niet terug in het spel. Dit kan maar één keer.'}</p>
      <button class="btn goud" data-a="joker-ok">Geef mij een andere</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'beschuldig') {
    inner = `<span class="k">Betrap!</span><h2>${esc(naam(sh.id))} betrappen?</h2><p>Zeg hardop wat je denkt dat de opdracht is. Klopt het, dan krijg je +2. Klopt het niet, dan −2.</p>
      <button class="btn goud" data-a="beschuldig-ok" data-id="${sh.id}">Betrap ${esc(naam(sh.id))}!</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'melding') {
    const b = S.besch.find((x) => x.id === sh.id);
    if (!b || b.status !== 'open' || doetMee(b.id)) { S.sheet = null; return ''; }
    const d = deelnemers(b.id);
    inner = `<div style="display:flex;align-items:center;gap:14px">${ring(b.id, restWacht(b), 52, 'var(--goud)')}<div><span class="k">Betrapt?!</span><h2>${esc(naam(b.eerste_beschuldiger_id))} betrapt ${esc(naam(b.beschuldigde_id))}</h2></div></div>
      <div class="naam-chips">${d.map((x) => `<span class="${x.rol === 'eerste' ? 'eerste' : ''}">${esc(naam(x.speler_id))}${x.rol === 'eerste' ? ' · betrapper' : ''}</span>`).join('')}<span style="background:transparent;color:var(--faint)">zagen het</span></div>
      <p>Zag jij het ook? Klopt het, dan krijg jij +1. Klopt het niet, dan −1. Bijvallen zet de teller terug op 15.</p>
      <div class="twee"><button class="btn klein" data-a="sheet-dicht">Later</button><button class="btn goud klein" data-a="meedoen" data-id="${b.id}">Ik zag het ook!</button></div>`;
  } else if (sh.type === 'open-besch') {
    const b = S.besch.find((x) => x.id === sh.id);
    if (!b || b.status !== 'open') { S.sheet = null; return ''; }
    const d = deelnemers(b.id), me = ik(), rest = restWacht(b);
    inner = `<span class="k">Betrapt?!</span><h2>${b.eerste_beschuldiger_id === me?.id ? 'Jij betrapt' : `${esc(naam(b.eerste_beschuldiger_id))} betrapt`} ${esc(naam(b.beschuldigde_id))}</h2>
      <div style="display:flex;justify-content:center;padding:6px 0">${ring(b.id, rest, 150, 'var(--goud)')}</div>
      <p style="text-align:center">${rest > 0 ? `Zeg hardop wat je denkt dat de opdracht is. ${esc(naam(b.beschuldigde_id))} kan pas reageren als de teller op 0 staat.` : `${esc(naam(b.beschuldigde_id))} kiest nu: Je hebt me! of Mooi niet!`}</p>
      <div><div class="mee-rij" style="color:var(--faint);font-size:13px"><span>Zagen het</span><span>klopt / klopt niet</span></div>
        ${d.map((x) => `<div class="mee-rij"><span>${x.speler_id === me?.id ? 'Jij' : esc(naam(x.speler_id))} <span style="color:var(--faint)">${x.rol === 'eerste' ? '· betrapper' : ''}</span></span><span>${x.rol === 'eerste' ? '+2 / −2' : '+1 / −1'}</span></div>`).join('')}</div>
      <p style="text-align:center;font-size:13px">Je kunt niet terugtrekken</p>
      <button class="btn klein" data-a="sheet-dicht">Terug naar het spel</button>`;
  } else if (sh.type === 'spelermenu') {
    const p = speler(sh.id), inSpel = S.sessie.status === 'spel';
    inner = `<h2>${esc(p?.naam)}</h2>
      ${inSpel ? `<button class="btn klein" data-a="extra-joker" data-id="${sh.id}">Nog een keer laten wisselen</button><p>Bijvoorbeeld als iemand per ongeluk zijn scherm liet zien.</p>` : ''}
      <button class="btn klein" style="border-color:var(--rood-rand);color:var(--rood-t)" data-a="verwijder" data-id="${sh.id}">Verwijderen van tafel</button>
      <button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'beeindig') {
    inner = `<h2>Spel beëindigen?</h2><p>Lopende betrappingen vervallen en de onthulling begint. Dit kan niet terug.</p>
      <button class="btn goud" data-a="beeindig-ok">Beëindigen en onthullen</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'annuleer') {
    inner = `<h2>Avond annuleren?</h2><p>${S.sessie?.status === 'lobby' ? 'Niemand kan meer aanschuiven.' : 'Het spel stopt direct, zonder onthulling.'} Iedereen ziet dat de avond is geannuleerd en alle aanmeldingen worden verwijderd. Dit kan niet terug.</p>
      <button class="btn toegeven" data-a="annuleer-ok">Ja, annuleer de avond</button><button class="btn ghost" data-a="sheet-dicht">Nee, terug</button>`;
  } else if (sh.type === 'verlaat') {
    inner = `<h2>Tafel verlaten?</h2><p>${S.sessie?.status === 'lobby' ? 'Je aanmelding wordt verwijderd. Met de code kun je later weer aanschuiven.' : 'Je doet niet meer mee en je opdracht vervalt. Wie jou als doelwit had, krijgt een gratis wissel.'}</p>
      <button class="btn toegeven" data-a="verlaat-ok">Verlaten</button><button class="btn ghost" data-a="sheet-dicht">Blijven</button>`;
  } else if (sh.type === 'naambestaat') {
    inner = `<h2>${esc(sh.naam)} zit al aan tafel</h2><p>Ben jij dat, op een nieuw toestel (bijvoorbeeld omdat je telefoon leeg is)?</p>
      <button class="btn goud" data-a="join-overname">Ja, ik ben ${esc(sh.naam)}</button><button class="btn" data-a="join-nieuw">Nee, ik ben iemand anders</button>`;
  } else if (sh.type === 'missies') {
    inner = `<h2>Alle opdrachten</h2>${(S.onthulling || []).map((o) => { const [c, t] = status(o); return `<div style="padding:14px;border-radius:16px;background:var(--s1);display:flex;flex-direction:column;gap:4px"><b>${esc(o.naam)} <span style="font-weight:400;color:${c === 'good' ? 'var(--goud)' : c === 'bad' ? 'var(--rood-t)' : 'var(--faint)'}">· ${t}</span></b><span style="color:var(--muted);font-size:15px">${esc(o.tekst)}</span></div>`; }).join('')}
      <button class="btn ghost" data-a="sheet-dicht">Sluiten</button>`;
  }
  const key = sh.type + (sh.id || ''), nieuw = key !== vSheet.laatste; vSheet.laatste = key;
  return `<div class="scrim ${nieuw ? 'anim' : ''}" data-a="scrim"><div class="sheet" role="dialog" aria-modal="true">${inner}${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}</div></div>`;
}

vToasts.gezien = new Set();
function vToasts() {
  if (!S.toasts.length) return '';
  const nieuw = (id) => { if (vToasts.gezien.has(id)) return ''; vToasts.gezien.add(id); return 'anim'; };
  return `<div class="toasts" aria-live="polite">${S.toasts.map((t) => `<button class="toast ${nieuw(t.id)}" data-a="toast" data-id="${t.id}"><b>${esc(t.titel)}</b>${t.tekst ? `<span>${esc(t.tekst)}</span>` : ''}</button>`).join('')}</div>`;
}
function toast(titel, tekst = '', ms = 5000) {
  const id = Math.random().toString(36).slice(2);
  S.toasts.push({ id, titel, tekst });
  setTimeout(() => { S.toasts = S.toasts.filter((t) => t.id !== id); render(); }, ms);
  render();
}

// ---------- QR en timers ----------
function tekenQR() {
  const el = document.getElementById('qr');
  if (!el || !window.maakQR) return;
  el.innerHTML = window.maakQR(location.origin + location.pathname.replace(/index\.html$/, '') + '?code=' + S.sessie.code);
}
const wasNul = new Set();
function tik() {
  clearTimeout(tikTimer);
  if (S.view !== 'sessie' || S.sessie?.status !== 'spel') return;
  let rerender = false;
  for (const b of openBesch()) {
    const rest = restWacht(b), t = rest > 0 ? Math.ceil(rest) : 0;
    document.querySelectorAll(`[data-wacht="${b.id}"]`).forEach((e) => (e.textContent = t || (e.closest('.ring') ? '0' : '')));
    document.querySelectorAll(`[data-ring="${b.id}"]`).forEach((e) => e.setAttribute('stroke-dashoffset', Number(e.dataset.omtrek) * (1 - rest / WACHT)));
    const key = b.id + b.laatste_meedoen;
    if (rest <= 0 && !wasNul.has(key)) { wasNul.add(key); rerender = true; if (b.beschuldigde_id === ik()?.id) tril([300, 120, 300]); }
    const lang = (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT;
    if (lang && !wasNul.has(key + 'lang')) { wasNul.add(key + 'lang'); rerender = true; }
  }
  document.querySelectorAll('[data-jokertot]').forEach((e) => { const ms = Number(e.dataset.jokertot) - nu(); if (ms <= 0) rerender = true; else e.textContent = fmtMin(ms); });
  if (rerender) return render();
  tikTimer = setTimeout(tik, 250);
}
function tril(p) { try { navigator.vibrate?.(p); } catch {} }

// ---------- sessie laden en realtime ----------
async function laadAlles() {
  if (!S.sid) return;
  const sid = S.sid;
  const [ses, spl, bes, dee, ste, ove] = await Promise.all([
    sb.from('sessies').select('*').eq('id', sid).maybeSingle(),
    sb.from('spelers').select('*').eq('sessie_id', sid).order('volgnr'),
    sb.from('beschuldigingen').select('*').eq('sessie_id', sid).order('aangemaakt'),
    sb.from('deelnames').select('*').eq('sessie_id', sid),
    sb.from('stemrondes').select('*').eq('sessie_id', sid),
    sb.from('overnames').select('*').eq('sessie_id', sid).eq('status', 'open'),
  ]);
  if (sid !== S.sid) return;
  if (ses.error || spl.error) { console.warn(ses.error || spl.error); return; }
  if (!ses.data) return verlaat(S.eersteLaad ? null : 'Deze avond bestaat niet meer, of je bent van tafel gehaald.');
  if (ses.data.status === 'geannuleerd') return verlaat('De host heeft de avond geannuleerd.');
  const vorig = { status: S.sessie?.status, ontm: ik()?.ontmaskerd, als: ik()?.id, stap: S.sessie && `${S.sessie.onthul_index}${S.sessie.onthul_stap}` };
  S.sessie = ses.data; S.spelers = spl.data || []; S.deel = dee.data || []; S.stemmen = ste.data || []; S.overnames = ove.data || [];
  const nieuweBesch = bes.data || [];
  if (!ik()) return verlaat(S.eersteLaad ? null : 'Je zit niet meer aan deze tafel.');
  meldingen(nieuweBesch);
  S.besch = nieuweBesch;
  ls.set('sessie', { sid, code: S.sessie.code });
  if (S.sessie.status === 'spel' && (!S.missie || vorig.status !== 'spel' || vorig.ontm !== ik().ontmaskerd || vorig.als !== ik().id)) await laadMissie();
  if (['onthulling', 'einde'].includes(S.sessie.status) && (!S.onthulling || vorig.status !== S.sessie.status)) {
    try { S.onthulling = await rpc('onthulling_data', { p_sessie: sid }); } catch (e) { console.warn(e); }
  }
  if (S.sessie.status === 'onthulling' && vorig.stap !== `${S.sessie.onthul_index}${S.sessie.onthul_stap}` && S.sessie.onthul_stap === 'missie' && isHost()) {
    const d = huidig().data; feest(d && (d.voltooid && !d.ontmaskerd));
  }
  if (S.sessie.status === 'spel' && vorig.status === 'lobby') { S.uitlegStap = 0; S.envelop = 'dicht'; }
  S.eersteLaad = false;
  render();
}
let laadtBezig = null, nogEens = false;
function laadNu() {
  if (laadtBezig) { nogEens = true; return laadtBezig; }
  laadtBezig = laadAlles().catch(console.warn).finally(() => { laadtBezig = null; if (nogEens) { nogEens = false; laadNu(); } });
  return laadtBezig;
}
const planLaad = () => { clearTimeout(laadTimer); laadTimer = setTimeout(laadNu, 120); };
async function laadMissie() { try { S.missie = await rpc('mijn_missie', { p_sessie: S.sid }); } catch (e) { S.fout = foutTekst(e); } }

function meldingen(nieuw) {
  const me = ik(); if (!me) return;
  const key = 'gezien.' + S.sid;
  if (!S.gezien.size) (ls.get(key, []) || []).forEach((x) => S.gezien.add(x));
  const oud = new Map(S.besch.map((b) => [b.id, b]));
  for (const b of nieuw) {
    const was = oud.get(b.id);
    if (b.status === 'open') {
      if (!S.gezien.has(b.id) && b.beschuldigde_id !== me.id && !doetMee(b.id) && !S.eersteLaad && !S.sheet) { S.sheet = { type: 'melding', id: b.id }; tril(120); }
      if (b.beschuldigde_id === me.id && !S.gezien.has(b.id)) tril([200, 100, 200]);
      S.gezien.add(b.id);
    } else if (was && was.status === 'open' && b.status !== 'vervallen' && !S.gezien.has(b.id + ':uit')) {
      const d = S.deel.filter((x) => x.beschuldiging_id === b.id);
      const wie = b.beschuldigde_id === me.id ? 'Jij' : naam(b.beschuldigde_id);
      S.uitslag = {
        id: b.id, goed: b.status === 'toegegeven',
        titel: b.status === 'toegegeven' ? `${wie} ${b.beschuldigde_id === me.id ? 'bent' : 'is'} betrapt!` : `${wie}: Mooi niet!`,
        sub: b.status === 'toegegeven' ? 'Het klopte. De opdracht is mislukt.' : b.door_host ? 'Gesloten door de host. Er wordt gewoon doorgespeeld.' : 'Er wordt gewoon doorgespeeld. Bij de onthulling komt dit terug.',
        rijen: d.sort((x, y) => (x.rol === 'eerste' ? -1 : 1)).map((x) => ({ naam: x.speler_id === me.id ? 'Jij' : naam(x.speler_id), rol: x.rol === 'eerste' ? 'betrapper' : 'zag het ook', pt: x.punten })),
      };
      clearTimeout(meldingen.t); meldingen.t = setTimeout(() => { S.uitslag = null; render(); }, 6000);
      if (S.sheet && ['melding', 'open-besch'].includes(S.sheet.type) && S.sheet.id === b.id) S.sheet = null;
    }
    if (b.status !== 'open') S.gezien.add(b.id + ':uit');
  }
  ls.set(key, [...S.gezien].slice(-300));
}

function abonneer() {
  if (kanaal) sb.removeChannel(kanaal);
  const sid = S.sid, f = `sessie_id=eq.${sid}`;
  kanaal = sb.channel('sessie-' + sid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessies', filter: `id=eq.${sid}` }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'spelers', filter: f }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'beschuldigingen', filter: f }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deelnames', filter: f }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stemrondes', filter: f }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'overnames', filter: f }, planLaad)
    .subscribe((st) => { if (st === 'SUBSCRIBED') planLaad(); });
}
async function ping() {
  if (!S.sid) return;
  try {
    const t0 = Date.now(), r = await rpc('ping', { p_sessie: S.sid }), t1 = Date.now(), rtt = t1 - t0;
    if (r?.weg) return planLaad();
    if (r?.nu && (rtt < (S.besteRtt ?? Infinity) || rtt < 400)) { S.besteRtt = Math.min(rtt, S.besteRtt ?? Infinity); S.offset = new Date(r.nu).getTime() - (t0 + t1) / 2; }
  } catch (e) { if (String(e.message).includes('geen_speler')) planLaad(); }
}
async function betreed(sid) {
  S.sid = sid; S.sessie = null; S.missie = null; S.onthulling = null; S.besch = []; S.gezien = new Set(); S.eersteLaad = true;
  S.view = 'sessie'; S.tab = 'missie'; S.fout = null; S.uitlegStap = 0; S.envelop = 'dicht';
  render(); abonneer(); await ping(); await laadNu();
  clearInterval(pingTimer); pingTimer = setInterval(ping, 25000);
}
function verlaat(msg) {
  if (kanaal) { sb.removeChannel(kanaal); kanaal = null; }
  clearInterval(pingTimer); ls.del('sessie');
  S.sid = null; S.sessie = null; S.missie = null; S.onthulling = null; S.sheet = null; S.uitslag = null; S.spelers = []; S.besch = [];
  S.fout = msg || null; S.view = msg ? 'weg' : 'home';
  render();
}

// ---------- feest bij onthulling ----------
function feest(groot) {
  const kleuren = ['#E9C774', '#FBF3E4', '#B3262E', '#1F5C45', '#F5DDA0'];
  const box = document.createElement('div'); box.className = 'confetti';
  for (let i = 0; i < (groot ? 90 : 30); i++) {
    const c = document.createElement('i');
    c.style.left = Math.random() * 100 + '%'; c.style.background = kleuren[i % kleuren.length];
    c.style.animationDuration = 2 + Math.random() * 2 + 's'; c.style.animationDelay = Math.random() * 0.6 + 's';
    box.appendChild(c);
  }
  document.body.appendChild(box); setTimeout(() => box.remove(), 5000);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    (groot ? [523.25, 659.25, 783.99, 1046.5] : [392, 523.25]).forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.12;
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.7);
    });
  } catch {}
}

// ---------- acties ----------
async function doe(fn) {
  if (S.bezig) return;
  S.bezig = true; S.fout = null; render();
  try { await fn(); } catch (e) { S.fout = foutTekst(e); console.warn(e); if (!S.sheet && S.view === 'sessie' && S.sessie?.status !== 'lobby') toast(S.fout); }
  finally { S.bezig = false; render(); }
}
const ACTIES = {
  view: (el) => { S.fout = null; S.view = el.dataset.v; },
  speluitleg: () => { S.terug = S.view; S.view = 'speluitleg'; },
  'speluitleg-terug': () => { S.view = S.terug || 'home'; },
  'naar-home': () => verlaat(),
  set: (el) => { S.form[el.dataset.k] = el.dataset.val; },
  ctx: (el) => { const c = S.form.context, v = el.dataset.val; S.form.context = c.includes(v) ? c.filter((x) => x !== v) : [...c, v]; },
  punten: () => { S.form.punten = !S.form.punten; },
  installeer: async () => { const p = S.installPrompt; S.installPrompt = null; p?.prompt(); },
  maak: () => doe(async () => {
    const f = S.form;
    if (!f.hostNaam.trim()) throw new Error('naam_leeg');
    ls.set('naam', f.hostNaam.trim());
    const r = await rpc('maak_sessie', { p_naam: f.naam || null, p_host_naam: f.hostNaam, p_thema: f.thema, p_moeilijkheid: f.moeilijkheid, p_context: f.context, p_punten: f.punten });
    await betreed(r.sessie_id);
  }),
  join: () => joinMet(null),
  'join-nieuw': () => { S.sheet = null; joinMet('nieuw'); },
  'join-overname': () => { S.sheet = null; joinMet('overname'); },
  'overname-stop': () => { ls.del('overname'); S.overname = null; S.view = 'deelnemen'; },
  scan: () => startScan(),
  stopscan: () => stopScan(),
  'uitleg-volgende': () => { S.uitlegStap++; window.scrollTo(0, 0); },
  'uitleg-klaar': () => { S.uitlegStap = 3; S.envelop = 'dicht'; window.scrollTo(0, 0); },
  zegel: () => { if (S.envelop !== 'dicht') return; S.envelop = 'open'; tril(60); setTimeout(() => { S.envelop = 'donker'; render(); }, 1700); },
  'naar-missie': () => { ls.set(ceremonieKey(), true); S.tab = 'missie'; },
  start: () => doe(() => rpc('start_spel', { p_sessie: S.sid })),
  tab: (el) => { S.tab = el.dataset.v; S.fout = null; window.scrollTo(0, 0); },
  voltooid: () => { S.sheet = { type: 'voltooid', getuige: null }; },
  getuige: (el) => { S.sheet.getuige = S.sheet.getuige === el.dataset.id ? null : el.dataset.id; },
  'voltooid-ok': () => doe(async () => { await rpc('markeer_voltooid', { p_sessie: S.sid, p_getuige: S.sheet.getuige }); S.sheet = null; await laadMissie(); }),
  'voltooid-ongedaan': () => doe(async () => { await rpc('markeer_voltooid', { p_sessie: S.sid, p_getuige: null, p_ongedaan: true }); await laadMissie(); }),
  joker: () => { S.sheet = { type: 'joker' }; },
  'joker-ok': () => doe(async () => { await rpc('gebruik_joker', { p_sessie: S.sid }); S.sheet = null; await laadMissie(); toast('Nieuwe opdracht', 'Houd je kaart vast om hem te lezen.', 3500); }),
  beschuldig: (el) => { S.sheet = { type: 'beschuldig', id: el.dataset.id }; },
  'beschuldig-ok': (el) => doe(async () => { const r = await rpc('beschuldig', { p_sessie: S.sid, p_beschuldigde: el.dataset.id }); await laadNu(); S.sheet = { type: 'open-besch', id: r.beschuldiging_id }; }),
  meedoen: (el) => doe(async () => { await rpc('meedoen', { p_beschuldiging: el.dataset.id }); await laadNu(); S.sheet = { type: 'open-besch', id: el.dataset.id }; }),
  'open-besch': (el) => { S.sheet = { type: 'open-besch', id: el.dataset.id }; },
  reageer: (el) => doe(async () => { await rpc('reageer', { p_beschuldiging: el.dataset.id, p_toegeven: el.dataset.val === 'ja' }); await laadNu(); }),
  'host-sluit': (el) => doe(() => rpc('host_sluit_beschuldiging', { p_beschuldiging: el.dataset.id })),
  spelermenu: (el) => { S.sheet = { type: 'spelermenu', id: el.dataset.id }; },
  verwijder: (el) => doe(async () => { await rpc('host_verwijder', { p_speler: el.dataset.id }); S.sheet = null; }),
  'extra-joker': (el) => doe(async () => { await rpc('host_extra_joker', { p_speler: el.dataset.id }); S.sheet = null; toast('Wissel gegeven', `${naam(el.dataset.id)} kan nu een andere opdracht kiezen.`, 3000); }),
  'overname-ja': (el) => doe(() => rpc('host_overname', { p_overname: el.dataset.id, p_akkoord: true })),
  'overname-nee': (el) => doe(() => rpc('host_overname', { p_overname: el.dataset.id, p_akkoord: false })),
  'melding-weg': () => doe(() => rpc('host_melding_weg', { p_sessie: S.sid })),
  beeindig: () => { S.sheet = { type: 'beeindig' }; },
  annuleer: () => { S.sheet = { type: 'annuleer' }; },
  'annuleer-ok': () => doe(async () => { await rpc('annuleer_sessie', { p_sessie: S.sid }); S.sheet = null; verlaat(); }),
  verlaat: () => { S.sheet = { type: 'verlaat' }; },
  'verlaat-ok': () => doe(async () => { await rpc('verlaat_sessie', { p_sessie: S.sid }); S.sheet = null; verlaat(); }),
  'beeindig-ok': () => doe(async () => { await rpc('beeindig_spel', { p_sessie: S.sid }); S.sheet = null; }),
  'onthul-volgende': () => doe(() => rpc('onthul_stap', { p_sessie: S.sid, p_vooruit: true })),
  'onthul-vorige': () => doe(() => rpc('onthul_stap', { p_sessie: S.sid, p_vooruit: false })),
  stem: (el) => doe(async () => { const v = stemVraag(); if (!v) return; await rpc('stem', { p_sessie: S.sid, p_speler: huidig().id, p_keuze: el.dataset.val, p_beschuldiging: v.besch }); await laadNu(); }),
  scorebord: () => doe(() => rpc('naar_scorebord', { p_sessie: S.sid })),
  'missies-terug': () => { S.sheet = { type: 'missies' }; },
  'test-als': (el) => doe(async () => {
    if (el.dataset.id === ik()?.id) return;
    await rpc('test_wissel', { p_sessie: S.sid, p_speler: el.dataset.id });
    S.sheet = null; S.uitslag = null; S.missie = null; S.eersteLaad = true; S.gezien = new Set(); S.tab = 'missie';
    if (S.vasthouden) toonMissie(false);
    await laadNu();
    const me = ik(), b = openBesch().find((x) => x.beschuldigde_id !== me?.id && !doetMee(x.id));
    if (b && S.sessie.status === 'spel') S.sheet = { type: 'melding', id: b.id };
  }),
  'sheet-dicht': () => { S.sheet = null; S.fout = null; },
  scrim: (el, ev) => { if (ev.target === el && S.sheet?.type !== 'naambestaat') { S.sheet = null; S.fout = null; } },
  'uitslag-dicht': () => { S.uitslag = null; },
  toast: (el) => { S.toasts = S.toasts.filter((t) => t.id !== el.dataset.id); },
};

async function joinMet(keuze) {
  await doe(async () => {
    const f = S.form;
    if (f.code.replace(/\s/g, '').length !== 4) throw new Error('code_kort');
    if (!f.spelerNaam.trim()) throw new Error('naam_leeg');
    ls.set('naam', f.spelerNaam.trim());
    const r = await rpc('join_sessie', { p_code: f.code, p_naam: f.spelerNaam, p_keuze: keuze });
    if (r.status === 'naam_bestaat') { S.sheet = { type: 'naambestaat', naam: r.naam }; return; }
    if (r.status === 'overname_aangevraagd') { S.overname = { id: r.overname_id, naam: f.spelerNaam.trim() }; ls.set('overname', S.overname); S.view = 'overname'; wachtOpOvername(); return; }
    await betreed(r.sessie_id);
  });
}
async function wachtOpOvername() {
  while (S.view === 'overname' && S.overname) {
    try {
      const r = await rpc('overname_check', { p_overname: S.overname.id });
      if (r.status === 'goed') { ls.del('overname'); S.overname = null; ls.set('ceremonie.' + r.sessie_id, true); return betreed(r.sessie_id); }
      if (r.status === 'geweigerd') { ls.del('overname'); S.overname = null; S.view = 'deelnemen'; S.fout = 'De host heeft het niet bevestigd.'; return render(); }
    } catch (e) { ls.del('overname'); S.overname = null; S.view = 'deelnemen'; S.fout = foutTekst(e); return render(); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

let scanStream = null;
async function startScan() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) { toast('Open de camera-app van je telefoon', 'Richt hem op de QR-code; die opent de app met de code al ingevuld.', 5000); return; }
  try { scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { toast('Geen toegang tot de camera', 'Typ de code dan over.'); return; }
  S.scannen = true; render();
  const v = document.getElementById('scan'); v.srcObject = scanStream; await v.play().catch(() => {});
  const det = new window.BarcodeDetector({ formats: ['qr_code'] });
  const loop = async () => {
    if (!S.scannen) return;
    try { const raw = (await det.detect(v))[0]?.rawValue; const m = raw && (raw.match(/[?&]code=([A-Za-z]{4})/) || raw.match(/^([A-Za-z]{4})$/)); if (m) { S.form.code = m[1].toUpperCase(); stopScan(); return; } } catch {}
    requestAnimationFrame(loop);
  };
  loop();
}
function stopScan() { S.scannen = false; scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; render(); }

// ---------- events ----------
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = ACTIES[el.dataset.a]; if (!fn) return;
  if (['scrim', 'uitslag-dicht'].includes(el.dataset.a) && el.classList.contains('uitslag') && ev.target !== el) return;
  if (el.dataset.a === 'scrim' && ev.target !== el) return;
  const r = fn(el, ev);
  if (!(r instanceof Promise)) render();
});
document.addEventListener('keydown', (ev) => {
  const el = ev.target;
  if ((ev.key === 'Enter' || ev.key === ' ') && el.matches?.('[role="button"][data-a]')) { ev.preventDefault(); el.click(); }
  if (el.dataset?.code != null && ev.key === 'Backspace' && !el.value) { const i = Number(el.dataset.code); if (i > 0) document.getElementById('c' + (i - 1))?.focus(); }
  if (ev.key === 'Enter' && S.view === 'deelnemen' && el.matches('input')) ACTIES.join();
  if (ev.key === 'Enter' && S.view === 'nieuw' && el.matches('input')) ACTIES.maak();
});
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.f) { S.form[el.dataset.f] = el.value; return; }
  if (el.dataset.code != null) {
    const i = Number(el.dataset.code), v = el.value.toUpperCase().replace(/[^A-Z]/g, '');
    const arr = (S.form.code + '    ').slice(0, 4).split('');
    if (v.length > 1) v.slice(0, 4 - i).split('').forEach((c, j) => (arr[i + j] = c)); else arr[i] = v || ' ';
    S.form.code = arr.join('').replace(/\s+$/, '');
    document.querySelectorAll('[data-code]').forEach((b, j) => (b.value = (arr[j] || '').trim()));
    if (v && i < 3) document.getElementById('c' + Math.min(3, i + v.length))?.focus();
  }
});
// Geen browsermenu's (Chrome-zoekbalk, delen, kopiëren) buiten invoervelden
document.addEventListener('contextmenu', (ev) => { if (!ev.target.closest('input, textarea')) ev.preventDefault(); });
document.addEventListener('selectstart', (ev) => { if (!ev.target.closest?.('input, textarea')) ev.preventDefault(); });
document.addEventListener('dragstart', (ev) => ev.preventDefault());

// Vasthouden om de missie te tonen (max. 5 seconden)
const VASTHOUD = '#missiekaart, #checkmissie';
function toonMissie(aan) {
  clearTimeout(leesTimer);
  S.vasthouden = aan;
  document.querySelectorAll(VASTHOUD).forEach((k) => k.classList.toggle('toon', aan));
  document.getElementById('missiewrap')?.classList.toggle('toon-dim', aan);
  if (aan) leesTimer = setTimeout(() => toonMissie(false), LEESTIJD);
  if (!aan && S.renderWacht) { S.renderWacht = false; render(); }
}
document.addEventListener('pointerdown', (ev) => { if (ev.target.closest(VASTHOUD)) { ev.preventDefault(); toonMissie(true); } });
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => { if (S.vasthouden) toonMissie(false); }));
document.addEventListener('keydown', (ev) => { if (ev.target.matches?.(VASTHOUD) && (ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) { ev.preventDefault(); toonMissie(true); } });
document.addEventListener('keyup', (ev) => { if (ev.target.matches?.(VASTHOUD)) toonMissie(false); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { if (S.vasthouden) toonMissie(false); } else if (S.sid) { ping(); planLaad(); } });
window.addEventListener('blur', () => { if (S.vasthouden) toonMissie(false); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (S.view === 'home') render(); });

// ---------- opstarten ----------
async function start() {
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const p = new URLSearchParams(location.search);
  if (p.get('code')) { S.form.code = p.get('code').toUpperCase().slice(0, 4); history.replaceState(null, '', location.pathname); }
  S.form.spelerNaam = S.form.hostNaam = ls.get('naam', '') || '';
  if (!CFG.supabaseUrl || CFG.supabaseUrl.includes('VUL_IN')) { $app.innerHTML = `<main class="screen"><div class="center-msg"><h2>Nog niet ingesteld</h2><p>Vul in config.js de Supabase-URL en de anon key in.</p></div></main>`; return; }
  try {
    const { createClient } = window.__supabaseMock || (await import(SUPABASE_ESM));
    sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ta.auth' } });
    let { data } = await sb.auth.getSession();
    if (!data.session) { const r = await sb.auth.signInAnonymously(); if (r.error) throw r.error; data = r.data; }
    uid = data.session?.user?.id || data.user?.id;
  } catch (e) { console.error(e); S.view = 'home'; S.fout = 'Geen verbinding met de server. Check je internet en herlaad de app.'; return render(); }
  const oudOvername = ls.get('overname'), oud = ls.get('sessie');
  if (oudOvername) { S.overname = oudOvername; S.view = 'overname'; render(); return wachtOpOvername(); }
  if (oud?.sid) { try { await betreed(oud.sid); return; } catch { ls.del('sessie'); } }
  S.view = S.form.code ? 'deelnemen' : 'home';
  render();
}
start();
