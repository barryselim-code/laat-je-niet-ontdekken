// Betrapt! – PWA (vanilla JS, geen build-stap)
const CFG = window.TAFELAGENT_CONFIG || {};
const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const HOST_SLUIT = 120;    // host kan een betrapping zonder antwoord na 2 minuten sluiten
const SPELDUUR = 45 * 60 * 1000;   // W8: een spel duurt maximaal 45 minuten
const HERINNER = 15000;    // W5: betrapte trilt elke 15 s tot hij kiest
const LEESTIJD = 5000;     // missie verdwijnt na 5 s vasthouden
const $app = document.getElementById('app');

let sb = null, uid = null, kanaal = null, pingTimer = null, tikTimer = null, laadTimer = null, leesTimer = null;

const S = {
  view: 'laden', terug: 'home', fout: null, bezig: false,
  form: { naam: '', hostNaam: '', thema: 'kerst', moeilijkheid: 'gemengd', context: ['eten', 'drinken', 'gastheer', 'versiering'], soorten: ['praten', 'sturen', 'doen'], punten: true, code: '', spelerNaam: '' },
  sid: null, sessie: null, spelers: [], besch: [], deel: [], overnames: [], bevestig: null,
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
const ceremonieKey = () => 'ceremonie.' + S.sid + '.' + (S.sessie?.ronde || 1);
const heeftCeremonie = () => !!(ls.get(ceremonieKey()) || ls.get('ceremonie.' + S.sid + '.alle'));
const echteIk = () => S.spelers.find((p) => p.user_id === uid && !p.verwijderd);
const testEigenaar = () => !!S.sessie?.test && S.sessie.test_eigenaar === uid;
const ik = () => (testEigenaar() && S.sessie.test_als && S.spelers.find((p) => p.id === S.sessie.test_als && !p.verwijderd)) || echteIk();
const speler = (id) => S.spelers.find((p) => p.id === id);
const naam = (id) => speler(id)?.naam ?? 'Iemand';
const isHost = () => S.sessie && ik() && S.sessie.host_id === ik().id;
const echteHost = () => !!S.sessie && (testEigenaar() || S.sessie.host_id === echteIk()?.id);
const actief = () => S.spelers.filter((p) => !p.verwijderd);
const speltijdEind = () => (S.sessie?.gestart_op ? new Date(S.sessie.gestart_op).getTime() + SPELDUUR : null);
// W11: punten volgens hoe snel je je opdracht flikt (gelijk aan geheim.tijdpunten in de database)
const tijdpunten = (van, tot) => { const m = Math.floor((tot - van) / 60000); return m <= 10 ? 10 : m <= 20 ? 8 : m <= 30 ? 6 : m <= 40 ? 5 : 4; };
const deelnemers = (bid) => S.deel.filter((d) => d.beschuldiging_id === bid).sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));
const doetMee = (bid) => !!ik() && S.deel.some((d) => d.beschuldiging_id === bid && d.speler_id === ik().id);
const openBesch = () => S.besch.filter((b) => b.status === 'open');
const plural = (n, een, meer) => `${n} ${n === 1 ? een : meer}`;
const tijd = (t) => t ? new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : '';
const namenLijst = (arr) => arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' en ' + arr[arr.length - 1];
const MOEIL = ['', 'Makkelijk', 'Normaal', 'Moeilijk'];
const RISICO = ['', 'LAAG', 'MIDDEL', 'HOOG'];
const dossierNr = (id) => String(1000 + (parseInt(String(id || '0').replace(/[^0-9a-f]/gi, '').slice(0, 7) || '0', 16) % 9000));
const risico = (n, w = 34, h = 10) => `<span class="risico" role="img" aria-label="Risico: ${(RISICO[n] || '').toLowerCase()}">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'aan' : ''}" style="width:${w}px;height:${h}px"></i>`).join('')}</span>`;
const CLIP = '<svg class="ds-clip" width="26" height="64" viewBox="0 0 26 64" aria-hidden="true"><path d="M8 8 V50 a5 5 0 0 0 10 0 V12 a8 8 0 0 0 -16 0 V46" fill="none" stroke="#8C877C" stroke-width="2.6" stroke-linecap="round"/></svg>';
const STEMPELKLEUR = { GEFLIKT: '#2F7D52', BETRAPT: '#C2372C', ONGEZIEN: '#2F4F9A' };
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
  nog_wachten: 'Nog even wachten.',
  niet_voltooid: 'Flik eerst je huidige opdracht.',
  eerst_reageren: 'Je bent betrapt: kies eerst Je hebt me! of Mooi niet!',
  spel_loopt_nog: 'Het spel loopt nog.',
  ongeldig_abonnement: 'Meldingen konden niet worden aangezet.',
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
  bel: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  belUit: svg('<path d="M6 8a6 6 0 0 1 9.3-5M18 8c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20"/>', 2),
  verbod: svg('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
  klok: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>'),
  oog: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  map: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  tik: svg('<path d="M9 11V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V9a1.5 1.5 0 0 1 3 0v2"/><path d="M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L5 16.5a1.5 1.5 0 0 1 2.3-2L9 16V11"/>'),
};
const LOGO = `<svg class="logo" viewBox="0 0 100 100" role="img" aria-label="Logo: dossiermap met een rode stempel BETRAPT!">
<defs>
<linearGradient id="b-kraft" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8CB92"/><stop offset="1" stop-color="#C9A464"/></linearGradient>
<linearGradient id="b-kraftd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9A464"/><stop offset="1" stop-color="#A9844A"/></linearGradient>
<filter id="b-sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#2A1A14" flood-opacity="0.35"/></filter>
</defs>
<g transform="translate(50 56) scale(1.06) translate(-50 -56)">
<g transform="rotate(5 50 56)" filter="url(#b-sh)">
<path d="M14 31 a4 4 0 0 1 4 -4 h19 l5 5 h40 a4 4 0 0 1 4 4 v43 a4 4 0 0 1 -4 4 h-64 a4 4 0 0 1 -4 -4z" fill="url(#b-kraftd)"/>
<rect x="21" y="25" width="57" height="40" rx="2" fill="#F6F0E4"/>
<path d="M26 31.5 H70 M26 37.5 H62" stroke="#CFC5B3" stroke-width="2.2" stroke-linecap="round"/>
<rect x="13" y="40" width="74" height="46" rx="4" fill="url(#b-kraft)"/>
<path d="M14 41 H86" stroke="#F4E2B8" stroke-width="1" opacity="0.9"/>
</g>
<g transform="rotate(-12 50 63)" fill="#C2302A">
<rect x="12" y="51" width="76" height="24" rx="5" fill="none" stroke="#C2302A" stroke-width="3.2"/>
<rect x="15.6" y="54.6" width="68.8" height="16.8" rx="3" fill="none" stroke="#C2302A" stroke-width="1"/>
<path transform="translate(18.000 68.142) scale(0.006002 0.006902)" d="M116 0H780C1110 0 1297 -176 1297 -416C1297 -632 1141 -767 962 -774V-790C1124 -823 1239 -941 1239 -1112C1239 -1337 1067 -1490 734 -1490H116ZM469 -285V-647H704C843 -647 929 -572 929 -456C929 -350 855 -285 697 -285ZM469 -876V-1208H680C802 -1208 879 -1145 879 -1045C879 -938 793 -876 674 -876ZM1517 0H2550V-288H1870V-612H2497V-894H1870V-1202H2551V-1490H1517ZM2756 -1202H3207V0H3559V-1202H4010V-1490H2756ZM4232 0H4585V-513H4777L5050 0H5437L5126 -569C5291 -643 5385 -789 5385 -995C5385 -1299 5178 -1490 4842 -1490H4232ZM4585 -792V-1204H4767C4933 -1204 5019 -1134 5019 -995C5019 -856 4933 -792 4768 -792ZM5559 0H5951L6048 -317H6544L6645 0H7041L6529 -1490H6056ZM6131 -587 6151 -651C6200 -820 6244 -1008 6289 -1209C6337 -1009 6386 -821 6438 -651L6458 -587ZM7244 0H7597V-465H7844C8186 -465 8397 -668 8397 -975C8397 -1280 8190 -1490 7854 -1490H7244ZM7597 -744V-1204H7779C7945 -1204 8031 -1115 8031 -975C8031 -837 7945 -744 7780 -744ZM8569 -1202H9020V0H9372V-1202H9823V-1490H8569ZM10136 -469H10456L10482 -1490H10110ZM10296 21C10413 21 10491 -51 10491 -162C10491 -274 10413 -346 10296 -346C10179 -346 10101 -274 10101 -162C10101 -51 10179 21 10296 21Z"/>
</g>
</g>
</svg>`;


// ---------- render ----------
function render() {
  if (S.vasthouden || S.envAnim) { S.renderWacht = true; return; }
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
  const ctx = [['eten', 'Er wordt gegeten'], ['drinken', 'Er wordt gedronken'], ['gastheer', 'Er is een gastheer of -vrouw'], ['kinderen', 'Kinderen aan tafel'], ...(f.thema === 'kerst' ? [['versiering', 'Kerstversiering op tafel']] : [])];
  const soorten = [['praten', 'Praten', 'gesprek sturen, woorden gebruiken'], ['sturen', 'Sturen', 'een ander iets laten zeggen of doen'], ['doen', 'Doen', 'gedrag en spullen op tafel']];
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
      <div class="field"><span class="label">Soort opdrachten</span><div class="chips">${soorten.map(([k, t]) => `<button class="chip" data-a="soort" data-val="${k}" aria-pressed="${pr(f.soorten.includes(k))}">${t}</button>`).join('')}</div>
        <span class="hint">${soorten.filter(([k]) => f.soorten.includes(k)).map(([, t, u]) => `${t}: ${u}`).join(' · ')}</span></div>
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

const PUNTEN = [['Opdracht geflikt binnen 10 min', '+10'], ['… binnen 20 min', '+8'], ['… binnen 30 min', '+6'], ['… binnen 40 min', '+5'], ['… daarna', '+4'],
  ['Jij riep Betrapt!, klopt', '+5'], ['Jij zag het ook!, klopt', '+2'], ['Jij riep Betrapt!, klopt niet', '−2 (elke volgende keer 1 meer, tot −5)'],
  ['Jij zag het ook!, klopt niet', '−1'], ['Betrapt op je opdracht', '0 voor die opdracht']];
// W14: wat niet mag, met de reden erbij
const VERBODEN = [
  ['Nepopdrachten doen om anderen op het verkeerde been te zetten', 'dan klopt geen enkele betrapping meer en wordt raden zinloos.'],
  ['Op elkaars scherm kijken', 'je opdracht is alleen voor jou; wie meekijkt, maakt het spel kapot.'],
  ['Vertellen wat je opdracht is zonder dat je terecht betrapt bent', 'dan kan niemand je meer eerlijk betrappen.'],
  ['Bewust saboteren, zoals dingen van tafel halen', 'iedereen moet zijn opdracht kunnen doen.'],
  ['Je opdracht uitvoeren tijdens een Betrapt!-discussie', 'dan let iedereen op het gesprek en is het geen kunst meer.'],
];
const verbodenLijst = () => `<ul class="verboden">${VERBODEN.map(([a, b]) => `<li><b>${a}</b>: ${b}</li>`).join('')}</ul>`;
// Puntenstelsel (gelijk aan de database): tijdstaffel en betrap-punten
const TIJDSTAFFEL = [['10', '0–10 min'], ['8', '11–20'], ['6', '21–30'], ['5', '31–40'], ['4', 'later']];
const BETRAPPUNTEN = [['Jij riep als eerste Betrapt! en het klopt', '+5', 'plus'], ['Jij zag het ook en het klopt', '+2', 'plus'],
  ['Jij riep als eerste Betrapt! en het klopt niet', '−2', 'min'], ['… en daarna elke foute Betrapt! 1 meer', 'tot −5', 'min'],
  ['Jij zag het ook en het klopt niet', '−1', 'min'], ['Jij bent betrapt', '0 voor die opdracht', 'nul']];
const DOE_VERBODEN = [
  ['Nepopdrachten doen', 'Expres iets geks doen om anderen op het verkeerde spoor te zetten maakt betrappen een gok. Het spel draait om echte opdrachten.'],
  ['Op elkaars scherm kijken', 'Je opdracht is alleen voor jou. Wie meekijkt, weet het antwoord al en verpest het voor de ander.'],
  ['Je opdracht verklappen', 'Vertel pas wat je opdracht is als je terecht betrapt bent. Anders weet de hele tafel het zonder dat iemand het heeft verdiend.'],
  ['Bewust saboteren', 'Dingen van tafel halen of iemand expres dwarszitten zodat zijn opdracht niet lukt, is geen spel meer maar pesten.'],
  ['Je opdracht doen tijdens een betrapping', 'Als iedereen even op één persoon let, is het te makkelijk om ongezien je eigen opdracht te doen. Wacht tot de rust terug is.'],
];
const staffelHtml = () => `<div class="staffel">${TIJDSTAFFEL.map(([p, m]) => `<div><b>${p}</b><span>${m}</span></div>`).join('')}</div>`;
const betrapTabel = () => `<div class="ptabel">${BETRAPPUNTEN.map(([a, b, k]) => `<div><span>${a}</span><b class="${k}">${b}</b></div>`).join('')}</div>`;

function vSpeluitleg() {
  const stappen = [
    ['Lees je dossier.', 'Houd het vast om je opdracht te zien. Bevalt hij niet? In de eerste 10 minuten mag je hem één keer ruilen.'],
    ['Flik het stiekem.', 'Gelukt zonder dat iemand iets merkte? Tik op Geflikt! en kies wie het zagen gebeuren. Daarna mag je een nieuwe opdracht pakken.'],
    ['Betrap de anderen.', 'Zie je iemand bezig? Tik op Betrapt! onder zijn naam en zeg hardop wat je denkt dat hij doet. Wie het ook zag, tikt op Ik zag het ook!'],
    ['Eerlijk antwoorden.', 'Ben jij betrapt? Kies Je hebt me! of Mooi niet!. Bij de onthulling ziet iedereen je echte opdracht, dus liegen valt op. De host kan een Mooi niet! dan alsnog op Betrapt! zetten.'],
    ['De onthulling.', 'Na 45 minuten, of zodra iedereen betrapt is, gaan alle dossiers open. De host kan het spel ook eerder stoppen.'],
  ];
  return `<main class="screen">
    <div class="kop-terug"><button class="iconbtn" data-a="speluitleg-terug" aria-label="Sluiten">${I.terug}</button></div>
    <article class="speluitleg">
      <h1>Zo speel je Betrapt!</h1>
      <p>Iedereen aan tafel krijgt een geheime opdracht: iets wat je moet doen of zeggen. Doe het zonder dat iemand het doorheeft, dan scoor je punten. Zie je een ander iets vreemds doen? Roep hem eruit. Wie aan het eind de meeste punten heeft, is de sluwste van de tafel.</p>
      <h2>Zo gaat een ronde</h2>
      <ol class="stappen">${stappen.map(([k, t], i) => `<li><span class="nr">${i + 1}</span><span><b>${k}</b> ${t}</span></li>`).join('')}</ol>
      <h2>Wanneer ben je echt betrapt?</h2>
      <p>Als iemand de kern van je opdracht raadt. Het hoeft niet woord voor woord te kloppen.</p>
      <div class="vb"><span>Opdracht: “Leg mes en vork omgewisseld tot het eerste gerecht op je bord ligt.”</span><span>Iemand zegt: “Jouw vork ligt aan de verkeerde kant!” Dan ben je betrapt.</span></div>
      <h2>Punten</h2>
      <p>Hoe sneller je je opdracht flikt, hoe meer hij waard is. De tijd loopt vanaf het moment dat je hem kreeg.</p>
      ${staffelHtml()}
      <p>Betrappen levert punten op als je gelijk hebt. Gokken kost punten, en hoe vaker je mis zit, hoe meer.</p>
      ${betrapTabel()}
      <h2>Niet toegestaan</h2>
      <div class="verboden">${DOE_VERBODEN.map(([w, r]) => `<div><b>${w}</b><span>${r}</span></div>`).join('')}</div>
    </article></main>`;
}

// ----- in een sessie -----
function vSessie() {
  const s = S.sessie;
  if (!s) return vLaden();
  if (s.status === 'lobby') return toestemmingVragen() ? vToestemming() : vLobby();
  if (s.status === 'spel') {
    if (!heeftCeremonie()) return S.uitlegStap < 5 ? vUitleg() : vEnvelop();
    return vSpel();
  }
  if (s.status === 'onthulling') return isHost() ? vOnthullingHost() : vOnthullingSpeler();
  return vScorebord();
}

const toestemmingVragen = () => pushKan() && Notification.permission === 'default' && !ls.get('meldingen.gevraagd');
function vToestemming() {
  return `<main class="screen licht toestemming">
    <div class="ts-midden"><div class="ts-bel"><span class="ts-ico">${I.bel}</span><span class="ts-stempel">BETRAPT!</span></div>
      <h1>Mag Betrapt! je waarschuwen?</h1>
      <p>Roept iemand <b>Betrapt!</b>, dan trilt je telefoon en krijg je een melding, ook als hij op slot in je zak zit. Zo mis je geen enkele betrapping, en zeker niet die van jezelf.</p>
      <div class="ts-kaart"><span><b>Iemand betrapt een ander:</b> één trilling en een melding. Zag jij het ook? Dan tik je erop.</span>
        <span><b>Jij bent betrapt:</b> je telefoon trilt elke 15 seconden tot je kiest.</span></div></div>
    <div class="foot" style="padding:0 24px 32px"><button class="btn rood" data-a="meldingen-aan">Ja, waarschuw me</button>
      <button class="btn ghost klein" data-a="meldingen-later">Liever niet</button>
      <span class="ts-noot">Op een iPhone werkt dit alleen als Betrapt! op je beginscherm staat (Deel › Zet op beginscherm).</span></div></main>`;
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
  const i = S.uitlegStap, N = 5;
  const stapjes = `<div class="stapjes" aria-label="Stap ${i + 1} van ${N}">${Array.from({ length: N }, (_, j) => `<i class="${j === i ? 'aan' : ''}"></i>`).join('')}</div>`;
  const kop = `<div style="display:flex;align-items:center;justify-content:space-between;height:44px">${stapjes}${i < N - 1 ? `<button class="btn ghost klein" style="width:auto;padding:0 4px" data-a="uitleg-klaar">Overslaan</button>` : ''}</div>`;
  const kicker = `<span class="kicker" style="margin-top:8px">Zo werkt het · ${i + 1} van ${N}</span>`;
  const h1 = (t) => `<h1 class="titel-serif" style="font-size:32px;margin-top:6px">${t}</h1>`;
  const kaart = (ico, kop, tekst) => `<div class="uitleg-kaart"><span class="ico">${ico}</span><span><b>${kop}</b><span>${tekst}</span></span></div>`;
  let inhoud = '', knop = '';
  if (i === 0) {
    inhoud = `${kicker}${h1('Zo speel je Betrapt!')}
      <p class="uitleg-p">Iedereen aan tafel krijgt een geheime opdracht. Voer hem uit zonder dat iemand het doorheeft. Ondertussen let je goed op de anderen, want zij zijn ook stiekem bezig.</p>
      <div class="uitleg-kaarten">${kaart(I.map, 'Doe je opdracht stiekem', 'Gelukt zonder dat iemand het zag? Dan scoor je punten.')}
        ${kaart(I.oog, 'Betrap de anderen', 'Zie je iemand iets vreemds doen? Dan roep je Betrapt! en druk je op de knop.')}
        ${kaart(I.klok, '45 minuten', 'Daarna gaan alle dossiers open. Degene met de meeste punten wint.')}</div>`;
    knop = `<button class="btn rood" data-a="uitleg-volgende">Volgende: je opdracht</button>`;
  } else if (i === 1) {
    inhoud = `${kicker}${h1('Je opdracht')}
      <div class="mock"><div class="vak ds-mock"><span class="typ" style="font-size:11px;letter-spacing:1px;color:#B9AC92">DOSSIER 0427 · <span style="color:#C9483D">GEHEIM</span></span><span class="balk" style="width:80%;background:#3A3328"></span><span class="balk" style="width:60%;background:#3A3328"></span>
        <span style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:#D9CBB0;border-top:1px dashed #4A4234;padding-top:8px"><span style="width:16px;height:16px">${I.hand}</span>Houd hier vast om te lezen</span><span class="nr" style="position:absolute;right:-6px;top:-6px">1</span></div>
        <div class="knopjes twee-k"><span style="background:var(--goud);color:var(--op-goud)">Geflikt!<span class="nr">3</span></span><span>Andere opdracht<span class="nr">2</span></span></div></div>
      <ol class="punten-lijst"><li><span class="nr">1</span><span><b>Je opdracht lezen.</b> Houd je vinger op de strook onder het dossier. Zolang je vasthoudt, zie je je opdracht. Laat je los, dan is hij weer weg.</span></li>
        <li><span class="nr">2</span><span><b>Andere opdracht?</b> Lukt deze echt niet aan jouw tafel? In de eerste 10 minuten mag je één keer ruilen.</span></li>
        <li><span class="nr">3</span><span><b>Gelukt? Druk op Geflikt!</b> Kies daarna wie erbij waren. Zij staan bij de onthulling als getuigen bij je opdracht.</span></li>
        <li><span class="nr">4</span><span><b>Nog een?</b> Na Geflikt! kun je een nieuwe opdracht pakken. Dat mag, het hoeft niet.</span></li></ol>`;
    knop = `<button class="btn rood" data-a="uitleg-volgende">Volgende: betrappen</button>`;
  } else if (i === 2) {
    inhoud = `${kicker}${h1('Iemand betrappen')}
      <div class="mock"><div class="mock-tegels">
        <div><span class="i">J</span><span>Joris</span><span class="k1">Betrapt!</span><span class="nr">1</span></div>
        <div><span class="i">F</span><span>Fleur</span><span class="k2">Ik zag het ook!</span><span class="nr">2</span></div>
        <div><span class="i">M</span><span>Mehmet</span><span class="k1">Betrapt!</span></div></div>
        <div class="twee" style="position:relative"><span class="btn klein toegeven" style="height:38px;font-size:13px">Je hebt me!</span><span class="btn klein licht-knop" style="height:38px;font-size:13px">Mooi niet!</span><span class="nr" style="position:absolute;right:-6px;top:-8px">3</span></div></div>
      <ol class="punten-lijst"><li><span class="nr">1</span><span><b>Zie je iemand bezig?</b> Druk onder zijn naam op Betrapt! en zeg hardop wat je denkt dat hij doet.</span></li>
        <li><span class="nr">2</span><span><b>Zag jij het ook?</b> Iedereen krijgt een melding. Druk op Ik zag het ook! om mee te doen.</span></li>
        <li><span class="nr">3</span><span><b>De verdachte kiest.</b> Klopt het, dan zegt hij Je hebt me! en is zijn opdracht mislukt. Klopt het niet, dan zegt hij Mooi niet! en speelt hij door.</span></li></ol>
      <p class="uitleg-p klein">De kern raden is genoeg, het hoeft niet woord voor woord. En liegen heeft geen zin: bij de onthulling ziet iedereen je echte opdracht.</p>`;
    knop = `<button class="btn rood" data-a="uitleg-volgende">Volgende: punten</button>`;
  } else if (i === 3) {
    inhoud = `${kicker}${h1('Zo verdien je punten')}
      <b class="uitleg-sub">Je opdracht geflikt</b><span class="uitleg-p klein" style="margin:2px 0 0">Hoe sneller, hoe meer punten. De tijd loopt vanaf het moment dat je de opdracht kreeg.</span>
      ${staffelHtml()}
      <b class="uitleg-sub">Iemand betrappen</b>
      ${betrapTabel()}
      <p class="uitleg-p klein"><b>Zelf betrapt?</b> Dan levert die opdracht niets op en krijg je geen nieuwe meer. Betrappen mag je wel blijven doen.</p>`;
    knop = `<button class="btn rood" data-a="uitleg-volgende">Volgende: wat niet mag</button>`;
  } else {
    const kort = [['Nepopdrachten doen', 'Expres iets geks doen om de rest op een dwaalspoor te zetten.'], ['Op elkaars scherm kijken', 'Je opdracht is alleen voor jou.'],
      ['Je opdracht verklappen', 'Pas vertellen als je terecht betrapt bent.'], ['Iemand dwarszitten', 'Expres zorgen dat de opdracht van een ander niet lukt.'],
      ['Je opdracht doen tijdens een betrapping', 'Dan let iedereen op één persoon. Wacht tot het weer rustig is.']];
    inhoud = `${kicker}${h1('Wat niet mag')}
      <p class="uitleg-p">Het spel is alleen leuk als iedereen eerlijk speelt. Dus:</p>
      <div class="uitleg-kaarten">${kort.map(([k, t]) => kaart(I.verbod, k, t)).join('')}</div>
      <p class="uitleg-p klein">Alles teruglezen kan tijdens het spel via het vraagteken.</p>`;
    knop = `<button class="btn rood" data-a="uitleg-klaar">Geef mij mijn opdracht</button>`;
  }
  return `<main class="screen licht uitleg-slide">${kop}${inhoud}<div style="flex-grow:1;min-height:18px"></div>${knop}</main>`;
}

function vEnvelop() {
  const f = S.envelop, open = f !== 'dicht', uit = f === 'uit' || f === 'donker', donker = f === 'donker', m = S.missie || {};
  const me = ik();
  return `<main class="envelop-scherm ${donker ? 'donker' : ''}">
    <div class="stippen-laag stippen" aria-hidden="true"></div>
    <div class="env-tekst">${envTekst(donker)}</div>
    <div class="dmap ${open ? 'open' : ''} ${uit ? 'uit' : ''}">
      <svg class="dmap-achter" width="300" height="230" viewBox="0 0 300 230" aria-hidden="true"><defs><linearGradient id="mo-kd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9A464"/><stop offset="1" stop-color="#A9844A"/></linearGradient></defs>
        <path d="M0 24 a10 10 0 0 1 10 -10 h70 l14 14 h196 a10 10 0 0 1 10 10 v182 a10 10 0 0 1 -10 10 h-280 a10 10 0 0 1 -10 -10z" fill="url(#mo-kd)"/></svg>
      <div class="dmap-papier ${donker ? 'leesbaar' : ''}" id="envpapier" tabindex="${donker ? 0 : -1}" aria-label="Je opdracht, beslagen. Houd vast om te lezen.">
        <div class="typ dmap-kop"><span>DOSSIER ${dossierNr(me?.id)}</span><span class="stempel-mini">GEHEIM</span></div>
        <span class="typ" style="font-size:11px;letter-spacing:1.5px;color:#8A7B62">OPDRACHT</span>
        <div class="dmap-inhoud"><div class="dmap-tekst"><p class="typ">${esc(m.tekst || '')}</p>
          <div class="typ dmap-meta"><span>DOELWIT: ${esc((m.doelwit || 'niemand').toUpperCase())}</span><span>·</span><span>ONTVANGEN ${tijd(m.toegewezen_op)}</span></div></div>
          <div class="wasem" aria-hidden="true"></div></div>
        <span class="dmap-hint">${donker ? 'Houd je vinger op het papier om de wasem weg te vegen' : ''}</span>
      </div>
      <div class="dmap-klep" aria-hidden="true"><svg width="300" height="170" viewBox="0 0 300 170" style="display:block;overflow:visible"><defs><linearGradient id="mo-kf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8CB92"/><stop offset="1" stop-color="#C9A464"/></linearGradient></defs>
        <rect width="300" height="170" rx="10" fill="url(#mo-kf)"/><path d="M4 2 H296" stroke="#F4E2B8" stroke-width="2" opacity="0.9"/>
        <g transform="rotate(-12 150 92)"><rect x="62" y="68" width="176" height="50" rx="10" fill="none" stroke="#C2302A" stroke-width="5"/><rect x="70" y="76" width="160" height="34" rx="6" fill="none" stroke="#C2302A" stroke-width="1.6"/>
        <text x="150" y="104" text-anchor="middle" font-family="'Black Ops One', Impact, sans-serif" font-size="30" letter-spacing="4" fill="#C2302A">GEHEIM</text></g></svg></div>
      <svg class="dmap-clip" width="30" height="78" viewBox="0 0 30 78" aria-hidden="true"><path d="M9 10 V60 a6 6 0 0 0 12 0 V14 a9 9 0 0 0 -18 0 V54" fill="none" stroke="#B9B6AE" stroke-width="3.2" stroke-linecap="round"/><path d="M9 10 V60 a6 6 0 0 0 12 0 V14 a9 9 0 0 0 -18 0 V54" fill="none" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="1" stroke-linecap="round"/></svg>
      ${open ? '' : '<span class="dmap-puls" aria-hidden="true"></span><button class="dmap-tik" data-a="zegel" aria-label="Haal de paperclip eraf en open het dossier"></button>'}
    </div>
    <div style="flex-grow:1"></div>
    <div style="position:relative;width:100%;max-width:432px;display:flex;flex-direction:column;align-items:center;gap:12px">
      ${!open ? '<span class="env-tikhint">Tik op de paperclip</span>' : ''}
      ${donker ? ENV_KNOP : ''}
    </div></main>`;
}
const ENV_KNOP = '<button class="btn goud" data-a="naar-missie">Begrepen, aan de slag</button>';
function envTekst(donker) {
  return `<span class="k">${donker ? `${esc(S.sessie.naam)} · ${esc(S.sessie.code)}` : 'De opdrachten zijn uitgedeeld'}</span>
      <h1>${donker ? 'Alleen voor jouw ogen' : 'Je dossier is binnen'}</h1>
      <p>${donker ? 'Het papier is beslagen. Kijk erdoorheen zolang je je vinger erop houdt.' : 'Iedereen aan tafel krijgt er nu een. Niet bij je buren kijken!'}</p>`;
}
// Envelop openen als één doorlopende animatie op de bestaande elementen (geen nieuwe schermen tussendoor)
function openEnvelop() {
  const scherm = document.querySelector('.envelop-scherm'), map = scherm?.querySelector('.dmap');
  tril(TRIL.tik);
  if (!scherm || !map) { S.envelop = 'donker'; render(); return; }
  S.envAnim = true; S.envelop = 'open';
  map.querySelector('.dmap-tik')?.remove(); map.querySelector('.dmap-puls')?.remove();
  scherm.querySelector('.env-tikhint')?.classList.add('weg');
  requestAnimationFrame(() => map.classList.add('open'));
  setTimeout(() => { S.envelop = 'uit'; map.classList.add('uit'); }, 950);
  setTimeout(() => { S.envelop = 'donker'; scherm.classList.add('donker'); scherm.querySelector('.env-tekst')?.classList.add('weg'); }, 1900);
  setTimeout(() => {
    const t = scherm.querySelector('.env-tekst'); if (t) { t.innerHTML = envTekst(true); t.classList.remove('weg'); }
    const pap = scherm.querySelector('#envpapier'); if (pap) { pap.classList.add('leesbaar'); pap.tabIndex = 0;
      const h = pap.querySelector('.dmap-hint'); if (h) h.textContent = 'Houd je vinger op het papier om de wasem weg te vegen'; }
    const voet = scherm.querySelector('.env-tikhint')?.parentElement; if (voet) { scherm.querySelector('.env-tikhint')?.remove(); voet.insertAdjacentHTML('beforeend', ENV_KNOP); voet.lastElementChild.classList.add('verschijn'); }
  }, 2300);
  setTimeout(() => { S.envAnim = false; S.renderWacht = false; render(); }, 3000);
}

// ----- spel -----
function vSpelkop() {
  const s = S.sessie, me = ik(), m = S.missie, eind = speltijdEind();
  const ms = eind ? eind - nu() : 0, rood = eind && ms < 5 * 60000;
  const meldingenUit = pushKan() && pushStatus() !== 'granted';
  const totaal = (me?.punten_beschuldiging ?? 0) + (m?.eerdere_punten || 0) + (m?.voltooid && !me?.ontmaskerd ? m.punten || 0 : 0);
  const rechts = m?.voltooid ? `<span class="pv"><span>Getuigen</span><b class="klein">${(m.getuigen || []).length ? esc(namenLijst(m.getuigen.map(naam))) : 'geen'}</b></span>`
    : me?.ontmaskerd ? `<span class="pv"><span>Deze opdracht</span><b class="rood">0</b></span>`
    : `<span class="pv"><span>Nu geflikt</span><b class="goud">+<span data-waard="${m?.toegewezen_op ? new Date(m.toegewezen_op).getTime() : nu()}">${m?.toegewezen_op ? tijdpunten(new Date(m.toegewezen_op).getTime(), nu()) : 10}</span></b></span>`;
  return `<div class="spelkop2">
    <div class="sk-rij"><span class="sk-naam">${esc(s.naam)} <span>· ${esc(s.code)}</span></span>
      <span class="sk-r">${echteHost() ? `<button class="sk-stop" data-a="beeindig">Spel stoppen</button>` : ''}
        <button class="iconbtn" data-a="speluitleg" aria-label="Spelregels">${I.vraag}</button><button class="iconbtn" data-a="menu" aria-label="Menu">${I.meer}</button></span></div>
    ${meldingenUit ? `<button class="sk-melding" data-a="meldingen-aan">${I.belUit}<span>Meldingen staan uit · je mist betrappingen</span><u>Aanzetten</u></button>` : ''}
    ${eind ? `<div class="sk-tijd ${rood ? 'rood' : ''}" data-tijdblok="${eind}"><div><span class="l">${I.klok}<span>Speltijd</span></span><span class="t"><b data-speltijd="${eind}">${fmtMin(ms)}</b> <span>over</span></span></div>
      <div class="sk-balk"><i data-tijdbalk style="width:${Math.min(100, Math.max(0, 100 - (ms / SPELDUUR) * 100))}%"></i></div></div>` : ''}
    ${s.punten_aan ? `<div class="sk-punten"><span class="pv"><span>Jouw punten</span><b>${totaal}</b></span>${rechts}</div>` : ''}
  </div>`;
}

function vSpel() {
  return `<main class="screen">${vSpelkop()}${hostBanners()}${vMissieTab()}</main>`;
}

function vMissieTab() {
  const m = S.missie, me = ik();
  if (!m) return `<div class="missie-wrap"><div class="center-msg"><div class="spinner"></div></div></div>`;
  if (!m.heeft_missie) return `<div class="missie-wrap"><div class="center-msg"><h2>Nog geen opdracht</h2><p>${esc(S.fout || 'Even geduld…')}</p></div></div>`;
  let knoppen;
  if (me?.ontmaskerd) {
    knoppen = `<div class="acties2"><span class="act-afgevinkt rood">Betrapt</span><span class="act-afgevinkt"><span>Geen nieuwe opdracht</span><small>betrappen mag wel</small></span></div>`;
  } else if (m.voltooid) {
    knoppen = `<div class="acties2"><button class="act-afgevinkt knop" data-a="voltooid-ongedaan" aria-label="Afgevinkt. Tik om ongedaan te maken">Afgevinkt<small>per ongeluk? tik</small></button>
      <button class="act" data-a="nieuwe-opdracht"><span class="a1">Nieuwe opdracht</span><small>mag, hoeft niet</small></button></div>`;
  } else {
    const jokerTot = new Date(m.joker_tot).getTime();
    const jokerKan = m.gratis_wissel || m.joker_extra || (!m.joker_gebruikt && nu() < jokerTot);
    const sub = m.gratis_wissel ? 'gratis: je doelwit is weg' : m.joker_extra ? 'extra ruil van de host' : `1× ruilen · kan nog <span data-jokertot="${jokerTot}" data-min="1">${Math.max(1, Math.ceil((jokerTot - nu()) / 60000))}</span> min`;
    knoppen = `<div class="acties2"><button class="act goud" data-a="voltooid">Geflikt!</button>
      ${jokerKan ? `<button class="act" data-a="joker"><span class="a1">Andere opdracht</span><small>${sub}</small></button>` : `<span class="act-afgevinkt"><span>Andere opdracht</span><small>${m.joker_gebruikt ? 'al geruild' : 'na 10 min niet meer'}</small></span>`}</div>`;
  }
  return `<div class="missie-wrap" id="missiewrap">
    ${m.gratis_wissel && !m.voltooid ? `<div class="banner" style="margin:0"><p>Je doelwit is vertrokken. Je mag gratis ruilen.</p></div>` : ''}
    ${vMissieKaart(m)}${knoppen}<div style="flex-grow:1"></div>${vBetrapGrid()}</div>`;
}

// W1: betrappen vanaf de opdracht-tab: alle spelers in kolommen van 3, met één tik
function vBetrapGrid() {
  const me = ik(), open = openBesch();
  const sp = actief().filter((p) => p.id !== me?.id).sort((a, b) => a.volgnr - b.volgnr);
  if (!sp.length) return '';
  return `<section class="betrap" aria-label="Wie betrap je?"><span class="betrap-t">Wie betrap je? Eén tik is genoeg.</span>
    <div class="betrap-grid">${sp.map((p) => {
      const b = open.find((x) => x.beschuldigde_id === p.id);
      let knop;
      if (p.ontmaskerd) knop = `<span class="bk-knop uit">BETRAPT</span>`;
      else if (b && doetMee(b.id)) knop = `<button class="bk-knop mee" data-a="open-besch" data-id="${b.id}">Jij zag het</button>`;
      else if (b) knop = `<button class="bk-knop ook" data-a="meedoen" data-id="${b.id}">Ik zag het<br>ook!</button>`;
      else knop = `<button class="bk-knop" data-a="betrap" data-id="${p.id}" aria-label="Betrap ${esc(p.naam)}">Betrapt!</button>`;
      return `<div class="bk ${p.ontmaskerd ? 'grijs' : ''}"><span class="bk-i">${esc(p.naam[0]?.toUpperCase())}</span><span class="bk-naam">${esc(p.naam)}</span>${knop}</div>`;
    }).join('')}</div></section>`;
}
// Doelwit en woord in de opdrachttekst laten opvallen
function nadruk(tekst, woorden) {
  let h = esc(tekst || '');
  for (const w of woorden.filter((x) => x && x.trim().length > 1)) {
    const e = esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    h = h.replace(new RegExp(`(^|[^\\p{L}])(${e})(?=$|[^\\p{L}])`, 'giu'), '$1<mark class="ds-nadruk">$2</mark>');
  }
  return h;
}
const fmtMin = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function vMissieKaart(m) {
  const me = ik();
  return `<div class="dossier2" id="missiekaart">
    <div class="ds-tab">DOSSIER ${dossierNr(me?.id)}</div>
    <div class="ds2-map">${CLIP.replace('class="ds-clip"', 'class="ds-clip ds2-clip"')}
      <div class="ds2-dicht" aria-hidden="true"><div class="ds-regels"><span>AGENT: ${esc((me?.naam || '').toUpperCase())}</span><span>ONTVANGEN: ${tijd(m.toegewezen_op)}</span></div>
        <div class="ds-midden"><span class="stempel-geheim">GEHEIM</span></div>
        ${m.voltooid && !me?.ontmaskerd ? `<span class="ds2-vink">${I.vink}${tijd(m.voltooid_op)} · +${m.punten}</span>` : ''}</div>
      <div class="ds2-open">
        <div class="ds-veld"><span class="ds-lbl">OPDRACHT</span><p class="ds2-tekst">${nadruk(m.tekst, [m.doelwit, m.woord])}</p></div>
        <div class="ds-grid ${m.woord ? '' : 'een'}"><div class="${m.doelwit ? 'ds-doel' : ''}"><span class="ds-lbl">DOELWIT</span><b>${esc(m.doelwit || 'Niemand speciaal')}</b></div>
          ${m.woord ? `<div class="ds-doel"><span class="ds-lbl">WOORD</span><b>${esc(m.woord)}</b></div>` : ''}</div>
        ${m.uitleg ? `<div class="ds-veld"><span class="ds-lbl">GEFLIKT ALS</span><span class="ds2-uitleg">${esc(m.uitleg)}</span></div>` : ''}</div>
      <div class="ds2-strook" id="leesstrook" tabindex="0" role="button" aria-label="Houd hier vast om je opdracht te lezen"><i class="vulbalk" aria-hidden="true"></i>
        <span class="dicht-t">${I.hand}Houd hier vast om te lezen</span><span class="open-t">${I.hand}Je houdt vast · loslaten = dicht</span></div>
    </div></div>`;
}


// Volledig scherm voor de beschuldigde
function vOverlay() {
  if (S.view !== 'sessie' || S.sessie?.status !== 'spel' || !heeftCeremonie()) return '';
  const me = ik(), b = me && openBesch().find((x) => x.beschuldigde_id === me.id);
  if (!b) { vOverlay.laatste = null; S.bevestig = null; return ''; }
  const nieuw = vOverlay.laatste !== b.id; vOverlay.laatste = b.id;
  const d = deelnemers(b.id), namen = d.map((x) => naam(x.speler_id));
  const lang = (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT;
  const kies = S.bevestig?.id === b.id ? S.bevestig.val : null, ja = kies === 'ja';
  return `<div class="accused ${nieuw ? 'anim' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="acc-t"><div class="inner">
    <span class="acc-titel">Betrapt?!</span><h2 id="acc-t">${esc(namenLijst(namen))} ${namen.length > 1 ? 'denken dat ze je hebben' : 'denkt dat hij je heeft'}</h2>
    <div class="acc-dossier"><div class="acc-inhoud"><span class="ds-lbl">JOUW OPDRACHT</span><p class="tekst">${esc(S.missie?.tekst || '')}</p><span class="balk" style="width:92%"></span><span class="balk" style="width:78%"></span><span class="balk" style="width:56%"></span></div>
      <div class="check-missie" id="checkmissie" role="button" tabindex="0" aria-label="Houd vast om je opdracht te checken"><span class="dicht-t">${I.hand}Houd hier vast om je opdracht te checken</span><span class="open-t">${I.hand}Je houdt vast · loslaten = dicht</span></div></div>
    <div class="acc-vraag"><b>Raakt hun vermoeden de kern van je opdracht?</b><span>Letterlijk hoeft niet. Bij de onthulling ziet iedereen wat je koos.</span></div>
    ${lang ? '<p style="color:var(--goud)">Iedereen wacht op jou. Kies nu.</p>' : ''}
    <div class="groei"></div>
    <span class="acc-tril">Je telefoon trilt elke 15 seconden tot je kiest</span>
    <div class="twee"><button class="btn toegeven groot" data-a="kies" data-id="${b.id}" data-val="ja">Je hebt me!</button>
      <button class="btn licht-knop groot" data-a="kies" data-id="${b.id}" data-val="nee">Mooi niet!</button></div>
  </div>
  ${kies ? `<div class="bev-scrim"><div class="bev-sheet" role="dialog" aria-label="Weet je het zeker?">
    <span class="bev-stempel ${ja ? 'rood' : ''}">${ja ? 'JE HEBT ME!' : 'MOOI NIET!'}</span>
    <b>${ja ? 'Weet je zeker dat ze je hebben?' : 'Weet je zeker dat ze ernaast zitten?'}</b>
    <span>${ja ? 'Dan is deze opdracht mislukt: hij levert geen punten op en je kunt daarna geen nieuwe opdracht meer pakken. Betrappen mag je nog wel.' : 'Dan speel je gewoon door. Maar bij de onthulling ziet iedereen je echte opdracht naast deze betrapping. Lieg je, dan valt dat op.'}</span>
    <button class="btn ${ja ? 'toegeven' : 'licht-knop'} groot" data-a="reageer" data-id="${b.id}" data-val="${kies}">${ja ? 'Ja, ze hebben me' : 'Ja, mooi niet!'}</button>
    <button class="btn klein" data-a="kies-terug">Nee, terug</button></div></div>` : ''}</div>`;
}

function vUitslag() {
  const u = S.uitslag;
  if (!u) { vUitslag.laatste = null; return ''; }
  const nieuw = vUitslag.laatste !== u.id; vUitslag.laatste = u.id;
  const rijen = S.sessie?.punten_aan ? u.rijen : [];
  return `<div class="uitslag ${nieuw ? 'anim' : ''}" data-a="uitslag-dicht"><div class="kaart" role="status">
    <div class="us-stempel"><div class="us-ini">${esc((u.wie || '?')[0].toUpperCase())}</div><span class="stempel ${u.goed ? 'rood' : 'creme'}">${u.goed ? 'BETRAPT!' : 'MOOI NIET!'}</span></div>
    <h2>${esc(u.titel)}</h2><span class="sub">${esc(u.sub)}</span>
    <div class="us-rijen">${rijen.map((r, i) => `<div class="us-rij" style="animation-delay:${700 + i * 90}ms"><span>${esc(r.naam)} <i>${esc(r.rol)}</i></span><b class="${r.pt > 0 ? 'plus' : r.pt < 0 ? 'min' : ''}">${r.pt > 0 ? '+' + r.pt : r.pt < 0 ? '−' + Math.abs(r.pt) : r.pt === 0 ? '0' : '·'}</b></div>`).join('')}</div>
    <div style="flex-grow:1"></div>
    <button class="btn klein" data-a="uitslag-dicht">Verder spelen</button><span class="noot">Blijft staan tot je tikt</span></div></div>`;
}

// ----- onthulling -----
function huidig() {
  const s = S.sessie, id = s.onthul_volgorde?.[s.onthul_index];
  const data = S.onthulling?.find((x) => x.speler_id === id);
  return { id, data, stap: s.onthul_stap, n: s.onthul_volgorde?.length || 0, i: s.onthul_index };
}
function status(o) {
  if (o.ontmaskerd) return ['bad', 'Betrapt'];
  if (o.voltooid && !o.afgewezen.length) return ['good', 'Ongezien'];
  if (o.voltooid) return ['good', 'Geflikt'];
  return ['meh', 'Niet geflikt'];
}
// Welke stemvraag hoort bij de huidige stap? null = geen stemming.
function revealAnim() {
  const k = `${S.sessie.onthul_index}${S.sessie.onthul_stap}`;
  const nieuw = revealAnim.laatste !== k; revealAnim.laatste = k; return nieuw ? 'anim' : '';
}
function vOnthullingInhoud(groot) {
  const { data, stap } = huidig();
  if (!data) return `<div class="spinner"></div>`;
  if (stap === 'naam') {
    return `<span class="ont-ster" aria-hidden="true">${I.ster}</span><span class="ondertitel2">Het dossier van</span><h2 class="grote-naam">${esc(data.naam)}</h2>
      ${groot ? `<span class="tik-knop">Tik om te onthullen</span>` : ''}`;
  }
  const [, txt] = status(data);
  const stempels = data.ontmaskerd ? ['BETRAPT'] : data.voltooid ? (txt === 'Ongezien' ? ['GEFLIKT', 'ONGEZIEN'] : ['GEFLIKT']) : [];
  const bd = data.betrapt_door, ontv = data.toegewezen_op ? `ONTVANGEN ${tijd(data.toegewezen_op)} · ` : '';
  const duur = data.voltooid_op && data.toegewezen_op ? Math.max(0, Math.floor((new Date(data.voltooid_op) - new Date(data.toegewezen_op)) / 60000)) : null;
  const meta = data.ontmaskerd ? `${ontv}BETRAPT${bd?.op ? ' ' + tijd(bd.op) : ''} · 0`
    : data.voltooid ? `${ontv}GEFLIKT ${tijd(data.voltooid_op)} (${duur} MIN) · +${data.punten}` : `${ontv}NIET GEFLIKT · 0`;
  const links = `<div class="links"><div class="ont-kop"><h2 class="ont-naam">${esc(data.naam)}</h2><span class="typ">DOSSIER ${dossierNr(data.speler_id)}</span></div>
    <div class="ont-blad"><span class="typ ont-lbl">${data.eerdere?.length ? 'LAATSTE OPDRACHT' : 'OPDRACHT'}</span><p class="ont-tekst typ">${esc(data.tekst)}</p>
      <span class="typ ont-meta">${meta}</span>
      ${stempels.map((st, k) => `<span class="stempel groot s${k}" style="--sk:${STEMPELKLEUR[st]}" aria-label="Stempel: ${st}">${st}</span>`).join('')}</div></div>`;
  const rij = (n, r, pt, kl) => `<div class="ok-rij"><span>${esc(n)} <i>${r}</i></span><b class="${kl}">${pt}</b></div>`;
  let hoofd;
  if (data.ontmaskerd && bd) {
    const ook = bd.ook || [];
    hoofd = `<div class="ont-kaart"><span class="k">Betrapt door ${esc(bd.eerste || '?')}</span><span class="h">${esc(bd.eerste || '?')} riep Betrapt!${bd.op ? ` om ${tijd(bd.op)}` : ''}</span>
      <span class="o">${ook.length ? `${esc(namenLijst(ook))} ${ook.length > 1 ? 'zagen' : 'zag'} het ook. ` : ''}${esc(data.naam)} gaf toe: “Je hebt me!”</span>
      <div class="ok-rijen">${(bd.punten || []).map((p) => rij(p.naam, p.rol === 'eerste' ? 'als eerste' : 'zag het ook', (p.punten > 0 ? '+' : '') + p.punten, p.punten > 0 ? 'plus' : 'min')).join('')}</div></div>`;
  } else if (data.ontmaskerd) {
    hoofd = `<div class="ont-kaart"><span class="k">Toch betrapt</span><span class="h">De host zette een “Mooi niet!” op Betrapt!</span><div class="ok-rijen">${rij(data.naam, 'deze opdracht', '0', 'nul')}</div></div>`;
  } else if (data.voltooid) {
    const g = data.getuigen || [];
    hoofd = `<div class="ont-kaart"><span class="k">Geflikt zonder betrapt te worden</span><span class="h">${g.length ? `${esc(namenLijst(g))} ${g.length > 1 ? 'zagen' : 'zag'} het gebeuren` : 'Niemand gekozen als getuige'}</span>
      <span class="o">${g.length ? `${esc(data.naam)} koos ${g.length > 1 ? 'hen' : 'diegene'} als getuige${g.length > 1 ? 'n' : ''}. Klopt het?` : 'Heeft iemand het toch gezien?'}</span>
      <div class="ok-rijen">${rij(data.naam, `binnen ${duur <= 10 ? 10 : duur <= 20 ? 20 : duur <= 30 ? 30 : duur <= 40 ? 40 : '45'} min`, '+' + data.punten, 'plus')}</div></div>`;
  } else {
    hoofd = `<div class="ont-kaart"><span class="k">Niet gelukt, niet betrapt</span><span class="h">Niemand had iets door</span><span class="o">${esc(data.naam)} kwam er niet aan toe. Hoe had jij dit aangepakt?</span>
      <div class="ok-rijen">${rij(data.naam, 'opdracht open', '0', 'nul')}</div></div>`;
  }
  const kaarten = [hoofd];
  if (data.eerdere?.length) kaarten.push(`<div class="ont-kaart"><span class="k">Eerder geflikt</span>${data.eerdere.map((e) => `<p class="eerder"><span class="typ">${esc(e.tekst)}</span><b>${e.toch_betrapt ? 'toch betrapt · 0 pt' : `+${e.punten}`} · ${tijd(e.voltooid_op)}${e.getuigen?.length ? ` · getuigen: ${esc(namenLijst(e.getuigen))}` : ''}</b></p>`).join('')}</div>`);
  (data.afgewezen || []).forEach((a) => {
    const [eerste, ...ook] = a.door;
    kaarten.push(`<div class="ont-kaart mooiniet ${a.toch_raak ? 'raak' : ''}"><span class="k">Ook gezegd: “Mooi niet!”</span>
      <span class="h2">${esc(eerste || '?')} betrapte ${esc(data.naam)} om ${tijd(a.op)}${ook.length ? ` · ${esc(namenLijst(ook))} zag${ook.length > 1 ? 'en' : ''} het ook` : ''}</span>
      ${a.toch_raak ? `<span class="mn-label">De host vond het toch raak: betrapt</span>` : `<span class="o">Wat dacht ${esc(eerste || 'je')} toen? Zeg het hardop. Eerlijk gespeeld, ${esc(data.naam)}?</span>`}
      ${groot && S.sessie.status === 'onthulling' ? `<button class="btn klein ${a.toch_raak ? 'fk-rand' : 'fk'}" data-a="toch-raak" data-id="${a.id}" data-val="${a.toch_raak ? 'nee' : 'ja'}">${a.toch_raak ? 'Toch niet raak' : 'Toch raak: zet op Betrapt!'}</button>` : ''}</div>`);
  });
  return `<div class="onthul-grid met-zij">${links}<div class="ont-zij">${kaarten.join('')}</div></div>`;
}
function volgendeLabel() {
  const { stap, n, i } = huidig();
  if (stap === 'naam') return 'Onthul de opdracht';
  return i < n - 1 ? 'Volgende speler' : null;
}
function vOnthullingHost() {
  const { stap, n, i } = huidig(), lbl = volgendeLabel();
  return `<main class="feest stippen">
    <div class="feest-top"><b>De onthulling</b><span>Speler ${Math.min(i + 1, n)} van ${n}</span></div>
    <div class="feest-main ${revealAnim()} ${stap === 'naam' ? 'tik' : ''}" ${stap === 'naam' ? 'data-a="onthul-volgende" role="button" tabindex="0"' : ''}>${vOnthullingInhoud(true)}</div>
    <p class="feest-noot">De host tikt door · iedereen kijkt mee op het grote scherm</p>
    <div class="feest-voet"><button class="btn fk-rand" data-a="onthul-vorige" ${i === 0 && stap === 'naam' ? 'disabled' : ''}>Vorige</button>
      ${lbl ? `<button class="btn fk" data-a="onthul-volgende">${lbl}</button>` : `<button class="btn fk" data-a="scorebord">Naar het scorebord</button>`}</div></main>`;
}
function vOnthullingSpeler() {
  const { n, i } = huidig();
  return `<main class="feest stippen">
    <div class="feest-top"><b>De onthulling</b><span>Speler ${Math.min(i + 1, n)} van ${n}</span></div>
    <div class="feest-main ${revealAnim()}" style="justify-content:flex-start;padding-top:32px">${vOnthullingInhoud(false)}</div>
    <div class="foot" style="width:100%;max-width:480px;margin:0 auto"><p class="foot-note" style="color:#F0D9C9;font-size:15px">Kijk mee op het scherm van de host.</p></div></main>`;
}

function vScorebord() {
  const sp = actief().slice().sort((a, b) => (b.eindscore ?? 0) - (a.eindscore ?? 0) || a.volgnr - b.volgnr);
  const punten = S.sessie.punten_aan, top = sp[0];
  const raak = {}, totaal = {};
  S.deel.forEach((d) => { const b = S.besch.find((x) => x.id === d.beschuldiging_id); if (!b || b.status === 'vervallen') return; totaal[d.speler_id] = (totaal[d.speler_id] || 0) + 1; if (d.punten > 0) raak[d.speler_id] = (raak[d.speler_id] || 0) + 1; });
  const speurder = Object.keys(raak).sort((a, b) => raak[b] - raak[a] || totaal[a] - totaal[b])[0];
  const verdacht = (id) => S.onthulling?.find((o) => o.speler_id === id)?.keer_verdacht ?? 0;
  const radar = sp.filter((p) => p.missie_gehaald && !p.ontmaskerd).sort((a, b) => verdacht(a.id) - verdacht(b.id))[0];
  const winnaars = top ? sp.filter((p) => p.eindscore === top.eindscore) : [];
  const waarom = (p) => {
    const delen = [];
    if (p.opdrachten_geflikt) delen.push(`${p.opdrachten_geflikt === 1 ? 'Eén opdracht' : p.opdrachten_geflikt + ' opdrachten'} geflikt (+${p.missie_punten ?? 0})`);
    if (p.punten_beschuldiging) delen.push(`betrappen ${p.punten_beschuldiging > 0 ? '+' : ''}${p.punten_beschuldiging}`);
    if (!delen.length) return ''; const z = delen.join(' en ') + '.'; return z[0].toUpperCase() + z.slice(1);
  };
  return `<main class="feest stippen eindstand" style="padding-bottom:env(safe-area-inset-bottom)">
    <div class="es-in">
    <span class="es-kop">Eindstand · ${esc(S.sessie.naam)}</span>
    ${punten && top ? `<div class="topkaart"><span class="k">Sluwste van de tafel</span><h2>${esc(winnaars.map((p) => p.naam).join(' & '))}</h2><b>${top.eindscore} punten</b>
        <span class="uitleg">De meeste punten van de avond. ${winnaars.length === 1 ? esc(waarom(top)) : ''}</span></div>`
      : `<div class="topkaart"><span class="k">Het spel is uit</span><h2>${sp.filter((p) => p.missie_gehaald).length} van ${sp.length}</h2><b>spelers flikten hun opdracht</b></div>`}
    <div class="titels">
      ${speurder ? `<div><span class="k">Haviksoog</span><b>${esc(naam(speurder))}</b><span>Wie het vaakst terecht iemand betrapte. ${esc(naam(speurder))} zat ${raak[speurder]} van de ${totaal[speurder]} keer goed.</span></div>` : ''}
      ${radar ? `<div><span class="k">Onder de radar</span><b>${esc(radar.naam)}</b><span>Wie het minst verdacht werd. ${verdacht(radar.id) ? `Maar ${verdacht(radar.id)} keer riep iemand Betrapt! naar ${esc(radar.naam)}.` : `Niemand riep ook maar één keer Betrapt! naar ${esc(radar.naam)}.`}</span></div>` : ''}
    </div>
    <div class="rang">${sp.map((p, i) => `<div><span class="pos">${punten ? i + 1 : ''}</span><span class="n">${esc(p.naam)}</span>${punten ? `<span class="pt">${p.eindscore ?? 0}</span>` : `<span style="width:22px;color:${p.missie_gehaald ? 'var(--feestgoud)' : 'transparent'}">${I.vink}</span>`}</div>`).join('')}</div>
    <button class="btn ghost klein es-alle" data-a="missies-terug">Alle opdrachten terugzien</button>
    <div class="es-knoppen">${echteHost() ? `<button class="btn fk" data-a="nieuwe-ronde">Nog een ronde</button>` : `<span class="es-wacht">Nog een ronde? Dat kiest de host.</span>`}
      <button class="btn fk-rand" data-a="afsluiten">Afsluiten</button></div>
    </div></main>`;
}

// ----- sheets en toasts -----
function vSheet() {
  const sh = S.sheet;
  if (!sh) { vSheet.laatste = null; return ''; }
  let inner = '';
  if (sh.type === 'voltooid') {
    const me = ik(), pt = S.missie ? tijdpunten(new Date(S.missie.toegewezen_op).getTime(), nu()) : 0;
    const n = sh.getuigen.length;
    inner = `<h2 style="color:var(--goud)">Geflikt?</h2><b style="font-size:17px">Wie zagen het gebeuren?</b><p>Tik iedereen aan die erbij was. Bij de onthulling staan zij als getuigen bij je opdracht. Niemand gezien? Dan sla je dit over. Dit levert nu ${pt} punten op.</p>
      <div class="picks3">${actief().filter((p) => p.id !== me?.id).map((p) => `<button class="pick" data-a="getuige" data-id="${p.id}" aria-pressed="${sh.getuigen.includes(p.id)}">${sh.getuigen.includes(p.id) ? I.vink : ''}${esc(p.naam)}</button>`).join('')}</div>
      <div class="twee een-twee"><button class="btn klein" data-a="sheet-dicht">Terug</button><button class="btn goud" data-a="voltooid-ok">Ja, geflikt${n ? ` (${n} ${n === 1 ? 'getuige' : 'getuigen'})` : ''}</button></div>`;
  } else if (sh.type === 'joker') {
    inner = `<h2>Andere opdracht?</h2><p>${S.missie?.gratis_wissel ? 'Je doelwit is vertrokken, dus deze wissel is gratis.' : 'Je krijgt een nieuwe opdracht. Je oude komt niet terug in het spel. Dit kan maar één keer.'}</p>
      <button class="btn goud" data-a="joker-ok">Geef mij een andere</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'nieuwe-opdracht') {
    inner = `<h2>Nieuwe opdracht pakken?</h2><p>Je geflikte opdracht (${S.missie?.punten ?? 0} pt) is dan veilig: niemand kan je er nog op betrappen. Word je op de nieuwe betrapt, dan levert die niets op en kun je daarna geen nieuwe meer pakken.</p>
      <button class="btn goud" data-a="nieuwe-opdracht-ok">Geef mij een nieuwe</button><button class="btn ghost" data-a="sheet-dicht">Nee, ik blijf zo</button>`;
  } else if (sh.type === 'menu') {
    const host = echteHost() && S.sessie?.status === 'spel', me = ik();
    const stil = openBesch().filter((b) => (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT && b.beschuldigde_id !== me?.id);
    inner = `<h2>Menu</h2>
      <button class="btn klein" data-a="speluitleg">${I.vraag}Spelregels</button>
      ${pushKan() && pushStatus() !== 'granted' ? `<button class="btn klein" data-a="meldingen-aan">Meldingen aanzetten</button>` : ''}
      ${host ? `${stil.map((b) => `<button class="btn klein" data-a="host-sluit" data-id="${b.id}">${esc(naam(b.beschuldigde_id))} reageert niet: sluit als Mooi niet!</button>`).join('')}
        <span class="k" style="margin-top:6px">Spelers (host)</span>
        <div class="menu-spelers">${actief().filter((p) => p.id !== echteIk()?.id).map((p) => `<button class="pick" data-a="spelermenu" data-id="${p.id}">${esc(p.naam)}</button>`).join('')}</div>
        <button class="btn klein" style="border-color:var(--rood-rand);color:var(--rood-t)" data-a="beeindig">Spel beëindigen en onthullen</button>
        <button class="btn ghost klein" style="color:var(--rood-t)" data-a="annuleer">Avond annuleren</button>`
      : `<button class="btn ghost klein" data-a="verlaat">Tafel verlaten</button>`}
      <button class="btn ghost" data-a="sheet-dicht">Sluiten</button>`;
  } else if (sh.type === 'meldingen') {
    inner = `<h2>Meldingen aanzetten?</h2><p>Dan trilt je telefoon en krijg je een melding als iemand Betrapt! roept, ook als je scherm op slot zit. Ben jij betrapt, dan trilt hij elke 15 seconden tot je kiest.</p>
      <button class="btn goud" data-a="meldingen-aan">Aanzetten</button><button class="btn ghost" data-a="meldingen-later">Later</button>`;
  } else if (sh.type === 'melding') {
    const b = S.besch.find((x) => x.id === sh.id);
    if (!b || b.status !== 'open' || doetMee(b.id)) { S.sheet = null; return ''; }
    const d = deelnemers(b.id);
    inner = `<div style="display:flex;align-items:center;gap:16px"><span class="mt-oog">${I.oog}</span><div><span class="k">Betrapt!</span><h2>${esc(naam(b.eerste_beschuldiger_id))} betrapt ${esc(naam(b.beschuldigde_id))}!</h2></div></div>
      <div class="naam-chips">${d.map((x) => `<span class="${x.rol === 'eerste' ? 'eerste' : ''}">${esc(naam(x.speler_id))}${x.rol === 'eerste' ? ' · betrapper' : ''}</span>`).join('')}<span style="background:transparent;color:var(--faint)">zagen het ook</span></div>
      <p>Zag jij het ook? Klopt het, dan +2 voor jou; klopt het niet, −1. Meedoen kan tot ${esc(naam(b.beschuldigde_id))} zelf kiest.</p>
      <div class="twee een-twee"><button class="btn klein" data-a="sheet-dicht">Later</button><button class="btn goud klein" data-a="meedoen" data-id="${b.id}">Ik zag het ook!</button></div>`;
  } else if (sh.type === 'open-besch') {
    const b = S.besch.find((x) => x.id === sh.id);
    if (!b || b.status !== 'open') { S.sheet = null; return ''; }
    const d = deelnemers(b.id), me = ik();
    const wie = esc(naam(b.beschuldigde_id));
    inner = `<div class="ob-kop"><span>${b.eerste_beschuldiger_id === me?.id ? 'Jij betrapt' : `${esc(naam(b.eerste_beschuldiger_id))} betrapt`}</span><h2>${wie}</h2><span class="ob-stempel">BETRAPT?</span></div>
      <p style="text-align:center">Zeg nu hardop wat je denkt dat de opdracht is. ${wie} krijgt een melding en kiest zelf: <b style="color:var(--text)">Je hebt me!</b> of <b style="color:var(--text)">Mooi niet!</b></p>
      <div><div class="mee-rij" style="color:var(--faint);font-size:13px"><span>Zagen het</span><span>klopt / klopt niet</span></div>
        ${d.map((x) => `<div class="mee-rij"><span>${x.speler_id === me?.id ? 'Jij' : esc(naam(x.speler_id))} <span style="color:var(--goud)">${x.rol === 'eerste' ? '· eerste' : ''}</span></span><span>${x.rol === 'eerste' ? '+5 / −2 of meer' : '+2 / −1'}</span></div>`).join('')}</div>
      <p style="font-size:13px;color:var(--faint)">Meedoen kan tot ${wie} kiest. Er loopt geen teller. Terugtrekken kan niet.</p>
      <div class="ob-wacht"><i></i>Wachten tot ${wie} kiest…</div>
      <button class="btn ghost klein" data-a="sheet-dicht">Terug naar het spel</button>`;
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
    inner = `<h2>Alle opdrachten</h2>${(S.onthulling || []).map((o) => { const [c, t] = status(o); return `<div style="padding:14px;border-radius:16px;background:var(--s1);display:flex;flex-direction:column;gap:4px"><b>${esc(o.naam)} <span style="font-weight:400;color:${c === 'good' ? 'var(--goud)' : c === 'bad' ? 'var(--rood-t)' : 'var(--faint)'}">· ${t}</span></b>${(o.eerdere || []).map((e) => `<span style="color:var(--muted);font-size:15px">${esc(e.tekst)} <span style="color:var(--goud)">· geflikt, ${e.punten} pt</span></span>`).join('')}<span style="color:var(--muted);font-size:15px">${esc(o.tekst)}</span>${o.betrapt_door ? `<span style="font-size:13px;color:var(--faint)">Betrapt door ${esc(o.betrapt_door.eerste || '?')}${o.betrapt_door.ook?.length ? `, ${esc(namenLijst(o.betrapt_door.ook))} zag${o.betrapt_door.ook.length > 1 ? 'en' : ''} het ook` : ''}</span>` : ''}</div>`; }).join('')}
      <button class="btn ghost" data-a="sheet-dicht">Sluiten</button>`;
  }
  const key = sh.type + (sh.id || ''), nieuw = key !== vSheet.laatste; vSheet.laatste = key;
  return `<div class="scrim ${nieuw ? 'anim' : ''} ${sh.type === 'melding' ? 'schud' : ''}" data-a="scrim"><div class="sheet" role="dialog" aria-modal="true">${inner}${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}</div></div>`;
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
    const lang = (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT, key = b.id + b.laatste_meedoen;
    if (lang && !wasNul.has(key + 'lang')) { wasNul.add(key + 'lang'); rerender = true; }
    // W5: wie betrapt is, trilt elke 15 seconden tot hij kiest
    if (b.beschuldigde_id === ik()?.id && heeftCeremonie() && Date.now() - (tik.gezoemd || 0) >= HERINNER) { tik.gezoemd = Date.now(); tril(TRIL.betrapt); }
  }
  document.querySelectorAll('[data-jokertot]').forEach((e) => { const ms = Number(e.dataset.jokertot) - nu(); if (ms <= 0) rerender = true; else e.textContent = e.dataset.min ? String(Math.max(1, Math.ceil(ms / 60000))) : fmtMin(ms); });
  document.querySelectorAll('[data-tijdblok]').forEach((e) => { const ms = Number(e.dataset.tijdblok) - nu(); e.classList.toggle('rood', ms < 5 * 60000); const bk = e.querySelector('[data-tijdbalk]'); if (bk) bk.style.width = Math.min(100, Math.max(0, 100 - (ms / SPELDUUR) * 100)) + '%'; });
  document.querySelectorAll('[data-speltijd]').forEach((e) => { const ms = Number(e.dataset.speltijd) - nu(); e.textContent = fmtMin(ms); if (ms <= 0 && !tik.eindPing) { tik.eindPing = true; ping(); } });
  document.querySelectorAll('[data-waard]').forEach((e) => { const v = String(tijdpunten(Number(e.dataset.waard), nu())); if (e.textContent !== v) e.textContent = v; });
  if (rerender) return render();
  tikTimer = setTimeout(tik, 250);
}
// Korte trillingen (< 100 ms) voel je op veel telefoons nauwelijks; daarom langere patronen.
const TRIL = { tik: 160, melding: [350, 120, 350], betrapt: [600, 150, 600, 150, 600] };
function tril(p) { try { navigator.vibrate?.(p); } catch {} }

