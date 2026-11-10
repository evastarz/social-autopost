#!/usr/bin/env node
// Pubblica i nuovi articoli dell'RSS dei siti elencati in sites.json su Facebook (Pagina), Telegram e X.
// Nessuna dipendenza da installare: serve solo Node 18+.
//
// Uso:   node autopost.mjs            -> pubblica davvero
//        node autopost.mjs --dry-run  -> mostra cosa pubblicherebbe, senza pubblicare né salvare
//
// Variabili d'ambiente (un social è attivo solo se ha le sue chiavi):
//   [PREFISSO_]FB_PAGE_ID, FB_PAGE_TOKEN                          -> Facebook
//   TG_BOT_TOKEN, TG_CHAT_ID (anche più canali: @a,@b)  -> Telegram
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET -> X
//   Le chiavi hanno il prefisso del sito (TIE_, SF_...), vedi sites.json e README.
//   MAX_AGE_HOURS (default 48)  articoli più vecchi non vengono mai pubblicati
//   MAX_PER_RUN   (default 3)   tetto di articoli per esecuzione (anti-valanga)
//   STATE_DIR     (default ./state)  un file di registro per sito
//   --site=<id>   elabora un solo sito di sites.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d = '') => (process.env[k] ?? d).trim();

// Credenziali del sito che si sta elaborando. Su GitHub arrivano tutte insieme in SECRETS_JSON
// (es. TIE_FB_PAGE_ID, SF_FB_PAGE_ID...); in locale si possono usare normali variabili d'ambiente con lo stesso nome.
let ALL_SECRETS = {};
try { ALL_SECRETS = JSON.parse(process.env.SECRETS_JSON || '{}'); } catch {}
let CURRENT = {};
const sec = (k) => String(CURRENT[k] ?? '').trim();
export const loadSecrets = (prefix) => {
  CURRENT = {};
  for (const k of ['FB_PAGE_ID','FB_PAGE_TOKEN','TG_BOT_TOKEN','TG_CHAT_ID','X_API_KEY','X_API_SECRET','X_ACCESS_TOKEN','X_ACCESS_SECRET'])
    CURRENT[k] = ALL_SECRETS[`${prefix}_${k}`] ?? process.env[`${prefix}_${k}`] ?? '';
};

// ---------- Errori con dettagli (per le "schede" di avviso) ----------
export class ApiError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.info = info;
  }
}

// Toglie dai testi ogni chiave/token/segreto (mai nei messaggi).
const redact = (v) => {
  let t = typeof v === 'string' ? v : JSON.stringify(v);
  const secrets = [...Object.entries(CURRENT), ...Object.entries(ALL_SECRETS)]
    .filter(([k]) => /TOKEN|SECRET|KEY/i.test(k))
    .map(([, x]) => String(x ?? '').trim())
    .filter((x) => x.length > 8);
  for (const x of secrets) t = t.split(x).join('***');
  return t;
};

// Ipotesi sulla causa, in base al social e al codice d'errore (aiuta a capire al volo).
export function diagnose(network, e) {
  const i = e.info || {};
  const msg = `${e.message} ${e.cause?.code || ''}`;
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|timeout/i.test(msg) && !i.http)
    return 'Problema di rete temporaneo (GitHub o il social non raggiungibile): di solito passa da solo.';
  if (network === 'facebook') {
    const c = i.error?.code;
    if (c === 190) return 'Token Facebook non valido o scaduto: rigenera il token dell\'utente di sistema (Impostazioni aziendali → Utenti di sistema → Genera token, scadenza Mai) e aggiorna *_FB_PAGE_TOKEN.';
    if ([200, 10, 3, 283].includes(c)) return 'Permessi mancanti: la Pagina non è assegnata all\'utente di sistema (accesso completo) o manca pages_manage_posts.';
    if ([4, 17, 32, 613].includes(c)) return 'Limite di richieste di Facebook: aspettare, di solito si risolve da solo.';
    if ([368, 1390008].includes(c)) return 'Facebook ha bloccato temporaneamente la pubblicazione (anti-spam).';
    if (c === 100) return 'Richiesta non valida: controllare l\'ID della Pagina (*_FB_PAGE_ID) e che il link dell\'articolo sia raggiungibile.';
    return 'Errore di Facebook: vedere codice e messaggio qui sopra.';
  }
  if (network.startsWith('telegram')) {
    const c = i.error_code;
    if (c === 400 && /chat not found/i.test(i.description || '')) return 'Canale non trovato: id sbagliato, o il bot non è amministratore del canale.';
    if (c === 403) return 'Il bot è stato rimosso dal canale o bloccato.';
    if (c === 401) return 'Token del bot sbagliato o revocato (BotFather → /mybots → API Token).';
    if (c === 429) return 'Troppi messaggi in poco tempo (limite di Telegram): si risolve da solo.';
    return 'Errore di Telegram: vedere descrizione qui sopra.';
  }
  if (network === 'x') {
    const h = i.http;
    if (h === 401) return 'Chiavi X sbagliate o rigenerate: ricontrollare le quattro *_X_… (API Key/Secret e Access Token/Secret).';
    if (h === 403) return 'X rifiuta: l\'app è in sola lettura (rigenerare l\'Access Token dopo aver salvato "Read and Write") oppure testo duplicato.';
    if (h === 402) return 'Credito X esaurito (piano a consumo): ricaricare.';
    if (h === 429) return 'Limite di post di X raggiunto: aspettare.';
    return 'Errore di X: vedere dettagli qui sopra.';
  }
  return 'Causa non riconosciuta: vedere il messaggio d\'errore.';
}

