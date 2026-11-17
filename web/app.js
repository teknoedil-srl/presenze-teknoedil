// Presenze TEKNOEDIL — registro presenze operai (uso interno)
// Web app senza framework: Firebase Authentication (Google) + Firestore.
// Nessun dato reale nel codice: anagrafica, presenze e utenti stanno solo nel database.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, onSnapshot, collection, query, where, orderBy, limit, getDocs,
  writeBatch, serverTimestamp, deleteField, documentId, Timestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Configurazione Firebase (valori pubblici del progetto web, non segreti)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyB-K9zSsrLn8ENJ5Z8Fhzr1QYWwWQULdqI",
  // Il login passa dallo stesso dominio dell'app (vedi web/__/auth): serve per i browser
  // che bloccano i cookie di terze parti
  authDomain: "teknoedil-srl.github.io/presenze-teknoedil",
  projectId: "presenze-teknoedil",
  storageBucket: "presenze-teknoedil.firebasestorage.app",
  messagingSenderId: "209965540526",
  appId: "1:209965540526:web:89b9d91c5c2cc015b9f93f",
};

// Giorni (oltre a oggi) entro cui un caposquadra può ancora correggere. Deve coincidere con le regole Firestore.
const FINESTRA_CAPO = 3;

const CAUSALI = [
  { c: "FER", n: "Ferie", s: "F" },
  { c: "PER", n: "Permesso / ROL", s: "P" },
  { c: "MAL", n: "Malattia", s: "M" },
  { c: "INF", n: "Infortunio", s: "I" },
  { c: "MLT", n: "Maltempo", s: "MT" },
  { c: "ING", n: "Assenza ingiustificata", s: "AI" },
  { c: "ALT", n: "Altro", s: "A" },
];
const CAUS = Object.fromEntries(CAUSALI.map((x) => [x.c, x]));
const RUOLI = { admin: "Amministratore", ufficio: "Ufficio", caposquadra: "Caposquadra" };
const QUALIFICHE = ["Operaio comune", "Operaio qualificato", "Operaio specializzato", "Operaio di 4° livello", "Caposquadra", "Apprendista", "Autista", "Gruista"];
const GIORNI_BREVI = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
const GIORNI_LUNGHI = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const DEF_IMP = { oreSett: [8, 8, 8, 8, 8, 0, 0], festivitaLocali: [], ultimoBackup: null };

// ---------------------------------------------------------------------------
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
auth.languageCode = "it";
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const S = {
  user: null, email: "", ruolo: "",
  membri: { ruoli: {}, nomi: {} },
  imp: { ...DEF_IMP },
  operai: [], opById: {},
  mk: null, mkLoaded: false, giorni: {}, mesi: {},
  view: "giorno", data: oggiISO(), meseVista: oggiISO().slice(0, 7), calOp: "tutti",
  unsub: {}, installPrompt: null,
};

// ---------------------------------------------------------------------------
// Utilità
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const fmt = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString("it-IT", { maximumFractionDigits: 2 });

function oggiISO() { return isoDi(new Date()); }
function isoDi(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function daISO(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
function aggiungiGiorni(iso, n) { const d = daISO(iso); d.setDate(d.getDate() + n); return isoDi(d); }
function giornoSett(iso) { return (daISO(iso).getDay() + 6) % 7; } // 0 = lunedì
function giorniNelMese(mk) { const [y, m] = mk.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function meseSucc(mk, n) { const [y, m] = mk.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return isoDi(d).slice(0, 7); }
function nomeMese(mk) { const [y, m] = mk.split("-").map(Number); return `${MESI[m - 1]} ${y}`; }
function titoloData(iso) { const d = daISO(iso); return `${GIORNI_LUNGHI[giornoSett(iso)]} ${d.getDate()} ${MESI[d.getMonth()]}`; }
function dataBreve(iso) { const d = daISO(iso); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; }
function nomeOp(op) { return op ? `${op.cognome} ${op.nome}`.trim() : "(operaio eliminato)"; }
function ordinaOp(a, b) { return nomeOp(a).localeCompare(nomeOp(b), "it"); }
function quando(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Pasqua (algoritmo gregoriano anonimo)
function pasqua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mese = Math.floor((h + l - 7 * m + 114) / 31), giorno = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mese - 1, giorno);
}
const FESTE_FISSE = {
  "01-01": "Capodanno", "01-06": "Epifania", "04-25": "Festa della Liberazione", "05-01": "Festa del Lavoro",
  "06-02": "Festa della Repubblica", "08-15": "Ferragosto", "11-01": "Ognissanti", "12-08": "Immacolata",
  "12-25": "Natale", "12-26": "Santo Stefano",
};
function festivita(iso) {
  const md = iso.slice(5), y = Number(iso.slice(0, 4));
  if (FESTE_FISSE[md]) return FESTE_FISSE[md];
  if (md === "10-04" && y >= 2026) return "San Francesco d'Assisi";
  const p = pasqua(y);
  if (iso === isoDi(p)) return "Pasqua";
  const lun = new Date(p); lun.setDate(lun.getDate() + 1);
  if (iso === isoDi(lun)) return "Lunedì dell'Angelo";
  const loc = (S.imp.festivitaLocali || []).find((f) => f.md === md);
  return loc ? loc.nome : null;
}

// Informazioni sul giorno: orario previsto, festività, se gli operai sono presunti presenti
function infoGiorno(iso, g = S.giorni[iso] || {}) {
  const gs = giornoSett(iso);
  const festa = festivita(iso);
  const std = num((S.imp.oreSett || DEF_IMP.oreSett)[gs]);
  const feriale = !festa && std > 0;
  const chiusura = g.lavorativa === false;
  return {
    gs, festa, std, feriale, chiusura,
    base: std > 0 ? std : 8,
    presunto: feriale && !chiusura, // tutti presenti di default
    festivo: !!festa || gs === 6,     // domenica o festività
  };
}

function ruoloUfficio() { return S.ruolo === "admin" || S.ruolo === "ufficio"; }
function meseChiuso(mk) { return !!(S.mesi[mk] && S.mesi[mk].chiuso); }
function puoModificare(iso) {
  if (meseChiuso(iso.slice(0, 7))) return { ok: false, motivo: "Mese chiuso" };
  if (ruoloUfficio()) return { ok: true };
  const oggi = oggiISO();
  if (iso < aggiungiGiorni(oggi, -FINESTRA_CAPO)) return { ok: false, motivo: "Solo lettura: per correzioni rivolgersi all'ufficio" };
  if (iso > aggiungiGiorni(oggi, 1)) return { ok: false, motivo: "Data futura" };
  return { ok: true };
}

// Riga (registrazione di un operaio in un giorno) → stato visualizzato
function statoRiga(r, info) {
  if (!r) {
    if (info && info.presunto) return { cls: "pres def", txt: `${fmt(info.std)}h`, cod: "?" };
    return { cls: "off", txt: "—", cod: "" };
  }
  const ore = num(r.ore), str = num(r.str), oa = num(r.oreAss), c = CAUS[r.caus];
  const piu = str > 0 ? ` +${fmt(str)}` : "";
  if (oa > 0 && ore === 0) return { cls: "ass", txt: (c ? c.n.split(" /")[0] : "Assente") + (oa && info && oa !== info.base ? ` ${fmt(oa)}h` : "") + piu, cod: c ? c.s : "A" };
  if (oa > 0 && ore > 0) return { cls: "parz", txt: `${fmt(ore)}h · ${c ? c.s : "A"} ${fmt(oa)}h${piu}`, cod: `${fmt(ore)}/${c ? c.s : "A"}` };
  if (ore > 0) return { cls: "pres", txt: `${fmt(ore)}h${piu}`, cod: `${fmt(ore)}${str ? "+" + fmt(str) : ""}` };
  if (str > 0) return { cls: "pres", txt: `str ${fmt(str)}h`, cod: `+${fmt(str)}` };
  return { cls: "off", txt: "Non in servizio", cod: "–" };
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), err ? 5000 : 2200);
}
function erroreScrittura(e) {
  console.error(e);
  const msg = e && e.code === "permission-denied"
    ? "Modifica rifiutata: permessi insufficienti o mese chiuso"
    : "Errore nel salvataggio: " + (e && e.message ? e.message : e);
  toast(msg, true);
}
function commit(batch, okMsg = "Salvato") {
  // Senza rete la scrittura resta in coda e viene inviata al ritorno della connessione
  batch.commit().catch(erroreScrittura);
  toast(navigator.onLine ? okMsg : okMsg + " (offline: verrà sincronizzato)");
}

