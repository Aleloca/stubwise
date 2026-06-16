# Internazionalizzazione (i18n) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (o subagent-driven-development) per implementare questo piano task per task.

**Goal:** Rendere Stubwise multilingua — UI in inglese di default con preferenza per-utente (react-i18next), e contenuti generati / output LLM / notifiche nella lingua d'istanza.

**Architecture:** Due risoluzioni di lingua. (1) `users.language` per-utente guida react-i18next nella web app. (2) `instance_settings.content_language` per-istanza guida i testi generati dal backend (commenti, report PR, notifiche) e l'istruzione di lingua nei prompt LLM, attraverso un nuovo pacchetto db-free `@stubwise/i18n`. Gli errori API sono in inglese con un `code` stabile che la UI traduce.

**Tech Stack:** pnpm monorepo, TS NodeNext strict, Drizzle+Postgres, Fastify 5 + fastify-type-provider-zod, Vitest+testcontainers, React 18 + TanStack Router/Query, react-i18next.

**Design di riferimento:** `docs/plans/2026-06-15-stubwise-i18n-design.md`.

**Convenzioni del repo:** TDD (rosso→verde→commit, un commit per task); comandi `pnpm --filter <pkg> {test,typecheck}`, `pnpm -r build`; migrazioni via `pnpm --filter @stubwise/db exec drizzle-kit generate` (applicate al boot del server da `runMigrations`); transizioni job status-guarded in `apps/worker/src/queue.ts`.

**Lingue v1:** `en` (default, fonte di verità) + `it`.

---

## Fase 0 — Fondamenta dati + pacchetto i18n backend

### Task 1: Schema DB — `users.language` + `instance_settings`

**Files:**
- Modify: `packages/db/src/schema.ts`
- Generate: `packages/db/drizzle/00NN_*.sql`
- Test: `packages/db/src/schema.test.ts`

**Step 1 — schema.ts:**
1. Nuovo enum lingua condiviso. In `packages/shared/src/schemas/` (o dove stanno gli enum) aggiungere `export const languageSchema = z.enum(["en","it"]);` e usarlo per il pgEnum: `export const language = pgEnum("language", enumValues(languageSchema));`
2. `users`: aggiungere `language: language("language").notNull().default("en")`.
3. Nuovo singleton `instance_settings` (modellato su `notificationSettings`):
   ```ts
   export const instanceSettings = pgTable("instance_settings", {
     id: integer("id").primaryKey().default(1),
     contentLanguage: language("content_language").notNull().default("en"),
     createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
     updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
   });
   ```

**Step 2 — Migrazione:** `pnpm --filter @stubwise/db exec drizzle-kit generate`. Deve contenere `CREATE TYPE language`, `ALTER TABLE users ADD COLUMN language ... DEFAULT 'en' NOT NULL`, `CREATE TABLE instance_settings`, e il **seed della riga singleton** `INSERT INTO instance_settings (id) VALUES (1) ON CONFLICT DO NOTHING;`. Drizzle non seeda da solo: aggiungere lo statement di seed a mano in coda al file SQL generato (come fatto per `notification_settings`/`automation_rules` nelle migrazioni precedenti — verificare il pattern usato lì e replicarlo). Additiva e sicura sul prod (default + seed).

**Step 3 — Test:** estendere `schema.test.ts`: inserisce un user con `language` default `'en'` e uno con `'it'`; verifica che `instance_settings` abbia la riga `id=1` con `content_language='en'` dopo le migrazioni; update a `'it'` e rilettura.

**Step 4 — Commit:** `feat(db): users.language + instance_settings.content_language`

---

### Task 2: Pacchetto `@stubwise/i18n`

**Files:**
- Create: `packages/i18n/package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`, `src/catalog.ts`, `src/index.test.ts`
- Modify: `pnpm-workspace.yaml` non serve (usa glob `packages/*`); verificare.

