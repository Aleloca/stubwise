# Interrogare i Docs da Slack (chat RAG) — Design

**Data:** 2026-06-25
**Stato:** approvato, pronto per il piano di implementazione

## Obiettivo

Permettere di interrogare la documentazione di un progetto (la stessa chat RAG
della web app) **direttamente da Slack**, con una slash command dedicata, un
selettore di progetto con autocomplete, risposta con citazioni, riservata agli
utenti Slack collegati a un account Stubwise.

## Decisioni (validate)

- **Trigger**: slash command dedicata **`/docs`** (separata da `/stubwise`).
- **Scelta progetto**: **modale con selettore type-ahead** (`external_select`):
  Slack non supporta l'autocomplete sugli argomenti di una slash command, quindi
  il picker vive in un modale (autocomplete reale via `block_suggestions`).
- **Auth**: solo utenti Slack **collegati** a un account Stubwise (`users.slackUserId`).
- **Risposta**: via **`response_url`** della slash command (stashato nel
  `private_metadata` del modale) → niente scope `chat:write`, bot non deve essere
  nel canale.

## Stato attuale (riusabile)

- **Slack inbound completo**: `apps/server/src/slack/` — `routes.ts` (POST
  `/api/slack/commands` per `/stubwise`, POST `/api/slack/interactions` per
  view_submission/actions), `verify.ts` (firma HMAC, anti-replay ±300s),
  `creds.ts` (signing secret + bot token da `instanceSettings`, AES-256-GCM),
  `api.ts` (`createSlackClient`: openView/users.*). Parser raw-body urlencoded
  scoped a `/api/slack`.
- **Identità**: `users.slackUserId` (unique, nullable) + UI di link (admin)
  (`slack/identity-routes.ts`, `web/.../slack` UI).
- **Chat RAG**: `apps/server/src/routes/docs-retrieval.ts` (`retrieveChunks(db,
  embeddingClient, projectId, query, {k})` → chunk ibridi con slug/title/kind/snippet)
  e `docs-chat.ts` (system prompt anti-allucinazione + citazioni) + `chat-llm.ts`
  (`ChatLlm.stream`, impl Anthropic via SDK — **richiede un provider `api_key`
  abilitato**, account/OAuth NON supportati).

**Manca**: branch `/docs` nel commands handler, branch `block_suggestions` e
`view_submission docs_query` nelle interactions, una funzione RAG **non-streaming**
riusabile, l'invio della risposta su `response_url`.

## Architettura (tutto server-side, niente worker, niente migrazioni)

### 1. Slash command `/docs` (`/api/slack/commands`)
Branch su `command === "/docs"` (la firma è già verificata a monte):
- **Auth**: risolvi l'utente da `users.slackUserId === payload.user_id`. Non
  collegato → risposta effimera "Non sei collegato a Stubwise, chiedi a un admin
  di collegarti" (200 con `response_type: ephemeral`), stop.
- Collegato → `views.open` di un modale (`callback_id: "docs_query"`):
  - blocco `external_select` "Progetto" (`min_query_length: 0/1`),
  - `plain_text_input` "Domanda" (multiline), precompilato col `text` del comando,
  - `private_metadata` = JSON `{ responseUrl, channelId, slackUserId }`.

### 2. Autocomplete progetti (`/api/slack/interactions`, `type: block_suggestions`)
Branch nuovo: ritorna `options` = progetti **con documentazione** (current
generation con pagine, o pagine manuali — stesso criterio dell'hub `/api/docs/spaces`)
il cui nome/slug matcha il `value` digitato. `option.text` = nome progetto,
`option.value` = `projectId`. Tetto ~20 opzioni.

### 3. Submit del modale (`/api/slack/interactions`, `type: view_submission`, `callback_id: docs_query`)
- ri-verifica il link utente (difesa in profondità);
- estrai `projectId` (dal select) e `question` (dal textarea) e `responseUrl` (dal
  private_metadata);
- **ack immediato**: `reply.send({})` (200 vuoto) → Slack chiude il modale entro 3s;
- lancia in **async (fire-and-forget)** `answerAndPost(...)`:
  1. `retrieveChunks(db, embeddingClient, projectId, question, { k: 8 })`;
  2. system prompt + contesto (riuso da `docs-chat.ts`, estratto in una funzione
     condivisa) → `ChatLlm.stream(...)` **accumulato** in una stringa;
  3. costruisci le **citazioni** (dedup per slug → `{slug,title,kind}`) come link
     `<{publicUrl}/docs/{projectId}/{slug}|titolo>`;
  4. **POST al `responseUrl`** con `{ response_type: "in_channel", text/blocks }`
     (eventuale POST interim "🔎 sto cercando…" prima del retrieval).
- Errori (LLM non disponibile, retrieval fallito) → POST al responseUrl con un
  messaggio effimero d'errore leggibile; mai un 5xx verso Slack.

### 4. Funzione RAG condivisa (refactor)
Estrai da `docs-chat.ts` il cuore "retrieve + system prompt + genera" in una
funzione riusabile sia dallo streaming web sia dall'accumulo Slack (zero
divergenza). La web resta streaming; Slack accumula `for await`.

### 5. Slack client
Nessun nuovo metodo necessario per la risposta (si usa `response_url` con un
semplice `fetch` POST). `external_select` e `views.open` riusano `openView`.

## Dati & config

- **Niente nuove tabelle/migrazioni**: riuso `instanceSettings` (creds Slack),
  `users.slackUserId` (auth), `projects` + docs (retrieval). **Stateless**:
  nessuna `docChatSession` per Slack in v1 (single Q&A).
- Nessuna UI web nuova (le creds Slack si configurano già da `slack-section.tsx`;
  il link identità c'è già).

## Prerequisiti (config lato utente/Slack)

1. Aggiungere la slash command **`/docs`** nell'app Slack → Request URL
   `https://stubwise.thecove.it/api/slack/commands`.
2. **Interactivity** già attiva → Request URL `/api/slack/interactions`.
3. Almeno un provider AI **`api_key`** abilitato (vincolo LLM, vale già per la web).
4. Gli utenti devono avere lo **Slack collegato** all'account Stubwise (admin).

## Testing (server)

- Firma Slack riusata (firma errata → 401).
- `/docs` non collegato → effimero; collegato → `views.open` coi blocchi attesi.
- `block_suggestions` → solo progetti con docs che matchano; tetto opzioni.
- `view_submission docs_query` → ack immediato + il percorso async chiama
  `retrieveChunks` + LLM (accumulato) + POST al responseUrl con citazioni; non
  collegato al submit → nessun post.
- LLM non disponibile → messaggio d'errore leggibile, nessun 5xx.
- Mock di `createSlackClient`/`ChatLlm`/`retrieveChunks`/`fetch(responseUrl)`,
  riusando i pattern dei test Slack esistenti.

## Deploy

Solo **server** (tutto server-side; niente migrazioni, niente UI). Rebuild `server`.

## Fuori scope (v1)

- Multi-turn / thread con storico (single Q&A stateless).
- App mention / Events API (solo slash command).
- Binding canale→progetto (scelta: picker nel modale).
- Streaming progressivo della risposta in Slack (un solo messaggio finale).