// ---------------------------------------------------------------------------
// Accesso
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

$("#btn-login").onclick = async () => {
  $("#login-error").textContent = "";
  try { await signInWithRedirect(auth, provider); } catch (e) { $("#login-error").textContent = "Accesso non riuscito: " + e.message; }
};
$("#btn-logout-login").onclick = () => signOut(auth);
getRedirectResult(auth).catch((e) => { $("#login-error").textContent = "Accesso non riuscito: " + (e.code || e.message); });

function mostra(id) {
  for (const x of ["splash", "login", "app"]) $("#" + x).classList.toggle("hidden", x !== id);
}

onAuthStateChanged(auth, async (user) => {
  chiudiSottoscrizioni();
  S.avviata = false;
  chiudiSheet();
  S.user = user;
  if (!user) { mostra("login"); $("#btn-logout-login").classList.add("hidden"); return; }
  S.email = (user.email || "").toLowerCase();
  mostra("splash");
  const ref = doc(db, "config", "membri");
  try {
    await getDoc(ref);
  } catch (e) {
    if (e.code === "permission-denied") {
      // Primo avvio: solo l'amministratore previsto dalle regole può creare l'elenco utenti
      try {
        await setDoc(ref, { ruoli: { [S.email]: "admin" }, nomi: { [S.email]: user.displayName || "" }, creato: serverTimestamp() });
      } catch (e2) {
        nonAutorizzato();
        return;
      }
    } else {
      mostra("login");
      $("#login-error").textContent = "Impossibile leggere i dati: " + e.message;
      return;
    }
  }
  S.unsub.membri = onSnapshot(ref, (snap) => {
    const d = snap.data() || {};
    S.membri = { ruoli: d.ruoli || {}, nomi: d.nomi || {} };
    S.ruolo = S.membri.ruoli[S.email] || "";
    if (!S.ruolo) { nonAutorizzato(); return; }
    if (!S.avviata) avviaApp(); else render();
  }, (e) => { if (e.code === "permission-denied") nonAutorizzato(); });
});

function nonAutorizzato() {
  chiudiSottoscrizioni();
  S.avviata = false;
  mostra("login");
  $("#login-error").textContent = `L'account ${S.email} non è abilitato. Chiedi all'amministratore di aggiungerlo.`;
  $("#btn-logout-login").classList.remove("hidden");
}

function chiudiSottoscrizioni() {
  for (const k in S.unsub) { try { S.unsub[k](); } catch (e) {} }
  S.unsub = {}; S.mk = null; S.mkLoaded = false; S.giorni = {}; S.mesi = {};
}

function avviaApp() {
  S.avviata = true;
  S.unsub.imp = onSnapshot(doc(db, "config", "impostazioni"), (s) => { S.imp = { ...DEF_IMP, ...(s.data() || {}) }; render(); }, () => {});
  S.unsub.operai = onSnapshot(collection(db, "operai"), (qs) => {
    S.operai = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort(ordinaOp);
    S.opById = Object.fromEntries(S.operai.map((o) => [o.id, o]));
    render();
  }, () => {});
  document.body.classList.toggle("ufficio", ruoloUfficio());
  $$(".solo-ufficio").forEach((b) => b.classList.toggle("hidden", !ruoloUfficio()));
  mostra("app");
  render();
}

// Sottoscrizione alle presenze del mese visualizzato
function assicuraMese(mk) {
  if (S.mk === mk) return;
  if (S.unsub.mese) S.unsub.mese();
  if (S.unsub.meseInfo) S.unsub.meseInfo();
  S.mk = mk; S.mkLoaded = false; S.giorni = {};
  const q = query(collection(db, "presenze"), where(documentId(), ">=", `${mk}-01`), where(documentId(), "<=", `${mk}-31`));
  S.unsub.mese = onSnapshot(q, (qs) => {
    S.giorni = Object.fromEntries(qs.docs.map((d) => [d.id, d.data()]));
    S.mkLoaded = true;
    render();
  }, (e) => { console.error(e); toast("Errore nel caricamento delle presenze", true); });
  S.unsub.meseInfo = onSnapshot(doc(db, "mesi", mk), (s) => { S.mesi[mk] = s.data() || null; render(); }, () => {});
}

// ---------------------------------------------------------------------------
// Navigazione
$("#tabs").onclick = (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  S.view = b.dataset.v;
  render();
  scrollTo(0, 0);
};
$("#btn-tema").onclick = () => {
  const t = document.documentElement.dataset.tema === "scuro" ? "chiaro" : "scuro";
  document.documentElement.dataset.tema = t;
  try { localStorage.setItem("tema", t); } catch (e) {}
};
function aggiornaRete() { $("#net").classList.toggle("hidden", navigator.onLine); }
addEventListener("online", aggiornaRete);
addEventListener("offline", aggiornaRete);
aggiornaRete();
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installPrompt = e; if (S.view === "impostazioni") render(); });

function render() {
  if (!S.avviata) return;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.view));
  renderAvvisi();
  const v = { giorno: vGiorno, calendario: vCalendario, riepilogo: vRiepilogo, operai: vOperai, impostazioni: vImpostazioni }[S.view] || vGiorno;
  v($("#view"));
}

function renderAvvisi() {
  let h = "";
  if (ruoloUfficio()) {
    const ub = S.imp.ultimoBackup && S.imp.ultimoBackup.toDate ? S.imp.ultimoBackup.toDate() : null;
    const giorni = ub ? (Date.now() - ub.getTime()) / 864e5 : Infinity;
    if (giorni > 30 && !sessionStorage.getItem("noBackup")) {
      h += `<div class="avviso"><span>💾 ${ub ? "Ultimo backup più di 30 giorni fa." : "Nessun backup scaricato finora."} Il piano gratuito non fa copie automatiche.</span>
        <span class="row"><button class="btn small" data-a="backup">Scarica</button><button class="btn small link" data-a="nobackup">Dopo</button></span></div>`;
    }
  }
  const box = $("#avvisi");
  box.innerHTML = h;
  box.onclick = (e) => {
    const a = e.target.closest("[data-a]");
    if (!a) return;
    if (a.dataset.a === "backup") scaricaBackup();
    if (a.dataset.a === "nobackup") { sessionStorage.setItem("noBackup", "1"); renderAvvisi(); }
  };
}

