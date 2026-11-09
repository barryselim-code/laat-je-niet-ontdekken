// Laat je niet ontdekken! – PWA (vanilla JS, geen build-stap)
const CFG = window.TAFELAGENT_CONFIG || {};
const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const WACHT = 15;          // seconden wachttijd bij beschuldigen
const HOST_SLUIT = 120;    // host kan na 2 minuten sluiten
const $app = document.getElementById('app');

let sb = null, uid = null, kanaal = null, pingTimer = null, tikTimer = null, laadTimer = null;

const S = {
  view: 'laden', terug: 'home', fout: null, bezig: false,
  form: { naam: '', hostNaam: '', thema: 'kerst', moeilijkheid: 'gemengd', context: ['eten', 'drinken'], punten: true, code: '', spelerNaam: '' },
  sid: null, sessie: null, spelers: [], besch: [], deel: [], stemmen: [], overnames: [],
  missie: null, onthulling: null, tab: 'missie', offset: 0,
  sheet: null, toasts: [], gezien: new Set(), eersteLaad: true,
  vasthouden: false, renderWacht: false, introStap: 0, overname: null, installPrompt: null,
};

// ---------- hulpjes ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nu = () => Date.now() + S.offset;
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem('ta.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ta.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('ta.' + k); } catch {} },
};
const ik = () => S.spelers.find((p) => p.user_id === uid && !p.verwijderd);
const speler = (id) => S.spelers.find((p) => p.id === id);
const naam = (id) => speler(id)?.naam ?? 'Iemand';
const isHost = () => S.sessie && ik() && S.sessie.host_id === ik().id;
const actief = () => S.spelers.filter((p) => !p.verwijderd);
const restWacht = (b) => Math.max(0, WACHT - (nu() - new Date(b.laatste_meedoen).getTime()) / 1000);
const deelnemers = (bid) => S.deel.filter((d) => d.beschuldiging_id === bid).sort((a, b) => new Date(a.tijdstip) - new Date(b.tijdstip));
const doetMee = (bid) => !!ik() && S.deel.some((d) => d.beschuldiging_id === bid && d.speler_id === ik().id);
const openBesch = () => S.besch.filter((b) => b.status === 'open');
const plural = (n, een, meer) => `${n} ${n === 1 ? een : meer}`;

const FOUTEN = {
  niet_ingelogd: 'Geen verbinding met de server. Probeer het opnieuw.',
  naam_leeg: 'Vul je naam in.',
  code_onbekend: 'Deze code bestaat niet (meer). Check de letters.',
  sessie_gesloten: 'Dit spel is al afgelopen.',
  sessie_vol: 'Deze sessie zit vol (maximaal 20 spelers).',
  niet_host: 'Alleen de host kan dit.',
  al_gestart: 'Het spel is al gestart.',
  te_weinig_spelers: 'Je hebt minstens 3 spelers nodig.',
  geen_joker: 'Je joker is gebruikt of de 10 minuten zijn voorbij. Liet je per ongeluk je scherm zien? Vraag de host om een extra joker.',
  al_voltooid: 'Je missie is al voltooid.',
  ontmaskerd: 'Je bent ontmaskerd; je missie telt niet meer.',
  jezelf: 'Dat kan niet bij jezelf.',
  al_ontmaskerd: 'Deze speler is al ontmaskerd.',
  nog_wachten: 'Nog even wachten, de aftelling loopt nog.',
  al_afgerond: 'Deze beschuldiging is al afgerond.',
  pool_op: 'De missies zijn op. De host kan nieuwe missies importeren.',
  spel_loopt_niet: 'Het spel loopt nu niet.',
  geen_speler: 'Je zit niet (meer) in deze sessie.',
  nog_geheim: 'De missies zijn nog geheim.',
  geen_onthulling: 'De onthulling is niet bezig.',
  onbekende_speler: 'Die speler bestaat niet (meer).',
  host_niet_verwijderen: 'De host kan zichzelf niet verwijderen.',
  niet_beschuldigd: 'Deze beschuldiging gaat niet over jou.',
  onbekend: 'Niet gevonden.',
  code_kort: 'Vul de 4 letters van de code in.',
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

// iconen (lijn-SVG)
const I = {
  vraag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4"/><path d="M12 17h.01"/></svg>',
  terug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  ster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l2.6 6.1 6.6.5-5 4.3 1.6 6.4L12 16.4l-5.8 3.4 1.6-6.4-5-4.3 6.6-.5z"/></svg>',
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 12h8"/></svg>',
  oog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  vink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  wissel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
  wijs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  missie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
  tafel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M14.5 14.3c.8-.3 1.6-.5 2.5-.5 2.2 0 3.9 1.5 4.4 4"/></svg>',
  meer: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  duimOp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v9H4v-9zM7 11l4-7c1.4 0 2.3 1 2 2.4L12.5 10H18a2 2 0 0 1 2 2.3l-1.1 6A2 2 0 0 1 17 20H7"/></svg>',
  duimNeer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 13V4H4v9zM7 13l4 7c1.4 0 2.3-1 2-2.4L12.5 14H18a2 2 0 0 0 2-2.3l-1.1-6A2 2 0 0 0 17 4H7"/></svg>',
  kroon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>',
  vergrootglas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  masker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7c3-1 6-1 9 1 3-2 6-2 9-1 0 6-2.5 10-5.5 10-1.6 0-2.5-1.5-3.5-1.5S10.1 17 8.5 17C5.5 17 3 13 3 7z"/><circle cx="8.3" cy="10.5" r="1.2"/><circle cx="15.7" cy="10.5" r="1.2"/></svg>',
};

// ---------- render ----------
function render() {
  if (S.vasthouden) { S.renderWacht = true; return; }
  const thema = S.sessie?.thema || S.form.thema;
  document.body.dataset.thema = thema === 'kerst' ? 'kerst' : 'algemeen';
  const views = { laden: vLaden, home: vHome, nieuw: vNieuw, deelnemen: vDeelnemen, uitleg: vUitleg, overname: vOvernameWacht, intro: vIntro, sessie: vSessie, weg: vWeg };
  const actiefEl = document.activeElement;
  const focusId = actiefEl && actiefEl.id;
  const sel = focusId && actiefEl.selectionStart != null ? [actiefEl.selectionStart, actiefEl.selectionEnd] : null;
  $app.innerHTML = (views[S.view] || vHome)() + vOverlay() + vSheet() + vToasts();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {} }
  }
  if (S.view === 'sessie' && S.sessie?.status === 'lobby') tekenQR();
  tik();
}

function vLaden() {
  return `<main class="screen"><div class="center-msg"><div class="spinner" role="status" aria-label="Laden"></div></div></main>`;
}

function vHome() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
  return `<main class="screen home">
    <div class="home-top"><button class="iconbtn" data-a="view" data-v="uitleg" aria-label="Spelregels">${I.vraag}</button></div>
    <div class="home-hero">
      <span style="color:var(--accent);width:44px;height:44px;display:block">${I.ster}</span>
      <h1>Laat je niet ontdekken!</h1>
      <p>Iedereen aan tafel krijgt een geheime missie. Voer hem ongemerkt uit, en ontmasker de rest.</p>
      <span class="badge"><span class="dot"></span>Thema: Kerst</span>
    </div>
    <div class="home-actions">
      ${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}
      <button class="btn primary" data-a="view" data-v="nieuw">Nieuwe sessie</button>
      <button class="btn" data-a="view" data-v="deelnemen">Deelnemen met code</button>
      ${S.installPrompt ? `<button class="btn ghost small" data-a="installeer">App installeren</button>` : ''}
      <p class="foot-note">3 tot 20 spelers · één telefoon per persoon${ios ? '<br>Installeren: Deel-knop › Zet op beginscherm' : ''}</p>
    </div>
  </main>`;
}

