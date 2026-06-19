# Stubwise — AI providers: credenziali in Settings, consumi, failover, usage abbonamento (design)

> Design validato il 2026-06-19. Sposta l'autenticazione verso Claude (oggi via
> env del worker) dentro l'applicazione: una **catena ordinata di credenziali**
> gestita da Settings, con monitoraggio consumi, failover al raggiungimento del
> limite, e (best-effort) lettura dell'utilizzo residuo dell'abbonamento.

## Contesto attuale

Il worker AI invoca `claude -p --output-format json …` come child process e si
autentica così (vedi `apps/worker/src/agent/claude-cli.ts`):
- `ANTHROPIC_API_KEY` passata via env del container (allowlist `ANTHROPIC_`/`CLAUDE_`), **oppure**
- token OAuth dell'abbonamento da `~/.claude/.credentials.json` (volume), quando l'API key è assente.

Le credenziali sono quindi **statiche, a livello di deploy**. L'utente vuole:
gestirle dall'app, vederne i consumi, e poter usare più credenziali con failover.

## Decisioni (validate)

- **Catena ordinata di credenziali** in Settings: ogni voce è `api_key` o
  `account` (token OAuth a lunga durata da `claude setup-token`). Il worker prova
  in ordine; al limite passa alla successiva. L'utente decide cosa metterci.
- **Consumi costi/token**: dashboard dai dati strutturati che già raccogliamo per
  job (`total_cost_usd`, `modelUsage`). Affidabile.
- **Usage abbonamento (residuo sessione 5h / settimanale)**: NON esiste un'API
  headless né un file documentato. Unica via = **PTY‑scraping di `/usage`**
  (comando della TUI, lettura gratuita che NON consuma token) con parsing a due
  livelli (deterministico → fallback LLM) e **banner in piattaforma** se entrambi
  falliscono. Best‑effort: degrada con grazia, non blocca nulla.
- **Failover** lungo la catena al raggiungimento del limite; **avviso ToS
  contestuale** in UI se la catena contiene più di una credenziale `account`.
- **Retro‑compatibilità**: se la catena è vuota, il worker usa il comportamento
  attuale (env `ANTHROPIC_API_KEY`/OAuth da volume) — nessuna rottura al deploy.

## Nota di Terms of Service (documentata)