function navData(titolo, sotto, tipoInput, valore) {
  return `<div class="nav-data">
    <button class="freccia" data-nav="-1" aria-label="Precedente">‹</button>
    <div class="titolo">${esc(titolo)}<span class="sotto">${esc(sotto)}</span>
      <input type="${tipoInput}" value="${valore}" data-nav-input aria-label="Scegli"></div>
    <button class="freccia" data-nav="1" aria-label="Successivo">›</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Vista GIORNO
function operaiDelGiorno(righe) {
  const ids = new Set(S.operai.filter((o) => o.attivo !== false).map((o) => o.id));
  Object.keys(righe || {}).forEach((id) => ids.add(id));
  return [...ids].map((id) => S.opById[id] || { id, cognome: "(operaio eliminato)", nome: "", attivo: false }).sort(ordinaOp);
}

function vGiorno(el) {
  const iso = S.data;
  assicuraMese(iso.slice(0, 7));
  const g = S.giorni[iso] || {};
  const righe = g.righe || {};
  const info = infoGiorno(iso, g);
  const perm = puoModificare(iso);
  const lista = operaiDelGiorno(righe);
  const oggi = oggiISO();
  const sotto = iso === oggi ? "Oggi" : iso === aggiungiGiorni(oggi, -1) ? "Ieri" : iso === aggiungiGiorni(oggi, 1) ? "Domani" : daISO(iso).getFullYear();

  let pres = 0, ass = 0, parz = 0, daConf = 0;
  for (const op of lista) {
    const r = righe[op.id];
    if (!r) { if (info.presunto && op.attivo !== false) daConf++; continue; }
    const st = statoRiga(r, info).cls;
    if (st === "pres") pres++; else if (st === "ass") ass++; else if (st === "parz") parz++;
  }

  const badges = [];
  if (info.festa) badges.push(`<span class="badge fest">${esc(info.festa)}</span>`);
  else if (info.gs === 6) badges.push(`<span class="badge fest">Domenica</span>`);
  else if (info.std === 0) badges.push(`<span class="badge">${GIORNI_LUNGHI[info.gs]} — non lavorativo</span>`);
  else badges.push(`<span class="badge">Orario ${fmt(info.std)}h</span>`);
  if (info.chiusura) badges.push(`<span class="badge warn">Chiusura aziendale</span>`);
  if (meseChiuso(iso.slice(0, 7))) badges.push(`<span class="badge chiuso">🔒 Mese chiuso</span>`);
  else if (!perm.ok) badges.push(`<span class="badge">👁 ${esc(perm.motivo)}</span>`);
  if (S.mkLoaded && info.presunto && daConf === 0 && lista.length) badges.push(`<span class="badge ok">✓ Giornata registrata</span>`);

  let h = navData(titoloData(iso), sotto, "date", iso);
  h += `<div class="badges">${badges.join("")}${iso !== oggi ? `<button class="badge" data-oggi style="border:none">↩ Torna a oggi</button>` : ""}</div>`;

  if (!S.mkLoaded) { el.innerHTML = h + `<div class="vuoto-msg"><div class="spinner" style="margin:auto"></div></div>`; bindNav(el, "giorno"); return; }

  if (!S.operai.length) {
    h += `<div class="card vuoto-msg">Nessun operaio in anagrafica.${ruoloUfficio() ? `<div class="spacer"></div><button class="btn primary" data-vai="operai">Aggiungi operai</button>` : " L'ufficio deve inserirli."}</div>`;
  } else {
    if (!info.presunto && !Object.keys(righe).length) {
      h += `<p class="muted small" style="margin:0 2px 10px">${info.chiusura ? "Giornata segnata come chiusura aziendale." : "Giornata non lavorativa."} Se qualcuno ha lavorato (urgenze), tocca il suo nome e registra le ore.</p>`;
    }
    h += `<div class="contatori"><span>Presenti <b>${pres}</b></span><span>Assenti <b>${ass}</b></span><span>Parziali <b>${parz}</b></span>${daConf ? `<span>Da confermare <b>${daConf}</b></span>` : ""}</div>`;
    h += `<div class="lista">`;
    for (const op of lista) {
      const r = righe[op.id];
      const st = statoRiga(r, info);
      h += `<button class="voce ${op.attivo === false ? "inattivo" : ""}" data-op="${op.id}">
        <span class="nome"><b>${esc(op.cognome)}</b> ${esc(op.nome)}<span class="q">${esc(op.qualifica || "")}${r && r.nota ? ` · 📝 ${esc(r.nota)}` : ""}</span></span>
        <span class="stato ${st.cls}">${esc(st.txt)}</span></button>`;
    }
    h += `</div>`;
    if (perm.ok) {
      h += `<div class="row wrap" style="margin-top:12px">
        <button class="btn small" data-multi>✎ Modifica più operai</button>
        ${ruoloUfficio() && info.feriale ? `<button class="btn small" data-chiusura>${info.chiusura ? "Annulla chiusura aziendale" : "Segna chiusura aziendale"}</button>` : ""}
      </div>`;
      if (daConf > 0) {
        h += `<div class="barra-conferma"><button class="btn primary big" data-conferma>✓ Conferma giornata (${daConf} ${daConf === 1 ? "presente" : "presenti"} da registrare)</button></div>`;
      }
    }
    h += `<p class="muted small" style="margin-top:14px">Le voci tratteggiate sono presenze previste non ancora registrate: toccando un operaio o "Conferma giornata" vengono salvate.</p>`;
  }
  el.innerHTML = h;
  bindNav(el, "giorno");
  el.querySelectorAll("[data-op]").forEach((b) => (b.onclick = () => {
    if (!perm.ok) { mostraDettaglio(iso, b.dataset.op); return; }
    apriEditor(iso, [b.dataset.op]);
  }));
  const conf = $("[data-conferma]", el);
  if (conf) conf.onclick = () => salvaRighe(iso, {}, "Giornata confermata");
  const multi = $("[data-multi]", el);
  if (multi) multi.onclick = () => apriEditorMulti(iso);
  const ch = $("[data-chiusura]", el);
  if (ch) ch.onclick = () => {
    const b = writeBatch(db);
    b.set(doc(db, "presenze", iso), { lavorativa: info.chiusura ? deleteField() : false, by: S.email, at: serverTimestamp() }, { merge: true });
    b.set(doc(collection(db, "log")), { giorno: iso, tipo: info.chiusura ? "riapertura giorno" : "chiusura aziendale", by: S.email, at: serverTimestamp() });
    commit(b);
  };
  const vai = $("[data-vai]", el);
  if (vai) vai.onclick = () => { S.view = vai.dataset.vai; render(); };
  const og = $("[data-oggi]", el);
  if (og) og.onclick = () => { S.data = oggiISO(); render(); };
}

function bindNav(el, tipo) {
  el.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => {
    const n = Number(b.dataset.nav);
    if (tipo === "giorno") S.data = aggiungiGiorni(S.data, n);
    else S.meseVista = meseSucc(S.meseVista, n);
    render();
  }));
  const inp = $("[data-nav-input]", el);
  if (inp) inp.onchange = () => {
    if (!inp.value) return;
    if (tipo === "giorno") S.data = inp.value; else S.meseVista = inp.value;
    render();
  };
}

// Salvataggio: changes = { idOperaio: riga | null (elimina) }
// Se la giornata prevede "tutti presenti", al primo salvataggio vengono registrati anche
// gli operai attivi non ancora toccati (presenza ordinaria), così nulla resta solo "previsto".
function salvaRighe(iso, changes, okMsg = "Salvato") {
  const g = S.giorni[iso] || {};
  const righe = g.righe || {};
  const info = infoGiorno(iso, g);
  const ora = serverTimestamp();
  const nuove = {};
  const batch = writeBatch(db);
  for (const [id, r] of Object.entries(changes)) {
    nuove[id] = r ? { ore: num(r.ore), str: num(r.str), caus: r.caus || null, oreAss: num(r.oreAss), nota: (r.nota || "").trim(), by: S.email, at: ora } : deleteField();
    batch.set(doc(collection(db, "log")), {
      giorno: iso, op: id, nomeOp: nomeOp(S.opById[id]), tipo: r ? (righe[id] ? "modifica" : "inserimento") : "eliminazione",
      prima: righe[id] ? pulisci(righe[id]) : null, dopo: r ? pulisci(r) : null, by: S.email, at: ora,
    });
  }
  let auto = 0;
  if (info.presunto) {
    for (const op of S.operai) {
      if (op.attivo === false || righe[op.id] || op.id in changes) continue;
      nuove[op.id] = { ore: info.std, str: 0, caus: null, oreAss: 0, nota: "", by: S.email, at: ora, auto: true };
      auto++;
    }
    if (auto) batch.set(doc(collection(db, "log")), { giorno: iso, tipo: "conferma presenze ordinarie", n: auto, by: S.email, at: ora });
  }
  if (!Object.keys(nuove).length) { toast("Niente da salvare"); return; }
  batch.set(doc(db, "presenze", iso), { righe: nuove, by: S.email, at: ora }, { merge: true });
  commit(batch, okMsg);
}
function pulisci(r) { return { ore: num(r.ore), str: num(r.str), caus: r.caus || null, oreAss: num(r.oreAss), nota: r.nota || "" }; }

// ---------------------------------------------------------------------------
// Pannello di modifica
function apriSheet(html, onBind) {
  const sh = $("#sheet");
  sh.innerHTML = `<div class="maniglia"></div>` + html;
  sh.classList.remove("hidden");
  $("#sheet-bg").classList.remove("hidden");
  $("#sheet-bg").onclick = chiudiSheet;
  onBind && onBind(sh);
}
function chiudiSheet() { $("#sheet").classList.add("hidden"); $("#sheet-bg").classList.add("hidden"); $("#sheet").innerHTML = ""; }
addEventListener("keydown", (e) => { if (e.key === "Escape") chiudiSheet(); });

function stepper(nome, val) {
  return `<div class="stepper" data-step="${nome}"><button type="button" data-d="-0.5">−</button>
    <input inputmode="decimal" name="${nome}" value="${fmt(val)}"><button type="button" data-d="0.5">+</button></div>`;
}

function formRiga(info, r, multi) {
  return `
  <div class="rapidi">
    <button type="button" class="btn" data-q="pres">✓ Presente ${fmt(info.base)}h</button>
    <button type="button" class="btn" data-q="mezza">◐ Mezza giornata</button>
    <button type="button" class="btn" data-q="ass">✗ Assente</button>
    <button type="button" class="btn" data-q="off">— Non in servizio</button>
  </div>
  <div class="griglia2">
    <div><label>Ore ordinarie</label>${stepper("ore", r.ore)}</div>
    <div><label>Straordinario (ore)</label>${stepper("str", r.str)}</div>
  </div>
  <div class="griglia2">
    <div><label>Ore di assenza</label>${stepper("oreAss", r.oreAss)}</div>
    <div></div>
  </div>
  <label>Causale assenza</label>
  <div class="chips" data-causali>${CAUSALI.map((c) => `<button type="button" class="chip ${r.caus === c.c ? "on" : ""}" data-c="${c.c}">${esc(c.n)}</button>`).join("")}</div>
  <label>Nota ${multi ? "(stessa per tutti)" : ""}</label>
  <textarea name="nota" placeholder="Es. cantiere, motivo, dettagli">${esc(r.nota || "")}</textarea>
  <p class="error" data-err></p>`;
}

function leggiForm(sh, causBox = $("[data-causali]", sh)) {
  const caus = $(".chip.on", causBox);
  return { ore: num($("[name=ore]", sh).value), str: num($("[name=str]", sh).value), oreAss: num($("[name=oreAss]", sh).value), caus: caus ? caus.dataset.c : null, nota: $("[name=nota]", sh).value };
}

function bindForm(sh, info, causBox = $("[data-causali]", sh)) {
  sh.querySelectorAll("[data-step] button").forEach((b) => (b.onclick = () => {
    const inp = b.parentElement.querySelector("input");
    inp.value = fmt(Math.min(24, Math.max(0, num(inp.value) + Number(b.dataset.d))));
  }));
  const setv = (n, v) => ($(`[name=${n}]`, sh).value = fmt(v));
  const setC = (c) => causBox.querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("on", x.dataset.c === c));
  causBox.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => {
    const on = !b.classList.contains("on");
    setC(on ? b.dataset.c : null);
    if (on && num($("[name=oreAss]", sh).value) === 0) { setv("oreAss", Math.max(0, info.base - num($("[name=ore]", sh).value)) || info.base); }
  }));
  sh.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => {
    const q = b.dataset.q, cur = $(".chip.on", causBox);
    $("[data-err]", sh).textContent = "";
    if (q === "pres") { setv("ore", info.base); setv("oreAss", 0); setC(null); }
    if (q === "mezza") { setv("ore", info.base / 2); setv("oreAss", info.base / 2); if (!cur) setC("PER"); }
    if (q === "ass") { setv("ore", 0); setv("oreAss", info.base); setv("str", 0); if (!cur) $("[data-err]", sh).textContent = "Scegli la causale dell'assenza"; }
    if (q === "off") { setv("ore", 0); setv("oreAss", 0); setv("str", 0); setC(null); }
  }));
}

function validaRiga(r, sh) {
  const err = $("[data-err]", sh);
  if (r.oreAss > 0 && !r.caus) { err.textContent = "Scegli la causale dell'assenza"; return false; }
  if (!r.oreAss) r.caus = null;
  if (r.ore + r.str + r.oreAss > 24) { err.textContent = "Il totale supera le 24 ore"; return false; }
  return true;
}

function apriEditor(iso, ids) {
  const id = ids[0];
  const g = S.giorni[iso] || {};
  const info = infoGiorno(iso, g);
  const esistente = (g.righe || {})[id];
  const r = esistente ? { ...esistente } : (info.presunto ? { ore: info.std, str: 0, oreAss: 0, caus: null, nota: "" } : { ore: info.base, str: 0, oreAss: 0, caus: null, nota: "" });
  const op = S.opById[id];
  const footer = esistente && esistente.by ? `<p class="muted small">Ultima modifica: ${esc(S.membri.nomi[esistente.by] || esistente.by)} — ${quando(esistente.at)}</p>` : "";
  apriSheet(`<h2>${esc(nomeOp(op))}</h2><div class="muted small">${esc(titoloData(iso))} ${daISO(iso).getFullYear()}${info.festa ? " · " + esc(info.festa) : ""}</div>
    ${formRiga(info, r, false)}
    ${footer}
    <div class="azioni">
      ${esistente ? `<button class="btn danger" data-del title="Elimina la registrazione">Elimina</button>` : ""}
      <button class="btn" data-annulla>Annulla</button>
      <button class="btn primary" data-salva>Salva</button>
    </div>`, (sh) => {
    bindForm(sh, info);
    $("[data-annulla]", sh).onclick = chiudiSheet;
    $("[data-salva]", sh).onclick = () => {
      const nr = leggiForm(sh);
      if (!validaRiga(nr, sh)) return;
      // In un giorno non lavorativo "non in servizio" = nessuna registrazione
      const vuota = !nr.ore && !nr.str && !nr.oreAss && !nr.nota.trim();
      salvaRighe(iso, { [id]: vuota && !info.presunto ? null : nr });
      chiudiSheet();
    };
    const del = $("[data-del]", sh);
    if (del) del.onclick = () => {
      if (!confirm("Eliminare la registrazione di questo operaio per il giorno?")) return;
      const b = writeBatch(db);
      b.set(doc(db, "presenze", iso), { righe: { [id]: deleteField() }, by: S.email, at: serverTimestamp() }, { merge: true });
      b.set(doc(collection(db, "log")), { giorno: iso, op: id, nomeOp: nomeOp(op), tipo: "eliminazione", prima: pulisci(esistente), dopo: null, by: S.email, at: serverTimestamp() });
      commit(b, "Registrazione eliminata");
      chiudiSheet();
    };
  });
}

function apriEditorMulti(iso) {
  const g = S.giorni[iso] || {};
  const info = infoGiorno(iso, g);
  const righe = g.righe || {};
  const lista = operaiDelGiorno(righe).filter((o) => o.attivo !== false || righe[o.id]);
  // Preselezionati: chi risulta in servizio (registrato con ore o presunto presente)
  const sel = new Set(lista.filter((o) => { const r = righe[o.id]; return r ? num(r.ore) > 0 : info.presunto; }).map((o) => o.id));
  const r = { ore: info.base, str: 0, oreAss: 0, caus: null, nota: "" };
  apriSheet(`<h2>Modifica più operai</h2><div class="muted small">${esc(titoloData(iso))} — es. maltempo dalle 11 per tutta la squadra</div>
    <label>Operai <button type="button" class="btn link small" data-tutti>tutti</button><button type="button" class="btn link small" data-nessuno>nessuno</button></label>
    <div class="chips" data-sel>${lista.map((o) => `<button type="button" class="chip ${sel.has(o.id) ? "on" : ""}" data-id="${o.id}">${esc(o.cognome)} ${esc((o.nome || "").charAt(0))}.</button>`).join("")}</div>
    ${formRiga(info, r, true).replace('data-causali', 'data-causali-m')}
    <div class="azioni"><button class="btn" data-annulla>Annulla</button><button class="btn primary" data-salva>Applica</button></div>`, (sh) => {
    sh.querySelectorAll("[data-sel] .chip").forEach((c) => (c.onclick = () => c.classList.toggle("on")));
    $("[data-tutti]", sh).onclick = () => sh.querySelectorAll("[data-sel] .chip").forEach((c) => c.classList.add("on"));
    $("[data-nessuno]", sh).onclick = () => sh.querySelectorAll("[data-sel] .chip").forEach((c) => c.classList.remove("on"));
    const causBox = $("[data-causali-m]", sh);
    bindForm(sh, info, causBox);
    $("[data-annulla]", sh).onclick = chiudiSheet;
    $("[data-salva]", sh).onclick = () => {
      const ids = $$("[data-sel] .chip.on", sh).map((c) => c.dataset.id);
      const nr = leggiForm(sh, causBox);
      if (!ids.length) { $("[data-err]", sh).textContent = "Seleziona almeno un operaio"; return; }
      if (!validaRiga(nr, sh)) return;
      salvaRighe(iso, Object.fromEntries(ids.map((id) => [id, { ...nr }])), `Applicato a ${ids.length} operai`);
      chiudiSheet();
    };
  });
}
function mostraDettaglio(iso, id) {
  const g = S.giorni[iso] || {};
  const r = (g.righe || {})[id];
  const info = infoGiorno(iso, g);
  const st = statoRiga(r, info);
  apriSheet(`<h2>${esc(nomeOp(S.opById[id]))}</h2><div class="muted small">${esc(titoloData(iso))} ${daISO(iso).getFullYear()}</div>
    <p><span class="stato ${st.cls}">${esc(st.txt)}</span></p>
    ${r ? `<p class="small">Ore ordinarie <b>${fmt(r.ore)}</b> · Straordinario <b>${fmt(r.str)}</b> · Assenza <b>${fmt(r.oreAss)}</b>${r.caus ? " (" + esc(CAUS[r.caus]?.n) + ")" : ""}</p>
      ${r.nota ? `<p class="small">📝 ${esc(r.nota)}</p>` : ""}
      <p class="muted small">Registrato da ${esc(S.membri.nomi[r.by] || r.by || "")} — ${quando(r.at)}</p>` : `<p class="muted small">Nessuna registrazione.</p>`}
    <p class="muted small">${esc(puoModificare(iso).motivo || "")}</p>
    <div class="azioni"><button class="btn" data-annulla>Chiudi</button></div>`, (sh) => ($("[data-annulla]", sh).onclick = chiudiSheet));
}

// ---------------------------------------------------------------------------
// Calcoli mensili
function calcolaMese(mk) {
  const n = giorniNelMese(mk);
  const oggi = oggiISO();
  const ids = new Set(S.operai.filter((o) => o.attivo !== false).map((o) => o.id));
  for (let d = 1; d <= n; d++) Object.keys((S.giorni[`${mk}-${String(d).padStart(2, "0")}`] || {}).righe || {}).forEach((id) => ids.add(id));
  const operai = [...ids].map((id) => S.opById[id] || { id, cognome: "(operaio eliminato)", nome: "", attivo: false }).sort(ordinaOp);
  const tot = {};
  const giorniMancanti = [];
  const maltempo = [];
  const note = [];
  for (const op of operai) tot[op.id] = { gg: 0, ore: 0, str: 0, fest: 0, caus: Object.fromEntries(CAUSALI.map((c) => [c.c, 0])) };
  for (let d = 1; d <= n; d++) {
    const iso = `${mk}-${String(d).padStart(2, "0")}`;
    const g = S.giorni[iso] || {};
    const info = infoGiorno(iso, g);
    const righe = g.righe || {};
    let manca = false;
    for (const op of operai) {
      const r = righe[op.id];
      if (!r) { if (info.presunto && op.attivo !== false && iso <= oggi) manca = true; continue; }
      const t = tot[op.id];
      const ore = num(r.ore), str = num(r.str), oa = num(r.oreAss);
      t.ore += ore; t.str += str;
      if (ore > 0 || str > 0) t.gg++;
      if (info.festivo) t.fest += ore + str;
      if (oa > 0 && r.caus) t.caus[r.caus] += oa;
      if (r.caus === "MLT" && oa > 0) maltempo.push({ iso, op, ore: oa, lav: ore, nota: r.nota || "" });
      if (r.nota) note.push({ iso, op, nota: r.nota });
    }
    if (manca) giorniMancanti.push(iso);
  }
  return { operai, tot, giorniMancanti, maltempo, note, n };
}

// ---------------------------------------------------------------------------
// Vista CALENDARIO
function vCalendario(el) {
  const mk = S.meseVista;
  assicuraMese(mk);
  let h = navData(nomeMese(mk).replace(/^./, (c) => c.toUpperCase()), meseChiuso(mk) ? "🔒 mese chiuso" : "", "month", mk);
  h += `<select data-calop style="margin-bottom:10px"><option value="tutti">Tutti gli operai (griglia)</option>
    ${S.operai.map((o) => `<option value="${o.id}" ${S.calOp === o.id ? "selected" : ""}>${esc(nomeOp(o))}${o.attivo === false ? " (non attivo)" : ""}</option>`).join("")}</select>`;
  if (!S.mkLoaded) { el.innerHTML = h + `<div class="vuoto-msg"><div class="spinner" style="margin:auto"></div></div>`; bindNav(el, "mese"); return; }
  const n = giorniNelMese(mk);
  const oggi = oggiISO();
  if (S.calOp === "tutti" || !S.opById[S.calOp]) {
    const { operai, tot } = calcolaMese(mk);
    h += `<div class="scroll-x"><table class="mese"><thead><tr><th>Operaio</th>`;
    for (let d = 1; d <= n; d++) {
      const iso = `${mk}-${String(d).padStart(2, "0")}`;
      const info = infoGiorno(iso);
      h += `<th class="${info.festivo ? "festcol" : ""}" title="${esc(info.festa || "")}">${d}<br><span style="font-weight:400">${GIORNI_BREVI[info.gs].charAt(0)}</span></th>`;
    }
    h += `<th>Ore</th><th>Str</th></tr></thead><tbody>`;
    for (const op of operai) {
      h += `<tr><td>${esc(op.cognome)} ${esc((op.nome || "").charAt(0))}.</td>`;
      for (let d = 1; d <= n; d++) {
        const iso = `${mk}-${String(d).padStart(2, "0")}`;
        const g = S.giorni[iso] || {};
        const info = infoGiorno(iso, g);
        const r = (g.righe || {})[op.id];
        const st = statoRiga(r, info);
        let cls = "c-" + st.cls.split(" ")[0], txt = st.cod;
        if (!r && info.presunto) { cls = "c-manca"; txt = iso <= oggi && op.attivo !== false ? "?" : ""; }
        h += `<td class="cell ${cls} ${info.festivo ? "festcol" : ""}" data-iso="${iso}">${esc(txt)}</td>`;
      }
      h += `<td><b>${fmt(tot[op.id].ore)}</b></td><td>${fmt(tot[op.id].str)}</td></tr>`;
    }
    h += `</tbody></table></div>`;
  } else {
    const op = S.opById[S.calOp];
    const primo = giornoSett(`${mk}-01`);
    h += `<div class="cal">${GIORNI_BREVI.map((g) => `<div class="gs">${g}</div>`).join("")}`;
    for (let i = 0; i < primo; i++) h += `<div class="g vuoto"></div>`;
    for (let d = 1; d <= n; d++) {
      const iso = `${mk}-${String(d).padStart(2, "0")}`;
      const g = S.giorni[iso] || {};
      const info = infoGiorno(iso, g);
      const r = (g.righe || {})[op.id];
      const st = statoRiga(r, info);
      let txt = st.cod, col = "c-" + st.cls.split(" ")[0];
      if (!r && info.presunto) { txt = iso <= oggi ? "?" : ""; col = "c-manca"; }
      h += `<button class="g ${info.festivo ? "fest" : ""} ${iso === oggi ? "oggi" : ""}" data-iso="${iso}" title="${esc(info.festa || "")}">
        <span class="n">${d}</span><span class="v"><span class="${col}" style="color:var(--${col === "c-pres" ? "pres" : col === "c-ass" ? "ass" : col === "c-parz" ? "parz" : "muted"})">${esc(txt)}</span></span>${r && r.nota ? `<span class="small">📝</span>` : ""}</button>`;
    }
    h += `</div>`;
    const { tot } = calcolaMese(mk);
    const t = tot[op.id];
    if (t) h += `<div class="card" style="margin-top:12px"><b>${esc(nomeOp(op))}</b> — ${esc(nomeMese(mk))}<br>
      <span class="small">Giorni lavorati <b>${t.gg}</b> · Ore ordinarie <b>${fmt(t.ore)}</b> · Straordinario <b>${fmt(t.str)}</b>${t.fest ? ` · di cui in festivi <b>${fmt(t.fest)}</b>` : ""}<br>
      ${CAUSALI.filter((c) => t.caus[c.c]).map((c) => `${esc(c.n)} <b>${fmt(t.caus[c.c])}h</b>`).join(" · ") || "Nessuna assenza"}</span></div>`;
  }
  h += legenda();
  el.innerHTML = h;
  bindNav(el, "mese");
  $("[data-calop]", el).onchange = (e) => { S.calOp = e.target.value; render(); };
  el.querySelectorAll("[data-iso]").forEach((c) => (c.onclick = () => { S.data = c.dataset.iso; S.view = "giorno"; render(); scrollTo(0, 0); }));
}

function legenda() {
  return `<div class="legenda"><span><b>8</b> ore ordinarie</span><span><b>8+2</b> con straordinario</span><span><b>4/F</b> parziale</span>
    ${CAUSALI.map((c) => `<span><b>${c.s}</b> ${esc(c.n)}</span>`).join("")}<span><b>?</b> da registrare</span><span><b>–</b> non in servizio</span></div>`;
}

// ---------------------------------------------------------------------------
// Vista RIEPILOGO
function vRiepilogo(el) {
  const mk = S.meseVista;
  assicuraMese(mk);
  const chiuso = meseChiuso(mk);
  let h = navData("Riepilogo " + nomeMese(mk), chiuso ? "🔒 mese chiuso" : "", "month", mk);
  if (!S.mkLoaded) { el.innerHTML = h + `<div class="vuoto-msg"><div class="spinner" style="margin:auto"></div></div>`; bindNav(el, "mese"); return; }
  const M = calcolaMese(mk);
  if (M.giorniMancanti.length) {
    h += `<div class="avviso" style="margin:0 0 10px"><span>⚠️ Giorni non ancora confermati: ${M.giorniMancanti.map((iso) => `<a href="#" data-iso="${iso}">${Number(iso.slice(8))}</a>`).join(", ")}</span></div>`;
  }
  h += `<div class="scroll-x"><table><thead><tr><th>Operaio</th><th>GG lav.</th><th>Ore ord.</th><th>Straord.</th><th title="Ore lavorate di domenica o festivi">Festivi</th>
    ${CAUSALI.map((c) => `<th title="${esc(c.n)} (ore)">${esc(c.n.split(" /")[0].replace("Assenza ingiustificata", "Ingiust."))}</th>`).join("")}</tr></thead><tbody>`;
  const somma = { gg: 0, ore: 0, str: 0, fest: 0, caus: Object.fromEntries(CAUSALI.map((c) => [c.c, 0])) };
  for (const op of M.operai) {
    const t = M.tot[op.id];
    somma.gg += t.gg; somma.ore += t.ore; somma.str += t.str; somma.fest += t.fest;
    CAUSALI.forEach((c) => (somma.caus[c.c] += t.caus[c.c]));
    h += `<tr><td><a href="#" data-op="${op.id}">${esc(nomeOp(op))}</a></td><td>${t.gg}</td><td><b>${fmt(t.ore)}</b></td><td>${fmt(t.str) === "0" ? "" : fmt(t.str)}</td><td>${t.fest ? fmt(t.fest) : ""}</td>
      ${CAUSALI.map((c) => `<td>${t.caus[c.c] ? fmt(t.caus[c.c]) : ""}</td>`).join("")}</tr>`;
  }
  h += `<tr><td><b>Totale</b></td><td><b>${somma.gg}</b></td><td><b>${fmt(somma.ore)}</b></td><td><b>${fmt(somma.str)}</b></td><td><b>${fmt(somma.fest)}</b></td>
    ${CAUSALI.map((c) => `<td><b>${somma.caus[c.c] ? fmt(somma.caus[c.c]) : ""}</b></td>`).join("")}</tr></tbody></table></div>
    <p class="muted small">Assenze espresse in ore. "Festivi" = ore lavorate di domenica o in giorni festivi (già comprese nelle colonne ore/straordinario).</p>`;

  if (ruoloUfficio()) {
    h += `<div class="row wrap" style="margin:12px 0">
      <button class="btn primary" data-export>⬇ Esporta Excel per il consulente</button>
      <button class="btn ${chiuso ? "" : "danger"}" data-chiudi>${chiuso ? "🔓 Riapri mese" : "🔒 Chiudi mese"}</button></div>`;
    if (chiuso && S.mesi[mk]) h += `<p class="muted small">Chiuso da ${esc(S.membri.nomi[S.mesi[mk].by] || S.mesi[mk].by)} il ${quando(S.mesi[mk].at)}. Le presenze del mese non sono più modificabili.</p>`;
    else h += `<p class="muted small">Dopo l'invio al consulente chiudi il mese: nessuno potrà più modificarlo finché l'ufficio non lo riapre (la riapertura resta registrata).</p>`;
  }

  h += `<h3>🌧 Maltempo del mese (per la domanda CIGO)</h3>`;
  if (!M.maltempo.length) h += `<p class="muted small">Nessuna ora di maltempo registrata.</p>`;
  else {
    const perGiorno = {};
    M.maltempo.forEach((x) => ((perGiorno[x.iso] = perGiorno[x.iso] || []).push(x)));
    h += `<div class="scroll-x"><table><thead><tr><th>Data</th><th>Operai</th><th>Ore perse</th><th style="text-align:left">Note</th></tr></thead><tbody>`;
    for (const [iso, xs] of Object.entries(perGiorno).sort()) {
      h += `<tr><td>${dataBreve(iso)}</td><td>${xs.length}</td><td>${fmt(xs.reduce((a, x) => a + x.ore, 0))}</td><td style="text-align:left;white-space:normal">${esc([...new Set(xs.map((x) => x.nota).filter(Boolean))].join("; "))}</td></tr>`;
    }
    h += `</tbody></table></div><p class="muted small">Il dettaglio per operaio è nel foglio "Maltempo" dell'export Excel.</p>`;
  }
  el.innerHTML = h;
  bindNav(el, "mese");
  el.querySelectorAll("[data-iso]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); S.data = a.dataset.iso; S.view = "giorno"; render(); }));
  el.querySelectorAll("[data-op]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); S.calOp = a.dataset.op; S.view = "calendario"; render(); }));
  const ex = $("[data-export]", el);
  if (ex) ex.onclick = () => esportaExcel(mk, M);
  const ch = $("[data-chiudi]", el);
  if (ch) ch.onclick = () => {
    if (!chiuso && M.giorniMancanti.length && !confirm(`Ci sono ${M.giorniMancanti.length} giorni non confermati. Chiudere comunque il mese?`)) return;
    if (!chiuso && !confirm(`Chiudere ${nomeMese(mk)}? Le presenze non saranno più modificabili.`)) return;
    if (chiuso && !confirm(`Riaprire ${nomeMese(mk)} per correzioni?`)) return;
    const b = writeBatch(db);
    b.set(doc(db, "mesi", mk), { chiuso: !chiuso, by: S.email, at: serverTimestamp() });
    b.set(doc(collection(db, "log")), { giorno: `${mk}-01`, tipo: chiuso ? "riapertura mese" : "chiusura mese", mese: mk, by: S.email, at: serverTimestamp() });
    commit(b, chiuso ? "Mese riaperto" : "Mese chiuso");
  };
}

// ---------------------------------------------------------------------------
// Export Excel (griglia operai × giorni, come richiesto dal consulente)
function caricaXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = "vendor/xlsx.full.min.js";
    s.onload = () => ok(window.XLSX);
    s.onerror = () => ko(new Error("Libreria Excel non disponibile"));
    document.head.appendChild(s);
  });
}

