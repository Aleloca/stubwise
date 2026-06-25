# Interrogare i Docs da Slack — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Slash command `/docs` su Slack → modale con selettore progetto type-ahead
+ domanda → risposta RAG con citazioni via `response_url`, riservata agli utenti
Slack collegati a un account Stubwise.

**Design:** `docs/plans/2026-06-25-docs-slack-chat-design.md`.

**Tech Stack:** Fastify+Zod, Slack (firma HMAC, Block Kit), RAG esistente
(`retrieveChunks` + `ChatLlm` Anthropic SDK), Vitest.

**Tutto server-side. Niente migrazioni, niente UI, niente worker.**

---

## Task 1: Funzione RAG condivisa non-streaming

**Files:** nuovo `apps/server/src/routes/docs-rag.ts` (o `apps/server/src/docs/rag.ts`);
refactor `apps/server/src/routes/docs-chat.ts`; test.

**Contesto:** `docs-chat.ts` oggi fa, nello streaming: `retrieveChunks(db,
embeddingClient, projectId, query, {k:8})` → costruisce system prompt
(anti-allucinazione, doppio registro, obbligo citazioni, ~righe 81-109) → genera
con `ChatLlm.stream({system, messages, signal})` (chat-llm.ts) → citazioni dedup
per slug (~111-120). `ChatLlm` ha `isAvailable()` (pre-flight) e richiede un
provider `api_key` abilitato.

