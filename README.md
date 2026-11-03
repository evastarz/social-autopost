# Autopost: nuovi articoli dei siti → Facebook, Telegram (e X)

Ogni 15 minuti circa GitHub controlla l'RSS dei siti elencati in `sites.json` (ora **TuttoInEdicola** e **ScontrinoFelice**) e
pubblica gli articoli nuovi sulla Pagina Facebook, sul canale Telegram (e su X, se configurato) **di quel sito**.
Gira sui server di GitHub: il PC può restare spento.

- Post = solo **titolo + link**; l'anteprima la crea il social dal link.
- Prima di ogni post su Facebook lo script fa **rileggere la pagina** a Facebook (come "Scrapa di nuovo" nel Debugger di
  condivisione), così l'immagine dell'anteprima è quella aggiornata.
- Anche su **Telegram** l'anteprima mostra l'immagine aggiornata: lo script chiede a Telegram di rileggere la pagina
  (indirizzo con parametro unico solo per l'anteprima; nel messaggio il link resta pulito).
- Primo avvio di ogni sito: segna gli articoli già esistenti come "visti" e **non** li pubblica.
- Pubblica solo articoli di meno di 48 ore, al massimo 3 per volta, mai due volte lo stesso.
- Se un social o un sito dà errore, il run diventa rosso su GitHub (arriva una mail), gli altri siti vanno avanti e al giro
  dopo riprova. Un social è attivo solo se ha tutte le sue chiavi.

## Aggiungere un sito

Una riga in `sites.json` (`id`, `name`, `feed`, `prefix`) e i segreti con quel prefisso. Niente altro.

## Segreti (Settings → Secrets and variables → Actions → New repository secret)

Per ogni sito, con il suo prefisso (`TIE_` = TuttoInEdicola, `SF_` = ScontrinoFelice):

| Social | Segreti |
|---|---|
| Facebook | `TIE_FB_PAGE_ID`, `TIE_FB_PAGE_TOKEN` |
| Telegram | `TIE_TG_BOT_TOKEN`, `TIE_TG_CHAT_ID` |
| X (facoltativo) | `TIE_X_API_KEY`, `TIE_X_API_SECRET`, `TIE_X_ACCESS_TOKEN`, `TIE_X_ACCESS_SECRET` |

…e gli stessi con `SF_` per ScontrinoFelice. Se un sito non ha ancora alcun social, il suo run dà errore (gli altri
funzionano comunque).

## Facebook: consigliato il token dell'"utente di sistema" (non scade)

Nel portfolio business crea un **utente di sistema** con accesso completo alla Pagina e all'app, genera un token con scadenza
**Mai** e le autorizzazioni `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, e mettilo in `*_FB_PAGE_TOKEN`.
Il programma ricava da solo il token della Pagina a ogni esecuzione. (Funziona anche con un normale token di Pagina.)

## Attivare Facebook (alternativa con token personale, vale per entrambe le Pagine)

1. Su <https://developers.facebook.com> → *Le mie app* → *Crea app* (tipo **Business**). Basta **una sola app** per tutte
   le tue Pagine.
2. Da *Graph API Explorer* scegli l'app e genera un token con i permessi `pages_manage_posts`,
   `pages_read_engagement`, `pages_show_list`, selezionando le tue Pagine.
3. Trasformalo in token a lunga durata (`oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=TOKEN`),
   poi chiama `me/accounts`: per ogni Pagina trovi `id` (= `*_FB_PAGE_ID`) e `access_token` (= `*_FB_PAGE_TOKEN`, non
   scade se ricavato da un token a lunga durata).
4. Se l'app è in modalità *Sviluppo* funziona già per te (sei amministratrice di app e Pagine).

## Attivare Telegram (5 minuti, un bot per sito oppure lo stesso bot su due canali)

1. Su Telegram scrivi a **@BotFather** → `/newbot` → ti dà il token (= `*_TG_BOT_TOKEN`).
2. Aggiungi il bot come **amministratore** del canale con il permesso di pubblicare.
3. `*_TG_CHAT_ID`: `@nomedelcanale` se pubblico; se privato, scrivi un messaggio nel canale e apri
   `https://api.telegram.org/bot<TOKEN>/getUpdates` (l'id inizia con `-100`).

## Attivare X (facoltativo)

Su <https://developer.x.com> crea un'app con permessi **Read and write**; genera *API Key & Secret* e
*Access Token & Secret* dell'account che deve pubblicare. Piano gratuito: circa 500 post al mese.

## Prove manuali (non registrano nulla)

*Actions* → "Pubblica nuovi articoli sui social" → *Run workflow* → menu **Prova manuale**:

- `facebook-controllo-sf` / `-tie`: verifica che Pagina e token funzionino e rilegge l'anteprima, **senza pubblicare**.
- `facebook-pubblica-sf` / `-tie`: pubblica davvero l'ultimo articolo sulla Pagina (poi cancellalo a mano).
- `telegram-sf` / `-tie`: invia l'ultimo articolo sul canale Telegram (poi cancellalo a mano).

## Avvio e prove

*Actions* → "Pubblica nuovi articoli sui social" → *Run workflow* (spunta "simulazione" per vedere i testi senza
pubblicare). **Le esecuzioni automatiche partono solo dal ramo principale** (serve il merge).

```
node test.mjs                                   # prove senza rete
node autopost.mjs --dry-run                     # mostra cosa pubblicherebbe, per tutti i siti
MAX_AGE_HOURS=999 node autopost.mjs --dry-run --site=sf
```

## WhatsApp

Non esiste un modo ufficiale e gratuito per pubblicare in automatico su un **Canale** WhatsApp (nessuna API per i
Canali); l'API WhatsApp Business è a pagamento e solo per messaggi modello a chi ha dato il consenso.

## Cambiare i testi

`facebookText()`, `telegramText()` e `xText()` in `autopost.mjs`.