async function esportaExcel(mk, M) {
  let XLSX;
  try { XLSX = await caricaXLSX(); } catch (e) { toast(e.message, true); return; }
  const n = M.n;
  const giorni = [...Array(n)].map((_, i) => `${mk}-${String(i + 1).padStart(2, "0")}`);
  const intest1 = ["Operaio", "Qualifica", ...giorni.map((iso) => Number(iso.slice(8))), "GG lavorati", "Ore ordinarie", "Straordinario", "di cui festivi", ...CAUSALI.map((c) => c.n + " (h)")];
  const intest2 = ["", "", ...giorni.map((iso) => { const i = infoGiorno(iso); return i.festa ? "FEST" : GIORNI_BREVI[i.gs]; }), "", "", "", "", ...CAUSALI.map(() => "")];
  const righe = [
    [`Teknoedil S.r.l. — Presenze ${nomeMese(mk)}`],
    [`Estratto il ${new Date().toLocaleString("it-IT")}${meseChiuso(mk) ? " — mese chiuso" : " — mese NON chiuso"}`],
    [],
    intest1, intest2,
  ];
  for (const op of M.operai) {
    const t = M.tot[op.id];
    const celle = giorni.map((iso) => {
      const g = S.giorni[iso] || {};
      const info = infoGiorno(iso, g);
      const r = (g.righe || {})[op.id];
      if (!r) return info.presunto && iso <= oggiISO() && op.attivo !== false ? "?" : "";
      const st = statoRiga(r, info);
      const v = st.cod === "–" ? "" : st.cod;
      return /^\d+(,\d+)?$/.test(v) ? num(v) : v;
    });
    righe.push([nomeOp(op), op.qualifica || "", ...celle, t.gg, t.ore, t.str, t.fest, ...CAUSALI.map((c) => t.caus[c.c] || 0)]);
  }
  righe.push([]);
  righe.push(["Legenda: numero = ore ordinarie; 8+2 = ore ordinarie + straordinario; 4/F = 4 ore lavorate e il resto per la causale indicata; ? = non registrato; FEST = festività"]);
  righe.push(["Sigle: " + CAUSALI.map((c) => `${c.s} = ${c.n}`).join("; ")]);
  const ws = XLSX.utils.aoa_to_sheet(righe);
  ws["!cols"] = [{ wch: 26 }, { wch: 18 }, ...giorni.map(() => ({ wch: 5 })), { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 11 }, ...CAUSALI.map(() => ({ wch: 12 }))];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 12 } }];

  const mal = [["Data", "Operaio", "Ore lavorate", "Ore perse per maltempo", "Note"],
    ...M.maltempo.map((x) => [dataBreve(x.iso), nomeOp(x.op), x.lav, x.ore, x.nota])];
  const wsM = XLSX.utils.aoa_to_sheet(mal);
  wsM["!cols"] = [{ wch: 12 }, { wch: 26 }, { wch: 12 }, { wch: 20 }, { wch: 50 }];
  const not = [["Data", "Operaio", "Nota"], ...M.note.map((x) => [dataBreve(x.iso), nomeOp(x.op), x.nota])];
  const wsN = XLSX.utils.aoa_to_sheet(not);
  wsN["!cols"] = [{ wch: 12 }, { wch: 26 }, { wch: 70 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Presenze");
  XLSX.utils.book_append_sheet(wb, wsM, "Maltempo");
  XLSX.utils.book_append_sheet(wb, wsN, "Note");
  XLSX.writeFile(wb, `Presenze_Teknoedil_${mk}.xlsx`);
  if (M.giorniMancanti.length) toast(`Esportato. Attenzione: ${M.giorniMancanti.length} giorni non confermati (segnati con ?)`, true);
  else toast("Excel esportato");
}

// ---------------------------------------------------------------------------
// Vista OPERAI (ufficio)
function vOperai(el) {
  if (!ruoloUfficio()) { S.view = "giorno"; render(); return; }
  const filtro = (S.filtroOp || "").toLowerCase();
  const lista = S.operai.filter((o) => !filtro || nomeOp(o).toLowerCase().includes(filtro) || (o.qualifica || "").toLowerCase().includes(filtro));
  const attivi = lista.filter((o) => o.attivo !== false), inatt = lista.filter((o) => o.attivo === false);
  let h = `<div class="row" style="margin-bottom:10px"><h2 class="grow" style="margin:0">Operai <span class="muted small">(${S.operai.filter((o) => o.attivo !== false).length} attivi)</span></h2>
    <button class="btn primary" data-nuovo>+ Nuovo</button></div>
    <input class="cerca" type="search" placeholder="Cerca per nome o qualifica" value="${esc(S.filtroOp || "")}" data-cerca>`;
  const blocco = (arr) => `<div class="lista">${arr.map((o) => `<button class="voce ${o.attivo === false ? "inattivo" : ""}" data-id="${o.id}">
      <span class="nome"><b>${esc(o.cognome)}</b> ${esc(o.nome)}<span class="q">${esc(o.qualifica || "—")}${o.matricola ? " · matr. " + esc(o.matricola) : ""}</span></span>
      <span class="muted">›</span></button>`).join("")}</div>`;
  if (!S.operai.length) h += `<div class="card vuoto-msg">Nessun operaio. Aggiungi il primo con "+ Nuovo".</div>`;
  if (attivi.length) h += blocco(attivi);
  if (inatt.length) h += `<div class="sez-titolo">Non attivi</div>` + blocco(inatt);
  el.innerHTML = h;
  const c = $("[data-cerca]", el);
  c.oninput = () => { S.filtroOp = c.value; const pos = c.selectionStart; vOperai(el); const nc = $("[data-cerca]", el); nc.focus(); nc.setSelectionRange(pos, pos); };
  $("[data-nuovo]", el).onclick = () => editorOperaio(null);
  el.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => editorOperaio(S.opById[b.dataset.id])));
}