// ---------- Avvisi di errore su Telegram (chat privata di Eva) ----------
// Segreti generali (senza prefisso): ALERT_TG_CHAT_ID (obbligatorio per attivare gli avvisi) e ALERT_TG_BOT_TOKEN
// (facoltativo: se manca si usa il token di uno dei bot già configurati). Lo stesso errore viene segnalato
// al massimo una volta ogni 6 ore (registro in state/alerts.json).
const alertChat = () => String(ALL_SECRETS.ALERT_TG_CHAT_ID ?? process.env.ALERT_TG_CHAT_ID ?? '').trim();
const alertToken = () => {
  const t = ALL_SECRETS.ALERT_TG_BOT_TOKEN ?? process.env.ALERT_TG_BOT_TOKEN;
  if (t) return String(t).trim();
  const k = Object.keys(ALL_SECRETS).find((x) => x.endsWith('_TG_BOT_TOKEN'));
  return k ? String(ALL_SECRETS[k]).trim() : '';
};
const ALERTS_FILE = () => path.join(env('STATE_DIR', path.join(HERE, 'state')), 'alerts.json');

export async function sendAlert(key, text, force = false) {
  const chat = alertChat();
  const token = alertToken();
  if (!chat || !token) return false;
  try {
    let log = {};
    try { log = JSON.parse(await readFile(ALERTS_FILE(), 'utf8')); } catch {}
    const now = Date.now();
    const prev = typeof log[key] === 'string' ? { first: log[key], last: log[key], count: 1 } : log[key];
    if (!force && key && prev && now - Date.parse(prev.last) < 6 * 3600e3) return false; // già segnalato da poco
    if (key && prev && typeof text === 'string') text = text.replace('{N}', String(prev.count + 1)).replace('{FIRST}', prev.first);
    else if (typeof text === 'string') text = text.replace('{N}', '1').replace('{FIRST}', new Date().toISOString());
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3500), disable_web_page_preview: true }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      console.warn(`⚠️ Avviso Telegram non inviato: ${j.description || res.status}`);
      return false;
    }
    if (key) {
      log[key] = { first: prev?.first || new Date().toISOString(), last: new Date().toISOString(), count: (prev?.count || 0) + 1 };
      for (const k of Object.keys(log)) {
        const l = typeof log[k] === 'string' ? log[k] : log[k].last;
        if (now - Date.parse(l) > 7 * 86400e3) delete log[k]; // pulizia
      }
      await mkdir(path.dirname(ALERTS_FILE()), { recursive: true });
      await writeFile(ALERTS_FILE(), JSON.stringify(log, null, 2) + '\n');
    }
    return true;
  } catch (e) {
    console.warn(`⚠️ Avviso Telegram non inviato: ${e.message}`);
    return false;
  }
}

// ---------- Lettura del feed ----------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const unCdata = (s) => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};

