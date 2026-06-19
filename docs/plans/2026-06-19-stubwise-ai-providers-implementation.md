# AI providers: credenziali in Settings, consumi, failover, usage — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.

**Goal:** Gestire l'autenticazione verso Claude da una **catena ordinata di credenziali** configurata in Settings (non più solo da env), con **failover** al raggiungimento del limite, una **dashboard dei consumi** (costi/token), e la lettura **best-effort** dell'utilizzo residuo dell'abbonamento via PTY-scraping di `/usage` con parser deterministico + fallback LLM + banner di diagnosi.

**Architecture:** Tabella `ai_providers` (catena ordinata, secret cifrata AES-256-GCM) letta a runtime dal worker, che inietta nell'ambiente del child `claude` la env corretta per tipo (`api_key`→`ANTHROPIC_API_KEY`, `account`→`CLAUDE_CODE_OAUTH_TOKEN`). Al limite il worker passa alla credenziale successiva; se tutte esaurite il job va `held`. I consumi si aggregano da `ai_jobs` (già raccolti). L'usage residuo dell'abbonamento si ottiene solo pilotando la TUI `/usage` in un PTY: parser deterministico → fallback LLM validato → banner admin se entrambi falliscono. Retro-compatibile: catena vuota → comportamento attuale (env del container).

**Design:** `docs/plans/2026-06-19-stubwise-ai-providers-design.md`. **Convenzioni:** TDD, testcontainers per DB/route, migrazione additiva, i18n en/it (parità), errori inglese + `code`, secret write-only cifrate (pattern S3/Slack), NodeNext `.js`, review spec+qualità. **Pre-merge:** `pnpm lint` (root) + `pnpm -r typecheck` + `pnpm -r test` + `pnpm --filter @stubwise/web e2e`. **ToS:** avviso UI se ≥2 credenziali `account`.

---

### Task 1: Schema — ai_providers, ai_usage_snapshots, ai_jobs.providerId

**Files:** `packages/db/src/schema.ts` (+ enum in `packages/shared` se è il pattern), migrazione, `packages/db/src/schema.test.ts`.

- pgEnum `ai_provider_kind`: `api_key`, `account`.
- **`ai_providers`**: `id uuid pk`, `position integer notNull`, `kind ai_provider_kind notNull`, `label text notNull`, `secretEncrypted text notNull` (cifrato), `enabled boolean notNull default true`, `createdAt`, `updatedAt`. Indice/ordinamento per `position` (riordino applicativo; valuta unique su position o gestione gap).
- **`ai_jobs`**: aggiungi `providerId uuid` nullable, FK→`ai_providers.id` onDelete **set null**. (Verifica i campi costo già presenti su `ai_jobs`: `total_cost_usd`/usage — riportali; servono per la dashboard.)
- **`ai_usage_snapshots`**: `id uuid pk`, `providerId uuid notNull FK→ai_providers cascade`, `capturedAt timestamptz notNull defaultNow`, `sessionRemaining jsonb`, `weeklyRemaining jsonb`, `sessionResetAt timestamptz`, `weeklyResetAt timestamptz`, `source enum('deterministic','llm_fallback')`, `parseOk boolean notNull`, `rawText text` (nullable; valorizzato su fallimento per il banner). Indice su `(providerId, capturedAt)`.
- Migrazione additiva (`drizzle-kit generate`, verifica SQL + idempotenza; allinea snapshot/journal).

**Test (testcontainers):** insert/read provider (secret, position, enabled); FK set null su ai_jobs quando si elimina un provider; cascade su ai_usage_snapshots dal provider; round-trip jsonb degli snapshot; enum kinds.

**Commit:** `feat(db): ai_providers + ai_usage_snapshots + ai_jobs.providerId`

---

### Task 2: Server — CRUD ai_providers (catena, secret cifrata)

**Files:** `apps/server/src/routes/ai-providers.ts` (nuovo, requireAdmin, registrato in app), `apps/web/src/lib/api.ts`, test.