function editorOperaio(op) {
  const o = op || { cognome: "", nome: "", qualifica: "", matricola: "", note: "", attivo: true };
  apriSheet(`<h2>${op ? "Modifica operaio" : "Nuovo operaio"}</h2>
    <div class="griglia2"><div><label>Cognome *</label><input name="cognome" value="${esc(o.cognome)}" autocapitalize="words"></div>
    <div><label>Nome *</label><input name="nome" value="${esc(o.nome)}" autocapitalize="words"></div></div>
    <label>Qualifica</label><input name="qualifica" list="qualifiche" value="${esc(o.qualifica || "")}">
    <datalist id="qualifiche">${QUALIFICHE.map((q) => `<option value="${esc(q)}">`).join("")}</datalist>
    <label>Matricola (facoltativa)</label><input name="matricola" value="${esc(o.matricola || "")}">
    <label>Note</label><textarea name="note">${esc(o.note || "")}</textarea>
    <label class="toggle"><input type="checkbox" name="attivo" ${o.attivo !== false ? "checked" : ""}> Attivo (compare nella giornata)</label>
    <p class="error" data-err></p>
    <div class="azioni"><button class="btn" data-annulla>Annulla</button><button class="btn primary" data-salva>Salva</button></div>`, (sh) => {
    $("[data-annulla]", sh).onclick = chiudiSheet;
    $("[data-salva]", sh).onclick = () => {
      const v = (n) => $(`[name=${n}]`, sh).value.trim();
      const cap = (s) => s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
      const dati = { cognome: cap(v("cognome")), nome: cap(v("nome")), qualifica: v("qualifica"), matricola: v("matricola"), note: v("note"), attivo: $("[name=attivo]", sh).checked, by: S.email, at: serverTimestamp() };
      if (!dati.cognome || !dati.nome) { $("[data-err]", sh).textContent = "Cognome e nome sono obbligatori"; return; }
      const ref = op ? doc(db, "operai", op.id) : doc(collection(db, "operai"));
      const b = writeBatch(db);
      if (!op) dati.creato = serverTimestamp();
      b.set(ref, dati, { merge: true });
      b.set(doc(collection(db, "log")), { giorno: oggiISO(), tipo: op ? "modifica anagrafica" : "nuovo operaio", op: ref.id, nomeOp: `${dati.cognome} ${dati.nome}`, by: S.email, at: serverTimestamp() });
      commit(b, op ? "Operaio aggiornato" : "Operaio aggiunto");
      chiudiSheet();
    };
  });
}