function vNieuw() {
  const f = S.form;
  const pr = (b) => (b ? 'true' : 'false');
  const ctx = [['eten', 'Er wordt gegeten'], ['drinken', 'Er wordt gedronken'], ['kinderen', 'Kinderen aan tafel'], ['gastheer', 'Ik ben de gastheer']];
  return `<main class="screen">
    <div class="topbar"><button class="iconbtn" data-a="view" data-v="home" aria-label="Terug">${I.terug}</button><h1>Nieuwe sessie</h1></div>
    <div class="body">
      <div class="field"><label class="label" for="f-naam">Naam van de avond</label>
        <input class="input" id="f-naam" data-f="naam" value="${esc(f.naam)}" placeholder="Kerstavond 2026" maxlength="40" autocomplete="off"></div>
      <div class="field"><label class="label" for="f-host">Jouw naam aan tafel</label>
        <input class="input" id="f-host" data-f="hostNaam" value="${esc(f.hostNaam)}" placeholder="Bijv. Barry" maxlength="20" autocomplete="given-name"></div>
      <div class="field"><span class="label">Thema</span>
        <div class="choice-grid">
          <button class="choice" data-a="set" data-k="thema" data-val="kerst" aria-pressed="${pr(f.thema === 'kerst')}">${f.thema === 'kerst' ? '<span class="dot"></span>' : ''}Kerst</button>
          <button class="choice" data-a="set" data-k="thema" data-val="algemeen" aria-pressed="${pr(f.thema === 'algemeen')}">${f.thema === 'algemeen' ? '<span class="dot"></span>' : ''}Algemeen</button>
        </div></div>
      <div class="field"><span class="label">Moeilijkheid</span>
        <div class="seg">${['makkelijk', 'gemengd', 'moeilijk'].map((m) => `<button data-a="set" data-k="moeilijkheid" data-val="${m}" aria-pressed="${pr(f.moeilijkheid === m)}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div></div>
      <div class="field"><span class="label">Wat gebeurt er aan tafel?</span>
        <div class="chips">${ctx.map(([k, t]) => `<button class="chip" data-a="ctx" data-val="${k}" aria-pressed="${pr(f.context.includes(k))}">${t}</button>`).join('')}</div></div>
      <div class="toggle-row"><div><b>Punten tellen</b><span>Uit = alleen gehaald of niet</span></div>
        <button class="toggle" data-a="punten" aria-pressed="${pr(f.punten)}" aria-label="Punten tellen"></button></div>
      ${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}
    </div>
    <div class="foot"><button class="btn primary" data-a="maak" ${S.bezig ? 'disabled' : ''}>${S.bezig ? 'Bezig…' : 'Sessie openen'}</button></div>
  </main>`;
}

function vDeelnemen() {
  const f = S.form;
  const c = (f.code + '    ').slice(0, 4);
  return `<main class="screen">
    <div class="topbar"><button class="iconbtn" data-a="view" data-v="home" aria-label="Terug">${I.terug}</button><h1>Deelnemen</h1></div>
    <div class="body" style="gap:28px;padding-top:24px">
      <div class="field" style="gap:12px"><label class="label" for="c0">Code van de sessie</label>
        <div class="codeboxes">${[0, 1, 2, 3].map((i) => `<input class="codebox" id="c${i}" data-code="${i}" aria-label="Letter ${i + 1}" maxlength="1" inputmode="text" autocapitalize="characters" autocomplete="off" value="${esc(c[i].trim())}">`).join('')}</div>
        ${S.scannen ? `<video class="scan" id="scan" playsinline muted></video><button class="btn small" data-a="stopscan">Stoppen met scannen</button>`
          : `<button class="btn small" data-a="scan">${I.scan}Scan de QR-code</button>`}
      </div>
      <div class="field"><label class="label" for="f-sp">Je naam aan tafel</label>
        <input class="input" id="f-sp" data-f="spelerNaam" value="${esc(f.spelerNaam)}" placeholder="Bijv. Fleur" maxlength="20" autocomplete="given-name">
        <span class="hint">Zo heet je in de lijst en bij de onthulling.</span></div>
      ${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}
    </div>
    <div class="foot"><button class="btn primary" data-a="join" ${S.bezig ? 'disabled' : ''}>${S.bezig ? 'Bezig…' : 'Aanschuiven'}</button></div>
  </main>`;
}

function vOvernameWacht() {
  return `<main class="screen"><div class="center-msg">
    <div class="spinner" role="status"></div>
    <h2>Wachten op de host</h2>
    <p>De host moet bevestigen dat jij ${esc(S.overname?.naam)} bent op een nieuw toestel.</p>
    <button class="btn ghost small" data-a="overname-stop" style="width:auto">Annuleren</button>
  </div></main>`;
}

function vWeg() {
  return `<main class="screen"><div class="center-msg">
    <h2>${esc(S.fout || 'Je zit niet meer in deze sessie')}</h2>
    <button class="btn primary" data-a="naar-home" style="max-width:280px">Naar het begin</button>
  </div></main>`;
}

const INTRO = [
  ['Je krijgt een geheime missie', 'Voer hem ongemerkt uit vanaf je stoel. Houd je scherm vast om je missie te zien; loslaten verbergt hem weer.'],
  ['Verdenk je iemand?', 'Druk op Beschuldig naast zijn naam en zeg hardop wat je denkt dat zijn missie is. Anderen kunnen meedoen.'],
  ['Blijf onder de radar', 'Ook na voltooien kun je nog ontmaskerd worden. Aan het eind onthult de app alle missies.'],
];
function vIntro() {
  const i = S.introStap, [t, p] = INTRO[i];
  return `<main class="screen">
    <div class="topbar" style="justify-content:flex-end"><button class="btn ghost small" style="width:auto" data-a="intro-klaar">Overslaan</button></div>
    <div class="intro"><span class="num">${i + 1} van 3</span><h2>${t}</h2><p>${p}</p></div>
    <div class="foot"><div class="dots" aria-hidden="true">${INTRO.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('')}</div>
      <button class="btn primary" data-a="${i < 2 ? 'intro-volgende' : 'intro-klaar'}">${i < 2 ? 'Volgende' : 'Begrepen'}</button></div>
  </main>`;
}

function vUitleg() {
  return `<main class="screen">
    <div class="topbar"><button class="iconbtn" data-a="uitleg-terug" aria-label="Terug">${I.terug}</button><h1>Spelregels</h1></div>
    <article class="uitleg">
      <p>Iedereen aan tafel krijgt een unieke geheime missie die je ongemerkt vanaf je stoel uitvoert. Wie betrapt wordt, verliest zijn missie; wie hem haalt zonder ontmaskerd te worden, scoort.</p>
      <h2>Verloop van een avond</h2>
      <ol><li>De host maakt een sessie aan en kiest thema en moeilijkheid.</li>
        <li>Spelers doen mee met de code of QR-code en vullen hun naam in.</li>
        <li>De host start het spel; iedereen krijgt tegelijk een unieke missie.</li>
        <li>Je mag één keer je missie wisselen (joker) in de eerste 10 minuten.</li>
        <li>Voer je missie uit en tik op Voltooid zodra het gelukt is.</li>
        <li>Verdenk je iemand, druk dan op Beschuldig naast zijn naam; anderen kunnen meedoen.</li>
        <li>De host beëindigt het spel; de app onthult alle missies één voor één.</li></ol>
      <h2>Voltooien</h2>
      <ul><li>Je tikt zelf op Voltooid en kiest eventueel wie er getuige of slachtoffer was.</li>
        <li>Bij de onthulling stemt de tafel met duim omhoog of omlaag of het echt gebeurd is. Meer duimen omlaag dan omhoog: punten vervallen.</li>
        <li>Na voltooien ben je niet veilig: tot het einde kun je nog ontmaskerd worden.</li></ul>
      <h2>Beschuldigen en meedoen</h2>
      <ol><li>Druk op Beschuldig naast iemands naam en zeg hardop wat je denkt dat zijn missie is.</li>
        <li>Iedereen krijgt een melding en kan meedoen.</li>
        <li>Na elke beschuldiging en elke meedoener loopt een wachttijd van 15 seconden opnieuw, zodat er ruimte is voor discussie.</li>
        <li>Daarna kiest de beschuldigde: Toegeven (ontmaskerd, missie mislukt) of Afwijzen (speelt door).</li></ol>
      <h2>Wanneer klopt een beschuldiging?</h2>
      <p>Als het hardop genoemde vermoeden de kern van de missie raakt; letterlijk hoeft niet. De beschuldigde beoordeelt dit zelf. Bij de onthulling ziet iedereen elke afgewezen beschuldiging naast de echte missie, dus liegen valt alsnog op.</p>
      <p class="example">Voorbeeld: is de missie "leg mes en vork omgewisseld tot het eerste gerecht op je bord ligt" en zegt iemand "jouw vork ligt aan de verkeerde kant", dan ben je ontmaskerd.</p>
      <h2>Punten</h2>
      <table><tbody>
        <tr><td>Missie voltooid (makkelijk / normaal / moeilijk)</td><td>+1 / +2 / +3</td></tr>
        <tr><td>Eerste beschuldiger, beschuldiging klopt</td><td>+2</td></tr>
        <tr><td>Meedoener, beschuldiging klopt</td><td>+1</td></tr>
        <tr><td>Eerste beschuldiger, klopt niet</td><td>−2</td></tr>
        <tr><td>Meedoener, klopt niet</td><td>−1</td></tr>
        <tr><td>Zelf ontmaskerd</td><td>0 voor je missie</td></tr>
      </tbody></table>
      <p>Wie de meeste punten heeft, is Topagent van de avond.</p>
    </article>
  </main>`;
}

// ----- in een sessie -----
function vSessie() {
  const s = S.sessie;
  if (!s) return vLaden();
  if (s.status === 'lobby') return vLobby();
  if (s.status === 'spel') return vSpel();
  if (s.status === 'onthulling') return isHost() ? vOnthullingHost() : vOnthullingSpeler();
  return vScorebord();
}

function hostBanners() {
  if (!isHost()) return '';
  let h = '';
  for (const o of S.overnames.filter((x) => x.status === 'open')) {
    h += `<div class="banner"><p><b>${esc(naam(o.speler_id))}</b> wil verder op een nieuw toestel.</p>
      <button class="pill-btn" data-a="overname-ja" data-id="${o.id}">Goed</button>
      <button class="pill-btn" data-a="overname-nee" data-id="${o.id}" aria-label="Weigeren">Nee</button></div>`;
  }
  if (S.sessie.host_melding) {
    h += `<div class="banner"><p>${esc(S.sessie.host_melding)}</p><button class="pill-btn" data-a="melding-weg">Oké</button></div>`;
  }
  return h;
}

function vLobby() {
  const s = S.sessie, me = ik(), host = isHost(), sp = actief();
  return `<main class="screen">
    <div class="topbar" style="padding:20px 24px 8px"><h1><span class="sub">Lobby</span>${esc(s.naam)}</h1>
      ${host ? '<span class="badge">Host</span>' : ''}
      <button class="iconbtn" data-a="view-uitleg" aria-label="Spelregels">${I.vraag}</button></div>
    ${hostBanners()}
    <div class="codecard">
      <div class="qr" id="qr" role="img" aria-label="QR-code om deel te nemen"></div>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
        <span class="hint" style="color:var(--muted)">Code</span>
        <span class="bigcode">${esc(s.code)}</span>
        <span class="hint">Scan, of typ de code in de app</span>
      </div>
    </div>
    <div class="section-head"><h2>Aan tafel</h2><span>${plural(sp.length, 'speler', 'spelers')}</span></div>
    <div class="list" style="flex-grow:1">
      ${sp.map((p) => `<div class="row"><span class="avatar">${esc(p.naam[0]?.toUpperCase())}</span>
        <span class="name">${esc(p.naam)}</span>
        <span class="tag">${p.id === s.host_id ? 'host' : ''}${p.id === me?.id ? (p.id === s.host_id ? ' · jij' : 'jij') : ''}</span>
        ${host && p.id !== me?.id ? `<button class="iconbtn" data-a="spelermenu" data-id="${p.id}" aria-label="Opties voor ${esc(p.naam)}">${I.meer}</button>` : ''}</div>`).join('')}
      ${sp.length < 20 ? `<div class="row wait"><span class="avatar"></span>Wachten op meer spelers…</div>` : ''}
    </div>
    <div class="foot">
      ${S.fout ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}
      ${host ? `<button class="btn primary" data-a="start" ${sp.length < 3 || S.bezig ? 'disabled' : ''}>${S.bezig ? 'Missies uitdelen…' : 'Start het spel'}</button>
        <p class="foot-note">${sp.length < 3 ? `Nog ${3 - sp.length} speler${3 - sp.length === 1 ? '' : 's'} nodig.` : 'Iedereen krijgt tegelijk een missie.'}</p>`
        : `<div class="row wait" style="justify-content:center"><div class="spinner" style="width:18px;height:18px;border-width:2px"></div>Wachten op de host…</div>`}
    </div>
  </main>`;
}

function vSpel() {
  const s = S.sessie, nOpen = openBesch().filter((b) => b.beschuldigde_id !== ik()?.id).length;
  return `<main class="screen">
    <div class="topbar" style="padding:12px 12px 4px 24px"><h1><span class="sub">${isHost() ? 'Host · ' : ''}${esc(s.code)}</span>${esc(s.naam)}</h1>
      <button class="iconbtn" data-a="view-uitleg" aria-label="Spelregels">${I.vraag}</button></div>
    ${hostBanners()}
    ${S.tab === 'missie' ? vMissieTab() : vTafelTab()}
    <nav class="tabbar" role="tablist">
      <button role="tab" aria-selected="${S.tab === 'missie'}" data-a="tab" data-v="missie">${I.missie}Missie</button>
      <button role="tab" aria-selected="${S.tab === 'tafel'}" data-a="tab" data-v="tafel">${I.tafel}Tafel${nOpen ? `<span class="count">${nOpen}</span>` : ''}</button>
    </nav>
  </main>`;
}

function vMissieTab() {
  const m = S.missie, me = ik();
  if (!m) return `<div class="missie-wrap"><div class="center-msg"><div class="spinner"></div></div></div>`;
  if (!m.heeft_missie) return `<div class="missie-wrap"><div class="missie-kaart status-kaart"><h2>Nog geen missie</h2><p>${esc(S.fout || 'Even geduld…')}</p></div></div>`;
  if (me?.ontmaskerd) {
    return `<div class="missie-wrap"><div class="missie-kaart status-kaart">
      <span style="color:var(--bad);width:44px;height:44px">${I.masker}</span>
      <h2>Ontmaskerd</h2><p>Je missie is mislukt. Je kunt nog wel anderen beschuldigen en meedoen.</p></div>
      <button class="btn" data-a="tab" data-v="tafel">${I.wijs}Naar de tafel</button></div>`;
  }
  const jokerTot = new Date(m.joker_tot).getTime();
  const jokerKan = !m.voltooid && (m.gratis_wissel || m.joker_extra || (!m.joker_gebruikt && nu() < jokerTot));
  const jokerSub = m.gratis_wissel ? 'gratis' : m.joker_extra ? 'extra' : m.joker_gebruikt ? 'gebruikt' : nu() < jokerTot ? `<span data-jokertot="${jokerTot}">${fmtMin(jokerTot - nu())}</span>` : 'voorbij';
  return `<div class="missie-wrap">
    ${m.gratis_wissel ? `<div class="banner" style="margin:0"><p>Je doelwit is vertrokken. Je mag gratis wisselen.</p></div>` : ''}
    <div class="missie-kaart" id="missiekaart" tabindex="0" aria-label="Houd vast om je missie te zien">
      <div class="missie-dicht" aria-hidden="true">
        <div class="lines"><span style="width:90%"></span><span style="width:75%"></span><span style="width:82%"></span></div>
        <span style="width:28px;height:28px">${I.oog}</span>
        <b>${m.voltooid ? 'Missie voltooid' : 'Houd vast om je missie te zien'}</b>
        <span style="font-size:14px">${m.voltooid ? 'Blijf onder de radar: je kunt nog ontmaskerd worden.' : 'Loslaten verbergt hem weer.'}</span>
      </div>
      <div class="missie-open">
        <span class="meta"><span>${['', 'Makkelijk', 'Normaal', 'Moeilijk'][m.moeilijkheid] || ''}</span>${m.voltooid ? '<span>· voltooid</span>' : ''}</span>
        <p class="missie-tekst">${esc(m.tekst)}</p>
        ${m.uitleg ? `<p class="missie-uitleg">${esc(m.uitleg)}</p>` : ''}
      </div>
    </div>
    <div class="actions3">
      ${m.voltooid
        ? `<button class="act" data-a="voltooid-ongedaan">${I.wissel}Ongedaan<small>per ongeluk?</small></button>`
        : `<button class="act primary" data-a="voltooid">${I.vink}Voltooid</button>`}
      <button class="act" data-a="joker" ${jokerKan ? '' : 'disabled'}>${I.wissel}Joker<small>${jokerSub}</small></button>
      <button class="act" data-a="tab" data-v="tafel">${I.wijs}Beschuldig</button>
    </div>
  </div>`;
}
const fmtMin = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `nog ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function vBeschKaart(b) {
  const d = deelnemers(b.id), me = ik();
  const eerste = d.find((x) => x.rol === 'eerste');
  const mee = d.filter((x) => x.rol === 'meedoener');
  const rest = restWacht(b), ikMee = doetMee(b.id), tegenMij = b.beschuldigde_id === me?.id;
  const lang = (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT;
  return `<div class="besch ${ikMee ? 'mij' : ''}">
    <div class="besch-top"><p><b>${esc(naam(eerste?.speler_id ?? b.eerste_beschuldiger_id))}</b> beschuldigt <b>${esc(tegenMij ? 'jou' : naam(b.beschuldigde_id))}</b></p>
      <span class="timer" data-wacht="${b.id}">${rest > 0 ? Math.ceil(rest) + 's' : ''}</span></div>
    <div class="timerbar"><i data-wachtbar="${b.id}" style="width:${(rest / WACHT) * 100}%"></i></div>
    <span class="who">${mee.length ? 'Doen mee: ' + mee.map((x) => esc(naam(x.speler_id))).join(', ') : 'Nog niemand doet mee'}${rest <= 0 ? ` · ${esc(tegenMij ? 'jij' : naam(b.beschuldigde_id))} kiest nu` : ''}</span>
    ${!ikMee && !tegenMij ? `<button class="btn small primary" data-a="meedoen" data-id="${b.id}">Meedoen</button>` : ''}
    ${isHost() && lang && !tegenMij ? `<button class="btn small ghost" data-a="host-sluit" data-id="${b.id}">Geen reactie? Sluit als afgewezen</button>` : ''}
  </div>`;
}

function vTafelTab() {
  const me = ik(), open = openBesch(), host = isHost();
  const openVoor = (id) => open.find((b) => b.beschuldigde_id === id);
  const sp = actief().slice().sort((a, b) => (a.id === me?.id) - (b.id === me?.id) || a.ontmaskerd - b.ontmaskerd || a.volgnr - b.volgnr);
  return `<div style="flex-grow:1;padding-bottom:16px">
    ${open.length ? `<div class="section-head" style="padding-top:12px"><h2>Lopende beschuldigingen</h2><span>${open.length}</span></div>${open.map(vBeschKaart).join('')}` : ''}
    <div class="section-head" style="padding-top:${open.length ? 16 : 12}px"><h2>Aan tafel</h2>${S.sessie.punten_aan ? '<span>punten</span>' : ''}</div>
    <div class="list">
      ${sp.map((p) => {
        const b = openVoor(p.id), zelf = p.id === me?.id;
        let knop = '';
        if (!zelf && !p.ontmaskerd) {
          if (b) knop = doetMee(b.id) ? `<span class="tag">je doet mee</span>` : `<button class="pill-btn join" data-a="meedoen" data-id="${b.id}">Meedoen</button>`;
          else knop = `<button class="pill-btn" data-a="beschuldig" data-id="${p.id}">Beschuldig</button>`;
        }
        return `<div class="row ${p.ontmaskerd ? 'dim' : ''}"><span class="avatar">${esc(p.naam[0]?.toUpperCase())}</span>
          <span class="name">${esc(p.naam)}${zelf ? ' <span class="tag">(jij)</span>' : ''}${p.ontmaskerd ? ' <span class="tag">ontmaskerd</span>' : ''}</span>
          ${S.sessie.punten_aan ? `<span class="tag" style="font-variant-numeric:tabular-nums">${p.punten_beschuldiging > 0 ? '+' : ''}${p.punten_beschuldiging || ''}</span>` : ''}
          ${knop}
          ${host && !zelf ? `<button class="iconbtn" data-a="spelermenu" data-id="${p.id}" aria-label="Opties voor ${esc(p.naam)}">${I.meer}</button>` : ''}</div>`;
      }).join('')}
    </div>
    ${host ? `<div class="foot" style="padding-top:24px"><button class="btn danger small" data-a="beeindig">Spel beëindigen en onthullen</button>
      <p class="foot-note">Iedereen ziet daarna alle missies.</p></div>` : ''}
  </div>`;
}

// Volledig scherm voor de beschuldigde
function vOverlay() {
  if (S.view !== 'sessie' || S.sessie?.status !== 'spel') return '';
  const me = ik();
  const b = me && openBesch().find((x) => x.beschuldigde_id === me.id);
  if (!b) { vOverlay.laatste = null; return ''; }
  const d = deelnemers(b.id), rest = restWacht(b);
  const eerste = d.find((x) => x.rol === 'eerste'), mee = d.filter((x) => x.rol === 'meedoener');
  const omtrek = 2 * Math.PI * 80;
  const lang = (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT;
  const nieuw = vOverlay.laatste !== b.id; vOverlay.laatste = b.id;
  return `<div class="accused ${nieuw ? 'anim' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="acc-t">
    <div class="inner">
      <span class="eyebrow">Je wordt beschuldigd</span>
      <h2 id="acc-t">${esc(naam(eerste?.speler_id ?? b.eerste_beschuldiger_id))} beschuldigt jou${mee.length ? `, ${plural(mee.length, 'ander doet', 'anderen doen')} mee` : ''}</h2>
      <p style="margin:0;color:var(--muted)">Luister naar wat er hardop gezegd wordt. Raakt het de kern van je missie, dan geef je toe.</p>
      <div class="ring" aria-live="polite">
        <svg viewBox="0 0 180 180" aria-hidden="true"><circle cx="90" cy="90" r="80" fill="none" stroke="var(--line)" stroke-width="8"/>
          <circle data-ring="${b.id}" cx="90" cy="90" r="80" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${omtrek}" stroke-dashoffset="${omtrek * (1 - rest / WACHT)}"/></svg>
        <b data-wacht-groot="${b.id}">${rest > 0 ? Math.ceil(rest) : '0'}</b>
      </div>
      <span class="hint" style="text-align:center">${mee.length ? 'Doen mee: ' + mee.map((x) => esc(naam(x.speler_id))).join(', ') : 'Anderen kunnen nog meedoen'}</span>
      <div class="grow"></div>
      ${rest > 0
        ? `<p class="foot-note">Over ${Math.ceil(rest)} seconden kies je: toegeven of afwijzen. Elke meedoener start de tijd opnieuw.</p>`
        : `${lang ? '<p class="foot-note" style="color:var(--accent)">Iedereen wacht op jou. Kies nu.</p>' : ''}
           <div class="two"><button class="btn" data-a="reageer" data-id="${b.id}" data-val="nee">Afwijzen</button>
           <button class="btn primary" data-a="reageer" data-id="${b.id}" data-val="ja">Toegeven</button></div>`}
    </div>
  </div>`;
}

// ----- onthulling -----
function huidigeOnthulling() {
  const s = S.sessie, id = s.onthul_volgorde?.[s.onthul_index];
  return { id, data: S.onthulling?.find((x) => x.speler_id === id), stap: s.onthul_stap, n: s.onthul_volgorde?.length || 0, i: s.onthul_index };
}
function verdict(o) {
  if (o.ontmaskerd) return ['bad', 'Betrapt'];
  if (o.voltooid) return ['good', 'Gehaald'];
  return ['meh', 'Niet gelukt'];
}
function stemTelling(id) {
  const st = S.stemmen.filter((x) => x.speler_id === id);
  return { op: st.filter((x) => x.duim).length, neer: st.filter((x) => !x.duim).length };
}
function revealAnim() {
  const k = S.sessie.onthul_index + S.sessie.onthul_stap;
  const nieuw = revealAnim.laatste !== k; revealAnim.laatste = k;
  return nieuw ? 'anim' : '';
}
function vOnthullingInhoud(o, stap, groot) {
  if (!o) return `<div class="center-msg"><div class="spinner"></div></div>`;
  if (stap === 'naam') {
    return `<span class="eyebrow">Wat was de missie van</span><h2 class="naam">${esc(o.naam)}</h2>
      ${groot ? '<p class="uitleg">Tik om te onthullen</p>' : ''}`;
  }
  const [cls, txt] = verdict(o), t = stemTelling(o.speler_id);
  return `<span class="eyebrow">${esc(o.naam)}</span>
    <p class="tekst">${esc(o.tekst)}</p>
    <span class="verdict ${cls}">${txt}</span>
    <div class="facts">
      ${o.getuige ? `<span>Getuige of slachtoffer: ${esc(o.getuige)}</span>` : ''}
      ${o.afgewezen.map((a) => `<span>Wees een beschuldiging af${a.door ? ` van ${esc(a.door)}` : ''}${a.mee > 0 ? ` (+${a.mee})` : ''}${a.door_host ? ', gesloten door de host' : ''}</span>`).join('')}
    </div>
    ${o.voltooid && !o.ontmaskerd ? `<div class="votes" aria-label="Stemmen"><span style="color:var(--good)">${I.duimOp}${t.op}</span><span style="color:var(--bad)">${I.duimNeer}${t.neer}</span></div>
      ${groot ? '<p class="uitleg">Is het echt gebeurd? Stem op je telefoon.</p>' : ''}` : ''}`;
}
function vOnthullingHost() {
  const { data, stap, n, i } = huidigeOnthulling();
  const laatste = i >= n - 1 && stap === 'missie';
  return `<main class="reveal">
    <div class="reveal-top"><span>Onthulling · ${Math.min(i + 1, n)} van ${n}</span><span>${esc(S.sessie.naam)}</span></div>
    <div class="reveal-main ${revealAnim()} ${stap === 'naam' ? 'reveal-tap' : ''}" ${stap === 'naam' ? 'data-a="onthul-volgende" role="button" tabindex="0"' : ''}>${vOnthullingInhoud(data, stap, true)}</div>
    <div class="reveal-foot">
      <button class="btn" data-a="onthul-vorige" ${i === 0 && stap === 'naam' ? 'disabled' : ''}>Vorige</button>
      ${laatste ? `<button class="btn primary" data-a="scorebord">Naar het scorebord</button>`
        : `<button class="btn primary" data-a="onthul-volgende">${stap === 'naam' ? 'Onthul missie' : 'Volgende speler'}</button>`}
    </div>
  </main>`;
}
function vOnthullingSpeler() {
  const { data, stap, n, i } = huidigeOnthulling(), me = ik();
  const magStemmen = data && stap === 'missie' && data.voltooid && !data.ontmaskerd && data.speler_id !== me?.id;
  const mijn = S.stemmen.find((x) => x.speler_id === data?.speler_id && x.stemmer_id === me?.id);
  return `<main class="screen">
    <div class="topbar" style="padding:12px 24px 4px"><h1><span class="sub">Onthulling · ${Math.min(i + 1, n)} van ${n}</span>${esc(S.sessie.naam)}</h1></div>
    <div class="reveal-main ${revealAnim()}" style="padding:24px">${vOnthullingInhoud(data, stap, false)}</div>
    <div class="foot">
      ${magStemmen ? `<p class="foot-note" style="font-size:15px;color:var(--text)">Is het echt gebeurd?</p>
        <div class="thumbs">
          <button class="thumb up" data-a="stem" data-val="ja" aria-pressed="${mijn?.duim === true}">${I.duimOp}Ja</button>
          <button class="thumb down" data-a="stem" data-val="nee" aria-pressed="${mijn?.duim === false}">${I.duimNeer}Nee</button></div>`
        : `<p class="foot-note">${stap === 'naam' ? 'Kijk mee op het scherm van de host.' : data?.speler_id === me?.id ? 'Dit is jouw missie. De anderen stemmen.' : 'Kijk mee op het scherm van de host.'}</p>`}
    </div>
  </main>`;
}

function vScorebord() {
  const sp = actief().slice().sort((a, b) => (b.eindscore ?? 0) - (a.eindscore ?? 0) || a.volgnr - b.volgnr);
  const punten = S.sessie.punten_aan;
  const top = sp[0];
  const titels = [];
  if (punten && top) titels.push([I.kroon, 'Topagent van de avond', sp.filter((p) => p.eindscore === top.eindscore).map((p) => p.naam).join(' en ')]);
  const goed = {};
  S.deel.filter((d) => d.punten > 0).forEach((d) => { goed[d.speler_id] = (goed[d.speler_id] || 0) + 1; });
  const max = Math.max(0, ...Object.values(goed));
  if (max > 0) titels.push([I.vergrootglas, 'Scherpste speurder', Object.keys(goed).filter((k) => goed[k] === max).map(naam).join(' en ') + ` (${plural(max, 'keer', 'keer')} raak)`]);
  const verdacht = new Set(S.besch.map((b) => b.beschuldigde_id));
  const stil = sp.filter((p) => p.missie_gehaald && !verdacht.has(p.id));
  if (stil.length) titels.push([I.masker, 'Meester der vermomming', stil.map((p) => p.naam).join(', ') + ' (nooit verdacht)']);
  return `<main class="screen">
    <div class="topbar" style="padding:16px 24px 4px"><h1><span class="sub">Einde</span>${esc(S.sessie.naam)}</h1></div>
    <div class="podium"><span class="crown">${I.kroon}</span>
      ${punten && top ? `<h2>${esc(top.naam)}</h2><p>Topagent van de avond · ${top.eindscore} punten</p>` : `<h2>Het spel is uit</h2><p>${sp.filter((p) => p.missie_gehaald).length} van de ${sp.length} missies gehaald</p>`}</div>
    ${titels.length ? `<div class="titles">${titels.map(([ic, t, w]) => `<div class="title-card">${ic}<div><b>${t}</b><span>${esc(w)}</span></div></div>`).join('')}</div>` : ''}
    <div class="section-head"><h2>${punten ? 'Ranglijst' : 'Resultaat'}</h2></div>
    <div class="list" style="flex-grow:1">
      ${sp.map((p, i) => `<div class="row"><span class="rank">${punten ? i + 1 : ''}</span><span class="avatar">${esc(p.naam[0]?.toUpperCase())}</span>
        <span class="name">${esc(p.naam)}<br><span class="tag">${p.missie_gehaald ? 'Missie gehaald' : p.ontmaskerd ? 'Ontmaskerd' : 'Missie niet gehaald'}${punten ? ` · beschuldigen ${p.punten_beschuldiging > 0 ? '+' : ''}${p.punten_beschuldiging}` : ''}</span></span>
        ${punten ? `<span class="score">${p.eindscore ?? 0}</span>` : `<span style="color:${p.missie_gehaald ? 'var(--good)' : 'var(--faint)'};width:22px">${p.missie_gehaald ? I.vink : ''}</span>`}</div>`).join('')}
    </div>
    <div class="foot"><button class="btn" data-a="missies-terug">Alle missies terugzien</button><button class="btn primary" data-a="naar-home">Nieuw spel</button></div>
  </main>`;
}

// ----- sheets en toasts -----
function vSheet() {
  const sh = S.sheet;
  if (!sh) { vSheet.laatste = null; return ''; }
  let inner = '';
  if (sh.type === 'voltooid') {
    const me = ik();
    inner = `<h2>Missie voltooid?</h2><p>Kies eventueel wie er getuige of slachtoffer was. Dat helpt bij de onthulling.</p>
      <div class="list" style="gap:6px">${actief().filter((p) => p.id !== me?.id).map((p) => `<button class="btn small pick" data-a="getuige" data-id="${p.id}" aria-pressed="${sh.getuige === p.id}">${esc(p.naam)}</button>`).join('')}</div>
      <button class="btn primary" data-a="voltooid-ok">Ja, voltooid</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'joker') {
    inner = `<h2>Missie wisselen?</h2><p>${S.missie?.gratis_wissel ? 'Je doelwit is vertrokken, dus deze wissel is gratis.' : 'Je krijgt een nieuwe missie. Je oude komt niet terug in het spel. Dit kan maar één keer.'}</p>
      <button class="btn primary" data-a="joker-ok">Wissel mijn missie</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'beschuldig') {
    inner = `<h2>${esc(naam(sh.id))} beschuldigen?</h2><p>Zeg hardop wat je denkt dat de missie is. Klopt het niet, dan kost het je 2 punten.</p>
      <button class="btn primary" data-a="beschuldig-ok" data-id="${sh.id}">Beschuldig ${esc(naam(sh.id))}</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'melding') {
    const b = S.besch.find((x) => x.id === sh.id);
    if (!b || b.status !== 'open' || doetMee(b.id)) { S.sheet = null; return ''; }
    inner = `<h2>${esc(naam(b.eerste_beschuldiger_id))} beschuldigt ${esc(naam(b.beschuldigde_id))}</h2>
      <p>Denk jij het ook? Doe mee. Klopt het, dan krijg je 1 punt; zo niet, dan kost het 1 punt.</p>
      <button class="btn primary" data-a="meedoen" data-id="${b.id}">Meedoen</button><button class="btn ghost" data-a="sheet-dicht">Niet meedoen</button>`;
  } else if (sh.type === 'spelermenu') {
    const p = speler(sh.id);
    const inSpel = S.sessie.status === 'spel';
    inner = `<h2>${esc(p?.naam)}</h2>
      ${inSpel ? `<button class="btn" data-a="extra-joker" data-id="${sh.id}">Extra joker geven</button><p class="hint">Bijvoorbeeld als iemand per ongeluk zijn scherm liet zien.</p>` : ''}
      <button class="btn danger" data-a="verwijder" data-id="${sh.id}">Verwijderen uit de sessie</button>
      <button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'beeindig') {
    inner = `<h2>Spel beëindigen?</h2><p>Lopende beschuldigingen vervallen en de onthulling begint. Dit kan niet terug.</p>
      <button class="btn primary" data-a="beeindig-ok">Beëindigen en onthullen</button><button class="btn ghost" data-a="sheet-dicht">Annuleren</button>`;
  } else if (sh.type === 'naambestaat') {
    inner = `<h2>${esc(sh.naam)} zit al aan tafel</h2><p>Ben jij dat, op een nieuw toestel (bijvoorbeeld omdat je telefoon leeg is)?</p>
      <button class="btn primary" data-a="join-overname">Ja, ik ben ${esc(sh.naam)}</button>
      <button class="btn" data-a="join-nieuw">Nee, ik ben iemand anders</button>`;
  } else if (sh.type === 'missies') {
    inner = `<h2>Alle missies</h2>${(S.onthulling || []).map((o) => { const [c, t] = verdict(o); return `<div class="card" style="padding:16px;display:flex;flex-direction:column;gap:6px"><b>${esc(o.naam)} <span class="tag" style="color:var(--${c === 'good' ? 'good' : c === 'bad' ? 'bad' : 'faint'})">· ${t}</span></b><span style="color:var(--muted);font-size:15px">${esc(o.tekst)}</span></div>`; }).join('')}
      <button class="btn ghost" data-a="sheet-dicht">Sluiten</button>`;
  }
  const key = sh.type + (sh.id || '');
  const nieuw = key !== vSheet.laatste; vSheet.laatste = key;
  return `<div class="scrim ${nieuw ? 'anim' : ''}" data-a="scrim"><div class="sheet" role="dialog" aria-modal="true">${inner}${S.fout && S.sheet ? `<p class="error" role="alert">${esc(S.fout)}</p>` : ''}</div></div>`;
}

function vToasts() {
  if (!S.toasts.length) return '';
  const nieuw = (id) => { if (vToasts.gezien.has(id)) return ''; vToasts.gezien.add(id); return 'anim'; };
  return `<div class="toasts" aria-live="polite">${S.toasts.map((t) => `<button class="toast ${nieuw(t.id)}" data-a="toast" data-id="${t.id}"><b>${esc(t.titel)}</b>${t.tekst ? `<span class="pts">${esc(t.tekst)}</span>` : ''}</button>`).join('')}</div>`;
}
vToasts.gezien = new Set();
function toast(titel, tekst = '', ms = 6000) {
  const id = Math.random().toString(36).slice(2);
  S.toasts.push({ id, titel, tekst });
  setTimeout(() => { S.toasts = S.toasts.filter((t) => t.id !== id); render(); }, ms);
  render();
}

// ---------- QR en timers ----------
function tekenQR() {
  const el = document.getElementById('qr');
  if (!el || !window.maakQR) return;
  const url = location.origin + location.pathname.replace(/index\.html$/, '') + '?code=' + S.sessie.code;
  el.innerHTML = window.maakQR(url);
}

let wasNul = new Set();
function tik() {
  clearTimeout(tikTimer);
  if (S.view !== 'sessie' || S.sessie?.status !== 'spel') return;
  let rerender = false;
  for (const b of openBesch()) {
    const rest = restWacht(b), t = rest > 0 ? Math.ceil(rest) : 0;
    document.querySelectorAll(`[data-wacht="${b.id}"]`).forEach((e) => (e.textContent = t ? t + 's' : ''));
    document.querySelectorAll(`[data-wacht-groot="${b.id}"]`).forEach((e) => (e.textContent = t));
    document.querySelectorAll(`[data-wachtbar="${b.id}"]`).forEach((e) => (e.style.width = (rest / WACHT) * 100 + '%'));
    document.querySelectorAll(`[data-ring="${b.id}"]`).forEach((e) => { const o = 2 * Math.PI * 80; e.setAttribute('stroke-dashoffset', o * (1 - rest / WACHT)); });
    const key = b.id + b.laatste_meedoen;
    if (rest <= 0 && !wasNul.has(key)) { wasNul.add(key); rerender = true; if (b.beschuldigde_id === ik()?.id) tril([300, 120, 300]); }
    const lang = (nu() - new Date(b.laatste_meedoen).getTime()) / 1000 > HOST_SLUIT;
    if (lang && !wasNul.has(key + 'lang')) { wasNul.add(key + 'lang'); rerender = true; }
  }
  document.querySelectorAll('[data-jokertot]').forEach((e) => {
    const ms = Number(e.dataset.jokertot) - nu();
    if (ms <= 0) rerender = true; else e.textContent = fmtMin(ms);
  });
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
    sb.from('stemmen').select('*').eq('sessie_id', sid),
    sb.from('overnames').select('*').eq('sessie_id', sid).eq('status', 'open'),
  ]);
  if (sid !== S.sid) return;
  const fout = ses.error || spl.error;
  if (fout) { console.warn(fout); return; }
  if (!ses.data) return verlaat(S.eersteLaad ? null : 'Deze sessie bestaat niet meer, of je bent eruit gehaald.');
  const vorig = { status: S.sessie?.status, ontm: ik()?.ontmaskerd, stap: S.sessie && S.sessie.onthul_index + S.sessie.onthul_stap };
  S.sessie = ses.data; S.spelers = spl.data || []; S.deel = dee.data || []; S.stemmen = ste.data || []; S.overnames = ove.data || [];
  const nieuweBesch = bes.data || [];
  if (!ik()) return verlaat(S.eersteLaad ? null : 'Je zit niet meer in deze sessie.');
  meldingen(nieuweBesch);
  S.besch = nieuweBesch;
  ls.set('sessie', { sid, code: S.sessie.code });

  if (S.sessie.status === 'spel' && (!S.missie || vorig.status !== 'spel' || vorig.ontm !== ik().ontmaskerd)) await laadMissie();
  if (['onthulling', 'einde'].includes(S.sessie.status) && (!S.onthulling || vorig.status === 'spel')) {
    try { S.onthulling = await rpc('onthulling_data', { p_sessie: sid }); } catch (e) { console.warn(e); }
  }
  if (S.sessie.status === 'onthulling' && vorig.stap !== S.sessie.onthul_index + S.sessie.onthul_stap && S.sessie.onthul_stap === 'missie' && isHost()) feest();
  if (S.sessie.status === 'spel' && vorig.status === 'lobby' && !ls.get('intro')) { S.view = 'intro'; S.introStap = 0; }
  S.eersteLaad = false;
  render();
}
// Laden gebeurt altijd één tegelijk; komt er tijdens het laden een wijziging binnen, dan volgt nog één ronde.
let laadtBezig = null, nogEens = false;
function laadNu() {
  if (laadtBezig) { nogEens = true; return laadtBezig; }
  laadtBezig = laadAlles().catch(console.warn).finally(() => {
    laadtBezig = null;
    if (nogEens) { nogEens = false; laadNu(); }
  });
  return laadtBezig;
}
const planLaad = () => { clearTimeout(laadTimer); laadTimer = setTimeout(laadNu, 120); };

async function laadMissie() {
  try { S.missie = await rpc('mijn_missie', { p_sessie: S.sid }); } catch (e) { S.fout = foutTekst(e); }
}

function meldingen(nieuw) {
  const me = ik(); if (!me) return;
  const key = 'gezien.' + S.sid;
  if (!S.gezien.size) (ls.get(key, []) || []).forEach((x) => S.gezien.add(x));
  const oud = new Map(S.besch.map((b) => [b.id, b]));
  for (const b of nieuw) {
    const was = oud.get(b.id);
    if (b.status === 'open') {
      if (!S.gezien.has(b.id) && b.beschuldigde_id !== me.id && !doetMee(b.id) && !S.eersteLaad) {
        if (!S.sheet) S.sheet = { type: 'melding', id: b.id };
      }
      if (b.beschuldigde_id === me.id && !S.gezien.has(b.id)) tril([200, 100, 200]);
      S.gezien.add(b.id);
    } else if (was && was.status === 'open' && b.status !== 'vervallen' && !S.gezien.has(b.id + ':uit')) {
      const d = S.deel.filter((x) => x.beschuldiging_id === b.id);
      const pts = S.sessie.punten_aan ? d.map((x) => `${naam(x.speler_id)} ${x.punten > 0 ? '+' : '−'}${Math.abs(x.punten)}`).join(' · ') : '';
      const wie = b.beschuldigde_id === me.id ? 'Jij' : naam(b.beschuldigde_id);
      if (b.status === 'toegegeven') toastLater(`${wie} ${b.beschuldigde_id === me.id ? 'gaf' : 'geeft'} toe: ontmaskerd`, pts);
      else toastLater(`${wie} ${b.beschuldigde_id === me.id ? 'wees' : 'wijst'} de beschuldiging af${b.door_host ? ' (gesloten door de host)' : ''}`, pts);
      if (S.sheet?.type === 'melding' && S.sheet.id === b.id) S.sheet = null;
    }
    if (b.status !== 'open') S.gezien.add(b.id + ':uit');
  }
  ls.set(key, [...S.gezien].slice(-300));
}
function toastLater(t, x) { setTimeout(() => toast(t, x), 0); }

function abonneer() {
  if (kanaal) sb.removeChannel(kanaal);
  const sid = S.sid, f = `sessie_id=eq.${sid}`;
  kanaal = sb.channel('sessie-' + sid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessies', filter: `id=eq.${sid}` }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'spelers', filter: f }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'beschuldigingen', filter: f }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deelnames', filter: f }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stemmen', filter: f }, planLaad)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'overnames', filter: f }, planLaad)
    .subscribe((st) => { if (st === 'SUBSCRIBED') planLaad(); });
}

async function ping() {
  if (!S.sid) return;
  try {
    const t0 = Date.now();
    const r = await rpc('ping', { p_sessie: S.sid });
    const t1 = Date.now();
    // klokverschil met de server; de meting met de kortste rondreis is het nauwkeurigst
    const rtt = t1 - t0;
    if (r?.nu && (rtt < (S.besteRtt ?? Infinity) || rtt < 400)) { S.besteRtt = Math.min(rtt, S.besteRtt ?? Infinity); S.offset = new Date(r.nu).getTime() - (t0 + t1) / 2; }
  } catch (e) { if (String(e.message).includes('geen_speler')) planLaad(); }
}

async function betreed(sid) {
  S.sid = sid; S.sessie = null; S.missie = null; S.onthulling = null; S.besch = []; S.gezien = new Set(); S.eersteLaad = true;
  S.view = 'sessie'; S.tab = 'missie'; S.fout = null;
  render();
  abonneer();
  await ping();
  await laadNu();
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { ping(); }, 25000);
}