// ---------- sessie laden en realtime ----------
async function laadAlles() {
  if (!S.sid) return;
  const sid = S.sid;
  const [ses, spl, bes, dee, ove] = await Promise.all([
    sb.from('sessies').select('*').eq('id', sid).maybeSingle(),
    sb.from('spelers').select('*').eq('sessie_id', sid).order('volgnr'),
    sb.from('beschuldigingen').select('*').eq('sessie_id', sid).order('aangemaakt'),
    sb.from('deelnames').select('*').eq('sessie_id', sid),
    sb.from('overnames').select('*').eq('sessie_id', sid).eq('status', 'open'),
  ]);
  if (sid !== S.sid) return;
  if (ses.error || spl.error) { console.warn(ses.error || spl.error); return; }
  if (!ses.data) return verlaat(S.eersteLaad ? null : 'Deze avond bestaat niet meer, of je bent van tafel gehaald.');
  if (ses.data.status === 'geannuleerd') return verlaat('De host heeft de avond geannuleerd.');
  const vorig = { status: S.sessie?.status, ontm: ik()?.ontmaskerd, als: ik()?.id, stap: S.sessie && `${S.sessie.onthul_index}${S.sessie.onthul_stap}` };
  S.sessie = ses.data; S.spelers = spl.data || []; S.deel = dee.data || []; S.overnames = ove.data || [];
  const nieuweBesch = bes.data || [];
  if (!ik()) return verlaat(S.eersteLaad ? null : 'Je zit niet meer aan deze tafel.');
  meldingen(nieuweBesch);
  S.besch = nieuweBesch;
  ls.set('sessie', { sid, code: S.sessie.code });
  if (S.sessie.status === 'spel' && (!S.missie || vorig.status !== 'spel' || vorig.ontm !== ik().ontmaskerd || vorig.als !== ik().id)) await laadMissie();
  const beschSleutel = S.besch.map((b) => b.id + b.status + b.toch_raak).join();
  if (['onthulling', 'einde'].includes(S.sessie.status) && (!S.onthulling || vorig.status !== S.sessie.status || laadAlles.besch !== beschSleutel)) {
    laadAlles.besch = beschSleutel;
    try { S.onthulling = await rpc('onthulling_data', { p_sessie: sid }); } catch (e) { console.warn(e); }
  }
  if (S.sessie.status === 'onthulling' && vorig.stap !== `${S.sessie.onthul_index}${S.sessie.onthul_stap}` && S.sessie.onthul_stap === 'missie' && isHost()) {
    const d = huidig().data; if (d && (d.voltooid || d.ontmaskerd)) setTimeout(bonk, 520); if (d && d.voltooid && !d.ontmaskerd) setTimeout(() => feest(true), 900);
  }
  if (S.sessie.status === 'spel' && vorig.status === 'lobby') { S.uitlegStap = 0; S.envelop = 'dicht'; }
  if (S.sessie.status === 'lobby' && vorig.status && vorig.status !== 'lobby') { S.missie = null; S.onthulling = null; S.uitslag = null; S.sheet = null; tik.eindPing = false; } // W12: nieuwe ronde
  if (S.sessie.status === 'spel' && !S.missie?.heeft_missie) tik.eindPing = false;
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
      if (!S.gezien.has(b.id) && b.beschuldigde_id !== me.id && !doetMee(b.id) && !S.eersteLaad && !S.sheet) { S.sheet = { type: 'melding', id: b.id }; tril(TRIL.melding); }
      if (b.beschuldigde_id === me.id && !S.gezien.has(b.id)) { tril(TRIL.betrapt); tik.gezoemd = Date.now(); }
      S.gezien.add(b.id);
    } else if (was && was.status === 'open' && b.status !== 'vervallen' && !S.gezien.has(b.id + ':uit')) {
      const d = S.deel.filter((x) => x.beschuldiging_id === b.id);
      const wie = b.beschuldigde_id === me.id ? 'Jij' : naam(b.beschuldigde_id);
      S.uitslag = {
        id: b.id, goed: b.status === 'toegegeven', wie: naam(b.beschuldigde_id),
        titel: b.status === 'toegegeven' ? `${wie}: “Je hebt me!”` : `${wie}: “Mooi niet!”`,
        sub: b.status === 'toegegeven' ? (b.beschuldigde_id === me.id ? 'Je opdracht is mislukt. Betrappen mag je nog wel.' : 'De opdracht is mislukt. Betrappen mag nog wel.') : b.door_host ? 'Gesloten door de host. Er wordt gewoon doorgespeeld.' : 'Er wordt gewoon doorgespeeld. Bij de onthulling checkt de tafel of dat eerlijk was.',
        rijen: [...d.sort((x, y) => (x.rol === 'eerste' ? -1 : 1)).map((x) => ({ naam: x.speler_id === me.id ? 'Jij' : naam(x.speler_id), rol: x.rol === 'eerste' ? 'riep Betrap!' : 'zag het ook', pt: x.punten })),
          { naam: b.beschuldigde_id === me.id ? 'Jij' : naam(b.beschuldigde_id), rol: b.status === 'toegegeven' ? 'opdracht' : 'speelt door', pt: b.status === 'toegegeven' ? 0 : null }],
      };
      // W6: de uitslag blijft staan tot je tikt
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
  S.view = 'sessie'; S.fout = null; S.uitlegStap = 0; S.envelop = 'dicht'; S.bevestig = null;
  render(); abonneer(); await ping(); await laadNu();
  clearInterval(pingTimer); pingTimer = setInterval(ping, 25000);
  pushKoppel();
}
function verlaat(msg) {
  if (kanaal) { sb.removeChannel(kanaal); kanaal = null; }
  clearInterval(pingTimer); ls.del('sessie');
  S.sid = null; S.sessie = null; S.missie = null; S.onthulling = null; S.sheet = null; S.uitslag = null; S.spelers = []; S.besch = []; S.bevestig = null;
  S.fout = msg || null; S.view = msg ? 'weg' : 'home';
  render();
}