**Step 1.** Estrai in `docs-rag.ts` le parti riusabili (SENZA cambiare il
comportamento web):
- `buildDocsSystemPrompt(...)` (il system prompt esistente),
- `buildCitations(chunks)` → `{ slug, title, kind }[]` dedup,
- `buildMessages(...)` se serve (history opzionale).
Aggiungi una funzione NON-streaming:
```ts
export interface DocsAnswer { text: string; citations: { slug: string; title: string; kind: string }[]; }
export async function answerDocsQuestion(deps: {
  db: Db; embeddingClient: EmbeddingClient; chatLlm: ChatLlm;
}, input: { projectId: string; question: string }): Promise<DocsAnswer>
```
che: `retrieveChunks` (k=8) → system prompt + messages (solo la domanda, niente
history per Slack v1) → **accumula** `for await (const chunk of chatLlm.stream(...)) text += chunk` → ritorna `{ text, citations }`. Gestisci internamente: se non
ci sono chunk, comunque genera (il prompt dice "rispondi solo dal contesto" →
l'LLM dirà che non sa). Niente AbortSignal (Slack è one-shot).

**Step 2.** Refactor `docs-chat.ts` per USARE gli helper estratti
(`buildDocsSystemPrompt`/`buildCitations`), mantenendo lo streaming e il
comportamento IDENTICO (i test esistenti di docs-chat devono restare verdi).

**Step 3.** Test: `answerDocsQuestion` con mock di `retrieveChunks`/`ChatLlm`
→ ritorna testo accumulato + citazioni; docs-chat esistente invariato.

**Step 4.** `pnpm --filter @stubwise/server typecheck && pnpm --filter @stubwise/server test docs && pnpm lint`.
**Commit:** `refactor(server): estrai funzione RAG condivisa non-streaming per i Docs`.

---

## Task 2: Slash command `/docs` + modale

**Files:** nuovo `apps/server/src/slack/docs-modal.ts`; `apps/server/src/slack/routes.ts`; test.

**Contesto:** `slackRoutes` (`routes.ts`) gestisce `/commands` (oggi apre SEMPRE il
modale ticket) e `/interactions`. Helper riusabili: `loadSlackCreds`,
`verifyOrReject`, `ack`, `clientFactory`, `selectedValue`/`inputValue`. Il modale
ticket è in `modal.ts` (`buildTicketModal`, `CREATE_TICKET_CALLBACK_ID`, BLOCK/ACTION_IDS).
`payload.user.id` = Slack user id. `users.slackUserId` mappa l'utente.

**Step 1 — modale Docs (`docs-modal.ts`).** `DOCS_QUERY_CALLBACK_ID = "docs_query"`,
BLOCK/ACTION ids per `project` e `question`. `buildDocsQueryModal({ prefillQuestion?, privateMetadata })`:
- blocco `input` con `external_select` (action_id project, `min_query_length: 0`,
  placeholder "Cerca un progetto…") — le option arrivano via block_suggestions;
- blocco `input` `plain_text_input` multiline "Domanda" (initial_value = prefill);
- `private_metadata`: stringa JSON (la passa il chiamante: `{ responseUrl, channelId, slackUserId }`);
- `callback_id: DOCS_QUERY_CALLBACK_ID`, submit "Chiedi".

**Step 2 — branch `/docs` in `/commands`.** Oggi `/commands` apre il ticket modal a
prescindere dal comando. Aggiungi un branch: `const command = body.command;` se
`command === "/docs"`:
- **Auth**: `const [linked] = db.select({id}).from(users).where(eq(users.slackUserId, body.user_id))`. Se non linkato → `reply.code(200).send({ response_type: "ephemeral", text: "Non sei collegato a un account Stubwise. Chiedi a un admin di collegarti dalle impostazioni." })` e stop.
- Linkato → `client.openView(triggerId, buildDocsQueryModal({ prefillQuestion: body.text?.trim(), privateMetadata: JSON.stringify({ responseUrl: body.response_url, channelId: body.channel_id, slackUserId: body.user_id }) }))`. Poi `ack`.
- Lascia il comportamento ticket invariato per gli altri comandi (es. `/stubwise`): branch esplicito, default = ticket modal come ora.

**Step 3 — test** (riusa il setup dei test Slack esistenti, `slack/routes.test.ts`): 
`/docs` con utente NON linkato (nessuna riga users con quello slack id) → 200
ephemeral, niente openView; `/docs` con utente linkato → openView chiamato con la
view docs (callback_id docs_query, external_select, private_metadata col response_url);
firma errata → 401 (riuso). `/stubwise` invariato.

**Step 4.** `pnpm --filter @stubwise/server typecheck && pnpm --filter @stubwise/server test slack && pnpm lint`.
**Commit:** `feat(server): slash command /docs apre il modale di interrogazione Docs`.

---

## Task 3: Interactions — autocomplete progetti + submit (risposta RAG)

**Files:** `apps/server/src/slack/routes.ts` (+ eventuale `docs-modal.ts`); helper
"progetti con docs"; test.

**Step 1 — `block_suggestions` (autocomplete).** In `/interactions`, dopo il parse
del payload, branch `if (payload.type === "block_suggestions")`:
- `const q = (payload.value ?? "").toLowerCase();` (il testo digitato);
- carica i **progetti con documentazione** (current generation con almeno una
  pagina, OR pagine manuali — riusa/duplica il criterio di `getDocSpaces`
  in `apps/server/src/routes/docs.ts` o la query dell'hub `/api/docs/spaces`);
- filtra per nome/slug che contiene `q`, tetto ~20;
- rispondi `reply.code(200).send({ options: matches.map(p => ({ text: { type: "plain_text", text: p.name }, value: p.id })) })`.
(Estendi `SlackInteractionPayload` con `value?` e `action_id?` per block_suggestions.)

**Step 2 — `view_submission` docs_query.** Nel branch `view_submission`, PRIMA della
logica ticket esistente, controlla `payload.view?.callback_id`. Se `=== "docs_query"`:
- estrai `projectId` (external_select → `selectedValue`), `question` (`inputValue`),
  e `private_metadata` (`JSON.parse(payload.view.private_metadata)` → responseUrl, slackUserId);
- validazione: se manca projectId o question → `reply.code(200).send({ response_action: "errors", errors })`;
- **ri-auth**: verifica che `users.slackUserId === slackUserId` esista ancora; se no → ack + (best-effort) POST al responseUrl con messaggio "non collegato";
- **ack immediato** (`ack(reply)`, chiude il modale);
- lancia in **async fire-and-forget** `void answerAndPostToSlack({ db, embeddingClient, chatLlm, postResponse }, { projectId, question, responseUrl, publicUrl })` con `.catch()` per non lasciare promise non gestite.
(Se `callback_id !== "docs_query"`, prosegui col flusso ticket esistente, INVARIATO.)

**Step 3 — `answerAndPostToSlack`** (funzione nuova, nel modulo Slack o docs-rag):
- pre-flight `chatLlm.isAvailable()`; se non disponibile → POST al responseUrl
  `{ response_type: "ephemeral", text: "La chat AI non è disponibile (manca una API key configurata)." }` e termina;
- (opzionale) POST interim `{ response_type: "ephemeral", text: "🔎 Cerco nella documentazione…" }`;
- `const { text, citations } = await answerDocsQuestion({db, embeddingClient, chatLlm}, { projectId, question })`;
- componi i blocchi Slack: la risposta (markdown→mrkdwn, mantieni semplice) + una
  sezione "Fonti:" con le citazioni come link `<{publicUrl}/docs/{projectId}/{slug}|{title}>` (se publicUrl vuoto, mostra solo i titoli);
- **POST finale** al responseUrl `{ response_type: "in_channel", blocks }` (un solo messaggio).
- Errori (retrieval/LLM lanciano) → POST `{ response_type: "ephemeral", text: "Errore durante la ricerca nella documentazione." }`; logga; mai propagare.
`postResponse(url, payload)` deve essere INIETTABILE (default: `fetch`) per i test.

**Step 4 — wiring deps.** La route Slack ha bisogno di `embeddingClient` e `chatLlm`
(oggi forse non li riceve). Passali da `app.ts`/`slackRoutes` come opzioni
(`SlackRoutesOptions`), riusando le stesse istanze che usa `docsChatRoutes`. Verifica
come `docs-chat.ts` ottiene `embeddingClient`/`chatLlm` (decorator su instance o
opzioni) e replica.

**Step 5 — test:**
- block_suggestions con `value="wil"` → ritorna i progetti-con-docs che matchano;
  progetti senza docs esclusi; tetto.
- view_submission docs_query: projectId+question presenti → ack 200 + `postResponse`
  chiamato al responseUrl con la risposta e i link citazione (mock di
  `answerDocsQuestion`/`retrieveChunks`/`chatLlm` + `postResponse` spy); manca
  question → response_action errors; utente non più collegato → no answer post;
  chatLlm non disponibile → messaggio d'errore; `answerDocsQuestion` che lancia →
  messaggio d'errore, nessun throw.
- callback_id ticket (create_ticket) invariato.

**Step 6.** `pnpm --filter @stubwise/server typecheck && pnpm --filter @stubwise/server test slack docs && pnpm lint`.
**Commit:** `feat(server): autocomplete progetti + risposta RAG dei Docs su Slack`.

---

## Task 4: Verifica finale + deploy

**Step 1.** Dalla radice del worktree: `pnpm typecheck && pnpm lint`, poi
`pnpm --filter @stubwise/server test` (testcontainers: per-package).

**Step 2.** REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch (merge su main).

**Step 3.** Deploy: solo **server** (`docker compose up -d --build server`). Niente
migrazioni/UI. Verifica health.

**Step 4 — config Slack (manuale, lato utente):** aggiungere la slash command
`/docs` (Request URL `…/api/slack/commands`); interactivity già attiva; almeno un
provider `api_key` abilitato; gli utenti collegati. Poi test reale da Slack.

---

## Note trasversali

- **Riuso massimo**: firma/creds/client/parser Slack, `retrieveChunks`, system
  prompt e citazioni del RAG, pattern modale e test Slack esistenti.
- **Non rompere il flusso ticket** (`/stubwise`, `create_ticket`): i branch `/docs`
  e `docs_query` sono additivi; il default resta il comportamento attuale.
- **Best-effort verso Slack**: mai 5xx; errori → messaggi effimeri leggibili.
- **Vincolo LLM**: serve un provider `api_key` abilitato (account/OAuth no);
  `isAvailable()` lo gestisce con un messaggio chiaro.
- **Stateless v1**: nessuna sessione/persistenza per Slack; single Q&A.