function verlaat(msg) {
  if (kanaal) { sb.removeChannel(kanaal); kanaal = null; }
  clearInterval(pingTimer);
  ls.del('sessie');
  S.sid = null; S.sessie = null; S.missie = null; S.onthulling = null; S.sheet = null; S.spelers = []; S.besch = [];
  S.fout = msg || null;
  S.view = msg ? 'weg' : 'home';
  render();
}

// ---------- feest bij onthulling ----------
function feest() {
  const kleuren = ['#D4B26A', '#E6C989', '#C0463A', '#ECE9E3', '#7FB7A4'];
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let i = 0; i < 80; i++) {
    const c = document.createElement('i');
    c.style.left = Math.random() * 100 + '%';
    c.style.background = kleuren[i % kleuren.length];
    c.style.animationDuration = 2 + Math.random() * 2 + 's';
    c.style.animationDelay = Math.random() * 0.6 + 's';
    box.appendChild(c);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5000);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.12 + 0.6);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.12); o.stop(ctx.currentTime + i * 0.12 + 0.7);
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
  view: (el) => { S.fout = null; S.view = el.dataset.v; if (S.view === 'uitleg') S.terug = 'home'; },
  'view-uitleg': () => { S.terug = S.view; S.view = 'uitleg'; },
  'uitleg-terug': () => { S.view = S.terug || 'home'; },
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
  'intro-volgende': () => { S.introStap++; },
  'intro-klaar': () => { ls.set('intro', true); S.view = 'sessie'; },
  start: () => doe(() => rpc('start_spel', { p_sessie: S.sid })),
  tab: (el) => { S.tab = el.dataset.v; S.fout = null; },
  voltooid: () => { S.sheet = { type: 'voltooid', getuige: null }; },
  getuige: (el) => { S.sheet.getuige = S.sheet.getuige === el.dataset.id ? null : el.dataset.id; },
  'voltooid-ok': () => doe(async () => { await rpc('markeer_voltooid', { p_sessie: S.sid, p_getuige: S.sheet.getuige }); S.sheet = null; await laadMissie(); }),
  'voltooid-ongedaan': () => doe(async () => { await rpc('markeer_voltooid', { p_sessie: S.sid, p_getuige: null, p_ongedaan: true }); await laadMissie(); }),
  joker: () => { S.sheet = { type: 'joker' }; },
  'joker-ok': () => doe(async () => { await rpc('gebruik_joker', { p_sessie: S.sid }); S.sheet = null; await laadMissie(); toast('Nieuwe missie', 'Houd je kaart vast om hem te zien.', 3500); }),
  beschuldig: (el) => { S.sheet = { type: 'beschuldig', id: el.dataset.id }; },
  'beschuldig-ok': (el) => doe(async () => { await rpc('beschuldig', { p_sessie: S.sid, p_beschuldigde: el.dataset.id }); S.sheet = null; await laadNu(); }),
  meedoen: (el) => doe(async () => { await rpc('meedoen', { p_beschuldiging: el.dataset.id }); S.sheet = null; await laadNu(); }),
  reageer: (el) => doe(async () => { await rpc('reageer', { p_beschuldiging: el.dataset.id, p_toegeven: el.dataset.val === 'ja' }); await laadNu(); }),
  'host-sluit': (el) => doe(() => rpc('host_sluit_beschuldiging', { p_beschuldiging: el.dataset.id })),
  spelermenu: (el) => { S.sheet = { type: 'spelermenu', id: el.dataset.id }; },
  verwijder: (el) => doe(async () => { await rpc('host_verwijder', { p_speler: el.dataset.id }); S.sheet = null; }),
  'extra-joker': (el) => doe(async () => { await rpc('host_extra_joker', { p_speler: el.dataset.id }); S.sheet = null; toast('Extra joker gegeven', `${naam(el.dataset.id)} kan nu wisselen.`, 3000); }),
  'overname-ja': (el) => doe(() => rpc('host_overname', { p_overname: el.dataset.id, p_akkoord: true })),
  'overname-nee': (el) => doe(() => rpc('host_overname', { p_overname: el.dataset.id, p_akkoord: false })),
  'melding-weg': () => doe(() => rpc('host_melding_weg', { p_sessie: S.sid })),
  beeindig: () => { S.sheet = { type: 'beeindig' }; },
  'beeindig-ok': () => doe(async () => { await rpc('beeindig_spel', { p_sessie: S.sid }); S.sheet = null; }),
  'onthul-volgende': () => doe(() => rpc('onthul_stap', { p_sessie: S.sid, p_vooruit: true })),
  'onthul-vorige': () => doe(() => rpc('onthul_stap', { p_sessie: S.sid, p_vooruit: false })),
  stem: (el) => doe(async () => { await rpc('stem', { p_sessie: S.sid, p_speler: huidigeOnthulling().id, p_duim: el.dataset.val === 'ja' }); await laadNu(); }),
  scorebord: () => doe(() => rpc('naar_scorebord', { p_sessie: S.sid })),
  'missies-terug': () => { S.sheet = { type: 'missies' }; },
  'sheet-dicht': () => { S.sheet = null; S.fout = null; },
  scrim: (el, ev) => { if (ev.target === el && S.sheet?.type !== 'naambestaat') { S.sheet = null; S.fout = null; } },
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
    if (!ls.get('intro')) { await betreed(r.sessie_id); if (S.sessie?.status === 'spel') { S.view = 'intro'; S.introStap = 0; } return; }
    await betreed(r.sessie_id);
  });
}