Anthropic indica di usare l'**API** per "shared production automation"; l'uso
dell'abbonamento con `claude -p` è supportato ma pensato per uso interattivo, e
**più abbonamenti in catena per superare i limiti è verosimile violazione dei
ToS** (rischio sospensione). Il sistema resta neutro (l'utente sceglie), ma mostra
l'avviso. Riferimenti: support.claude.com (Claude Code con Pro/Max; Agent SDK).

## Modello dati (migrazione additiva)

- **`ai_providers`**: `id uuid pk`, `position int` (ordine nella catena),
  `kind enum('api_key','account')`, `label text`, `secretEncrypted text`
  (la API key o il `CLAUDE_CODE_OAUTH_TOKEN`, cifrata AES‑256‑GCM con la
  `ENCRYPTION_KEY` già condivisa server/worker), `enabled bool default true`,
  `createdAt`, `updatedAt`. Unicità su `position` (o riordino applicativo).
- **`ai_jobs`**: aggiungi `providerId uuid` nullable (FK→ai_providers set null) =
  quale credenziale ha effettivamente eseguito il job (per attribuire i consumi).
- **`ai_usage_snapshots`**: `id`, `providerId` (FK), `capturedAt`,
  `sessionRemaining jsonb|null`, `weeklyRemaining jsonb|null`,
  `sessionResetAt timestamptz|null`, `weeklyResetAt timestamptz|null`,
  `source enum('deterministic','llm_fallback')`, `parseOk bool`,
  `rawText text|null` (l'output `/usage` grezzo, solo quando il parsing fallisce,
  per il banner di diagnosi — admin‑only). Tiene lo storico/ultimo snapshot.

## Componenti

### 1. Credenziali (server + UI)
- **Server** (route `requireAdmin`): CRUD `ai_providers` (crea, riordina,
  enable/disable, elimina). Secret **write‑only** (mai restituita in lettura;
  GET espone solo `secretSet`/label/kind/position/enabled), pattern S3/Slack.
  (Opzionale) endpoint "test credential": un `claude -p "ok"` rapido per validarla.
- **UI Settings → "AI providers"**: lista ordinata con drag/riordino, aggiungi
  (kind + label + secret), enable/disable, elimina. **Avviso ToS** se ≥2 `account`.
  Hint su come ottenere il token (`claude setup-token`).

### 2. Selezione credenziale + failover (worker)
- Il worker carica la catena ordinata (enabled) e la decifra. Per ogni job prova
  la prima credenziale; inietta nel child `claude` SOLO la sua env:
  - `api_key` → `ANTHROPIC_API_KEY=<key>` (niente OAuth);
  - `account` → `CLAUDE_CODE_OAUTH_TOKEN=<token>` (niente `ANTHROPIC_API_KEY`: l'API key vince sull'OAuth).
- **Rilevamento limite**: se l'esito del CLI indica limite raggiunto (messaggio di
  rate/usage limit dell'abbonamento, o 429 per API key) → passa alla credenziale
  successiva e ritenta lo stesso job. Se tutte esaurite → job `held` con messaggio
  "tutti i provider esauriti, reset previsto ~X" (riusa lo stato held esistente).
- Registra su `ai_jobs.providerId` la credenziale che ha eseguito.
- **Catena vuota** → fallback al comportamento attuale (env del container).

### 3. Dashboard consumi (server + UI)
- Aggrega da `ai_jobs` (costo, token per modello) per **giorno / modello /
  progetto / credenziale**. Espone serie temporali + totali.
- UI: grafici/tabelle dei consumi; per le credenziali `account` mostra anche
  l'ultimo `ai_usage_snapshot` (residuo sessione/settimanale) quando disponibile.

### 4. Usage abbonamento — PTY‑scraping best‑effort (worker)
- Un **task periodico** (ogni ~5 min) per ogni credenziale `account` enabled:
  avvia `claude` interattivo in uno **pseudo‑terminale** (richiede una dipendenza
  PTY, es. `node-pty` — vedi rischi), invia `/usage`, cattura l'output.
- **Parsing a due livelli**:
  1. **deterministico** (regex/struttura) → JSON `{ session, weekly, resets }`;
  2. se fallisce → **fallback LLM**: passa il testo grezzo a un modello economico
     (preferendo una credenziale `api_key` se presente, per non intaccare la quota
     dell'abbonamento) che restituisce lo stesso JSON; **valida con zod + sanity
     check** sui numeri (un LLM può allucinare → se implausibile, fallimento). Il
     dato via LLM è marcato "stimato (fallback)" in UI.
- **Allarme**: se il deterministico fallisce (anche se il fallback LLM riesce) →
  salva `rawText` + `parseOk=false`/`source=llm_fallback` e mostra un **banner
  admin** in piattaforma con: testo grezzo, step fallito, e hint operativo
  ("aggiorna il parser in `apps/worker/src/agent/usage-parser.ts`, atteso vs
  ricevuto"). Così l'utente‑sviluppatore corregge subito il parser deterministico
  e non resta silenziosamente sul fallback LLM (che costa/latenza).
- `/usage` è una **lettura gratuita** (non consuma token): il cron non brucia quota.

## Sicurezza

- Secret cifrate a riposo, mai esposte in lettura (solo flag `secretSet`); il
  worker non le logga. Credenziali iniettate nell'env del child, MAI dal prompt
  (injection‑safe, coerente con l'allowlist/denylist esistente).
- `rawText` di `/usage` e i banner di diagnosi: **admin‑only**.
- Endpoint di gestione credenziali: `requireAdmin`.

## Errori / degradazione

- Parsing usage fallito → banner, dato "non disponibile", nessun blocco.
- Tutte le credenziali esaurite → job `held` con reset stimato (non `failed`).
- PTY/`node-pty` non disponibile o TUI cambiata → usage best‑effort disattivato,
  resta la dashboard costi/token (che è il dato solido).

## Testing (TDD)

- **db**: schema/migrazione `ai_providers`/`ai_usage_snapshots`/`ai_jobs.providerId`.
- **server**: CRUD provider (secret cifrata/mai esposta, riordino, enable),
  aggregazione consumi, endpoint usage snapshot/banner; requireAdmin.
- **worker**: selezione credenziale per kind (env iniettata giusta), failover al
  limite (credenziale fake che simula limite → passa alla successiva → held se
  tutte esaurite), retro‑compat catena vuota.
- **usage parser**: deterministico su esempi reali di `/usage`; fallback LLM
  (mockato) su formato cambiato; validazione zod + sanity check; flag parseOk e
  rawText su fallimento.
- **web**: pagina AI providers (lista/riordino/secret write‑only/avviso ToS),
  dashboard consumi, banner parsing fallito. i18n en/it parità.

## Deploy

Migrazione additiva (nuove tabelle + colonna). Il worker già ha DB +
`ENCRYPTION_KEY`. **Nuova dipendenza** worker per il PTY (es. `node-pty`):
verificare il build Docker (prebuild/toolchain). Rebuild server + worker + caddy.
Nessuna nuova env obbligatoria; l'`ANTHROPIC_API_KEY` di deploy resta come
fallback finché la catena non è configurata.

## Fuori scope / follow-up

- Lettura "ufficiale" del residuo abbonamento: impossibile finché Anthropic non
  espone un'API; il PTY‑scraping è l'unico proxy.
- Admin/Analytics API per usage (richiede organizzazione/Console): valutabile in
  futuro per i consumi API key autorevoli.
- Bilanciamento intelligente tra credenziali (oltre al failover sequenziale):
  non in v1.
- Validazione/refresh automatico dei token `account` alla scadenza (~1 anno): per
  ora il fallimento è visibile e si rigenera il token a mano.