export function parseFeed(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = decodeEntities(unCdata(tag(block, 'title'))).trim();
    const link = decodeEntities(unCdata(tag(block, 'link'))).trim();
    const guid = decodeEntities(unCdata(tag(block, 'guid'))).trim() || link;
    const date = new Date(tag(block, 'pubDate').trim());
    const desc = unCdata(tag(block, 'description'));
    const firstP = (desc.match(/<p>([\s\S]*?)<\/p>/i) || [, desc])[1];
    const excerpt = decodeEntities(decodeEntities(firstP).replace(/<[^>]*>/g, ' '))
      .replace(/\[…\]|\[&hellip;\]|\.\.\.$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const categories = [...block.matchAll(/<category>([\s\S]*?)<\/category>/gi)].map((c) =>
      decodeEntities(unCdata(c[1])).trim()
    );
    if (title && link && !Number.isNaN(date.getTime())) items.push({ title, link, guid, date, excerpt, categories });
  }
  return items;
}

// ---------- Testi dei post ----------

const cut = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

// Solo titolo + link: l'anteprima (immagine, titolo, descrizione) la crea il social dal link.
export function facebookText(item) {
  return `${item.title}`; // il link viaggia nel campo "link" e Facebook ne fa l'anteprima classica
}

export function telegramText(item) {
  return `${item.title}\n\n${item.link}`; // riga vuota tra titolo e link
}

export function xText(item) {
  // X conta ogni link come 23 caratteri, qualunque sia la lunghezza.
  return cut(`${item.title}`, 280 - 2 - 23) + `\n\n${item.link}`;
}

// ---------- Facebook ----------

// Il segreto FB_PAGE_TOKEN può essere il token di una Pagina oppure quello di un "utente di sistema" (senza scadenza):
// in quel caso a ogni esecuzione ricaviamo da lui il token della Pagina, come raccomanda Meta.
const pageTokenCache = new Map();
async function fbToken() {
  const key = sec('FB_PAGE_ID') + ':' + sec('FB_PAGE_TOKEN');
  if (pageTokenCache.has(key)) return pageTokenCache.get(key);
  let token = sec('FB_PAGE_TOKEN');
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${sec('FB_PAGE_ID')}?` + new URLSearchParams({ fields: 'access_token', access_token: token }));
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) token = json.access_token;
  } catch {}
  pageTokenCache.set(key, token);
  return token;
}

// Equivale al "Debugger di condivisione" di Facebook (pulsante "Scrapa di nuovo"): fa rileggere
// la pagina così l'anteprima usa l'immagine/titolo aggiornati e non quelli in cache.
async function refreshFacebookPreview(url) {
  const body = new URLSearchParams({ id: url, scrape: 'true', access_token: await fbToken() });
  const res = await fetch('https://graph.facebook.com/v21.0/', { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) console.warn(`⚠️ Aggiornamento anteprima Facebook non riuscito: ${json.error?.message || res.status}`);
  else console.log(`🔄 Anteprima Facebook aggiornata (immagine: ${json.image?.[0]?.url || 'non trovata'})`);
}

async function postFacebook(item) {
  await refreshFacebookPreview(item.link);
  const body = new URLSearchParams({
    message: facebookText(item),
    link: item.link,
    access_token: await fbToken(),
  });
  const res = await fetch(`https://graph.facebook.com/v21.0/${sec('FB_PAGE_ID')}/feed`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new ApiError(`Facebook: ${json.error?.message || res.status}`, { http: res.status, error: json.error });
  return json.id;
}

// ---------- Telegram ----------

// Telegram tiene in memoria l'anteprima di ogni indirizzo (anche con l'immagine vecchia). Per l'anteprima
// usiamo lo stesso indirizzo con un parametro unico: per Telegram è "nuovo" e rilegge la pagina. WordPress
// ignora il parametro. Nel testo del messaggio resta il link pulito.
export function freshPreviewUrl(link, stamp = Date.now()) {
  return link + (link.includes('?') ? '&' : '?') + 'tgpreview=' + stamp;
}

async function logOgImage(url) {
  try {
    const html = await (await fetch(url, { headers: { 'User-Agent': 'autopost/1.0' }, signal: AbortSignal.timeout(15000) })).text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    console.log(m ? `🖼️ Immagine di anteprima: ${decodeEntities(m[1])}` : '⚠️ La pagina non ha og:image: l\'anteprima potrebbe non avere immagine.');
  } catch (e) {
    console.warn(`⚠️ Controllo immagine non riuscito: ${e.message}`);
  }
}