// ---------------------------------------------------------------------------
// Vista ALTRO / IMPOSTAZIONI
function vImpostazioni(el) {
  const io = S.membri.nomi[S.email] || (S.user && S.user.displayName) || "";
  let h = `<div class="sez-titolo">Account</div>
    <div class="card"><b>${esc(io)}</b><br><span class="small muted">${esc(S.email)} — ${RUOLI[S.ruolo] || S.ruolo}</span>
    <div class="row wrap" style="margin-top:10px"><button class="btn small" data-esci>Esci</button>
    ${S.installPrompt ? `<button class="btn small primary" data-installa>📲 Installa l'app</button>` : ""}</div>
    ${!S.installPrompt && !matchMedia("(display-mode: standalone)").matches ? `<p class="muted small">Per installarla sul telefono: menu del browser → "Aggiungi a schermata Home" / "Installa app".</p>` : ""}</div>`;

  if (S.ruolo === "admin") {
    const emails = Object.keys(S.membri.ruoli).sort();
    h += `<div class="sez-titolo">Utenti con accesso</div><div class="lista elenco-imp">
      ${emails.map((e) => `<div class="voce"><span class="nome"><b>${esc(S.membri.nomi[e] || e)}</b><span class="q">${esc(e)}</span></span>
        <select data-ruolo="${esc(e)}" style="width:auto" ${e === S.email ? "disabled" : ""}>${Object.entries(RUOLI).map(([k, n]) => `<option value="${k}" ${S.membri.ruoli[e] === k ? "selected" : ""}>${n}</option>`).join("")}</select>
        ${e === S.email ? "" : `<button class="btn small danger" data-rimuovi="${esc(e)}" title="Rimuovi accesso">✕</button>`}</div>`).join("")}
      </div>
      <div class="card" style="margin-top:8px"><b>Aggiungi utente</b>
        <label>Email Google</label><input data-nu-email type="email" placeholder="nome@gmail.com o email aziendale Google">
        <div class="griglia2"><div><label>Nome</label><input data-nu-nome></div>
        <div><label>Ruolo</label><select data-nu-ruolo>${Object.entries(RUOLI).map(([k, n]) => `<option value="${k}" ${k === "caposquadra" ? "selected" : ""}>${n}</option>`).join("")}</select></div></div>
        <p class="error" data-nu-err></p>
        <button class="btn primary" data-nu-add>Aggiungi</button>
        <p class="muted small">Caposquadra: inserisce le presenze e corregge gli ultimi ${FINESTRA_CAPO} giorni. Ufficio: modifica tutto, anagrafica, export, chiusura mesi. Amministratore: come ufficio + gestione utenti.</p>
      </div>`;
  }

  if (ruoloUfficio()) {
    const os = S.imp.oreSett || DEF_IMP.oreSett;
    const fl = S.imp.festivitaLocali || [];
    h += `<div class="sez-titolo">Orario e calendario</div>
      <div class="card"><b>Ore ordinarie previste per giorno</b><p class="muted small" style="margin:4px 0 8px">0 = giorno non lavorativo (nessuno è presunto presente; si possono comunque registrare ore).</p>
        <div class="ore-sett">${GIORNI_BREVI.map((g, i) => `<div>${g}<input data-os="${i}" inputmode="decimal" value="${fmt(os[i])}"></div>`).join("")}</div>
        <button class="btn small primary" data-salva-os style="margin-top:10px">Salva orario</button>
      </div>
      <div class="card"><b>Festività locali / aziendali</b><p class="muted small" style="margin:4px 0 8px">Le festività nazionali (compreso il 4 ottobre dal 2026) e Pasquetta sono già incluse. Aggiungi qui il patrono o altre chiusure fisse.</p>
        ${fl.map((f, i) => `<div class="row" style="margin-bottom:6px"><span class="grow">${esc(f.md.split("-").reverse().join("/"))} — ${esc(f.nome)}</span><button class="btn small danger" data-fl-del="${i}">✕</button></div>`).join("") || `<p class="muted small">Nessuna.</p>`}
        <div class="row"><input data-fl-data type="text" placeholder="gg/mm" style="width:90px"><input data-fl-nome placeholder="Descrizione (es. Santo patrono)"><button class="btn small" data-fl-add>+</button></div>
      </div>
      <div class="sez-titolo">Dati</div>
      <div class="card"><b>Backup</b><p class="muted small" style="margin:4px 0 8px">Il piano gratuito non ha copie automatiche: scarica il backup almeno una volta al mese e conservalo nel server/cartella aziendale.
        ${S.imp.ultimoBackup ? `Ultimo: ${quando(S.imp.ultimoBackup)}${S.imp.ultimoBackupBy ? " (" + esc(S.membri.nomi[S.imp.ultimoBackupBy] || S.imp.ultimoBackupBy) + ")" : ""}.` : "Nessun backup finora."}</p>
        <button class="btn small primary" data-backup>💾 Scarica backup completo</button></div>
      <div class="card"><b>Registro modifiche</b><p class="muted small" style="margin:4px 0 8px">Chi ha inserito o modificato cosa, e quando.</p>
        <button class="btn small" data-log>Mostra ultime 150 modifiche</button><div data-log-box></div></div>`;
  }

  h += `<p class="muted small" style="margin-top:20px">Presenze TEKNOEDIL — strumento interno di Teknoedil S.r.l. per la rilevazione delle presenze. Non sostituisce il Libro Unico del Lavoro né il gestionale del consulente paghe.</p>`;
  el.innerHTML = h;

  $("[data-esci]", el).onclick = () => { if (confirm("Uscire dall'app?")) signOut(auth); };
  const ins = $("[data-installa]", el);
  if (ins) ins.onclick = async () => { S.installPrompt.prompt(); await S.installPrompt.userChoice; S.installPrompt = null; render(); };

  if (S.ruolo === "admin") {
    const salvaMembri = (ruoli, nomi, msg) => {
      const b = writeBatch(db);
      b.set(doc(db, "config", "membri"), { ruoli, nomi, by: S.email, at: serverTimestamp() });
      b.set(doc(collection(db, "log")), { giorno: oggiISO(), tipo: "utenti: " + msg, by: S.email, at: serverTimestamp() });
      commit(b, "Utenti aggiornati");
    };
    el.querySelectorAll("[data-ruolo]").forEach((s) => (s.onchange = () => {
      const e = s.dataset.ruolo;
      salvaMembri({ ...S.membri.ruoli, [e]: s.value }, { ...S.membri.nomi }, `${e} → ${s.value}`);
    }));
    el.querySelectorAll("[data-rimuovi]").forEach((b) => (b.onclick = () => {
      const e = b.dataset.rimuovi;
      if (!confirm(`Togliere l'accesso a ${e}?`)) return;
      const ruoli = { ...S.membri.ruoli }, nomi = { ...S.membri.nomi };
      delete ruoli[e]; delete nomi[e];
      salvaMembri(ruoli, nomi, `rimosso ${e}`);
    }));
    $("[data-nu-add]", el).onclick = () => {
      const e = $("[data-nu-email]", el).value.trim().toLowerCase();
      const n = $("[data-nu-nome]", el).value.trim();
      const r = $("[data-nu-ruolo]", el).value;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { $("[data-nu-err]", el).textContent = "Email non valida"; return; }
      if (S.membri.ruoli[e]) { $("[data-nu-err]", el).textContent = "Utente già presente"; return; }
      salvaMembri({ ...S.membri.ruoli, [e]: r }, { ...S.membri.nomi, [e]: n }, `aggiunto ${e} (${r})`);
    };
  }

  if (ruoloUfficio()) {
    const salvaImp = (dati, msg) => {
      const b = writeBatch(db);
      b.set(doc(db, "config", "impostazioni"), { ...dati, by: S.email, at: serverTimestamp() }, { merge: true });
      b.set(doc(collection(db, "log")), { giorno: oggiISO(), tipo: "impostazioni: " + msg, by: S.email, at: serverTimestamp() });
      commit(b, "Impostazioni salvate");
    };
    $("[data-salva-os]", el).onclick = () => salvaImp({ oreSett: $$("[data-os]", el).map((i) => Math.min(24, Math.max(0, num(i.value)))) }, "orario settimanale");
    el.querySelectorAll("[data-fl-del]").forEach((b) => (b.onclick = () => {
      const fl = [...(S.imp.festivitaLocali || [])];
      const [x] = fl.splice(Number(b.dataset.flDel), 1);
      salvaImp({ festivitaLocali: fl }, `rimossa festività ${x.nome}`);
    }));
    $("[data-fl-add]", el).onclick = () => {
      const m = $("[data-fl-data]", el).value.trim().match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
      const nome = $("[data-fl-nome]", el).value.trim() || "Festività locale";
      if (!m || +m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) { toast("Data non valida: usa gg/mm", true); return; }
      const md = `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      const fl = [...(S.imp.festivitaLocali || []).filter((f) => f.md !== md), { md, nome }].sort((a, b) => a.md.localeCompare(b.md));
      salvaImp({ festivitaLocali: fl }, `festività ${md} ${nome}`);
    };
    $("[data-backup]", el).onclick = scaricaBackup;
    $("[data-log]", el).onclick = () => mostraLog($("[data-log-box]", el));
  }
}

async function mostraLog(box) {
  box.innerHTML = `<div class="spinner" style="margin:10px auto"></div>`;
  try {
    const qs = await getDocs(query(collection(db, "log"), orderBy("at", "desc"), limit(150)));
    const fr = (r) => r ? statoRiga(r, { base: 8 }).txt + (r.nota ? ` (${r.nota})` : "") : "—";
    box.innerHTML = `<div class="scroll-x" style="margin-top:10px"><table><thead><tr><th>Quando</th><th style="text-align:left">Chi</th><th style="text-align:left">Cosa</th></tr></thead><tbody>
      ${qs.docs.map((d) => { const x = d.data(); return `<tr><td>${quando(x.at)}</td><td style="text-align:left">${esc(S.membri.nomi[x.by] || x.by)}</td>
        <td style="text-align:left;white-space:normal">${esc(x.tipo)}${x.giorno && x.op ? " " + dataBreve(x.giorno) : ""}${x.nomeOp ? " — " + esc(x.nomeOp) : ""}${x.prima || x.dopo ? `: ${esc(fr(x.prima))} → ${esc(fr(x.dopo))}` : ""}${x.n ? ` (${x.n} operai, ${dataBreve(x.giorno)})` : ""}</td></tr>`; }).join("")}
      </tbody></table></div>`;
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function scaricaBackup() {
  toast("Preparo il backup…");
  try {
    const conv = (v) => {
      if (v instanceof Timestamp) return v.toDate().toISOString();
      if (Array.isArray(v)) return v.map(conv);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]));
      return v;
    };
    const out = { app: "Presenze TEKNOEDIL", creato: new Date().toISOString(), da: S.email };
    for (const c of ["config", "operai", "presenze", "mesi", "log"]) {
      const qs = await getDocs(collection(db, c));
      out[c] = Object.fromEntries(qs.docs.map((d) => [d.id, conv(d.data())]));
    }
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `backup_presenze_teknoedil_${oggiISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    await setDoc(doc(db, "config", "impostazioni"), { ultimoBackup: serverTimestamp(), ultimoBackupBy: S.email }, { merge: true });
    toast("Backup scaricato");
  } catch (e) { erroreScrittura(e); }
}

// ---------------------------------------------------------------------------
// Service worker (funzionamento offline dell'interfaccia)
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