- Riusa `encrypt`/`decrypt` (`@stubwise/db`), `app.encryptionKey`, `apiError`, `isUniqueViolation`, pattern write-only di S3/Slack.
- **POST `/api/ai-providers`** `{ kind, label, secret, position? }`: cifra `secret` → `secretEncrypted`; `position` = append in coda se assente; 201 con proiezione pubblica (id, kind, label, position, enabled, `secretSet:true`, createdAt) — **mai** la secret.
- **GET `/api/ai-providers`**: lista ordinata per position, proiezione pubblica (no secret) + `accountCount` (per l'avviso ToS lato UI) — oppure la UI lo calcola.
- **PATCH `/api/ai-providers/:id`** `{ label?, secret?, enabled?, position? }`: secret presente → re-encrypt; assente → invariata; gestione riordino (sposta position). 404; 200 proiezione.
- **DELETE `/api/ai-providers/:id`**: 204; 404.
- **(Opzionale) POST `/api/ai-providers/:id/test`**: validazione leggera della credenziale (un `claude -p "ok"` con un timeout corto usando quella credenziale); se complesso/costoso, rimanda — documenta.
- Client `api.ts`: tipi `AiProvider`, `listAiProviders`, `createAiProvider`, `updateAiProvider`, `deleteAiProvider`, `reorderAiProviders` (se separato).

**Test (testcontainers):** create cifra (secret non in chiaro; decrypt round-trip); GET non espone la secret (`secretSet`); PATCH secret presente/assente; enable/disable; riordino position; delete; requireAdmin (401/403).

**Commit:** `feat(server): CRUD ai_providers con secret cifrata e ordinamento`

---

### Task 3: Worker — selezione credenziale dalla catena + iniezione env per kind

**Files:** `apps/worker/src/agent/claude-cli.ts` (env injection), nuovo `apps/worker/src/providers/` (caricamento+decifratura catena), `apps/worker/src/config.ts` (eventuale), test.

- Modulo `loadProviderChain(db, encryptionKey)`: legge `ai_providers` enabled ordinati per position, decifra le secret → lista `{ id, kind, secret }`. Errore di decifratura su una voce → la salta (logga), non blocca le altre.
- In `claude-cli.ts` (`buildAgentEnv`): aggiungi un parametro per la **credenziale scelta**; inietta:
  - `kind="api_key"` → `ANTHROPIC_API_KEY=<secret>`, e NON impostare `CLAUDE_CODE_OAUTH_TOKEN`;
  - `kind="account"` → `CLAUDE_CODE_OAUTH_TOKEN=<secret>`, e NON impostare `ANTHROPIC_API_KEY` (l'API key vince sull'OAuth → va omessa).
  - Mantieni l'allowlist/denylist esistente; le secret arrivano dal DB, non dall'env del container.
- **Retro-compat**: se la catena è vuota → comportamento attuale (env `ANTHROPIC_API_KEY` del container / OAuth da volume). Questo è il default quando l'utente non ha ancora configurato nulla.
- Il punto di esecuzione del job (dove oggi si chiama il runner) sceglie la **prima** credenziale enabled della catena e la passa al runner. (Il failover vero è il Task 4.)
- Registra `ai_jobs.providerId` con la credenziale usata.

**Test:** `buildAgentEnv` con kind api_key → env ha ANTHROPIC_API_KEY e NON OAuth; con account → viceversa; catena vuota → fallback all'env esistente; `loadProviderChain` ordina/decifra/salta voci corrotte. Imita i test worker esistenti.

**Commit:** `feat(worker): selezione credenziale dalla catena + env per kind (retro-compat)`

---

### Task 4: Worker — failover al limite + job held se esaurite

**Files:** `apps/worker/src/agent/claude-cli.ts` (rilevamento limite), il punto che esegue il fix/triage (loop di tentativo sulla catena), `apps/worker/src/pipeline/*`, test.

- **Rilevamento "limite raggiunto"**: dall'esito del CLI distingui un errore di **rate/usage limit** (messaggio dell'abbonamento es. "usage limit reached"/"rate limit", o exit/HTTP 429 per API key) dagli altri errori. Isola un helper `isLimitError(result)` best-effort (parsing del messaggio/`is_error`/codice) — documenta i marcatori usati.
- **Loop di failover** attorno all'esecuzione del job: prova la credenziale i-esima; se `isLimitError` → passa alla i+1; ripeti finché una riesce o la catena finisce. NON ritentare in failover gli errori non-limite (quelli restano gestiti come oggi: failed/self-repair).
- **Tutte esaurite** → job `held` (riusa lo stato esistente) con messaggio "all AI providers exhausted (rate/usage limit), retry after reset"; niente PR. NON `failed` (è una condizione transitoria).
- Registra su `ai_jobs.providerId` la credenziale che ha effettivamente eseguito (l'ultima provata con successo, o l'ultima tentata se held).
- Attenzione idempotenza/costi: il failover ritenta lo **stesso** job con un'altra credenziale; assicurati di non aprire PR duplicate (il rilevamento limite scatta PRIMA che il lavoro produca effetti, perché il limite blocca la chiamata). Documenta il comportamento se il limite arriva a metà.