async function wachtOpOvername() {
  while (S.view === 'overname' && S.overname) {
    try {
      const r = await rpc('overname_check', { p_overname: S.overname.id });
      if (r.status === 'goed') { ls.del('overname'); S.overname = null; return betreed(r.sessie_id); }
      if (r.status === 'geweigerd') { ls.del('overname'); S.overname = null; S.view = 'deelnemen'; S.fout = 'De host heeft het niet bevestigd.'; return render(); }
    } catch (e) { ls.del('overname'); S.overname = null; S.view = 'deelnemen'; S.fout = foutTekst(e); return render(); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// QR scannen (waar de browser het ondersteunt)
let scanStream = null;
async function startScan() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    toast('Open de camera-app van je telefoon', 'Richt hem op de QR-code; die opent de app met de code al ingevuld.', 5000);
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch { toast('Geen toegang tot de camera', 'Typ de code dan over.'); return; }
  S.scannen = true; render();
  const v = document.getElementById('scan');
  v.srcObject = scanStream; await v.play().catch(() => {});
  const det = new window.BarcodeDetector({ formats: ['qr_code'] });
  const loop = async () => {
    if (!S.scannen) return;
    try {
      const codes = await det.detect(v);
      const raw = codes[0]?.rawValue;
      const m = raw && (raw.match(/[?&]code=([A-Za-z]{4})/) || raw.match(/^([A-Za-z]{4})$/));
      if (m) { S.form.code = m[1].toUpperCase(); stopScan(); return; }
    } catch {}
    requestAnimationFrame(loop);
  };
  loop();
}
function stopScan() { S.scannen = false; scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; render(); }

// ---------- events ----------
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = ACTIES[el.dataset.a];
  if (!fn) return;
  if (el.dataset.a === 'scrim' && ev.target !== el) return;
  const r = fn(el, ev);
  if (!(r instanceof Promise)) render();
});
document.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role="button"][data-a]')) { ev.preventDefault(); ev.target.click(); }
});
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.f) { S.form[el.dataset.f] = el.value; return; }
  if (el.dataset.code != null) {
    const i = Number(el.dataset.code);
    const v = el.value.toUpperCase().replace(/[^A-Z]/g, '');
    const arr = (S.form.code + '    ').slice(0, 4).split('');
    if (v.length > 1) { // geplakte code
      v.slice(0, 4 - i).split('').forEach((c, j) => (arr[i + j] = c));
    } else arr[i] = v || ' ';
    S.form.code = arr.join('').replace(/\s+$/, '');
    document.querySelectorAll('[data-code]').forEach((b, j) => (b.value = (arr[j] || '').trim()));
    const next = v ? Math.min(3, i + v.length) : i;
    if (v && i < 3) document.getElementById('c' + next)?.focus();
  }
});
document.addEventListener('keydown', (ev) => {
  const el = ev.target;
  if (el.dataset?.code != null && ev.key === 'Backspace' && !el.value) {
    const i = Number(el.dataset.code);
    if (i > 0) document.getElementById('c' + (i - 1))?.focus();
  }
  if (ev.key === 'Enter' && S.view === 'deelnemen' && el.matches('input')) ACTIES.join();
  if (ev.key === 'Enter' && S.view === 'nieuw' && el.matches('input')) ACTIES.maak();
});

