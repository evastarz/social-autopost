#!/usr/bin/env node
// Pubblica i nuovi articoli dell'RSS dei siti elencati in sites.json su Facebook (Pagina), Telegram e X.
// Nessuna dipendenza da installare: serve solo Node 18+.
//
// Uso:   node autopost.mjs            -> pubblica davvero
//        node autopost.mjs --dry-run  -> mostra cosa pubblicherebbe, senza pubblicare né salvare
//
// Variabili d'ambiente (un social è attivo solo se ha le sue chiavi):
//   [PREFISSO_]FB_PAGE_ID, FB_PAGE_TOKEN                          -> Facebook
//   TG_BOT_TOKEN, TG_CHAT_ID                           -> Telegram
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
const loadSecrets = (prefix) => {
  CURRENT = {};
  for (const k of ['FB_PAGE_ID','FB_PAGE_TOKEN','TG_BOT_TOKEN','TG_CHAT_ID','X_API_KEY','X_API_SECRET','X_ACCESS_TOKEN','X_ACCESS_SECRET'])
    CURRENT[k] = ALL_SECRETS[`${prefix}_${k}`] ?? process.env[`${prefix}_${k}`] ?? '';
};

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
  return `📰 ${item.title}`; // il link viaggia nel campo "link" e Facebook ne fa l'anteprima classica
}

export function telegramText(item) {
  return `📰 ${item.title}\n${item.link}`;
}

export function xText(item) {
  // X conta ogni link come 23 caratteri, qualunque sia la lunghezza.
  return cut(`📰 ${item.title}`, 280 - 2 - 23) + `\n\n${item.link}`;
}

// ---------- Facebook ----------

// Equivale al "Debugger di condivisione" di Facebook (pulsante "Scrapa di nuovo"): fa rileggere
// la pagina così l'anteprima usa l'immagine/titolo aggiornati e non quelli in cache.
async function refreshFacebookPreview(url) {
  const body = new URLSearchParams({ id: url, scrape: 'true', access_token: sec('FB_PAGE_TOKEN') });
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
    access_token: sec('FB_PAGE_TOKEN'),
  });
  const res = await fetch(`https://graph.facebook.com/v21.0/${sec('FB_PAGE_ID')}/feed`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`Facebook: ${json.error?.message || res.status}`);
  return json.id;
}

// ---------- Telegram ----------

async function postTelegram(item) {
  const res = await fetch(`https://api.telegram.org/bot${sec('TG_BOT_TOKEN')}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: sec('TG_CHAT_ID'),
      text: telegramText(item),
      link_preview_options: { url: item.link, prefer_large_media: true },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`Telegram: ${json.description || res.status}`);
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
  if (!res.ok) throw new Error(`X: ${json.detail || json.title || res.status}`);
  return json.data?.id;
}

// ---------- Programma principale ----------

const NETWORKS = [
  { name: 'facebook', enabled: () => sec('FB_PAGE_ID') && sec('FB_PAGE_TOKEN'), post: postFacebook, preview: facebookText },
  { name: 'telegram', enabled: () => sec('TG_BOT_TOKEN') && sec('TG_CHAT_ID'), post: postTelegram, preview: telegramText },
  {
    name: 'x',
    enabled: () => sec('X_API_KEY') && sec('X_API_SECRET') && sec('X_ACCESS_TOKEN') && sec('X_ACCESS_SECRET'),
    post: postX,
    preview: xText,
  },
];

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

  const active = dry ? NETWORKS : NETWORKS.filter((n) => n.enabled());
  if (!active.length) throw new Error(`Nessun social configurato per ${site.name}: mancano i segreti ${site.prefix}_… (vedi README).`);

  // Primo avvio di questo sito: segna come "già visti" gli articoli attuali, senza pubblicarli.
  if (firstRun && !dry) {
    for (const it of items) state.posted[it.guid] = { seeded: new Date().toISOString() };
    await save();
    console.log(`Primo avvio: ${items.length} articoli esistenti segnati come già visti. Da ora pubblico solo i nuovi.`);
    return 0;
  }

  const now = Date.now();
  const todo = items
    .filter((it) => now - it.date.getTime() <= maxAgeMs && now >= it.date.getTime() - 300e3)
    .filter((it) => active.some((n) => !state.posted[it.guid]?.[n.name] && !state.posted[it.guid]?.seeded))
    .slice(0, maxPerRun);

  if (!todo.length) {
    console.log('Nessun articolo nuovo da pubblicare.');
    return 0;
  }

  let failures = 0;
  for (const it of todo) {
    for (const n of active) {
      if (state.posted[it.guid]?.[n.name] || state.posted[it.guid]?.seeded) continue;
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

async function main() {
  const dry = process.argv.includes('--dry-run');
  const only = process.argv.find((a) => a.startsWith('--site='))?.slice(7);
  const sites = JSON.parse(await readFile(path.join(HERE, 'sites.json'), 'utf8')).filter((s) => !only || s.id === only);
  if (!sites.length) throw new Error('Nessun sito trovato in sites.json');

  let failures = 0;
  for (const site of sites) {
    try {
      failures += await runSite(site, dry);
    } catch (e) {
      failures++; // un sito rotto non blocca gli altri
      console.error(`❌ ${site.name}: ${e.message}`);
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