**Test (worker, runner fake):** credenziale 1 simula limite → usa credenziale 2 (successo) → job ok + providerId = 2; tutte simulano limite → job held con messaggio; errore non-limite → NON fa failover (comportamento attuale); catena di 1 sola che limita → held.

**Commit:** `feat(worker): failover tra credenziali al limite, held se tutte esaurite`

---

### Task 5: Server + Web — dashboard consumi (costi/token)

**Files:** `apps/server/src/routes/` (endpoint usage/consumi, o estendi un esistente), `apps/web/src/routes/` (pagina/sezione dashboard), `apps/web/src/lib/api.ts`, i18n, test.

- **Server** `GET /api/ai-usage/costs` (requireAdmin) con query (range date, group by): aggrega da `ai_jobs` (costo `total_cost_usd`, token per modello da `modelUsage`/usage, conteggio job) per **giorno**, e dimensioni **modello / progetto / providerId**. Risposta: serie temporali + totali. Una/poche query SQL aggregate (no N+1).
- **Web**: pagina/sezione "Usage & costs" (admin) con grafici/tabelle semplici (riusa stile control-room; niente nuove dipendenze pesanti — tabelle + barre CSS se non c'è una lib chart già presente; verifica). Filtri per range/modello/progetto.
- Client `api.ts`: tipi + `getAiUsageCosts(params)`.
- i18n en/it (parità).

**Test:** server aggrega correttamente (crea ai_jobs con costi/modelli noti → verifica totali/raggruppamenti, attribuzione per provider); requireAdmin; web rende i totali (mock API). Parità i18n.

**Commit:** `feat(server,web): dashboard consumi AI (costi/token)`

---

### Task 6: Worker — usage abbonamento via PTY-scraping (`/usage`) + parser 2 livelli

**Files:** nuovo `apps/worker/src/agent/usage-pty.ts` (cattura PTY), `apps/worker/src/agent/usage-parser.ts` (deterministico + fallback LLM), scheduler nel worker entrypoint (`apps/worker/src/index.ts`), `apps/worker/package.json` (dipendenza PTY), `apps/worker/Dockerfile` (toolchain se serve), test.

- **PTY capture** (`usage-pty.ts`): per una credenziale `account`, avvia `claude` interattivo in uno **pseudo-terminale** (valuta `node-pty`; se la build nativa è problematica nel container, alternativa `script`/`util-linux` o un wrapper — DOCUMENTA la scelta e i rischi), attende il prompt, invia `/usage`, attende il render, cattura l'output (rimuovi i codici ANSI), chiude. Timeout corto. `/usage` è gratuito (non consuma token). Iniettabile/mockabile nei test (NON spawnare un vero claude nei test).
- **Parser** (`usage-parser.ts`):
  1. `parseUsageDeterministic(text): UsageSnapshot | null` — regex/struttura su sessione 5h e settimanale (+ reset). Ritorna null se il formato non combacia.
  2. se null → `parseUsageWithLlm(text, runLlm): UsageSnapshot | null` — `runLlm` esegue `claude -p "<istruzioni estrazione JSON> <rawText>" --output-format json` con un **modello economico** (haiku) usando **preferibilmente una credenziale `api_key`** della catena (per non intaccare la quota dell'abbonamento; se assente, usa l'account). Valida l'output con **zod** + **sanity check** (numeri plausibili: percentuali 0–100, reset nel futuro, ecc.); se non valido → null.
  - Tipo `UsageSnapshot` = `{ sessionRemaining, weeklyRemaining, sessionResetAt?, weeklyResetAt? }` (definisci lo schema condiviso).
- **Scheduler**: nel worker, un task periodico ogni ~5 min (setInterval o un job ricorrente — coerente con come il worker tiene il loop) che per ogni credenziale `account` enabled cattura+parsa e **salva un `ai_usage_snapshot`**: `parseOk=true,source=deterministic` se il primo ha funzionato; `parseOk=false,source=llm_fallback,rawText=<grezzo>` se ha funzionato solo l'LLM o nessuno (in caso di solo-LLM salva comunque i valori + flag che segnala "deterministico fallito"). NON deve mai far crashare il worker (best-effort, try/catch).
- Rispetta `WORKER_STALE_MINUTES`/heartbeat: il task usage NON deve interferire col loop dei job (esegui fuori dal lock dei job, o come task separato).

**Test (worker):** parser deterministico su 2–3 esempi reali di output `/usage`; formato cambiato → deterministico null → fallback LLM (mock `runLlm`) → snapshot con source=llm_fallback + parseOk=false + rawText; LLM che allucina numeri implausibili → null (validazione zod/sanity); cattura PTY mockata (niente claude reale). Lo scheduler salva snapshot per ogni account.

**Commit:** `feat(worker): usage abbonamento via PTY /usage + parser deterministico/LLM`

---

### Task 7: Web — pagina Settings "AI providers"

**Files:** `apps/web/src/components/ai-providers-section.tsx` (+ test), `apps/web/src/routes/settings/ai-providers.tsx`, layout settings + router, `apps/web/src/lib/api.ts`, i18n.

- Lista ordinata delle credenziali (label, kind badge, enabled, `secretSet`); azioni: **aggiungi** (kind + label + secret), **riordina** (su/giù o drag), **enable/disable**, **elimina**. Secret **write-only** (placeholder "•••• set"; checkbox remove), pattern S3/Slack.
- **Avviso ToS** (callout) se la catena contiene ≥2 credenziali `account`: testo che spiega che usare più abbonamenti per superare i limiti è contro i ToS Anthropic (rischio sospensione) — neutro ma chiaro.
- Hint: come ottenere un token `account` (`claude setup-token` su una macchina con browser); per `api_key` la chiave del Console.
- Voce nel layout settings + route in router. i18n en/it (parità).

**Test web:** lista/riordino/secret-write-only/enable/elimina (mock API); avviso ToS appare con ≥2 account; non mostra mai la secret. Parità i18n.

**Commit:** `feat(web): pagina Settings AI providers (catena, secret, avviso ToS)`

---

### Task 8: Web — usage abbonamento + banner parsing fallito

**Files:** `apps/web/src/components/` (usage panel + banner), la pagina dashboard/AI providers, `apps/web/src/lib/api.ts`, i18n, test. **Server**: endpoint `GET /api/ai-usage/snapshots` (requireAdmin) → ultimo snapshot per provider `account` (+ rawText/flag).

- Per ogni credenziale `account`, mostra l'**ultimo snapshot**: residuo sessione/settimanale + reset, con etichetta "stimato (fallback)" quando `source=llm_fallback`, e "non disponibile" se nessun dato.
- **Banner admin** quando l'ultimo snapshot ha `parseOk=false`: mostra che il parsing deterministico di `/usage` è fallito, il **testo grezzo** catturato (admin-only), e un hint operativo ("aggiorna `apps/worker/src/agent/usage-parser.ts`: atteso X, ricevuto Y") così l'utente corregge subito.
- Client `api.ts`: `getAiUsageSnapshots()` + tipi. i18n en/it (parità).

**Test:** server ritorna l'ultimo snapshot per provider; web mostra residuo + etichetta fallback + banner con rawText quando parseOk=false; admin-only. Parità i18n.

**Commit:** `feat(server,web): usage residuo abbonamento + banner diagnosi parsing`

---

### Task 9: Docs + verifica finale + deploy

**Files:** `apps/docs/.../getting-started/claude-setup.md` (riscrivi: ora le credenziali si gestiscono in Settings → AI providers; catena + failover; nota ToS; come ottenere api_key vs token account; usage best-effort) + eventuale pagina dashboard. In inglese. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm lint` (root), `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. **Verifica build Docker del worker** con la dipendenza PTY (`node-pty`): assicurati che l'immagine worker compili (toolchain/prebuild). Code review finale d'insieme. **Deploy:** backup DB, migrazione additiva, rebuild server+worker+caddy, verifica `/health` + tabelle + CI. **Env/infra:** nessuna env nuova obbligatoria; l'`ANTHROPIC_API_KEY` di deploy resta fallback finché la catena è vuota; dopo il deploy l'utente configura la catena in Settings.

**Commit:** `docs: AI providers (credenziali, consumi, failover, usage)`

---

## Note / rischi
- **PTY/`node-pty`**: dipendenza nativa nel worker → rischio build Docker (verifica prebuild; in alternativa `script`/`expect`). Se la cattura PTY non funziona in produzione, l'usage best-effort si disattiva da solo: resta la dashboard costi/token (dato solido). Isolare bene questo modulo.
- **Fallback LLM**: scatta solo on-failure del deterministico; preferire credenziale `api_key` per non intaccare la quota dell'abbonamento; sempre validato (zod + sanity) e marcato "stimato".
- **ToS**: l'avviso UI per ≥2 account è obbligatorio (trasparenza). Il sistema resta neutro.
- **Retro-compat**: catena vuota = comportamento attuale; nessuna rottura al deploy. La migrazione dall'env alla catena è una scelta dell'utente post-deploy.
- **Token account scaduto** (~1 anno) o revocato: il job va in held/errore visibile; rigenerazione manuale del token (follow-up: refresh automatico).