// Vasthouden om de missie te tonen
function toonMissie(aan) {
  const k = document.getElementById('missiekaart');
  S.vasthouden = aan;
  if (k) k.classList.toggle('toon', aan);
  if (!aan && S.renderWacht) { S.renderWacht = false; render(); }
}
document.addEventListener('pointerdown', (ev) => { if (ev.target.closest('#missiekaart')) { ev.preventDefault(); toonMissie(true); } });
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => { if (S.vasthouden) toonMissie(false); }));
document.addEventListener('contextmenu', (ev) => { if (ev.target.closest('#missiekaart')) ev.preventDefault(); });
document.addEventListener('keydown', (ev) => { if (ev.target.id === 'missiekaart' && (ev.key === ' ' || ev.key === 'Enter')) { ev.preventDefault(); toonMissie(true); } });
document.addEventListener('keyup', (ev) => { if (ev.target.id === 'missiekaart') toonMissie(false); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (S.vasthouden) toonMissie(false); }
  else if (S.sid) { ping(); planLaad(); }
});
window.addEventListener('blur', () => { if (S.vasthouden) toonMissie(false); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (S.view === 'home') render(); });

// ---------- opstarten ----------
async function start() {
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const p = new URLSearchParams(location.search);
  if (p.get('code')) { S.form.code = p.get('code').toUpperCase().slice(0, 4); history.replaceState(null, '', location.pathname); }
  S.form.spelerNaam = S.form.hostNaam = ls.get('naam', '') || '';

  if (!CFG.supabaseUrl || CFG.supabaseUrl.includes('VUL_IN')) {
    $app.innerHTML = `<main class="screen"><div class="center-msg"><h2>Nog niet ingesteld</h2><p>Vul in config.js de Supabase-URL en de anon key in.</p></div></main>`;
    return;
  }
  try {
    const { createClient } = window.__supabaseMock || (await import(SUPABASE_ESM));
    sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ta.auth' } });
    let { data } = await sb.auth.getSession();
    if (!data.session) {
      const r = await sb.auth.signInAnonymously();
      if (r.error) throw r.error;
      data = r.data;
    }
    uid = data.session?.user?.id || data.user?.id;
  } catch (e) {
    console.error(e);
    S.view = 'home'; S.fout = 'Geen verbinding met de server. Check je internet en herlaad de app.';
    return render();
  }

  const oudOvername = ls.get('overname');
  const oud = ls.get('sessie');
  if (oudOvername) { S.overname = oudOvername; S.view = 'overname'; render(); return wachtOpOvername(); }
  if (oud?.sid) {
    try { await betreed(oud.sid); return; } catch { ls.del('sessie'); }
  }
  S.view = S.form.code ? 'deelnemen' : 'home';
  render();
}
start();