**Cosa fa.** Pacchetto db-free, funzioni pure (come l'entry `/format` di `@stubwise/notifications`). Espone:
```ts
export type Language = "en" | "it";
export function t(lang: Language, key: string, params?: Record<string, string | number>): string;
export function languageName(lang: Language): string; // "English" | "Italian" — per i prompt
```
`t` cerca la chiave nel catalogo `lang`, fa interpolazione `{param}`, e fa **fallback su `en`** se la chiave manca in `lang`. I cataloghi (`catalog.ts`) coprono SOLO i testi generati dal backend, raggruppati per area:
- `comment.*` — template commenti generati: `comment.prMerged`, `comment.prClosed`, `comment.fixReady`, `comment.triageHeld`, `comment.triageSkip`, `comment.triageDuplicate`, `comment.planProposed`, `comment.planApproved`, `comment.planRejected`, `comment.reportFooter`.
- `notify.*` — messaggi notifiche (i testi oggi in `format.ts`: ticketCreated, prOpened, prClosed, jobHeld, planReview, jobFailed), per i 3 formati se serve testo diverso (slack/discord/plain condividono il testo, generic usa `notify.*`).
- `report.*` — header sezioni report: `report.investigation`, `report.rootCause`, `report.solution`, `report.rationale`; e le label del piano (`plan.rootCause`, `plan.filesToChange`, …).
- `prompt.*` — eventuali frammenti (non strettamente necessari se si usa `languageName`).

**Step 1 — Test rossi (`src/index.test.ts`):**
- `t("en","comment.prMerged",{url})` e `t("it","comment.prMerged",{url})` ritornano i testi attesi con interpolazione;
- chiave mancante in `it` → fallback al testo `en`;
- `languageName("en")==="English"`, `languageName("it")==="Italian"`;
- **test di parità chiavi**: l'insieme delle chiavi di `it` è uguale a quello di `en` (fallisce se una lingua ha una chiave in meno). Questo test protegge da cataloghi disallineati.

**Step 2 — Implementazione** `catalog.ts` (oggetti `en`/`it` con le stesse chiavi) + `index.ts` (`t`, `languageName`). I testi `it` sono quelli ATTUALI presi da webhooks.ts/triage.ts/fix.ts/format.ts; i testi `en` sono le traduzioni.

**Step 3:** `pnpm --filter @stubwise/i18n test` + `typecheck`.

**Step 4 — Commit:** `feat(i18n): pacchetto @stubwise/i18n per i testi generati dal backend`

---

## Fase 1 — Lingua d'istanza nei contenuti generati

### Task 3: Worker — prompt, report e commenti generati nella lingua d'istanza

**Files:**
- Modify: `apps/worker/src/pipeline/prompts.ts`, `apps/worker/src/pipeline/fix.ts`, `apps/worker/src/pipeline/triage.ts`
- Create/Modify: un helper per leggere `instance_settings.content_language` (es. `apps/worker/src/settings.ts` o dentro queue.ts)
- Test: `prompts`/`fix`/`triage` test esistenti

**Step 1 — Helper lingua d'istanza.** `getContentLanguage(db): Promise<Language>` legge `instance_settings.contentLanguage` (riga id=1), fallback `'en'`. Il worker lo risolve una volta per job e lo passa giù.

**Step 2 — Prompt.** `buildFixPlanPrompt`/`buildFixExecutePrompt`/`buildFixPrompt`/`buildTriagePrompt` accettano `lang: Language`. Sostituire l'hardcoded `in Italian` con `` in ${languageName(lang)} ``; gli header fissi del report (`## Processo di indagine` ecc.) e le label del piano vengono da `t(lang, "report.*"/"plan.*")`. Il triage chiede al modello di scrivere `reason` nella lingua `lang`.

**Step 3 — Commenti generati.** In `fix.ts`/`triage.ts` i body dei commenti (`Fix automatico pronto`, `Piano proposto`, `Triage AI: held/skip/duplicate`, footer report) passano da `t(lang, "comment.*", params)`.

**Step 4 — Test.** Aggiornare i test: con `content_language='it'` i prompt contengono `in Italian` e gli header italiani e i commenti sono in italiano; con `'en'` in inglese. Iniettare il lang nei test (o seedare `instance_settings`).

**Step 5 — Commit:** `feat(worker): prompt, report e commenti nella lingua d'istanza`

---

### Task 4: Server — commenti di sistema del webhook localizzati

**Files:**
- Modify: `apps/server/src/routes/webhooks.ts`
- Test: `apps/server/src/routes/webhooks.test.ts`

**Step 1.** Leggere `instance_settings.content_language` (helper analogo) all'interno della transazione/handler. I body dei commenti di sistema (`PR mergiata: …`, `PR chiusa senza merge: …`) passano da `t(lang, "comment.prMerged"/"comment.prClosed", { url })`.

**Step 2 — Test.** Aggiornare i test che asserivano il testo italiano del commento → ora dipende da `content_language` (seedare `'it'` per mantenere l'asserzione esistente, e aggiungere un caso `'en'`).

**Step 3 — Commit:** `feat(server): commenti di sistema del webhook nella lingua d'istanza`

---

### Task 5: Notifiche localizzate

**Files:**
- Modify: `packages/notifications/src/format.ts`, `packages/notifications/src/dispatch.ts`
- Test: `format.test.ts`, `dispatch.test.ts`

**Step 1.** `formatNotification(event, format, lang)` (nuovo param `lang`): i testi dei messaggi vengono da `@stubwise/i18n` (`t(lang, "notify.*", params)`) invece che hardcoded. `sampleEvents` resta uguale (sono dati, non testi).

**Step 2.** `dispatch.ts`/`dispatchNotification` legge `instance_settings.content_language` (estendere `loadSettings` o un secondo read) e passa `lang` a `formatNotification`.

**Step 3 — Test.** `format.test.ts`: ogni evento formattato con `lang="en"` e `lang="it"` produce i testi attesi. `dispatch.test.ts`: il messaggio inviato è nella lingua d'istanza.

**Step 4 — Commit:** `feat(notifications): messaggi nella lingua d'istanza`

---

## Fase 2 — Errori API in inglese (con codici) + lingua utente

### Task 6: Errori API → inglese + `code` stabile

**Files:**
- Modify: tutte le route che fanno `reply.code(4xx).send({ message: "<italiano>" })` (`tickets.ts`, `webhooks.ts`, `auth.ts`, `git-accounts.ts`, `projects.ts`, `settings.ts`, `users.ts`, `ingest.ts`), `apps/server/src/app.ts` (handler), eventuale helper condiviso
- Test: i `*.test.ts` corrispondenti

**Step 1 — Convenzione.** Introdurre un helper `apiError(reply, status, code, messageEn)` (o un piccolo modulo `errors.ts`) che invia `{ code, message }` con messaggio in **inglese**. `code` è una stringa stabile snake_case (`ticket_not_found`, `webhook_unauthorized`, `plan_not_pending`, `unauthorized`, `forbidden`, …).

**Step 2 — Conversione.** Sostituire i `send({ message: "<it>" })` user-facing con `apiError(...)` (messaggio inglese + code). Lasciare invariata la logica/HTTP status. Il `setErrorHandler` in `app.ts` continua a passare l'errore; cambia solo il messaggio di fallback interno `"Errore interno"` → `"Internal error"` (questo non ha bisogno di `code`).

**Step 3 — Test.** Aggiornare tutti i test che asserivano messaggi italiani (es. `"Ticket non trovato"`, `"Webhook non autorizzato"`) → ai nuovi messaggi inglesi e/o al `code`. Mechanical ma esteso: cercare con `grep -rn "non trovato\|non autorizzato\|già\|mancante" apps/server/src/**/*.test.ts`.

**Step 4 — Commit:** `feat(server): messaggi d'errore API in inglese con code stabile`

---

### Task 7: `users.language` — lettura in `/me` + endpoint di update

**Files:**
- Modify: `apps/server/src/auth/session.ts` (SessionUser + query in requireAuth), `apps/server/src/routes/auth.ts` (/me) o `users.ts` (PATCH lingua)
- Test: `auth.test.ts` / `users.test.ts`

**Step 1.** Aggiungere `language` a `SessionUser` e alla SELECT che carica l'utente in `requireAuth` (`session.ts`). `/api/auth/me` ora restituisce anche `user.language`.

**Step 2.** Endpoint `PATCH /api/auth/me` (o `/api/users/me/language`) `preHandler: requireAuth`, body `{ language: languageSchema }`, aggiorna `users.language` dell'utente corrente, 200. (Ogni utente cambia SOLO la propria lingua; non serve admin.)

**Step 3 — Test.** `/me` espone `language`; PATCH cambia la lingua e si riflette in `/me`; validazione lingua non valida → 400.

**Step 4 — Commit:** `feat(server): preferenza lingua utente in /me + endpoint di update`

---

## Fase 3 — Web: react-i18next ed estrazione stringhe

### Task 8: Setup react-i18next + fondamenta

**Files:**
- Modify: `apps/web/package.json` (dep `i18next`, `react-i18next`)
- Create: `apps/web/src/i18n/index.ts`, `apps/web/src/i18n/locales/en.json`, `apps/web/src/i18n/locales/it.json`, `apps/web/src/lib/translate-api-error.ts`
- Modify: `apps/web/src/lib/api.ts` (ApiError porta `code`), il bootstrap dell'app (provider/init), `apps/web/src/lib/api.ts` `getMe` type
- Test: `apps/web/src/i18n/*.test.ts(x)`

**Step 1 — Init i18n.** `src/i18n/index.ts`: `i18next.use(initReactI18next).init({ resources: { en, it }, lng: "en", fallbackLng: "en", interpolation: { escapeValue: false }, ns: [...], defaultNS: "common" })`. Caricare i due JSON. Avviare l'init prima del render (import in `main.tsx`).

**Step 2 — Risoluzione lingua.** Dopo il login, quando `getMe()` restituisce `user.language`, chiamare `i18n.changeLanguage(user.language)` (in un effect nel componente che ha l'utente, o nel router context). Pre-login: `en` (opzionale: `navigator.language` → `it`).

**Step 3 — ApiError con code.** Estendere `ApiError` (api.ts) con `readonly code?: string`, estratto dal body `{ code, message }`. `translateApiError(error, t)`: se `error.code` ha una chiave `errors:<code>`, ritorna `t("errors:"+code)`, altrimenti `error.message`.

**Step 4 — Catalogo iniziale.** `en.json`/`it.json` con i namespace vuoti/parziali (`common`, `errors`, `auth`, `tickets`, `settings`, `notifications`, `automation`, `jobStatus`). Le chiavi si riempiono nei task di estrazione.

**Step 5 — Test.** init i18n carica en/it; `translateApiError` mappa un code noto e fa fallback sul message; `changeLanguage` cambia la lingua attiva. Test di **parità chiavi** en/it (come per `@stubwise/i18n`).

**Step 6 — Commit:** `feat(web): setup react-i18next + translateApiError`

> Le 4 task seguenti (9–12) seguono tutte la STESSA ricetta per ciascuna area:
> (a) per ogni stringa italiana hardcoded, aggiungere la chiave a `en.json` (testo inglese) e `it.json` (testo italiano attuale); (b) sostituire la stringa con `t("ns:key")` via `useTranslation`; (c) per le interpolazioni usare `t("k", { var })`; (d) aggiornare/aggiungere i test del componente; (e) `pnpm --filter @stubwise/web test` + `typecheck`; (f) commit. Le label di stato/badge centralizzate (es. `ai-job-timeline.tsx`) diventano `t("jobStatus:<stato>")`.

### Task 9: Estrazione — auth, layout, navigazione, common

**Scope:** pagine di login/setup/invito (`auth`), layout/nav/sidebar, wordmark/footer, testi comuni (bottoni Salva/Annulla, stati di loading/errore generici). Aggiungere il **selettore lingua** NON qui (è in Account, Task 11).
**Files:** i `.tsx` di auth + layout + componenti common + `en.json`/`it.json`. **Test:** i test esistenti di auth/layout.
**Commit:** `feat(web): i18n auth/layout/common`

### Task 10: Estrazione — ticket (board, lista, dettaglio, timeline/badge)

**Scope:** board/lista ticket, `ticket-row.tsx`, `ticket-filters.tsx`, `new-ticket-dialog.tsx`, dettaglio `tickets/$id.tsx` (inclusi i bottoni "Avvia fix AI"/"Rilancia con istruzioni"/"Approva"/"Rifiuta" e gli hint), `ai-job-timeline.tsx` (etichette/note stati → `jobStatus` ns), `comment-thread.tsx`.
**Files:** i suddetti + cataloghi. **Test:** `$id.test.tsx`, `ai-job-timeline.test.tsx`, `new-ticket-dialog.test.tsx`, `ticket-filters.test.tsx` (aggiornare le asserzioni di testo: usare le chiavi tradotte o renderizzare in una lingua nota nei test).
**Commit:** `feat(web): i18n ticket e timeline AI`

### Task 11: Estrazione — Settings (tutte le sotto-pagine) + selettore lingua utente

**Scope:** `settings/layout.tsx` (sub-nav), `account.tsx` (+ **nuovo selettore lingua** `English`/`Italiano` legato a `user.language` → `PATCH /me` + `i18n.changeLanguage` live), `automation.tsx`, `notifications-section.tsx`, `git-accounts.tsx`, pagina Team.
**Files:** i suddetti + cataloghi + client `api.ts` (`patchMyLanguage`). **Test:** `settings.test.tsx` (+ test del selettore lingua: cambia pref e lingua attiva).
**Commit:** `feat(web): i18n settings + selettore lingua utente`

### Task 12: Estrazione — resto + sweep finale

**Scope:** qualunque `.tsx` rimasto con stringhe italiane (error boundary, pagine 404, toast, dialog vari). Poi uno **sweep**: cercare stringhe italiane residue.
**Files:** i rimanenti + cataloghi. **Test:** quelli toccati.
**Verifica sweep:** `grep -rnE "[a-z]+(à|è|é|ì|ò|ù)|\b(non|già|salva|annulla|impostazioni|attesa|errore)\b" apps/web/src --include=*.tsx | grep -v "\.test\." | grep -v "t(" ` → deve essere (quasi) vuoto; valutare i match residui.
**Commit:** `feat(web): i18n stringhe residue + sweep`

---

## Fase 4 — UI lingua d'istanza

### Task 13: Settings (admin) — lingua dei contenuti d'istanza

**Files:**
- Modify: `apps/server/src/routes/settings.ts` (GET/PUT `instance_settings.content_language`), `apps/web/src/routes/settings/*` (un controllo nella pagina admin), `apps/web/src/lib/api.ts`
- Test: `settings.test.ts` (server) + test web

**Step 1 — Server.** Endpoint GET/PUT per `instance_settings.content_language` (admin, `requireAdmin`), body `{ contentLanguage: languageSchema }`, upsert su `id=1`.
**Step 2 — Web.** Un select "Lingua dei contenuti generati (commenti AI, report, notifiche)" nella sezione Settings appropriata (admin), con nota che NON è la lingua della propria UI.
**Step 3 — Test.** round-trip GET/PUT lato server; il select web invia il valore.
**Step 4 — Commit:** `feat: lingua dei contenuti d'istanza configurabile (Settings admin)`

---

## Fase 5 — Verifica finale

### Task 14: Sweep finale + verifica

**Step 1.** Confermare i test di **parità chiavi** (en/it) sia in `@stubwise/i18n` sia in `apps/web` verdi.
**Step 2.** Sweep finale stringhe italiane residue in `apps/web/src` (vedi Task 12) e nei testi generati backend.
**Step 3.** Verifica completa:
- `pnpm -r typecheck` → 0 errori;
- `pnpm -r test` → tutto verde (inclusi i test server aggiornati);
- `pnpm -r build`.
**Step 4.** Code review finale dell'intera feature (subagent) contro il design.

### Note per il deploy (NON parte dei task)
- Migrazione additiva (backup prima, come prassi).
- **Effetto atteso dopo il deploy:** UI in inglese per tutti gli utenti finché non scelgono Italiano in Account; nuovi contenuti in inglese finché `content_language` d'istanza non è portato su `it`. Subito dopo il deploy, se desiderato, impostare la propria istanza su Italiano (profilo + contenuti).
- **Docs** restano in italiano (follow-up dedicato): discrepanza nota da tracciare.
