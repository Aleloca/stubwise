# Widget customer service embeddabile

Data: 2026-07-05 · Stato: design validato

## Obiettivo

Widget chat embeddabile per progetto (stile Intercom), da installare sul sito
del cliente: risponde alle domande degli utenti finali facendo RAG sulla docs
autogenerata del progetto e, quando riconosce un bug/feedback, propone e crea
un ticket reale su Stubwise.

## Decisioni chiave

| Tema | Decisione |
|---|---|
| Utenti finali | Identità passata dal sito ospite (`user: {id, email, name}` all'init); il widget vive in aree autenticate del sito cliente |
| Verifica identità | Fiducia cieca (nessuna firma HMAC in v1) — accettabile per istanze self-hosted con clienti fidati |
| Creazione ticket | L'agente LLM propone (tool `propose_ticket`), l'utente conferma/edita in una card nel widget |
| Distribuzione | Bundle IIFE `widget.js` servito da Caddy (script-tag) + entry npm `@stubwise/sdk/widget` |
| Knowledge base | Whitelist di repository per-progetto nelle impostazioni widget; retrieval cross-repo filtrato |
| Lato team | Solo AI + viewer conversazioni read-only; niente presa in carico umana in v1 |

## Architettura

Nuovi componenti:

1. **`packages/widget`** — package frontend (Vite in library mode, output
   IIFE). UI in Shadow DOM (isolamento CSS bidirezionale): bolla in basso a
   destra → pannello chat (~380×600, full-screen mobile). Espone
   `window.Stubwise.initWidget({ dsn, user })`; il DSN è lo stesso formato
   dell'SDK (`https://KEY@host/p/slug`). L'entry `@stubwise/sdk/widget`
   riesporta `initWidget` per chi usa npm.
2. **Superficie API pubblica `/widget/:slug/*`** sul server — CORS aperto e
   auth `X-Stubwise-Key` = `ingestionKey`, sullo stesso modello di `/ingest`
   (confronto tempo-costante `keysMatch`, 401 indistinguibile, rate limit
   per chiave).
3. **Caddy** serve `GET /widget.js` come statico buildato in
   `Dockerfile.caddy` (stesso pattern di SPA e Starlight).

Integrazione tipo nel sito cliente:

```html
<script src="https://stubwise.example.it/widget.js" defer></script>
<script>
  window.addEventListener("stubwise:ready", () =>
    Stubwise.initWidget({
      dsn: "https://KEY@stubwise.example.it/p/mio-progetto",
      user: { id: "u_42", email: "mario@cliente.it", name: "Mario" },
    }));
</script>
```

## Modello dati

- **`widget_conversations`**: `id`, `projectId`, `externalUserId`,
  `externalUserEmail`, `externalUserName`, `createdAt`, `lastMessageAt`.
  Parallelo pubblico di `doc_chat_sessions`, legato all'utente esterno
  dichiarato dal sito ospite. Il widget persiste l'id conversazione in
  `localStorage` e riprende il filo alle visite successive.
- **`widget_messages`**: `id`, `conversationId`, `role` (`user`/`assistant`),
  `content`, `citations` (jsonb), `ticketId` (nullable — valorizzato quando
  da quel punto è nato un ticket), `createdAt`.
- **`widget_settings`** (1:1 con project): `enabled` (default **false**),
  `enabledRepositoryIds`, `title`, `welcomeMessage`, `accentColor`,
  `language` (`it`/`en`, via `packages/i18n`).
- Nuovo valore **`widget`** nell'enum `ticket_source`.
  ⚠️ Trappola migrazioni: il migratore Drizzle esegue il batch in UNA
  transazione — il valore enum va ADDato in una migrazione che non lo usa.

## Flusso chat

1. Init: `GET /widget/:slug/config` → `enabled`, title, welcomeMessage,
   accentColor, language. Se `enabled=false`, server irraggiungibile o
   nessun provider AI configurato, la bolla non compare (chat spenta ma
   config lo comunica esplicitamente nel caso provider mancante).
2. Messaggio utente → `POST /widget/:slug/conversations/:id/messages` →
   retrieval ibrido esistente (`retrieveChunksForProject`) filtrato su
   `enabledRepositoryIds` → loop SSE condiviso (`streamChatResponse`).
3. System prompt dedicato: tono customer service, risposte solo dalla
   documentazione, definizione del tool `propose_ticket`.
4. Citazioni mostrate come "fonte: <titolo pagina>" senza link (la docs
   interna non è raggiungibile dall'utente finale).

## Flusso ticket

1. L'LLM invoca `propose_ticket({title, body, type})` con `type` limitato a
   `bug`/`feedback`/`feature`. Il server NON crea il ticket: emette evento
   SSE `ticket_proposal`.
2. Il widget mostra una card editabile (badge tipo, titolo, descrizione) con
   "Invia segnalazione" / "Annulla".
3. Conferma → `POST /widget/:slug/conversations/:id/tickets` crea il ticket:
   source `widget`, transcript recente e identità utente in coda al body,
   `ticketId` salvato sul messaggio (link bidirezionale).
4. Annulla → la conversazione prosegue normalmente.

## Lato team (SPA)

- **Impostazioni progetto → tab "Widget"**: toggle enable, checklist repo
  con docs generate (avviso se vuota), titolo/benvenuto/colore/lingua,
  snippet di integrazione precompilato con bottone copia.
- **Voce "Conversazioni"** nel progetto: lista (utente, anteprima, data,
  badge ticket) + dettaglio read-only con citazioni e card ticket linkate.
  Endpoint interni `/api/projects/:id/widget/...` con `requireAuth` +
  ownership, separati dalla superficie pubblica.
- Ticket con source `widget` mostrano link "Vedi conversazione".

## Sicurezza e limiti

- Auth a chiave progetto, rate limit per chiave (riuso `/ingest`).
- **Cap giornaliero di messaggi chat per progetto** (contatore Postgres):
  a cap raggiunto il widget mostra "assistente non disponibile, lascia una
  segnalazione" — la creazione ticket resta attiva (zero token).
- Messaggio max ~2k caratteri; storico troncato alle ultime N coppie nel
  prompt.
- Resilienza lato ospite: come l'SDK, il widget non lancia mai nell'app
  ospite; ogni errore interno è inghiottito.

## Testing

- Server (testcontainers): auth/CORS/enabled=false sulla superficie
  `/widget`, filtro repo nel retrieval, flusso proposta→conferma→ticket
  source `widget`, cap giornaliero. LLM mockato via `app.chatLlm`.
- Widget (Vitest + happy-dom): parsing SSE, persistenza conversazione,
  card ticket. Niente Playwright in v1.
- `pnpm lint` prima del merge (la CI fallisce su lint).

## Deploy

- `widget.js` buildato in `Dockerfile.caddy` → modifiche widget = ribuild
  **caddy**; endpoint nuovi = ribuild **server**. Nessun impatto sul worker;
  la migrazione DB la applica il server all'avvio.

## Fuori scope v1 (possibili v2)

- Presa in carico umana live (inbox, realtime bidirezionale)
- Notifiche al team per nuova conversazione
- Feedback 👍/👎 sulle risposte
- Identità firmata HMAC (flag per-progetto)
- Visibilità docs a livello di singola pagina
