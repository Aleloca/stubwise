# File d'ambiente per progetto — Design

**Data:** 2026-06-22

## Problema

Molti repo richiedono variabili d'ambiente (in `.env` / `.env.local` o simili) per
buildare o far girare i test. La pipeline di fix di Stubwise lavora in un worktree
effimero clonato dal mirror: quelle variabili non ci sono, quindi build/test possono
fallire anche dopo l'install delle dipendenze. Serve poter configurare, **per progetto**,
uno o più file d'ambiente con valori **cifrati**, materializzati automaticamente nel
worktree prima di install/test.

## Decisioni (dal brainstorming)

1. **Modello a variabili key/value** (non contenuto grezzo): import/incolla → parsing in
   singole variabili, ogni valore cifrato; il file `.env` viene **rigenerato** come
   `KEY=value` alla materializzazione. UI per-variabile. Commenti/formattazione originali
   non sono preservati (accettabile per env di CI/test).
2. **Valori mascherati**: dopo il salvataggio i valori non tornano mai al client; si vede
   che sono impostati (e i nomi delle variabili), per cambiarli si re-inserisce. Nessun
   endpoint di reveal. Stesso modello di credenziali git / provider AI.
3. **Ambito: file `.env` + process env**: si scrivono i file nei percorsi configurati E si
   iniettano le variabili nell'ambiente dei processi install/test (per i runner che leggono
   `process.env` senza dotenv).

## Modello dati (migrazione 0025, additiva)

- `project_env_files`: `id` (uuid), `project_id` (FK → projects, ON DELETE CASCADE),
  `path` (text, relativo al repo), `created_at`, `updated_at`. **Unique** `(project_id, path)`.
- `project_env_vars`: `id` (uuid), `file_id` (FK → project_env_files, CASCADE), `key` (text),
  `value_encrypted` (text), `created_at`, `updated_at`. **Unique** `(file_id, key)`.

Cifratura AES-256-GCM via `encrypt`/`decrypt` di `@stubwise/db` + `app.encryptionKey` (stessa
chiave già condivisa server↔worker).

## Sicurezza

- **Valori mai esposti**: la proiezione pubblica ritorna `path` + elenco `key` con
  `valueSet: true`, mai il valore in chiaro. Nessun reveal.
- **Validazione `path` (anti-traversal)**: relativo, normalizzato, dentro il repo — niente
  assoluti, niente `..`, niente leading `/`. Controllato in input (server) E in scrittura
  (worker: `resolve(join(dir, path))` deve restare dentro il worktree).
- **Validazione `key`**: `^[A-Za-z_][A-Za-z0-9_]*$`.
- **Niente segreti nei log**: il worker logga solo `path` + numero di variabili, mai i valori.
- Gestione **admin-only**, come le altre configurazioni sensibili del progetto.
- **🔒 I segreti NON finiscono nella PR**: i file materializzati non devono essere committati.
  Lo staging del fix già esclude `STUBWISE_REPORT.md` con `git add -A -- . :(exclude)…`;
  l'esclusione (e il check di diff vuoto) viene estesa ai path dei file env configurati. Così,
  anche con `git add -A`, i `.env` materializzati non entrano mai nel commit/push.

## Import "smart"

Due vie, stesso risultato:
- **Upload file**: drag & drop / file picker; JS legge il contenuto localmente; il nome
  suggerisce il `path`.
- **Copia/incolla**: textarea col contenuto grezzo.

Il contenuto passa per un **parser dotenv-style** robusto (ignora righe vuote e commenti `#`,
gestisce `export ` prefix, apici singoli/doppi, `=` nel valore, spazi, multiline tra apici),
estrae le coppie, mostra un'anteprima (chiavi + conteggio, valori mascherati), e alla conferma
il **server cifra ogni valore e fa upsert**. Il parsing canonico è **lato server** (verità
unica); il client può fare un'anteprima ma il server ri-parsa. I valori transitano una sola
volta su HTTPS al salvataggio.

## API server (admin-only)

- `GET /api/projects/:id/env-files` → file + chiavi (mai valori).
- `POST /api/projects/:id/env-files` → crea file (`path`).
- `POST /api/projects/:id/env-files/:fileId/import` → `{ content }` → parse + upsert (cifrato),
  ritorna le chiavi.
- `PUT /api/projects/:id/env-files/:fileId/vars/:key` → sostituisce un valore.
- `DELETE` di variabile e di file.

## UI

Nuova sezione "File d'ambiente" nelle impostazioni progetto (accanto a comando di
test/installazione): lista dei file per `path`; per ciascuno le variabili `KEY ···· [sostituisci]`;
azioni Aggiungi file / Importa-incolla / aggiungi-sostituisci-elimina variabile / elimina file.

## Materializzazione nel worker

Nuovo modulo `apps/worker/src/pipeline/env-files.ts`. All'inizio del callback `withWorktree`
in `fix.ts`, **prima dell'install**, una volta, **saltata in plan-only**:
1. carica da DB file + variabili del progetto, **decifra** i valori;
2. per ogni file, serializza il contenuto `KEY=value` (valori con spazi/newline/speciali
   **quotati ed escapati** per round-trip), e scrive il file in `join(dir, path)` (dopo il
   check anti-traversal), creando le dir genitrici;
3. costruisce la **mappa unificata** `{KEY: value}` (collisioni fra file: ordine deterministico
   per `path`, last-wins; duplicati segnalati in UI) e la passa a `runCommandCaptured` per
   install e test → `execa(..., { env: { ...userVars, NODE_ENV: undefined } })` (NODE_ENV resta
   neutralizzato per le devDeps, vedi il fix install/test recente).

I run dell'**agente** ricevono i **file** (li legge dal worktree) ma non la process env
iniettata: non si tocca `buildAgentEnv` né l'allowlist (i segreti sono comunque nei file che
l'agente può leggere — è inerente alla feature).

## Testing

TDD su: parser dotenv (casi: commenti, export, apici, `=` nel valore, multiline);
serializzazione/quoting (round-trip via parse); validazione path (traversal → rifiutato) e key;
materializzazione (file scritti nei path giusti + **esclusi dal commit**); iniezione process env;
proiezione che non espone valori; CRUD server; UI import (upload + paste).

## Fuori scope (YAGNI)

- Reveal dei valori in chiaro.
- Versioning / cronologia delle modifiche.
- Espansione di variabili annidate `${VAR}`.
- Materializzazione per linguaggi non-`.env` (config di altri ecosistemi).
- Iniezione nella process env dell'agente (oltre ai file).

## Superficie di modifica

- **DB**: migrazione 0025 + `packages/db/src/schema.ts`.
- **Server**: `routes/project-env-files.ts` (CRUD + import/parse), parser dotenv condivisibile,
  registrazione rotta.
- **Worker**: `pipeline/env-files.ts` (load+decrypt+serialize+materialize), wiring in `fix.ts`
  (scrittura file prima dell'install, esclusione dallo staging, iniezione process env in
  `runCommandCaptured`).
- **Web**: sezione "File d'ambiente" nel form/route progetto + tipi in `lib/api.ts` + i18n it/en.
- **Docs**: pagina configurazione progetto.