// ---------- stempel-bonk (alleen tv/host) ----------
function bonk() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)(), t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.18);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.3);
  } catch {}
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
  soort: (el) => { const c = S.form.soorten, v = el.dataset.val; if (c.includes(v) && c.length === 1) return; S.form.soorten = c.includes(v) ? c.filter((x) => x !== v) : [...c, v]; },
  ctx: (el) => { const c = S.form.context, v = el.dataset.val; S.form.context = c.includes(v) ? c.filter((x) => x !== v) : [...c, v]; },
  punten: () => { S.form.punten = !S.form.punten; },
  installeer: async () => { const p = S.installPrompt; S.installPrompt = null; p?.prompt(); },
  maak: () => doe(async () => {
    const f = S.form;
    if (!f.hostNaam.trim()) throw new Error('naam_leeg');
    ls.set('naam', f.hostNaam.trim());
    const r = await rpc('maak_sessie', { p_naam: f.naam || null, p_host_naam: f.hostNaam, p_thema: f.thema, p_moeilijkheid: f.moeilijkheid, p_context: f.context.filter((c) => c !== 'versiering' || f.thema === 'kerst'), p_punten: f.punten, p_soorten: f.soorten });
    await betreed(r.sessie_id);
  }),
  join: () => joinMet(null),
  'join-nieuw': () => { S.sheet = null; joinMet('nieuw'); },
  'join-overname': () => { S.sheet = null; joinMet('overname'); },
  'overname-stop': () => { ls.del('overname'); S.overname = null; S.view = 'deelnemen'; },
  scan: () => startScan(),
  stopscan: () => stopScan(),
  'uitleg-volgende': () => { S.uitlegStap++; window.scrollTo(0, 0); },
  'uitleg-klaar': () => { S.uitlegStap = 5; S.envelop = 'dicht'; window.scrollTo(0, 0); },
  zegel: () => { if (S.envelop !== 'dicht' || S.envAnim) return; openEnvelop(); },
  'naar-missie': () => { ls.set(ceremonieKey(), true); },
  start: () => doe(() => rpc('start_spel', { p_sessie: S.sid })),
  menu: () => { S.sheet = { type: 'menu' }; },
  voltooid: () => { S.sheet = { type: 'voltooid', getuigen: [] }; },
  getuige: (el) => { const g = S.sheet.getuigen, id = el.dataset.id; S.sheet.getuigen = g.includes(id) ? g.filter((x) => x !== id) : [...g, id]; },
  'voltooid-ok': () => doe(async () => { await rpc('markeer_voltooid', { p_sessie: S.sid, p_getuigen: S.sheet.getuigen }); S.sheet = null; await laadMissie(); }),
  'voltooid-ongedaan': () => doe(async () => { await rpc('markeer_voltooid', { p_sessie: S.sid, p_getuigen: [], p_ongedaan: true }); await laadMissie(); }),
  'nieuwe-opdracht': () => { S.sheet = { type: 'nieuwe-opdracht' }; },
  'nieuwe-opdracht-ok': () => doe(async () => { await rpc('nieuwe_opdracht', { p_sessie: S.sid }); S.sheet = null; await laadMissie(); toast('Nieuwe opdracht', 'Je vorige is veilig. Houd je dossier vast om de nieuwe te lezen.', 4000); }),
  joker: () => { S.sheet = { type: 'joker' }; },
  'joker-ok': () => doe(async () => { await rpc('gebruik_joker', { p_sessie: S.sid }); S.sheet = null; await laadMissie(); toast('Nieuwe opdracht', 'Houd je kaart vast om hem te lezen.', 3500); }),
  betrap: (el) => doe(async () => { const r = await rpc('beschuldig', { p_sessie: S.sid, p_beschuldigde: el.dataset.id }); tril(TRIL.tik); await laadNu(); S.sheet = { type: 'open-besch', id: r.beschuldiging_id }; }),
  meedoen: (el) => doe(async () => { await rpc('meedoen', { p_beschuldiging: el.dataset.id }); await laadNu(); S.sheet = { type: 'open-besch', id: el.dataset.id }; }),
  'open-besch': (el) => { S.sheet = { type: 'open-besch', id: el.dataset.id }; },
  kies: (el) => { S.bevestig = { id: el.dataset.id, val: el.dataset.val }; },
  'kies-terug': () => { S.bevestig = null; },
  reageer: (el) => doe(async () => { await rpc('reageer', { p_beschuldiging: el.dataset.id, p_toegeven: el.dataset.val === 'ja' }); S.bevestig = null; await laadNu(); }),
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
  'toch-raak': (el) => doe(async () => { await rpc('host_toch_raak', { p_beschuldiging: el.dataset.id, p_raak: el.dataset.val === 'ja' }); if (el.dataset.val === 'ja') { bonk(); tril(TRIL.tik); } await laadNu(); }),
  'onthul-volgende': () => doe(() => rpc('onthul_stap', { p_sessie: S.sid, p_vooruit: true })),
  'onthul-vorige': () => doe(() => rpc('onthul_stap', { p_sessie: S.sid, p_vooruit: false })),
  'nieuwe-ronde': () => doe(() => rpc('nieuwe_ronde', { p_sessie: S.sid })),
  afsluiten: () => verlaat(),
  'meldingen-aan': () => { ls.set('meldingen.gevraagd', true); S.sheet = null; pushAan().then(render); },
  'meldingen-later': () => { ls.set('meldingen.gevraagd', true); S.sheet = null; },  scorebord: () => doe(() => rpc('naar_scorebord', { p_sessie: S.sid })),
  'missies-terug': () => { S.sheet = { type: 'missies' }; },
  'test-als': (el) => doe(async () => {
    if (el.dataset.id === ik()?.id) return;
    await rpc('test_wissel', { p_sessie: S.sid, p_speler: el.dataset.id });
    S.sheet = null; S.uitslag = null; S.missie = null; S.eersteLaad = true; S.gezien = new Set(); S.bevestig = null;
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
      if (r.status === 'goed') { ls.del('overname'); S.overname = null; ls.set('ceremonie.' + r.sessie_id + '.alle', true); return betreed(r.sessie_id); }
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
const VASTHOUD = '#leesstrook, #checkmissie, #envpapier.leesbaar';
function toonMissie(aan) {
  clearTimeout(leesTimer);
  S.vasthouden = aan;
  document.querySelectorAll(VASTHOUD).forEach((k) => k.classList.toggle('toon', aan));
  document.querySelectorAll('#missiekaart, .accused .acc-dossier').forEach((k) => k.classList.toggle('toon', aan));
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

// ---------- W4: pushmeldingen ----------
const pushKan = () => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
const pushStatus = () => (pushKan() ? Notification.permission : 'denied');
function b64urlNaarBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4), raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function pushAan() {
  if (!pushKan()) { toast('Meldingen werken hier niet', 'Op een iPhone werkt het alleen als de app op je beginscherm staat.', 6000); return; }
  try { if ((await Notification.requestPermission()) !== 'granted') { toast('Meldingen staan uit', 'Je kunt ze later aanzetten in de instellingen van je telefoon.', 5000); return; } } catch { return; }
  tril(TRIL.tik); await pushKoppel();
}
async function pushKoppel() {
  if (!S.sid || !CFG.vapidPublicKey || pushStatus() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlNaarBytes(CFG.vapidPublicKey) }));
    const j = sub.toJSON();
    await rpc('push_aanmelden', { p_sessie: S.sid, p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  } catch (e) { console.warn('push', e); }
}
// Een melding terwijl de app open is: alleen trillen (de service worker stuurt dit door)
navigator.serviceWorker?.addEventListener?.('message', (ev) => { if (ev.data?.soort === 'tril') { tril(ev.data.patroon || TRIL.betrapt); planLaad(); } });

// ---------- W13: terugknop sluit de app niet ----------
let terugKlaar = false;
function terugVangen() { if (terugKlaar) return; terugKlaar = true; try { history.pushState({ betrapt: 1 }, ''); } catch {} }
document.addEventListener('pointerdown', terugVangen, { capture: true });
window.addEventListener('popstate', () => {
  try { history.pushState({ betrapt: 1 }, ''); } catch {}
  if (S.sheet && S.sheet.type !== 'naambestaat') S.sheet = null;
  else if (S.uitslag) S.uitslag = null;
  else if (S.view === 'speluitleg') S.view = S.terug || 'home';
  else if (['nieuw', 'deelnemen', 'weg'].includes(S.view)) S.view = 'home';
  render();
});

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