async function postTelegram(item, chat = sec('TG_CHAT_ID')) {
  const previewUrl = freshPreviewUrl(item.link);
  await logOgImage(previewUrl);
  const res = await fetch(`https://api.telegram.org/bot${sec('TG_BOT_TOKEN')}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat,
      text: telegramText(item),
      link_preview_options: { url: previewUrl, prefer_large_media: true },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new ApiError(`Telegram: ${json.description || res.status}`, { http: res.status, error_code: json.error_code, description: json.description, parameters: json.parameters, canale: chat });
  return json.result?.message_id;
}

// ---------- X (OAuth 1.0a, firmato a mano per non avere dipendenze) ----------

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function oauthHeader(method, url, extra, keys, nonce = randomBytes(16).toString('hex'), ts = Math.floor(Date.now() / 1000)) {
  const oauth = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(ts),
    oauth_token: keys.token,
    oauth_version: '1.0',
  };
  const all = Object.entries({ ...oauth, ...extra })
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method.toUpperCase(), enc(url), enc(all)].join('&');
  oauth.oauth_signature = createHmac('sha1', `${enc(keys.consumerSecret)}&${enc(keys.tokenSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries(oauth).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}

async function postX(item) {
  const url = 'https://api.twitter.com/2/tweets';
  const auth = oauthHeader('POST', url, {}, {
    consumerKey: sec('X_API_KEY'),
    consumerSecret: sec('X_API_SECRET'),
    token: sec('X_ACCESS_TOKEN'),
    tokenSecret: sec('X_ACCESS_SECRET'),
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: xText(item) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(`X: ${json.detail || json.title || res.status}`, { http: res.status, title: json.title, detail: json.detail, type: json.type, errors: json.errors, limite_rimasto: res.headers.get('x-rate-limit-remaining') });
  return json.data?.id;
}

// ---------- Programma principale ----------

// I social attivi per il sito corrente. TG_CHAT_ID può contenere PIÙ canali separati da virgola
// (es. "@canale1,@canale2"): ognuno ha il suo "già pubblicato", così un errore su uno non duplica sull'altro.
// Il primo canale mantiene il nome storico "telegram" (compatibile con i registri esistenti).
function networksFor(site) {
  const chats = sec('TG_CHAT_ID').split(',').map((c) => c.trim()).filter(Boolean);
  const telegram = (chats.length ? chats : ['']).map((chat, i) => ({
    name: i === 0 ? 'telegram' : `telegram:${chat}`,
    enabled: () => sec('TG_BOT_TOKEN') && chat,
    post: (item) => postTelegram(item, chat),
    preview: telegramText,
  }));
  const off = (site?.disabled || []).map((x) => String(x).toLowerCase()); // social spenti per questo sito (sites.json)
  const list = [
    { name: 'facebook', enabled: () => sec('FB_PAGE_ID') && sec('FB_PAGE_TOKEN'), post: postFacebook, preview: facebookText },
    ...telegram,
    {
      name: 'x',
      enabled: () => sec('X_API_KEY') && sec('X_API_SECRET') && sec('X_ACCESS_TOKEN') && sec('X_ACCESS_SECRET'),
      post: postX,
      preview: xText,
    },
  ];
  return list.filter((n) => !off.includes(n.name.split(':')[0]));
}

// Scarica il feed riprovando fino a 3 volte (i siti ogni tanto rispondono male per un attimo).
async function fetchFeed(url) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'autopost/1.0' }, signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.text();
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = new Error(`${e.message}${e.cause?.code ? ' (' + e.cause.code + ')' : ''}`);
    }
    if (i < 3) await new Promise((r) => setTimeout(r, i * 3000));
  }
  throw new Error(`Feed non raggiungibile: ${last.message}`);
}


// Scheda completa da incollare a Claude: contiene tutto il necessario per capire l'errore.
export async function buildAlert(site, network, item, e, state) {
  const i = e.info || {};
  const lines = ['⚠️ ERRORE AUTOPOST — incolla tutto questo messaggio a Claude', ''];
  lines.push(`Sito: ${site.name} (id ${site.id}, prefisso segreti ${site.prefix}_)`);
  lines.push(`Social: ${network}`);
  if (item) lines.push(`Articolo: ${item.title}`, `Link: ${item.link}`);
  lines.push(`Errore: ${redact(e.message)}`);
  const details = { ...i };
  if (e.cause?.code) details.causa_rete = e.cause.code;
  if (Object.keys(details).length) lines.push(`Dettagli tecnici: ${redact(details).slice(0, 900)}`);
  lines.push(`Ipotesi: ${diagnose(network, e)}`);
  lines.push('', `Quando: ${new Date().toISOString()} (UTC; in Italia +1h)`);
  lines.push('Avviso n° {N} per questo stesso errore (primo: {FIRST}); ritento ogni 5 min, riavviso ogni 6 ore.');
  if (state) {
    const last = Object.entries(state.posted || {})
      .map(([g, v]) => v[network])
      .filter(Boolean)
      .sort()
      .pop();
    lines.push(`Ultimo post riuscito su ${network}: ${last || 'nessuno finora'}`);
  }
  const names = ['FB_PAGE_ID', 'FB_PAGE_TOKEN', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
  lines.push(`Segreti presenti: ${names.filter((k) => sec(k)).join(', ') || 'nessuno'}`);
  lines.push(`Segreti mancanti: ${names.filter((k) => !sec(k)).join(', ') || 'nessuno'} (normale se un social non è usato)`);
  if (network === 'facebook' && sec('FB_PAGE_TOKEN')) {
    try {
      const t = sec('FB_PAGE_TOKEN');
      const d = (await (await fetch('https://graph.facebook.com/v21.0/debug_token?' + new URLSearchParams({ input_token: t, access_token: t }))).json()).data;
      if (d) lines.push(`Token Facebook: tipo ${d.type}, valido ${d.is_valid ? 'sì' : 'NO'}, scadenza ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'mai'}, permessi ${(d.scopes || []).join(',')}${d.error ? ', errore ' + redact(d.error) : ''}`);
    } catch {}
  }
  const run = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '(esecuzione locale)';
  lines.push('', `Esecuzione GitHub: ${run}`);
  lines.push(`Repository: ${process.env.GITHUB_REPOSITORY || 'evastarz/social-autopost'} · programma autopost.mjs · versione ${(process.env.GITHUB_SHA || '?').slice(0, 7)} · Node ${process.version}`);
  lines.push('Contesto: il programma pubblica gli articoli dei feed RSS su Facebook, Telegram e X; i dettagli sono nel README della repository.');
  return lines.join('\n');
}

async function runSite(site, dry) {
  console.log(`\n=== ${site.name} ===`);
  loadSecrets(site.prefix);
  const stateFile = path.join(env('STATE_DIR', path.join(HERE, 'state')), `${site.id}.json`);
  const maxAgeMs = Number(env('MAX_AGE_HOURS', '48')) * 3600e3;
  const maxPerRun = Number(env('MAX_PER_RUN', '3'));

  let state = { posted: {} };
  let firstRun = false;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    firstRun = true;
  }
  state.posted ??= {};
  const save = async () => {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
  };

  const items = parseFeed(await fetchFeed(env('FEED_URL', site.feed))).sort((a, b) => a.date - b.date); // dal più vecchio

  const all = networksFor(site);
  const active = dry ? all : all.filter((n) => n.enabled());
  if (!active.length) throw new Error(`Nessun social configurato per ${site.name}: mancano i segreti ${site.prefix}_… (vedi README).`);

  // Primo avvio di questo sito: segna come "già visti" gli articoli attuali, senza pubblicarli.
  if (firstRun && !dry) {
    for (const it of items) state.posted[it.guid] = { seeded: new Date().toISOString() };
    await save();
    console.log(`Primo avvio: ${items.length} articoli esistenti segnati come già visti. Da ora pubblico solo i nuovi.`);
    return 0;
  }

  // Un articolo "visto ma mai pubblicato" (seeded) conta come nuovo se è stato ripubblicato/ri-datato DOPO quel momento
  // (es. i volantini che vengono aggiornati con la stessa pagina e una nuova data).
  const needs = (it, n) => {
    const e = state.posted[it.guid];
    if (!e) return true;
    if (e[n.name]) return false;
    if (e.seeded) return it.date.getTime() > Date.parse(e.seeded) + 60e3;
    return true;
  };

  const now = Date.now();
  const todo = items
    .filter((it) => now - it.date.getTime() <= maxAgeMs && now >= it.date.getTime() - 300e3)
    .filter((it) => active.some((n) => needs(it, n)))
    .slice(0, maxPerRun);

  if (!todo.length) {
    console.log('Nessun articolo nuovo da pubblicare.');
    return 0;
  }

  let failures = 0;
  for (const it of todo) {
    for (const n of active) {
      if (!needs(it, n)) continue;
      if (dry) {
        console.log(`\n--- [${n.name}] (simulazione) ---\n${n.preview(it)}${n.name === 'facebook' ? '\n[link: ' + it.link + ']' : ''}`);
        continue;
      }
      try {
        const id = await n.post(it);
        (state.posted[it.guid] ??= {})[n.name] = new Date().toISOString();
        console.log(`✅ ${n.name}: "${it.title}" (${id})`);
      } catch (e) {
        failures++;
        console.error(`❌ ${n.name}: "${it.title}" — ${e.message}`);
        if (!dry) await sendAlert(`${site.id}|${n.name}|${redact(e.message).slice(0, 80)}`, await buildAlert(site, n.name, it, e, state));
      }
      await save(); // salva subito: niente doppioni se crasha dopo
    }
  }

  if (!dry) {
    state.posted = Object.fromEntries(Object.entries(state.posted).slice(-300)); // tiene gli ultimi 300
    await save();
  }
  return failures;
}

// Prove manuali, senza toccare il registro. Tipi:
//   telegram            invia l'ultimo articolo sul canale Telegram
//   facebook-controllo  verifica Pagina e token e rilegge l'anteprima, SENZA pubblicare
//   facebook-pubblica   pubblica davvero l'ultimo articolo sulla Pagina (da cancellare a mano)
// Controlli senza pubblicare: canali Telegram (nome) e account X (utente collegato alle chiavi).
async function checkOthers(site) {
  if (sec('TG_BOT_TOKEN') && sec('TG_CHAT_ID')) {
    for (const chat of sec('TG_CHAT_ID').split(',').map((c) => c.trim()).filter(Boolean)) {
      try {
        const j = await (await fetch(`https://api.telegram.org/bot${sec('TG_BOT_TOKEN')}/getChat?` + new URLSearchParams({ chat_id: chat }))).json();
        console.log(j.ok ? `✅ Telegram: canale "${j.result.title}"` : `❌ Telegram ${chat}: ${j.description}`);
      } catch (e) {
        console.log(`❌ Telegram ${chat}: ${e.message}`);
      }
    }
  } else console.log('ℹ️ Telegram non configurato per questo sito.');
  if ((site.disabled || []).map((x) => String(x).toLowerCase()).includes('x')) console.log('ℹ️ X disattivato per questo sito in sites.json (nessun post, nessun avviso).');
  else if (sec('X_API_KEY') && sec('X_API_SECRET') && sec('X_ACCESS_TOKEN') && sec('X_ACCESS_SECRET')) {
    try {
      const url = 'https://api.twitter.com/2/users/me';
      const auth = oauthHeader('GET', url, {}, { consumerKey: sec('X_API_KEY'), consumerSecret: sec('X_API_SECRET'), token: sec('X_ACCESS_TOKEN'), tokenSecret: sec('X_ACCESS_SECRET') });
      const res = await fetch(url, { headers: { Authorization: auth } });
      const j = await res.json().catch(() => ({}));
      console.log(res.ok ? `✅ X: account @${j.data?.username} (chiavi valide)` : `❌ X: ${j.detail || j.title || res.status}${res.status === 402 ? ' (serve credito sul piano a consumo)' : ''}`);
    } catch (e) {
      console.log(`❌ X: ${e.message}`);
    }
  } else console.log('ℹ️ X non configurato per questo sito.');
}

async function runTest(kind, site) {
  console.log(`\n=== Prova ${kind}: ${site.name} ===`);
  loadSecrets(site.prefix);
  const items = parseFeed(await fetchFeed(site.feed)).sort((a, b) => b.date - a.date);
  if (!items.length) throw new Error('Il feed non contiene articoli');
  const latest = items[0];

  if (kind === 'telegram') {
    if (!(sec('TG_BOT_TOKEN') && sec('TG_CHAT_ID'))) throw new Error(`Mancano ${site.prefix}_TG_BOT_TOKEN e/o ${site.prefix}_TG_CHAT_ID`);
    for (const n of networksFor(site).filter((n) => n.name.startsWith('telegram') && n.enabled())) {
      const id = await n.post(latest);
      console.log(`✅ Messaggio di prova inviato a ${n.name} (${id}): "${latest.title}". Controlla il canale e cancellalo a mano.`);
    }
    return;
  }
  if (kind === 'facebook-controllo') {
    await checkOthers(site);
    if (alertChat()) {
      const ok = await sendAlert(null, `✅ Prova avvisi (${site.name}): se leggi questo messaggio, gli avvisi di errore funzionano.`, true);
      console.log(ok ? '✅ Avvisi: messaggio di prova inviato sulla tua chat privata Telegram.' : '❌ Avvisi: invio non riuscito (hai scritto /start al bot? l\'id è giusto?)');
    } else console.log('ℹ️ Avvisi non configurati (manca il segreto ALERT_TG_CHAT_ID).');
  }
  if (!(sec('FB_PAGE_ID') && sec('FB_PAGE_TOKEN'))) throw new Error(`Mancano ${site.prefix}_FB_PAGE_ID e/o ${site.prefix}_FB_PAGE_TOKEN`);
  if (kind === 'facebook-controllo') {
    const url = `https://graph.facebook.com/v21.0/${sec('FB_PAGE_ID')}?` + new URLSearchParams({ fields: 'name,link', access_token: await fbToken() });
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(`Facebook: ${json.error?.message || res.status}`);
    console.log(`✅ Token valido. Pagina: "${json.name}" ${json.link || ''}`);
    // Scadenza del token salvato nei segreti (quello "grezzo", prima di ricavare il token della Pagina)
    try {
      const t = sec('FB_PAGE_TOKEN');
      const dbg = await (await fetch('https://graph.facebook.com/v21.0/debug_token?' + new URLSearchParams({ input_token: t, access_token: t }))).json();
      const d = dbg.data;
      if (d) {
        const mai = !d.expires_at || d.expires_at === 0;
        console.log(`🔑 Token nei segreti: tipo ${d.type || '?'}, ${mai ? 'NON SCADE MAI ✅' : 'SCADE il ' + new Date(d.expires_at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' ⚠️ (temporaneo: va sostituito)'}`);
      } else {
        console.log('🔑 Non sono riuscito a leggere la scadenza del token (' + (dbg.error?.message || 'risposta vuota') + ').');
      }
    } catch (e) {
      console.log('🔑 Controllo scadenza non riuscito: ' + e.message);
    }
    await refreshFacebookPreview(latest.link);
    console.log('Nessun post è stato pubblicato (controllo). Per provare la pubblicazione scegli "facebook-pubblica".');
    return;
  }
  if (kind === 'facebook-pubblica') {
    const id = await postFacebook(latest);
    console.log(`✅ Post di prova pubblicato (${id}): "${latest.title}". Cancellalo dalla Pagina a mano.`);
    return;
  }
  throw new Error(`Tipo di prova sconosciuto: ${kind}`);
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const test = process.argv.find((a) => a.startsWith('--test='))?.slice(7);
  const only = process.argv.find((a) => a.startsWith('--site='))?.slice(7);
  const sites = JSON.parse(await readFile(path.join(HERE, 'sites.json'), 'utf8')).filter((s) => !only || s.id === only);
  if (!sites.length) throw new Error('Nessun sito trovato in sites.json');
  if (test && !only) throw new Error('Per la prova indica il sito, es. --test=telegram --site=sf');

  let failures = 0;
  for (const site of sites) {
    try {
      if (test) await runTest(test, site);
      else failures += await runSite(site, dry);
    } catch (e) {
      failures++; // un sito rotto non blocca gli altri
      console.error(`❌ ${site.name}: ${e.message}`);
      if (!dry && !test) await sendAlert(`${site.id}|sito|${redact(e.message).slice(0, 80)}`, await buildAlert(site, 'sito', null, e, null));
    }
  }
  if (failures) process.exitCode = 1; // run rosso su GitHub -> arriva una mail
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
